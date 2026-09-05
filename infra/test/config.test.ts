import * as fs from 'fs';
import * as path from 'path';

import * as cdk from 'aws-cdk-lib';

import { contextKeys, resolveConfig } from '../lib/config';
import { goSource, goStringConstants, requireConstant } from './helpers';

/** The context committed in cdk.json, which is what an unqualified `cdk` command uses. */
const committedContext: Record<string, unknown> = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'),
).context;

function scopeWith(overrides: Record<string, unknown> = {}): cdk.App {
  return new cdk.App({ context: { ...committedContext, ...overrides } });
}

describe('the committed context', () => {
  test('resolves without an override', () => {
    // Acceptance for issue #4 is that `cdk synth` succeeds from a clean clone, which
    // means cdk.json alone has to satisfy every key resolveConfig requires.
    expect(() => resolveConfig(scopeWith())).not.toThrow();
  });

  test('names the production account and region the task fixed', () => {
    const config = resolveConfig(scopeWith());
    expect(config.account).toBe('289866763058');
    expect(config.region).toBe('ap-southeast-2');
  });

  test('declares a key for every value the stack reads', () => {
    // A key present in contextKeys and absent from cdk.json would synthesize only
    // for whoever passed it on the command line.
    for (const key of Object.values(contextKeys)) {
      expect(Object.keys(committedContext)).toContain(key);
    }
  });

  test('holds no key beyond the ones the stack reads', () => {
    // Everything here is committed, printed by `cdk context`, and read by every
    // reviewer, so the Graph API key is named indirectly through the secret that
    // holds it. Pinning the set is what catches a later edit that adds an
    // `ens-scout:` key to carry the credential itself: it fails until someone adds
    // the key to contextKeys, which is the moment to notice.
    const declared = new Set<string>(Object.values(contextKeys));
    const ours = Object.keys(committedContext).filter((key) => key.startsWith('ens-scout:'));
    expect(ours.sort()).toEqual([...declared].sort());
  });

  test('names the TTL attribute internal/dynamo actually writes', () => {
    // This is the one Go-owned name that lives in context, so it is the one that can
    // be wrong in the committed value alone. A mismatch is silent in every direction:
    // the table gets a TimeToLiveSpecification on an attribute nothing writes, every
    // call still succeeds, no alarm fires, and a superseded chunk set carries an
    // `expires_at` DynamoDB never looks at - unreachable, because its publisher
    // unstaged it on success and nothing scans chunk partitions. The table just grows.
    //
    // The assertion is against the committed context rather than testConfig, whose
    // value is a literal: comparing a copy with the Go constant would pass while
    // cdk.json said something else entirely.
    const expiresAt = requireConstant(
      goStringConstants(goSource('internal/dynamo/item.go')),
      'attrExpiresAt',
    );
    expect(resolveConfig(scopeWith()).snapshotTtlAttribute).toBe(expiresAt);
  });

  test('names the credential rather than carrying it', () => {
    const config = resolveConfig(scopeWith());
    expect(config.graphApiKeySecretName).toBe('ens-scout/thegraph-api-key');
    expect(config.graphApiKeySecretField).toBe('apiKey');
    expect(JSON.stringify(committedContext)).not.toContain('THEGRAPH_API_KEY');
  });
});

describe('resolveConfig', () => {
  test('rejects a missing value rather than substituting one', () => {
    // Every key changes what a scheduled scan queries or where it publishes, so a
    // silent default would point a real scan at the wrong subgraph or table.
    for (const key of Object.values(contextKeys)) {
      expect(() => resolveConfig(scopeWith({ [key]: undefined }))).toThrow(key);
    }
  });

  test('rejects an empty or blank string', () => {
    expect(() => resolveConfig(scopeWith({ [contextKeys.subgraphId]: '' }))).toThrow();
    expect(() => resolveConfig(scopeWith({ [contextKeys.subgraphId]: '   ' }))).toThrow();
  });

  test('trims a value, so a stray space cannot become part of an identifier', () => {
    const config = resolveConfig(scopeWith({ [contextKeys.subgraphId]: '  abc123  ' }));
    expect(config.subgraphId).toBe('abc123');
  });

  test('requires an account of exactly twelve digits', () => {
    // A truncated or mistyped account number synthesizes an asset bucket and a set
    // of ARNs for an account that does not exist, and the failure appears at deploy.
    for (const account of ['28986676305', '2898667630588', '28986676305a', 'default']) {
      expect(() => resolveConfig(scopeWith({ [contextKeys.account]: account }))).toThrow(
        contextKeys.account,
      );
    }
    expect(() =>
      resolveConfig(scopeWith({ [contextKeys.account]: '123456789012' })),
    ).not.toThrow();
  });

  test('requires a positive integer retention', () => {
    for (const value of [0, -1, 1.5, 'thirty']) {
      expect(() => resolveConfig(scopeWith({ [contextKeys.logRetentionDays]: value }))).toThrow(
        contextKeys.logRetentionDays,
      );
    }
  });

  test('accepts a numeric string, because -c always passes one', () => {
    const config = resolveConfig(scopeWith({ [contextKeys.dlqRetentionDays]: '7' }));
    expect(config.dlqRetentionDays).toBe(7);
  });
});
