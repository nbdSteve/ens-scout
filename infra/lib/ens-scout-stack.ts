import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
} from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

import { Config, functionTimeout } from './config';
import { scanSchedules } from './schedules';

/**
 * The word list directory inside the deployed bundle.
 *
 * `scripts/bundle-scanner.js` copies `data/words/*.txt` to `data/words` in the
 * asset, and the AWS Lambda runtime unpacks an asset into `/var/task`. The path is
 * absolute rather than relative so the value does not depend on the runtime's
 * working directory.
 */
export const wordListDirectory = '/var/task/data/words';

/**
 * The handler name the `provided.al2023` runtime executes. It has to match the
 * binary `scripts/bundle-scanner.js` writes.
 */
export const scannerHandler = 'bootstrap';

export interface EnsScoutStackProps extends StackProps {
  readonly config: Config;

  /**
   * The scanner Lambda's code.
   *
   * It is injected rather than resolved here so a test can supply a fixed asset.
   * A freshly built Go binary would otherwise change the asset hash on every
   * machine, and a template assertion or a `cdk diff` would report a Lambda update
   * that is not one.
   */
  readonly scannerCode: lambda.Code;
}

/**
 * EnsScoutStack defines the scheduled ENS snapshot publisher.
 *
 * It provisions exactly what `internal/scanner` and `internal/dynamo` need and
 * nothing else: the single-table snapshot store, the Go scanner function, the two
 * offset schedules, the failure queue, and the alarms. The read API, the frontend
 * distribution, and the deployment pipeline are later phases and are deliberately
 * absent.
 *
 * Nothing here creates a Secrets Manager secret, an account, a role outside this
 * stack, a domain, or a certificate. The Graph API key is referenced through an
 * existing secret, so the credential is never in the repository, the CDK context,
 * or the synthesized template.
 */
export class EnsScoutStack extends Stack {
  readonly snapshotTable: dynamodb.Table;
  readonly scannerFunction: lambda.Function;
  readonly scannerLogGroup: logs.LogGroup;
  readonly failureQueue: sqs.Queue;
  readonly alarmTopic: sns.Topic;
  readonly scanRules: events.Rule[];

  constructor(scope: Construct, id: string, props: EnsScoutStackProps) {
    super(scope, id, props);
    const { config } = props;

    // The snapshot store. internal/snapshot owns the key layout and internal/dynamo
    // owns the attribute names; this table has to match both or the publisher writes
    // items nothing can read.
    //
    // On-demand capacity suits a workload that is idle between scans and then writes
    // a whole chunk set at once. The table is retained on stack deletion, and point
    // in time recovery is on, because it holds the only copy of every published
    // snapshot: a scan can be repeated, but only by spending the Graph budget again.
    this.snapshotTable = new dynamodb.Table(this, 'SnapshotTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: config.snapshotTtlAttribute,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
      deletionProtection: true,
    });

    // The failure queue. EventBridge invokes the function asynchronously, so an
    // invocation that never ran - a throttle, or a function that could not start -
    // lands here instead of disappearing. It is a record for an operator, not a
    // work queue: nothing consumes it, and the alarm below is what surfaces it.
    this.failureQueue = new sqs.Queue(this, 'ScanFailureQueue', {
      retentionPeriod: Duration.days(config.dlqRetentionDays),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // The log group is declared rather than left to the runtime, so its retention is
    // bounded from the first invocation and the function's role can be scoped to
    // this one group. A group the runtime creates on demand would need
    // logs:CreateLogGroup on a wildcard resource.
    this.scannerLogGroup = new logs.LogGroup(this, 'ScannerLogGroup', {
      retention: retentionDays(config.logRetentionDays),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const scannerRole = this.createScannerRole();
    this.scannerFunction = this.createScannerFunction(props, scannerRole);
    this.scanRules = this.createScanRules();
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: `ENS Scout ${config.environmentName} alarms`,
      enforceSSL: true,
    });
    this.createAlarms();

    Tags.of(this).add('Project', 'ens-scout');
    Tags.of(this).add('Environment', config.environmentName);

    this.declareOutputs(config);
  }

  /**
   * createScannerRole builds the function's role by hand.
   *
   * The managed AWSLambdaBasicExecutionRole policy is not used: it grants
   * logs:CreateLogGroup on every log group in the account, and the group already
   * exists here. Data-plane access is the five DynamoDB calls internal/dynamo's
   * `API` interface declares, on this table's ARN alone - not
   * `grantReadWriteData`, which would also add DeleteItem, Scan, the stream
   * actions, and an index wildcard the table has no index for.
   */
  private createScannerRole(): iam.Role {
    const role = new iam.Role(this, 'ScannerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Publishes ENS snapshots into the snapshot table',
    });

    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'WriteScannerLogs',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [this.scannerLogGroup.logGroupArn],
      }),
    );

    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'PublishSnapshots',
        actions: [
          // internal/dynamo/store.go: chunk writes, the pointer and staging reads
          // and writes, the chunk and staging queries, and the TTL update.
          'dynamodb:BatchWriteItem',
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:Query',
          'dynamodb:UpdateItem',
        ],
        resources: [this.snapshotTable.tableArn],
      }),
    );

    return role;
  }

  private createScannerFunction(props: EnsScoutStackProps, role: iam.Role): lambda.Function {
    const { config } = props;

    // The secret is referenced, never created: the credential is provisioned out of
    // band and this stack must not be able to overwrite it. `secretValueFromJson`
    // resolves to a CloudFormation dynamic reference, so the synthesized template
    // carries a pointer to the secret rather than its value, and CloudFormation
    // substitutes the key at deploy time. `unsafeUnwrap` is the explicit opt-in
    // that turns that reference into the environment value; the resolved key then
    // lives in the function's encrypted configuration, which is the "encrypted
    // Lambda setting" docs/website-plan.md permits alongside Secrets Manager.
    const graphApiKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'GraphApiKeySecret',
      config.graphApiKeySecretName,
    );
    const graphApiKey = graphApiKeySecret
      .secretValueFromJson(config.graphApiKeySecretField)
      .unsafeUnwrap();

    const scanner = new lambda.Function(this, 'ScannerFunction', {
      description: 'Scans one group of ENS word lists and publishes a snapshot',
      // The Go binary is built for linux/arm64 and named bootstrap, which is what
      // the provided runtime family executes. Runtime and architecture must agree
      // with scripts/bundle-scanner.js or the function fails to start.
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: scannerHandler,
      code: props.scannerCode,
      role,
      logGroup: this.scannerLogGroup,
      timeout: functionTimeout,
      // The scan holds a batch of results and one serialized, compressed snapshot
      // in memory at a time, so memory is sized for CPU: Lambda scales CPU with
      // memory, and gzip and checksums are the publication's hot path.
      memorySize: 1024,
      // Two schedules, and they are offset so they cannot overlap. The bound is
      // here so a misconfigured schedule or a burst of manual invocations cannot
      // run many scans at once and multiply the Graph spend.
      reservedConcurrentExecutions: 2,
      // A failed scan waits for its next schedule instead of retrying. A rescan
      // costs the whole Graph budget again, and the publisher is designed so a
      // failure leaves the previous snapshot serving, so there is nothing urgent to
      // recover. The queue records the invocation either way.
      retryAttempts: 0,
      deadLetterQueue: this.failureQueue,
      deadLetterQueueEnabled: true,
      environment: {
        ENS_SNAPSHOT_TABLE: this.snapshotTable.tableName,
        ENS_SUBGRAPH_ID: config.subgraphId,
        THEGRAPH_API_KEY: graphApiKey,
        ENS_WORD_LIST_DIR: wordListDirectory,
        ENS_SCAN_WORKERS: String(config.scanTuning.workers),
        ENS_SCAN_BATCH_SIZE: String(config.scanTuning.batchSize),
        ENS_SCAN_HTTP_RETRIES: String(config.scanTuning.httpRetries),
        ENS_SCAN_REQUEST_TIMEOUT_SECONDS: String(config.scanTuning.requestTimeout.toSeconds()),
        ENS_SCAN_BUDGET_SECONDS: String(config.scanTuning.scanBudget.toSeconds()),
        ENS_SCAN_PREVIOUS_READ_ATTEMPTS: String(config.scanTuning.previousReadAttempts),
      },
    });

    // ENS_SUBGRAPH_URL is deliberately unset. internal/scanner has no fallback to
    // the shared public endpoint, so leaving the explicit URL out is what makes the
    // gateway credential the only way a scheduled scan reaches The Graph.
    return scanner;
  }

  /**
   * createScanRules wires one EventBridge rule per group.
   *
   * Each rule sends a constant payload naming its own group and nothing else, so a
   * rule cannot widen a scan: `scanner.Event` carries only the group, and
   * `parseGroup` rejects a group it does not know.
   */
  private createScanRules(): events.Rule[] {
    return scanSchedules.map((schedule) => {
      const rule = new events.Rule(this, `${schedule.id}Rule`, {
        description: schedule.description,
        schedule: events.Schedule.cron({
          minute: schedule.cron.minute,
          hour: schedule.cron.hour,
          day: '*',
          month: '*',
          year: '*',
        }),
      });
      rule.addTarget(
        new targets.LambdaFunction(this.scannerFunction, {
          event: events.RuleTargetInput.fromObject({ group: schedule.group }),
          retryAttempts: 0,
          deadLetterQueue: this.failureQueue,
        }),
      );
      return rule;
    });
  }

  /**
   * createAlarms covers the failures an operator has to know about, and stops
   * there. A stale-snapshot alarm needs a metric the publisher does not emit yet,
   * so it belongs with the operations phase rather than here.
   */
  private createAlarms(): void {
    const action = new cloudwatchActions.SnsAction(this.alarmTopic);
    const alarms: cloudwatch.Alarm[] = [
      // A scan that ran and failed. One failure matters: the group it scanned is
      // now absent from the next publication until its own schedule comes round.
      new cloudwatch.Alarm(this, 'ScanFailureAlarm', {
        alarmDescription: 'A scheduled ENS scan failed and published nothing',
        metric: this.scannerFunction.metricErrors({ period: Duration.hours(1), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        // No datapoint means no invocation in the period, which is the missing-scan
        // alarm's job and not this one's.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      // A scan that never ran. The reserved concurrency is the bound this trips
      // against, and a throttled scheduled run is silent otherwise.
      new cloudwatch.Alarm(this, 'ScanThrottleAlarm', {
        alarmDescription: 'A scheduled ENS scan was throttled before it started',
        metric: this.scannerFunction.metricThrottles({ period: Duration.hours(1), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
      // A schedule that stopped firing. The three-hourly rule fires eight times a
      // day, so six hours with no invocation at all means two consecutive scans
      // were missed, which is past the point the site's own staleness warning
      // appears.
      new cloudwatch.Alarm(this, 'ScanMissingAlarm', {
        alarmDescription: 'No ENS scan has run for six hours',
        metric: this.scannerFunction.metricInvocations({
          period: Duration.hours(6),
          statistic: 'Sum',
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        // A rule that stopped firing produces no datapoint at all, which is exactly
        // the condition this alarm exists for, so missing data has to breach.
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }),
      // An invocation that failed on the event-source side rather than inside the
      // function, which the Errors metric never sees.
      new cloudwatch.Alarm(this, 'ScanFailureQueueAlarm', {
        alarmDescription: 'A scheduled ENS scan invocation landed on the failure queue',
        metric: this.failureQueue.metricApproximateNumberOfMessagesVisible({
          period: Duration.hours(1),
          statistic: 'Maximum',
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    ];
    for (const alarm of alarms) {
      alarm.addAlarmAction(action);
    }
  }

  /**
   * declareOutputs exports the identifiers an operator needs. None of them names a
   * credential: the secret is identified by name, which is public, and the resolved
   * key is never an output.
   */
  private declareOutputs(config: Config): void {
    new CfnOutput(this, 'SnapshotTableName', {
      value: this.snapshotTable.tableName,
      description: 'DynamoDB table holding published snapshot chunks and the latest pointer',
    });
    new CfnOutput(this, 'ScannerFunctionName', {
      value: this.scannerFunction.functionName,
      description: 'Scheduled ENS snapshot publisher',
    });
    new CfnOutput(this, 'ScannerLogGroupName', {
      value: this.scannerLogGroup.logGroupName,
      description: 'Log group holding the redacted structured records of the publisher',
    });
    new CfnOutput(this, 'ScanFailureQueueUrl', {
      value: this.failureQueue.queueUrl,
      description: 'Queue recording scan invocations that never ran',
    });
    new CfnOutput(this, 'AlarmTopicArn', {
      value: this.alarmTopic.topicArn,
      description: 'Alarm topic; subscribe out of band, this stack adds no subscription',
    });
    new CfnOutput(this, 'GraphApiKeySecretName', {
      value: config.graphApiKeySecretName,
      description: 'Secrets Manager secret the deployment reads the Graph API key from',
    });
  }
}

/**
 * retentionDays maps a day count onto the enum CloudWatch Logs accepts, and rejects
 * a count that is not one of them rather than rounding to a longer retention than
 * was asked for.
 */
function retentionDays(days: number): logs.RetentionDays {
  const supported = Object.entries(logs.RetentionDays).find(([, value]) => value === days);
  if (!supported) {
    throw new Error(`log retention of ${days} days is not a value CloudWatch Logs accepts`);
  }
  return days as logs.RetentionDays;
}
