import { Construct } from 'constructs';
import { Duration } from 'aws-cdk-lib';

/**
 * Context keys. Every deployment-specific value is read from CDK context rather
 * than from the environment or a checked-in credential, so `cdk.json` records
 * what is deployed and an operator can override any of it with `-c key=value`.
 *
 * No key here holds a secret. The Graph API key is named indirectly, by the
 * Secrets Manager secret that holds it, so its value never enters the repository,
 * the context, or the synthesized template.
 *
 * The account, hosted-zone ID, and certificate ARN are the deployment identifiers
 * `cdk.json` deliberately does not commit. See the placeholder constants below.
 */
export const contextKeys = {
  environmentName: 'ens-scout:environmentName',
  account: 'ens-scout:account',
  region: 'ens-scout:region',
  subgraphId: 'ens-scout:subgraphId',
  graphApiKeySecretName: 'ens-scout:graphApiKeySecretName',
  graphApiKeySecretField: 'ens-scout:graphApiKeySecretField',
  siteDomainName: 'ens-scout:siteDomainName',
  siteHostedZoneName: 'ens-scout:siteHostedZoneName',
  siteHostedZoneId: 'ens-scout:siteHostedZoneId',
  siteCertificateArn: 'ens-scout:siteCertificateArn',
  snapshotTtlAttribute: 'ens-scout:snapshotTtlAttribute',
  logRetentionDays: 'ens-scout:logRetentionDays',
  dlqRetentionDays: 'ens-scout:dlqRetentionDays',
} as const;

/**
 * ScanTuning mirrors the `ENS_SCAN_*` settings `internal/scanner.LoadConfig`
 * reads. Every value here has a default and a ceiling in that package, so a value
 * this file sets is validated again at cold start; these are the deliberate
 * deployment choices rather than the library defaults.
 */
export interface ScanTuning {
  /** Bounded concurrency for the Graph phase, `ENS_SCAN_WORKERS`. */
  readonly workers: number;
  /** Labels per `name_in` query, `ENS_SCAN_BATCH_SIZE`. */
  readonly batchSize: number;
  /** Transient-failure retries per request, `ENS_SCAN_HTTP_RETRIES`. */
  readonly httpRetries: number;
  /** Per-request timeout, `ENS_SCAN_REQUEST_TIMEOUT_SECONDS`. */
  readonly requestTimeout: Duration;
  /** Ceiling on the Graph phase alone, `ENS_SCAN_BUDGET_SECONDS`. */
  readonly scanBudget: Duration;
  /** Attempts to read the snapshot being merged forward, `ENS_SCAN_PREVIOUS_READ_ATTEMPTS`. */
  readonly previousReadAttempts: number;
}

/**
 * Config is the resolved deployment configuration.
 */
export interface Config {
  readonly environmentName: string;
  readonly account: string;
  readonly region: string;
  readonly subgraphId: string;
  readonly graphApiKeySecretName: string;
  readonly graphApiKeySecretField: string;
  /** The public alternate name served by the CloudFront distribution. */
  readonly siteDomainName: string;
  /** The existing public Route 53 zone containing `siteDomainName`. */
  readonly siteHostedZoneName: string;
  /** The existing public Route 53 zone ID; supplied by the production environment. */
  readonly siteHostedZoneId: string;
  /** The existing us-east-1 ACM viewer certificate; supplied by the production environment. */
  readonly siteCertificateArn: string;
  /**
   * The DynamoDB TTL attribute. It must match `attrExpiresAt` in
   * `internal/dynamo`, or a superseded snapshot's chunks are never removed.
   */
  readonly snapshotTtlAttribute: string;
  readonly logRetentionDays: number;
  readonly dlqRetentionDays: number;
  readonly scanTuning: ScanTuning;
}

/**
 * defaultScanTuning is the tuning the scheduled publisher runs with.
 *
 * The batch size and worker count come from the query budget recorded in
 * `docs/website-plan.md`: 6,573 three- and four-letter candidates are 66 requests
 * at a batch size of 100, and four workers keep that inside the Graph allowance
 * while finishing well within the scan budget.
 *
 * The scan budget bounds the Graph phase alone. `functionTimeout` below leaves the
 * rest of the invocation for serialization, the chunk write, the read-back, the
 * pointer write, and the retention pass, so a scan that overruns is abandoned
 * before it can eat the time its own snapshot needs to be published.
 */
export const defaultScanTuning: ScanTuning = {
  workers: 4,
  batchSize: 100,
  httpRetries: 3,
  requestTimeout: Duration.seconds(30),
  scanBudget: Duration.minutes(9),
  previousReadAttempts: 3,
};

/**
 * Safe deployment-specific stand-ins committed for credential-free synthesis.
 *
 * The production workflow supplies the real account, hosted-zone ID, and certificate
 * ARN. Keeping shaped placeholders here lets a clean clone resolve and test the whole
 * stack while ensuring an unqualified deployment cannot land in the production
 * account or manage its DNS.
 */
export const placeholderAccount = '000000000000';
export const placeholderHostedZoneId = 'Z00000000000000000000';
export const placeholderCertificateArn =
  `arn:aws:acm:us-east-1:${placeholderAccount}:certificate/00000000-0000-0000-0000-000000000000`;

/**
 * functionTimeout is the Lambda timeout.
 *
 * It exceeds `defaultScanTuning.scanBudget` by the publication margin described
 * there, and stays under the two hours `internal/scanner.abandonedAfter` waits
 * before a later run may reclaim a staged chunk set, so a reclaim can never expire
 * chunks a live invocation is still writing.
 */
export const functionTimeout = Duration.minutes(13);

/**
 * resolveConfig reads the configuration from CDK context.
 *
 * It fails on a missing or malformed value instead of substituting one, because
 * every key here changes what a scheduled scan queries or where it publishes, and
 * a silent default would put a real scan against the wrong subgraph or table.
 */
export function resolveConfig(scope: Construct): Config {
  const account = requireDigits(scope, contextKeys.account, 12);
  const siteDomainName = requireDomainName(scope, contextKeys.siteDomainName);
  const siteHostedZoneName = requireDomainName(scope, contextKeys.siteHostedZoneName);
  if (!siteDomainName.endsWith(`.${siteHostedZoneName}`)) {
    throw new Error(
      `context key ${contextKeys.siteDomainName} must name a subdomain of ${contextKeys.siteHostedZoneName}`,
    );
  }

  return {
    environmentName: requireString(scope, contextKeys.environmentName),
    account,
    region: requireString(scope, contextKeys.region),
    subgraphId: requireString(scope, contextKeys.subgraphId),
    graphApiKeySecretName: requireString(scope, contextKeys.graphApiKeySecretName),
    graphApiKeySecretField: requireString(scope, contextKeys.graphApiKeySecretField),
    siteDomainName,
    siteHostedZoneName,
    siteHostedZoneId: requireHostedZoneId(scope, contextKeys.siteHostedZoneId),
    siteCertificateArn: requireCertificateArn(scope, contextKeys.siteCertificateArn, account),
    snapshotTtlAttribute: requireString(scope, contextKeys.snapshotTtlAttribute),
    logRetentionDays: requireNumber(scope, contextKeys.logRetentionDays),
    dlqRetentionDays: requireNumber(scope, contextKeys.dlqRetentionDays),
    scanTuning: defaultScanTuning,
  };
}

function requireString(scope: Construct, key: string): string {
  const value = scope.node.tryGetContext(key);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`context key ${key} must be a non-empty string`);
  }
  return value.trim();
}

function requireNumber(scope: Construct, key: string): number {
  const value = scope.node.tryGetContext(key);
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`context key ${key} must be a positive integer`);
  }
  return parsed;
}

function requireDigits(scope: Construct, key: string, digits: number): string {
  const value = requireString(scope, key);
  if (!new RegExp(`^[0-9]{${digits}}$`).test(value)) {
    throw new Error(`context key ${key} must be exactly ${digits} digits`);
  }
  return value;
}

function requireDomainName(scope: Construct, key: string): string {
  const value = requireString(scope, key);
  const labels = value.split('.');
  if (
    value.length > 253 ||
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  ) {
    throw new Error(`context key ${key} must be a lowercase DNS name`);
  }
  return value;
}

function requireHostedZoneId(scope: Construct, key: string): string {
  const value = requireString(scope, key);
  if (!/^Z[A-Z0-9]{10,31}$/.test(value)) {
    throw new Error(`context key ${key} must be a Route 53 hosted-zone ID`);
  }
  return value;
}

function requireCertificateArn(scope: Construct, key: string, account: string): string {
  const value = requireString(scope, key);
  const certificateId =
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  if (!new RegExp(`^arn:aws:acm:us-east-1:${account}:certificate/${certificateId}$`).test(value)) {
    throw new Error(
      `context key ${key} must be a us-east-1 ACM certificate ARN in the configured account`,
    );
  }
  return value;
}
