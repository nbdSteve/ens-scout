# Deployment

This document records how `EnsScout-prod` reaches its AWS account in `ap-southeast-2`,
and what the identity that deploys it is permitted to do.
It holds no credential and no secret value.
It also names no account number and no role name, and neither does any other tracked
file: those are public facts about a private deployment, so they live in the protected
`production` environment's variables and are read from there.

`infra/README.md` covers the CDK application itself, including the out-of-band
prerequisites, and `.github/workflows/deploy-production.yml` is the only workflow that
deploys.

## The four variables

Everything the deployment needs to know about the account is a variable on the
`production` environment.
There are four, and none of them is secret.

| Variable | What it holds |
| --- | --- |
| `AWS_ACCOUNT_ID` | The twelve-digit account, as a bare account number |
| `AWS_REGION` | `ap-southeast-2` |
| `AWS_DEPLOY_ROLE_ARN` | The whole ARN of the role GitHub Actions assumes |
| `AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN` | The whole ARN of the role CloudFormation acts as |

Both roles are supplied as whole ARNs rather than assembled from the account and a role
name.
Composing one in the workflow would put a role name back in a tracked file, and it would
also let a variable disagree with the ARN the workflow built out of it.
`AWS_ACCOUNT_ID` exists as a separate value because two things genuinely need the account
on its own: the CDK stack environment, which is an account and a region rather than an
ARN, and the `allowed-account-ids` guard on the credential step.

The deploy job's first step refuses to build anything until all four are present, the
account is twelve digits and is not the placeholder `infra/cdk.json` commits, the region
is shaped like a region, both ARNs are IAM role ARNs in the account `AWS_ACCOUNT_ID`
names, and the two ARNs are not the same role.
It prints variable names and never values.
`infra/test/deployment.test.ts` asserts that the step comes before the build and the
deploy, that every variable the workflow reads is one the step requires, and that each
one reaches the command that needs it.

## The path

Every successful `checks` workflow for a push to `main` automatically queues the exact
commit it checked for production. A manual `workflow_dispatch` remains available only
as a recovery path from `main`; it does not approve, release, or otherwise participate
in the automatic path.

1. `checks.yml` runs for the push to `main`.
2. When that run completes, GitHub starts `deploy production` through `workflow_run`.
   The trigger names the `checks` workflow, the `completed` activity, and the `main`
   branch, but those filters are not treated as the authorization boundary.
3. The unprivileged selector job emits a deploy SHA only when the upstream event was
   `push`, its conclusion was `success`, its head branch was `main`, and its head
   repository was `nbdSteve/ens-scout`. The emitted value is exactly
   `github.event.workflow_run.head_sha`, and it must be a full commit ID. A failed run,
   pull-request run, fork run, or non-main run emits nothing, so the deploy job is
   skipped before it can enter the environment or request an OIDC token.
   For a recovery dispatch, the same selector accepts only `refs/heads/main` and emits
   the immutable `github.sha` recorded on that dispatch.
4. The deploy job runs only when that one output is present. It declares
   `environment: production`, whose custom deployment branch policy names `main` alone
   and whose protection rules require no reviewer interaction.
5. The job checks the four variables described above, then checks out the selected
   full SHA and verifies that `git rev-parse HEAD` is the same value. It never checks
   out a moving branch for a deployment.
6. The job builds `web/dist` with `VITE_API_BASE_URL=/`, so the browser uses the
   generated CloudFront hostname for both the page and `/api/*`.
7. The job builds, tests, and synthesizes once with
   `npm run check -- --context "ens-scout:account=$AWS_ACCOUNT_ID"`, which leaves the
   whole cloud assembly - the template, both Go binaries, and that web build - in
   `infra/cdk.out`.
8. It records that selected SHA and the synthesized template's SHA-256, then requests
   an OIDC token and assumes the role `AWS_DEPLOY_ROLE_ARN` names.
9. It runs `cdk deploy --app cdk.out --role-arn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN"`,
   which deploys the assembly step 7 verified and synthesizes nothing new.
10. It writes the stack's generated HTTPS `PublicSiteUrl` output to the GitHub
    deployment summary.

The build happens before the credential is obtained, so a failing check costs no AWS
session at all.
The deploy step reads the assembly rather than re-running the app, which is what makes
the artifact that reaches AWS the one the checks passed rather than an equal one built a
second time.
The selected SHA is the single identity used by checkout, verification, the artifact
summary, and the build that creates that assembly, so a later move of `main` cannot
change what an already-triggered run deploys.

That is also why the account is supplied at step 7 rather than at step 9.
`--app cdk.out` deploys the assembly, and the stack environment is baked into it, so the
real account has to be present at the synth that produced the artifact.
`infra/cdk.json` commits `infra/lib/config.ts`'s `placeholderAccount` instead, which is
what lets a clean clone, every pull-request check, and every test synthesize the stack
without the real value.
`npm run check` ends with the synth, so the trailing arguments reach `cdk synth` and
nothing else; a test asserts that, because a check script reordered to end with the tests
would send the context to jest and deploy an artifact built against the placeholder.

Step 5 compiles both Lambda entrypoints, because every CDK command bundles them
first, so the Go toolchain is part of what this job produces.
Every `setup-go` step in `.github/workflows/` therefore pins one exact version rather
than a channel that resolves to whatever was released most recently, and
`infra/test/deployment.test.ts` fails when the pins disagree.
Each Lambda asset hash is the content hash of its binary, so a deploy running a
compiler no pull request had run would report an update for source nobody changed.
Raising the pin is a deliberate change, and `AGENTS.md` records what else has to move
with it.

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

All four applied documents are in `infra/iam/`, as templates.
The applied documents name the account and the execution role, so every such position is
an explicit `${PLACEHOLDER}`, `infra/iam/README.md` says which, and
`infra/scripts/render-iam.js` is the one path from a template to a document.
Rendering is deterministic and writes to the gitignored `infra/iam/rendered/`, so a
rendered document can be diffed against what a role really carries.
Nothing in this repository applies one, and no workflow here has the permission to.

`infra/test/deployment.test.ts` renders the templates with `infra/iam/example-values.json`
and asserts them against `lib/deployment.ts` and the committed CDK context, so a
qualifier, region, account, stack name, or secret name that moves in one place and not
the other fails a test rather than a deployment.
The example account is the same placeholder `infra/cdk.json` commits, which is what keeps
those assertions a tie rather than a comparison of two literals.
Everything else in the templates stays a literal for the same reason: a placeholder for
the region or the secret name would make the tie tautological.

### The deployment role, `AWS_DEPLOY_ROLE_ARN`

The identity GitHub Actions assumes.
One inline policy and no attached managed policy.

Trust: `sts:AssumeRoleWithWebIdentity` through this account's own
`token.actions.githubusercontent.com` provider, with `StringEquals` on both
`:aud = sts.amazonaws.com` and
`:sub = repo:nbdSteve/ens-scout:environment:production`.
Matching the subject with `StringEquals` rather than `StringLike` is the whole
restriction: a pattern such as `repo:nbdSteve/ens-scout:*` would admit every branch and
every pull request of this repository and bypass the environment protection entirely.

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
S3 bucket name AWS requires, API Gateway's ID-addressed paths, and the CloudFront
and random-secret-generation calls whose APIs do not provide a stack-name resource
scope. A new exception is a failing test rather than a quiet widening.

What it deliberately does not hold:

- No `iam:AttachRolePolicy` or `iam:DetachRolePolicy`.
  The scanner's role gets an inline policy only, so nothing is lost, and the exclusion is
  what stops this role from attaching `AdministratorAccess` to a role it can also pass to
  Lambda.
- No `iam:PutRolePermissionsBoundary`, no policy creation, and no user or access-key
  creation.
- One `iam:PassRole`, on `role/EnsScout-prod-*`, conditioned on
  `iam:PassedToService = lambda.amazonaws.com`.
- `secretsmanager:GetSecretValue` on the existing Graph secret, plus create,
  update, add-version, delete, describe, tag, and read on
  `secret:EnsScout-prod-*` for the two generated serving secrets, and
  `GetRandomPassword` for their generated values.
  The Graph credential reaches the function as a CloudFormation dynamic reference that
  this role resolves, and the generated check/origin values reach their consumers the
  same way. Those grants are here and not on any runtime role;
  `infra/README.md` records that trade-off.

## The GitHub configuration

Repository `nbdSteve/ens-scout`.

- Environment `production`, with no required reviewers and a custom deployment branch
  policy that names `main` alone.
- The four variables above, held on that environment.
  None is secret by nature, and the workflow refuses to run without them.
- No Actions secret holds an AWS credential, and there is no AWS access key anywhere in
  the repository or its settings.
  The OIDC token the deploy job requests is the entire credential path, and it is
  requested on that one job.

`checks.yml` runs the three repository gates on every pull request and on a push to
`main`, and requests no `id-token` at all, so nothing on that path can reach the account.
Only its successful same-repository `push` run on `main` can supply a deploy SHA; a
successful pull request, including one from a fork or a branch also named `main`, cannot.
The checks also need none of the four variables: they synthesize against the committed
placeholder account, which is the whole reason that placeholder exists.

## Residual risks

These are accepted rather than closed, and each is a deliberate decision.

1. The execution role can create a role under `EnsScout-prod-*`, put an inline policy on
   it, and pass it to Lambda, which is a theoretical privilege-escalation path from that
   role to arbitrary permissions.
   Reaching it needs a change to the stack definition, a merge to `main`, and a successful
   `main` checks run; that success now deploys automatically.
   A permissions boundary on that `iam:PutRolePolicy` grant is the follow-up that would
   close it properly.
2. The execution role's action set was derived from the committed stack rather than proved
   by a deployment, because this repository does not deploy.
   The first real deployment may therefore surface a missing action.
   The failure mode is a denied CloudFormation call and a rolled-back stack, not a partial
   deployment of the wrong thing.
3. Neither role is defined in CDK, so nothing synthesizes them and nothing detects drift.
   `infra/iam/` plus the test is what keeps the templates honest, and rendering them is
   deterministic, so a drift check is a diff someone runs rather than something this
   repository performs.
4. The account number and the role names are absent from the repository and present in
   the environment's variables, which moves them out of a public git history and into
   settings a repository administrator can read.
   That is the intended trade: it removes them from every clone, every fork, and every
   search index, and it does not make them secret.
