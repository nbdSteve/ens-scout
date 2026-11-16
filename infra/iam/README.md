# The deployment role documents

The documents applied to the two deployment roles and the stack's permissions boundary,
as templates.
They are configuration in an AWS account rather than resources in the stack, for the
reason [../README.md](../README.md) records, so nothing synthesizes them and nothing
detects drift: this directory plus `../test/deployment.test.ts` is what keeps them
honest.

The `*.template.json` files are committed source. They are templates rather than the
applied documents because the applied documents name the account, the execution role,
the hosted-zone ID, and GitHub's immutable repository identity, and none belongs in a
public repository.
Every such position is an explicit `${PLACEHOLDER}`:

| Placeholder | What it is | Where the real value lives |
| --- | --- | --- |
| `${ACCOUNT_ID}` | The twelve-digit target account | Protected `production` environment secret `AWS_ACCOUNT_ID` |
| `${CLOUDFORMATION_EXECUTION_ROLE_NAME}` | The role CloudFormation acts as | The role-name part of protected `production` environment secret `AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN`; the full ARN is not rendered |
| `${GITHUB_REPOSITORY_IDENTITY}` | GitHub's immutable `owner@owner-id/repository@repository-id` identity segment | The live repository OIDC customization; supplied out of band when rendering and never stored in a workflow secret or variable |
| `${ROUTE53_HOSTED_ZONE_ID}` | The public hosted zone whose ENS Scout records CloudFormation may manage | Protected `production` environment secret `AWS_ROUTE53_HOSTED_ZONE_ID` |

Everything else stays a literal, because it is committed elsewhere in this repository
already and the test ties the documents to that copy: the region and the secret name
to `../cdk.json`, the bootstrap qualifier to `../lib/deployment.ts`, and the stack
name to the environment name in context.
A placeholder for one of those would make the tie tautological.

## The documents

| Template | Applied to | Purpose |
| --- | --- | --- |
| `permissions-boundary-policy` | A customer-managed policy, `EnsScout-prod-PermissionsBoundary` | The ceiling on every IAM role the stack creates |
| `cloudformation-execution-role-policy` | The execution role, inline | The final policy: role-shaping calls only under the boundary |
| `cloudformation-execution-role-policy-transition` | The execution role, inline, for one step of the rollout | Today's role grants plus the two boundary calls, for one deploy |
| `cloudformation-execution-role-trust` | The execution role | Trusts CloudFormation only |
| `github-deploy-role-policy` | The deployment role, inline | Deploys one stack and passes one role |
| `github-deploy-role-trust` | The deployment role | Trusts one GitHub OIDC subject |

## Rendering

```powershell
node scripts/render-iam.js --example
node scripts/render-iam.js --account-id <twelve digits> --repository-identity <owner@owner-id/repository@repository-id> --execution-role-name <name> --route53-hosted-zone-id <id>
```

Both write to `iam/rendered/`, which is ignored by git; rendered documents are never
committed in place of the `*.template.json` source.
The rendering is deterministic - the same inputs produce the same bytes - and it
refuses a placeholder it does not know, a placeholder no value was supplied for, a
supplied value no template uses, a duplicate command-line value, and a value that is
not shaped like the thing it names.
The repository identity must name exactly `nbdSteve` and `ens-scout`, with one
canonical positive decimal identity after each name. Missing, extra, signed, zero,
leading-zero, and non-decimal forms are refused.
No diagnostic it prints contains a supplied value, because the run that renders the
real documents is the run whose output must stay free of every supplied identifier.

`--example` renders with `example-values.json`, whose account is the same placeholder
`../cdk.json` commits and whose GitHub identity uses synthetic positive decimals.
The example documents and the committed CDK context therefore agree, and a reviewer
can read a whole rendered policy without knowing any live identifier.

Rendered documents are applied out of band with `aws iam create-policy`,
`aws iam put-role-policy`, and `aws iam update-assume-role-policy`. Nothing in this repository applies them, and no
workflow here has the permission to.

## The permissions boundary

Before this, a template that reached the CloudFormation execution role could create a
role under `EnsScout-prod-*`, give it any inline policy, and pass it to Lambda.
A merge to `main` was not needed for that: any code in the job that held the OIDC token
could send the template, and the workflow is now split so such code runs elsewhere (see
[../../docs/deployment.md](../../docs/deployment.md)).
The boundary is what keeps the template from mattering once it gets there.

`permissions-boundary-policy` allows only what the stack's three roles are granted today:
log writes to its log groups, five DynamoDB item calls on its table, read of the CDK
asset bucket, and read, write, and delete in its private website bucket.
It names no `iam:`, `sts:`, or wildcard-service action and no unscoped resource.
`test/deployment.test.ts` derives it from the synthesized production template: every
action each role is granted must be in the boundary, and every action in the boundary
must be one a role uses, so a wider grant in the stack fails a test until the policy
moves with it, and a boundary that outgrew the stack does too.

The stack gives every `AWS::IAM::Role` that policy as its boundary
(`lib/deployment.ts`, applied in `lib/ens-scout-stack.ts`), and the final execution-role
policy allows `iam:CreateRole`, `iam:PutRolePolicy`, `iam:DeleteRolePolicy`, and
`iam:PutRolePermissionsBoundary` only when `iam:PermissionsBoundary` equals the policy's
ARN.
It attaches no managed policy (`iam:AttachRolePolicy` and `iam:DetachRolePolicy` are not
granted, because the stack uses inline policies only), never grants
`iam:DeleteRolePermissionsBoundary`, creates or changes no policy, user, or access key,
and keeps one `iam:PassRole`, on `role/EnsScout-prod-*` to Lambda alone.
Only the transition policy, which is applied for one deploy, also allows
`iam:DeleteRolePermissionsBoundary`, under the same condition.

What the boundary does not do: a trust policy cannot be conditioned, so a template can
still create a bounded role that another principal may assume.
That role has only what the boundary allows - this stack's table, log groups, and
buckets - and a template that controls the stack could change those resources directly
anyway.
It also does not constrain anything the execution role does outside IAM.
Those grants are as narrow as they were, and `docs/deployment.md` records them.

Example document, rendered with `node scripts/render-iam.js --example`
(the other five render the same way, into the gitignored `rendered/`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "WriteTheStackLogs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": [
        "arn:aws:logs:ap-southeast-2:000000000000:log-group:EnsScout-prod-*",
        "arn:aws:logs:ap-southeast-2:000000000000:log-group:EnsScout-prod-*:*"
      ]
    },
    {
      "Sid": "UseTheSnapshotTableItems",
      "Effect": "Allow",
      "Action": [
        "dynamodb:BatchWriteItem",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:UpdateItem"
      ],
      "Resource": "arn:aws:dynamodb:ap-southeast-2:000000000000:table/EnsScout-prod-*"
    },
    {
      "Sid": "ReadTheStackAssets",
      "Effect": "Allow",
      "Action": ["s3:GetBucket*", "s3:GetObject*", "s3:List*"],
      "Resource": [
        "arn:aws:s3:::cdk-hnb659fds-assets-000000000000-ap-southeast-2",
        "arn:aws:s3:::cdk-hnb659fds-assets-000000000000-ap-southeast-2/*"
      ],
      "Condition": { "StringEquals": { "aws:ResourceAccount": "000000000000" } }
    },
    {
      "Sid": "CopyTheWebsiteIntoItsPrivateBucket",
      "Effect": "Allow",
      "Action": [
        "s3:Abort*",
        "s3:DeleteObject*",
        "s3:GetBucket*",
        "s3:GetObject*",
        "s3:List*",
        "s3:PutObject",
        "s3:PutObjectLegalHold",
        "s3:PutObjectRetention",
        "s3:PutObjectTagging",
        "s3:PutObjectVersionTagging"
      ],
      "Resource": ["arn:aws:s3:::ensscout-prod-*", "arn:aws:s3:::ensscout-prod-*/*"],
      "Condition": { "StringEquals": { "aws:ResourceAccount": "000000000000" } }
    }
  ]
}
```

The role statements of the two execution-role policies, rendered the same way.
Every other statement is identical in both, and a test asserts it.

Transition (today's grants, plus the two boundary calls, so a failed deploy can roll back):

```json
[
  {
    "Sid": "StackLambdaRolesAndTheirInlinePolicies",
    "Effect": "Allow",
    "Action": [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
      "iam:PutRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription"
    ],
    "Resource": "arn:aws:iam::000000000000:role/EnsScout-prod-*"
  },
  {
    "Sid": "AttachOrRollBackThePermissionsBoundaryOnStackLambdaRoles",
    "Effect": "Allow",
    "Action": ["iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary"],
    "Resource": "arn:aws:iam::000000000000:role/EnsScout-prod-*",
    "Condition": {
      "StringEquals": {
        "iam:PermissionsBoundary": "arn:aws:iam::000000000000:policy/EnsScout-prod-PermissionsBoundary"
      }
    }
  }
]
```

Final:

```json
[
  {
    "Sid": "StackLambdaRolesLifecycleAndInspection",
    "Effect": "Allow",
    "Action": [
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription"
    ],
    "Resource": "arn:aws:iam::000000000000:role/EnsScout-prod-*"
  },
  {
    "Sid": "ShapeStackLambdaRolesOnlyUnderThePermissionsBoundary",
    "Effect": "Allow",
    "Action": [
      "iam:CreateRole",
      "iam:DeleteRolePolicy",
      "iam:PutRolePermissionsBoundary",
      "iam:PutRolePolicy"
    ],
    "Resource": "arn:aws:iam::000000000000:role/EnsScout-prod-*",
    "Condition": {
      "StringEquals": {
        "iam:PermissionsBoundary": "arn:aws:iam::000000000000:policy/EnsScout-prod-PermissionsBoundary"
      }
    }
  }
]
```

## Rolling it out to the live account

The owner applies this out of band, with an identity that may manage IAM.
The order matters.
The live execution role cannot attach a boundary yet, and the final policy would also
stop it from changing a role that does not carry one, so applying the final policy first
would wedge the next deployment.
Merging the change to `main` deploys it automatically, so everything before step 3 has to
be done before the merge.

Placeholders below: `<ACCOUNT_ID>`, `<EXECUTION_ROLE_NAME>`, `<EXECUTION_POLICY_NAME>`
(the name of the execution role's existing inline policy), and the values
`render-iam.js` takes.
Run the AWS commands against the account with credentials you have checked with
`aws sts get-caller-identity`.

0. Prepare.
   Render the documents with the real values into the gitignored `iam/rendered/`, and
   keep what is applied today in the same folder so any step can be undone:

   ```sh
   cd infra
   node scripts/render-iam.js --account-id <ACCOUNT_ID> \
     --repository-identity <owner@owner-id/repository@repository-id> \
     --execution-role-name <EXECUTION_ROLE_NAME> \
     --route53-hosted-zone-id <ZONE_ID>
   aws iam list-role-policies --role-name <EXECUTION_ROLE_NAME>
   aws iam get-role-policy --role-name <EXECUTION_ROLE_NAME> \
     --policy-name <EXECUTION_POLICY_NAME> --query PolicyDocument --output json \
     > iam/rendered/before-execution-policy.json
   ```

   Then create the five secrets and the one variable the new workflow reads (see
   `docs/deployment.md`). Keep the old variables until step 5 passes: the old workflow
   still reads them, and a recovery dispatch before then needs them.

1. Create the boundary policy. It changes nothing by itself: no role carries it yet.

   ```sh
   aws iam create-policy --policy-name EnsScout-prod-PermissionsBoundary \
     --description "Ceiling on every IAM role the EnsScout-prod stack creates" \
     --policy-document file://iam/rendered/permissions-boundary-policy.json
   aws iam get-policy --policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/EnsScout-prod-PermissionsBoundary
   ```

2. Apply the transition policy to the execution role.
   Use the existing policy name, so it replaces the policy rather than adding a second
   one beside it:

   ```sh
   aws iam put-role-policy --role-name <EXECUTION_ROLE_NAME> \
     --policy-name <EXECUTION_POLICY_NAME> \
     --policy-document file://iam/rendered/cloudformation-execution-role-policy-transition.json
   ```

   Then preview the change before the merge. From a build of the change that used
   `ens-scout:deferDeploymentIdentifiers=true` (`npm run check -- --context
   "ens-scout:deferDeploymentIdentifiers=true"` leaves it in `infra/cdk.out`), with the
   real parameters and credentials for the deployment role:

   ```sh
   npx cdk deploy EnsScout-prod --app cdk.out --no-execute \
     --role-arn <EXECUTION_ROLE_ARN> \
     --parameters EnsScout-prod:SiteHostedZoneId=<ZONE_ID> \
     --parameters EnsScout-prod:SiteCertificateArn=<CERTIFICATE_ARN>
   aws cloudformation describe-change-set --stack-name EnsScout-prod \
     --change-set-name <CHANGE_SET_NAME> --query "Changes[].ResourceChange.[LogicalResourceId,Action,Replacement]" --output table
   ```

   Every changed resource must be a modify, and `Replacement` must be `False` for the
   two Route 53 alias records and the API integration permission (the Lambda permission
   for API Gateway). The three roles change in place, to add the boundary. If any of
   them shows a replacement, stop and fix the template. Delete the change set afterwards
   with `aws cloudformation delete-change-set`.

3. Deploy the stack, so every role gets the boundary.
   Merge this change to `main`; the successful `checks` run starts `deploy production`.
   When it has finished, check each role:

   ```sh
   aws iam list-roles --query "Roles[?starts_with(RoleName, 'EnsScout-prod-')].RoleName" --output text
   aws iam get-role --role-name <ROLE_NAME> --query Role.PermissionsBoundary
   ```

   All three roles (the scanner, the API, and the website deployment role) must report
   the boundary policy's ARN.
   After step 3 the way forward is to fix forward: the old workflow no longer exists on
   `main`, so a failed later step is repaired by changing `main`, not by reverting.
   If the step 3 deploy fails and the stack is stuck in `UPDATE_ROLLBACK_FAILED`
   (the transition policy allows the rollback to remove a boundary, so this is unlikely),
   recover with:

   ```sh
   aws cloudformation continue-update-rollback --stack-name EnsScout-prod \
     --role-arn <EXECUTION_ROLE_ARN> --resources-to-skip <ROLE_LOGICAL_ID> [<ROLE_LOGICAL_ID> ...]
   ```

   The role logical IDs are `ScannerRole81F9E458`, `PublicSiteApiRole6575B2D4`, and
   `PublicSiteWebsiteDeploymentRole67F56037`; list the failed ones with
   `aws cloudformation describe-stack-events --stack-name EnsScout-prod`.

4. Apply the final execution-role policy, again under the same policy name:

   ```sh
   aws iam put-role-policy --role-name <EXECUTION_ROLE_NAME> \
     --policy-name <EXECUTION_POLICY_NAME> \
     --policy-document file://iam/rendered/cloudformation-execution-role-policy.json
   ```

   Check it without deploying anything. A role created with no boundary must be denied,
   and one with the boundary must not be:

   ```sh
   aws iam simulate-principal-policy \
     --policy-source-arn arn:aws:iam::<ACCOUNT_ID>:role/<EXECUTION_ROLE_NAME> \
     --action-names iam:CreateRole \
     --resource-arns arn:aws:iam::<ACCOUNT_ID>:role/EnsScout-prod-Probe \
     --query "EvaluationResults[].EvalDecision"
   aws iam simulate-principal-policy \
     --policy-source-arn arn:aws:iam::<ACCOUNT_ID>:role/<EXECUTION_ROLE_NAME> \
     --action-names iam:CreateRole iam:PutRolePolicy \
     --resource-arns arn:aws:iam::<ACCOUNT_ID>:role/EnsScout-prod-Probe \
     --context-entries ContextKeyName=iam:PermissionsBoundary,ContextKeyType=string,ContextKeyValues=arn:aws:iam::<ACCOUNT_ID>:policy/EnsScout-prod-PermissionsBoundary \
     --query "EvaluationResults[].EvalDecision"
   ```

   The first must print `implicitDeny` and the second `allowed` twice.

5. Prove it with a no-op deploy.
   Run the `deploy production` workflow by `workflow_dispatch` on `main`.
   It must finish with no changes to the stack and no `AccessDenied`; a change set with
   no changes is the expected result. This is the proof that the final policy still
   covers everything a deployment does.
   Only now delete the five old environment variables other than `AWS_REGION`, which
   stays.

To undo step 4 or 2, apply `iam/rendered/before-execution-policy.json` the same way
(`--policy-document file://iam/rendered/before-execution-policy.json`).
Undoing step 1 is not needed and is unsafe once roles carry the boundary: a role whose
boundary policy is deleted loses its permissions.
Change the boundary only with `aws iam create-policy-version --set-as-default`, from a
rendered document, and keep the stack's grants inside it.
