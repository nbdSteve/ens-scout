package ens

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestClientLookupBatchesNames(t *testing.T) {
	expiry := time.Date(2030, time.June, 1, 0, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", request.Method)
		}
		if request.Header.Get("User-Agent") != "ens-scrape/1" {
			t.Errorf("unexpected User-Agent %q", request.Header.Get("User-Agent"))
		}

		var payload struct {
			Query     string `json:"query"`
			Variables struct {
				Names []string `json:"names"`
				First int      `json:"first"`
			} `json:"variables"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if !strings.Contains(payload.Query, "name_in") {
			t.Errorf("query does not batch with name_in: %s", payload.Query)
		}
		if payload.Variables.First != 2 {
			t.Errorf("first = %d, want 2", payload.Variables.First)
		}
		if got := strings.Join(payload.Variables.Names, ","); got != "taken.eth,free.eth" {
			t.Errorf("names = %q", got)
		}

		writer.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(writer, `{"data":{"registrations":[{"expiryDate":"%d","domain":{"name":"taken.eth"}}]}}`, expiry.Unix())
	}))
	defer server.Close()

	client, err := NewClient(server.URL, server.Client(), 0)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	lookups, err := client.Lookup(context.Background(), []string{"TAKEN", "free"})
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if len(lookups) != 2 {
		t.Fatalf("got %d lookups, want 2", len(lookups))
	}
	if !lookups[0].Found || lookups[0].Expiry == nil || !lookups[0].Expiry.Equal(expiry) {
		t.Errorf("taken lookup = %+v", lookups[0])
	}
	if lookups[1].Found || lookups[1].Name != "free.eth" {
		t.Errorf("free lookup = %+v", lookups[1])
	}
}

func TestClientRetriesRateLimit(t *testing.T) {
	var attempts int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		if atomic.AddInt32(&attempts, 1) == 1 {
			writer.Header().Set("Retry-After", "0")
			http.Error(writer, "slow down", http.StatusTooManyRequests)
			return
		}
		fmt.Fprint(writer, `{"data":{"registrations":[]}}`)
	}))
	defer server.Close()

	client, err := NewClient(server.URL, server.Client(), 1)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	if _, err := client.Lookup(context.Background(), []string{"free"}); err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if got := atomic.LoadInt32(&attempts); got != 2 {
		t.Fatalf("attempts = %d, want 2", got)
	}
}

func TestClientReportsGraphQLErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(writer, `{"errors":[{"message":"bad query"}]}`)
	}))
	defer server.Close()

	client, err := NewClient(server.URL, server.Client(), 0)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	_, err = client.Lookup(context.Background(), []string{"name"})
	if err == nil || !strings.Contains(err.Error(), "bad query") {
		t.Fatalf("error = %v, want GraphQL error", err)
	}
}

func TestClientKeepsMalformedExpiryAsUnknown(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(writer, `{"data":{"registrations":[{"expiryDate":"not-a-timestamp","domain":{"name":"odd.eth"}}]}}`)
	}))
	defer server.Close()

	client, err := NewClient(server.URL, server.Client(), 0)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	lookups, err := client.Lookup(context.Background(), []string{"odd"})
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if len(lookups) != 1 || !lookups[0].Found || lookups[0].Expiry != nil {
		t.Fatalf("lookup = %+v, want found registration with unknown expiry", lookups)
	}
}

func TestNewClientRejectsInvalidEndpoint(t *testing.T) {
	if _, err := NewClient("not a URL", http.DefaultClient, 0); err == nil {
		t.Fatal("expected an invalid endpoint error")
	}
}

func TestClientDoesNotLeakEndpointInNetworkError(t *testing.T) {
	const secret = "super-secret-api-key"
	httpClient := &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("connection failed")
	})}
	client, err := NewClient("https://gateway.example/api/"+secret, httpClient, 0)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	_, err = client.Lookup(context.Background(), []string{"name"})
	if err == nil {
		t.Fatal("expected a network error")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("error leaked endpoint credentials: %v", err)
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (function roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}
