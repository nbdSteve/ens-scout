import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as cdk from 'aws-cdk-lib';

import { placeholderAccount, resolveConfig } from '../lib/config';
import {
  assetBucketName,
  bootstrapQualifier,
  deploymentParameterNames,
  deploymentSynthesizer,
  permissionsBoundaryName,
} from '../lib/deployment';
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
const exampleRepositoryIdentity = 'nbdSteve@1/ens-scout@2';
const boundaryArn = `arn:aws:iam::${config.account}:policy/${permissionsBoundaryName(config.environmentName)}`;

/**
 * The subject the deployment role trusts. It is a literal here on purpose: the point
 * of the assertion is that this exact string, and no pattern that could match another
 * branch, environment, or repository, is what the role admits.
 */
const trustedSubject = `repo:${exampleRepositoryIdentity}:environment:production`;

function iamDocument(name: string): { Version: string; Statement: Statement[] } {
  return JSON.parse(render.renderIamDocument(render.readTemplate(name), exampleValues));
}

function statements(name: string): Statement[] {
  return iamDocument(name).Statement;
}

function actions(document: Statement[]): string[] {
  return document.flatMap((statement) => asList(statement.Action) as string[]);
}

function admitsWebIdentitySubject(statement: Statement, subject: string): boolean {
  const equals = statement.Condition?.StringEquals;
  return (
    equals?.['token.actions.githubusercontent.com:aud'] === 'sts.amazonaws.com' &&
    equals?.['token.actions.githubusercontent.com:sub'] === subject
  );
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
    // StringLike with a wildcard anywhere in the subject is the widening to catch:
    // it admits branches and pull requests that the production environment excludes.
    expect(Object.keys(trust[0].Condition ?? {})).toEqual(['StringEquals']);
    expect(JSON.stringify(trust[0].Condition)).not.toContain('*');
  });

  test('admits the immutable production subject and rejects every neighbouring context', () => {
    expect(admitsWebIdentitySubject(trust[0], trustedSubject)).toBe(true);
    for (const subject of [
      `repo:${exampleRepositoryIdentity}:pull_request`,
      `repo:${exampleRepositoryIdentity}:ref:refs/heads/feature/not-main`,
      `repo:${exampleRepositoryIdentity}:environment:staging`,
      'repo:someone-else@3/ens-scout@4:environment:production',
      'repo:nbdSteve/ens-scout:environment:production',
    ]) {
      expect(admitsWebIdentitySubject(trust[0], subject)).toBe(false);
    }
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

  test('shapes a role only under the permissions boundary', () => {
    // The calls that give a role its permissions, or change what limits them, are
    // allowed only when the request names the boundary policy. Without the condition a
    // template could create a role with an administrator policy and pass it to Lambda.
    const bounded = statementNamed(policy, 'ShapeStackLambdaRolesOnlyUnderThePermissionsBoundary');
    expect(asList(bounded.Action).sort()).toEqual([
      'iam:CreateRole',
      'iam:DeleteRolePolicy',
      'iam:PutRolePermissionsBoundary',
      'iam:PutRolePolicy',
    ]);
    expect(bounded.Effect).toBe('Allow');
    expect(bounded.Resource).toBe(`arn:aws:iam::${config.account}:role/${stackName}-*`);
    expect(bounded.Condition).toEqual({
      StringEquals: { 'iam:PermissionsBoundary': boundaryArn },
    });
  });

  test('grants each boundary-conditioned action nowhere else', () => {
    // A second, unconditioned grant of any of them would make the condition above
    // decoration.
    const conditioned = new Set([
      'iam:CreateRole',
      'iam:DeleteRolePolicy',
      'iam:PutRolePermissionsBoundary',
      'iam:PutRolePolicy',
    ]);
    for (const statement of policy) {
      const granted = (asList(statement.Action) as string[]).filter((action) =>
        conditioned.has(action),
      );
      if (statement.Sid === 'ShapeStackLambdaRolesOnlyUnderThePermissionsBoundary') {
        expect(granted).toHaveLength(conditioned.size);
      } else {
        expect(granted).toEqual([]);
      }
    }
  });

  test('attaches no managed policy, can never remove a boundary, and can create no policy, user, or access key', () => {
    for (const excluded of [
      'iam:AttachRolePolicy',
      'iam:DetachRolePolicy',
      'iam:DeleteRolePermissionsBoundary',
      'iam:CreatePolicy',
      'iam:CreatePolicyVersion',
      'iam:SetDefaultPolicyVersion',
      'iam:DeletePolicy',
      'iam:DeletePolicyVersion',
      'iam:CreateUser',
      'iam:CreateAccessKey',
      'iam:PutUserPolicy',
      'iam:PutUserPermissionsBoundary',
      'iam:AttachUserPolicy',
    ]) {
      expect(actions(policy)).not.toContain(excluded);
    }
    expect(actions(policy).filter((action) => action.startsWith('iam:'))).not.toContain('iam:*');
  });

  test('names the boundary policy the stack applies, in this account', () => {
    expect(boundaryArn).toBe(
      `arn:aws:iam::${config.account}:policy/${permissionsBoundaryName(config.environmentName)}`,
    );
    const source = render.readTemplate('cloudformation-execution-role-policy');
    expect(source).toContain(`policy/${permissionsBoundaryName(config.environmentName)}`);
  });

  test('passes the stack Lambda roles to Lambda alone', () => {
    const statement = statementNamed(policy, 'PassTheStackLambdaRolesToLambdaOnly');
    expect(statement.Condition).toEqual({
      StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' },
    });
    expect(actions(policy).filter((action) => action === 'iam:PassRole')).toHaveLength(1);
  });

  test('manages only the two CDK website-deployment layers', () => {
    const layers = statementNamed(policy, 'LambdaLayers');
    expect(actions([layers])).toEqual([
      'lambda:DeleteLayerVersion',
      'lambda:GetLayerVersion',
      'lambda:GetLayerVersionPolicy',
      'lambda:PublishLayerVersion',
    ]);
    expect(asList(layers.Resource)).toEqual([
      `arn:aws:lambda:${config.region}:${config.account}:layer:PublicSiteDeployWebsiteAwsCliLayer*`,
      `arn:aws:lambda:${config.region}:${config.account}:layer:PublicSiteDeployWebsiteAwsCliLayer*:*`,
      `arn:aws:lambda:${config.region}:${config.account}:layer:PublicSiteDeployWebsiteAssetsAwsCliLayer*`,
      `arn:aws:lambda:${config.region}:${config.account}:layer:PublicSiteDeployWebsiteAssetsAwsCliLayer*:*`,
    ]);
  });

  test('manages DNS records only in the configured hosted zone', () => {
    const records = statementNamed(policy, 'PublicSiteDnsRecords');
    expect(actions([records])).toEqual([
      'route53:ChangeResourceRecordSets',
      'route53:GetHostedZone',
      'route53:ListResourceRecordSets',
    ]);
    expect(records.Resource).toBe(
      `arn:aws:route53:::hostedzone/${config.siteHostedZoneId}`,
    );

    const changes = statementNamed(policy, 'ReadPublicSiteDnsChanges');
    expect(actions([changes])).toEqual(['route53:GetChange']);
    expect(changes.Resource).toBe('arn:aws:route53:::change/*');

    const zones = statementNamed(policy, 'ListHostedZonesForPublicSiteDnsRecords');
    expect(actions([zones])).toEqual(['route53:ListHostedZones']);
    expect(zones.Resource).toBe('*');

    expect(actions(policy).filter((action) => action.startsWith('acm:'))).toEqual([]);
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
        'LambdaLayers',
        [
          `arn:aws:lambda:${config.region}:${config.account}:layer:PublicSiteDeployWebsiteAwsCliLayer*`,
          `arn:aws:lambda:${config.region}:${config.account}:layer:PublicSiteDeployWebsiteAwsCliLayer*:*`,
          `arn:aws:lambda:${config.region}:${config.account}:layer:PublicSiteDeployWebsiteAssetsAwsCliLayer*`,
          `arn:aws:lambda:${config.region}:${config.account}:layer:PublicSiteDeployWebsiteAssetsAwsCliLayer*:*`,
        ],
      ],
      [
        'GeneratedServingSecrets',
        [
          `arn:aws:secretsmanager:${config.region}:${config.account}:secret:PublicSiteCheckClientSecret*`,
          `arn:aws:secretsmanager:${config.region}:${config.account}:secret:PublicSiteOriginSecret*`,
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
      [
        'PublicSiteDnsRecords',
        [`arn:aws:route53:::hostedzone/${config.siteHostedZoneId}`],
      ],
      ['ReadPublicSiteDnsChanges', ['arn:aws:route53:::change/*']],
      ['ListHostedZonesForPublicSiteDnsRecords', ['*']],
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
    expect(asList(generated.Resource)).toEqual([
      `arn:aws:secretsmanager:${config.region}:${config.account}:secret:PublicSiteCheckClientSecret*`,
      `arn:aws:secretsmanager:${config.region}:${config.account}:secret:PublicSiteOriginSecret*`,
    ]);
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
  const template = artifact.template as {
    Resources?: Record<string, { Type?: string }>;
  };

  function logicalIds(resourceType: string): string[] {
    return Object.entries(template.Resources ?? {})
      .filter(([, resource]) => resource.Type === resourceType)
      .map(([logicalId]) => logicalId)
      .sort();
  }

  function resourceNamePrefixes(sid: string, marker: string): string[] {
    const statement = statementNamed(statements('cloudformation-execution-role-policy'), sid);
    return [
      ...new Set(
        (asList(statement.Resource) as string[]).map((resource) => {
          const start = resource.indexOf(marker);
          if (start < 0) {
            throw new Error(`statement ${sid} has a resource outside ${marker}`);
          }
          return resource.slice(start + marker.length).replace(/\*.*/, '');
        }),
      ),
    ].sort();
  }

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

  test('keeps the generated-secret grants tied to both synthesized secret resources', () => {
    const logical = logicalIds('AWS::SecretsManager::Secret');
    const prefixes = resourceNamePrefixes('GeneratedServingSecrets', ':secret:');
    expect(logical).toHaveLength(2);
    expect(prefixes).toHaveLength(2);
    for (const logicalId of logical) {
      expect(prefixes.filter((prefix) => logicalId.startsWith(prefix))).toHaveLength(1);
    }
    for (const prefix of prefixes) {
      expect(logical.filter((logicalId) => logicalId.startsWith(prefix))).toHaveLength(1);
    }
  });

  test('keeps the layer grants tied to both synthesized website-deployment layers', () => {
    const logical = logicalIds('AWS::Lambda::LayerVersion');
    const prefixes = resourceNamePrefixes('LambdaLayers', ':layer:');
    expect(logical).toHaveLength(2);
    expect(prefixes).toHaveLength(2);
    for (const logicalId of logical) {
      expect(prefixes.filter((prefix) => logicalId.startsWith(prefix))).toHaveLength(1);
    }
    for (const prefix of prefixes) {
      expect(logical.filter((logicalId) => logicalId.startsWith(prefix))).toHaveLength(1);
    }
  });

  test('invokes only the synthesized website-deployment provider function', () => {
    const statement = statementNamed(
      statements('cloudformation-execution-role-policy'),
      'InvokeWebsiteDeploymentProvider',
    );
    expect(actions([statement])).toEqual(['lambda:InvokeFunction']);
    const providers = logicalIds('AWS::Lambda::Function').filter((logicalId) =>
      logicalId.startsWith('CustomCDKBucketDeployment'),
    );
    expect(providers).toHaveLength(1);
    expect(asList(statement.Resource)).toEqual([
      `arn:aws:lambda:${config.region}:${config.account}:function:${stackName}-CustomCDKBucketDeployment*`,
    ]);
  });
});

interface SynthesizedResource {
  readonly Type?: string;
  readonly Properties?: Record<string, unknown>;
}

/**
 * synthesizeProduction builds the stack the way `bin/ens-scout.ts` does, at the
 * committed context, with the deployment synthesizer and the fixture assets.
 */
function synthesizeProduction(deferred: boolean): {
  readonly resources: Record<string, SynthesizedResource>;
  readonly parameters: Record<string, unknown>;
  readonly serialized: string;
  readonly environment: { readonly account: string; readonly region: string };
  readonly directory: string;
} {
  const productionConfig = {
    ...resolveConfig(new cdk.App({ context: committedContext })),
    deferDeploymentIdentifiers: deferred,
  };
  const productionApp = new cdk.App({ context: committedContext });
  const website = fixtureWebsiteSources();
  new EnsScoutStack(productionApp, stackName, {
    config: productionConfig,
    scannerCode: fixtureCode(),
    apiCode: fixtureApiCode(),
    websiteSource: website.site,
    websiteAssetsSource: website.assets,
    env: deferred
      ? { region: productionConfig.region }
      : { account: productionConfig.account, region: productionConfig.region },
    synthesizer: deploymentSynthesizer(),
  });
  const assembly = productionApp.synth();
  const stackArtifact = assembly.getStackByName(stackName);
  const template = stackArtifact.template as {
    Resources?: Record<string, SynthesizedResource>;
    Parameters?: Record<string, unknown>;
  };
  return {
    resources: template.Resources ?? {},
    parameters: template.Parameters ?? {},
    serialized: fs.readFileSync(path.join(assembly.directory, stackArtifact.templateFile), 'utf8'),
    environment: stackArtifact.environment,
    directory: assembly.directory,
  };
}

/**
 * accountShapedRun is a twelve-digit run that is not part of a longer hex string, which
 * is what an asset hash is: a content hash can contain twelve decimal digits in a row
 * by chance, and an account number never sits inside one.
 */
const accountShapedRun = /(?<![0-9a-f])[0-9]{12}(?![0-9a-f])/;

/** actionMatches reports whether an IAM action pattern with `*` covers an action. */
function actionMatches(pattern: string, action: string): boolean {
  const expression = new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    'i',
  );
  return expression.test(action);
}

describe('the permissions boundary', () => {
  const boundary = statements('permissions-boundary-policy');
  const boundaryActions = actions(boundary);
  const production = synthesizeProduction(false);
  const roles = Object.entries(production.resources).filter(
    ([, resource]) => resource.Type === 'AWS::IAM::Role',
  );

  /** The actions every inline policy attached to one synthesized role grants. */
  function grantedTo(roleLogicalId: string): string[] {
    return Object.values(production.resources)
      .filter((resource) => resource.Type === 'AWS::IAM::Policy')
      .filter((resource) =>
        (resource.Properties?.Roles as { Ref?: string }[]).some(
          (role) => role.Ref === roleLogicalId,
        ),
      )
      .flatMap((resource) => {
        const document = resource.Properties?.PolicyDocument as { Statement: Statement[] };
        return actions(document.Statement);
      });
  }

  test('is carried by every IAM role in the production template', () => {
    expect(roles.map(([logicalId]) => logicalId).sort()).toEqual([
      'PublicSiteApiRole6575B2D4',
      'PublicSiteWebsiteDeploymentRole67F56037',
      'ScannerRole81F9E458',
    ]);
    for (const [logicalId, role] of roles) {
      // The ARN is a join of the partition, the account, and the policy name, so it
      // is compared as the string CloudFormation resolves it to.
      const arn = JSON.stringify(role.Properties?.PermissionsBoundary);
      expect(arn).toContain(`:policy/${permissionsBoundaryName(config.environmentName)}"`);
      expect(arn).toContain('"Ref":"AWS::Partition"');
      expect({ logicalId, boundary: role.Properties?.PermissionsBoundary }).toEqual({
        logicalId,
        boundary: {
          'Fn::Join': [
            '',
            [
              'arn:',
              { Ref: 'AWS::Partition' },
              `:iam::${config.account}:policy/${permissionsBoundaryName(config.environmentName)}`,
            ],
          ],
        },
      });
    }
  });

  test('is carried by every IAM role when the identifiers are deferred, with no account in it', () => {
    const deferred = synthesizeProduction(true);
    const deferredRoles = Object.entries(deferred.resources).filter(
      ([, resource]) => resource.Type === 'AWS::IAM::Role',
    );
    expect(deferredRoles).toHaveLength(roles.length);
    for (const [, role] of deferredRoles) {
      expect(role.Properties?.PermissionsBoundary).toEqual({
        'Fn::Join': [
          '',
          [
            'arn:',
            { Ref: 'AWS::Partition' },
            ':iam::',
            { Ref: 'AWS::AccountId' },
            `:policy/${permissionsBoundaryName(config.environmentName)}`,
          ],
        ],
      });
    }
  });

  test('is named by the stack and the committed templates alike', () => {
    expect(permissionsBoundaryName('prod')).toBe('EnsScout-prod-PermissionsBoundary');
    expect(permissionsBoundaryName(config.environmentName).startsWith(`${stackName}-`)).toBe(true);
    for (const name of [
      'cloudformation-execution-role-policy',
      'cloudformation-execution-role-policy-transition',
    ]) {
      const document = statements(name).find(
        (statement) => statement.Condition?.StringEquals?.['iam:PermissionsBoundary'] !== undefined,
      );
      expect(document?.Condition?.StringEquals?.['iam:PermissionsBoundary']).toBe(boundaryArn);
    }
  });

  test.each(roles.map(([logicalId]) => [logicalId]))(
    'allows every action %s is granted, because it is derived from the stack',
    (logicalId) => {
      const granted = grantedTo(logicalId);
      expect(granted.length).toBeGreaterThan(0);
      for (const action of granted) {
        expect(boundaryActions.some((pattern) => actionMatches(pattern, action))).toBe(true);
      }
    },
  );

  test('allows nothing a role of this stack does not use', () => {
    // A boundary wider than the stack is a bound that bounds nothing. Every action in
    // it has to be one some synthesized role is actually granted, matched as a pattern
    // in either direction because a role grants `s3:GetObject*` where a boundary names
    // the same family.
    const everyGrant = roles.flatMap(([logicalId]) => grantedTo(logicalId));
    for (const pattern of boundaryActions) {
      expect(everyGrant.some((action) => actionMatches(pattern, action) || actionMatches(action, pattern))).toBe(true);
    }
  });

  test('holds no IAM, STS, or wildcard-service grant and no unscoped resource', () => {
    for (const statement of boundary) {
      expect(statement.Effect).toBe('Allow');
      for (const action of asList(statement.Action) as string[]) {
        expect(action).toMatch(/^(logs|dynamodb|s3):[A-Za-z*]+$/);
        expect(action).not.toMatch(/^[a-z0-9]+:\*$/);
      }
      for (const resource of asList(statement.Resource) as string[]) {
        expect(resource).not.toBe('*');
        expect(resource).toMatch(
          new RegExp(
            `(${stackName}-|:ensscout-${config.environmentName}-|${assetBucket})`,
          ),
        );
      }
    }
  });

  test('scopes the asset and website buckets to the names the synthesizer and the stack use', () => {
    const assets = statementNamed(boundary, 'ReadTheStackAssets');
    expect(asList(assets.Resource)).toEqual([
      `arn:aws:s3:::${assetBucket}`,
      `arn:aws:s3:::${assetBucket}/*`,
    ]);
    const website = statementNamed(boundary, 'CopyTheWebsiteIntoItsPrivateBucket');
    expect(asList(website.Resource)).toEqual([
      `arn:aws:s3:::ensscout-${config.environmentName}-*`,
      `arn:aws:s3:::ensscout-${config.environmentName}-*/*`,
    ]);
  });
});

describe('the transition execution role policy', () => {
  const finalPolicy = statements('cloudformation-execution-role-policy');
  const transition = statements('cloudformation-execution-role-policy-transition');
  const isRoleStatement = (statement: Statement) =>
    (asList(statement.Resource) as string[]).some((resource) =>
      resource.includes(`:role/${stackName}-*`),
    ) && !(asList(statement.Action) as string[]).includes('iam:PassRole');

  test('differs from the final policy only in the role statements', () => {
    // Every other grant is the same document, so the transition cannot quietly carry
    // a permission the final policy dropped.
    expect(transition.filter((statement) => !isRoleStatement(statement))).toEqual(
      finalPolicy.filter((statement) => !isRoleStatement(statement)),
    );
  });

  test('keeps today role grants and adds only the boundary-conditioned PutRolePermissionsBoundary', () => {
    const roleStatements = transition.filter(isRoleStatement);
    const unconditioned = roleStatements.filter((statement) => statement.Condition === undefined);
    expect(unconditioned).toHaveLength(1);
    expect(asList(unconditioned[0].Action)).toEqual(
      expect.arrayContaining(['iam:CreateRole', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy']),
    );
    expect(asList(unconditioned[0].Action)).not.toContain('iam:PutRolePermissionsBoundary');
    expect(asList(unconditioned[0].Action)).not.toContain('iam:AttachRolePolicy');

    const conditioned = roleStatements.filter((statement) => statement.Condition !== undefined);
    expect(conditioned).toHaveLength(1);
    expect(asList(conditioned[0].Action)).toEqual([
      'iam:PutRolePermissionsBoundary',
      'iam:DeleteRolePermissionsBoundary',
    ]);
    expect(conditioned[0].Condition).toEqual({
      StringEquals: { 'iam:PermissionsBoundary': boundaryArn },
    });
  });

  test('may remove a boundary only under the boundary condition, so a failed deploy can roll back', () => {
    // CloudFormation removes the property from a role when it rolls a role update back,
    // and a transition policy that could not would leave the stack in UPDATE_ROLLBACK_FAILED.
    const removing = transition.filter((statement) =>
      asList(statement.Action).includes('iam:DeleteRolePermissionsBoundary'),
    );
    expect(removing).toHaveLength(1);
    expect(removing[0].Condition).toEqual({
      StringEquals: { 'iam:PermissionsBoundary': boundaryArn },
    });
    expect(actions(finalPolicy)).not.toContain('iam:DeleteRolePermissionsBoundary');
  });

  test('grants every role action the final policy grants, so no deploy loses a call mid-rollout', () => {
    const roleActions = (document: Statement[]) =>
      actions(document.filter(isRoleStatement)).filter((action) => action.startsWith('iam:'));
    for (const action of roleActions(finalPolicy)) {
      expect(roleActions(transition)).toContain(action);
    }
  });
});

describe('the assembly the production build job uploads', () => {
  const deferred = synthesizeProduction(true);

  test('is environment-agnostic in the account and names no account', () => {
    expect(deferred.environment.account).toBe('unknown-account');
    expect(deferred.serialized).not.toMatch(accountShapedRun);
    expect(deferred.serialized).not.toContain(config.siteHostedZoneId);
    expect(deferred.serialized).not.toContain(config.siteCertificateArn);
    const manifest = fs.readFileSync(path.join(deferred.directory, 'manifest.json'), 'utf8');
    expect(manifest).not.toMatch(accountShapedRun);
    for (const entry of fs.readdirSync(deferred.directory).filter((name) => name.endsWith('.assets.json'))) {
      expect(fs.readFileSync(path.join(deferred.directory, entry), 'utf8')).not.toMatch(accountShapedRun);
    }
  });

  test('carries the hosted zone and certificate as two required, hidden parameters', () => {
    expect(Object.keys(deferred.parameters).filter((name) => name !== 'BootstrapVersion').sort()).toEqual(
      Object.values(deploymentParameterNames).sort(),
    );
    for (const name of Object.values(deploymentParameterNames)) {
      const parameter = deferred.parameters[name] as Record<string, unknown>;
      expect(parameter.Type).toBe('String');
      expect(parameter.NoEcho).toBe(true);
      expect(parameter).not.toHaveProperty('Default');
      expect(typeof parameter.AllowedPattern).toBe('string');
    }
  });

  test('uses the parameters where the two values go, and nowhere else names them', () => {
    const distribution = Object.values(deferred.resources).find(
      (resource) => resource.Type === 'AWS::CloudFront::Distribution',
    );
    expect(
      (distribution?.Properties?.DistributionConfig as { ViewerCertificate: { AcmCertificateArn: unknown } })
        .ViewerCertificate.AcmCertificateArn,
    ).toEqual({ Ref: deploymentParameterNames.siteCertificateArn });
    const records = Object.values(deferred.resources).filter(
      (resource) => resource.Type === 'AWS::Route53::RecordSet',
    );
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.Properties?.HostedZoneId).toEqual({ Ref: deploymentParameterNames.siteHostedZoneId });
    }
  });

  test('accepts only a zone ID and certificate ARN of the right shape', () => {
    const zone = new RegExp((deferred.parameters.SiteHostedZoneId as { AllowedPattern: string }).AllowedPattern);
    const certificate = new RegExp(
      (deferred.parameters.SiteCertificateArn as { AllowedPattern: string }).AllowedPattern,
    );
    expect(zone.test(config.siteHostedZoneId)).toBe(true);
    expect(zone.test('not-a-zone')).toBe(false);
    expect(certificate.test(config.siteCertificateArn)).toBe(true);
    expect(certificate.test(config.siteCertificateArn.replace('us-east-1', 'ap-southeast-2'))).toBe(false);
  });

  test('is the same template as the committed-context one, apart from the two values', () => {
    // Deferring must not change what is deployed: the same resource set, the same
    // boundary, the same roles. Only the account, zone, and certificate move.
    const committed = synthesizeProduction(false);
    expect(Object.keys(deferred.resources).sort()).toEqual(Object.keys(committed.resources).sort());
    for (const logicalId of Object.keys(committed.resources)) {
      expect(deferred.resources[logicalId].Type).toBe(committed.resources[logicalId].Type);
    }
  });
});

describe('the production deployment workflow', () => {
  const document = workflow('deploy-production.yml');
  const select = workflowJob(document, 'select');
  const build = workflowJob(document, 'build');
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
    expect(build.needs).toBe('select');
    expect(build.if).toBe("needs.select.outputs.deploy_sha != ''");
    expect(deploy.needs).toEqual(['select', 'build']);
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

    const checkout = workflowStep(build, 'checkout the selected commit');
    expect(checkout.uses).toBe('actions/checkout@v7');
    expect(checkout.with).toEqual({
      ref: deploySha,
      'persist-credentials': false,
    });
    expect(workflowStep(build, 'verify the selected commit').env).toEqual({
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
    expect(
      Object.entries(document.jobs)
        .filter(([, job]) => job.environment !== undefined)
        .map(([id]) => id),
    ).toEqual(['deploy']);
    expect(deploy.permissions).toEqual({
      contents: 'read',
      'id-token': 'write',
    });
  });

  test('runs every third-party build step in a job with no token, no environment, and no secret', () => {
    // The point of the split. Anything that installs a dependency, compiles, or
    // tests runs here, so this job must hold nothing worth stealing: no OIDC token,
    // no production environment (environment secrets reach only a job that declares
    // one), no secret or variable, and no credential action.
    expect(build.permissions).toEqual({ contents: 'read' });
    expect(build.environment).toBeUndefined();
    const serialized = JSON.stringify(build);
    expect(serialized).not.toContain('id-token');
    expect(serialized).not.toMatch(/secrets\./);
    expect(serialized).not.toMatch(/vars\./);
    expect(serialized).not.toContain('configure-aws-credentials');
    expect(serialized).not.toMatch(/AWS_[A-Z0-9_]+/);
    const commands = build.steps.map(workflowRunOrEmpty).join('\n');
    for (const command of ['npm ci', 'npm run build', 'npm run check']) {
      expect(commands).toContain(command);
    }
    expect(commands).not.toContain('cdk deploy');
  });

  test('runs no repository code, no build, and no cached or scripted install in the job with the token', () => {
    // The mirror of the test above. The only `uses` the deploy job may carry are the
    // ones that fetch the assembly, install Node for the CLI, and exchange the token.
    expect(deploy.steps.flatMap((step) => (step.uses === undefined ? [] : [step.uses]))).toEqual([
      'actions/download-artifact@v8',
      'actions/setup-node@v7',
      'aws-actions/configure-aws-credentials@v6',
    ]);
    const commands = deploy.steps.map(workflowRunOrEmpty).join('\n');
    for (const forbidden of [
      'npm ci',
      'npm run',
      'npx',
      'go build',
      'go test',
      'git ',
      'cdk synth',
      'ts-node',
    ]) {
      expect(commands).not.toContain(forbidden);
    }
    // Every install it does perform disables lifecycle scripts, so installing the CLI
    // cannot run anything but the CLI's own code.
    const installs = commands.split('\n').filter((line) => /\bnpm (install|i|add)\b/.test(line));
    expect(installs).toHaveLength(1);
    for (const line of installs) {
      expect(line).toContain('--ignore-scripts');
    }
    // A cache restore is the other way a build job reaches a job it does not control.
    const setupNode = deploy.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(setupNode?.with).not.toHaveProperty('cache');
    expect(setupNode?.with?.['package-manager-cache']).toBe(false);
  });

  test('installs exactly the CDK CLI version the infra project pins', () => {
    const install = workflowStep(deploy, 'install the pinned CDK CLI');
    const pinned: string = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    ).devDependencies['aws-cdk'];
    expect(pinned).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
    expect(install.env).toEqual({ CDK_CLI_VERSION: pinned });
    expect(workflowRun(install)).toContain('"aws-cdk@$CDK_CLI_VERSION"');
  });

  test('installs the CLI before any credential exists', () => {
    expect(deploy.steps.indexOf(workflowStep(deploy, 'install the pinned CDK CLI'))).toBeLessThan(
      deploy.steps.indexOf(workflowStep(deploy, 'assume the deployment role')),
    );
  });

  test('builds once and deploys the exact cdk.out assembly that passed', () => {
    const website = workflowStep(build, 'build the production website');
    const artifact = workflowStep(build, 'build and verify the artifact');
    const upload = workflowStep(build, 'upload the cloud assembly');
    const download = workflowStep(deploy, 'download the cloud assembly');
    const verify = workflowStep(deploy, 'verify and unpack the downloaded assembly');
    const validate = workflowStep(deploy, 'validate the cloud assembly');
    const deployment = workflowStep(deploy, 'deploy');
    expect(deploy.steps.indexOf(verify)).toBeLessThan(deploy.steps.indexOf(validate));
    expect(deploy.steps.indexOf(validate)).toBeLessThan(
      deploy.steps.indexOf(workflowStep(deploy, 'install the pinned CDK CLI')),
    );
    expect(build.steps.indexOf(website)).toBeLessThan(build.steps.indexOf(artifact));
    expect(build.steps.indexOf(artifact)).toBeLessThan(build.steps.indexOf(upload));
    expect(deploy.steps.indexOf(download)).toBeLessThan(deploy.steps.indexOf(verify));
    expect(deploy.steps.indexOf(verify)).toBeLessThan(deploy.steps.indexOf(deployment));
    expect(website['working-directory']).toBe('web');
    expect(website.env).toEqual({ VITE_API_BASE_URL: '/' });
    expect(workflowRun(artifact)).toBe(
      'npm run check -- --context "ens-scout:deferDeploymentIdentifiers=true"',
    );
    expect(upload.with).toMatchObject({
      name: 'cdk-assembly',
      path: 'cdk-assembly.tar',
      'if-no-files-found': 'error',
    });
    expect(download.with).toEqual({ name: 'cdk-assembly', path: 'assembly' });
    expect(workflowRun(deployment)).toContain(`cdk deploy ${stackName}`);
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

  test('ships the assembly as a tar, because the artifact actions drop the execute bit', () => {
    const pack = workflowStep(build, 'package the cloud assembly');
    expect(workflowRun(pack)).toContain('tar -C infra -cf cdk-assembly.tar cdk.out');
    expect(build.outputs).toEqual({ assembly_sha256: '${{ steps.assembly.outputs.sha256 }}' });
    expect(pack.id).toBe('assembly');
    expect(build.steps.indexOf(pack)).toBeLessThan(
      build.steps.indexOf(workflowStep(build, 'upload the cloud assembly')),
    );
  });

  test('refuses a tar that is not the one the build reported, and keeps the execute bit', () => {
    const verify = workflowStep(deploy, 'verify and unpack the downloaded assembly');
    expect(verify.env).toEqual({
      EXPECTED_ASSEMBLY_SHA256: '${{ needs.build.outputs.assembly_sha256 }}',
    });

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ens-scout-assembly-'));
    try {
      const source = path.join(directory, 'source', 'cdk.out', 'asset.abc');
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, 'bootstrap'), 'binary');
      fs.chmodSync(path.join(source, 'bootstrap'), 0o755);
      fs.mkdirSync(path.join(directory, 'work', 'assembly'), { recursive: true });
      const tar = path.join(directory, 'work', 'assembly', 'cdk-assembly.tar');
      expect(
        spawnSync('tar', ['-C', path.join(directory, 'source'), '-cf', tar, 'cdk.out']).status,
      ).toBe(0);
      const expected = require('crypto').createHash('sha256').update(fs.readFileSync(tar)).digest('hex');
      const run = (hash: string) =>
        spawnSync('/bin/bash', ['-c', `set -euo pipefail\n${workflowRun(verify)}`], {
          cwd: path.join(directory, 'work'),
          env: { ...process.env, EXPECTED_ASSEMBLY_SHA256: hash },
          encoding: 'utf8',
        });
      expect(run('0'.repeat(64)).status).not.toBe(0);
      expect(run('').status).not.toBe(0);
      expect(run(expected).status).toBe(0);
      const handler = path.join(directory, 'work', 'cdk.out', 'asset.abc', 'bootstrap');
      expect(() => fs.accessSync(handler, fs.constants.X_OK)).not.toThrow();

      // A copy that lost the bit, which is what the artifact actions do, is refused.
      fs.chmodSync(handler, 0o644);
      expect(
        spawnSync('/bin/bash', ['-c', `for handler in cdk.out/asset.*/bootstrap; do [ ! -e "$handler" ] || [ -x "$handler" ] || exit 1; done`], {
          cwd: path.join(directory, 'work'),
        }).status,
      ).toBe(1);
      expect(workflowRun(verify)).toContain('[ ! -x "$handler" ]');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  describe('the assembly validation', () => {
    const validate = workflowStep(deploy, 'validate the cloud assembly');
    const stackFile = `${stackName}.assets.json`;

    /** Run the validation step against a copy of a real deferred assembly, edited by `edit`. */
    function validation(
      edit: (files: { manifest: any; assets: any; directory: string }) => void = () => undefined,
    ): StepResult {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ens-scout-validate-'));
      try {
        fs.cpSync(synthesizeProduction(true).directory, path.join(directory, 'cdk.out'), {
          recursive: true,
        });
        const manifestPath = path.join(directory, 'cdk.out', 'manifest.json');
        const assetsPath = path.join(directory, 'cdk.out', stackFile);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const assets = JSON.parse(fs.readFileSync(assetsPath, 'utf8'));
        edit({ manifest, assets, directory: path.join(directory, 'cdk.out') });
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        fs.writeFileSync(assetsPath, JSON.stringify(assets));
        const result = spawnSync('/bin/bash', ['-c', `set -euo pipefail\n${workflowRun(validate)}`], {
          cwd: directory,
          encoding: 'utf8',
        });
        return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, outputs: {} };
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }

    const firstFile = (assets: any) => Object.values(assets.files)[0] as any;

    test('accepts the assembly today synth produces', () => {
      const result = validation();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    });

    test.each([
      ['an asset executable the CLI would run', ({ assets }: any) => {
        firstFile(assets).source.executable = ['sh', '-c', 'true'];
      }],
      ['a docker image asset', ({ assets }: any) => {
        assets.dockerImages = { abc: { source: { directory: 'x' }, destinations: {} } };
      }],
      ['a source path with ..', ({ assets }: any) => {
        firstFile(assets).source.path = '../outside';
      }],
      ['an absolute source path', ({ assets }: any) => {
        firstFile(assets).source.path = '/etc/passwd';
      }],
      ['another bucket', ({ assets }: any) => {
        (Object.values(firstFile(assets).destinations)[0] as any).bucketName = 'other-bucket';
      }],
      ['an assumed role on a destination', ({ assets }: any) => {
        (Object.values(firstFile(assets).destinations)[0] as any).assumeRoleArn = 'arn:aws:iam::1:role/x';
      }],
      ['a concrete stack environment', ({ manifest }: any) => {
        manifest.artifacts[stackName].environment = 'aws://123456789012/ap-southeast-2';
      }],
      ['an assumeRoleArn on the stack', ({ manifest }: any) => {
        manifest.artifacts[stackName].properties.assumeRoleArn = 'arn:aws:iam::1:role/x';
      }],
      ['a cloudFormationExecutionRoleArn on the stack', ({ manifest }: any) => {
        manifest.artifacts[stackName].properties.cloudFormationExecutionRoleArn = 'arn:aws:iam::1:role/x';
      }],
      ['a lookup role on the stack', ({ manifest }: any) => {
        manifest.artifacts[stackName].properties.lookupRole = { arn: 'arn:aws:iam::1:role/x' };
      }],
      ['an unexpected artifact', ({ manifest }: any) => {
        manifest.artifacts.Extra = { type: 'cdk:cloud-assembly', properties: { directoryName: 'x' } };
      }],
      ['a template asset that is not the hashed template', ({ manifest }: any) => {
        manifest.artifacts[stackName].properties.stackTemplateAssetObjectUrl =
          manifest.artifacts[stackName].properties.stackTemplateAssetObjectUrl.replace(/[0-9a-f]\.json$/, '0.json');
      }],
      ['a symbolic link', ({ directory }: any) => {
        fs.symlinkSync('/tmp', path.join(directory, 'link'));
      }],
    ])('refuses %s', (_name, edit) => {
      const result = validation(edit as never);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('the cloud assembly is not acceptable');
    });
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
      expect(summary).not.toMatch(/AWS_[A-Z0-9_]+/);
      expect(summary).not.toContain('role/');
    }
  });

  test('holds no long-lived AWS credential', () => {
    // The whole point of federating: there is no access key in this repository to
    // leak, rotate, or forget.
    const serialized = serializedWorkflow(document);
    expect(serialized).not.toContain('aws-access-key-id');
    expect(serialized).not.toContain('aws-secret-access-key');
    expect(serialized).not.toMatch(/secrets\.AWS_(ACCESS|SECRET|SESSION)/);
  });
});

describe('the deployment configuration the workflow requires', () => {
  const document = workflow('deploy-production.yml');
  const build = workflowJob(document, 'build');
  const deploy = workflowJob(document, 'deploy');
  const validation = workflowStep(deploy, 'require the deployment configuration');
  const credential = workflowStep(deploy, 'assume the deployment role');
  const artifact = workflowStep(build, 'build and verify the artifact');
  const download = workflowStep(deploy, 'download the cloud assembly');
  const deployment = workflowStep(deploy, 'deploy');
  const required = Object.keys(validation.env ?? {}).filter((name) => name.startsWith('AWS_'));
  const validAccount = '1'.repeat(12);
  const valid = {
    AWS_ACCOUNT_ID: validAccount,
    AWS_REGION: 'ap-southeast-2',
    AWS_DEPLOY_ROLE_ARN: `arn:aws:iam::${validAccount}:role/DeployFixture`,
    AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN: `arn:aws:iam::${validAccount}:role/ExecutionFixture`,
    AWS_ROUTE53_HOSTED_ZONE_ID: 'Z1234567890ABCDEFGHIJ',
    AWS_ACM_CERTIFICATE_ARN:
      `arn:aws:acm:us-east-1:${validAccount}:certificate/12345678-1234-1234-1234-123456789abc`,
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

  test('requires every secret and variable it reads, and reads every one it requires', () => {
    // A seventh value added without a check would be one the job discovers is missing
    // at whichever step first needs it, which on the deploy step is mid-deployment.
    const referenced = new Set(
      [...serializedWorkflow(document).matchAll(/(?:vars|secrets)\.([A-Z0-9_]+)/g)].map(
        (match) => match[1],
      ),
    );
    expect([...referenced].sort()).toEqual([...required].sort());
    expect([...required].sort()).toEqual([
      'AWS_ACCOUNT_ID',
      'AWS_ACM_CERTIFICATE_ARN',
      'AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN',
      'AWS_DEPLOY_ROLE_ARN',
      'AWS_REGION',
      'AWS_ROUTE53_HOSTED_ZONE_ID',
    ]);
  });

  test('keeps every account-specific value a secret, and only the region a variable', () => {
    // A variable in `env:` or `with:` is printed in the step header of a log a public
    // repository shows to everyone. A secret is masked there. The region is the one
    // value that is not account-specific.
    const sources = Object.entries(validation.env ?? {})
      .filter(([name]) => name.startsWith('AWS_'))
      .map(([name, value]) => [name, String(value)]);
    expect(Object.fromEntries(sources)).toEqual({
      AWS_ACCOUNT_ID: '${{ secrets.AWS_ACCOUNT_ID }}',
      AWS_REGION: '${{ vars.AWS_REGION }}',
      AWS_DEPLOY_ROLE_ARN: '${{ secrets.AWS_DEPLOY_ROLE_ARN }}',
      AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN: '${{ secrets.AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN }}',
      AWS_ROUTE53_HOSTED_ZONE_ID: '${{ secrets.AWS_ROUTE53_HOSTED_ZONE_ID }}',
      AWS_ACM_CERTIFICATE_ARN: '${{ secrets.AWS_ACM_CERTIFICATE_ARN }}',
    });
    const variables = new Set(
      [...serializedWorkflow(document).matchAll(/vars\.([A-Z0-9_]+)/g)].map((match) => match[1]),
    );
    expect([...variables]).toEqual(['AWS_REGION']);
  });

  test('prints no secret value: none reaches an echo, a trace, or a step summary', () => {
    for (const step of allWorkflowSteps(document)) {
      const script = workflowRunOrEmpty(step);
      expect(script).not.toMatch(/set -[a-z]*x/);
      for (const line of script.split('\n').filter((candidate) => /\b(echo|printf)\b/.test(candidate))) {
        expect(line).not.toMatch(
          /\$\{?(AWS_ACCOUNT_ID|AWS_DEPLOY_ROLE_ARN|AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN|AWS_ROUTE53_HOSTED_ZONE_ID|AWS_ACM_CERTIFICATE_ARN)\b/,
        );
      }
    }
  });

  test('checks the configuration before it downloads, authenticates, or deploys anything', () => {
    // Ordering is the point of the step. A value checked after the synth costs a
    // toolchain and a build; one checked after the deploy step has started costs a
    // half-applied stack.
    expect(deploy.steps.indexOf(validation)).toBe(0);
    expect(deploy.steps.indexOf(validation)).toBeLessThan(deploy.steps.indexOf(download));
    expect(deploy.steps.indexOf(validation)).toBeLessThan(deploy.steps.indexOf(credential));
    expect(deploy.steps.indexOf(validation)).toBeLessThan(deploy.steps.indexOf(deployment));
  });

  test('accepts six consistent production values and prints none of them', () => {
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
    expect(validate({ AWS_ROUTE53_HOSTED_ZONE_ID: 'not-a-zone' }).status).not.toBe(0);
    expect(
      validate({
        AWS_ACM_CERTIFICATE_ARN:
          `arn:aws:acm:ap-southeast-2:${validAccount}:certificate/12345678-1234-1234-1234-123456789abc`,
      }).status,
    ).not.toBe(0);
    expect(
      validate({
        AWS_ACM_CERTIFICATE_ARN:
          `arn:aws:acm:us-east-1:${'2'.repeat(12)}:certificate/12345678-1234-1234-1234-123456789abc`,
      }).status,
    ).not.toBe(0);
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

  test('assumes the deployment role the deploy-role secret names, in that region', () => {
    expect(credential.with?.['role-to-assume']).toBe('${{ secrets.AWS_DEPLOY_ROLE_ARN }}');
    expect(credential.with?.['aws-region']).toBe('${{ vars.AWS_REGION }}');
    expect(credential.with?.['allowed-account-ids']).toBe('${{ secrets.AWS_ACCOUNT_ID }}');
  });

  test('masks the account ID in the credential action, which does not by default', () => {
    expect(credential.with?.['mask-aws-account-id']).toBe(true);
  });

  test('synthesizes the deployed artifact with the account, zone, and certificate left out', () => {
    // The build job holds none of the three, so the assembly it uploads names none of
    // them, and the deploy job supplies the two the stack needs as CloudFormation
    // parameters. `--app cdk.out` deploys the assembly, so the parameter names have to
    // be the ones the stack declares.
    expect(artifact.env).toBeUndefined();
    expect(workflowRun(artifact)).toBe(
      'npm run check -- --context "ens-scout:deferDeploymentIdentifiers=true"',
    );
    expect(deployment.env).toEqual({
      AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN: '${{ secrets.AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN }}',
      AWS_ROUTE53_HOSTED_ZONE_ID: '${{ secrets.AWS_ROUTE53_HOSTED_ZONE_ID }}',
      AWS_ACM_CERTIFICATE_ARN: '${{ secrets.AWS_ACM_CERTIFICATE_ARN }}',
    });
    expect(workflowRun(deployment)).toContain(
      `--parameters "${stackName}:${deploymentParameterNames.siteHostedZoneId}=$AWS_ROUTE53_HOSTED_ZONE_ID"`,
    );
    expect(workflowRun(deployment)).toContain(
      `--parameters "${stackName}:${deploymentParameterNames.siteCertificateArn}=$AWS_ACM_CERTIFICATE_ARN"`,
    );
  });

  test('passes the execution role the execution-role secret names', () => {
    // A different ARN here is refused by the deployment role's PassRole condition, so
    // the failure is safe but opaque; this is the assertion that names where it comes
    // from.
    expect(deployment.env?.AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN).toBe(
      '${{ secrets.AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN }}',
    );
    expect(workflowRun(deployment)).toContain(
      '--role-arn "$AWS_CLOUDFORMATION_EXECUTION_ROLE_ARN"',
    );
  });

  test('appends the deferral context to a script that ends with the synth', () => {
    // `npm run check -- <args>` appends to the end of the chained script string, so the
    // arguments reach whatever the chain ends with and nothing else. A check script
    // reordered to end with the tests would send `--context` to jest, which would
    // upload an assembly that still names the placeholders, and the deploy job's
    // parameters would then address a template that declares none.
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

  test('are the documents applied to the two deployment roles and the boundary policy', () => {
    expect(names.sort()).toEqual([
      'cloudformation-execution-role-policy',
      'cloudformation-execution-role-policy-transition',
      'cloudformation-execution-role-trust',
      'github-deploy-role-policy',
      'github-deploy-role-trust',
      'permissions-boundary-policy',
    ]);
  });

  test('render against the account the committed context names', () => {
    // Every assertion above compares a rendered document with `config`, so this is the
    // equality those comparisons rest on. Were it to break, they would all fail at
    // once and look like a policy change instead of a mismatched example.
    expect(exampleValues.ACCOUNT_ID).toBe(config.account);
    expect(config.account).toBe(placeholderAccount);
  });

  test('render against the hosted zone the committed context names', () => {
    expect(exampleValues.ROUTE53_HOSTED_ZONE_ID).toBe(config.siteHostedZoneId);
    const source = render.readTemplate('cloudformation-execution-role-policy');
    expect(source).toContain('hostedzone/${ROUTE53_HOSTED_ZONE_ID}');
    expect(source).not.toContain(config.siteHostedZoneId);
  });

  test('render against a synthetic immutable repository identity', () => {
    expect(exampleValues.GITHUB_REPOSITORY_IDENTITY).toBe(exampleRepositoryIdentity);
    const source = JSON.parse(render.readTemplate('github-deploy-role-trust'));
    expect(source.Statement[0].Condition).toEqual({
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub':
          'repo:${GITHUB_REPOSITORY_IDENTITY}:environment:production',
      },
    });
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
