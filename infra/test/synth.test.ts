import * as fs from 'fs';
import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { resolveConfig } from '../lib/config';
import { EnsScoutStack } from '../lib/ens-scout-stack';
import { fixtureCode, repoRoot, synth } from './helpers';

const committedContext: Record<string, unknown> = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'),
).context;

describe('synthesis', () => {
  test('is deterministic', () => {
    // A template that differs between two synths of the same input makes `cdk diff`
    // useless: every diff then reports changes that are only synthesis noise, and a
    // real change hides among them.
    const first = JSON.stringify(synth().template.toJSON());
    const second = JSON.stringify(synth().template.toJSON());
    expect(second).toBe(first);
  });

  test('succeeds against the committed context, which is what a clean clone uses', () => {
    const app = new cdk.App({ context: committedContext });
    const config = resolveConfig(app);
    const stack = new EnsScoutStack(app, `EnsScout-${config.environmentName}`, {
      config,
      scannerCode: fixtureCode(),
      env: { account: config.account, region: config.region },
    });
    const template = Template.fromStack(stack);
    // The environment is fixed rather than resolved from ambient credentials, so a
    // synth cannot silently target whichever account happens to be logged in.
    expect(stack.account).toBe('289866763058');
    expect(stack.region).toBe('ap-southeast-2');
    expect(Object.keys(template.toJSON().Resources ?? {}).length).toBeGreaterThan(0);
  });

  test('produces no unresolved token in a value an operator reads', () => {
    // A `${Token[...]}` in a description or an output is a construct reference that
    // escaped into a string, and CloudFormation will not resolve it.
    const rendered = JSON.stringify(synth().template.toJSON());
    expect(rendered).not.toContain('${Token[');
  });

  test('adds none of the resources issue #4 defers', () => {
    // The read API, the frontend, and the deployment pipeline are later phases. This
    // is the assertion that keeps a well-meant addition out of this stack.
    const template = synth().template;
    for (const type of [
      'AWS::ApiGateway::RestApi',
      'AWS::ApiGatewayV2::Api',
      'AWS::Lambda::Url',
      'AWS::S3::Bucket',
      'AWS::CloudFront::Distribution',
      'AWS::IAM::OIDCProvider',
      'AWS::CertificateManager::Certificate',
      'AWS::Route53::HostedZone',
      'AWS::Scheduler::Schedule',
    ]) {
      template.resourceCountIs(type, 0);
    }
  });

  test('tags every taggable resource with the project and the environment', () => {
    // Cost attribution and the "assume production unless tagged otherwise" rule both
    // depend on this, and a stack-level tag is only applied to resources that take
    // one, so the assertion checks the resources rather than the Tags aspect.
    const template = synth().template;
    const resources = template.toJSON().Resources as Record<
      string,
      { Type: string; Properties?: { Tags?: Array<{ Key: string; Value: string }> } }
    >;
    const taggable = Object.values(resources).filter((resource) =>
      Array.isArray(resource.Properties?.Tags),
    );
    expect(taggable.length).toBeGreaterThan(0);
    for (const resource of taggable) {
      const tags = new Map(resource.Properties!.Tags!.map((tag) => [tag.Key, tag.Value]));
      expect(tags.get('Project')).toBe('ens-scout');
      expect(tags.get('Environment')).toBe('test');
    }
  });
});

describe('the scanner bundle', () => {
  test('is the only Go binary the stack packages', () => {
    // The Lambda asset is the compiled scanner and its word lists, nothing else. A
    // bundle that swept the repository in would ship the CLI, the fixtures, and the
    // historical results, and its hash would change on every unrelated commit.
    const script = fs.readFileSync(
      path.join(repoRoot, 'infra', 'scripts', 'bundle-scanner.js'),
      'utf8',
    );
    expect(script).toContain('./cmd/scan-lambda');
    expect(script).toContain('arm64');
    expect(script).toContain('CGO_ENABLED');
    // These three flags are what make two builds of the same source produce the same
    // bytes, and so the same CDK asset hash. -buildvcs=false is the one worth
    // asserting: without it a git worktree and a normal clone of the same commit
    // stamp different module versions and produce different asset hashes, so a
    // deployment from one would report a Lambda update over the other.
    expect(script).toContain('-trimpath');
    expect(script).toContain('-buildid=');
    expect(script).toContain('-buildvcs=false');
  });

  test('targets the Go version go.mod declares', () => {
    // The repository holds Go 1.18 compatibility deliberately. A bundle built by a
    // newer toolchain is fine; source that needs one is not.
    const goMod = fs.readFileSync(path.join(repoRoot, 'go.mod'), 'utf8');
    expect(goMod).toMatch(/^go 1\.18$/m);
  });
});
