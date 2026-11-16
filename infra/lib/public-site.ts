import {
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
} from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

import { Config } from './config';
import { spaRewriteCode } from './spa';

export const apiHandler = 'bootstrap';
export const apiTimeout = Duration.seconds(15);
export const apiIntegrationTimeout = Duration.seconds(16);
export const apiReservedConcurrency = 4;
// A buffered Lambda response is limited to 6 MiB, and the API Gateway response
// envelope JSON-escapes the snapshot body. Keep the application's raw-body ceiling
// below that transport limit so it can return its fixed snapshot_too_large failure
// instead of being truncated by the integration.
export const apiMaxBodyBytes = 4 * 1024 * 1024;
export const originSecretEnvironment = 'ENS_API_ORIGIN_SECRET';
export const originSecretHeader = 'X-Ens-Scout-Origin-Secret';
export const viewerAddressHeader = 'CloudFront-Viewer-Address';

export interface PublicSiteProps {
  readonly config: Config;
  /** The existing public hosted zone ID: the context value, or a deferred parameter. */
  readonly siteHostedZoneId: string;
  /** The existing us-east-1 viewer certificate ARN: the context value, or a deferred parameter. */
  readonly siteCertificateArn: string;
  readonly snapshotTable: dynamodb.Table;
  readonly apiCode: lambda.Code;
  readonly websiteSource: s3deploy.ISource;
  readonly websiteAssetsSource: s3deploy.ISource;
}

/**
 * PublicSite is the one-origin website: a private S3 origin for the Vite build
 * and one HTTP API origin for internal/api, both behind one CloudFront distribution.
 * Its generated hostname remains valid beside the production Route 53 alias.
 */
export class PublicSite extends Construct {
  readonly apiFunction: lambda.Function;
  readonly apiLogGroup: logs.LogGroup;
  readonly httpApi: apigwv2.HttpApi;
  readonly websiteBucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly publicUrl: string;

  constructor(scope: Construct, id: string, props: PublicSiteProps) {
    super(scope, id);

    const checkClientSecret = this.generatedSecret(
      'CheckClientSecret',
      'Keys the irreversible fresh-check client identity',
    );
    const originSecret = this.generatedSecret(
      'OriginSecret',
      'Authenticates the CloudFront origin request to the read API',
    );
    const graphApiKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'GraphApiKeySecret',
      props.config.graphApiKeySecretName,
    );
    const graphApiKey = graphApiKeySecret
      .secretValueFromJson(props.config.graphApiKeySecretField)
      .unsafeUnwrap();
    const checkClientKey = checkClientSecret.secretValue.unsafeUnwrap();
    const originKey = originSecret.secretValue.unsafeUnwrap();

    this.apiLogGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      retention: retentionDays(props.config.logRetentionDays),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const apiRole = this.createApiRole(props.snapshotTable);
    this.apiFunction = new lambda.Function(this, 'ApiFunction', {
      description: 'Serves the published ENS snapshot and bounded fresh checks',
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: apiHandler,
      code: props.apiCode,
      role: apiRole,
      logGroup: this.apiLogGroup,
      timeout: apiTimeout,
      memorySize: 512,
      reservedConcurrentExecutions: apiReservedConcurrency,
      environment: {
        ENS_SNAPSHOT_TABLE: props.snapshotTable.tableName,
        ENS_SUBGRAPH_ID: props.config.subgraphId,
        ENS_API_MAX_BODY_BYTES: String(apiMaxBodyBytes),
        THEGRAPH_API_KEY: graphApiKey,
        ENS_API_CHECK_CLIENT_SECRET: checkClientKey,
        [originSecretEnvironment]: originKey,
      },
    });

    const integration = new integrations.HttpLambdaIntegration(
      'ApiIntegration',
      this.apiFunction,
      {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
        timeout: apiIntegrationTimeout,
        // The $default route invokes an execute-api ARN ending in /*/*, without
        // the resource-path segment used by named routes.
        scopePermissionToRoute: true,
      },
    );
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `ens-scout-${props.config.environmentName}`,
      description: 'Private origin for the ENS Scout CloudFront distribution',
      defaultIntegration: integration,
      createDefaultStage: true,
    });

    this.websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const staticOrigin = origins.S3BucketOrigin.withOriginAccessControl(
      this.websiteBucket as s3.IBucket,
    );
    const apiDomain = Fn.select(2, Fn.split('/', this.httpApi.apiEndpoint));
    const apiOrigin = new origins.HttpOrigin(apiDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      readTimeout: Duration.seconds(20),
      keepaliveTimeout: Duration.seconds(5),
      customHeaders: { [originSecretHeader]: originKey },
    });

    const shellCache = new cloudfront.CachePolicy(this, 'HtmlShellCachePolicy', {
      comment: 'The HTML shell and unhashed static files always revalidate',
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(0),
      // CloudFront rejects Accept-Encoding cache-key settings when all three TTLs
      // are zero. The shell objects carry `no-cache, must-revalidate`, so the
      // non-zero ceiling makes the policy valid without letting a request skip
      // revalidation; it only bounds an object whose metadata was somehow absent.
      maxTtl: Duration.seconds(1),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
    });
    const immutableCache = new cloudfront.CachePolicy(this, 'ImmutableAssetCachePolicy', {
      comment: 'Vite content-hashed assets are immutable',
      minTtl: Duration.days(365),
      defaultTtl: Duration.days(365),
      maxTtl: Duration.days(365),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
    });
    const snapshotCache = new cloudfront.CachePolicy(this, 'SnapshotCachePolicy', {
      comment: 'Snapshot reads honor the API cache lifetime within a one-hour ceiling',
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(60),
      maxTtl: Duration.hours(1),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
    });
    const apiRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'ApiRequestPolicy', {
      comment: 'Only headers used by internal/api plus CloudFront viewer identity',
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
        'Origin',
        'If-None-Match',
        'If-Modified-Since',
        'Content-Type',
        'Access-Control-Request-Method',
        'Access-Control-Request-Headers',
        viewerAddressHeader,
      ),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
    });

    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      comment: 'Rewrite extensionless frontend routes to index.html',
      code: cloudfront.FunctionCode.fromInline(spaRewriteCode),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });
    const staticBehavior: cloudfront.BehaviorOptions = {
      origin: staticOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
      cachePolicy: shellCache,
      compress: true,
      functionAssociations: [
        {
          function: spaRewrite,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        },
      ],
    };
    const snapshotBehavior: cloudfront.BehaviorOptions = {
      origin: apiOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
      cachePolicy: snapshotCache,
      originRequestPolicy: apiRequestPolicy,
      compress: true,
    };
    const dynamicApiBehavior: cloudfront.BehaviorOptions = {
      origin: apiOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: apiRequestPolicy,
      compress: true,
    };

    const viewerCertificate = acm.Certificate.fromCertificateArn(
      this,
      'ViewerCertificate',
      props.siteCertificateArn,
    );
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `ENS Scout ${props.config.environmentName}`,
      domainNames: [props.config.siteDomainName],
      certificate: viewerCertificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultRootObject: 'index.html',
      defaultBehavior: staticBehavior,
      additionalBehaviors: {
        'assets/*': {
          origin: staticOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          cachePolicy: immutableCache,
          compress: true,
        },
        'api/snapshot': snapshotBehavior,
        'api/snapshot/meta': snapshotBehavior,
        'api/*': dynamicApiBehavior,
        health: {
          ...dynamicApiBehavior,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        },
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.siteHostedZoneId,
      zoneName: props.config.siteHostedZoneName,
    });
    const recordName = props.config.siteDomainName.slice(
      0,
      -(props.config.siteHostedZoneName.length + 1),
    );
    new route53.ARecord(this, 'AliasA', {
      zone: hostedZone,
      recordName,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(this.distribution),
      ),
    });
    new route53.AaaaRecord(this, 'AliasAAAA', {
      zone: hostedZone,
      recordName,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(this.distribution),
      ),
    });

    const deploymentLogGroup = new logs.LogGroup(this, 'WebsiteDeploymentLogGroup', {
      retention: retentionDays(props.config.logRetentionDays),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const deploymentRole = new iam.Role(this, 'WebsiteDeploymentRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Copies the tested ENS Scout web assets into the private origin bucket',
    });
    deploymentRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'WriteWebsiteDeploymentLogs',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [deploymentLogGroup.logGroupArn],
      }),
    );
    const shellDeployment = new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [props.websiteSource],
      destinationBucket: this.websiteBucket as s3.IBucket,
      prune: true,
      retainOnDelete: true,
      cacheControl: [s3deploy.CacheControl.noCache(), s3deploy.CacheControl.mustRevalidate()],
      logGroup: deploymentLogGroup,
      role: deploymentRole,
      outputObjectKeys: false,
    });
    const assetDeployment = new s3deploy.BucketDeployment(this, 'DeployWebsiteAssets', {
      sources: [props.websiteAssetsSource],
      destinationBucket: this.websiteBucket as s3.IBucket,
      destinationKeyPrefix: 'assets',
      prune: false,
      retainOnDelete: true,
      cacheControl: [
        s3deploy.CacheControl.setPublic(),
        s3deploy.CacheControl.maxAge(Duration.days(365)),
        s3deploy.CacheControl.immutable(),
      ],
      logGroup: deploymentLogGroup,
      role: deploymentRole,
      outputObjectKeys: false,
    });
    assetDeployment.node.addDependency(shellDeployment);

    this.publicUrl = `https://${this.distribution.distributionDomainName}`;
    new CfnOutput(Stack.of(this), 'PublicSiteUrl', {
      value: this.publicUrl,
      description: 'Generated HTTPS URL for the public ENS Scout website',
    });
  }

  private generatedSecret(id: string, description: string): secretsmanager.Secret {
    return new secretsmanager.Secret(this, id, {
      description,
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }

  private createApiRole(table: dynamodb.Table): iam.Role {
    const role = new iam.Role(this, 'ApiRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Reads ENS snapshots and writes only fresh-check allowance items',
    });
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'WriteApiLogs',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [this.apiLogGroup.logGroupArn],
      }),
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'ReadPublishedSnapshots',
        actions: ['dynamodb:GetItem', 'dynamodb:Query'],
        resources: [table.tableArn],
        conditions: {
          'ForAllValues:StringLike': {
            'dynamodb:LeadingKeys': ['META', 'SNAPSHOT#*'],
          },
        },
      }),
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'UseFreshCheckStore',
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
        resources: [table.tableArn],
        conditions: {
          'ForAllValues:StringLike': {
            'dynamodb:LeadingKeys': ['CHECKRATE#*', 'CHECKRESULT#*'],
          },
        },
      }),
    );
    return role;
  }
}

function retentionDays(days: number): logs.RetentionDays {
  return days as logs.RetentionDays;
}
