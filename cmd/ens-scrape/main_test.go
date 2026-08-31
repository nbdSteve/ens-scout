package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRunEndToEnd(t *testing.T) {
	expiry := time.Date(2100, time.January, 1, 0, 0, 0, 0, time.UTC).Unix()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var payload struct {
			Variables struct {
				Names []string `json:"names"`
			} `json:"variables"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}

		fmt.Fprint(writer, `{"data":{"registrations":[`)
		separator := ""
		for _, name := range payload.Variables.Names {
			if name != "held.eth" {
				continue
			}
			fmt.Fprintf(writer, `%s{"expiryDate":"%d","domain":{"name":"%s"}}`, separator, expiry, name)
			separator = ","
		}
		fmt.Fprint(writer, `]}}`)
	}))
	defer server.Close()

	input := filepath.Join(t.TempDir(), "names.txt")
	if err := os.WriteFile(input, []byte("free\nheld\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := run(
		context.Background(),
		[]string{"-endpoint", server.URL, "-workers", "2", "-batch-size", "1", "-show", "all", input},
		strings.NewReader(""),
		&stdout,
		&stderr,
	)
	if exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %s", exitCode, stderr.String())
	}
	if !strings.Contains(stdout.String(), "free.eth <- AVAILABLE") {
		t.Errorf("stdout does not contain available result: %s", stdout.String())
	}
	if !strings.Contains(stdout.String(), "held.eth <- REGISTERED") {
		t.Errorf("stdout does not contain registered result: %s", stdout.String())
	}
	if !strings.Contains(stderr.String(), "Checked 2 names in 2 batches") {
		t.Errorf("unexpected stderr: %s", stderr.String())
	}
}

func TestRunHelpSucceeds(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	exitCode := run(context.Background(), []string{"-h"}, strings.NewReader(""), &stdout, &stderr)
	if exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %s", exitCode, stderr.String())
	}
	if !strings.Contains(stderr.String(), "Usage: ens-scrape") {
		t.Fatalf("help output = %q", stderr.String())
	}
}

func TestResolveEndpointUsesPublicDefault(t *testing.T) {
	t.Setenv("ENS_SUBGRAPH_URL", "")
	t.Setenv("THEGRAPH_API_KEY", "")

	endpoint, err := resolveEndpoint("")
	if err != nil {
		t.Fatalf("resolveEndpoint: %v", err)
	}
	if endpoint != publicENSSubgraphURL {
		t.Fatalf("endpoint = %q, want %q", endpoint, publicENSSubgraphURL)
	}
}

func TestResolveEndpointUsesAPIKeyWhenConfigured(t *testing.T) {
	t.Setenv("ENS_SUBGRAPH_URL", "")
	t.Setenv("THEGRAPH_API_KEY", "test-key")

	endpoint, err := resolveEndpoint("")
	if err != nil {
		t.Fatalf("resolveEndpoint: %v", err)
	}
	want := "https://gateway.thegraph.com/api/test-key/subgraphs/id/" + ensSubgraphID
	if endpoint != want {
		t.Fatalf("endpoint = %q, want %q", endpoint, want)
	}
}
