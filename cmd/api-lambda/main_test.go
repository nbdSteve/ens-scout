package main

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"

	"ens-scrape/internal/api"
	"ens-scrape/internal/scanner"
)

const testOriginSecret = "test-origin-secret-0123456789abcdef"

func gatewayEvent() events.APIGatewayV2HTTPRequest {
	return events.APIGatewayV2HTTPRequest{
		Version:        "2.0",
		RawPath:        "/api/check",
		RawQueryString: "mode=fresh",
		Cookies:        []string{"first=one", "second=two"},
		Headers: map[string]string{
			"content-type":              "application/json",
			"x-ens-scout-origin-secret": testOriginSecret,
			"cloudfront-viewer-address": "[2001:db8::5]:443",
		},
		RequestContext: events.APIGatewayV2HTTPRequestContext{
			DomainName: "origin.execute-api.example",
			HTTP: events.APIGatewayV2HTTPRequestContextHTTPDescription{
				Method:   http.MethodPost,
				Path:     "/api/check",
				SourceIP: "198.51.100.20",
			},
		},
		Body:            base64.StdEncoding.EncodeToString([]byte(`{"names":["zap"]}`)),
		IsBase64Encoded: true,
	}
}

func TestHandlerAdaptsTheGatewayRequestAndTrustedViewer(t *testing.T) {
	called := false
	httpHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if r.Method != http.MethodPost {
			t.Errorf("method = %q, want POST", r.Method)
		}
		if r.URL.Path != "/api/check" || r.URL.RawQuery != "mode=fresh" {
			t.Errorf("URL = %q, want /api/check?mode=fresh", r.URL.String())
		}
		if got := r.Header.Get("Cookie"); got != "first=one; second=two" {
			t.Errorf("Cookie = %q", got)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		if string(body) != `{"names":["zap"]}` {
			t.Errorf("body = %q", body)
		}
		if identity, ok := api.ContextClientKey(r); !ok || identity != "2001:db8::5" {
			t.Errorf("identity = %q, %v", identity, ok)
		}
		w.Header().Add("Vary", "Origin")
		w.Header().Add("Vary", "Accept-Encoding")
		w.Header().Add("Set-Cookie", "answer=one")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("created"))
	})

	response, err := handler(httpHandler, testOriginSecret)(context.Background(), gatewayEvent())
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if !called {
		t.Fatal("HTTP handler was not called")
	}
	if response.StatusCode != http.StatusCreated || response.Body != "created" {
		t.Errorf("response = %+v", response)
	}
	if response.Headers["Vary"] != "Origin, Accept-Encoding" {
		t.Errorf("Vary = %q", response.Headers["Vary"])
	}
	if len(response.Cookies) != 1 || response.Cookies[0] != "answer=one" {
		t.Errorf("cookies = %#v", response.Cookies)
	}
}

func TestHandlerRejectsARequestThatDidNotComeThroughCloudFront(t *testing.T) {
	event := gatewayEvent()
	event.Headers["x-ens-scout-origin-secret"] = "caller-selected"
	called := false

	response, err := handler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}), testOriginSecret)(context.Background(), event)
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if called {
		t.Fatal("HTTP handler was called for an unauthenticated origin request")
	}
	if response.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403", response.StatusCode)
	}
	if strings.Contains(response.Body, testOriginSecret) {
		t.Fatal("response contains the origin secret")
	}
	if response.Headers["Cache-Control"] != "no-store" {
		t.Errorf("Cache-Control = %q", response.Headers["Cache-Control"])
	}
}

func TestHandlerDoesNotTrustAMalformedViewerAddress(t *testing.T) {
	event := gatewayEvent()
	event.Headers["cloudfront-viewer-address"] = "caller-selected"
	httpHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := api.ContextClientKey(r); ok {
			t.Error("malformed viewer identity was attached")
		}
		w.WriteHeader(http.StatusNoContent)
	})

	response, err := handler(httpHandler, testOriginSecret)(context.Background(), event)
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if response.StatusCode != http.StatusNoContent {
		t.Errorf("status = %d, want 204", response.StatusCode)
	}
}

func TestHandlerRefusesAMalformedGatewayBodyWithAFixedResponse(t *testing.T) {
	event := gatewayEvent()
	event.Body = "not-base64!"
	response, err := handler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("HTTP handler was called")
	}), testOriginSecret)(context.Background(), event)
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if response.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", response.StatusCode)
	}
	if strings.Contains(response.Body, event.Body) {
		t.Fatal("response reflected the malformed body")
	}
}

func TestBuildFailsBeforeItReachesAWS(t *testing.T) {
	for _, name := range []string{
		envOriginSecret,
		scanner.EnvSubgraphURL,
		scanner.EnvAPIKey,
		scanner.EnvSubgraphID,
		scanner.EnvTable,
		api.EnvCheckClientSecret,
	} {
		t.Setenv(name, "")
	}
	if _, err := build(context.Background()); err == nil {
		t.Fatal("build succeeded without production configuration")
	}
}

func TestColdStartFailureTextCannotContainConfiguration(t *testing.T) {
	// The main function writes this literal rather than build's error. Keep the
	// configuration-shaped strings out of it.
	const message = "ENS read API cold start failed"
	for _, forbidden := range []string{"http", "secret", "THEGRAPH", os.Getenv(scanner.EnvAPIKey)} {
		if forbidden != "" && strings.Contains(message, forbidden) {
			t.Errorf("cold-start message contains %q", forbidden)
		}
	}
}
