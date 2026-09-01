// Command scan-lambda is the scheduled snapshot publisher.
//
// It is deliberately thin. Everything that decides what a run does lives in
// internal/scanner, internal/checker, internal/ens, and internal/snapshot, and is
// tested against local fakes; this file only builds the real Graph client and the
// real DynamoDB store and hands them over. Anything added here would be code that
// runs in production and is exercised by nothing.
package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"time"

	"github.com/aws/aws-lambda-go/lambda"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"ens-scrape/internal/dynamo"
	"ens-scrape/internal/ens"
	"ens-scrape/internal/scanner"
)

func main() {
	logger := scanner.NewLogger(os.Stdout, time.Now)
	deps, err := build(context.Background(), logger)
	if err != nil {
		// Cold start failed, so there is nothing to serve. The record is logged
		// redacted like every other, because a configuration error can quote the
		// endpoint and the endpoint can carry the API key.
		logger.LogError(scanner.LevelError, "cold_start_failed", scanner.Fields{}, err)
		os.Exit(1)
	}
	lambda.Start(handler(deps))
}

// build resolves the environment and constructs the run's dependencies once, at
// cold start, so a misconfiguration fails before any schedule fires rather than on
// every invocation.
func build(ctx context.Context, logger *scanner.Logger) (scanner.Dependencies, error) {
	config, err := scanner.LoadConfig(os.Getenv)
	if err != nil {
		return scanner.Dependencies{}, err
	}

	awsConfig, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		return scanner.Dependencies{}, err
	}
	store, err := dynamo.New(dynamodb.NewFromConfig(awsConfig), dynamo.Options{Table: config.Table})
	if err != nil {
		return scanner.Dependencies{}, err
	}

	// The timeout is per request, not per run: internal/scanner bounds the scan as
	// a whole, and internal/ens retries only transient failures.
	client, err := ens.NewClient(config.Endpoint, &http.Client{Timeout: config.RequestTimeout}, config.Retries)
	if err != nil {
		return scanner.Dependencies{}, err
	}

	return scanner.Dependencies{
		Config: config,
		Store:  store,
		Client: client,
		Logger: logger,
	}, nil
}

// response is what an invocation reports back. A schedule discards it, but a
// manual invocation reads it, so it carries counts and identifiers and no
// candidate names.
type response struct {
	Group      scanner.Group `json:"group"`
	SnapshotID string        `json:"snapshot_id"`
	Names      int           `json:"names"`
	Scanned    int           `json:"scanned"`
	Carried    int           `json:"carried"`
	Chunks     int           `json:"chunks"`
	ScannedAt  string        `json:"scanned_at"`
	Superseded string        `json:"superseded_snapshot_id,omitempty"`
}

// handler runs one scheduled scan.
//
// A returned error is what marks the invocation failed, which is how the schedule
// and its alarms learn that a scan did not publish. It is redacted first: the
// Lambda runtime writes the error it is given straight to the log group, and an
// error from a lower layer may quote the Graph endpoint, which carries the API key
// in its path. scanner.Run has already logged the same failure with its fields.
func handler(deps scanner.Dependencies) func(context.Context, scanner.Event) (response, error) {
	return func(ctx context.Context, event scanner.Event) (response, error) {
		result, err := scanner.Run(ctx, deps, event)
		if err != nil {
			return response{}, errors.New(scanner.Redact(err))
		}
		return response{
			Group:      result.Group,
			SnapshotID: result.Latest.SnapshotID,
			Names:      result.Latest.Names,
			Scanned:    result.Scanned,
			Carried:    result.Carried,
			Chunks:     result.Latest.ChunkCount,
			ScannedAt:  result.Latest.ScannedAt.Format(time.RFC3339),
			Superseded: result.Previous,
		}, nil
	}
}
