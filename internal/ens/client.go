package ens

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	maxBatchSize    = 1000
	maxResponseSize = 4 << 20
)

const registrationsQuery = `query CheckNames($names: [String!]!, $first: Int!) {
  registrations(first: $first, where: {domain_: {name_in: $names}}) {
    expiryDate
    domain {
      name
    }
  }
}`

// Client queries the ENS subgraph. It is safe for concurrent use.
type Client struct {
	endpoint   string
	httpClient *http.Client
	retries    int
}

// NewClient constructs a subgraph client. retries is the number of attempts
// made after the initial request for transient failures.
func NewClient(endpoint string, httpClient *http.Client, retries int) (*Client, error) {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return nil, errors.New("ENS subgraph endpoint is required")
	}
	parsedEndpoint, err := url.ParseRequestURI(endpoint)
	if err != nil || (parsedEndpoint.Scheme != "http" && parsedEndpoint.Scheme != "https") || parsedEndpoint.Host == "" {
		return nil, errors.New("invalid ENS subgraph endpoint")
	}
	if httpClient == nil {
		return nil, errors.New("HTTP client is required")
	}
	if retries < 0 {
		return nil, errors.New("retries cannot be negative")
	}

	return &Client{
		endpoint:   parsedEndpoint.String(),
		httpClient: httpClient,
		retries:    retries,
	}, nil
}

type graphQLRequest struct {
	Query     string                 `json:"query"`
	Variables map[string]interface{} `json:"variables"`
}

type graphQLError struct {
	Message string `json:"message"`
}

type graphQLResponse struct {
	Data struct {
		Registrations []struct {
			ExpiryDate string `json:"expiryDate"`
			Domain     struct {
				Name string `json:"name"`
			} `json:"domain"`
		} `json:"registrations"`
	} `json:"data"`
	Errors []graphQLError `json:"errors"`
}

// Lookup returns one item for every supplied label, including labels that do
// not have a registration in the subgraph.
func (c *Client) Lookup(ctx context.Context, labels []string) ([]Lookup, error) {
	if len(labels) == 0 {
		return nil, nil
	}
	if len(labels) > maxBatchSize {
		return nil, fmt.Errorf("batch contains %d names; maximum is %d", len(labels), maxBatchSize)
	}

	names := make([]string, len(labels))
	lookups := make([]Lookup, len(labels))
	positions := make(map[string][]int, len(labels))
	for i, label := range labels {
		name := strings.ToLower(strings.TrimSpace(label)) + ".eth"
		names[i] = name
		lookups[i] = Lookup{Name: name}
		positions[name] = append(positions[name], i)
	}

	payload, err := json.Marshal(graphQLRequest{
		Query: registrationsQuery,
		Variables: map[string]interface{}{
			"names": names,
			"first": len(names),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("encode GraphQL request: %w", err)
	}

	body, err := c.do(ctx, payload)
	if err != nil {
		return nil, err
	}

	var response graphQLResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, fmt.Errorf("decode GraphQL response: %w", err)
	}
	if len(response.Errors) > 0 {
		messages := make([]string, 0, len(response.Errors))
		for _, graphErr := range response.Errors {
			messages = append(messages, graphErr.Message)
		}
		return nil, fmt.Errorf("GraphQL error: %s", strings.Join(messages, "; "))
	}

	for _, registration := range response.Data.Registrations {
		name := strings.ToLower(registration.Domain.Name)
		matchingPositions, ok := positions[name]
		if !ok {
			continue
		}
		for _, position := range matchingPositions {
			lookups[position].Found = true
		}

		seconds, err := strconv.ParseInt(registration.ExpiryDate, 10, 64)
		if err != nil || seconds <= 0 {
			continue
		}
		expiry := time.Unix(seconds, 0).UTC()
		for _, position := range matchingPositions {
			lookups[position].Expiry = &expiry
		}
	}

	return lookups, nil
}

func (c *Client) do(ctx context.Context, payload []byte) ([]byte, error) {
	var lastErr error

	for attempt := 0; attempt <= c.retries; attempt++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(payload))
		if err != nil {
			return nil, fmt.Errorf("create GraphQL request: %w", err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Accept", "application/json")
		request.Header.Set("User-Agent", "ens-scrape/1")

		response, err := c.httpClient.Do(request)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			lastErr = fmt.Errorf("query ENS subgraph: %w", requestError(err))
			if attempt < c.retries {
				if err := waitForRetry(ctx, retryDelay("", attempt)); err != nil {
					return nil, err
				}
				continue
			}
			break
		}

		body, readErr := readBody(response.Body)
		response.Body.Close()
		if readErr != nil {
			return nil, fmt.Errorf("read ENS subgraph response: %w", readErr)
		}
		if response.StatusCode >= http.StatusOK && response.StatusCode < http.StatusMultipleChoices {
			return body, nil
		}

		lastErr = fmt.Errorf("ENS subgraph returned %s: %s", response.Status, responseSnippet(body))
		if !isRetryableStatus(response.StatusCode) || attempt >= c.retries {
			break
		}
		if err := waitForRetry(ctx, retryDelay(response.Header.Get("Retry-After"), attempt)); err != nil {
			return nil, err
		}
	}

	return nil, lastErr
}

func readBody(reader io.Reader) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(reader, maxResponseSize+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxResponseSize {
		return nil, fmt.Errorf("response exceeds %d bytes", maxResponseSize)
	}
	return body, nil
}

func isRetryableStatus(status int) bool {
	return status == http.StatusTooManyRequests || status >= http.StatusInternalServerError
}

func retryDelay(header string, attempt int) time.Duration {
	if seconds, err := strconv.Atoi(strings.TrimSpace(header)); err == nil && seconds >= 0 {
		return time.Duration(seconds) * time.Second
	}
	if when, err := http.ParseTime(header); err == nil {
		if delay := time.Until(when); delay > 0 {
			return delay
		}
	}

	delay := 250 * time.Millisecond * time.Duration(1<<attempt)
	if delay > 4*time.Second {
		return 4 * time.Second
	}
	return delay
}

func waitForRetry(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()

	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func responseSnippet(body []byte) string {
	const limit = 300
	text := strings.TrimSpace(string(body))
	if len(text) > limit {
		return text[:limit] + "..."
	}
	return text
}

func requestError(err error) error {
	var urlError *url.Error
	if errors.As(err, &urlError) {
		return urlError.Err
	}
	return err
}
