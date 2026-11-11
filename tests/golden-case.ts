// The golden calendar file's inputs, shared by tests/ics.test.ts and tests/update-goldens.ts.
// The 2027-02-06 annular solar eclipse, planned in Europe/Oslo on 16 October 2026 with four alarms:
// on the day at 12:00, 1 day before at 12:00, 1 week before at 08:30, and 30 minutes before.

import { planAlarms, planAlarmsAt } from '#core/alarms.js';
import { eclipseById } from '#core/eclipses.js';
import { buildIcs } from '#core/ics.js';
import { minuteOf } from '#core/format.js';
import { localFor } from '#core/local.js';
import type { AlarmSpec } from '#core/types.js';
import { defined } from './helpers.ts';

export const GOLDEN_SPECS: readonly AlarmSpec[] = [
  { kind: 'day', daysBefore: 0, time: '12:00' },
  { kind: 'day', daysBefore: 1, time: '12:00' },
  { kind: 'day', daysBefore: 7, time: '08:30' },
  { kind: 'before', minutes: 30 },
];

export function goldenIcs(): string {
  const eclipse = defined(eclipseById('2027-02-06-solar'), 'the 2027-02-06 solar eclipse');
  const now = Date.parse('2026-10-16T10:30:00Z');
  return buildIcs({ eclipse, alarms: planAlarms(eclipse, GOLDEN_SPECS, 'Europe/Oslo', now), uid: '0123456789abcdef0123456789abcdef', dtstamp: now });
}

/** Cairo, as the catalogue has it (City of Cairo, Egypt, Africa/Cairo). */
export const CAIRO = { name: 'Cairo', country: 'Egypt', lat: 30.0626, lon: 31.2497, tz: 'Africa/Cairo' };

/**
 * The golden calendar file for a city (city filter, 11 November 2026): the 2027-08-02 solar eclipse
 * as seen from Cairo, planned on 11 November 2026 with two alarms counted from the minute the
 * eclipse starts there: on the day at 12:00 (Cairo's zone) and 30 minutes before.
 */
export function cairoIcs(): string {
  const eclipse = defined(eclipseById('2027-08-02-solar'), 'the 2027-08-02 solar eclipse');
  const local = defined(localFor(eclipse, CAIRO), 'the eclipse seen from Cairo');
  const now = Date.parse('2026-11-11T12:00:00Z');
  const specs: AlarmSpec[] = [{ kind: 'day', daysBefore: 0, time: '12:00' }, { kind: 'before', minutes: 30 }];
  return buildIcs({
    eclipse, alarms: planAlarmsAt(minuteOf(local.start), specs, CAIRO.tz, now), uid: '0123456789abcdef0123456789abcdef', dtstamp: now,
    local: { place: `${CAIRO.name}, ${CAIRO.country}`, city: CAIRO.name, zone: CAIRO.tz, local },
  });
}
