# The deployment role documents

The four documents applied to the two deployment roles, as templates.
They are configuration in an AWS account rather than resources in the stack, for the
reason [../README.md](../README.md) records, so nothing synthesizes them and nothing
detects drift: this directory plus `../test/deployment.test.ts` is what keeps them
honest.

The `*.template.json` files are committed source. They are templates rather than the
applied documents because the applied documents name the account and the execution
role, and neither belongs in a public repository. Every such position is an explicit
`${PLACEHOLDER}`:

| Placeholder | What it is | Where the real value lives |
| --- | --- | --- |
| `${ACCOUNT_ID}` | The twelve-digit target account | Protected `production` environment variable `AWS_ACCOUNT_ID` |
| `${CLOUDFORMATION_EXECUTION_ROLE_NAME}` | The role CloudFormation acts as | The role-name part of protected `production` environment variable `AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN`; the full ARN is not rendered |

Everything else stays a literal, because it is committed elsewhere in this repository
already and the test ties the documents to that copy: the region and the secret name
to `../cdk.json`, the bootstrap qualifier to `../lib/deployment.ts`, and the stack
name to the environment name in context.
A placeholder for one of those would make the tie tautological.

## Rendering

```powershell
node scripts/render-iam.js --example
node scripts/render-iam.js --account-id <twelve digits> --execution-role-name <name>
```

Both write to `iam/rendered/`, which is ignored by git; rendered documents are never
committed in place of the `*.template.json` source.
The rendering is deterministic - the same inputs produce the same bytes - and it
refuses a placeholder it does not know, a placeholder no value was supplied for, a
supplied value no template uses, and a value that is not shaped like the thing it
names.
No diagnostic it prints contains a supplied value, because the run that renders the
real documents is the run whose output must stay free of the account number.

`--example` renders with `example-values.json`, whose account is the same placeholder
`../cdk.json` commits, so the example documents and the committed CDK context agree
and a reviewer can read a whole rendered policy without knowing the real account.

Rendered documents are applied out of band with `aws iam put-role-policy` and
`aws iam update-assume-role-policy`. Nothing in this repository applies them, and no
workflow here has the permission to.
