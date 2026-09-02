#!/usr/bin/env node
'use strict';

// Builds the scanner Lambda bundle that lib/scanner-bundle.ts turns into a CDK
// asset.
//
// cdk.json runs this before the CDK app on every CDK command, so `cdk synth` and
// `cdk diff` work from a clean clone with nothing but the Go toolchain and
// `npm ci`. It never contacts AWS.
//
// The build is kept reproducible on purpose: the CDK asset hash is the hash of
// this directory's contents, so a binary that changed only because it was rebuilt
// would make `cdk diff` report a Lambda update that is not one. Three flags are
// what make the bytes depend on the source alone:
//
//   -trimpath        drops absolute source paths, which differ per checkout;
//   -buildid=        drops the build ID;
//   -buildvcs=false  drops the VCS stamp, which records the commit, the dirty
//                    flag, and the revision time.
//
// The VCS stamp is the one that is easy to miss, because it makes an otherwise
// identical build vary with how the checkout was made rather than with what is in
// it. A git worktree stamps the module as `(devel)` and a normal clone stamps a
// pseudo-version, so the same commit built two ways produced two asset hashes
// until this flag was added. Deployment provenance belongs in the pipeline that
// deploys, not in a byte that has to stay stable for a diff to be meaningful.
//
// buildArgs, buildEnv, requiredWordLists, and selectWordLists are exported so the
// assertion suite can check the argv, the environment, and the word-list contract
// this script actually builds, rather than checking that this file mentions them.

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

// The Go file that defines which word lists a scan loads.
const scannerSource = path.join(repoRoot, 'internal', 'scanner', 'scanner.go');

// The Go package the bundle compiles, and the file name the AWS provided.al2023
// runtime executes.
const scannerPackage = './cmd/scan-lambda';
const entrypointName = 'bootstrap';

// arm64 is Graviton, which is the cheaper Lambda architecture and is what
// lib/ens-scout-stack.ts declares. The two must agree or the function fails to
// start with an exec format error.
const goos = 'linux';
const goarch = 'arm64';

/** buildArgs is the `go` argv the bundle is compiled with. */
function buildArgs() {
  return [
    'build',
    '-trimpath',
    '-buildvcs=false',
    '-ldflags',
    '-s -w -buildid=',
    '-o',
    path.join(outputRoot, entrypointName),
    scannerPackage,
  ];
}

/** buildEnv is the environment the compiler runs in, cross-compiling statically. */
function buildEnv(base = process.env) {
  return { ...base, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' };
}

/**
 * requiredWordLists is the file name of every list `internal/scanner.Lists` names.
 *
 * The names belong to Go, so they are read from the definition rather than copied.
 * A `Lists` block this cannot parse, or one that yields no path, throws: expanding
 * to nothing would turn the check below into one that passes for any bundle.
 */
function requiredWordLists(source) {
  const block = /var\s+Lists\s*=\s*\[\]ListSpec\{([\s\S]*?)\n\}/.exec(source);
  if (!block) {
    throw new Error(`could not find the Lists definition in ${scannerSource}`);
  }
  const names = [...block[1].matchAll(/Path:\s*"([^"]+)"/g)].map((match) =>
    path.posix.basename(match[1]),
  );
  if (names.length === 0) {
    throw new Error(`the Lists definition in ${scannerSource} names no word list path`);
  }
  return names;
}

/**
 * selectWordLists is the word lists to copy into the bundle.
 *
 * Only `.txt` files are taken: data/fixtures, data/results, and data/archive are
 * development and reference data, and shipping them would grow the bundle without
 * the scanner ever reading them.
 *
 * A list `internal/scanner.Lists` names and the checkout does not hold fails the
 * bundle here. It would otherwise package, deploy cleanly, and then fail every
 * invocation in `loadLists`, which resolves each spec's path inside this directory.
 */
function selectWordLists(available, required) {
  const lists = available.filter((name) => name.endsWith('.txt')).sort();
  const present = new Set(lists);
  const missing = required.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(
      `internal/scanner.Lists names ${missing.join(', ')}, which ${wordListSource} does not hold`,
    );
  }
  return lists;
}

function main() {
  const lists = selectWordLists(
    fs.readdirSync(wordListSource),
    requiredWordLists(fs.readFileSync(scannerSource, 'utf8')),
  );

  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(wordListOutput, { recursive: true });

  execFileSync('go', buildArgs(), {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: buildEnv(),
  });

  for (const list of lists) {
    fs.copyFileSync(path.join(wordListSource, list), path.join(wordListOutput, list));
  }

  process.stderr.write(
    `bundled ${entrypointName} (${goos}/${goarch}) and ${lists.length} word lists into ${path.relative(repoRoot, outputRoot)}\n`,
  );
}

module.exports = {
  buildArgs,
  buildEnv,
  entrypointName,
  requiredWordLists,
  scannerPackage,
  selectWordLists,
};

if (require.main === module) {
  main();
}
