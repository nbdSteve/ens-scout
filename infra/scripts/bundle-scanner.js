#!/usr/bin/env node
'use strict';

// Builds the scanner Lambda bundle that lib/scanner-bundle.ts turns into a CDK
// asset.
//
// cdk.json runs this before the CDK app on every command, so `cdk synth` and
// `cdk diff` work from a clean clone with nothing but the Go toolchain and
// `npm ci`. It never contacts AWS.
//
// The build is kept reproducible on purpose: the CDK asset hash is the hash of
// this directory's contents, so a binary that changed only because it was rebuilt
// would make `cdk diff` report a Lambda update that is not one. -trimpath drops
// absolute source paths and -buildid= drops the build ID, which are the two parts
// of a Go binary that otherwise vary between machines and builds.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Layout. The bundle mirrors the repository's data/words path so an operator
// unpacking the deployed artifact sees the same layout as the checkout, and
// EnvWordListDir points at it.
const repoRoot = path.resolve(__dirname, '..', '..');
const outputRoot = path.join(__dirname, '..', 'build', 'scan-lambda');
const wordListOutput = path.join(outputRoot, 'data', 'words');
const wordListSource = path.join(repoRoot, 'data', 'words');

// The AWS provided.al2023 runtime executes the file named bootstrap.
const entrypointName = 'bootstrap';

// arm64 is Graviton, which is the cheaper Lambda architecture and is what
// lib/scanner-function.ts declares. The two must agree or the function fails to
// start with an exec format error.
const goos = 'linux';
const goarch = 'arm64';

function main() {
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(wordListOutput, { recursive: true });

  execFileSync(
    'go',
    [
      'build',
      '-trimpath',
      '-ldflags',
      '-s -w -buildid=',
      '-o',
      path.join(outputRoot, entrypointName),
      './cmd/scan-lambda',
    ],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' },
    },
  );

  // Only the word lists are copied. data/fixtures, data/results, and data/archive
  // are development and reference data, and shipping them would grow the bundle
  // without the scanner ever reading them.
  const lists = fs
    .readdirSync(wordListSource)
    .filter((name) => name.endsWith('.txt'))
    .sort();
  if (lists.length === 0) {
    throw new Error(`no word lists found in ${wordListSource}`);
  }
  for (const list of lists) {
    fs.copyFileSync(path.join(wordListSource, list), path.join(wordListOutput, list));
  }

  process.stderr.write(
    `bundled ${entrypointName} (${goos}/${goarch}) and ${lists.length} word lists into ${path.relative(repoRoot, outputRoot)}\n`,
  );
}

main();
