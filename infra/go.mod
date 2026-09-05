// This directory is not part of the ens-scrape Go module, and this file is how the
// Go tool is told so: a directory holding its own go.mod is pruned from the parent
// module's package walk.
//
// The CDK application is TypeScript and contains no Go source. It does contain a
// node_modules tree once `npm ci` has run, and the aws-cdk CLI ships Go project
// templates inside it whose file names the Go tool rejects. Without this file,
// `go build ./...`, `go vet ./...`, and `go test ./...` all fail from the repository
// root for anyone who has installed the infra dependencies - which is every reason
// the documented Go workflow would appear broken by a change that touched no Go.
//
// Nothing imports this module and nothing builds it.
module ens-scrape/infra

go 1.18
