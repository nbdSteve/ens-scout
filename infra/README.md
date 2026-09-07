# ENS Scout infrastructure

TypeScript AWS CDK application that defines the scheduled ENS snapshot publisher.

One stack, `EnsScout-prod`, holds the DynamoDB snapshot table, the Go scanner
Lambda, the two offset EventBridge schedules, the undelivered-event queue, the log
group, the alarms and the topic they raise into, and the scanner's IAM role.
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
The bundle is `GOOS=linux GOARCH=arm64 CGO_ENABLED=0` with `-trimpath`, a cleared
build id, and `-buildvcs=false`, so two builds of the same source produce the same
bytes and the same CDK asset hash.
Without that, every `cdk diff` would report a Lambda update that is not one, and a
real change would then hide among the noise.
The VCS stamp matters as much as the other two: it records the commit and the
revision time, and a git worktree stamps a module version a normal clone does not,
so the same commit built in the two places produced two different asset hashes until
the flag was added.

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

The stack creates the alarm topic and deliberately adds no subscription to it, so
subscribing is a deployment step rather than something the template does.
Subscribe out of band to the `AlarmTopicArn` output after the first deploy; until
someone does, every alarm here raises into a topic with no subscribers and notifies
nobody.

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
| `ens-scout:logRetentionDays` | Scanner log retention, a finite CloudWatch Logs value |
| `ens-scout:dlqRetentionDays` | Undelivered-event queue retention |

No key holds a credential.
`resolveConfig` fails on a missing or malformed value instead of substituting one,
because every key changes what a scheduled scan queries or where it publishes, and
a silent default would point a real scan at the wrong subgraph or table.

`ens-scout:logRetentionDays` has to be one of the finite day counts CloudWatch Logs
accepts.
An unsupported count is refused rather than rounded, because rounding up keeps
records longer than the deployment asked for and rounding down discards them early.
`9999` is refused too, even though CloudWatch Logs accepts it: it is
`RetentionDays.INFINITE`, and log volume grows with every invocation, so a group that
never expires is unbounded cost and contradicts the rule that anything this stack
creates which accumulates is bounded.

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
- the DynamoDB action set the scanner's role allows, derived from the method names on
  `internal/dynamo`'s `API` interface, one per action;
- the scanner's environment variable names, from `internal/scanner/scanner.go`;
- the two scan group strings, from the same file;
- the word lists the bundle must ship, from that file's `Lists`;
- the Lambda timeout, which has to stay under that package's `abandonedAfter`
  window so a reclaim pass can never expire chunks a live invocation is writing.

`ens-scout:snapshotTtlAttribute` is checked the same way, but against the context
committed in `cdk.json` rather than against the test configuration.
It is the only Go-owned name that lives in context, so it is the only one that can be
wrong in the deployed value alone, and a mismatch is silent: every call still
succeeds, no alarm fires, and DynamoDB simply expires nothing.

A rename in Go therefore fails a test here, rather than producing a deployment that
starts and then cannot read or write anything.

The schedule offset is asserted by expanding both cron expressions into the minutes
they actually fire and requiring the intersection to be empty.
Comparing the two cron strings would pass for two different expressions that
describe the same instant.

The bundle's reproducibility is asserted the same way.
`scripts/bundle-scanner.js` exports the `go` argv and the environment it builds, and
the suite runs those functions and asserts on the values, so deleting a flag fails a
test.
Matching the script's text would not: its own header comment names every flag, which
is how a dropped `-buildvcs=false` went unnoticed once already.
`npm test` never compiles the binary.

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
A scan that ran and failed is surfaced by the error alarm and by the redacted
records in the log group.

**The queue holds undelivered schedule events only.** Its single writer is the
EventBridge target's dead-letter queue, so a message in it means EventBridge could
not hand the event to the function and no invocation ever happened - which is
exactly the failure the Lambda `Errors` metric never sees.
The function declares no dead-letter queue of its own, deliberately.
Lambda's async `DeadLetterConfig` receives the event for *any* failed asynchronous
invocation, including a scan that ran and returned an error, and nothing consumes
this queue, so an ordinary Graph outage would leave `ApproximateNumberOfMessagesVisible`
above zero - and its alarm latched - for the queue's whole retention, and a real
delivery failure arriving in that window would notify nobody, because an alarm only
notifies on a state change.
The record is bounded, not durable.
Nothing consumes the queue, so the message stays visible until an operator removes it
or until SQS expires it after `ens-scout:dlqRetentionDays`, whichever comes first -
and expiry happens whether or not anyone acted.
The alarm clears either way and sends an OK notification when it does, so that
notification is not evidence the event was handled.
The queue is the only record of an undelivered scan, because no invocation happened,
so the `Errors` metric never saw it and nothing reached the log group.

**Three alarms, and each one watches an occurrence.** An invocation that errored, one
that was throttled, and an event EventBridge could not deliver.
All three raise on a single datapoint, because one of any of them is already the whole
signal, and all three treat missing data as not breaching, so an empty period is
silence rather than evidence and no first deploy can page on one.

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

**Nothing here detects scan staleness, or a schedule that silently stopped firing.**
That is a real gap, and it is stated rather than approximated: a schedule that stops
firing produces no invocation, so the `Errors` alarm, the `Throttles` alarm, and the
queue alarm all see nothing at all.
Closing it needs a signal this stack does not have.
It has to be measured from the published snapshot's own timestamps rather than from
missing `Invocations` datapoints, because the snapshot is the artifact that matters and
an invocation that ran and published nothing looks identical to a healthy one on that
metric.
It has to be per source, because the two groups run on different cadences and one
snapshot is fresh against one group's threshold and stale against the other's, which a
single aggregate timestamp cannot express - `internal/snapshot` already carries each
source's own last-scanned instant and its own thresholds, so a stopped group is
measurable from a published snapshot without any new field.
And it has to carry an explicit deployment grace period, so a first deploy or a
redeploy does not read as staleness before the first scheduled scan has had a chance to
publish.
That grace period is what a Lambda-metric alarm has no way to express, which is why the
gap is left open here instead of approximated: CloudWatch fills a missing datapoint
according to `treatMissingData` rather than waiting for the window to fill, so an
`Invocations` alarm that breaches on missing data pages on its own first deploy however
wide its evaluation window is, and widening that window buys no quiet at all - it only
doubles detection latency.
The signal belongs with the operational monitoring work that owns the published-snapshot
metric.

**The chunk retention window is not configurable here.** `internal/dynamo` derives
a superseded snapshot's TTL from that snapshot's own stale-after threshold, measured
from the new publication, so there is no environment variable to set and an infra
knob would be dead configuration.
Issue #4 asks for a parameterized recovery TTL; the parameter that exists is the TTL
attribute name, which has to match the publisher.
Changing the window means changing the staleness thresholds in `internal/snapshot`.
