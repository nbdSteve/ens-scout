/**
 * The scan schedules.
 *
 * One schedule event names one group, and the groups are the ones
 * `internal/scanner` defines: `Group` is a closed set, and `parseGroup` rejects
 * anything else, so a schedule cannot widen a scan by sending a different payload.
 * The strings here must match `scanner.GroupShort` and `scanner.GroupLong`.
 */
export type ScanGroup = 'three-four-letter' | 'five-letter';

/**
 * CronFields is the subset of an EventBridge cron expression these schedules use.
 * Day, month, and weekday are always wildcards, so the only thing that decides
 * whether two schedules can fire together is the hour and minute.
 */
export interface CronFields {
  readonly minute: string;
  readonly hour: string;
}

export interface ScanSchedule {
  /** Construct id fragment, and the source of the rule name. */
  readonly id: string;
  /** The single group this schedule scans. */
  readonly group: ScanGroup;
  /** Human description recorded on the rule. */
  readonly description: string;
  readonly cron: CronFields;
}

/**
 * scanSchedules are the two schedules, offset from each other.
 *
 * The three-hourly run fires at :05 past every third hour and the daily run at
 * 01:35, so the two can never fire in the same second. That offset is a
 * requirement, not a preference. Both runs publish into one latest pointer that
 * only ever moves forward, so on a collision the short run finishes first and
 * publishes, and the daily run is then refused because its scan time is the older
 * of the two - throwing away a whole daily Graph budget on which run happened to
 * sample its clock first. Refusing the older scan is correct; not colliding is
 * cheaper.
 *
 * The minutes are also offset from :00 so a scan does not start in the minute that
 * every other scheduled job on the hour starts in.
 */
export const scanSchedules: readonly ScanSchedule[] = [
  {
    id: 'ShortScan',
    group: 'three-four-letter',
    description: 'Scans the three- and four-letter word lists every three hours',
    cron: { minute: '5', hour: '0/3' },
  },
  {
    id: 'LongScan',
    group: 'five-letter',
    description: 'Scans the five-letter word list once a day',
    cron: { minute: '35', hour: '1' },
  },
];

/**
 * firingMinutes expands an hour-and-minute cron pair into every minute of the day
 * it fires, as minutes past midnight UTC.
 *
 * It exists so a test can prove the offset holds by comparing the two schedules'
 * actual firing times rather than by comparing two cron strings, which would pass
 * for two different expressions that describe the same instant.
 */
export function firingMinutes(cron: CronFields): number[] {
  const minutes = expandField(cron.minute, 0, 59);
  const hours = expandField(cron.hour, 0, 23);
  const firings: number[] = [];
  for (const hour of hours) {
    for (const minute of minutes) {
      firings.push(hour * 60 + minute);
    }
  }
  return firings.sort((left, right) => left - right);
}

/**
 * expandField expands one EventBridge cron field. It supports the forms these
 * schedules use - a literal, a comma list, a start-end range, a wildcard, and a
 * step written after any of them - and rejects anything else rather than guessing,
 * so a field a future edit adds cannot silently expand to nothing and make the
 * offset test pass by describing a schedule that never fires.
 */
function expandField(field: string, low: number, high: number): number[] {
  const values = new Set<number>();
  for (const term of field.split(',')) {
    const [spec, stepText] = term.split('/');
    const step = stepText === undefined ? 1 : parseBounded(stepText, 1, high - low + 1, field);

    let start: number;
    let end: number;
    if (spec === '*') {
      start = low;
      end = high;
    } else if (spec.includes('-')) {
      const [startText, endText] = spec.split('-');
      start = parseBounded(startText, low, high, field);
      end = parseBounded(endText, low, high, field);
    } else {
      start = parseBounded(spec, low, high, field);
      // A bare `start/step` counts up to the ceiling, which is how EventBridge
      // reads `0/3`; a bare literal with no step is that single value.
      end = stepText === undefined ? start : high;
    }
    if (end < start) {
      throw new Error(`cron field ${field} has a range that ends before it starts`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  return [...values].sort((left, right) => left - right);
}

function parseBounded(text: string, low: number, high: number, field: string): number {
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`cron field ${field} is not one of the supported forms`);
  }
  const value = Number(text);
  if (value < low || value > high) {
    throw new Error(`cron field ${field} has a value outside ${low}-${high}`);
  }
  return value;
}
