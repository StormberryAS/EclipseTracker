import { greatestMinute, minuteOf } from './format.js?v=118a26b0';
import { addDays, isKnownZone, isWallTime, localDateTime, offsetMinutes, wallTimeToInstant } from './zoned.js?v=d3e47120';
export const MAX_ALARMS = 8;
export const DEFAULT_TIME = '12:00';
export const DEFAULT_SPEC = { kind: 'day', daysBefore: 0, time: DEFAULT_TIME };
export function defaultSpecAt(anchor, zone) {
    return localDateTime(zone, anchor).time < DEFAULT_TIME
        ? { kind: 'day', daysBefore: 1, time: DEFAULT_TIME }
        : { kind: 'day', daysBefore: 0, time: DEFAULT_TIME };
}
export function plannerFrame(e, start, cityZone, deviceZone) {
    return start === undefined
        ? { anchor: greatestMinute(e), zone: deviceZone, local: false }
        : { anchor: minuteOf(start), zone: cityZone, local: true };
}
export const DAYS_BEFORE = [0, 1, 2, 3, 7];
export const MINUTES_BEFORE = [15, 30, 60, 120];
export const RECORD_GRACE_MS = 48 * 3600000;
export const MAX_START_OFFSET_MS = 6 * 3600000;
const MINUTE = 60000;
const RECORD_ID = /^[0-9a-f]{32}$/;
const ECLIPSE_ID = /^\d{4}-\d{2}-\d{2}-(solar|lunar)$/;
const START_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;
const ZONE_TEXT = /^[A-Z][A-Za-z0-9_+-]*(\/[A-Z][A-Za-z0-9_+-]*)*$/;
const PLACE_BAD = /[\u0000-\u001f\u007f-\u009f]/;
export function fireInstantAt(anchor, spec, zone) {
    if (spec.kind === 'before')
        return { epochMs: anchor - spec.minutes * MINUTE, dst: 'none' };
    const day = localDateTime(zone, anchor).date;
    return wallTimeToInstant(zone, addDays(day, -spec.daysBefore), spec.time);
}
export function fireInstant(e, spec, zone) {
    return fireInstantAt(greatestMinute(e), spec, zone);
}
export function planAlarmAt(anchor, spec, zone, now) {
    if (!isValidSpec(spec))
        throw new RangeError(`not an alarm: ${JSON.stringify(spec)}`);
    if (!isKnownZone(zone))
        throw new RangeError(`unknown time zone: ${zone}`);
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
export function planAlarm(e, spec, zone, now) {
    return planAlarmAt(greatestMinute(e), spec, zone, now);
}
export function planAlarmsAt(anchor, specs, zone, now) {
    if (specs.length > MAX_ALARMS)
        throw new RangeError(`at most ${MAX_ALARMS} alarms per eclipse, not ${specs.length}`);
    const seen = new Set();
    return specs.map((spec) => {
        const p = planAlarmAt(anchor, spec, zone, now);
        if (p.status !== 'ok')
            return p;
        if (seen.has(p.fireAt))
            return { ...p, status: 'duplicate' };
        seen.add(p.fireAt);
        return p;
    });
}
export function planAlarms(e, specs, zone, now) {
    return planAlarmsAt(greatestMinute(e), specs, zone, now);
}
export function ringing(planned) {
    return planned.filter((p) => p.status === 'ok').sort((a, b) => a.fireAt - b.fireAt);
}
export function isValidSpec(spec) {
    if (!spec || typeof spec !== 'object')
        return false;
    const s = spec;
    if (s.kind === 'before')
        return Object.keys(s).length === 2 && MINUTES_BEFORE.includes(s.minutes);
    if (s.kind === 'day') {
        return Object.keys(s).length === 3 && DAYS_BEFORE.includes(s.daysBefore) && typeof s.time === 'string' && isWallTime(s.time);
    }
    return false;
}
export function isRecordId(id) {
    return typeof id === 'string' && RECORD_ID.test(id);
}
function startMs(text) {
    if (typeof text !== 'string' || !START_TEXT.test(text))
        return undefined;
    const ms = Date.parse(text);
    return Number.isNaN(ms) || new Date(ms).toISOString().replace('.000Z', 'Z') !== text ? undefined : ms;
}
function isRecordZone(zone) {
    return typeof zone === 'string' && zone.length <= 200 && ZONE_TEXT.test(zone) && isKnownZone(zone);
}
export function isPlace(place) {
    return typeof place === 'string' && place.length >= 1 && place.length <= 200 && !PLACE_BAD.test(place);
}
export function isValidRecord(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r))
        return false;
    const o = r;
    const common = isRecordId(o.id) && typeof o.eclipseId === 'string' && ECLIPSE_ID.test(o.eclipseId) && isValidSpec(o.spec);
    if (o.v === 1)
        return Object.keys(o).length === 4 && common;
    if (o.v === 2)
        return Object.keys(o).length === 7 && common && startMs(o.start) !== undefined && isRecordZone(o.zone) && isPlace(o.place);
    return false;
}
export function recordAnchor(record, eclipse) {
    return record.v === 2 ? Date.parse(record.start) : greatestMinute(eclipse);
}
export function recordZone(record, zone) {
    return record.v === 2 ? record.zone : zone;
}
export function planRecord(record, eclipse, zone, now) {
    return planAlarmAt(recordAnchor(record, eclipse), record.spec, recordZone(record, zone), now);
}
export function isValidRecordSet(records) {
    if (!Array.isArray(records))
        return false;
    const ids = new Set();
    const perEclipse = new Map();
    for (const r of records) {
        if (!isValidRecord(r) || ids.has(r.id))
            return false;
        ids.add(r.id);
        const n = (perEclipse.get(r.eclipseId) ?? 0) + 1;
        if (n > MAX_ALARMS)
            return false;
        perEclipse.set(r.eclipseId, n);
    }
    return true;
}
export function recordFate(record, eclipse, zone, now) {
    if (!isValidRecord(record))
        return { action: 'delete', reason: 'invalid' };
    if (!eclipse || eclipse.id !== record.eclipseId)
        return { action: 'delete', reason: 'unknown-eclipse' };
    if (now >= greatestMinute(eclipse) + RECORD_GRACE_MS)
        return { action: 'delete', reason: 'expired' };
    if (record.v === 2 && Math.abs(Date.parse(record.start) - greatestMinute(eclipse)) > MAX_START_OFFSET_MS)
        return { action: 'delete', reason: 'invalid' };
    const { fireAt } = planRecord(record, eclipse, zone, now);
    return fireAt > now ? { action: 'arm', fireAt } : { action: 'delete', reason: 'passed' };
}
export function rowsFromRecords(records, eclipseId) {
    return records
        .filter((r) => isValidRecord(r) && r.eclipseId === eclipseId)
        .slice(0, MAX_ALARMS)
        .map((r) => ({ id: r.id, spec: r.spec }));
}
export function recordsFromRows(eclipseId, rows, newId, local) {
    if (!ECLIPSE_ID.test(eclipseId))
        throw new RangeError(`not an eclipse id: ${eclipseId}`);
    if (rows.length > MAX_ALARMS)
        throw new RangeError(`at most ${MAX_ALARMS} alarms per eclipse, not ${rows.length}`);
    const records = rows.map((row) => {
        const id = row.id ?? newId();
        if (!local)
            return { v: 1, id, eclipseId, spec: row.spec };
        return { v: 2, id, eclipseId, spec: row.spec, start: new Date(local.start).toISOString().replace('.000Z', 'Z'), zone: local.zone, place: local.place };
    });
    if (!isValidRecordSet(records))
        throw new RangeError('the rows do not make a valid set of records');
    return records;
}
export function choiceOf(spec) {
    return spec.kind === 'before' ? 'before' : `day-${spec.daysBefore}`;
}
export function specForChoice(choice, previous, lastTime = DEFAULT_TIME, lastMinutes = 30) {
    if (choice === 'before')
        return { kind: 'before', minutes: previous.kind === 'before' ? previous.minutes : lastMinutes };
    const days = Number(choice.replace('day-', ''));
    if (!DAYS_BEFORE.includes(days))
        throw new RangeError(`not a choice: ${choice}`);
    return { kind: 'day', daysBefore: days, time: previous.kind === 'day' ? previous.time : lastTime };
}
export function nextNewSpec(existing, lastTime = DEFAULT_TIME) {
    const candidates = [
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
    const key = (s) => (s.kind === 'before' ? `before-${s.minutes}` : `day-${s.daysBefore}-${s.time}`);
    const taken = new Set(existing.map(key));
    return candidates.find((c) => !taken.has(key(c))) ?? DEFAULT_SPEC;
}
