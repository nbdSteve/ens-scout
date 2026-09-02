import * as fs from 'fs';
import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';

import { Config, defaultScanTuning } from '../lib/config';
import { EnsScoutStack } from '../lib/ens-scout-stack';

/**
 * repoRoot is the checkout, so a test can read the Go source that owns a name the
 * stack has to match.
 */
export const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * testSecretName is deliberately not a plausible credential. It is the secret's
 * name, which is not secret; the value never enters a test, because a test that
 * held one would be the leak it is meant to rule out.
 */
export const testSecretName = 'ens-scout-test/thegraph-api-key';

/**
 * testConfig is a complete configuration with no dependence on cdk.json, so a
 * change to the deployed context cannot silently change what these tests assert.
 */
export const testConfig: Config = {
  environmentName: 'test',
  account: '289866763058',
  region: 'ap-southeast-2',
  subgraphId: 'test-subgraph-id',
  graphApiKeySecretName: testSecretName,
  graphApiKeySecretField: 'apiKey',
  snapshotTtlAttribute: 'expires_at',
  logRetentionDays: 30,
  dlqRetentionDays: 14,
  scanTuning: defaultScanTuning,
};

/**
 * fixtureCode is the stand-in Lambda asset. See test/fixtures/scan-lambda/bootstrap
 * for why the real bundle is never used here.
 */
export function fixtureCode(): lambda.Code {
  return lambda.Code.fromAsset(path.join(__dirname, 'fixtures', 'scan-lambda'));
}

export interface SynthResult {
  readonly app: cdk.App;
  readonly stack: EnsScoutStack;
  readonly template: Template;
}

/**
 * synth builds the stack under test. Passing a partial config overrides one field
 * without restating the rest.
 */
export function synth(overrides: Partial<Config> = {}): SynthResult {
  const app = new cdk.App();
  const config: Config = { ...testConfig, ...overrides };
  const stack = new EnsScoutStack(app, `EnsScout-${config.environmentName}`, {
    config,
    scannerCode: fixtureCode(),
    env: { account: config.account, region: config.region },
  });
  return { app, stack, template: Template.fromStack(stack) };
}

/**
 * goSource reads a file from the Go tree.
 *
 * Several names in the stack - the environment variable names, the scan group
 * strings, the table's key and TTL attributes - are not the stack's to choose: the
 * Go packages define them, and a mismatch produces a deployment that starts and
 * then fails to read or write anything. Reading the definition instead of copying
 * it is what makes those assertions catch a drift rather than restate it.
 */
export function goSource(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/**
 * goStringConstants extracts `Name = "value"` and `Name Type = "value"` constants
 * from Go source, keyed by constant name.
 */
export function goStringConstants(source: string): Map<string, string> {
  const constants = new Map<string, string>();
  const pattern = /^\s*([A-Za-z][A-Za-z0-9_]*)\s+(?:[A-Za-z][A-Za-z0-9_]*\s+)?=\s*"([^"]*)"/gm;
  for (const match of source.matchAll(pattern)) {
    constants.set(match[1], match[2]);
  }
  return constants;
}

/**
 * requireConstant fails loudly when a Go constant a test depends on has been
 * renamed, rather than letting the test pass against undefined.
 */
export function requireConstant(constants: Map<string, string>, name: string): string {
  const value = constants.get(name);
  if (value === undefined) {
    throw new Error(`Go constant ${name} was not found; the assertion below is stale`);
  }
  return value;
}

/**
 * eachPolicyStatement yields every statement of every IAM policy and role in a
 * template, so a test can assert over all of them and cannot pass by checking only
 * the policies it happened to name.
 */
export function eachPolicyStatement(template: Template): Array<Record<string, unknown>> {
  const statements: Array<Record<string, unknown>> = [];
  const collect = (document: unknown): void => {
    const candidate = document as { Statement?: unknown } | undefined;
    if (!candidate || !Array.isArray(candidate.Statement)) {
      return;
    }
    for (const statement of candidate.Statement) {
      statements.push(statement as Record<string, unknown>);
    }
  };
  for (const resource of Object.values(template.findResources('AWS::IAM::Policy'))) {
    collect((resource.Properties as { PolicyDocument?: unknown }).PolicyDocument);
  }
  for (const resource of Object.values(template.findResources('AWS::IAM::Role'))) {
    const properties = resource.Properties as {
      AssumeRolePolicyDocument?: unknown;
      Policies?: Array<{ PolicyDocument?: unknown }>;
    };
    collect(properties.AssumeRolePolicyDocument);
    for (const policy of properties.Policies ?? []) {
      collect(policy.PolicyDocument);
    }
  }
  return statements;
}

/** asList normalizes a CloudFormation field that may be a scalar or a list. */
export function asList(value: unknown): unknown[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
