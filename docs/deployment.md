# Deployment

This document records how `EnsScout-prod` reaches AWS account `289866763058` in
`ap-southeast-2`, and what the identity that deploys it is permitted to do.
It holds no credential and no secret value.

`infra/README.md` covers the CDK application itself, including the out-of-band
prerequisites, and `.github/workflows/deploy-production.yml` is the only workflow that
deploys.

## The path

One manual workflow run deploys, and nothing else can.

1. Someone dispatches `deploy production` on the default branch.
2. The job declares `environment: production`, so GitHub holds it for the reviewer that
   environment requires and refuses any ref the environment's branch policy does not
   name.
3. The job builds and verifies once with `npm run check`, which leaves the whole cloud
   assembly in `infra/cdk.out`.
4. It requests an OIDC token and assumes `EnsScoutGitHubDeployRole`.
5. It runs `cdk deploy --app cdk.out --role-arn ...EnsScoutCloudFormationExecutionRole`,
   which deploys the assembly step 3 verified and synthesizes nothing new.

The build happens before the credential is obtained, so a failing check costs no AWS
session at all.
The deploy step reads the assembly rather than re-running the app, which is what makes
the artifact that reaches AWS the one the checks passed rather than an equal one built a
second time.

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

The committed copies of all four documents are in `infra/iam/`, and
`infra/test/deployment.test.ts` asserts them against `lib/deployment.ts` and the
committed CDK context, so a qualifier, region, account, stack name, or secret name that
moves in one place and not the other fails a test rather than a deployment.
They were dumped from the live roles, so the committed copy is what is applied.

### `arn:aws:iam::289866763058:role/EnsScoutGitHubDeployRole`

The identity GitHub Actions assumes.
One inline policy, `EnsScoutGitHubDeploy`, and no attached managed policy.

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
| `PublishCdkAssetsToTheBootstrapBucket` | Read and write on `cdk-hnb659fds-assets-289866763058-ap-southeast-2`, conditioned on `aws:ResourceAccount` |
| `ReadTheBootstrapVersion` | `ssm:GetParameter` on `/cdk-bootstrap/hnb659fds/version` |
| `PassOnlyTheEnsScoutExecutionRoleAndOnlyToCloudFormation` | `iam:PassRole` on the one execution role, conditioned on `iam:PassedToService` |

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

### `arn:aws:iam::289866763058:role/EnsScoutCloudFormationExecutionRole`

The identity CloudFormation creates and updates the stack's resources as.
One inline policy, `EnsScoutStackResources`, and no attached managed policy.
Trust: `cloudformation.amazonaws.com` and nothing else.

Every resource it names carries the `EnsScout-prod-` prefix CloudFormation gives an
auto-named resource, except five grants that cannot be written that way: `DescribeAlarms`
takes no resource, `DescribeLogGroups` takes the region, and the secret, the asset
bucket, and the bootstrap version parameter are named directly.
The test pins that exception set, so a sixth one is a failing test rather than a quiet
widening.

What it deliberately does not hold:

- No `iam:AttachRolePolicy` or `iam:DetachRolePolicy`.
  The scanner's role gets an inline policy only, so nothing is lost, and the exclusion is
  what stops this role from attaching `AdministratorAccess` to a role it can also pass to
  Lambda.
- No `iam:PutRolePermissionsBoundary`, no policy creation, and no user or access-key
  creation.
- One `iam:PassRole`, on `role/EnsScout-prod-*`, conditioned on
  `iam:PassedToService = lambda.amazonaws.com`.
- `secretsmanager:GetSecretValue` on `secret:ens-scout/thegraph-api-key-*` only.
  The Graph credential reaches the function as a CloudFormation dynamic reference that
  this role resolves, which is why the grant is here and not on the scanner's own role;
  `infra/README.md` records that trade-off.

## The GitHub configuration

Repository `nbdSteve/ens-scout`.

- Environment `production`, with a required reviewer and a deployment branch policy that
  names `main` alone.
- Repository variables, all three non-secret by nature:
  `AWS_ACCOUNT_ID`, `AWS_REGION`, and `AWS_DEPLOY_ROLE_ARN`.
- No Actions secret holds an AWS credential, and there is no AWS access key anywhere in
  the repository or its settings.
  The OIDC token the deploy job requests is the entire credential path, and it is
  requested on that one job.

`checks.yml` runs the three repository gates on every pull request and on a push to
`main`, and requests no `id-token` at all, so nothing on that path can reach the account.

## Residual risks

These are accepted rather than closed, and each is a deliberate decision.

1. The execution role can create a role under `EnsScout-prod-*`, put an inline policy on
   it, and pass it to Lambda, which is a theoretical privilege-escalation path from that
   role to arbitrary permissions.
   Reaching it needs a change to the stack definition, which needs a merge to `main` and
   the production environment's approval.
   A permissions boundary on that `iam:PutRolePolicy` grant is the follow-up that would
   close it properly.
2. The execution role's action set was derived from the committed stack rather than proved
   by a deployment, because this repository does not deploy.
   The first real deployment may therefore surface a missing action.
   The failure mode is a denied CloudFormation call and a rolled-back stack, not a partial
   deployment of the wrong thing.
3. Neither role is defined in CDK, so nothing synthesizes them and nothing detects drift.
   `infra/iam/` plus the test is what keeps the committed copies honest, and the copies
   were dumped from the live roles.
