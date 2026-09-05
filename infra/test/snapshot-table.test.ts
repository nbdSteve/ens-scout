import { Match, Template } from 'aws-cdk-lib/assertions';

import { goSource, goStringConstants, requireConstant, synth } from './helpers';

describe('the snapshot table', () => {
  let template: Template;

  beforeAll(() => {
    template = synth().template;
  });

  test('is one table with the key layout internal/snapshot documents', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
    });
  });

  test('declares the key and TTL attributes internal/dynamo writes', () => {
    // These three names belong to internal/dynamo, not to this stack. A table that
    // disagrees deploys cleanly and then fails on the first write, so the
    // assertion reads the Go definitions rather than repeating them.
    const constants = goStringConstants(goSource('internal/dynamo/item.go'));
    const partition = requireConstant(constants, 'attrPartition');
    const sort = requireConstant(constants, 'attrSort');
    const expiresAt = requireConstant(constants, 'attrExpiresAt');

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: partition, KeyType: 'HASH' },
        { AttributeName: sort, KeyType: 'RANGE' },
      ],
      TimeToLiveSpecification: { AttributeName: expiresAt, Enabled: true },
    });
  });

  test('uses on-demand capacity', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      ProvisionedThroughput: Match.absent(),
    });
  });

  test('has no secondary index, so no policy needs an index wildcard', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.absent(),
      LocalSecondaryIndexes: Match.absent(),
    });
  });

  test('is encrypted, recoverable, and protected from deletion', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      SSESpecification: { SSEEnabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      DeletionProtectionEnabled: true,
    });
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  test('does not enable streams, which nothing reads', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      StreamSpecification: Match.absent(),
    });
  });
});
