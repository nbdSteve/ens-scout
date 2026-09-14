import { Match, Template } from 'aws-cdk-lib/assertions';

import { synth } from './helpers';

describe('the public website', () => {
  let template: Template;

  beforeAll(() => {
    template = synth().template;
  });

  test('keeps the retained S3 origin private behind signed OAC reads', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    const bucket = Object.values(template.findResources('AWS::S3::Bucket'))[0];
    expect(bucket.DeletionPolicy).toBe('Retain');
    expect(bucket.UpdateReplacePolicy).toBe('Retain');

    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: {
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      },
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:GetObject',
            Effect: 'Allow',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Condition: { StringEquals: { 'AWS:SourceArn': Match.anyValue() } },
          }),
        ]),
      },
    });
  });

  test('uses one generated hostname for static files and every API route', () => {
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        Aliases: Match.absent(),
        ViewerCertificate: Match.absent(),
        DefaultRootObject: 'index.html',
        Origins: Match.arrayWith([
          Match.objectLike({ S3OriginConfig: { OriginAccessIdentity: '' } }),
          Match.objectLike({ CustomOriginConfig: { OriginProtocolPolicy: 'https-only' } }),
        ]),
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: 'assets/*' }),
          Match.objectLike({ PathPattern: 'api/snapshot' }),
          Match.objectLike({ PathPattern: 'api/snapshot/meta' }),
          Match.objectLike({ PathPattern: 'api/*' }),
          Match.objectLike({ PathPattern: 'health' }),
        ]),
        CustomErrorResponses: Match.absent(),
      },
    });
    expect(template.toJSON().Outputs?.PublicSiteUrl).toEqual({
      Description: 'Generated HTTPS URL for the public ENS Scout website',
      Value: {
        'Fn::Join': [
          '',
          [
            'https://',
            {
              'Fn::GetAtt': [expect.stringMatching(/^PublicSiteDistribution/), 'DomainName'],
            },
          ],
        ],
      },
    });
  });

  test('assigns separate bounded cache policies to shell, assets, snapshots, and mutations', () => {
    const policies = Object.values(template.findResources('AWS::CloudFront::CachePolicy')).map(
      (resource) =>
        (
          resource.Properties as {
            CachePolicyConfig: {
              Comment: string;
              MinTTL: number;
              DefaultTTL: number;
              MaxTTL: number;
              ParametersInCacheKeyAndForwardedToOrigin: {
                EnableAcceptEncodingBrotli: boolean;
                EnableAcceptEncodingGzip: boolean;
              };
            };
          }
        ).CachePolicyConfig,
    );
    expect(policies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Comment: 'The HTML shell and unhashed static files always revalidate',
          MinTTL: 0,
          DefaultTTL: 0,
          // A zero maximum makes this a disabled cache policy, which CloudFront
          // rejects when either Accept-Encoding cache-key flag is enabled. The S3
          // object metadata below is what requires every request to revalidate.
          MaxTTL: 1,
          ParametersInCacheKeyAndForwardedToOrigin: expect.objectContaining({
            EnableAcceptEncodingBrotli: true,
            EnableAcceptEncodingGzip: true,
          }),
        }),
        expect.objectContaining({
          Comment: 'Vite content-hashed assets are immutable',
          MinTTL: 31_536_000,
          DefaultTTL: 31_536_000,
          MaxTTL: 31_536_000,
        }),
        expect.objectContaining({
          Comment: 'Snapshot reads honor the API cache lifetime within a one-hour ceiling',
          MinTTL: 0,
          DefaultTTL: 60,
          MaxTTL: 3600,
        }),
      ]),
    );

    const distribution = Object.values(
      template.findResources('AWS::CloudFront::Distribution'),
    )[0].Properties as {
      DistributionConfig: {
        CacheBehaviors: Array<{ PathPattern: string; CachePolicyId: unknown }>;
      };
    };
    const mutation = distribution.DistributionConfig.CacheBehaviors.find(
      (behavior) => behavior.PathPattern === 'api/*',
    );
    expect(mutation?.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
  });

  test('publishes the shell and hashed assets with matching S3 metadata', () => {
    template.resourceCountIs('Custom::CDKBucketDeployment', 2);
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      Prune: true,
      RetainOnDelete: true,
      SystemMetadata: { 'cache-control': 'no-cache, must-revalidate' },
      OutputObjectKeys: false,
    });
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      DestinationBucketKeyPrefix: 'assets',
      Prune: false,
      RetainOnDelete: true,
      SystemMetadata: { 'cache-control': 'public, max-age=31536000, immutable' },
      OutputObjectKeys: false,
    });
  });

  test('associates the SPA rewrite only with the shell behavior', () => {
    template.resourceCountIs('AWS::CloudFront::Function', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultCacheBehavior: {
          FunctionAssociations: [
            {
              EventType: 'viewer-request',
              FunctionARN: Match.anyValue(),
            },
          ],
        },
        CacheBehaviors: Match.not(
          Match.arrayWith([Match.objectLike({ FunctionAssociations: Match.anyValue() })]),
        ),
      },
    });
  });
});
