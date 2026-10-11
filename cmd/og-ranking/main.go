package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"ens-scrape/internal/ogranking"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], os.Stdout, os.Stderr))
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		usage(stderr)
		return 2
	}
	switch args[0] {
	case "generate":
		return runGenerate(ctx, args[1:], stdout, stderr)
	case "review-queue":
		return runReviewQueue(args[1:], stdout, stderr)
	case "build":
		return runBuild(args[1:], stdout, stderr, false)
	case "check":
		return runBuild(args[1:], stdout, stderr, true)
	case "help", "-h", "--help":
		usage(stdout)
		return 0
	default:
		fmt.Fprintf(stderr, "error: unknown command %q\n\n", args[0])
		usage(stderr)
		return 2
	}
}

func usage(output io.Writer) {
	fmt.Fprintln(output, "Usage: og-ranking <generate|review-queue|build|check> [flags]")
	fmt.Fprintln(output)
	fmt.Fprintln(output, "generate      manually score the bounded candidate set through Bedrock")
	fmt.Fprintln(output, "review-queue  write an ignored ranked-head and policy review aid")
	fmt.Fprintln(output, "build         derive reviewed and browser artifacts from validated inputs")
	fmt.Fprintln(output, "check         verify committed derived artifacts without writing")
}

func runGenerate(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("og-ranking generate", flag.ContinueOnError)
	flags.SetOutput(stderr)
	root := flags.String("root", ".", "repository root")
	generatorCommit := flags.String("generator-commit", "", "full commit containing the generator")
	modelID := flags.String("model", ogranking.DefaultModelID, "versioned Bedrock model id")
	modelRevision := flags.String(
		"model-revision",
		ogranking.DefaultModelRevision,
		"immutable model revision",
	)
	modelComposition := flags.String(
		"model-composition",
		ogranking.DefaultModelComposition,
		"managed model-catalog composition",
	)
	codexCommand := flags.String("codex", "codex", "Bedrock-backed Codex executable")
	generatedAtText := flags.String("generated-at", "", "RFC3339 generation instant (defaults to now)")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintln(stderr, "error: generate takes no positional arguments")
		return 2
	}
	absoluteRoot, err := filepath.Abs(*root)
	if err != nil {
		fmt.Fprintf(stderr, "error: resolve root: %v\n", err)
		return 2
	}
	if strings.TrimSpace(*generatorCommit) == "" {
		commit, err := gitHead(ctx, absoluteRoot)
		if err != nil {
			fmt.Fprintf(stderr, "error: %v\n", err)
			return 2
		}
		*generatorCommit = commit
	}
	generatedAt := time.Now().UTC().Truncate(time.Second)
	if *generatedAtText != "" {
		parsed, err := time.Parse(time.RFC3339, *generatedAtText)
		if err != nil {
			fmt.Fprintln(stderr, "error: generated-at must be RFC3339")
			return 2
		}
		generatedAt = parsed.UTC().Truncate(time.Second)
	}
	interfaceVersion, err := commandVersion(ctx, *codexCommand)
	if err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		return 1
	}
	runner := ogranking.CodexRunner{
		Command:          *codexCommand,
		RepositoryRoot:   absoluteRoot,
		ModelID:          *modelID,
		ModelRevision:    *modelRevision,
		ModelComposition: *modelComposition,
		InterfaceVersion: interfaceVersion,
	}
	record, err := ogranking.GenerateModelPasses(ctx, ogranking.GeneratorOptions{
		RepositoryRoot:  absoluteRoot,
		GeneratorCommit: *generatorCommit,
		GeneratedAt:     generatedAt,
		Runner:          runner,
	})
	if err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		return 1
	}
	fmt.Fprintf(
		stdout,
		"generated %d passes over %d candidates in %d attempts; input_tokens=%d output_tokens=%d\n",
		len(record.Passes),
		record.Settings.CandidateCount,
		record.TotalAttempts,
		record.TotalUsage.InputTokens,
		record.TotalUsage.OutputTokens,
	)
	return 0
}

func runReviewQueue(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("og-ranking review-queue", flag.ContinueOnError)
	flags.SetOutput(stderr)
	root := flags.String("root", ".", "repository root")
	headCount := flags.Int("head", 128, "number of ranked labels to review")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintln(stderr, "error: review-queue takes no positional arguments")
		return 2
	}
	payload, err := ogranking.BuildReviewQueue(*root, *headCount)
	if err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		return 1
	}
	if err := ogranking.WriteReviewQueue(*root, payload); err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "wrote %s with %d ranked labels\n", ogranking.ReviewQueuePath, *headCount)
	return 0
}

func runBuild(args []string, stdout, stderr io.Writer, check bool) int {
	name := "og-ranking build"
	if check {
		name = "og-ranking check"
	}
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	flags.SetOutput(stderr)
	root := flags.String("root", ".", "repository root")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintf(stderr, "error: %s takes no positional arguments\n", name)
		return 2
	}
	artifacts, err := ogranking.BuildArtifacts(*root)
	if err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		return 1
	}
	if check {
		err = ogranking.CheckArtifacts(*root, artifacts)
	} else {
		err = ogranking.WriteArtifacts(*root, artifacts)
	}
	if err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		return 1
	}
	action := "wrote"
	if check {
		action = "verified"
	}
	fmt.Fprintf(stdout, "%s %d ranking artifacts\n", action, len(artifacts))
	return 0
}

func gitHead(ctx context.Context, root string) (string, error) {
	command := exec.CommandContext(ctx, "git", "rev-parse", "HEAD")
	command.Dir = root
	output, err := command.Output()
	if err != nil {
		return "", fmt.Errorf("read generator commit: %w", err)
	}
	return strings.TrimSpace(string(output)), nil
}

func commandVersion(ctx context.Context, commandName string) (string, error) {
	command := exec.CommandContext(ctx, commandName, "--version")
	output, err := command.Output()
	if err != nil {
		return "", fmt.Errorf("read model interface version: %w", err)
	}
	version := strings.TrimSpace(string(output))
	if version == "" || len(version) > 100 {
		return "", fmt.Errorf("model interface returned an invalid version")
	}
	return version, nil
}
