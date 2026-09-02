# ENS Scout infrastructure

TypeScript AWS CDK application that defines the scheduled ENS snapshot publisher.

One stack, `EnsScout-prod`, holds the DynamoDB snapshot table, the Go scanner
Lambda, the two offset EventBridge schedules, the failure queue, the log group, the
alarms, and the scanner's IAM role.
Nothing else.
The public read API, the frontend distribution, and the deployment pipeline are
later phases of [docs/website-plan.md](../docs/website-plan.md) and are
deliberately absent.

## Requirements

- Node.js 20 or newer.
- The Go toolchain, because every CDK command compiles the scanner first.
- Nothing else for a synth.
  Credentials are needed only to deploy, and no command here is run against AWS as
  part of development.

## Commands

```powershell
npm ci          # install exactly the locked dependency versions
npm run bundle  # cross-compile the scanner into build/scan-lambda
npm test        # the CDK assertion suite
npm run lint    # tsc --noEmit
npm run synth   # write cdk.out/EnsScout-prod.template.json
npm run diff    # compare the synthesized stack with the deployed one
npm run check   # lint, test, and synth: the check to run before a commit
```

`cdk.json` runs `scripts/bundle-scanner.js` before the app on every CDK command, so
`npm run synth` works from a clean clone with no separate build step and no Docker.
The bundle is `GOOS=linux GOARCH=arm64 CGO_ENABLED=0` with `-trimpath` and a cleared
build id, so two builds of the same source produce the same bytes and the same CDK
asset hash.
Without that, every `cdk diff` would report a Lambda update that is not one.

`npm run synth` prints a warning about absent AWS credentials and synthesizes
anyway.
That is expected: the account and region are fixed in context rather than taken
from whichever profile is logged in.

## Deployment

This repository does not deploy.
`npm run diff` and `cdk deploy` are run by a person with credentials for account
`289866763058` in `ap-southeast-2`, and two things must exist first.

1. The CDK bootstrap stack in that account and region, `cdk bootstrap`.
2. The Secrets Manager secret named by `ens-scout:graphApiKeySecretName`, holding a
   JSON document with the field named by `ens-scout:graphApiKeySecretField`.
   Create it out of band.
   This stack references the secret and never creates, rotates, or overwrites it.

Confirm `ens-scout:subgraphId` against the current ENS subgraph before the first
deploy.
The committed value is the ENS mainnet subgraph on The Graph's decentralised
network; a scan against the wrong subgraph ID fails at the gateway rather than
returning wrong data, but it fails after the schedule has already fired.

## Configuration

Every deployment-specific value is a CDK context key in `cdk.json`, so what is
deployed is recorded in the repository and any of it can be overridden with
`-c key=value`.

| Key | Purpose |
| --- | --- |
| `ens-scout:environmentName` | Stack name suffix and the `Environment` tag |
| `ens-scout:account` | Target account, exactly twelve digits |
| `ens-scout:region` | Target region |
| `ens-scout:subgraphId` | ENS subgraph on the Graph gateway |
| `ens-scout:graphApiKeySecretName` | Secrets Manager secret holding the Graph API key |
| `ens-scout:graphApiKeySecretField` | JSON field inside that secret |
| `ens-scout:snapshotTtlAttribute` | DynamoDB TTL attribute, must match `internal/dynamo` |
| `ens-scout:logRetentionDays` | Scanner log retention |
| `ens-scout:dlqRetentionDays` | Failure queue retention |

No key holds a credential.
`resolveConfig` fails on a missing or malformed value instead of substituting one,
because every key changes what a scheduled scan queries or where it publishes, and
a silent default would point a real scan at the wrong subgraph or table.

The scan tuning is in `lib/config.ts` rather than in context.
It is a deployment decision derived from the query budget, not an operational knob,
and `internal/scanner` validates and bounds every value again at cold start.

## How the Graph API key reaches the scanner

The stack references an existing secret and reads one field of it with
`secretValueFromJson(...).unsafeUnwrap()`.
That synthesizes to a CloudFormation dynamic reference,
`{{resolve:secretsmanager:...}}`, which CloudFormation substitutes at deploy time
using the deployer's credentials.
The synthesized template therefore holds the secret's address and never its value,
and the resolved key lives in the function's encrypted configuration - the
"encrypted Lambda setting" `docs/website-plan.md` permits alongside Secrets Manager.

The trade-off is deliberate.
The scanner's role has no `secretsmanager:GetSecretValue`, because a grant nothing
uses is privilege the running function should not have; the cost is that rotating
the secret needs a deployment to pick up the new value, rather than the next cold
start.
A scheduled publisher that runs eight times a day and holds one long-lived gateway
credential is the case where that is the cheaper side of the trade.
Moving to a runtime fetch means adding the grant, the client, and a cache, and it
belongs with a rotation schedule rather than on its own.

## What the tests assert

`npm test` synthesizes the stack against a committed fixture asset, so no assertion
depends on the machine that compiled the Go binary.

Several names in the stack are not the stack's to choose, so the tests read the Go
definition instead of copying it:

- the table's key and TTL attribute names, from `internal/dynamo/item.go`;
- the scanner's environment variable names, from `internal/scanner/scanner.go`;
- the two scan group strings, from the same file;
- the Lambda timeout, which has to stay under that package's `abandonedAfter`
  window so a reclaim pass can never expire chunks a live invocation is writing.

A rename in Go therefore fails a test here, rather than producing a deployment that
starts and then cannot read or write anything.

The schedule offset is asserted by expanding both cron expressions into the minutes
they actually fire and requiring the intersection to be empty.
Comparing the two cron strings would pass for two different expressions that
describe the same instant.

## Layout

```text
bin/ens-scout.ts              app entry point; resolves context and the environment
lib/config.ts                 context keys, validation, and the scan tuning
lib/schedules.ts              the two schedules and the cron expansion used to prove the offset
lib/ens-scout-stack.ts        the stack
lib/scanner-bundle.ts         locates the bundle the CDK app packages
scripts/bundle-scanner.js     reproducible cross-compile of cmd/scan-lambda
test/                         the assertion suite
test/fixtures/scan-lambda/    fixed-hash stand-in for the compiled scanner
```

## Design notes

**EventBridge Rules, not the Scheduler L2.** `aws-scheduler` is still an alpha
module, and two fixed cron schedules need nothing it adds.

**No retry on a failed scan.** A rescan costs the whole Graph budget again, and the
publisher is built so a failure leaves the previous snapshot serving, so there is
nothing urgent to recover.
The invocation is recorded on the failure queue either way, and the alarm is what
surfaces it.

**A declared log group, not `logRetention`.** The deprecated property provisions a
helper Lambda holding `logs:PutRetentionPolicy` on every log group in the account.
Declaring the group bounds retention from the first invocation and lets the
scanner's role name that one group.

**Reserved concurrency of two.** Two schedules, offset so they cannot overlap.
The bound is here so a misconfigured schedule or a burst of manual invocations
cannot run many scans at once and multiply the Graph spend.

**The table is retained and deletion-protected.** It holds the only copy of every
published snapshot.
A scan can be repeated, but only by spending the Graph budget again.

**No alarm on snapshot staleness.** It needs a metric the publisher does not emit
yet.
The missing-scan alarm covers the case that produces a stale snapshot - a schedule
that stopped firing - and the real staleness signal belongs with the read path.

**The chunk retention window is not configurable here.** `internal/dynamo` derives
a superseded snapshot's TTL from that snapshot's own stale-after threshold, measured
from the new publication, so there is no environment variable to set and an infra
knob would be dead configuration.
Issue #4 asks for a parameterized recovery TTL; the parameter that exists is the TTL
attribute name, which has to match the publisher.
Changing the window means changing the staleness thresholds in `internal/snapshot`.
