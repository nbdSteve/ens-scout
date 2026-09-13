import * as fs from 'fs';
import * as path from 'path';

import * as cdk from 'aws-cdk-lib';

import { placeholderAccount, resolveConfig } from '../lib/config';
import { assetBucketName, bootstrapQualifier, deploymentSynthesizer } from '../lib/deployment';
import { EnsScoutStack } from '../lib/ens-scout-stack';
import { asList, fixtureCode, repoRoot } from './helpers';

/**
 * The deployment path is the one part of this repository that is configured in AWS
 * and in GitHub rather than synthesized, so nothing about it can be asserted from a
 * template. These tests assert the three things that can drift silently and would fail
 * only at a deployment: the committed role documents against what `lib/deployment.ts`
 * and the committed context actually produce, the workflow against the one execution
 * role the deployment role is permitted to pass, and every value the workflow needs
 * from the account against the variable it really reads it from.
 *
 * `docs/deployment.md` records what is deployed and why each grant is there.
 */

// The render script is plain CommonJS, so it is required rather than imported, the same
// way scripts/bundle-scanner.js is. `iam/README.md` describes the arrangement: the
// applied documents name the account and the execution role, so what is committed is a
// template and this is the one path to a document.
const render = require('../scripts/render-iam');

interface Statement {
  readonly Sid?: string;
  readonly Effect: string;
  readonly Action: string | string[];
  readonly Resource?: string | string[];
  readonly Principal?: Record<string, string>;
  readonly Condition?: Record<string, Record<string, string>>;
}

const committedContext: Record<string, unknown> = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'),
).context;

const config = resolveConfig(new cdk.App({ context: committedContext }));
const stackName = `EnsScout-${config.environmentName}`;
const assetBucket = assetBucketName(config.account, config.region);

/**
 * The substitution every assertion below renders with.
 *
 * Its `ACCOUNT_ID` is the account the committed context carries, which is what keeps
 * these assertions the tie they were: a rendered document is compared against
 * `config`, so a template that stopped naming the account through its placeholder
 * would render a document that no longer matches. A test below asserts the two agree,
 * because if they ever did not, every such comparison would fail for a reason that
 * looks like a policy change.
 */
const exampleValues: Record<string, string> = render.exampleValues();
const executionRoleArn = `arn:aws:iam::${config.account}:role/${exampleValues.CLOUDFORMATION_EXECUTION_ROLE_NAME}`;

/**
 * The subject the deployment role trusts. It is a literal here on purpose: the point
 * of the assertion is that this exact string, and no pattern that could match another
 * branch, environment, or repository, is what the role admits.
 */
const trustedSubject = 'repo:nbdSteve/ens-scout:environment:production';

function iamDocument(name: string): { Version: string; Statement: Statement[] } {
  return JSON.parse(render.renderIamDocument(render.readTemplate(name), exampleValues));
}

function statements(name: string): Statement[] {
  return iamDocument(name).Statement;
}

function actions(document: Statement[]): string[] {
  return document.flatMap((statement) => asList(statement.Action) as string[]);
}

function statementNamed(document: Statement[], sid: string): Statement {
  const found = document.find((statement) => statement.Sid === sid);
  if (!found) {
    throw new Error(`no statement with Sid ${sid}; the assertion below is stale`);
  }
  return found;
}

/**
 * workflow is a workflow file with its full-line comments removed.
 *
 * These assertions match text, which is what this repository avoids elsewhere, and
 * the reason is that there is no YAML parser in the dependency set and adding one is
 * a decision rather than a convenience. Dropping the comments is what keeps the match
 * honest: a comment that names `aws-access-key-id` to say it is absent must not make
 * the assertion that it is absent fail, or pass.
 */
function workflow(name: string): string {
  const source = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', name), 'utf8');
  return source
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

/**
 * goVersions is the version every setup-go step in one workflow installs.
 *
 * The value is parsed out rather than matched as text, so `stable`, `oldstable`, and a
 * major-only `1.26` are each readable as the thing they are: a channel that resolves to
 * whatever was released most recently, rather than a version. A workflow that installs
 * no toolchain at all would make the assertions vacuous, so finding none is a failure.
 */
function goVersions(name: string): string[] {
  const found = workflow(name)
    .split('\n')
    .map((line) => /^\s*go-version:\s*'?([^'\s]+)'?\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1]);
  if (found.length === 0) {
    throw new Error(`${name} installs no Go toolchain; the assertion below is stale`);
  }
  return found;
}

describe('the GitHub deployment role trust policy', () => {
  const trust = statements('github-deploy-role-trust');

  test('federates only through this account own GitHub Actions provider', () => {
    expect(trust).toHaveLength(1);
    expect(trust[0].Principal).toEqual({
      Federated: `arn:aws:iam::${config.account}:oidc-provider/token.actions.githubusercontent.com`,
    });
    expect(asList(trust[0].Action)).toEqual(['sts:AssumeRoleWithWebIdentity']);
  });

  test('admits one repository, one environment, and one audience', () => {
    // This is the whole restriction. A missing `sub` admits every repository in
    // GitHub, and a missing `aud` admits a token minted for another audience.
    expect(trust[0].Condition).toEqual({
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': trustedSubject,
      },
    });
  });

  test('matches the subject exactly, never by pattern', () => {
    // StringLike with a `*` anywhere in the subject is the widening to catch:
    // `repo:nbdSteve/ens-scout:*` admits every branch and every pull request of this
    // repository, which is exactly the environment protection being bypassed.
    expect(Object.keys(trust[0].Condition ?? {})).toEqual(['StringEquals']);
    expect(JSON.stringify(trust[0].Condition)).not.toContain('*');
  });
});

describe('the GitHub deployment role policy', () => {
  const policy = statements('github-deploy-role-policy');

  test('deploys this stack and no other', () => {
    const statement = statementNamed(policy, 'DeployTheEnsScoutStackAndNoOther');
    expect(statement.Resource).toBe(
      `arn:aws:cloudformation:${config.region}:${config.account}:stack/${stackName}/*`,
    );
    expect(actions([statement]).every((action) => action.startsWith('cloudformation:'))).toBe(true);
  });

  test('publishes assets to the bucket the synthesizer names', () => {
    // The tie between lib/deployment.ts and this document. The qualifier decides the
    // bucket name, so changing it there without changing this grant would leave every
    // deployment failing to publish the Lambda bundle.
    const statement = statementNamed(policy, 'PublishCdkAssetsToTheBootstrapBucket');
    expect(asList(statement.Resource)).toEqual([
      `arn:aws:s3:::${assetBucket}`,
      `arn:aws:s3:::${assetBucket}/*`,
    ]);
    expect(statement.Condition).toEqual({ StringEquals: { 'aws:ResourceAccount': config.account } });
  });

  test('cannot delete a published asset', () => {
    // Assets are content-addressed and immutable, so nothing on the deployment path
    // needs to remove one, and a deployment identity that could would be able to
    // break the running function by deleting the object its code points at.
    expect(actions(policy).filter((action) => /^s3:Delete/.test(action))).toEqual([]);
  });

  test('reads the bootstrap version parameter the qualifier names', () => {
    const statement = statementNamed(policy, 'ReadTheBootstrapVersion');
    expect(statement.Resource).toBe(
      `arn:aws:ssm:${config.region}:${config.account}:parameter/cdk-bootstrap/${bootstrapQualifier}/version`,
    );
  });

  test('passes one role, and only to CloudFormation', () => {
    // Without the service condition this is a general privilege-escalation grant: the
    // role could be handed to any service that assumes it.
    const statement = statementNamed(
      policy,
      'PassOnlyTheEnsScoutExecutionRoleAndOnlyToCloudFormation',
    );
    expect(statement.Resource).toBe(executionRoleArn);
    expect(statement.Condition).toEqual({
      StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' },
    });
  });

  test('holds no IAM permission but that one PassRole', () => {
    expect(actions(policy).filter((action) => action.startsWith('iam:'))).toEqual(['iam:PassRole']);
  });

  test('grants nothing on every resource but calls that take no resource', () => {
    // A `Resource: "*"` statement is where a narrow policy quietly stops being one,
    // so the actions allowed on one are pinned rather than merely inspected.
    const unscoped = policy.filter((statement) => asList(statement.Resource).includes('*'));
    expect(unscoped.map((statement) => statement.Sid)).toEqual([
      'CloudFormationCallsThatTakeNoResource',
    ]);
    expect(actions(unscoped).sort()).toEqual([
      'cloudformation:GetTemplateSummary',
      'cloudformation:ListStacks',
      'sts:GetCallerIdentity',
    ]);
  });

  test('grants no wildcard action and nothing outside the deployment services', () => {
    expect(actions(policy).length).toBeGreaterThan(0);
    for (const action of actions(policy)) {
      expect(action).not.toBe('*');
      expect(action).toMatch(/^(cloudformation|s3|ssm|sts|iam):[A-Za-z*]+$/);
    }
  });
});

describe('the CloudFormation execution role', () => {
  const trust = statements('cloudformation-execution-role-trust');
  const policy = statements('cloudformation-execution-role-policy');

  test('is assumable by CloudFormation and by nothing else', () => {
    expect(trust).toHaveLength(1);
    expect(trust[0].Principal).toEqual({ Service: 'cloudformation.amazonaws.com' });
    expect(asList(trust[0].Action)).toEqual(['sts:AssumeRole']);
  });

  test('can attach no managed policy to the role it creates', () => {
    // The stack gives the scanner an inline policy only, so nothing is lost, and the
    // exclusion is what stops this role from attaching AdministratorAccess to a role
    // it may also pass to Lambda.
    for (const excluded of [
      'iam:AttachRolePolicy',
      'iam:DetachRolePolicy',
      'iam:PutRolePermissionsBoundary',
      'iam:CreatePolicy',
      'iam:CreatePolicyVersion',
      'iam:CreateUser',
      'iam:CreateAccessKey',
    ]) {
      expect(actions(policy)).not.toContain(excluded);
    }
  });

  test('passes the scanner role to Lambda alone', () => {
    const statement = statementNamed(policy, 'PassTheScannerRoleToLambdaOnly');
    expect(statement.Condition).toEqual({
      StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' },
    });
    expect(actions(policy).filter((action) => action === 'iam:PassRole')).toHaveLength(1);
  });

  test('names this stack own resources everywhere but the listed exceptions', () => {
    // CloudFormation names an auto-named resource `<stackName>-<logicalId>-<random>`,
    // so the stack name is a real prefix and every resource this role touches carries
    // it. The exceptions are the grants that cannot be written that way, and pinning
    // the set is what makes a sixth one a failing test rather than a quiet widening.
    const exceptions = new Map<string, string>([
      ['DescribeLogGroupsTakesTheWholeRegion', `arn:aws:logs:${config.region}:${config.account}:log-group:*`],
      ['DescribeAlarmsTakesNoResource', '*'],
      [
        'ResolveTheGraphCredentialDynamicReference',
        `arn:aws:secretsmanager:${config.region}:${config.account}:secret:${config.graphApiKeySecretName}-*`,
      ],
      ['ReadTheScannerBundleAsset', `arn:aws:s3:::${assetBucket}/*`],
      [
        'ReadTheBootstrapVersion',
        `arn:aws:ssm:${config.region}:${config.account}:parameter/cdk-bootstrap/${bootstrapQualifier}/version`,
      ],
    ]);
    for (const statement of policy) {
      const exception = exceptions.get(statement.Sid ?? '');
      for (const resource of asList(statement.Resource) as string[]) {
        if (exception !== undefined) {
          expect(resource).toBe(exception);
        } else {
          expect(resource).toContain(`${stackName}-`);
        }
      }
    }
    const named = policy.filter((statement) => exceptions.has(statement.Sid ?? ''));
    expect(named.map((statement) => statement.Sid).sort()).toEqual([...exceptions.keys()].sort());
  });

  test('reads only the secret the committed context names', () => {
    // The credential reaches the function as a CloudFormation dynamic reference this
    // role resolves, so this is the one grant that is a real secret read, and it must
    // follow cdk.json rather than a literal copied beside it.
    const secretReads = policy.filter((statement) =>
      actions([statement]).some((action) => action.startsWith('secretsmanager:')),
    );
    expect(secretReads).toHaveLength(1);
    expect(actions(secretReads)).toEqual(['secretsmanager:GetSecretValue']);
    expect(secretReads[0].Resource).toContain(config.graphApiKeySecretName);
  });

  test('grants no wildcard action', () => {
    expect(actions(policy).length).toBeGreaterThan(0);
    for (const action of actions(policy)) {
      expect(action).not.toBe('*');
      expect(action).not.toMatch(/^[a-z0-9]+:\*$/);
    }
  });
});

describe('synthesis under the deployment synthesizer', () => {
  const app = new cdk.App({ context: committedContext });
  new EnsScoutStack(app, stackName, {
    config,
    scannerCode: fixtureCode(),
    env: { account: config.account, region: config.region },
    synthesizer: deploymentSynthesizer(),
  });
  const assembly = app.synth();
  const artifact = assembly.getStackByName(stackName);

  test('depends on none of the CDK bootstrap roles', () => {
    // This is what the narrow deployment policy rests on. Any of these three present
    // means the deployment assumes a bootstrap role again, and the bootstrap
    // cfn-exec-role carries AdministratorAccess.
    expect(artifact.assumeRoleArn).toBeUndefined();
    expect(artifact.cloudFormationExecutionRoleArn).toBeUndefined();
    expect(artifact.lookupRole).toBeUndefined();
  });

  test('publishes every asset to the bucket the deployment role grants', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(assembly.directory, `${stackName}.assets.json`), 'utf8'),
    ) as {
      files: Record<
        string,
        { destinations: Record<string, { bucketName: string; assumeRoleArn?: string }> }
      >;
    };
    const destinations = Object.values(manifest.files).flatMap((file) =>
      Object.values(file.destinations),
    );
    expect(destinations.length).toBeGreaterThan(0);
    for (const destination of destinations) {
      expect(destination.bucketName).toBe(assetBucket);
      expect(destination.assumeRoleArn).toBeUndefined();
    }
    expect(artifact.stackTemplateAssetObjectUrl).toContain(`s3://${assetBucket}/`);
  });
});

describe('the production deployment workflow', () => {
  const deploy = workflow('deploy-production.yml');

  test('runs only when someone starts it', () => {
    // Not on a push, not on a pull request, and not on a schedule. There is one
    // environment and no promotion path, so a deployment is a decision.
    expect(deploy).toContain('workflow_dispatch:');
    expect(deploy).not.toContain('pull_request');
    expect(deploy).not.toMatch(/^\s*schedule:/m);
    expect(deploy).not.toMatch(/^\s*push:/m);
  });

  test('deploys through the protected environment and asks for a token there alone', () => {
    expect(deploy).toContain('environment: production');
    expect(deploy).toContain('id-token: write');
    expect(deploy.match(/id-token: write/g)).toHaveLength(1);
  });

  test('deploys the assembly it verified rather than synthesizing a second one', () => {
    expect(deploy).toContain('npm run check');
    expect(deploy).toContain('--app cdk.out');
    expect(deploy).toContain(`cdk deploy ${stackName}`);
  });

  test('holds no long-lived AWS credential', () => {
    // The whole point of federating: there is no access key in this repository to
    // leak, rotate, or forget.
    expect(deploy).not.toContain('aws-access-key-id');
    expect(deploy).not.toContain('aws-secret-access-key');
    expect(deploy).not.toMatch(/secrets\.AWS/);
  });
});

describe('the deployment configuration the workflow requires', () => {
  const deploy = workflow('deploy-production.yml');

  /** The four names, in the order the workflow's own validation loop lists them. */
  const required = ((): string[] => {
    const listed = /for name in ([A-Z0-9_ ]+); do/.exec(deploy);
    if (!listed) {
      throw new Error('deploy-production.yml validates no variable; the assertions below are stale');
    }
    return listed[1].trim().split(/\s+/);
  })();

  /** usesVariable is a YAML key bound to a repository variable on one line. */
  function usesVariable(key: string, variable: string): boolean {
    return new RegExp(`${key}:\\s*\\$\\{\\{\\s*vars\\.${variable}\\s*\\}\\}`).test(deploy);
  }

  /** stepIndex is where a named step begins, so two can be ordered. */
  function stepIndex(name: string): number {
    const found = deploy.indexOf(`- name: ${name}\n`);
    if (found < 0) {
      throw new Error(`deploy-production.yml has no step named ${name}; this assertion is stale`);
    }
    return found;
  }

  test('embeds no account number of its own', () => {
    // The one twelve-digit run this file may hold is the placeholder its own guard
    // compares against, and that guard is only a guard if it is the same placeholder
    // lib/config.ts commits. Everything else about the account arrives as a variable.
    const digitRuns = new Set([...deploy.matchAll(/[0-9]{12,}/g)].map((match) => match[0]));
    expect([...digitRuns]).toEqual([placeholderAccount]);
  });

  test('embeds no role ARN and no role name of its own', () => {
    // A whole ARN, or a CamelCase role name, is the shape the leak took: both roles are
    // now supplied whole, so the file names IAM only in the pattern its guard matches.
    expect(deploy).not.toMatch(/arn:aws:iam::[0-9]+:role\//);
    expect(deploy).not.toMatch(/[A-Za-z][A-Za-z0-9]*Role[A-Za-z0-9]*/);
  });

  test('requires every variable it reads, and reads every variable it requires', () => {
    // A fifth variable added without a check would be one the job discovers is missing
    // at whichever step first needs it, which on the deploy step is mid-deployment.
    const referenced = new Set(
      [...deploy.matchAll(/vars\.([A-Z0-9_]+)/g)].map((match) => match[1]),
    );
    expect([...referenced].sort()).toEqual([...required].sort());
    expect([...required].sort()).toEqual([
      'AWS_ACCOUNT_ID',
      'AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN',
      'AWS_DEPLOY_ROLE_ARN',
      'AWS_REGION',
    ]);
  });

  test('checks the configuration before it builds or deploys anything', () => {
    // Ordering is the point of the step. A value checked after the synth costs a
    // toolchain and a build; one checked after the deploy step has started costs a
    // half-applied stack.
    const validation = stepIndex('require the deployment configuration');
    expect(validation).toBeLessThan(stepIndex('build and verify the artifact'));
    expect(validation).toBeLessThan(stepIndex('deploy'));
  });

  test('refuses the placeholder account rather than deploying at nothing', () => {
    expect(deploy).toContain(`PLACEHOLDER_ACCOUNT: '${placeholderAccount}'`);
    expect(deploy).toMatch(/AWS_ACCOUNT_ID" = "\$PLACEHOLDER_ACCOUNT"/);
  });

  test('assumes the deployment role the deploy-role variable names, in that region', () => {
    expect(usesVariable('role-to-assume', 'AWS_DEPLOY_ROLE_ARN')).toBe(true);
    expect(usesVariable('aws-region', 'AWS_REGION')).toBe(true);
    expect(usesVariable('allowed-account-ids', 'AWS_ACCOUNT_ID')).toBe(true);
  });

  test('synthesizes the deployed artifact against the account variable', () => {
    // `--app cdk.out` deploys the assembly, and the stack environment is baked into
    // it, so the real account has to reach the synth that produced it. This is the
    // whole reason cdk.json can carry a placeholder at all.
    expect(usesVariable('AWS_ACCOUNT_ID', 'AWS_ACCOUNT_ID')).toBe(true);
    expect(deploy).toContain('npm run check -- --context "ens-scout:account=$AWS_ACCOUNT_ID"');
  });

  test('passes the execution role the execution-role variable names', () => {
    // A different ARN here is refused by the deployment role's PassRole condition, so
    // the failure is safe but opaque; this is the assertion that names where it comes
    // from.
    expect(
      usesVariable('AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN', 'AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN'),
    ).toBe(true);
    expect(deploy).toContain('--role-arn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN"');
  });

  test('appends the account context to a script that ends with the synth', () => {
    // `npm run check -- <args>` appends to the end of the chained script string, so the
    // arguments reach whatever the chain ends with and nothing else. A check script
    // reordered to end with the tests would send `--context` to jest, which would
    // deploy an artifact synthesized against the placeholder.
    const scripts: Record<string, string> = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    ).scripts;
    const last = scripts.check.split('&&').pop()!.trim();
    expect(last.startsWith('npm run synth')).toBe(true);
    expect(scripts.synth).toBe('cdk synth');
  });
});

describe('the committed IAM templates', () => {
  const names: string[] = render.templateNames();

  test('are the four documents applied to the two deployment roles', () => {
    expect(names.sort()).toEqual([
      'cloudformation-execution-role-policy',
      'cloudformation-execution-role-trust',
      'github-deploy-role-policy',
      'github-deploy-role-trust',
    ]);
  });

  test('render against the account the committed context names', () => {
    // Every assertion above compares a rendered document with `config`, so this is the
    // equality those comparisons rest on. Were it to break, they would all fail at
    // once and look like a policy change instead of a mismatched example.
    expect(exampleValues.ACCOUNT_ID).toBe(config.account);
    expect(config.account).toBe(placeholderAccount);
  });

  test('carry no account number', () => {
    for (const name of names) {
      expect(render.readTemplate(name)).not.toMatch(/[0-9]{12,}/);
    }
  });

  test('name the deployment roles through a placeholder, and no other role by literal', () => {
    // A role a template may name outright is one this stack creates, which
    // CloudFormation prefixes with the stack name, so it is scoped and reviewable. The
    // two deployment roles are not among them: they exist before the stack does, and
    // their names are what this change took out of the repository.
    for (const name of names) {
      const roles = [...render.readTemplate(name).matchAll(/:role\/([^"]*)/g)].map(
        (match: RegExpMatchArray) => match[1],
      );
      for (const role of roles) {
        if (!role.startsWith('${')) {
          expect(role.startsWith(`${stackName}-`)).toBe(true);
        }
      }
    }
  });

  test('use only placeholders the render script knows how to fill', () => {
    // A placeholder nothing substitutes would be applied literally, and an
    // unsubstituted `${ACCOUNT_ID}` in a Resource is an ARN that matches nothing: every
    // call denied, at the deployment rather than here.
    const known = Object.keys(render.placeholderRules);
    for (const name of names) {
      for (const placeholder of render.placeholdersIn(render.readTemplate(name))) {
        expect(known).toContain(placeholder);
      }
    }
  });
});

describe('the pull request checks', () => {
  const checks = workflow('checks.yml');

  test('request no OIDC token, so they can reach no AWS account', () => {
    expect(checks).not.toContain('id-token');
    expect(checks).not.toContain('role-to-assume');
  });

  test('run every command AGENTS.md documents as the development workflow', () => {
    for (const command of [
      'gofmt -l cmd internal',
      'go vet ./...',
      'go test ./...',
      'go build ./...',
      'go build -o /dev/null ./cmd/scan-lambda',
      'npm run check',
      'npm run verify',
    ]) {
      expect(checks).toContain(command);
    }
  });

  test('cross-compile the Lambda for the architecture it runs on', () => {
    expect(checks).toContain('GOOS: linux');
    expect(checks).toContain('GOARCH: arm64');
  });
});

describe('the Go toolchain the workflows install', () => {
  // This pin is load-bearing rather than hygiene, and both halves of it have already
  // been observed. data/fixtures/*/latest.json commits the gzip stream's checksum and
  // byte length, and compress/flate emits different bytes for identical input between Go
  // releases, so a floating channel failed TestCommittedFixturesAreCurrent on a commit
  // that changed no Go code. The scanner bundle carries the same exposure with a worse
  // consequence, because its CDK asset hash is the content hash of a compiled binary: a
  // deploy job on a toolchain no check had run would report a Lambda update for source
  // nobody touched. Raising the pin is a deliberate change that regenerates the fixtures
  // with it.
  const versions = [...goVersions('checks.yml'), ...goVersions('deploy-production.yml')];

  test('is an exact version in every job, never a channel that floats', () => {
    for (const version of versions) {
      expect(version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
    }
  });

  test('is the same version in every job, including the one that deploys', () => {
    // The checks are only evidence about the artifact if the deploy compiles it with
    // the compiler the checks ran.
    expect([...new Set(versions)]).toHaveLength(1);
  });
});
