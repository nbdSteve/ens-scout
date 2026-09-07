// This directory is not part of the ens-scrape Go module, and this file is how the
// Go tool is told so: a directory holding its own go.mod is pruned from the parent
// module's package walk.
//
// The website is TypeScript and contains no Go source. It does contain a node_modules
// tree once `npm ci` has run, and a dependency in it ships Go source of its own
// (`flatted` carries `golang/pkg/flatted/flatted.go`). Without this file,
// `go build ./...`, `go vet ./...`, and `go test ./...` from the repository root all
// walk into a dependency tree that has nothing to do with this module, and report
// packages nobody here owns.
//
// Nothing imports this module and nothing builds it.
module ens-scrape/web

go 1.18
