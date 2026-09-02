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

  test('are the four failures an operator has to know about', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 4);
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
      // A period with no invocation is the missing-scan alarm's condition, not this
      // one's, so no datapoint here must not raise.
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

  test('report a schedule that stopped firing', () => {
    // The only alarm that has to breach on missing data: a rule that stopped firing
    // produces no datapoint at all, so notBreaching would make this alarm silent in
    // exactly the state it exists for.
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Invocations',
      Namespace: 'AWS/Lambda',
      Statistic: 'Sum',
      Threshold: 1,
      ComparisonOperator: 'LessThanThreshold',
      TreatMissingData: 'breaching',
    });
  });

  test('leave the other three on a single datapoint, because one occurrence matters', () => {
    // Only the missing-scan alarm needs a wider window. The other three treat missing
    // data as not breaching, so an empty period cannot raise them at all, and one
    // error, one throttle, or one undelivered event is already the whole signal - a
    // second period would only delay it.
    for (const alarm of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) {
      const properties = alarm.Properties as {
        MetricName: string;
        EvaluationPeriods: number;
        TreatMissingData: string;
      };
      if (properties.MetricName === 'Invocations') {
        continue;
      }
      expect(properties.EvaluationPeriods).toBe(1);
      expect(properties.TreatMissingData).toBe('notBreaching');
    }
  });

  test('report a schedule event EventBridge could not deliver', () => {
    // The only writer to this queue is the EventBridge target's dead-letter queue, so
    // a message here means no invocation ever happened and the Errors metric saw
    // nothing. A level alarm is intended: nothing drains the queue, so an undelivered
    // scan stays raised until an operator deals with it.
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Namespace: 'AWS/SQS',
      Statistic: 'Maximum',
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  test('give the missing-scan alarm a window wider than the three-hourly cadence', () => {
    // One six-hour period is already two consecutive missed three-hourly scans, and
    // the alarm needs two of them. A window at or below the cadence would raise on the
    // ordinary gap between two scans.
    const missing = Object.values(template.findResources('AWS::CloudWatch::Alarm')).find(
      (alarm) => (alarm.Properties as { MetricName?: string }).MetricName === 'Invocations',
    );
    expect(missing).toBeDefined();
    const properties = missing!.Properties as { Period: number; EvaluationPeriods: number };
    expect(properties.Period).toBeGreaterThan(3 * 60 * 60);
    expect(properties.Period * properties.EvaluationPeriods).toBeGreaterThan(3 * 60 * 60);
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

describe('the missing-scan alarm', () => {
  let model: AlarmModel;

  beforeAll(() => {
    model = alarmModel(synth().template, 'Invocations');
  });

  test('needs two windows, with both knobs spelled out rather than defaulted', () => {
    // datapointsToAlarm defaults to evaluationPeriods, so a reader cannot tell an
    // intended 2-of-2 from an accident. Both are set, and both are pinned here.
    expect(model.evaluationPeriods).toBe(2);
    expect(model.datapointsToAlarm).toBe(2);
    expect(model.treatMissingData).toBe('breaching');
  });

  test('does not raise on the first window after a deploy', () => {
    // Only one window has elapsed, so the alarm's evaluation range holds one
    // datapoint. A deploy that lands part way through a window leaves it empty
    // through no fault of the schedule, and that is not evidence a schedule stopped.
    expect(evaluate(model, ['missing'])).toBe('OK');
  });

  test('does not raise on one missing window', () => {
    expect(evaluate(model, [16, 'missing'])).toBe('OK');
  });

  test('raises on two consecutive missing windows', () => {
    // Two empty six-hour windows is twelve hours with no invocation at all, which is
    // a schedule that stopped firing rather than a gap between scans.
    expect(evaluate(model, [16, 'missing', 'missing'])).toBe('ALARM');
  });

  test('recovers once a scan lands again', () => {
    expect(evaluate(model, [16, 'missing', 'missing', 16])).toBe('OK');
  });

  test('raises on a window that ran but published fewer invocations than one', () => {
    // The condition is Sum < 1, not just missing data, so a window whose datapoint is
    // a real zero breaches the same way an absent one does.
    expect(evaluate(model, [0, 0])).toBe('ALARM');
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

/**
 * A window's contribution to an alarm evaluation: the metric value CloudWatch
 * collected for that period, or the absence of one.
 */
type Datapoint = number | 'missing';

/**
 * AlarmModel is the synthesized alarm reduced to the fields that decide its state.
 *
 * The values come from the CloudFormation template, which is the stack's generated
 * output, so a change to the alarm changes what these cases run against.
 */
interface AlarmModel {
  readonly threshold: number;
  readonly comparisonOperator: string;
  readonly evaluationPeriods: number;
  readonly datapointsToAlarm: number;
  readonly treatMissingData: string;
}

function alarmModel(template: Template, metricName: string): AlarmModel {
  const alarm = Object.values(template.findResources('AWS::CloudWatch::Alarm')).find(
    (resource) => (resource.Properties as { MetricName?: string }).MetricName === metricName,
  );
  if (!alarm) {
    throw new Error(`no alarm watches ${metricName}; the cases below are stale`);
  }
  const properties = alarm.Properties as Record<string, unknown>;
  const evaluationPeriods = properties.EvaluationPeriods as number;
  return {
    threshold: properties.Threshold as number,
    comparisonOperator: properties.ComparisonOperator as string,
    evaluationPeriods,
    // CloudWatch defaults datapointsToAlarm to evaluationPeriods when it is absent.
    datapointsToAlarm: (properties.DatapointsToAlarm as number | undefined) ?? evaluationPeriods,
    treatMissingData: properties.TreatMissingData as string,
  };
}

/**
 * evaluate applies CloudWatch's M-of-N rule to a sequence of windows, oldest first,
 * and returns the state the alarm would hold.
 *
 * The evaluation range is the most recent `evaluationPeriods` windows; the alarm
 * raises when at least `datapointsToAlarm` of them breach, and a missing window
 * breaches according to `treatMissingData`. A sequence shorter than
 * `evaluationPeriods` models the windows that had not elapsed yet, which is the
 * state a freshly deployed alarm is in.
 */
function evaluate(model: AlarmModel, windows: readonly Datapoint[]): 'ALARM' | 'OK' {
  const range = windows.slice(-model.evaluationPeriods);
  const breaching = range.filter((window) => isBreaching(model, window)).length;
  return breaching >= model.datapointsToAlarm ? 'ALARM' : 'OK';
}

function isBreaching(model: AlarmModel, window: Datapoint): boolean {
  if (window === 'missing') {
    switch (model.treatMissingData) {
      case 'breaching':
        return true;
      case 'notBreaching':
        return false;
      default:
        throw new Error(`unmodelled missing-data treatment ${model.treatMissingData}`);
    }
  }
  switch (model.comparisonOperator) {
    case 'LessThanThreshold':
      return window < model.threshold;
    case 'GreaterThanOrEqualToThreshold':
      return window >= model.threshold;
    default:
      throw new Error(`unmodelled comparison operator ${model.comparisonOperator}`);
  }
}
