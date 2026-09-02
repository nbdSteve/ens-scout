import { Match, Template } from 'aws-cdk-lib/assertions';

import { functionTimeout, defaultScanTuning } from '../lib/config';
import { scannerHandler, wordListDirectory } from '../lib/ens-scout-stack';
import { goSource, goStringConstants, synth, testConfig } from './helpers';

describe('the scanner function', () => {
  let template: Template;

  beforeAll(() => {
    template = synth().template;
  });

  test('is one function packaged for the Go runtime on Graviton', () => {
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'provided.al2023',
      Architectures: ['arm64'],
      Handler: scannerHandler,
    });
  });

  test('is bounded in time, memory, and concurrency', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: functionTimeout.toSeconds(),
      MemorySize: 1024,
      ReservedConcurrentExecutions: 2,
    });
  });

  test('leaves publication time after the scan budget', () => {
    // internal/scanner bounds the Graph phase with the scan budget and then still
    // has to serialize, write, read back, verify, and move the pointer. A timeout
    // at or below the budget would kill the publication of a scan that had already
    // been paid for.
    expect(functionTimeout.toSeconds()).toBeGreaterThan(defaultScanTuning.scanBudget.toSeconds());
  });

  test('cannot outlive the window a later run waits before reclaiming its chunks', () => {
    // internal/scanner.abandonedAfter is how long a staged snapshot must sit before
    // another run may expire its chunks. A function that could still be running
    // then would have its own chunk set reclaimed underneath it.
    const source = goSource('internal/scanner/scanner.go');
    const match = /abandonedAfter\s*=\s*(\d+)\s*\*\s*time\.Hour/.exec(source);
    expect(match).not.toBeNull();
    const abandonedAfterSeconds = Number(match![1]) * 3600;
    expect(functionTimeout.toSeconds()).toBeLessThan(abandonedAfterSeconds);
  });

  test('never retries a scan', () => {
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 0,
    });
  });

  test('declares no dead-letter queue of its own', () => {
    // Lambda's async DeadLetterConfig receives the event for any failed asynchronous
    // invocation, including a scan that ran and returned an error. Nothing drains the
    // undelivered-event queue, so a function-level DLQ would latch that queue's level
    // alarm for its whole retention on an ordinary Graph outage and blind the alarm to
    // a real delivery failure arriving meanwhile. An execution failure is reported by
    // the Errors alarm and the log group.
    template.hasResourceProperties('AWS::Lambda::Function', {
      DeadLetterConfig: Match.absent(),
    });
  });


  test('sets only environment variables internal/scanner reads', () => {
    // A variable this stack invents is a variable the Lambda ignores, which is a
    // setting that looks applied and is not. The names come from the Go package.
    const constants = goStringConstants(goSource('internal/scanner/scanner.go'));
    const known = new Set(
      [...constants.entries()]
        .filter(([name]) => name.startsWith('Env'))
        .map(([, value]) => value),
    );
    expect(known.size).toBeGreaterThan(0);

    const variables = environmentVariables(template);
    for (const name of Object.keys(variables)) {
      expect(known).toContain(name);
    }
  });

  test('passes the table, the subgraph, the word lists, and the tuning', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ENS_SNAPSHOT_TABLE: { Ref: Match.stringLikeRegexp('^SnapshotTable') },
          ENS_SUBGRAPH_ID: testConfig.subgraphId,
          ENS_WORD_LIST_DIR: wordListDirectory,
          ENS_SCAN_WORKERS: String(defaultScanTuning.workers),
          ENS_SCAN_BATCH_SIZE: String(defaultScanTuning.batchSize),
          ENS_SCAN_HTTP_RETRIES: String(defaultScanTuning.httpRetries),
          ENS_SCAN_REQUEST_TIMEOUT_SECONDS: String(defaultScanTuning.requestTimeout.toSeconds()),
          ENS_SCAN_BUDGET_SECONDS: String(defaultScanTuning.scanBudget.toSeconds()),
          ENS_SCAN_PREVIOUS_READ_ATTEMPTS: String(defaultScanTuning.previousReadAttempts),
        }),
      },
    });
  });

  test('does not set an explicit endpoint, so the credential is the only way out', () => {
    // internal/scanner has no fallback to the shared public endpoint. Setting
    // ENS_SUBGRAPH_URL would point tens of thousands of names at a globally
    // rate-limited endpoint and turn a missing credential into a slow partial scan
    // instead of a startup failure.
    expect(environmentVariables(template).ENS_SUBGRAPH_URL).toBeUndefined();
  });

  test('logs to a declared group with bounded retention', () => {
    template.resourceCountIs('AWS::Logs::LogGroup', 1);
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: testConfig.logRetentionDays,
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      LoggingConfig: { LogGroup: { Ref: Match.stringLikeRegexp('^ScannerLogGroup') } },
    });
  });

  test('adds no log-retention custom resource', () => {
    // The deprecated logRetention property provisions a helper Lambda with
    // logs:PutRetentionPolicy on every log group in the account. Declaring the
    // group instead avoids both the extra function and that permission.
    template.resourceCountIs('Custom::LogRetention', 0);
  });

  test('bounds the undelivered-event queue and encrypts it', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: testConfig.dlqRetentionDays * 24 * 60 * 60,
      SqsManagedSseEnabled: true,
    });
  });
});

function environmentVariables(template: Template): Record<string, unknown> {
  const functions = template.findResources('AWS::Lambda::Function');
  const properties = Object.values(functions)[0].Properties as {
    Environment?: { Variables?: Record<string, unknown> };
  };
  return properties.Environment?.Variables ?? {};
}
