import * as fs from 'fs';
import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { resolveConfig } from '../lib/config';
import { EnsScoutStack, scannerHandler } from '../lib/ens-scout-stack';
import { fixtureCode, goSource, repoRoot, synth } from './helpers';

// The bundle script is plain CommonJS, so it is required rather than imported. The
// assertions below run its exported functions instead of reading its text.
const bundle = require('../scripts/bundle-scanner');

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
  // The script's own argv and environment, not its text. Asserting on the source
  // would pass from the header comment that names these flags, which is exactly how
  // a dropped -buildvcs=false went unnoticed once already.
  const args: string[] = bundle.buildArgs();
  const env: Record<string, string> = bundle.buildEnv({});

  test('compiles the scanner package and nothing else', () => {
    // The Lambda asset is the compiled scanner and its word lists. A bundle that
    // swept the repository in would ship the CLI, the fixtures, and the historical
    // results, and its hash would change on every unrelated commit.
    expect(args[0]).toBe('build');
    expect(args.filter((arg) => arg.startsWith('./'))).toEqual(['./cmd/scan-lambda']);
    expect(args[args.length - 1]).toBe('./cmd/scan-lambda');
  });

  test('writes the entrypoint name the provided runtime executes', () => {
    const output = args[args.indexOf('-o') + 1];
    expect(path.basename(output)).toBe(scannerHandler);
  });

  test('drops every stamp that would vary between two builds of one commit', () => {
    // These are what make two builds of the same source produce the same bytes, and
    // so the same CDK asset hash. -buildvcs=false is the one worth asserting:
    // without it a git worktree and a normal clone of the same commit stamp
    // different module versions and produce different asset hashes, so a deployment
    // from one would report a Lambda update over the other.
    expect(args).toContain('-trimpath');
    expect(args).toContain('-buildvcs=false');
    const ldflags = args[args.indexOf('-ldflags') + 1];
    expect(ldflags.split(/\s+/)).toContain('-buildid=');
  });

  test('cross-compiles statically for the architecture the function declares', () => {
    expect(env.GOOS).toBe('linux');
    expect(env.GOARCH).toBe('arm64');
    expect(env.CGO_ENABLED).toBe('0');
  });

  test('ships every word list internal/scanner.Lists names', () => {
    // A list the Go definition names and the checkout does not hold would package,
    // deploy cleanly, and then fail every invocation in loadLists.
    const required: string[] = bundle.requiredWordLists(goSource('internal/scanner/scanner.go'));
    expect(required.length).toBeGreaterThan(0);
    const available = fs.readdirSync(path.join(repoRoot, 'data', 'words'));
    expect(bundle.selectWordLists(available, required)).toEqual(expect.arrayContaining(required));
  });

  test('fails the bundle when a required word list is missing, and names it', () => {
    const required: string[] = bundle.requiredWordLists(goSource('internal/scanner/scanner.go'));
    const dropped = required[required.length - 1];
    const available = required.filter((name) => name !== dropped);
    expect(() => bundle.selectWordLists(available, required)).toThrow(dropped);
  });

  test('refuses a Lists block it can only partly read', () => {
    // An entry whose Path is a constant rather than a string literal contributes no
    // name. Yielding the readable subset would leave the missing-list check finding
    // every name it was told about, so the bundle would package without that list and
    // fail every invocation of its group - the failure the check exists to prevent,
    // reached through a parse gap instead of a glob gap.
    const partial = [
      'var Lists = []ListSpec{',
      '\t{ID: "3-letters", Path: "data/words/3-letters.txt", Cadence: c, Group: g},',
      '\t{ID: "6-letters", Path: sixLetterPath, Cadence: c, Group: g},',
      '}',
    ].join('\n');
    expect(() => bundle.requiredWordLists(partial)).toThrow(/6-letters/);
  });

  test('refuses a Lists block that declares nothing', () => {
    expect(() => bundle.requiredWordLists('var Lists = []ListSpec{\n}')).toThrow(/declares no list/);
  });

  test('refuses a source with no Lists block at all', () => {
    expect(() => bundle.requiredWordLists('package scanner\n')).toThrow(/Lists definition/);
  });

  test('copies word lists only, never the fixtures or the historical results', () => {
    const required: string[] = bundle.requiredWordLists(goSource('internal/scanner/scanner.go'));
    const selected: string[] = bundle.selectWordLists(
      [...required, 'results.json', 'notes.md', 'archive'],
      required,
    );
    expect(selected).toEqual([...required].sort());
  });

  test('targets the Go version go.mod declares', () => {
    // The repository holds Go 1.18 compatibility deliberately. A bundle built by a
    // newer toolchain is fine; source that needs one is not.
    expect(goDirective(goSource('go.mod'))).toBe('1.18');
  });
});

/**
 * goDirective is the version in go.mod's `go` directive.
 *
 * go.mod is a declarative artifact the Go tool consumes, so the assertion parses it
 * into the value it means rather than matching the file's text.
 */
function goDirective(goMod: string): string {
  const directive = goMod
    .split('\n')
    .map((line) => /^go\s+([0-9]+(?:\.[0-9]+)*)$/.exec(line.trim()))
    .find((match) => match !== null);
  if (!directive) {
    throw new Error('go.mod declares no go directive');
  }
  return directive[1];
}
