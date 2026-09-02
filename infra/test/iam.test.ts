import { Match, Template } from 'aws-cdk-lib/assertions';

import { asList, eachPolicyStatement, synth } from './helpers';

describe('the scanner role', () => {
  let template: Template;

  beforeAll(() => {
    template = synth().template;
  });

  test('is the only role in the stack', () => {
    // A second role means something added a helper it did not declare - the
    // log-retention custom resource is the usual one - and that helper's privileges
    // are then outside every assertion below.
    template.resourceCountIs('AWS::IAM::Role', 1);
    template.resourceCountIs('AWS::IAM::Policy', 1);
  });

  test('is assumable only by Lambda', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
          },
        ],
      },
    });
  });

  test('carries no managed policy', () => {
    // AWSLambdaBasicExecutionRole would add logs:CreateLogGroup on every group in
    // the account, which is exactly what declaring the group avoids.
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.absent(),
    });
  });

  test('writes to the declared log group and cannot create another', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          {
            Sid: 'WriteScannerLogs',
            Effect: 'Allow',
            Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('^ScannerLogGroup'), 'Arn'] },
          },
        ]),
      },
    });
    const granted = grantedActions(template);
    expect(granted).not.toContain('logs:CreateLogGroup');
    expect(granted).not.toContain('logs:PutRetentionPolicy');
    expect(granted).not.toContain('logs:DeleteLogGroup');
  });

  test('holds exactly the five DynamoDB calls internal/dynamo makes', () => {
    // grantReadWriteData would also add DeleteItem, Scan, the stream actions, and an
    // index wildcard for a table that has no index. The publisher never deletes an
    // item: a superseded snapshot is expired with a TTL, which is an UpdateItem.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          {
            Sid: 'PublishSnapshots',
            Effect: 'Allow',
            Action: [
              'dynamodb:BatchWriteItem',
              'dynamodb:GetItem',
              'dynamodb:PutItem',
              'dynamodb:Query',
              'dynamodb:UpdateItem',
            ],
            Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('^SnapshotTable'), 'Arn'] },
          },
        ]),
      },
    });
    const dynamoActions = grantedActions(template).filter((action) =>
      action.startsWith('dynamodb:'),
    );
    expect(dynamoActions.sort()).toEqual([
      'dynamodb:BatchWriteItem',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
      'dynamodb:UpdateItem',
    ]);
  });

  test('cannot write to the undelivered-event queue, because EventBridge does', () => {
    // sqs:SendMessage was an implicit grant CDK added for the function-level
    // dead-letter queue, which no longer exists. EventBridge writes to that queue
    // under the queue's own resource policy, so a grant here would be privilege
    // nothing uses.
    const sqsActions = grantedActions(template).filter((action) => action.startsWith('sqs:'));
    expect(sqsActions).toEqual([]);
  });

  test('cannot read the secret, because CloudFormation resolves it', () => {
    // THEGRAPH_API_KEY reaches the function as a CloudFormation dynamic reference,
    // which the deployment resolves with the deployer's credentials before the
    // function exists. A GetSecretValue grant here would be privilege nothing uses,
    // and it would let the running function read the credential store directly.
    const granted = grantedActions(template);
    expect(granted.filter((action) => action.startsWith('secretsmanager:'))).toEqual([]);
    expect(granted.filter((action) => action.startsWith('kms:'))).toEqual([]);
  });

  test('grants nothing on a wildcard resource', () => {
    for (const statement of allowStatements(template)) {
      for (const resource of asList(statement.Resource)) {
        expect(resource).not.toBe('*');
      }
    }
  });

  test('grants no wildcard action', () => {
    for (const action of grantedActions(template)) {
      expect(action).not.toContain('*');
    }
  });

  test('grants nothing at all outside the two services it uses', () => {
    // The catch-all: a future edit that adds a permission also has to add its
    // service here, which is the moment to decide the grant is least privilege.
    // Secrets Manager is deliberately not one of the two, which the test above says.
    const services = new Set(grantedActions(template).map((action) => action.split(':')[0]));
    expect([...services].sort()).toEqual(['dynamodb', 'logs']);
  });
});

describe('the resource policies', () => {
  let template: Template;

  beforeAll(() => {
    template = synth().template;
  });

  test('open the undelivered-event queue only to the two scan rules', () => {
    const statements = resourcePolicyStatements(template, 'AWS::SQS::QueuePolicy').filter(
      (statement) => statement.Effect === 'Allow',
    );
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      expect(statement.Action).toBe('sqs:SendMessage');
      expect(statement.Principal).toEqual({ Service: 'events.amazonaws.com' });
      // Without the source condition any EventBridge rule in any account could fill
      // the queue the failure alarm watches.
      expect(statement.Condition).toHaveProperty('ArnEquals');
    }
  });

  test('use a wildcard action only to deny, never to allow', () => {
    // enforceSSL writes a Deny on the whole service action set, which is the one
    // place a wildcard belongs: a Deny that named fewer actions would enforce less.
    for (const type of ['AWS::SQS::QueuePolicy', 'AWS::SNS::TopicPolicy'] as const) {
      for (const statement of resourcePolicyStatements(template, type)) {
        for (const action of asList(statement.Action)) {
          if (typeof action === 'string' && action.includes('*')) {
            expect(statement.Effect).toBe('Deny');
          }
        }
      }
    }
  });

  test('refuse unencrypted transport on the queue and the topic', () => {
    for (const type of ['AWS::SQS::QueuePolicy', 'AWS::SNS::TopicPolicy'] as const) {
      const denies = resourcePolicyStatements(template, type).filter(
        (statement) => statement.Effect === 'Deny',
      );
      expect(denies.length).toBeGreaterThan(0);
      for (const statement of denies) {
        expect(statement.Condition).toEqual({ Bool: { 'aws:SecureTransport': 'false' } });
      }
    }
  });
});

/** allowStatements is every Allow statement of every identity policy in the stack. */
function allowStatements(template: Template): Array<Record<string, unknown>> {
  return eachPolicyStatement(template).filter((statement) => statement.Effect === 'Allow');
}

/** grantedActions is every action any identity policy in the stack allows. */
function grantedActions(template: Template): string[] {
  const actions: string[] = [];
  for (const statement of allowStatements(template)) {
    for (const action of asList(statement.Action)) {
      if (typeof action === 'string') {
        actions.push(action);
      }
    }
  }
  // sts:AssumeRole comes from the trust policy, which is not a grant to the function.
  return actions.filter((action) => action !== 'sts:AssumeRole');
}

function resourcePolicyStatements(
  template: Template,
  type: 'AWS::SQS::QueuePolicy' | 'AWS::SNS::TopicPolicy',
): Array<Record<string, unknown>> {
  const statements: Array<Record<string, unknown>> = [];
  for (const resource of Object.values(template.findResources(type))) {
    const document = (resource.Properties as { PolicyDocument: { Statement: unknown[] } })
      .PolicyDocument;
    for (const statement of document.Statement) {
      statements.push(statement as Record<string, unknown>);
    }
  }
  return statements;
}
