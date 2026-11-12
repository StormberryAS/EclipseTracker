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

import { greatestMinute, minuteOf } from './format.js';
import type { AlarmRecord, AlarmSpec, DaysBefore, Eclipse, LocalAnchor, MinutesBefore, PlannedAlarm, PlannerRow, RecordFate } from './types.js';
import { addDays, isKnownZone, isWallTime, localDateTime, offsetMinutes, wallTimeToInstant } from './zoned.js';

/** The most alarms one eclipse can have. */
export const MAX_ALARMS = 8;

/** The time of day every new "at a time of day" alarm starts with (Marcos, 2026-10-16). */
export const DEFAULT_TIME = '12:00';

/** The alarm a new planner starts with: on the day of the eclipse at 12:00. */
export const DEFAULT_SPEC: AlarmSpec = { kind: 'day', daysBefore: 0, time: DEFAULT_TIME };

/**
 * The alarm a new planner starts with when a city is chosen (Marcos, 2026-11-11): on the day at
 * 12:00, as without a city, unless the eclipse starts at the city before 12:00 local time. The
 * 12:00 of that day would then ring after the start, so the default is the day before at 12:00.
 * `anchor` is the minute the eclipse starts at the city, and `zone` the city's time zone.
 */
export function defaultSpecAt(anchor: number, zone: string): AlarmSpec {
  return localDateTime(zone, anchor).time < DEFAULT_TIME
    ? { kind: 'day', daysBefore: 1, time: DEFAULT_TIME }
    : { kind: 'day', daysBefore: 0, time: DEFAULT_TIME };
}

/** Where the planner counts from: the minute, the zone, and whether the alarms are for a city. */
export interface PlannerFrame {
  readonly anchor: number;
  readonly zone: string;
  /** True when the alarms count from the start at the city (version 2 records); false: greatest eclipse (version 1). */
  readonly local: boolean;
}

/**
 * Where the planner counts from (plan Q4, Marcos, 2026-11-12). `start` is the eclipse's start at
 * the chosen city, or undefined when no city is chosen or the city cannot see the eclipse. With a
 * start: that minute in the city's zone, and the ringing alarms are version 2 records. Without
 * one: greatest eclipse in the device's zone, exactly as with no city, so the ringing alarms stay
 * version 1 records and ring as in 2.0.1. Page only: the app plans each record from what it holds.
 */
export function plannerFrame(e: Pick<Eclipse, 'greatest'>, start: number | undefined, cityZone: string, deviceZone: string): PlannerFrame {
  return start === undefined
    ? { anchor: greatestMinute(e), zone: deviceZone, local: false }
    : { anchor: minuteOf(start), zone: cityZone, local: true };
}

export const DAYS_BEFORE: readonly DaysBefore[] = [0, 1, 2, 3, 7];
export const MINUTES_BEFORE: readonly MinutesBefore[] = [15, 30, 60, 120];

/**
 * How long after greatest eclipse a stored record is kept at most. No alarm can ring later: a time
 * of day on the local day of greatest eclipse is less than 24 hours of wall clock after it, plus at
 * most 2 hours when the clocks go back that day (Antarctica/Troll goes back 2 hours). 24 hours
 * would not be enough; 48 leaves a clear margin.
 */
export const RECORD_GRACE_MS = 48 * 3_600_000;

/**
 * The most a version 2 record's start may differ from greatest eclipse (EclipseTracker 2.1.0). The
 * start at a city is never more than 3.1 hours from it (the largest of the 2,137 city cases in
 * tests/local-vectors.json); 6 hours leaves a clear margin. Android cannot work out a local start
 * itself, so this bound is the check it has: a record outside it cannot come from the page.
 */
export const MAX_START_OFFSET_MS = 6 * 3_600_000;

const MINUTE = 60_000;
const RECORD_ID = /^[0-9a-f]{32}$/;
const ECLIPSE_ID = /^\d{4}-\d{2}-\d{2}-(solar|lunar)$/;
/** A start in the contract's one format with the seconds at 00. */
const START_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;
/** An IANA region name: every segment starts with a capital letter (the tz database's names do), as java.time reads them. */
const ZONE_TEXT = /^[A-Z][A-Za-z0-9_+-]*(\/[A-Z][A-Za-z0-9_+-]*)*$/;
const PLACE_BAD = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The instant an alarm rings, and how a clock change was resolved, before any status is decided.
 * `anchor` is the minute the alarms count from: greatest eclipse (rounded to the minute) as the
 * list shows it, or, with a city chosen, the minute the eclipse starts there. "Before" is minutes
 * before the anchor; "at a time of day" is that wall time in `zone`, on the local date of the
 * anchor in that zone minus the days chosen.
 */
export function fireInstantAt(anchor: number, spec: AlarmSpec, zone: string): { epochMs: number; dst: PlannedAlarm['dst'] } {
  if (spec.kind === 'before') return { epochMs: anchor - spec.minutes * MINUTE, dst: 'none' };
  const day = localDateTime(zone, anchor).date;
  return wallTimeToInstant(zone, addDays(day, -spec.daysBefore), spec.time);
}

/** The instant an alarm rings for an eclipse, counted from greatest eclipse. */
export function fireInstant(e: Pick<Eclipse, 'greatest'>, spec: AlarmSpec, zone: string): { epochMs: number; dst: PlannedAlarm['dst'] } {
  return fireInstantAt(greatestMinute(e), spec, zone);
}

/**
 * One alarm, planned from an anchor minute. Its status is 'ok' or 'past'; planAlarmsAt() also finds
 * duplicates. `afterGreatest` keeps its name for the stage B contract; it means "after the anchor".
 */
export function planAlarmAt(anchor: number, spec: AlarmSpec, zone: string, now: number): PlannedAlarm {
  if (!isValidSpec(spec)) throw new RangeError(`not an alarm: ${JSON.stringify(spec)}`);
  if (!isKnownZone(zone)) throw new RangeError(`unknown time zone: ${zone}`);
  const { epochMs, dst } = fireInstantAt(anchor, spec, zone);
  const local = localDateTime(zone, epochMs);
  return {
    spec,
    fireAt: epochMs,
    localDate: local.date,
    localTime: local.time,
    offsetMinutes: offsetMinutes(zone, epochMs),
    status: epochMs > now ? 'ok' : 'past',
    afterGreatest: epochMs > anchor,
    dst,
  };
}

/** One alarm, planned from greatest eclipse. */
export function planAlarm(e: Pick<Eclipse, 'greatest'>, spec: AlarmSpec, zone: string, now: number): PlannedAlarm {
  return planAlarmAt(greatestMinute(e), spec, zone, now);
}

/**
 * Several alarms counted from one anchor minute, in the order given; a later alarm at the same
 * minute as an earlier one is a duplicate. More than MAX_ALARMS is refused.
 */
export function planAlarmsAt(anchor: number, specs: readonly AlarmSpec[], zone: string, now: number): PlannedAlarm[] {
  if (specs.length > MAX_ALARMS) throw new RangeError(`at most ${MAX_ALARMS} alarms per eclipse, not ${specs.length}`);
  const seen = new Set<number>();
  return specs.map((spec) => {
    const p = planAlarmAt(anchor, spec, zone, now);
    if (p.status !== 'ok') return p;
    if (seen.has(p.fireAt)) return { ...p, status: 'duplicate' };
    seen.add(p.fireAt);
    return p;
  });
}

/**
 * Several alarms for one eclipse, counted from greatest eclipse, in the order given; a later alarm
 * at the same minute as an earlier one is a duplicate. More than MAX_ALARMS is refused.
 */
export function planAlarms(e: Pick<Eclipse, 'greatest'>, specs: readonly AlarmSpec[], zone: string, now: number): PlannedAlarm[] {
  return planAlarmsAt(greatestMinute(e), specs, zone, now);
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

/** The epoch ms of a start text, or undefined unless the text is a real instant in the contract's format with the seconds at 00. */
function startMs(text: unknown): number | undefined {
  if (typeof text !== 'string' || !START_TEXT.test(text)) return undefined;
  const ms = Date.parse(text);
  // A round trip: 24:00 and 02-30 are read by Date.parse as other instants, so only a real one comes back unchanged.
  return Number.isNaN(ms) || new Date(ms).toISOString().replace('.000Z', 'Z') !== text ? undefined : ms;
}

/** True for a city's time zone as a version 2 record keeps it: an IANA region name this runtime knows, never a fixed offset. */
function isRecordZone(zone: unknown): zone is string {
  return typeof zone === 'string' && zone.length <= 200 && ZONE_TEXT.test(zone) && isKnownZone(zone);
}

/** True for a place name as a version 2 record keeps it: 1 to 200 characters, no control character. */
export function isPlace(place: unknown): place is string {
  return typeof place === 'string' && place.length >= 1 && place.length <= 200 && !PLACE_BAD.test(place);
}

/**
 * True for one alarm record stage B can store (spec section 9.4): version 1 has exactly v, id,
 * eclipseId and spec; version 2 (EclipseTracker 2.1.0) has exactly those and start, zone and place.
 */
export function isValidRecord(r: unknown): r is AlarmRecord {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
  const o = r as Record<string, unknown>;
  const common = isRecordId(o.id) && typeof o.eclipseId === 'string' && ECLIPSE_ID.test(o.eclipseId) && isValidSpec(o.spec);
  if (o.v === 1) return Object.keys(o).length === 4 && common;
  if (o.v === 2) return Object.keys(o).length === 7 && common && startMs(o.start) !== undefined && isRecordZone(o.zone) && isPlace(o.place);
  return false;
}

/** The minute a record counts from: the start at its city (version 2), else greatest eclipse. */
export function recordAnchor(record: AlarmRecord, eclipse: Pick<Eclipse, 'greatest'>): number {
  return record.v === 2 ? Date.parse(record.start) : greatestMinute(eclipse);
}

/** The zone a record works in: its city's (version 2, wherever the phone is), else the phone's. */
export function recordZone(record: AlarmRecord, zone: string): string {
  return record.v === 2 ? record.zone : zone;
}

/** One stored record planned: from its own anchor, in its own zone. */
export function planRecord(record: AlarmRecord, eclipse: Pick<Eclipse, 'greatest'>, zone: string, now: number): PlannedAlarm {
  return planAlarmAt(recordAnchor(record, eclipse), record.spec, recordZone(record, zone), now);
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
  // A version 2 start far from greatest eclipse cannot come from the page: invalid, after the expiry test.
  if (record.v === 2 && Math.abs(Date.parse(record.start) - greatestMinute(eclipse)) > MAX_START_OFFSET_MS) return { action: 'delete', reason: 'invalid' };
  const { fireAt } = planRecord(record, eclipse, zone, now);
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
 * more than MAX_ALARMS rows. With `local` (a city is chosen) every record is version 2 and counts
 * from the start at the city; without it, version 1.
 */
export function recordsFromRows(eclipseId: string, rows: readonly PlannerRow[], newId: () => string, local?: LocalAnchor): AlarmRecord[] {
  if (!ECLIPSE_ID.test(eclipseId)) throw new RangeError(`not an eclipse id: ${eclipseId}`);
  if (rows.length > MAX_ALARMS) throw new RangeError(`at most ${MAX_ALARMS} alarms per eclipse, not ${rows.length}`);
  const records = rows.map((row): AlarmRecord => {
    const id = row.id ?? newId();
    if (!local) return { v: 1, id, eclipseId, spec: row.spec };
    return { v: 2, id, eclipseId, spec: row.spec, start: new Date(local.start).toISOString().replace('.000Z', 'Z'), zone: local.zone, place: local.place };
  });
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
