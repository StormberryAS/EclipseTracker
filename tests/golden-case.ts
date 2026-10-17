// The golden calendar file's inputs, shared by tests/ics.test.ts and tests/update-goldens.ts.
// The 2027-02-06 annular solar eclipse, planned in Europe/Oslo on 16 October 2026 with four alarms:
// on the day at 12:00, 1 day before at 12:00, 1 week before at 08:30, and 30 minutes before.

import { planAlarms } from '#core/alarms.js';
import { eclipseById } from '#core/eclipses.js';
import { buildIcs } from '#core/ics.js';
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
