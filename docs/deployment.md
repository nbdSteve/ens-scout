# Deployment

This document records how `EnsScout-prod` reaches its AWS account in `ap-southeast-2`,
and what the identity that deploys it is permitted to do.
It holds no credential and no secret value.
It also names no real account number, role name, role ARN, hosted-zone ID, certificate
ARN, or numeric GitHub repository identity. The account, roles, zone, and certificate
live in the protected `production` environment's secrets; the region is its one
variable; the immutable GitHub identity stays in GitHub's repository configuration and
is supplied only when the deployment-role trust document is rendered.

`infra/README.md` covers the CDK application itself, including the out-of-band
prerequisites, and `.github/workflows/deploy-production.yml` is the only workflow that
deploys.

## The six values

Everything the deployment needs to know about the account is a secret or a variable on
the `production` environment.
There are six: five secrets and one variable.

| Name | Kind | What it holds |
| --- | --- | --- |
| `AWS_ACCOUNT_ID` | Secret | The twelve-digit account, as a bare account number |
| `AWS_REGION` | Variable | `ap-southeast-2` |
| `AWS_DEPLOY_ROLE_ARN` | Secret | The whole ARN of the role GitHub Actions assumes |
| `AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN` | Secret | The whole ARN of the role CloudFormation acts as |
| `AWS_ROUTE53_HOSTED_ZONE_ID` | Secret | The existing public Route 53 zone containing `ens.steve.gg` |
| `AWS_ACM_CERTIFICATE_ARN` | Secret | The existing `us-east-1` ACM certificate covering `ens.steve.gg` |

They are secrets because a repository may be public and its deploy logs are readable by
anyone.
A variable used in `env:` or `with:` is printed in the step header, where a secret is
masked, and the certificate ARN embeds the account, so it is a secret too.
The region is not account-specific and stays a variable.
Environment secrets reach only a job that declares the `production` environment, which
is what keeps the build job from reading them.
Do not create a repository-level secret for any of them: that would make it readable by
the build job.

`aws-actions/configure-aws-credentials` does not mask the account ID in its own output by
default, so the credentials step sets `mask-aws-account-id: true`, and it sets
`allowed-account-ids` to the account secret.
No step prints a value.

Both roles are supplied as whole ARNs rather than assembled from the account and a role
name.
Composing one in the workflow would put a role name back in a tracked file, and it would
also let a value disagree with the ARN the workflow built out of it.
`AWS_ACCOUNT_ID` exists as a separate value because the `allowed-account-ids` guard on
the credential step needs the account on its own.

The deploy job's first step refuses to run anything until all six are present, the
account is twelve digits and is not the placeholder `infra/cdk.json` commits, the region
is shaped like a region, both ARNs are IAM role ARNs in the account `AWS_ACCOUNT_ID`
names, the hosted-zone ID is shaped like a Route 53 zone ID, the certificate ARN names
`us-east-1` and the same account, and the two role ARNs are not the same role.
It prints names and never values.
`infra/test/deployment.test.ts` asserts that the step comes first, that every secret and
variable the workflow reads is one the step requires, that only the region is a variable,
and that each value reaches the command that needs it.

## The path

Every successful `checks` workflow for a push to `main` automatically queues the exact
commit it checked for production. A manual `workflow_dispatch` remains available only
as a recovery path from `main`; it does not approve, release, or otherwise participate
in the automatic path.

The work is three jobs, and the split is a security boundary.
The job that holds the OIDC token must not run third-party build code, because anything
that can request the token can assume the deployment role and send the stack any
template.
A package install script, a Go module, a web build step, or a test is such code, so none
of them runs in that job.
The deploy job still acts on data the build job controls, which is why it validates that
data first (below).

1. `checks.yml` runs for the push to `main`.
2. When that run completes, GitHub starts `deploy production` through `workflow_run`.
   The trigger names the `checks` workflow, the `completed` activity, and the `main`
   branch, but those filters are not treated as the authorization boundary.
3. The unprivileged `select` job emits a deploy SHA only when the upstream event was
   `push`, its conclusion was `success`, its head branch was `main`, and its head
   repository was `nbdSteve/ens-scout`. The emitted value is exactly
   `github.event.workflow_run.head_sha`, and it must be a full commit ID. A failed run,
   pull-request run, fork run, or non-main run emits nothing, so the later jobs are
   skipped before anything runs.
   For a recovery dispatch, the same selector accepts only `refs/heads/main` and emits
   the immutable `github.sha` recorded on that dispatch.
4. The `build` job checks out that full SHA and verifies that `git rev-parse HEAD` is the
   same value. It has `contents: read` and nothing else: no `id-token`, no
   `production` environment, so no secret and no variable of that environment, and no
   AWS credential. It builds `web/dist` with `VITE_API_BASE_URL=/`, so the browser stays
   on the hostname that reached CloudFront for both the page and `/api/*`, then runs
   `npm run check` with `ens-scout:deferDeploymentIdentifiers=true`. That is
   `tsc --noEmit`, the assertion suite, and a synth, and it leaves the whole cloud
   assembly - the template, both Go binaries, and the web build - in `infra/cdk.out`.
   It packs `cdk.out` into a tar, because the artifact actions save every file as mode
   644 and the Lambda `bootstrap` binaries would lose their execute bit, reports the
   tar's SHA-256 as a job output, and uploads it as an artifact kept for one day.
5. The `deploy` job declares `environment: production`, whose custom deployment branch
   policy names `main` alone and whose protection rules require no reviewer
   interaction, and is the only job with `id-token: write`. It checks the six values
   first, then downloads the assembly tar, compares its hash with the one `build` reported
   (which protects the transfer only), unpacks it, and validates it. It checks out
   nothing, restores no cache, and runs no repository code.
6. The validation step allows only what today's synth produces: the artifact kinds, the
   agnostic stack environment with no assumed or lookup role, no docker image assets,
   file asset sources that are relative paths inside `cdk.out` with no `executable`,
   the bootstrap bucket as the only destination, no symlinks, and a template asset that
   is the hashed template. `cdk deploy --app` reads the asset manifest, and the schema
   lets a file source name an `executable` the CLI runs with the credentials in its
   environment, so without this step the build job could run code in the token job.
   It records the selected SHA and the template's SHA-256 in the job summary, installs
   the `aws-cdk` CLI at the exact version `infra/package.json` pins with
   `--ignore-scripts`, and only then requests an OIDC token and assumes the role
   `AWS_DEPLOY_ROLE_ARN` names.
7. It runs `cdk deploy --app cdk.out --role-arn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN"`
   with the two `--parameters` described below, which deploys the assembly `build`
   verified and synthesizes nothing new.
8. It writes the stack's generated HTTPS `PublicSiteUrl` output to the GitHub deployment
   summary. The CLI's own output goes to a file that is deleted, so nothing but that
   URL, the commit, and the template hash reaches a log.

The build happens before the credential is obtained, so a failing check costs no AWS
session at all.
The deploy step reads the assembly rather than re-running the app, which is what makes
the artifact that reaches AWS the one the checks passed rather than an equal one built a
second time.
The selected SHA is the single identity used by checkout, verification, the artifact
summary, and the build that creates that assembly, so a later move of `main` cannot
change what an already-triggered run deploys.
Concurrency is one `deploy-production` group for the whole run and never cancels one in
flight, so two deployments cannot overlap.

### How the account stays out of the assembly

The stack needs the account, the hosted-zone ID, and the certificate ARN, and the build
job may hold none of them: environment secrets reach only a job that declares the
environment, and that job is the one holding the token.
With `ens-scout:deferDeploymentIdentifiers=true` the stack is environment-agnostic in the
account, so `cdk deploy` resolves the account from the credentials it runs with, and the
zone ID and certificate ARN are two required, `NoEcho` CloudFormation parameters,
`SiteHostedZoneId` and `SiteCertificateArn`, with no default.
The deploy job supplies them through `--parameters` from its own secrets.
A deployment that forgot one fails in CloudFormation rather than deploying at a
placeholder, and the assembly, which is an artifact anyone who can read the repository
may download, names no account, zone, or certificate.
`infra/cdk.json` commits the flag false and the safe placeholders, which let a clean
clone, every pull-request check, and every test synthesize the stack without the real
values; `lib/deployment.ts` holds the mechanism.
`npm run check` ends with the synth, so the trailing argument reaches `cdk synth` and
nothing else; a test asserts that, because a check script reordered to end with the
tests would send the context to jest and upload an assembly that still named the
placeholders.

The build job's tests run at the committed context, not the deferred one, so a test
synthesizes the deferred stack itself and asserts that it names no twelve-digit number,
declares exactly those two parameters, and differs from the committed-context stack in no
resource.

Compiling both Lambda entrypoints is part of the `build` job, because every CDK command
bundles them first, so the Go toolchain is part of what that job produces.
Every `setup-go` step in `.github/workflows/` therefore pins one exact version rather
than a channel that resolves to whatever was released most recently, and
`infra/test/deployment.test.ts` fails when the pins disagree.
Each Lambda asset hash is the content hash of its binary, so a build running a
compiler no pull request had run would report an update for source nobody changed.
Raising the pin is a deliberate change, and `AGENTS.md` records what else has to move
with it.

### What the split does and does not buy

It stops code that runs while building from requesting the token, assuming the deployment
role, or reading an account value.
It does not stop the `build` job from handing the `deploy` job a different template: the
assembly is produced by the job that runs third-party code, and the hash comparison only
catches a transfer that differs from what `build` reported.
The validation step closes the way an assembly could run code in the deploy job; it does
not inspect the template, which is bounded instead.
What stops a hostile template from becoming account access is the permissions boundary,
described under the execution role below.

## Post-deploy smoke sequence

Run this only after the trusted `main` deployment succeeds.
Use the exact deployed SHA and copy the generated `PublicSiteUrl` from that run's deployment summary.
The sequence is read-only: do not deploy, invoke a scanner, mutate AWS, or send `POST /api/check`.

From the repository root, replace the generated URL placeholder and capture the two origins under the ignored Playwright output directory:

```bash
CUSTOM_SITE='https://ens.steve.gg'
GENERATED_SITE='<PublicSiteUrl copied from the deployment summary>'
SMOKE_OUTPUT='web/test-results/post-deploy'
mkdir -p "$SMOKE_OUTPUT"

for SITE_NAME in custom generated; do
  if [ "$SITE_NAME" = custom ]; then
    SITE_ORIGIN="$CUSTOM_SITE"
  else
    SITE_ORIGIN="$GENERATED_SITE"
  fi

  curl --fail-with-body --silent --show-error --compressed \
    --dump-header "$SMOKE_OUTPUT/$SITE_NAME-health.headers" \
    --output "$SMOKE_OUTPUT/$SITE_NAME-health.json" \
    "$SITE_ORIGIN/health"
  curl --fail-with-body --silent --show-error --compressed \
    --dump-header "$SMOKE_OUTPUT/$SITE_NAME-meta.headers" \
    --output "$SMOKE_OUTPUT/$SITE_NAME-meta.json" \
    "$SITE_ORIGIN/api/snapshot/meta"
  curl --fail-with-body --silent --show-error --compressed \
    --dump-header "$SMOKE_OUTPUT/$SITE_NAME-rank.headers" \
    --output "$SMOKE_OUTPUT/$SITE_NAME-rank.json" \
    "$SITE_ORIGIN/data/og-rank-v1.json"
done

jq -e '.status == "ok" and (.snapshot_id | type == "string")' \
  "$SMOKE_OUTPUT/custom-health.json" "$SMOKE_OUTPUT/generated-health.json"
jq -e '.format_version == 3 and (.snapshot_id | type == "string") and (.checksum | type == "string")' \
  "$SMOKE_OUTPUT/custom-meta.json" "$SMOKE_OUTPUT/generated-meta.json"
jq -e '.format_version == 1 and .rubric_version == "og-v1" and .policy_version == "featured-safe-v1" and (.items | length == 19051)' \
  "$SMOKE_OUTPUT/custom-rank.json" "$SMOKE_OUTPUT/generated-rank.json"
jq -S '{snapshot_id, checksum}' "$SMOKE_OUTPUT/custom-meta.json" > "$SMOKE_OUTPUT/custom-identity.json"
jq -S '{snapshot_id, checksum}' "$SMOKE_OUTPUT/generated-meta.json" > "$SMOKE_OUTPUT/generated-identity.json"
cmp "$SMOKE_OUTPUT/custom-identity.json" "$SMOKE_OUTPUT/generated-identity.json"
shasum -a 256 "$SMOKE_OUTPUT/custom-rank.json" "$SMOKE_OUTPUT/generated-rank.json"
```

The two rank hashes must match, and the two metadata identity documents must compare equal.
Review the captured headers for `200`, the expected content type, cache policy, and an entity tag on both cacheable API responses.
Do not fail the smoke solely because `/health` reports an old source; that is a publisher-freshness signal to investigate, while a non-`ok` health document or non-`200` response is a serving failure.

Use `chrome-devtools-axi` against each origin and save screenshots or traces only below `web/test-results/post-deploy/`.
At 1440 by 900, load `/`, confirm twelve featured name controls in ranked DOM order with no visible ranks or facet tags, and confirm there is no visible page header.
Confirm the one floating `Data` button covers neither a name nor an action, open it, confirm the compact `Featured ranking` facts and current snapshot join, press Escape, and confirm focus returns to Data.
Confirm no featured or raw name is a registration link before a fresh check, then use `Explore all` and verify that ordinary discovery receives focus.
Load `/?q=zine`, confirm the hero is bypassed and the search, filters, pagination, snapshot notice, and matching result remain usable.
At 390 CSS pixels and at 320 by 568, repeat the root and deep-link checks, confirm the mobile hero contains seven names, and confirm the floating Data button, check action, Explore action, and long-name content remain fully visible without horizontal document overflow.
Repeat the keyboard path with reduced motion enabled, then inspect the Network panel and confirm requests stay on the current origin and include only the application assets, rank artifact, and read-only snapshot paths.
Any model host, model asset, provider call, WebGPU probe, cross-origin API request, or request to `/api/check` fails the smoke.
The normal trusted-main pipeline owns deployment; this live verification is a separate post-deploy activity and never runs from a pull-request worktree.

## Why the bootstrap roles are not used

`infra/lib/deployment.ts` selects `CliCredentialsStackSynthesizer`, so the deployment
uses the caller's own credentials and publishes assets to the bootstrap bucket directly.
The four bootstrap roles go unused; the bootstrap stack is still required, because the
qualifier names the asset bucket and the version parameter.

The default synthesizer would make every deployment assume `cdk-hnb659fds-deploy-role`,
and that role may pass `cdk-hnb659fds-cfn-exec-role`, which carries
`AdministratorAccess` and can be passed to any stack.
An identity permitted to assume the deploy role is therefore an account administrator by
another name, whatever its own policy says.
Substituting a narrower execution role through that chain does not work either: the
bootstrap deploy role's `iam:PassRole` is restricted to exactly the admin-capable role.
Removing the hop is what makes least privilege reachable here.

## The two roles

The applied documents are in `infra/iam/`, as templates: the two roles' trust and policy documents, the permissions boundary policy, and a transition version of the execution role's policy used once during rollout.
The applied documents name the account, the execution role, the hosted-zone ID, and the
immutable GitHub repository identity, so every such position is an explicit `${PLACEHOLDER}`,
`infra/iam/README.md` says which, and `infra/scripts/render-iam.js` is the one path
from a template to a document.
Rendering is deterministic and writes to the gitignored `infra/iam/rendered/`, so a
rendered document can be diffed against what a role really carries.
Nothing in this repository applies one, and no workflow here has the permission to.

`infra/test/deployment.test.ts` renders the templates with `infra/iam/example-values.json`
and asserts them against `lib/deployment.ts` and the committed CDK context, so a
qualifier, region, account, stack name, or secret name that moves in one place and not
the other fails a test rather than a deployment.
The example account is the same placeholder `infra/cdk.json` commits, and the example
GitHub identity has synthetic positive decimal identifiers, so no live identifier is
needed to exercise the whole contract.
That is what keeps the account assertions a tie rather than a comparison of two literals.
Everything else in the templates stays a literal for the same reason: a placeholder for
the region or the secret name would make the tie tautological.

### The deployment role, `AWS_DEPLOY_ROLE_ARN`

The identity GitHub Actions assumes.
One inline policy and no attached managed policy.

Trust: `sts:AssumeRoleWithWebIdentity` through this account's own
`token.actions.githubusercontent.com` provider, with `StringEquals` on both
`:aud = sts.amazonaws.com` and
`:sub = repo:${GITHUB_REPOSITORY_IDENTITY}:environment:production`.
The placeholder is the exact immutable identity segment reported by the repository OIDC
customization: `nbdSteve@<owner-id>/ens-scout@<repository-id>`.
Both identifiers are canonical positive base-10 integers; the renderer refuses a
missing, duplicate, extra, malformed, signed, zero, leading-zero, or non-decimal value
without printing it.
The old repository-name-only subject does not match a token issued under immutable
subjects.
Matching the subject with `StringEquals` rather than `StringLike` is the whole AWS-side
restriction: a prefix pattern would admit contexts the production environment excludes.
A pull request, an ordinary branch ref, and another environment have a different
context, while a fork has a different immutable repository identity.
The selector and the `production` environment's main-only branch policy stop a non-main
run before the deploy job can request any token.

Permissions, five statements:

| Statement | Grant |
| --- | --- |
| `DeployTheEnsScoutStackAndNoOther` | The CloudFormation calls a deploy makes, on `stack/EnsScout-prod/*` alone |
| `CloudFormationCallsThatTakeNoResource` | `GetTemplateSummary`, `ListStacks`, `sts:GetCallerIdentity` |
| `PublishCdkAssetsToTheBootstrapBucket` | Read and write on `cdk-hnb659fds-assets-<account>-ap-southeast-2`, conditioned on `aws:ResourceAccount` |
| `ReadTheBootstrapVersion` | `ssm:GetParameter` on `/cdk-bootstrap/hnb659fds/version` |
| `PassOnlyTheEnsScoutExecutionRoleAndOnlyToCloudFormation` | `iam:PassRole` on the one execution role, conditioned on `iam:PassedToService` |

That last statement is the tie the `AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN` variable has
to honour.
It names one role, so an ARN naming any other one is denied at the deploy step rather
than widened here.

What it deliberately does not hold:

- No permission over DynamoDB, Lambda, IAM, EventBridge, SQS, SNS, CloudWatch, or
  Secrets Manager.
  CloudFormation makes those calls as the execution role, so this identity needs none of
  them.
- No `s3:Delete*`.
  Assets are content-addressed and immutable, so nothing on the deployment path removes
  one, and an identity that could would be able to break the running function by
  deleting the object its code points at.
- No `iam:` action but that one conditioned `PassRole`.
  Without the `iam:PassedToService` condition the grant would be a general
  privilege-escalation path, because the role could be handed to any service that
  assumes it.
- `cloudformation:DeleteStack` is granted, on the single stack ARN.
  A first deploy that fails leaves a `ROLLBACK_COMPLETE` or `REVIEW_IN_PROGRESS` stack
  that CDK has to remove before it can retry, and refusing that would wedge the first
  release on exactly the failure it is most likely to hit.
  The durable resources are `RemovalPolicy.RETAIN` and the table has deletion
  protection, so the data survives a stack deletion.

### The CloudFormation execution role, `AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN`

The identity CloudFormation creates and updates the stack's resources as.
One inline policy and no attached managed policy.
Trust: `cloudformation.amazonaws.com` and nothing else.

Most resources it names carry the `EnsScout-prod-` prefix CloudFormation gives an
auto-named resource. The exceptions are pinned in
`infra/test/deployment.test.ts`: regional or no-resource describe calls, the
existing Graph secret, the bootstrap bucket and version parameter, the lowercase
S3 bucket name AWS requires, API Gateway's ID-addressed paths, the two generated
serving-secret prefixes, the two CDK bucket-deployment layer prefixes, and the
CloudFront and random-secret-generation calls whose APIs do not provide a stack-name
resource scope. Route 53 is split across the exact hosted-zone ARN, change ARNs, and
the no-resource `ListHostedZones` call its CloudFormation provider declares. A new
exception is a failing test rather than a quiet widening.

What it deliberately does not hold:

- No unconditioned grant of the calls that shape a role. `iam:CreateRole`,
  `iam:PutRolePolicy`, `iam:DeleteRolePolicy`, and `iam:PutRolePermissionsBoundary` are allowed only on
  `role/EnsScout-prod-*` and only when `iam:PermissionsBoundary` equals the ARN of
  `EnsScout-prod-PermissionsBoundary`, the customer-managed policy every role in the
  stack carries as its boundary.
  A role the template creates without it is refused at creation, and one with it can
  never be granted more than the boundary allows, so a template that creates a role with
  `AdministratorAccess` and passes it to Lambda gets a role that can still do nothing but
  what the stack's own three roles already do.
- No `iam:AttachRolePolicy` or `iam:DetachRolePolicy`: the stack's roles take inline
  policies only, and the exclusion stops this role attaching `AdministratorAccess`.
- No `iam:DeleteRolePermissionsBoundary` in the final policy, so the boundary cannot be
  removed from a role. The transition policy used for one rollout deploy allows it under
  the boundary condition, so that deploy can roll back.
- No policy creation or change and no user or access-key creation, so the boundary policy
  cannot be edited through this role and no principal outside the stack's roles can be
  made.
- One `iam:PassRole`, on `role/EnsScout-prod-*`, conditioned on
  `iam:PassedToService = lambda.amazonaws.com`.
- Publish, read, and delete versions of only the two AWS CLI layers CDK generates for
  the shell and immutable-asset bucket deployments, under their
  `PublicSiteDeployWebsite...AwsCliLayer` prefixes.
- `secretsmanager:GetSecretValue` on the existing Graph secret, plus create,
  update, add-version, delete, describe, tag, and read on
  the `secret:PublicSiteCheckClientSecret*` and
  `secret:PublicSiteOriginSecret*` prefixes for the two generated serving secrets,
  and `GetRandomPassword` for their generated values.
  The Graph credential reaches the function as a CloudFormation dynamic reference that
  this role resolves, and the generated check/origin values reach their consumers the
  same way. Those grants are here and not on any runtime role;
  `infra/README.md` records that trade-off.
- `route53:ChangeResourceRecordSets`, `GetHostedZone`, and
  `ListResourceRecordSets` on the one hosted-zone ARN; `GetChange` on Route 53 change
  ARNs; and `ListHostedZones` on `*`, because that action offers no resource scope.
  Those are the `AWS::Route53::RecordSet` provider's declared calls and nothing else.
- No ACM action. The stack supplies the already-issued certificate ARN directly to
  CloudFront and creates, updates, and reads no ACM resource.

### The permissions boundary

`infra/iam/permissions-boundary-policy.template.json` is a customer-managed policy, and
it costs nothing.
It allows exactly what the stack's three roles are granted - log writes to the stack's
log groups, five DynamoDB item calls on its table, read of the CDK asset bucket, and
read, write, and delete in its private website bucket - and nothing from IAM or STS.
The stack applies it to every `AWS::IAM::Role` it contains (`lib/ens-scout-stack.ts`),
the app and the tests alike, and `test/deployment.test.ts` asserts that every role in the
production template carries it, with and without the deferred identifiers, and that the
policy is derived from the template's own role policies in both directions.
The policy is configuration in the account rather than a resource in the stack, because
a stack that created its own ceiling could raise it.
`infra/iam/README.md` is the rollout plan for the live account and the order it has to go
in.

A trust policy cannot be conditioned, so a template can still create a bounded role that
another principal may assume.
That role has the boundary's permissions and no more, which is this stack's own table,
log groups, and buckets.

## The GitHub configuration

Repository `nbdSteve/ens-scout`.

- Environment `production`, with no required reviewers and a custom deployment branch
  policy that names `main` alone.
- Repository OIDC subjects use GitHub's immutable repository identity. The live numeric
  values are not committed; the trust template holds `${GITHUB_REPOSITORY_IDENTITY}`.
- The five environment secrets and one environment variable above, held on that
  environment.
  The workflow refuses to run without them.
- No repository-level secret.
  A repository secret would be readable by the build job, which runs third-party code.
- No Actions secret holds an AWS credential, and there is no AWS access key anywhere in
  the repository or its settings.
  The OIDC token the deploy job requests is the entire credential path, and it is
  requested on that one job.

`checks.yml` runs the three repository gates on every pull request and on a push to
`main`, and requests no `id-token` at all, so nothing on that path can reach the account.
Only its successful same-repository `push` run on `main` can supply a deploy SHA; a
successful pull request, including one from a fork or a branch also named `main`, cannot.
The checks also need none of the six values: they synthesize against the committed
placeholder account, hosted-zone ID, and certificate ARN.

## Residual risks

These are accepted rather than closed, and each is a deliberate decision.

1. The `build` job can hand the `deploy` job any template, because it produces the
   assembly while running third-party code.
   The permissions boundary bounds what such a template can do with IAM: a role it
   creates carries a ceiling it cannot remove, and the ceiling is this stack's own table,
   log groups, and buckets.
   It does not bound the rest of the execution role, which can still change this stack's
   own resources, so a hostile template could still damage or replace the published site
   and its data, and could create a bounded role that another account may assume.
   Closing that needs a trusted source for the template, which is a different design.
   The actions the deploy job runs, and the CDK CLI it installs, are third-party code
   too: the CLI is pinned to an exact version with install scripts disabled, and the
   actions are referenced by major-version tag like every other workflow here, so pinning
   them to commit SHAs is the follow-up.
2. The execution role's action set was derived from the committed stack rather than proved
   by a deployment, because this repository does not deploy.
   The first real deployment may therefore surface a missing action.
   The failure mode is a denied CloudFormation call and a rolled-back stack, not a partial
   deployment of the wrong thing.
3. Neither role is defined in CDK, so nothing synthesizes them and nothing detects drift.
   `infra/iam/` plus the test is what keeps the templates honest, and rendering them is
   deterministic, so a drift check is a diff someone runs rather than something this
   repository performs.
4. The account number, role names, hosted-zone ID, certificate ARN, and live numeric
   GitHub repository identity are absent from the repository. The deployment identifiers
   are present in the environment's secrets, while GitHub itself holds the immutable
   identity used in OIDC subjects.
   That is the intended trade: it removes them from every clone, every fork, every search
   index, and every new deploy log, and it does not make the account or role names
   secret. Runs before this change printed some of them in step headers, and their logs
   keep them until the logs are deleted.
5. The deployment role's trust and policy, and the boundary, are applied by hand, so the
   rollout in `infra/iam/README.md` is manual and its order matters.
