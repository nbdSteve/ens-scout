import { Template } from 'aws-cdk-lib/assertions';

import {
  asList,
  eachPolicyStatement,
  environmentVariables,
  goInterfaceMethods,
  goSource,
  goStringConstants,
  requireConstant,
  synth,
} from './helpers';

/**
 * The fresh-check allowances live in this table.
 *
 * `internal/checkstore` is the authority for the per-client throttle, the upstream
 * budget, and the short-lived result cache, and `internal/dynamo.CheckStore` puts all
 * three in the publisher's own table rather than in a second one. That is a claim about
 * infrastructure, so it is asserted here: the table has to carry the check items under
 * the same string keys, expire them through the same TTL attribute, and need no
 * DynamoDB action the hand-written scanner role does not already allow.
 *
 * None of it deploys the read API. That is a later phase of docs/website-plan.md, and
 * `synth.test.ts` asserts its resource types are absent; what these tests protect is
 * the table it will use when it arrives, so a change that would strand the allowances
 * fails here instead of at run time.
 */
describe('the check-store items', () => {
  let template: Template;

  beforeAll(() => {
    template = synth().template;
  });

  test('share the publisher table rather than needing a second one', () => {
    // internal/dynamo.CheckStore takes a table name and writes CHECKRATE# and
    // CHECKRESULT# partitions into it. A second table here would be a second thing to
    // provision, tag, alarm on, and pay for, and nothing in the check path needs one:
    // the partition prefixes cannot collide with a snapshot key.
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
  });

  test('are addressed by the string keys internal/dynamo names', () => {
    // internal/dynamo/check.go writes its keys through the same attrPartition and
    // attrSort constants item.go declares, so this reads those constants rather than
    // repeating them. Both are strings because every check key is one: a rate partition
    // is a prefix and a hash, and a rate sort key is a window start in seconds written
    // as text.
    const constants = goStringConstants(goSource('internal/dynamo/item.go'));
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      AttributeDefinitions: [
        { AttributeName: requireConstant(constants, 'attrPartition'), AttributeType: 'S' },
        { AttributeName: requireConstant(constants, 'attrSort'), AttributeType: 'S' },
      ],
    });
  });

  test('expire through the TTL attribute the check store writes', () => {
    // A counter and a cached answer are both bounded by an expiry the store writes and
    // DynamoDB sweeps. Without TTL enabled on this exact attribute every counter and
    // every cached body would stay for good: the table would grow without bound, and
    // nothing would fail while it did, because a lapsed window is addressed by nothing
    // and a lapsed cache entry is refused on read. This is the failure that has to be
    // caught here rather than in production.
    const constants = goStringConstants(goSource('internal/dynamo/item.go'));
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: {
        AttributeName: requireConstant(constants, 'attrExpiresAt'),
        Enabled: true,
      },
    });
  });

  test('need no DynamoDB action the scanner role does not already allow', () => {
    // internal/dynamo.CheckAPI declares one method per action the check store calls,
    // and it is a subset of API on purpose, so a deployment that serves the read API
    // from this role needs no wider policy. Deriving both sets from the Go source is
    // what makes a method added to CheckAPI - a DeleteItem instead of an expiry, say -
    // fail here rather than deploy and then refuse every charge with AccessDenied.
    const publisher = goInterfaceMethods(goSource('internal/dynamo/store.go'), 'API');
    const check = goInterfaceMethods(goSource('internal/dynamo/check.go'), 'CheckAPI');
    expect(check.length).toBeGreaterThan(0);
    for (const method of check) {
      expect(publisher).toContain(method);
    }

    const granted = new Set(
      eachPolicyStatement(template)
        .filter((statement) => statement.Effect === 'Allow')
        .flatMap((statement) => asList(statement.Action))
        .filter((action): action is string => typeof action === 'string'),
    );
    for (const method of check) {
      expect(granted).toContain(`dynamodb:${method}`);
    }
  });
});

describe('the check client secret', () => {
  let template: Template;
  let variableName: string;

  beforeAll(() => {
    template = synth().template;
    variableName = requireConstant(
      goStringConstants(goSource('internal/api/checkconfig.go')),
      'EnvCheckClientSecret',
    );
  });

  test('is not configured by this stack, which serves no read API yet', () => {
    // The secret keys the client identity, so it has to be stable across instances and
    // therefore configured rather than minted at cold start. It belongs to the read
    // API's own function, which this stack does not define. Setting it on the scanner
    // would be a credential in the environment of a function that never reads one.
    expect(Object.keys(environmentVariables(template))).not.toContain(variableName);
  });

  test('adds no second place a credential is materialized', () => {
    // graph-credential.test.ts asserts the one dynamic reference this template holds.
    // This is the other half: whatever supplies the check secret later must not put a
    // second resolved credential into a template, because the places a template puts a
    // string are descriptions, tags, and alarm text.
    const rendered = JSON.stringify(template.toJSON());
    expect(rendered).not.toContain(variableName);
    expect(rendered.split('{{resolve:secretsmanager:').length - 1).toBe(1);
  });
});
