import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as cdk from 'aws-cdk-lib';

import { placeholderAccount, resolveConfig } from '../lib/config';
import { assetBucketName, bootstrapQualifier, deploymentSynthesizer } from '../lib/deployment';
import { EnsScoutStack } from '../lib/ens-scout-stack';
import {
  asList,
  fixtureApiCode,
  fixtureCode,
  fixtureWebsiteSources,
  repoRoot,
} from './helpers';

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
const yaml = require('js-yaml');

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

interface WorkflowStep {
  readonly name?: string;
  readonly id?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, unknown>;
  readonly run?: string;
  readonly shell?: string;
  readonly ['working-directory']?: string;
}

interface WorkflowJob {
  readonly name?: string;
  readonly needs?: string | string[];
  readonly if?: string;
  readonly environment?: string | { readonly name?: string };
  readonly permissions?: Record<string, string>;
  readonly outputs?: Record<string, string>;
  readonly steps: WorkflowStep[];
}

interface Workflow {
  readonly name: string;
  readonly on: Record<string, unknown>;
  readonly permissions?: Record<string, string>;
  readonly concurrency?: Record<string, unknown>;
  readonly jobs: Record<string, WorkflowJob>;
}

/**
 * Parse a workflow into the same mapping/list/scalar model GitHub consumes.
 *
 * js-yaml is already present in the exact locked Jest dependency graph. Parsing the
 * document keeps comments and formatting from deciding a test and lets the assertions
 * below exercise jobs, steps, triggers, permissions, inputs, and scripts as workflow
 * data rather than as incidental source text.
 */
function workflow(name: string): Workflow {
  const source = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', name), 'utf8');
  const parsed: unknown = yaml.safeLoad(source);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} did not parse to a workflow mapping`);
  }
  const candidate = parsed as Partial<Workflow>;
  if (
    typeof candidate.name !== 'string' ||
    candidate.on === null ||
    typeof candidate.on !== 'object' ||
    candidate.jobs === null ||
    typeof candidate.jobs !== 'object'
  ) {
    throw new Error(`${name} is missing its name, triggers, or jobs`);
  }
  return candidate as Workflow;
}

function workflowJob(document: Workflow, id: string): WorkflowJob {
  const found = document.jobs[id];
  if (!found || !Array.isArray(found.steps)) {
    throw new Error(`workflow has no job ${id} with steps; the assertion below is stale`);
  }
  return found;
}

function workflowStep(job: WorkflowJob, name: string): WorkflowStep {
  const found = job.steps.find((step) => step.name === name);
  if (!found) {
    throw new Error(`workflow job has no step named ${name}; the assertion below is stale`);
  }
  return found;
}

function workflowRun(step: WorkflowStep): string {
  if (typeof step.run !== 'string') {
    throw new Error(`workflow step ${step.name ?? step.id ?? '<unnamed>'} has no run script`);
  }
  return step.run;
}

function workflowRunOrEmpty(step: WorkflowStep): string {
  return typeof step.run === 'string' ? step.run : '';
}

function allWorkflowSteps(document: Workflow): WorkflowStep[] {
  return Object.values(document.jobs).flatMap((job) => job.steps ?? []);
}

function serializedWorkflow(document: Workflow): string {
  return JSON.stringify(document);
}

interface StepResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputs: Record<string, string>;
}

/**
 * Execute the exact shell body carried by a parsed workflow step.
 *
 * The scripts under test use only runner-provided environment and shell tools. A
 * temporary GITHUB_OUTPUT file captures the same step outputs GitHub would expose to
 * downstream jobs.
 */
function runWorkflowStep(step: WorkflowStep, env: Record<string, string>): StepResult {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ens-scout-workflow-'));
  const output = path.join(directory, 'output');
  fs.writeFileSync(output, '');
  try {
    const result = spawnSync('/bin/bash', ['-c', `set -euo pipefail\n${workflowRun(step)}`], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env,
        GITHUB_OUTPUT: output,
      },
      encoding: 'utf8',
    });
    const outputs = Object.fromEntries(
      fs
        .readFileSync(output, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf('=');
          if (separator < 1) {
            throw new Error(`workflow output is not a name=value pair: ${line}`);
          }
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    return {
      status: result.status ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
      outputs,
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
  const found = allWorkflowSteps(workflow(name))
    .filter((step) => step.uses?.startsWith('actions/setup-go@'))
    .map((step) => step.with?.['go-version'])
    .filter((version): version is string => typeof version === 'string');
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
    // The stack gives every Lambda role an inline policy only, so nothing is lost, and the
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

  test('passes the stack Lambda roles to Lambda alone', () => {
    const statement = statementNamed(policy, 'PassTheStackLambdaRolesToLambdaOnly');
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
    const exceptions = new Map<string, string[]>([
      [
        'DescribeLogGroupsTakesTheWholeRegion',
        [`arn:aws:logs:${config.region}:${config.account}:log-group:*`],
      ],
      ['DescribeAlarmsTakesNoResource', ['*']],
      [
        'ResolveTheGraphCredentialDynamicReference',
        [
          `arn:aws:secretsmanager:${config.region}:${config.account}:secret:${config.graphApiKeySecretName}-*`,
        ],
      ],
      [
        'PrivateWebsiteBucket',
        [`arn:aws:s3:::ensscout-prod-*`, `arn:aws:s3:::ensscout-prod-*/*`],
      ],
      [
        'HttpApi',
        [
          `arn:aws:apigateway:${config.region}::/apis`,
          `arn:aws:apigateway:${config.region}::/apis/*`,
          `arn:aws:apigateway:${config.region}::/tags/*`,
        ],
      ],
      ['CloudFrontPublicSite', ['*']],
      ['GenerateServingSecretValues', ['*']],
      ['ReadTheStackAssets', [`arn:aws:s3:::${assetBucket}/*`]],
      [
        'ReadTheBootstrapVersion',
        [
          `arn:aws:ssm:${config.region}:${config.account}:parameter/cdk-bootstrap/${bootstrapQualifier}/version`,
        ],
      ],
    ]);
    for (const statement of policy) {
      const exception = exceptions.get(statement.Sid ?? '');
      const resources = asList(statement.Resource) as string[];
      if (exception !== undefined) {
        expect(resources).toEqual(exception);
      } else {
        for (const resource of resources) {
          expect(resource).toContain(`${stackName}-`);
        }
      }
    }
    const named = policy.filter((statement) => exceptions.has(statement.Sid ?? ''));
    expect(named.map((statement) => statement.Sid).sort()).toEqual([...exceptions.keys()].sort());
  });

  test('reads the external Graph key and manages only the two stack-generated serving secrets', () => {
    const graph = statementNamed(policy, 'ResolveTheGraphCredentialDynamicReference');
    expect(actions([graph])).toEqual(['secretsmanager:GetSecretValue']);
    expect(graph.Resource).toContain(config.graphApiKeySecretName);

    const generated = statementNamed(policy, 'GeneratedServingSecrets');
    expect(actions([generated])).toEqual(
      expect.arrayContaining([
        'secretsmanager:CreateSecret',
        'secretsmanager:DeleteSecret',
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetSecretValue',
        'secretsmanager:PutSecretValue',
        'secretsmanager:UpdateSecret',
      ]),
    );
    expect(generated.Resource).toBe(
      `arn:aws:secretsmanager:${config.region}:${config.account}:secret:${stackName}-*`,
    );
    const random = statementNamed(policy, 'GenerateServingSecretValues');
    expect(actions([random])).toEqual(['secretsmanager:GetRandomPassword']);
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
  const website = fixtureWebsiteSources();
  new EnsScoutStack(app, stackName, {
    config,
    scannerCode: fixtureCode(),
    apiCode: fixtureApiCode(),
    websiteSource: website.site,
    websiteAssetsSource: website.assets,
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
  const document = workflow('deploy-production.yml');
  const select = workflowJob(document, 'select');
  const deploy = workflowJob(document, 'deploy');
  const resolver = workflowStep(select, 'resolve the immutable deploy SHA');
  const deploySha = '${{ needs.select.outputs.deploy_sha }}';
  const checkedSha = 'a'.repeat(40);
  const workflowSha = 'b'.repeat(40);

  function selection(overrides: Record<string, string> = {}): StepResult {
    return runWorkflowStep(resolver, {
      EVENT_NAME: 'workflow_run',
      REPOSITORY: 'nbdSteve/ens-scout',
      DISPATCH_REF: 'refs/heads/main',
      DISPATCH_SHA: workflowSha,
      UPSTREAM_EVENT: 'push',
      UPSTREAM_CONCLUSION: 'success',
      UPSTREAM_HEAD_BRANCH: 'main',
      UPSTREAM_HEAD_REPOSITORY: 'nbdSteve/ens-scout',
      UPSTREAM_HEAD_SHA: checkedSha,
      ...overrides,
    });
  }

  test('listens only for completed checks runs on main and optional recovery dispatches', () => {
    expect(document.on).toEqual({
      workflow_run: {
        workflows: ['checks'],
        types: ['completed'],
        branches: ['main'],
      },
      workflow_dispatch: null,
    });
    expect(document.on).not.toHaveProperty('pull_request');
    expect(document.on).not.toHaveProperty('push');
    expect(document.on).not.toHaveProperty('schedule');
  });

  test('serializes production deployments without cancelling one in progress', () => {
    expect(document.concurrency).toEqual({
      group: 'deploy-production',
      'cancel-in-progress': false,
    });
  });

  test('binds the resolver to the upstream event fields and gates the deploy job on its output', () => {
    expect(resolver.env).toEqual({
      EVENT_NAME: '${{ github.event_name }}',
      REPOSITORY: '${{ github.repository }}',
      DISPATCH_REF: '${{ github.ref }}',
      DISPATCH_SHA: '${{ github.sha }}',
      UPSTREAM_EVENT: '${{ github.event.workflow_run.event }}',
      UPSTREAM_CONCLUSION: '${{ github.event.workflow_run.conclusion }}',
      UPSTREAM_HEAD_BRANCH: '${{ github.event.workflow_run.head_branch }}',
      UPSTREAM_HEAD_REPOSITORY: '${{ github.event.workflow_run.head_repository.full_name }}',
      UPSTREAM_HEAD_SHA: '${{ github.event.workflow_run.head_sha }}',
    });
    expect(select.outputs).toEqual({
      deploy_sha: '${{ steps.resolve.outputs.deploy_sha }}',
    });
    expect(deploy.needs).toBe('select');
    expect(deploy.if).toBe("needs.select.outputs.deploy_sha != ''");
  });

  test('admits a successful main push from this repository and selects its checked SHA', () => {
    const result = selection();
    expect(result.status).toBe(0);
    expect(result.outputs).toEqual({ deploy_sha: checkedSha });
    expect(result.stdout).not.toContain(checkedSha);
    expect(result.stderr).not.toContain(checkedSha);
  });

  test.each([
    ['a failed checks run', { UPSTREAM_CONCLUSION: 'failure' }],
    ['a pull-request head', { UPSTREAM_EVENT: 'pull_request' }],
    ['a fork head', { UPSTREAM_HEAD_REPOSITORY: 'someone-else/ens-scout' }],
    ['a non-main branch', { UPSTREAM_HEAD_BRANCH: 'feature/not-main' }],
  ])('does not admit %s', (_name, overrides) => {
    const result = selection(overrides);
    expect(result.status).toBe(0);
    expect(result.outputs).toEqual({});
  });

  test('uses workflow_run.head_sha rather than the deploy workflow SHA', () => {
    const result = selection({
      UPSTREAM_HEAD_SHA: checkedSha,
      DISPATCH_SHA: workflowSha,
    });
    expect(result.outputs.deploy_sha).toBe(checkedSha);
    expect(result.outputs.deploy_sha).not.toBe(workflowSha);

    const checkout = workflowStep(deploy, 'checkout the selected commit');
    expect(checkout.uses).toBe('actions/checkout@v7');
    expect(checkout.with).toEqual({
      ref: deploySha,
      'persist-credentials': false,
    });
    expect(workflowStep(deploy, 'verify the selected commit').env).toEqual({
      DEPLOY_SHA: deploySha,
    });
    expect(workflowStep(deploy, 'record what is about to be deployed').env).toEqual({
      DEPLOY_SHA: deploySha,
    });
  });

  test('keeps dispatch as a main-only recovery path with its own immutable event SHA', () => {
    const accepted = selection({
      EVENT_NAME: 'workflow_dispatch',
      DISPATCH_REF: 'refs/heads/main',
      DISPATCH_SHA: workflowSha,
    });
    expect(accepted.status).toBe(0);
    expect(accepted.outputs).toEqual({ deploy_sha: workflowSha });

    const rejected = selection({
      EVENT_NAME: 'workflow_dispatch',
      DISPATCH_REF: 'refs/heads/recovery',
      DISPATCH_SHA: workflowSha,
    });
    expect(rejected.status).toBe(0);
    expect(rejected.outputs).toEqual({});
  });

  test('fails closed if an otherwise eligible event does not carry a full commit SHA', () => {
    const result = selection({ UPSTREAM_HEAD_SHA: 'not-a-commit' });
    expect(result.status).not.toBe(0);
    expect(result.outputs).toEqual({});
    expect(`${result.stdout}${result.stderr}`).not.toContain('not-a-commit');
  });

  test('deploys through the production environment and asks for an OIDC token there alone', () => {
    expect(deploy.environment).toBe('production');
    expect(
      Object.entries(document.jobs)
        .filter(([, job]) => job.permissions?.['id-token'] === 'write')
        .map(([id]) => id),
    ).toEqual(['deploy']);
    expect(deploy.permissions).toEqual({
      contents: 'read',
      'id-token': 'write',
    });
  });

  test('builds once and deploys the exact cdk.out assembly that passed', () => {
    const website = workflowStep(deploy, 'build the production website');
    const artifact = workflowStep(deploy, 'build and verify the artifact');
    const deployment = workflowStep(deploy, 'deploy');
    expect(deploy.steps.indexOf(website)).toBeLessThan(deploy.steps.indexOf(artifact));
    expect(deploy.steps.indexOf(artifact)).toBeLessThan(deploy.steps.indexOf(deployment));
    expect(website['working-directory']).toBe('web');
    expect(website.env).toEqual({ VITE_API_BASE_URL: '/' });
    expect(workflowRun(artifact)).toBe(
      'npm run check -- --context "ens-scout:account=$AWS_ACCOUNT_ID"',
    );
    expect(workflowRun(deployment)).toContain(`npx cdk deploy ${stackName}`);
    expect(workflowRun(deployment)).toContain('--app cdk.out');
    expect(
      allWorkflowSteps(document).filter((step) =>
        workflowRunOrEmpty(step).includes('npm run check'),
      ),
    ).toHaveLength(1);
    expect(
      allWorkflowSteps(document).filter((step) => workflowRunOrEmpty(step).includes('cdk deploy')),
    ).toHaveLength(1);
  });

  test('records only the immutable SHA, artifact checksum, and generated site URL', () => {
    const artifactSummary = workflowStep(deploy, 'record what is about to be deployed');
    const deployment = workflowStep(deploy, 'deploy');
    const siteSummary = workflowStep(deploy, 'publish the generated site URL');
    expect(workflowRun(artifactSummary)).toContain('commit  $DEPLOY_SHA');
    expect(workflowRun(artifactSummary)).toContain('sha256sum cdk.out/EnsScout-prod.template.json');
    expect(workflowRun(deployment)).toContain('--outputs-file cdk-outputs.json');
    expect(workflowRun(deployment)).toContain('>"$deploy_log" 2>&1');
    expect(workflowRun(siteSummary)).toContain("outputs['EnsScout-prod']?.PublicSiteUrl");
    expect(workflowRun(siteSummary)).toContain('GITHUB_STEP_SUMMARY');
    for (const summary of [workflowRun(artifactSummary), workflowRun(siteSummary)]) {
      expect(summary).not.toMatch(/AWS_(ACCOUNT|REGION|DEPLOY|CLOUDFORMATION)/);
      expect(summary).not.toContain('role/');
    }
  });

  test('holds no long-lived AWS credential', () => {
    // The whole point of federating: there is no access key in this repository to
    // leak, rotate, or forget.
    const serialized = serializedWorkflow(document);
    expect(serialized).not.toContain('aws-access-key-id');
    expect(serialized).not.toContain('aws-secret-access-key');
    expect(serialized).not.toMatch(/secrets\.AWS/);
  });
});

describe('the deployment configuration the workflow requires', () => {
  const document = workflow('deploy-production.yml');
  const deploy = workflowJob(document, 'deploy');
  const validation = workflowStep(deploy, 'require the deployment configuration');
  const credential = workflowStep(deploy, 'assume the deployment role');
  const artifact = workflowStep(deploy, 'build and verify the artifact');
  const deployment = workflowStep(deploy, 'deploy');
  const required = Object.keys(validation.env ?? {}).filter((name) => name.startsWith('AWS_'));
  const validAccount = '1'.repeat(12);
  const valid = {
    AWS_ACCOUNT_ID: validAccount,
    AWS_REGION: 'ap-southeast-2',
    AWS_DEPLOY_ROLE_ARN: `arn:aws:iam::${validAccount}:role/DeployFixture`,
    AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN: `arn:aws:iam::${validAccount}:role/ExecutionFixture`,
    PLACEHOLDER_ACCOUNT: placeholderAccount,
  };

  function validate(overrides: Record<string, string> = {}): StepResult {
    return runWorkflowStep(validation, { ...valid, ...overrides });
  }

  test('embeds no account number of its own', () => {
    // The one twelve-digit run this file may hold is the placeholder its own guard
    // compares against, and that guard is only a guard if it is the same placeholder
    // lib/config.ts commits. Everything else about the account arrives as a variable.
    const serialized = serializedWorkflow(document);
    const digitRuns = new Set([...serialized.matchAll(/[0-9]{12,}/g)].map((match) => match[0]));
    expect([...digitRuns]).toEqual([placeholderAccount]);
  });

  test('embeds no role ARN and no role name of its own', () => {
    // A whole ARN, or a CamelCase role name, is the shape the leak took: both roles are
    // now supplied whole, so the file names IAM only in the pattern its guard matches.
    const serialized = serializedWorkflow(document);
    expect(serialized).not.toMatch(/arn:aws:iam::[0-9]+:role\//);
    expect(serialized).not.toMatch(/[A-Za-z][A-Za-z0-9]*Role[A-Za-z0-9]*/);
  });

  test('requires every variable it reads, and reads every variable it requires', () => {
    // A fifth variable added without a check would be one the job discovers is missing
    // at whichever step first needs it, which on the deploy step is mid-deployment.
    const referenced = new Set(
      [...serializedWorkflow(document).matchAll(/vars\.([A-Z0-9_]+)/g)].map((match) => match[1]),
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
    expect(deploy.steps.indexOf(validation)).toBeLessThan(deploy.steps.indexOf(artifact));
    expect(deploy.steps.indexOf(validation)).toBeLessThan(deploy.steps.indexOf(deployment));
  });

  test('accepts four consistent production values and prints none of them', () => {
    const result = validate();
    expect(result.status).toBe(0);
    for (const value of Object.values(valid)) {
      expect(`${result.stdout}${result.stderr}`).not.toContain(value);
    }
  });

  test.each(required)('refuses a missing %s before any build', (name) => {
    const result = validate({ [name]: '' });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(name);
  });

  test('refuses the placeholder account rather than deploying at nothing', () => {
    expect(validation.env?.PLACEHOLDER_ACCOUNT).toBe(placeholderAccount);
    expect(validate({ AWS_ACCOUNT_ID: placeholderAccount }).status).not.toBe(0);
  });

  test('refuses malformed values, role/account disagreement, and one role used twice', () => {
    expect(validate({ AWS_ACCOUNT_ID: 'short' }).status).not.toBe(0);
    expect(validate({ AWS_REGION: 'not-a-region' }).status).not.toBe(0);
    expect(
      validate({
        AWS_DEPLOY_ROLE_ARN: `arn:aws:iam::${'2'.repeat(12)}:role/DeployFixture`,
      }).status,
    ).not.toBe(0);
    expect(
      validate({
        AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN: valid.AWS_DEPLOY_ROLE_ARN,
      }).status,
    ).not.toBe(0);
  });

  test('assumes the deployment role the deploy-role variable names, in that region', () => {
    expect(credential.with?.['role-to-assume']).toBe('${{ vars.AWS_DEPLOY_ROLE_ARN }}');
    expect(credential.with?.['aws-region']).toBe('${{ vars.AWS_REGION }}');
    expect(credential.with?.['allowed-account-ids']).toBe('${{ vars.AWS_ACCOUNT_ID }}');
  });

  test('synthesizes the deployed artifact against the account variable', () => {
    // `--app cdk.out` deploys the assembly, and the stack environment is baked into
    // it, so the real account has to reach the synth that produced it. This is the
    // whole reason cdk.json can carry a placeholder at all.
    expect(artifact.env?.AWS_ACCOUNT_ID).toBe('${{ vars.AWS_ACCOUNT_ID }}');
    expect(workflowRun(artifact)).toBe(
      'npm run check -- --context "ens-scout:account=$AWS_ACCOUNT_ID"',
    );
  });

  test('passes the execution role the execution-role variable names', () => {
    // A different ARN here is refused by the deployment role's PassRole condition, so
    // the failure is safe but opaque; this is the assertion that names where it comes
    // from.
    expect(deployment.env?.AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN).toBe(
      '${{ vars.AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN }}',
    );
    expect(workflowRun(deployment)).toContain(
      '--role-arn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN"',
    );
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
  const serialized = serializedWorkflow(checks);
  const commands = allWorkflowSteps(checks).map(workflowRunOrEmpty).join('\n');

  test('request no OIDC token, so they can reach no AWS account', () => {
    expect(serialized).not.toContain('id-token');
    expect(serialized).not.toContain('role-to-assume');
  });

  test('run every command AGENTS.md documents as the development workflow', () => {
    for (const command of [
      'gofmt -l cmd internal',
      'go vet ./...',
      'go test ./...',
      'go build ./...',
      'go build -o /dev/null ./cmd/scan-lambda',
      'go build -o /dev/null ./cmd/api-lambda',
      'npm run check',
      'npm run verify',
    ]) {
      expect(commands).toContain(command);
    }
  });

  test('cross-compile the Lambda for the architecture it runs on', () => {
    const crossCompile = workflowStep(
      workflowJob(checks, 'go'),
      'cross-compile the Lambdas for their runtime',
    );
    expect(crossCompile.env).toEqual({
      GOOS: 'linux',
      GOARCH: 'arm64',
    });
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
