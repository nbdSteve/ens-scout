import { Match, Template } from 'aws-cdk-lib/assertions';
import * as logs from 'aws-cdk-lib/aws-logs';

import { contextKeys } from '../lib/config';
import { unboundedRetention } from '../lib/ens-scout-stack';
import { synth, testConfig } from './helpers';

describe('the alarms', () => {
  let template: Template;

  beforeAll(() => {
    template = synth().template;
  });

  test('are the three failures this stack can observe', () => {
    // All three watch something that happened. A schedule that silently stopped firing
    // is not among them: it produces no invocation, so no Lambda metric and no queue
    // metric records it. infra/README.md states that gap and where it belongs.
    template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
  });

  test('all notify the one topic', () => {
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
    for (const alarm of alarms) {
      const properties = alarm.Properties as { AlarmActions?: unknown[] };
      expect(properties.AlarmActions).toHaveLength(1);
    }
    template.resourceCountIs('AWS::SNS::Topic', 1);
  });

  test('leave the topic unsubscribed, because a recipient is not this stack to pick', () => {
    // Subscribing an address here would put a person's contact details in the
    // repository and would make a deployment mail whoever the code named.
    template.resourceCountIs('AWS::SNS::Subscription', 0);
  });

  test('report a scan that ran and failed', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      Statistic: 'Sum',
      Threshold: 1,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      // A period with no invocation is not a failed scan, so no datapoint must not
      // raise this alarm.
      TreatMissingData: 'notBreaching',
    });
  });

  test('report a scan that was throttled before it started', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Throttles',
      Namespace: 'AWS/Lambda',
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  test('none of them treats missing data as a failure', () => {
    // Every alarm here watches an occurrence, so an empty period is silence rather
    // than evidence. A breaching treatment would need an M-of-N window and a
    // deployment grace period neither of these metrics can express, which is why no
    // alarm in this stack claims to detect a schedule that stopped firing.
    for (const alarm of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) {
      const properties = alarm.Properties as { TreatMissingData: string };
      expect(properties.TreatMissingData).toBe('notBreaching');
    }
  });

  test('all raise on a single datapoint, because one occurrence matters', () => {
    // One error, one throttle, or one undelivered event is already the whole signal,
    // and a second period would only delay it. Missing data cannot raise any of them,
    // so a single datapoint carries no first-deploy risk.
    for (const alarm of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) {
      const properties = alarm.Properties as {
        EvaluationPeriods: number;
        DatapointsToAlarm?: number;
      };
      expect(properties.EvaluationPeriods).toBe(1);
      expect(properties.DatapointsToAlarm ?? 1).toBe(1);
    }
  });

  test('none of them watches Invocations, which cannot distinguish silence from a deploy', () => {
    // A missing Invocations datapoint is what a stopped schedule and a fresh deploy
    // both look like, and CloudWatch fills a missing datapoint per treatMissingData
    // rather than shrinking the window, so an Invocations alarm with a breaching
    // treatment pages on the first deploy. Reintroducing one needs the published
    // snapshot metric instead.
    for (const alarm of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) {
      expect((alarm.Properties as { MetricName: string }).MetricName).not.toBe('Invocations');
    }
  });

  test('report a schedule event EventBridge could not deliver', () => {
    // The only writer to this queue is the EventBridge target's dead-letter queue, so
    // a message here means no invocation ever happened and the Errors metric saw
    // nothing. A level alarm is intended, because nothing drains the queue - but it
    // clears when SQS expires the message as well as when an operator removes it.
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Namespace: 'AWS/SQS',
      Statistic: 'Maximum',
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  test('describe themselves, so a notification says what broke', () => {
    // An alarm that arrives with a construct id and no description makes an operator
    // open the console to find out what fired.
    for (const alarm of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) {
      const description = (alarm.Properties as { AlarmDescription?: string }).AlarmDescription;
      expect(typeof description).toBe('string');
      expect(description!.length).toBeGreaterThan(20);
    }
  });

  test('watch the scanner and the undelivered-event queue, and nothing else', () => {
    const dimensions = Object.values(template.findResources('AWS::CloudWatch::Alarm')).map(
      (alarm) =>
        ((alarm.Properties as { Dimensions: Array<{ Name: string }> }).Dimensions ?? []).map(
          (dimension) => dimension.Name,
        ),
    );
    for (const names of dimensions) {
      expect(names.length).toBe(1);
      expect(['FunctionName', 'QueueName']).toContain(names[0]);
    }
  });

  test('are the whole alarming surface: no dashboard, no composite, no anomaly detector', () => {
    // Issue #4 scopes bounded alarms. Anything wider is the operations phase.
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 0);
    template.resourceCountIs('AWS::CloudWatch::CompositeAlarm', 0);
    template.resourceCountIs('AWS::CloudWatch::AnomalyDetector', 0);
  });
});

describe('retention', () => {
  test('is bounded on the log group and the undelivered-event queue', () => {
    const template = synth().template;
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: Match.anyValue(),
    });
  });

  test('rejects a log retention CloudWatch Logs does not accept', () => {
    // Rounding an unsupported day count up would keep records longer than the
    // deployment asked for, and rounding it down would discard them early. Both are
    // worse than refusing to synthesize.
    expect(() => synth({ logRetentionDays: 45 })).toThrow(/log retention/);
    expect(() => synth({ logRetentionDays: 45 })).toThrow(contextKeys.logRetentionDays);
  });

  test('rejects every retention that means never expire', () => {
    // 9999 is RetentionDays.INFINITE, which CloudWatch Logs does accept, so neither
    // the positive-integer check in resolveConfig nor the enum-membership check
    // catches it. Log volume grows with every invocation, so an unbounded group is
    // unbounded cost and contradicts the rule that anything accumulating is bounded.
    expect(unboundedRetention).toContain(logs.RetentionDays.INFINITE);
    for (const days of unboundedRetention) {
      expect(() => synth({ logRetentionDays: days })).toThrow(contextKeys.logRetentionDays);
      expect(() => synth({ logRetentionDays: days })).toThrow(/finite/);
    }
  });

  test('accepts every finite day count CloudWatch Logs does', () => {
    // The two either side of the deployed default are the regression case: rejecting
    // the infinite sentinel must not reject an ordinary neighbouring value.
    for (const days of [1, 7, 14, testConfig.logRetentionDays, 60, 90, 365, 3653]) {
      expect(() => synth({ logRetentionDays: days })).not.toThrow();
    }
  });
});
