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
 * The public read API now charges these items. These assertions tie its table and
 * secret to the same contracts the Go package enforces.
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

  test('is generated once for the API and never placed on the scanner', () => {
    const apiVariables = environmentVariables(template, variableName);
    expect(apiVariables).toHaveProperty(variableName);
    expect(JSON.stringify(apiVariables[variableName])).toContain('{{resolve:secretsmanager:');
    expect(Object.keys(environmentVariables(template))).not.toContain(variableName);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Description: 'Keys the irreversible fresh-check client identity',
      GenerateSecretString: {
        ExcludePunctuation: true,
        PasswordLength: 64,
      },
    });
  });

  test('is materialized only in the API environment and never in an output', () => {
    const rendered = JSON.stringify(template.toJSON());
    expect(rendered.split(variableName).length - 1).toBe(1);
    expect(JSON.stringify(template.toJSON().Outputs ?? {})).not.toContain(variableName);
  });
});
