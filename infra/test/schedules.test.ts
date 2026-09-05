import { Match, Template } from 'aws-cdk-lib/assertions';

import { firingMinutes, scanSchedules } from '../lib/schedules';
import { goSource, goStringConstants, requireConstant, synth } from './helpers';

describe('the scan schedules', () => {
  let template: Template;

  beforeAll(() => {
    template = synth().template;
  });

  test('are one rule per group and no more', () => {
    template.resourceCountIs('AWS::Events::Rule', scanSchedules.length);
    expect(scanSchedules).toHaveLength(2);
  });

  test('name the groups internal/scanner accepts', () => {
    // scanner.parseGroup rejects anything outside its closed set, so a payload this
    // stack invents would fail every invocation of that schedule.
    const constants = goStringConstants(goSource('internal/scanner/scanner.go'));
    const groups = new Set([
      requireConstant(constants, 'GroupShort'),
      requireConstant(constants, 'GroupLong'),
    ]);
    for (const schedule of scanSchedules) {
      expect(groups).toContain(schedule.group);
    }
    // Both groups are covered, or a whole word list would never be scanned.
    expect(new Set(scanSchedules.map((schedule) => schedule.group))).toEqual(groups);
  });

  test('run the three- and four-letter lists every three hours', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(5 0/3 * * ? *)',
      State: 'ENABLED',
      Targets: [
        Match.objectLike({ Input: JSON.stringify({ group: 'three-four-letter' }) }),
      ],
    });
  });

  test('run the five-letter list once a day', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(35 1 * * ? *)',
      State: 'ENABLED',
      Targets: [Match.objectLike({ Input: JSON.stringify({ group: 'five-letter' }) })],
    });
  });

  test('target only their own group', () => {
    // A rule with a second target, or with a payload naming another group, would
    // let one schedule widen a scan and multiply the Graph spend.
    const rules = Object.values(template.findResources('AWS::Events::Rule'));
    expect(rules).toHaveLength(scanSchedules.length);
    const payloads = new Set<string>();
    for (const rule of rules) {
      const targets = (rule.Properties as { Targets: Array<{ Input?: string }> }).Targets;
      expect(targets).toHaveLength(1);
      const input = targets[0].Input;
      expect(input).toBeDefined();
      const parsed = JSON.parse(input!);
      // The payload carries the group and nothing else: scanner.Event has one
      // field, so any extra key here is a setting the scan silently ignores.
      expect(Object.keys(parsed)).toEqual(['group']);
      payloads.add(parsed.group);
    }
    expect(payloads.size).toBe(scanSchedules.length);
  });

  test('can never fire in the same second', () => {
    // The invariant issue #4 and docs/website-plan.md both call out. Both runs
    // publish into one monotonic pointer, so a collision means the daily run is
    // refused for having the older scan time and a whole daily Graph budget is
    // spent for nothing. The comparison is over the minutes each schedule actually
    // fires, not over the two cron strings, because two different expressions can
    // describe the same instant.
    const [short, long] = scanSchedules.map((schedule) => firingMinutes(schedule.cron));
    expect(short.length).toBeGreaterThan(0);
    expect(long.length).toBeGreaterThan(0);
    const collisions = short.filter((minute) => long.includes(minute));
    expect(collisions).toEqual([]);
  });

  test('fire at the cadence docs/website-plan.md approved', () => {
    const byGroup = new Map(
      scanSchedules.map((schedule) => [schedule.group, firingMinutes(schedule.cron)]),
    );
    // Eight times a day is every three hours; once a day is daily.
    expect(byGroup.get('three-four-letter')).toHaveLength(8);
    expect(byGroup.get('five-letter')).toHaveLength(1);
  });

  test('grant EventBridge nothing but permission to invoke the scanner', () => {
    template.resourceCountIs('AWS::Lambda::Permission', scanSchedules.length);
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'events.amazonaws.com',
      FunctionName: { 'Fn::GetAtt': [Match.stringLikeRegexp('^ScannerFunction'), 'Arn'] },
    });
  });

  test('do not retry, and record a failed delivery', () => {
    const rules = Object.values(template.findResources('AWS::Events::Rule'));
    for (const rule of rules) {
      const target = (rule.Properties as {
        Targets: Array<{ RetryPolicy?: { MaximumRetryAttempts?: number }; DeadLetterConfig?: unknown }>;
      }).Targets[0];
      expect(target.RetryPolicy?.MaximumRetryAttempts).toBe(0);
      expect(target.DeadLetterConfig).toBeDefined();
    }
  });
});

describe('firingMinutes', () => {
  test('expands a literal, a step, a range, and a list', () => {
    expect(firingMinutes({ minute: '5', hour: '1' })).toEqual([65]);
    expect(firingMinutes({ minute: '0', hour: '0/6' })).toEqual([0, 360, 720, 1080]);
    expect(firingMinutes({ minute: '0', hour: '1-3' })).toEqual([60, 120, 180]);
    expect(firingMinutes({ minute: '0,30', hour: '0' })).toEqual([0, 30]);
    expect(firingMinutes({ minute: '0', hour: '*/12' })).toEqual([0, 720]);
  });

  test('rejects a field it does not understand rather than expanding to nothing', () => {
    // A field that quietly expanded to an empty list would make the offset test
    // pass by describing a schedule that never fires.
    expect(() => firingMinutes({ minute: '?', hour: '0' })).toThrow();
    expect(() => firingMinutes({ minute: '0', hour: 'MON' })).toThrow();
    expect(() => firingMinutes({ minute: '60', hour: '0' })).toThrow();
    expect(() => firingMinutes({ minute: '0', hour: '3-1' })).toThrow();
  });
});
