// Time-zone arithmetic with nothing but Intl: the offset of a zone at an instant, the local date
// and wall time of an instant, and the instant a local wall time names. Pure: the zone and the
// instant always come in as arguments, so Node, every browser and the tests give the same answer.
//
// Days the clocks change follow java.time's ZonedDateTime.of, which stage B (Android) uses and
// SunApp's alarm engine documents:
//   * gap (spring forward): a wall time that does not exist moves forward by the length of the gap,
//     so 02:30 on the night Oslo goes from 02:00 to 03:00 becomes 03:30;
//   * overlap (autumn back): a wall time that happens twice takes the first, earlier instant.
// Dates are ISO strings, YYYY-MM-DD; wall times are HH:MM, 24-hour.

import type { DstResolution } from './types.js';

const MINUTE = 60_000;
const DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

/** True when this runtime knows the IANA zone name. */
export function isKnownZone(zone: string): boolean {
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** The device's own zone, or 'UTC' when the runtime cannot tell. */
export function deviceZone(): string {
  try {
    const z = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return z && isKnownZone(z) ? z : 'UTC';
  } catch {
    return 'UTC';
  }
}

interface Parts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

function parts(zone: string, epochMs: number): Parts {
  const out: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  const get = (k: string): number => {
    const v = out[k];
    if (v === undefined || Number.isNaN(v)) throw new RangeError(`no ${k} for ${zone} at ${epochMs}`);
    return v;
  };
  const hour = get('hour');
  return { y: get('year'), m: get('month'), d: get('day'), hh: hour === 24 ? 0 : hour, mm: get('minute'), ss: get('second') };
}

/** The zone's offset from UTC at an instant, in whole minutes (east positive: Oslo in winter is 60). */
export function offsetMinutes(zone: string, epochMs: number): number {
  const p = parts(zone, epochMs);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  const whole = Math.floor(epochMs / 1000) * 1000;
  return Math.round((asUtc - whole) / MINUTE);
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** The local date and wall time of an instant: { date: '2027-02-06', time: '16:59' }. */
export function localDateTime(zone: string, epochMs: number): { date: string; time: string } {
  const p = parts(zone, epochMs);
  return { date: `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`, time: `${pad(p.hh)}:${pad(p.mm)}` };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** True for a wall time written HH:MM, 00:00 to 23:59. */
export function isWallTime(text: string): boolean {
  return TIME_RE.test(text);
}

/** The ISO date n days after (or, for negative n, before) the one given. */
export function addDays(iso: string, n: number): string {
  const m = DATE_RE.exec(iso);
  if (!m) throw new RangeError(`not a date: ${iso}`);
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Day of the week of an ISO date, 0 for Sunday to 6 for Saturday. */
export function weekday(iso: string): number {
  const m = DATE_RE.exec(iso);
  if (!m) throw new RangeError(`not a date: ${iso}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

/**
 * The instant a local date and wall time name in a zone, with the gap and overlap rules above.
 * Returns the instant and how it was resolved.
 */
export function wallTimeToInstant(zone: string, date: string, time: string): { epochMs: number; dst: DstResolution } {
  const dm = DATE_RE.exec(date);
  const tm = TIME_RE.exec(time);
  if (!dm) throw new RangeError(`not a date: ${date}`);
  if (!tm) throw new RangeError(`not a time: ${time}`);
  const wall = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]));
  // A clock change moves the offset at most once in a day in every zone in use, so the offsets a
  // day either side are the only two candidates.
  const before = offsetMinutes(zone, wall - DAY);
  const after = offsetMinutes(zone, wall + DAY);
  const valid = [...new Set([before, after])]
    .map((o) => wall - o * MINUTE)
    .filter((t) => offsetMinutes(zone, t) * MINUTE === wall - t)
    .sort((a, b) => a - b);
  const first = valid[0];
  if (first !== undefined) return { epochMs: first, dst: valid.length > 1 ? 'overlap' : 'none' };
  // The gap: read the wall time with the offset in force before the change, which lands it the
  // length of the gap later on the clock.
  return { epochMs: wall - before * MINUTE, dst: 'gap' };
}
