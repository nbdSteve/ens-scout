// Command api-lambda exposes internal/api through an API Gateway HTTP API.
//
// It is deliberately an adapter and nothing more. internal/api owns the routes,
// cache validators, CORS, fixed failure documents, snapshot cache, and bounded
// fresh-check path. This file converts the signed API Gateway event to net/http,
// attaches the viewer identity CloudFront supplied, and builds the real DynamoDB
// and ENS clients once at cold start.
package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"ens-scrape/internal/api"
	"ens-scrape/internal/dynamo"
	"ens-scrape/internal/ens"
	"ens-scrape/internal/scanner"
)

const (
	// envOriginSecret is a stack-generated value shared only by CloudFront and
	// this function. CloudFront overwrites the matching viewer header before it
	// reaches the origin, so a request that passes this comparison came through
	// the distribution and may trust CloudFront-Viewer-Address.
	envOriginSecret = "ENS_API_ORIGIN_SECRET"

	originSecretHeader  = "X-Ens-Scout-Origin-Secret"
	viewerAddressHeader = "CloudFront-Viewer-Address"

	minOriginSecretBytes = 32
)

type application struct {
	handler      http.Handler
	originSecret string
}

func main() {
	app, err := build(context.Background())
	if err != nil {
		// No error text is written here. Configuration can contain the Graph
		// endpoint and credential, and a cold-start diagnostic is not allowed to
		// turn an upstream or SDK error into a credential-bearing log record.
		fmt.Fprintln(os.Stderr, "ENS read API cold start failed")
		os.Exit(1)
	}
	lambda.Start(handler(app.handler, app.originSecret))
}

// build resolves every bounded setting before it opens an AWS client. A malformed
// deployment therefore fails once at cold start and cannot serve a partly
// configured check path.
func build(ctx context.Context) (application, error) {
	originSecret := os.Getenv(envOriginSecret)
	if len(originSecret) < minOriginSecretBytes {
		return application{}, fmt.Errorf("%s must be at least %d bytes", envOriginSecret, minOriginSecretBytes)
	}

	// scanner.LoadConfig owns the production Graph gateway resolution and its
	// credential validation. Reusing it keeps the scheduled scan and the fresh
	// check on one endpoint contract without moving any Graph setting into
	// internal/api.
	graphConfig, err := scanner.LoadConfig(os.Getenv)
	if err != nil {
		return application{}, err
	}
	apiConfig, err := api.LoadConfig(os.Getenv)
	if err != nil {
		return application{}, err
	}
	checkConfig, err := api.LoadCheckConfig(os.Getenv)
	if err != nil {
		return application{}, err
	}

	awsConfig, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		return application{}, err
	}
	dynamoClient := dynamodb.NewFromConfig(awsConfig)
	snapshotStore, err := dynamo.New(dynamoClient, dynamo.Options{Table: graphConfig.Table})
	if err != nil {
		return application{}, err
	}
	checkStore, err := dynamo.NewCheckStore(dynamoClient, dynamo.CheckOptions{Table: graphConfig.Table})
	if err != nil {
		return application{}, err
	}
	upstream, err := ens.NewClient(
		graphConfig.Endpoint,
		&http.Client{Timeout: checkConfig.Timeout},
		checkConfig.Retries,
	)
	if err != nil {
		return application{}, err
	}

	// Only an identity the authenticated CloudFront adapter attached is accepted.
	// Falling back to API Gateway's transport peer would throttle CloudFront edge
	// addresses rather than visitors.
	checkConfig.ClientKey = api.ContextClientKey
	checkConfig.Upstream = upstream
	checkConfig.Store = checkStore
	checkConfig.Log = os.Stdout

	apiConfig.Store = snapshotStore
	apiConfig.Check = &checkConfig
	httpHandler, err := api.New(apiConfig)
	if err != nil {
		return application{}, err
	}
	return application{handler: httpHandler, originSecret: originSecret}, nil
}

// handler adapts API Gateway payload format 2.0 to the net/http handler.
func handler(httpHandler http.Handler, originSecret string) func(context.Context, events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
	return func(ctx context.Context, event events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
		if !authenticatedOrigin(event.Headers, originSecret) {
			return fixedResponse(http.StatusForbidden, `{"code":"forbidden","message":"This origin is not public."}`+"\n"), nil
		}

		request, err := requestFromEvent(ctx, event)
		if err != nil {
			return fixedResponse(http.StatusBadRequest, `{"code":"bad_gateway_request","message":"The gateway request was malformed."}`+"\n"), nil
		}
		if identity, ok := viewerIdentity(headerValue(event.Headers, viewerAddressHeader)); ok {
			request = request.WithContext(api.WithClientIdentity(request.Context(), identity))
		}

		writer := newResponseWriter()
		httpHandler.ServeHTTP(writer, request)
		return writer.response(), nil
	}
}

func authenticatedOrigin(headers map[string]string, want string) bool {
	got := headerValue(headers, originSecretHeader)
	if len(got) != len(want) || len(want) < minOriginSecretBytes {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

func headerValue(headers map[string]string, name string) string {
	for key, value := range headers {
		if strings.EqualFold(key, name) {
			return value
		}
	}
	return ""
}

// viewerIdentity accepts exactly the address shape CloudFront generates. The port
// changes per connection and is intentionally discarded before internal/api keys
// and hashes the identity.
func viewerIdentity(address string) (string, bool) {
	host, _, err := net.SplitHostPort(strings.TrimSpace(address))
	if err != nil || net.ParseIP(host) == nil {
		return "", false
	}
	return host, true
}

func requestFromEvent(ctx context.Context, event events.APIGatewayV2HTTPRequest) (*http.Request, error) {
	body := []byte(event.Body)
	if event.IsBase64Encoded {
		decoded, err := base64.StdEncoding.DecodeString(event.Body)
		if err != nil {
			return nil, fmt.Errorf("decode request body")
		}
		body = decoded
	}

	method := strings.TrimSpace(event.RequestContext.HTTP.Method)
	if method == "" {
		return nil, fmt.Errorf("request method is missing")
	}
	path := event.RawPath
	if path == "" {
		path = event.RequestContext.HTTP.Path
	}
	if path == "" || !strings.HasPrefix(path, "/") {
		return nil, fmt.Errorf("request path is invalid")
	}

	requestURL := &url.URL{
		Scheme:   "https",
		Host:     event.RequestContext.DomainName,
		Path:     path,
		RawQuery: event.RawQueryString,
	}
	request, err := http.NewRequestWithContext(ctx, method, requestURL.String(), bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("construct request")
	}
	for name, value := range event.Headers {
		request.Header.Set(name, value)
	}
	if len(event.Cookies) > 0 {
		request.Header.Set("Cookie", strings.Join(event.Cookies, "; "))
	}
	return request, nil
}

type responseWriter struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func newResponseWriter() *responseWriter {
	return &responseWriter{header: make(http.Header)}
}

func (w *responseWriter) Header() http.Header {
	return w.header
}

func (w *responseWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
}

func (w *responseWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.body.Write(body)
}

func (w *responseWriter) response() events.APIGatewayV2HTTPResponse {
	status := w.status
	if status == 0 {
		status = http.StatusOK
	}
	headers := make(map[string]string)
	var cookies []string
	for name, values := range w.header {
		if strings.EqualFold(name, "Set-Cookie") {
			cookies = append(cookies, values...)
			continue
		}
		headers[name] = strings.Join(values, ", ")
	}
	return events.APIGatewayV2HTTPResponse{
		StatusCode: status,
		Headers:    headers,
		Body:       w.body.String(),
		Cookies:    cookies,
	}
}

func fixedResponse(status int, body string) events.APIGatewayV2HTTPResponse {
	return events.APIGatewayV2HTTPResponse{
		StatusCode: status,
		Headers: map[string]string{
			"Cache-Control": "no-store",
			"Content-Type":  "application/json; charset=utf-8",
		},
		Body: body,
	}
}

// Compile-time checks keep the small adapter honest when net/http changes.
var (
	_ http.ResponseWriter = (*responseWriter)(nil)
	_ io.Writer           = (*responseWriter)(nil)
)
