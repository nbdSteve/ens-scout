import { Match, Template } from 'aws-cdk-lib/assertions';

import { synth } from './helpers';

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

  test('report an invocation that never reached the function', () => {
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
    // Six hours is two consecutive missed three-hourly scans. A window at or below
    // the cadence would raise on the ordinary gap between two scans.
    const missing = Object.values(template.findResources('AWS::CloudWatch::Alarm')).find(
      (alarm) => (alarm.Properties as { MetricName?: string }).MetricName === 'Invocations',
    );
    expect(missing).toBeDefined();
    const properties = missing!.Properties as { Period: number; EvaluationPeriods: number };
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

  test('watch the scanner and the failure queue, and nothing else', () => {
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
  test('is bounded on the log group and the failure queue', () => {
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
  });

  test('accepts every day count CloudWatch Logs does', () => {
    for (const days of [1, 7, 30, 90, 365]) {
      expect(() => synth({ logRetentionDays: days })).not.toThrow();
    }
  });
});
