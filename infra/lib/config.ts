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
 */
export const contextKeys = {
  environmentName: 'ens-scout:environmentName',
  account: 'ens-scout:account',
  region: 'ens-scout:region',
  subgraphId: 'ens-scout:subgraphId',
  graphApiKeySecretName: 'ens-scout:graphApiKeySecretName',
  graphApiKeySecretField: 'ens-scout:graphApiKeySecretField',
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
  return {
    environmentName: requireString(scope, contextKeys.environmentName),
    account: requireDigits(scope, contextKeys.account, 12),
    region: requireString(scope, contextKeys.region),
    subgraphId: requireString(scope, contextKeys.subgraphId),
    graphApiKeySecretName: requireString(scope, contextKeys.graphApiKeySecretName),
    graphApiKeySecretField: requireString(scope, contextKeys.graphApiKeySecretField),
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
