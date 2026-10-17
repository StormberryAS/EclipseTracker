// The alarm planner: when each alarm the person chose rings, for one eclipse, in one time zone, at
// one moment. Pure: the zone and "now" always come in as arguments. The web page uses it to show the
// times and to write the calendar file; stage B (Android) ports it to Kotlin with java.time and must
// give the same answers for tests/alarm-vectors.json, tests/record-vectors.json and
// tests/dst-vectors.json.
//
// The rules (spec section 6):
//   * "At a time of day" alarms (on the day, 1, 2 or 3 days or 1 week before) ring at that wall
//     time in the person's zone, on the local date of greatest eclipse minus the days chosen. On a
//     night the clocks change, a time that does not exist moves forward by the gap and a time that
//     happens twice takes the first (zoned.ts).
//   * "Before greatest eclipse" alarms ring that many minutes before greatest eclipse, rounded to
//     the minute. They do not depend on the zone.
//   * An alarm whose time is not after `now` has passed: it is shown as passed and left out.
//   * Two alarms that ring at the same minute are one alarm: the later in the list is a duplicate.
//   * An alarm that rings after greatest eclipse (a time of day later than the eclipse on its own
//     day, such as noon on the day of a lunar eclipse at 00:13) is kept, because the person chose
//     it, and flagged: the page says "after greatest eclipse" next to it.
//   * At most MAX_ALARMS alarms per eclipse: planAlarms(), buildIcs() and the record checks refuse
//     more (data review D-7).
//
// Stage B's records (spec section 9.4) are handled here too, so the Kotlin port has one place to
// copy: the checks on records that cross the bridge or come out of storage, what a re-plan does with
// each record (recordFate), and the planner rows built from stored records and back.

import { greatestMinute } from './format.js';
import type { AlarmRecord, AlarmSpec, DaysBefore, Eclipse, MinutesBefore, PlannedAlarm, PlannerRow, RecordFate } from './types.js';
import { addDays, isKnownZone, isWallTime, localDateTime, offsetMinutes, wallTimeToInstant } from './zoned.js';

/** The most alarms one eclipse can have. */
export const MAX_ALARMS = 8;

/** The time of day every new "at a time of day" alarm starts with (Marcos, 2026-10-16). */
export const DEFAULT_TIME = '12:00';

/** The alarm a new planner starts with: on the day of the eclipse at 12:00. */
export const DEFAULT_SPEC: AlarmSpec = { kind: 'day', daysBefore: 0, time: DEFAULT_TIME };

export const DAYS_BEFORE: readonly DaysBefore[] = [0, 1, 2, 3, 7];
export const MINUTES_BEFORE: readonly MinutesBefore[] = [15, 30, 60, 120];

/**
 * How long after greatest eclipse a stored record is kept at most. No alarm can ring later: a time
 * of day on the local day of greatest eclipse is less than 24 hours of wall clock after it, plus at
 * most 2 hours when the clocks go back that day (Antarctica/Troll goes back 2 hours). 24 hours
 * would not be enough; 48 leaves a clear margin.
 */
export const RECORD_GRACE_MS = 48 * 3_600_000;

const MINUTE = 60_000;
const RECORD_ID = /^[0-9a-f]{32}$/;
const ECLIPSE_ID = /^\d{4}-\d{2}-\d{2}-(solar|lunar)$/;

/** The instant an alarm rings, and how a clock change was resolved, before any status is decided. */
export function fireInstant(e: Pick<Eclipse, 'greatest'>, spec: AlarmSpec, zone: string): { epochMs: number; dst: PlannedAlarm['dst'] } {
  const greatest = greatestMinute(e);
  if (spec.kind === 'before') return { epochMs: greatest - spec.minutes * MINUTE, dst: 'none' };
  const day = localDateTime(zone, greatest).date;
  return wallTimeToInstant(zone, addDays(day, -spec.daysBefore), spec.time);
}

/** One alarm, planned. Its status is 'ok' or 'past'; planAlarms() also finds duplicates. */
export function planAlarm(e: Pick<Eclipse, 'greatest'>, spec: AlarmSpec, zone: string, now: number): PlannedAlarm {
  if (!isValidSpec(spec)) throw new RangeError(`not an alarm: ${JSON.stringify(spec)}`);
  if (!isKnownZone(zone)) throw new RangeError(`unknown time zone: ${zone}`);
  const { epochMs, dst } = fireInstant(e, spec, zone);
  const local = localDateTime(zone, epochMs);
  return {
    spec,
    fireAt: epochMs,
    localDate: local.date,
    localTime: local.time,
    offsetMinutes: offsetMinutes(zone, epochMs),
    status: epochMs > now ? 'ok' : 'past',
    afterGreatest: epochMs > greatestMinute(e),
    dst,
  };
}

/**
 * Several alarms for one eclipse, in the order given; a later alarm at the same minute as an
 * earlier one is a duplicate. More than MAX_ALARMS is refused.
 */
export function planAlarms(e: Pick<Eclipse, 'greatest'>, specs: readonly AlarmSpec[], zone: string, now: number): PlannedAlarm[] {
  if (specs.length > MAX_ALARMS) throw new RangeError(`at most ${MAX_ALARMS} alarms per eclipse, not ${specs.length}`);
  const seen = new Set<number>();
  return specs.map((spec) => {
    const p = planAlarm(e, spec, zone, now);
    if (p.status !== 'ok') return p;
    if (seen.has(p.fireAt)) return { ...p, status: 'duplicate' };
    seen.add(p.fireAt);
    return p;
  });
}

/** The alarms that will ring, in the order they ring. */
export function ringing(planned: readonly PlannedAlarm[]): PlannedAlarm[] {
  return planned.filter((p) => p.status === 'ok').sort((a, b) => a.fireAt - b.fireAt);
}

/** True for an alarm spec this version understands (a guard for data that crossed a bridge or came from storage). */
export function isValidSpec(spec: unknown): spec is AlarmSpec {
  if (!spec || typeof spec !== 'object') return false;
  const s = spec as Record<string, unknown>;
  if (s.kind === 'before') return Object.keys(s).length === 2 && (MINUTES_BEFORE as readonly unknown[]).includes(s.minutes);
  if (s.kind === 'day') {
    return Object.keys(s).length === 3 && (DAYS_BEFORE as readonly unknown[]).includes(s.daysBefore) && typeof s.time === 'string' && isWallTime(s.time);
  }
  return false;
}

/** True for a record id: 32 lower-case hex digits, random. */
export function isRecordId(id: unknown): id is string {
  return typeof id === 'string' && RECORD_ID.test(id);
}

/** True for one alarm record stage B can store (spec section 9.4): exactly v, id, eclipseId and spec. */
export function isValidRecord(r: unknown): r is AlarmRecord {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
  const o = r as Record<string, unknown>;
  return Object.keys(o).length === 4 && o.v === 1 && isRecordId(o.id) && typeof o.eclipseId === 'string'
    && ECLIPSE_ID.test(o.eclipseId) && isValidSpec(o.spec);
}

/**
 * True for a whole set of records, as stored or as sent over the bridge: every record valid, no id
 * twice, and at most MAX_ALARMS for any one eclipse.
 */
export function isValidRecordSet(records: unknown): records is AlarmRecord[] {
  if (!Array.isArray(records)) return false;
  const ids = new Set<string>();
  const perEclipse = new Map<string, number>();
  for (const r of records) {
    if (!isValidRecord(r) || ids.has(r.id)) return false;
    ids.add(r.id);
    const n = (perEclipse.get(r.eclipseId) ?? 0) + 1;
    if (n > MAX_ALARMS) return false;
    perEclipse.set(r.eclipseId, n);
  }
  return true;
}

/**
 * What a re-plan does with one stored record (spec section 9.4, code review C-1). `eclipse` is the
 * bundled eclipse with the record's id, or undefined when the list has none.
 *
 * A record is never deleted merely because its eclipse has passed: an alarm set for after greatest
 * eclipse (ALARM-2) is kept and armed until its own time. It is deleted when it can never ring
 * again: its own time, worked out now in the current zone, is not after now (it rang, or it was
 * missed and is never rung late), or 48 hours have passed since greatest eclipse (RECORD_GRACE_MS,
 * a backstop that needs no zone), or its eclipse is unknown, or the record itself is not valid.
 */
export function recordFate(record: unknown, eclipse: Pick<Eclipse, 'id' | 'greatest'> | undefined, zone: string, now: number): RecordFate {
  if (!isValidRecord(record)) return { action: 'delete', reason: 'invalid' };
  if (!eclipse || eclipse.id !== record.eclipseId) return { action: 'delete', reason: 'unknown-eclipse' };
  if (now >= greatestMinute(eclipse) + RECORD_GRACE_MS) return { action: 'delete', reason: 'expired' };
  const { fireAt } = planAlarm(eclipse, record.spec, zone, now);
  return fireAt > now ? { action: 'arm', fireAt } : { action: 'delete', reason: 'passed' };
}

/**
 * The planner rows for one eclipse from stored records (stage B opens the planner with them instead
 * of the default alarm): that eclipse's valid records, in the order stored, each row keeping its
 * record id. Records for other eclipses and invalid records are skipped.
 */
export function rowsFromRecords(records: readonly unknown[], eclipseId: string): PlannerRow[] {
  return records
    .filter((r): r is AlarmRecord => isValidRecord(r) && r.eclipseId === eclipseId)
    .slice(0, MAX_ALARMS)
    .map((r) => ({ id: r.id, spec: r.spec }));
}

/**
 * The records for one eclipse from the planner's rows (stage B's "alarms.set" message): a row
 * keeps its record id, a new row gets one from newId(). Refuses an invalid row, a repeated id and
 * more than MAX_ALARMS rows.
 */
export function recordsFromRows(eclipseId: string, rows: readonly PlannerRow[], newId: () => string): AlarmRecord[] {
  if (!ECLIPSE_ID.test(eclipseId)) throw new RangeError(`not an eclipse id: ${eclipseId}`);
  if (rows.length > MAX_ALARMS) throw new RangeError(`at most ${MAX_ALARMS} alarms per eclipse, not ${rows.length}`);
  const records = rows.map((row): AlarmRecord => ({ v: 1, id: row.id ?? newId(), eclipseId, spec: row.spec }));
  if (!isValidRecordSet(records)) throw new RangeError('the rows do not make a valid set of records');
  return records;
}

/** The planner's choice value for a spec ("day-0" ... "day-7", "before"), and back. */
export function choiceOf(spec: AlarmSpec): string {
  return spec.kind === 'before' ? 'before' : `day-${spec.daysBefore}`;
}

/**
 * The spec for a choice, keeping what still applies from the previous spec: the time of day when
 * moving between day options, the minutes when coming back to "before".
 */
export function specForChoice(choice: string, previous: AlarmSpec, lastTime = DEFAULT_TIME, lastMinutes: MinutesBefore = 30): AlarmSpec {
  if (choice === 'before') return { kind: 'before', minutes: previous.kind === 'before' ? previous.minutes : lastMinutes };
  const days = Number(choice.replace('day-', ''));
  if (!(DAYS_BEFORE as readonly number[]).includes(days)) throw new RangeError(`not a choice: ${choice}`);
  return { kind: 'day', daysBefore: days as DaysBefore, time: previous.kind === 'day' ? previous.time : lastTime };
}

/**
 * The alarm "Add another alarm" starts with (ALARM-8): the first of these not already among the
 * specs, with the time of day last typed, so a new alarm is never a copy of one already there.
 */
export function nextNewSpec(existing: readonly AlarmSpec[], lastTime = DEFAULT_TIME): AlarmSpec {
  const candidates: AlarmSpec[] = [
    { kind: 'day', daysBefore: 0, time: lastTime },
    { kind: 'day', daysBefore: 1, time: lastTime },
    { kind: 'before', minutes: 30 },
    { kind: 'day', daysBefore: 7, time: lastTime },
    { kind: 'before', minutes: 60 },
    { kind: 'day', daysBefore: 2, time: lastTime },
    { kind: 'day', daysBefore: 3, time: lastTime },
    { kind: 'before', minutes: 15 },
    { kind: 'before', minutes: 120 },
  ];
  const key = (s: AlarmSpec): string => (s.kind === 'before' ? `before-${s.minutes}` : `day-${s.daysBefore}-${s.time}`);
  const taken = new Set(existing.map(key));
  return candidates.find((c) => !taken.has(key(c))) ?? DEFAULT_SPEC;
}
