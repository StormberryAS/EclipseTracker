// The calendar file (spec section 7): one eclipse as an RFC 5545 event at greatest eclipse, with one
// alarm (VALARM) for each alarm the person chose. The person saves it and opens it in their own
// calendar, which then rings the alarms. The app keeps nothing.
//
//   * The event starts at greatest eclipse, in UTC, to the minute (DTSTART:...Z), and lasts
//     EVENT_MINUTES. It is marked free time (TRANSP:TRANSPARENT).
//   * Every alarm is a trigger relative to the start, a duration (TRIGGER:-P1DT5H, TRIGGER:-PT30M;
//     positive, TRIGGER:PT11H47M, for an alarm after greatest eclipse). For "at a time of day"
//     alarms the duration is worked out from the device's own time zone when the file is made, so
//     it rings at the same instant the page shows: the file holds no time zone and no zone name, and
//     an alarm does not follow the person if they later change zone (the page says so).
//     (Decision ICS-3 as changed by Marcos on 2026-10-16, data review D-1: the absolute form,
//     TRIGGER;VALUE=DATE-TIME:...Z, is valid RFC 5545 but Fossify's importer reads every trigger
//     as a duration and turned it into an alarm at the start of the event.) The start is in UTC,
//     so a day in the duration is exactly 24 hours (RFC 5545 section 3.3.6).
//   * At most MAX_ALARMS alarms (data review D-7).
//   * An alarm that has passed or repeats another is left out (alarms.ts).
//   * Format, as the GDPRLetterBuilder file: CRLF line ends; lines folded at 75 octets counted in
//     UTF-8, never inside a character; TEXT values escaped (backslash, semicolon, comma, line breaks).
//   * Never in the file: a name, a place, the time zone or anything else about the person. The UID
//     is random (from the caller), so two files never collide in a calendar.

import { eclipseName, greatestMinute, magnitudeWords, utcWhen } from './format.js';
import type { Eclipse, PlannedAlarm } from './types.js';
import { MAX_ALARMS, ringing } from './alarms.js';

export const PRODID = '-//Stormberry AS//EclipseTracker 2.0//EN';

/** How long the event lasts, from greatest eclipse. */
export const EVENT_MINUTES = 30;

/** RFC 5545 section 3.3.11 TEXT escaping. */
export function escapeText(text: string): string {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** The UTF-8 length of one character (one code point), in octets. No TextEncoder: core/ has no DOM. */
function octets(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** Folds one content line at 75 octets (RFC 5545 section 3.1); continuation lines start with one space. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const n = octets(ch);
    if (size + n > 75) {
      out.push(current);
      current = ' ';
      size = 1;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join('\r\n');
}

/** A UTC instant as YYYYMMDDTHHMMSSZ. */
export function utcStamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * An RFC 5545 duration (section 3.3.6) of whole minutes, negative before the start: -30 ->
 * "-PT30M", -60 -> "-PT1H", -1740 -> "-P1DT5H", -10590 -> "-P7DT8H30M", 707 -> "PT11H47M",
 * 0 -> "PT0S". Days and hours, never weeks (a week cannot be combined with days).
 */
export function triggerDuration(minutes: number): string {
  if (!Number.isInteger(minutes)) throw new RangeError(`not whole minutes: ${minutes}`);
  if (minutes === 0) return 'PT0S';
  const a = Math.abs(minutes);
  const d = Math.floor(a / 1440);
  const h = Math.floor((a % 1440) / 60);
  const m = a % 60;
  const time = h || m ? `T${h ? `${h}H` : ''}${m ? `${m}M` : ''}` : '';
  return `${minutes < 0 ? '-' : ''}P${d ? `${d}D` : ''}${time}`;
}

/** The TRIGGER line of one alarm: its instant as a duration from the start of the event. */
export function triggerLine(fireAt: number, start: number): string {
  return `TRIGGER:${triggerDuration((fireAt - start) / 60_000)}`;
}

/** The event's title: "Annular solar eclipse". */
export function eventTitle(e: Eclipse): string {
  return eclipseName(e);
}

/** The event's description, plain text. Times in UTC only: the file carries no time zone. */
export function eventDescription(e: Eclipse): string {
  const mag = magnitudeWords(e);
  return [
    `${eclipseName(e)}. Greatest eclipse at ${utcWhen(greatestMinute(e))}.`,
    `${mag.label}: ${mag.value}.`,
    `Visible from: ${e.region}.`,
    ...(e.path ? [`Path of the ${e.type === 'hybrid' ? 'central' : e.type} eclipse: ${e.path}.`] : []),
    '',
    'Times from NASA\'s eclipse catalogue (Fred Espenak, NASA Goddard Space Flight Center), rounded to the minute.',
    'Made with EclipseTracker by Stormberry AS, eclipse.stormberry.as.',
  ].join('\n');
}

export interface IcsInput {
  readonly eclipse: Eclipse;
  /** From planAlarms(): only the alarms with status 'ok' go into the file. */
  readonly alarms: readonly PlannedAlarm[];
  /** 16 to 64 lower-case hex digits, random, from the caller (crypto.getRandomValues). */
  readonly uid: string;
  /** Now, epoch milliseconds. */
  readonly dtstamp: number;
}

/** The whole calendar file, CRLF line ends, ending in CRLF. */
export function buildIcs({ eclipse, alarms, uid, dtstamp }: IcsInput): string {
  if (!/^[0-9a-f]{16,64}$/.test(uid)) throw new RangeError('uid must be 16 to 64 hex digits');
  if (alarms.length > MAX_ALARMS) throw new RangeError(`at most ${MAX_ALARMS} alarms per eclipse, not ${alarms.length}`);
  const start = greatestMinute(eclipse);
  const title = eventTitle(eclipse);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}@eclipse.stormberry.as`,
    `DTSTAMP:${utcStamp(dtstamp)}`,
    `DTSTART:${utcStamp(start)}`,
    `DTEND:${utcStamp(start + EVENT_MINUTES * 60_000)}`,
    `SUMMARY:${escapeText(title)}`,
    `DESCRIPTION:${escapeText(eventDescription(eclipse))}`,
    'TRANSP:TRANSPARENT',
  ];
  for (const a of ringing(alarms)) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(title)}`,
      triggerLine(a.fireAt, start),
      'END:VALARM',
    );
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
