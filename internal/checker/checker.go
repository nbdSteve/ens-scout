// Package checker coordinates batched, concurrent ENS lookups.
package checker

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"ens-scrape/internal/ens"
)

// Client is the subset of the ENS client used by the runner.
type Client interface {
	Lookup(context.Context, []string) ([]ens.Lookup, error)
}

// Options controls batching, concurrency, and status classification.
type Options struct {
	Workers   int
	BatchSize int
	Soon      time.Duration
	Now       func() time.Time
}

// Stats describes the work scheduled by Run.
type Stats struct {
	Names   int
	Batches int
	// ClassifiedAt is the single UTC instant every result was classified
	// against. Run samples it once, so the whole run shares one view of the
	// lifecycle boundaries no matter how long the lookups take. A caller that
	// publishes these results must pass this instant to snapshot.Build as the
	// scan time; any other instant can disagree with a stored status. Run always
	// sets it when it returns a nil error.
	ClassifiedAt time.Time
}

type batchResult struct {
	lookups []ens.Lookup
	err     error
}

// Run splits names into batches and checks them using a bounded worker pool.
func Run(ctx context.Context, client Client, names []string, options Options) ([]ens.Result, Stats, error) {
	stats := Stats{Names: len(names)}
	if client == nil {
		return nil, stats, errors.New("ENS client is required")
	}
	if options.Workers < 1 {
		return nil, stats, errors.New("workers must be at least 1")
	}
	if options.BatchSize < 1 || options.BatchSize > 1000 {
		return nil, stats, errors.New("batch size must be between 1 and 1000")
	}
	if options.Soon < 0 {
		return nil, stats, errors.New("soon window cannot be negative")
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	// The classification instant is sampled before any lookup starts and is
	// reported back, so a publisher can reuse the exact instant the statuses
	// describe rather than sampling the clock again.
	now := options.Now().UTC()
	stats.ClassifiedAt = now
	if len(names) == 0 {
		return nil, stats, nil
	}

	stats.Batches = (len(names) + options.BatchSize - 1) / options.BatchSize
	workerCount := options.Workers
	if workerCount > stats.Batches {
		workerCount = stats.Batches
	}

	runContext, cancel := context.WithCancel(ctx)
	defer cancel()

	jobs := make(chan []string)
	outputs := make(chan batchResult, workerCount)

	var workers sync.WaitGroup
	workers.Add(workerCount)
	for i := 0; i < workerCount; i++ {
		go func() {
			defer workers.Done()
			for batch := range jobs {
				lookups, err := client.Lookup(runContext, batch)
				select {
				case outputs <- batchResult{lookups: lookups, err: err}:
				case <-runContext.Done():
					return
				}
				if err != nil {
					return
				}
			}
		}()
	}

	go func() {
		defer close(jobs)
		for start := 0; start < len(names); start += options.BatchSize {
			end := start + options.BatchSize
			if end > len(names) {
				end = len(names)
			}
			select {
			case jobs <- names[start:end]:
			case <-runContext.Done():
				return
			}
		}
	}()

	go func() {
		workers.Wait()
		close(outputs)
	}()

	results := make([]ens.Result, 0, len(names))
	var firstErr error
	for output := range outputs {
		if output.err != nil {
			if firstErr == nil {
				firstErr = output.err
				cancel()
			}
			continue
		}
		for _, lookup := range output.lookups {
			results = append(results, ens.Classify(lookup, now, options.Soon))
		}
	}

	if firstErr != nil {
		return nil, stats, fmt.Errorf("check names: %w", firstErr)
	}
	if err := ctx.Err(); err != nil {
		return nil, stats, err
	}

	sort.Slice(results, func(i, j int) bool {
		return results[i].Name < results[j].Name
	})
	return results, stats, nil
}
