import { Match, Template } from 'aws-cdk-lib/assertions';

import {
  apiHandler,
  apiIntegrationTimeout,
  apiMaxBodyBytes,
  apiReservedConcurrency,
  apiTimeout,
  originSecretEnvironment,
  originSecretHeader,
  viewerAddressHeader,
} from '../lib/public-site';
import {
  asList,
  environmentVariables,
  goInterfaceMethods,
  goSource,
  synth,
  testConfig,
} from './helpers';

describe('the production read API', () => {
  let template: Template;

  beforeAll(() => {
    template = synth().template;
  });

  test('packages one bounded Go function behind one HTTP API integration', () => {
    const functions = Object.values(template.findResources('AWS::Lambda::Function')).filter(
      (resource) => {
        const variables = (
          resource.Properties as { Environment?: { Variables?: Record<string, unknown> } }
        ).Environment?.Variables;
        return variables !== undefined && originSecretEnvironment in variables;
      },
    );
    expect(functions).toHaveLength(1);
    expect(functions[0].Properties).toEqual(
      expect.objectContaining({
        Runtime: 'provided.al2023',
        Architectures: ['arm64'],
        Handler: apiHandler,
        Timeout: apiTimeout.toSeconds(),
        MemorySize: 512,
        ReservedConcurrentExecutions: apiReservedConcurrency,
      }),
    );

    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.resourceCountIs('AWS::ApiGatewayV2::Integration', 1);
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 1);
    template.resourceCountIs('AWS::ApiGatewayV2::Stage', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
      IntegrationType: 'AWS_PROXY',
      PayloadFormatVersion: '2.0',
      TimeoutInMillis: apiIntegrationTimeout.toMilliseconds(),
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      AuthorizationType: 'NONE',
      RouteKey: '$default',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      AutoDeploy: true,
      StageName: '$default',
    });
    template.resourceCountIs('AWS::Lambda::Url', 0);
  });

  test('allows API Gateway to invoke the HTTP API default route ARN', () => {
    const permissions = Object.values(template.findResources('AWS::Lambda::Permission')).filter(
      (resource) => resource.Properties.Principal === 'apigateway.amazonaws.com',
    );
    expect(permissions).toHaveLength(1);
    expect(permissions[0].Properties).toEqual(
      expect.objectContaining({
        Action: 'lambda:InvokeFunction',
        FunctionName: {
          'Fn::GetAtt': [expect.stringMatching(/^PublicSiteApiFunction/), 'Arn'],
        },
      }),
    );
    const sourceArn = permissions[0].Properties.SourceArn as {
      'Fn::Join': [string, unknown[]];
    };
    expect(sourceArn['Fn::Join'][0]).toBe('');
    expect(sourceArn['Fn::Join'][1].at(-1)).toBe('/*/*');
    expect(sourceArn['Fn::Join'][1]).toContainEqual({
      Ref: expect.stringMatching(/^PublicSiteHttpApi/),
    });
  });

  test('passes only production wiring and a response bound below the integration ceiling', () => {
    const variables = environmentVariables(template, originSecretEnvironment);
    expect(Object.keys(variables).sort()).toEqual(
      [
        'ENS_API_CHECK_CLIENT_SECRET',
        'ENS_API_MAX_BODY_BYTES',
        originSecretEnvironment,
        'ENS_SNAPSHOT_TABLE',
        'ENS_SUBGRAPH_ID',
        'THEGRAPH_API_KEY',
      ].sort(),
    );
    expect(variables.ENS_SNAPSHOT_TABLE).toEqual({
      Ref: expect.stringMatching(/^SnapshotTable/),
    });
    expect(variables.ENS_SUBGRAPH_ID).toBe(testConfig.subgraphId);
    expect(variables.ENS_API_MAX_BODY_BYTES).toBe(String(apiMaxBodyBytes));
    expect(variables.ENS_API_ALLOWED_ORIGINS).toBeUndefined();
    expect(variables.ENS_SUBGRAPH_URL).toBeUndefined();
    for (const secret of [
      variables.THEGRAPH_API_KEY,
      variables.ENS_API_CHECK_CLIENT_SECRET,
      variables[originSecretEnvironment],
    ]) {
      expect(JSON.stringify(secret)).toContain('{{resolve:secretsmanager:');
    }
  });

  test('reads snapshots and writes only the check-store keyspaces', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies)
      .flatMap(
        (resource) =>
          (
            resource.Properties as {
              PolicyDocument: { Statement: Array<Record<string, unknown>> };
            }
          ).PolicyDocument.Statement,
      )
      .filter((statement) =>
        ['ReadPublishedSnapshots', 'UseFreshCheckStore'].includes(String(statement.Sid)),
      );
    expect(statements).toHaveLength(2);

    const read = statements.find((statement) => statement.Sid === 'ReadPublishedSnapshots')!;
    expect(asList(read.Action).sort()).toEqual(['dynamodb:GetItem', 'dynamodb:Query']);
    expect(read.Condition).toEqual({
      'ForAllValues:StringLike': {
        'dynamodb:LeadingKeys': ['META', 'SNAPSHOT#*'],
      },
    });

    const check = statements.find((statement) => statement.Sid === 'UseFreshCheckStore')!;
    const expected = goInterfaceMethods(goSource('internal/dynamo/check.go'), 'CheckAPI')
      .map((method) => `dynamodb:${method}`)
      .sort();
    expect(asList(check.Action).sort()).toEqual(expected);
    expect(check.Condition).toEqual({
      'ForAllValues:StringLike': {
        'dynamodb:LeadingKeys': ['CHECKRATE#*', 'CHECKRESULT#*'],
      },
    });
    expect(JSON.stringify(statements)).not.toContain('BatchWriteItem');
    expect(JSON.stringify(statements)).not.toContain('DeleteItem');
  });

  test('trusts the viewer identity only behind the generated origin token', () => {
    template.hasResourceProperties('AWS::CloudFront::OriginRequestPolicy', {
      OriginRequestPolicyConfig: {
        HeadersConfig: {
          HeaderBehavior: 'whitelist',
          Headers: Match.arrayWith([viewerAddressHeader]),
        },
      },
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        Origins: Match.arrayWith([
          Match.objectLike({
            OriginCustomHeaders: [
              {
                HeaderName: originSecretHeader,
                HeaderValue: Match.anyValue(),
              },
            ],
          }),
        ]),
      },
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Description: 'Authenticates the CloudFront origin request to the read API',
      GenerateSecretString: {
        ExcludePunctuation: true,
        PasswordLength: 64,
      },
    });
  });

  test('logs to its own bounded group and has no runtime secret-store grant', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ [originSecretEnvironment]: Match.anyValue() }) },
      LoggingConfig: { LogGroup: { Ref: Match.stringLikeRegexp('ApiLogGroup') } },
    });
    const policy = Object.values(template.findResources('AWS::IAM::Policy')).find((resource) =>
      JSON.stringify(resource).includes('ReadPublishedSnapshots'),
    );
    expect(policy).toBeDefined();
    const rendered = JSON.stringify(policy);
    expect(rendered).not.toContain('secretsmanager:');
    expect(rendered).not.toContain('kms:');
  });
});
