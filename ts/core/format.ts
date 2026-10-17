// The words and numbers the page shows, in British English. Pure: no Date.now(), no locale look-ups
// (Intl is used only through zoned.ts, for the time zone), so Node and every browser give the same
// text. No dashes of any kind in the output: ranges and pauses use words or commas.

import type { AlarmSpec, Eclipse, EclipseType } from './types.js';
import { localDateTime, offsetMinutes, weekday } from './zoned.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const TYPE_WORDS: Readonly<Record<EclipseType, string>> = {
  total: 'Total',
  annular: 'Annular',
  hybrid: 'Hybrid',
  partial: 'Partial',
  penumbral: 'Penumbral',
};

/** "Total solar eclipse", "Penumbral lunar eclipse". */
export function eclipseName(e: Pick<Eclipse, 'kind' | 'type'>): string {
  return `${TYPE_WORDS[e.type]} ${e.kind} eclipse`;
}

/** The year, the month's name and the day of an ISO date: "2027-02-06" -> 2027, "February", 6. */
function dateParts(iso: string): { y: number; month: string; d: number; dayName: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  const dayName = DAYS[weekday(iso)];
  if (!m || month === undefined || dayName === undefined) throw new RangeError(`not a date: ${iso}`);
  return { y: Number(m[1]), month, d: Number(m[3]), dayName };
}

/** "6 February 2027" from "2027-02-06". */
export function dateWords(iso: string): string {
  const { y, month, d } = dateParts(iso);
  return `${d} ${month} ${y}`;
}

/** "Saturday 6 February 2027". */
export function longDate(iso: string): string {
  return `${dateParts(iso).dayName} ${dateWords(iso)}`;
}

/** "Sat 6 Feb 2027": for the list, where space is short. */
export function shortDate(iso: string): string {
  const { y, month, d, dayName } = dateParts(iso);
  return `${dayName.slice(0, 3)} ${d} ${month.slice(0, 3)} ${y}`;
}

/** "UTC", "UTC+1", "UTC+5:30", "UTC−3" (a true minus sign, not a hyphen). */
export function offsetWords(minutes: number): string {
  if (minutes === 0) return 'UTC';
  const sign = minutes > 0 ? '+' : '−';
  const a = Math.abs(minutes);
  const h = Math.floor(a / 60);
  const m = a % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/**
 * The instant of greatest eclipse rounded to the nearest minute, half a minute up, epoch
 * milliseconds: floor((ms + 30000) / 60000) * 60000, written so for the Kotlin port (spec 9.5).
 * 17:12:30 becomes 17:13:00. Every time the page shows, counts down to or plans from is this one.
 */
export function greatestMinute(e: Pick<Eclipse, 'greatest'>): number {
  return Math.floor((Date.parse(e.greatest) + 30_000) / 60_000) * 60_000;
}

/** "Saturday 6 February 2027 at 16:59 (UTC+1)": an instant in a zone, to the minute. */
export function localWhen(zone: string, epochMs: number): string {
  const { date, time } = localDateTime(zone, epochMs);
  return `${longDate(date)} at ${time} (${offsetWords(offsetMinutes(zone, epochMs))})`;
}

/** "15:59 UTC on 6 February 2027". */
export function utcWhen(epochMs: number): string {
  const { date, time } = localDateTime('UTC', epochMs);
  return `${time} UTC on ${dateWords(date)}`;
}

/** The magnitude line: label and value. The value is the data's shownMagnitude, never re-rounded (data review D-5). */
export function magnitudeWords(e: Pick<Eclipse, 'kind' | 'type' | 'shownMagnitude'>): { label: string; value: string } {
  const label = e.kind === 'solar' ? 'Magnitude' : e.type === 'penumbral' ? 'Penumbral magnitude' : 'Umbral magnitude';
  return { label, value: e.shownMagnitude };
}

/** The countdown digits, days:hours:minutes:seconds, from milliseconds (never negative). */
export function countdownParts(ms: number): { days: number; hours: number; minutes: number; seconds: number } {
  const s = Math.max(0, Math.floor(ms / 1000));
  return { days: Math.floor(s / 86400), hours: Math.floor((s % 86400) / 3600), minutes: Math.floor((s % 3600) / 60), seconds: s % 60 };
}

/** "123 days, 4 hours and 5 minutes": the countdown in words, for screen readers. */
export function countdownWords(ms: number): string {
  const { days, hours, minutes } = countdownParts(ms);
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const bits = [days ? unit(days, 'day') : '', hours ? unit(hours, 'hour') : '', unit(minutes, 'minute')].filter(Boolean);
  const last = bits.pop() ?? '';
  return bits.length > 0 ? `${bits.join(', ')} and ${last}` : last;
}

const BEFORE_WORDS: Readonly<Record<number, string>> = { 15: '15 minutes', 30: '30 minutes', 60: '1 hour', 120: '2 hours' };
const DAY_WORDS: Readonly<Record<number, string>> = { 0: 'On the day of the eclipse', 1: '1 day before', 2: '2 days before', 3: '3 days before', 7: '1 week before' };

/** "On the day of the eclipse at 12:00", "1 week before at 08:30", "30 minutes before greatest eclipse". */
export function alarmWords(spec: AlarmSpec): string {
  if (spec.kind === 'before') return `${BEFORE_WORDS[spec.minutes]} before greatest eclipse`;
  return `${DAY_WORDS[spec.daysBefore]} at ${spec.time}`;
}

/** The labels of the choices, in the order the planner offers them. */
export const DAY_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'day-0', label: 'On the day of the eclipse' },
  { value: 'day-1', label: '1 day before' },
  { value: 'day-2', label: '2 days before' },
  { value: 'day-3', label: '3 days before' },
  { value: 'day-7', label: '1 week before' },
  { value: 'before', label: 'Before greatest eclipse' },
];

export const BEFORE_CHOICES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 15, label: '15 minutes before' },
  { value: 30, label: '30 minutes before' },
  { value: 60, label: '1 hour before' },
  { value: 120, label: '2 hours before' },
];

/** The pattern every calendar file name matches; stage B checks a name from the page against it (spec 9.6). */
export const ICS_FILE_NAME = /^eclipse-\d{4}-\d{2}-\d{2}-(solar|lunar)\.ics$/;

/** The calendar file's name: the eclipse and nothing else. "eclipse-2027-02-06-solar.ics". */
export function icsFileName(e: Pick<Eclipse, 'id'>): string {
  const name = `eclipse-${e.id}.ics`;
  if (!ICS_FILE_NAME.test(name)) throw new RangeError(`not an eclipse id: ${e.id}`);
  return name;
}

/** True for a calendar file name this app makes (and nothing else: no path, no other extension). */
export function isIcsFileName(name: unknown): name is string {
  return typeof name === 'string' && ICS_FILE_NAME.test(name);
}
