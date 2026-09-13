# ENS Scout infrastructure

TypeScript AWS CDK application for the scheduled publisher and public website.

One stack, `EnsScout-prod`, holds the DynamoDB snapshot/check table, both Go
Lambdas, the two offset EventBridge schedules, the private frontend bucket, one
HTTP API, one CloudFront distribution, the generated serving secrets, the
undelivered-event queue, and the existing publisher alarms.
CloudFront is the public origin: OAC keeps the bucket private, `/api/*` goes to the
HTTP API, and the stack outputs the complete generated HTTPS URL.
The two deployment roles are absent from the stack too, and for a different reason:
they are what deploys it, so a stack that defined them would have to be deployed by
something else first.
They live in `iam/` as templates of the documents applied to the account, and
[docs/deployment.md](../docs/deployment.md) explains them.

## Requirements

- Node.js 20 or newer.
- The Go toolchain, because every CDK command compiles both Lambda entrypoints.
- A production build in `web/dist`, built with `VITE_API_BASE_URL=/`, because the
  synth packages those exact bytes.
- Nothing else for a synth.
  Credentials are needed only to deploy, and no command here is run against AWS as
  part of development.

## Commands

```powershell
npm ci          # install exactly the locked dependency versions
npm run bundle  # cross-compile scanner and API into build/
npm test        # the CDK assertion suite
npm run lint    # tsc --noEmit
npm run synth   # write cdk.out/EnsScout-prod.template.json
npm run diff    # compare the synthesized stack with the deployed one
npm run check   # lint, test, and synth: the check to run before a commit

npm run render:iam -- --example   # render iam/*.template.json with the example values
```

`npm run check` ends with the synth deliberately, so trailing arguments reach `cdk
synth` and nothing else: `npm run check -- --context ens-scout:account=<account>` is
how the production workflow builds the artifact it deploys, and a `check` reordered to
end with the tests would send that context to jest instead.
A test asserts the order.

Build the website before an infrastructure check:

```powershell
cd ../web
$env:VITE_API_BASE_URL = "/"
npm ci
npm run build
cd ../infra
npm ci
npm run check
```

`cdk.json` runs `scripts/bundle-scanner.js` before the app on every CDK command, so
the Go bundles need no separate build step and no Docker. Both use
`GOOS=linux GOARCH=arm64 CGO_ENABLED=0` with `-trimpath`, a cleared build id, and
`-buildvcs=false`, so two builds of the same source produce the same bytes and the
same CDK asset hashes.
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

Deployment follows every successful `checks` run for a same-repository push to `main`,
through a GitHub OIDC role and the `production` environment in `ap-southeast-2`.
A main-only `workflow_dispatch` remains as an optional recovery trigger and does not
gate the automatic path.
[docs/deployment.md](../docs/deployment.md) is the whole description: the four
`production` environment variables, the two roles, what they may and may not do, the
GitHub configuration, and the residual risks.
`.github/workflows/deploy-production.yml` is the only workflow that deploys, and no
command run during development here touches AWS.

The target account is the one deployment value this repository does not commit.
`cdk.json` carries `lib/config.ts`'s `placeholderAccount`, which is what lets a clean
clone, every pull-request check, and every test synthesize the stack, and the workflow
supplies the real account from the `AWS_ACCOUNT_ID` variable as
`-c ens-scout:account=` on the synth that produces the artifact it deploys.
The workflow selects `github.event.workflow_run.head_sha`, checks out and verifies that
full commit, builds `web/dist` with the same-origin API base before the synth, deploys
`infra/cdk.out` without another synth, and writes only the selected SHA, the template
checksum, and the `PublicSiteUrl` output to the deployment summary.

`npm run diff` and an interactive `cdk deploy` still work for someone holding
credentials directly, and three things must exist before either.

1. The CDK bootstrap stack in that account and region, `cdk bootstrap`.
   The four bootstrap roles go unused, for the reason `lib/deployment.ts` records, but
   the bucket and the version parameter the qualifier names are both required.
2. The Secrets Manager secret named by `ens-scout:graphApiKeySecretName`, holding a
   JSON document with the field named by `ens-scout:graphApiKeySecretField`.
   Create it out of band.
   This stack references the secret and never creates, rotates, or overwrites it.
3. The two roles the templates in `iam/` describe, if the deployment goes through the
   workflow, and the four `production` environment variables that name them.

The stack creates the alarm topic and deliberately adds no subscription to it, so
subscribing is a deployment step rather than something the template does.
Subscribe out of band to the `AlarmTopicName` output in the configured account after
the first deploy; until
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
| `ens-scout:account` | Target account, exactly twelve digits; committed as a placeholder |
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

`ens-scout:account` is the one key whose committed value is deliberately not the
deployed one.
It is `lib/config.ts`'s `placeholderAccount`, an account nobody owns, and the real
account arrives as `-c ens-scout:account=` at the synth the production workflow
deploys.
The key is present rather than absent so `resolveConfig` still resolves from a clean
clone and every assertion about the stack's environment stays a real assertion; a
test pins the committed value, so a commit that put the real account back fails
rather than only being noticed by a reader.

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

## How the Graph API key reaches the Lambdas

The stack references an existing secret and reads one field of it with
`secretValueFromJson(...).unsafeUnwrap()`.
That synthesizes to a CloudFormation dynamic reference,
`{{resolve:secretsmanager:...}}`, which CloudFormation substitutes at deploy time
using the deployer's credentials.
The synthesized template therefore holds the secret's address and never its value,
and the resolved key lives in the function's encrypted configuration - the
"encrypted Lambda setting" `docs/website-plan.md` permits alongside Secrets Manager.

The trade-off is deliberate.
Neither runtime role has `secretsmanager:GetSecretValue`, because a grant nothing
uses is privilege a running function should not have; the cost is that rotating
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
- the actions the fresh-check store calls, derived from `CheckAPI` the same way, which
  has to stay a subset of `API` so serving the read API needs no wider policy;
- the environment variable that names the check client secret, from
  `internal/api/checkconfig.go`, which only the API function receives;
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

The bundles' reproducibility is asserted the same way.
`scripts/bundle-scanner.js` exports both `go` argv lists and the environment it
builds, and the suite runs those functions and asserts on the values, so deleting a
flag fails a test.
Matching the script's text would not: its own header comment names every flag, which
is how a dropped `-buildvcs=false` went unnoticed once already.
`npm test` never compiles the binary.

`test/deployment.test.ts` is the one suite that asserts on things outside CDK.
The four documents in `iam/` are configuration in an AWS account, and the two workflows
are configuration in GitHub, so no template can describe either, and both have to agree
with `lib/deployment.ts` and with the committed context.
It renders the templates through `scripts/render-iam.js` with `iam/example-values.json`
and asserts the rendered documents, because the committed form carries placeholders
rather than an account.
It derives the asset bucket, the bootstrap version parameter, the stack ARN, and the
secret ARN from those two sources and requires the documents to name exactly them; it
pins the trust policy's subject, audience, and condition operator; it pins the statements
that grant anything on `*`; it synthesizes with `deploymentSynthesizer()` and requires
the stack artifact to name none of the bootstrap roles; and it requires every template to
hold no twelve-digit run and to name no role but a placeholder or one under the stack's
own prefix.
It parses the workflow YAML into mappings, lists, and scalars through the YAML parser
already present in the locked Jest dependency graph, so comments and formatting cannot
decide an assertion.
For the automatic gate it executes the exact resolver shell body from that parsed model
against successful, failed, pull-request, fork, non-main, dispatch, and malformed-SHA
events, then requires checkout, verification, summary, build, and deployment to consume
the one selected output.

The same suite asserts what the deploy workflow may not contain and what it must carry.
It requires that the workflow embeds no account number of its own and no role name or
role ARN at all, that the four `production` variables it reads are exactly the four its
deploy job refuses to run without, that the check comes before both the build and the
deploy, and that each variable reaches the command that needs it - `AWS_DEPLOY_ROLE_ARN`
the credential step's `role-to-assume`, `AWS_ACCOUNT_ID` the `allowed-account-ids` guard
and the synth's `-c ens-scout:account=`, and
`AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN` the deploy's `--role-arn`.
A workflow that composed an ARN out of the account and a literal role name would satisfy
the deployment either way, so the assertion is what keeps the identifiers out of the
tree rather than a reviewer's attention.

`test/iam-render.test.ts` covers the render script itself: that the example values fill
every placeholder and no more, that rendering is deterministic and canonical, that a
value of the wrong shape is refused, that a refusal names the placeholder and never the
value supplied for it, and that the output directory is gitignored.
That last set is what makes it safe to render the real documents locally.

## Layout

```text
bin/ens-scout.ts              app entry point; resolves context and the environment
lib/config.ts                 context keys, validation, and the scan tuning
lib/deployment.ts             the bootstrap qualifier, the asset bucket, and the synthesizer
lib/api-bundle.ts              locates the built read API bundle
lib/public-site.ts             HTTP API, private bucket, CloudFront, and cache policies
lib/schedules.ts              the two schedules and the cron expansion used to prove the offset
lib/ens-scout-stack.ts        the stack
lib/scanner-bundle.ts         locates the bundle the CDK app packages
lib/spa.ts                    the extensionless-route viewer-request rewrite
lib/website-bundle.ts         locates web/dist and its hashed assets
iam/                          templates of the four documents applied to the two deployment roles
scripts/bundle-scanner.js     reproducible cross-compile of both Lambda entrypoints
scripts/render-iam.js         the one path from an iam/ template to a document
test/                         the assertion suite
test/fixtures/scan-lambda/    fixed-hash stand-in for the compiled scanner
test/fixtures/api-lambda/     fixed-hash stand-in for the compiled API
test/fixtures/web/            fixed-hash stand-in for the production web build
```

## Design notes

**The caller's own credentials, not the CDK bootstrap roles.** The default synthesizer
makes every deployment assume `cdk-hnb659fds-deploy-role`, which may pass
`cdk-hnb659fds-cfn-exec-role`, and that role carries `AdministratorAccess` and can be
passed to any stack.
An identity permitted to assume the deploy role is therefore an account administrator by
another name, and the deploy role's own `iam:PassRole` is restricted to exactly that
admin-capable role, so a narrower execution role cannot be substituted through the chain.
`lib/deployment.ts` selects `CliCredentialsStackSynthesizer` to remove the hop, which is
what makes the two narrow roles `iam/` describes reachable at all.
The cost is that the bootstrap roles go unused while the bootstrap stack is still
required, because the qualifier names the asset bucket and the version parameter.

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

**One public origin.** The Vite build is stored in a private S3 bucket and read
through CloudFront OAC. The HTTP API is the second origin under the same
distribution, so the production build uses `VITE_API_BASE_URL=/` and never needs a
custom domain or a cross-origin browser grant. The execute-api endpoint still
exists as CloudFront's origin, but the Lambda adapter accepts it only when the
request carries the stack-generated origin token CloudFront overwrites and forwards.
That authenticated adapter may then trust `CloudFront-Viewer-Address` for the
fresh-check client identity; a caller-controlled forwarding header never reaches
the limiter as identity.

**SPA fallback is a path rewrite, not an error rewrite.** The viewer-request
function rewrites only extensionless shell routes on the default behavior.
`assets/*` has no function association, concrete file names keep their path, and
the distribution defines no custom error response, so a missing immutable asset
cannot return `index.html`.

**Four cache classes.** The HTML shell and unhashed files do not cache, Vite's
content-hashed assets cache for one year as immutable, snapshot GET/HEAD traffic
uses the API's short cache lifetime under a one-hour ceiling, and health,
fresh-check, and other `/api/*` traffic is cache-disabled. `internal/api` remains
the authority for ETag, `Cache-Control`, CORS, and `no-store`.
The API entrypoint also sets the raw snapshot ceiling to 4 MiB, leaving room for
the JSON-escaped Lambda proxy envelope under the buffered response limit.

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

**One table, and the fresh-check allowances live in it too.** `internal/checkstore` is
the authority for the per-client throttle, the upstream budget, and the short-lived
result cache, because a Lambda deployment runs many instances at once and a per-instance
allowance is that allowance times however many instances a caller reaches.
`internal/dynamo.CheckStore` puts all three in this table under their own partition
prefixes, which cannot collide with a snapshot key, so nothing here provisions a second
table.
What the table owes them is the two string keys and TTL on the same attribute the
publisher uses, and `test/check-store.test.ts` asserts exactly that against the Go
definitions.
The API role reads published snapshots only under `META` and `SNAPSHOT#` keys and
writes only the `CHECKRATE#` and `CHECKRESULT#` keyspaces. The stable check-client
secret is generated once by the stack, reaches only the API environment through a
dynamic reference, and never reaches the scanner, an output, or an asset.
