package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"

	"ens-scrape/internal/checker"
	"ens-scrape/internal/ens"
	"ens-scrape/internal/names"
	"ens-scrape/internal/report"
)

const (
	ensSubgraphID        = "5XqPmWe6gjyrJtFn9cLy237i4cWw2j9HcUJEXsP5qGtH"
	publicENSSubgraphURL = "https://api.thegraph.com/subgraphs/name/ensdomains/ens"
)

var defaultInputFiles = []string{
	"data/words/4-letters.txt",
	"data/words/5-letters.txt",
}

type config struct {
	endpoint   string
	workers    int
	batchSize  int
	retries    int
	timeout    time.Duration
	soonDays   int
	format     string
	show       string
	output     string
	inputFiles []string
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	configuration, err := parseConfig(args, stderr)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		fmt.Fprintf(stderr, "error: %v\n", err)
		return 2
	}

	selection, err := report.ParseSelection(configuration.show)
	if err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		return 2
	}
	if configuration.timeout <= 0 {
		fmt.Fprintln(stderr, "error: timeout must be greater than zero")
		return 2
	}
	if configuration.soonDays < 0 {
		fmt.Fprintln(stderr, "error: soon-days cannot be negative")
		return 2
	}
	if configuration.workers < 1 {
		fmt.Fprintln(stderr, "error: workers must be at least 1")
		return 2
	}
	if configuration.batchSize < 1 || configuration.batchSize > 1000 {
		fmt.Fprintln(stderr, "error: batch-size must be between 1 and 1000")
		return 2
	}
	if configuration.retries < 0 {
		fmt.Fprintln(stderr, "error: retries cannot be negative")
		return 2
	}
	if err := report.ValidateFormat(configuration.format); err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		return 2
	}

	endpoint, err := resolveEndpoint(configuration.endpoint)
	if err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		return 2
	}

	labels, err := names.Load(configuration.inputFiles, stdin)
	if err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		return 1
	}
	if len(labels) == 0 {
		fmt.Fprintln(stderr, "error: input contains no names")
		return 1
	}

	httpClient := &http.Client{Timeout: configuration.timeout}
	ensClient, err := ens.NewClient(endpoint, httpClient, configuration.retries)
	if err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		return 2
	}

	started := time.Now()
	results, stats, err := checker.Run(ctx, ensClient, labels, checker.Options{
		Workers:   configuration.workers,
		BatchSize: configuration.batchSize,
		Soon:      time.Duration(configuration.soonDays) * 24 * time.Hour,
	})
	if err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		return 1
	}

	output, closeOutput, err := openOutput(configuration.output, stdout)
	if err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		return 1
	}
	emitted, writeErr := report.Write(output, results, configuration.format, selection)
	closeErr := closeOutput()
	if writeErr != nil {
		fmt.Fprintf(stderr, "error: write results: %v\n", writeErr)
		return 1
	}
	if closeErr != nil {
		fmt.Fprintf(stderr, "error: close output: %v\n", closeErr)
		return 1
	}

	fmt.Fprintf(
		stderr,
		"Checked %d names in %d batches with up to %d workers in %s; emitted %d results.\n",
		stats.Names,
		stats.Batches,
		configuration.workers,
		time.Since(started).Round(time.Millisecond),
		emitted,
	)
	fmt.Fprintln(stderr, statusSummary(results))
	return 0
}

func parseConfig(args []string, stderr io.Writer) (config, error) {
	configuration := config{}
	flags := flag.NewFlagSet("ens-scrape", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.StringVar(&configuration.endpoint, "endpoint", "", "GraphQL endpoint (defaults to the public ENS endpoint)")
	flags.IntVar(&configuration.workers, "workers", defaultWorkers(), "maximum concurrent requests")
	flags.IntVar(&configuration.batchSize, "batch-size", 100, "names per GraphQL request (1-1000)")
	flags.IntVar(&configuration.retries, "retries", 3, "retries after transient HTTP failures")
	flags.DurationVar(&configuration.timeout, "timeout", 30*time.Second, "timeout for each HTTP request")
	flags.IntVar(&configuration.soonDays, "soon-days", 7, "mark expiry or grace-period end within this many days")
	flags.StringVar(&configuration.format, "format", "text", "output format: text, jsonl, or csv")
	flags.StringVar(&configuration.show, "show", report.DefaultSelection, "comma-separated statuses to emit, or all")
	flags.StringVar(&configuration.output, "output", "", "write results to this file instead of stdout")
	flags.Usage = func() {
		fmt.Fprintln(flags.Output(), "Usage: ens-scrape [flags] [input-file ...]")
		fmt.Fprintln(flags.Output(), "")
		fmt.Fprintln(flags.Output(), "Input files contain one ENS label or .eth name per line. Use - for stdin.")
		fmt.Fprintln(flags.Output(), "With no files, the bundled 4- and 5-letter word lists are scanned.")
		fmt.Fprintln(flags.Output(), "")
		fmt.Fprintln(flags.Output(), "Flags:")
		flags.PrintDefaults()
	}

	if err := flags.Parse(args); err != nil {
		return config{}, err
	}
	configuration.inputFiles = flags.Args()
	if len(configuration.inputFiles) == 0 {
		configuration.inputFiles = append([]string(nil), defaultInputFiles...)
	}
	return configuration, nil
}

func resolveEndpoint(explicit string) (string, error) {
	if endpoint := strings.TrimSpace(explicit); endpoint != "" {
		return endpoint, nil
	}
	if endpoint := strings.TrimSpace(os.Getenv("ENS_SUBGRAPH_URL")); endpoint != "" {
		return endpoint, nil
	}
	if apiKey := strings.TrimSpace(os.Getenv("THEGRAPH_API_KEY")); apiKey != "" {
		return fmt.Sprintf(
			"https://gateway.thegraph.com/api/%s/subgraphs/id/%s",
			url.PathEscape(apiKey),
			ensSubgraphID,
		), nil
	}
	return publicENSSubgraphURL, nil
}

func defaultWorkers() int {
	workers := runtime.NumCPU()
	if workers > 8 {
		return 8
	}
	if workers < 1 {
		return 1
	}
	return workers
}

func openOutput(path string, stdout io.Writer) (io.Writer, func() error, error) {
	if strings.TrimSpace(path) == "" {
		return stdout, func() error { return nil }, nil
	}
	file, err := os.Create(path)
	if err != nil {
		return nil, nil, fmt.Errorf("create output %s: %w", path, err)
	}
	return file, file.Close, nil
}

func statusSummary(results []ens.Result) string {
	counts := make(map[ens.Status]int, len(ens.Statuses))
	for _, result := range results {
		counts[result.Status]++
	}

	parts := make([]string, 0, len(counts))
	for _, status := range ens.Statuses {
		if count := counts[status]; count > 0 {
			parts = append(parts, fmt.Sprintf("%s=%d", status, count))
		}
	}
	sort.Strings(parts)
	return "Status totals: " + strings.Join(parts, ", ")
}
