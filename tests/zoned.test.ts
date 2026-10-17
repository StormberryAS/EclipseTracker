// Time-zone arithmetic (core/zoned.js): offsets, local dates, and the gap and overlap rules of
// java.time's ZonedDateTime.of, which stage B uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addDays, deviceZone, isKnownZone, isWallTime, localDateTime, offsetMinutes, wallTimeToInstant, weekday } from '#core/zoned.js';
import { countdownParts, countdownWords, dateWords, longDate, offsetWords, shortDate } from '#core/format.js';

const at = (s: string): number => Date.parse(s);
const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

test('offsets in Oslo, Sydney, Kolkata and UTC', () => {
  assert.equal(offsetMinutes('Europe/Oslo', at('2027-01-15T12:00:00Z')), 60);
  assert.equal(offsetMinutes('Europe/Oslo', at('2027-07-15T12:00:00Z')), 120);
  assert.equal(offsetMinutes('Australia/Sydney', at('2027-01-15T12:00:00Z')), 660);
  assert.equal(offsetMinutes('Australia/Sydney', at('2027-07-15T12:00:00Z')), 600);
  assert.equal(offsetMinutes('Asia/Kolkata', at('2027-07-15T12:00:00Z')), 330);
  assert.equal(offsetMinutes('UTC', at('2027-07-15T12:00:00Z')), 0);
  assert.equal(offsetMinutes('America/New_York', at('2027-01-15T12:00:00Z')), -300);
  // Oslo's change: 01:00 UTC on the last Sunday of March.
  assert.equal(offsetMinutes('Europe/Oslo', at('2033-03-27T00:59:59Z')), 60);
  assert.equal(offsetMinutes('Europe/Oslo', at('2033-03-27T01:00:00Z')), 120);
});

test('local date and time', () => {
  assert.deepEqual(localDateTime('Europe/Oslo', at('2027-02-20T23:13:00Z')), { date: '2027-02-21', time: '00:13' });
  assert.deepEqual(localDateTime('UTC', at('2027-02-20T23:13:00Z')), { date: '2027-02-20', time: '23:13' });
  assert.deepEqual(localDateTime('Pacific/Pago_Pago', at('2100-01-01T05:00:00Z')), { date: '2099-12-31', time: '18:00' });
});

test('wall times: plain, the spring gap and the autumn overlap, north and south', () => {
  assert.deepEqual(wallTimeToInstant('Europe/Oslo', '2027-02-06', '12:00'), { epochMs: at('2027-02-06T11:00:00Z'), dst: 'none' });
  const gap = wallTimeToInstant('Europe/Oslo', '2033-03-27', '02:30');
  assert.equal(iso(gap.epochMs), '2033-03-27T01:30:00Z');
  assert.equal(gap.dst, 'gap');
  assert.deepEqual(localDateTime('Europe/Oslo', gap.epochMs), { date: '2033-03-27', time: '03:30' });
  // The edges of the gap: 02:00 does not exist either; 03:00 does.
  assert.equal(wallTimeToInstant('Europe/Oslo', '2033-03-27', '02:00').dst, 'gap');
  assert.deepEqual(wallTimeToInstant('Europe/Oslo', '2033-03-27', '03:00'), { epochMs: at('2033-03-27T01:00:00Z'), dst: 'none' });
  assert.deepEqual(wallTimeToInstant('Europe/Oslo', '2033-03-27', '01:59'), { epochMs: at('2033-03-27T00:59:00Z'), dst: 'none' });
  const overlap = wallTimeToInstant('Europe/Oslo', '2033-10-30', '02:30');
  assert.deepEqual(overlap, { epochMs: at('2033-10-30T00:30:00Z'), dst: 'overlap' });
  assert.deepEqual(wallTimeToInstant('Europe/Oslo', '2033-10-30', '03:00'), { epochMs: at('2033-10-30T02:00:00Z'), dst: 'none' });
  assert.deepEqual(wallTimeToInstant('Australia/Sydney', '2027-10-03', '02:30'), { epochMs: at('2027-10-02T16:30:00Z'), dst: 'gap' });
  assert.deepEqual(wallTimeToInstant('Australia/Sydney', '2027-04-04', '02:30'), { epochMs: at('2027-04-03T15:30:00Z'), dst: 'overlap' });
  assert.throws(() => wallTimeToInstant('Europe/Oslo', '2027-02-30x', '12:00'), RangeError);
  assert.throws(() => wallTimeToInstant('Europe/Oslo', '2027-02-06', '24:00'), RangeError);
});

test('dates', () => {
  assert.equal(addDays('2027-03-01', -1), '2027-02-28');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29');
  assert.equal(addDays('2027-01-02', -7), '2026-12-26');
  assert.equal(weekday('2027-02-06'), 6);
  assert.ok(isWallTime('00:00') && isWallTime('23:59') && !isWallTime('24:00') && !isWallTime('7:00') && !isWallTime(''));
  assert.ok(isKnownZone('Europe/Oslo') && !isKnownZone('Nowhere/Never'));
  assert.ok(isKnownZone(deviceZone()));
});

test('words: British dates, offsets with a true minus sign, the countdown', () => {
  assert.equal(dateWords('2027-02-06'), '6 February 2027');
  assert.equal(longDate('2027-02-06'), 'Saturday 6 February 2027');
  assert.equal(shortDate('2027-02-06'), 'Sat 6 Feb 2027');
  assert.equal(offsetWords(0), 'UTC');
  assert.equal(offsetWords(60), 'UTC+1');
  assert.equal(offsetWords(330), 'UTC+5:30');
  assert.equal(offsetWords(-300), 'UTC−5');
  assert.deepEqual(countdownParts(90061000), { days: 1, hours: 1, minutes: 1, seconds: 1 });
  assert.deepEqual(countdownParts(-5), { days: 0, hours: 0, minutes: 0, seconds: 0 });
  assert.equal(countdownWords(90061000), '1 day, 1 hour and 1 minute');
  assert.equal(countdownWords(59000), '0 minutes');
  assert.equal(countdownWords(2 * 3600000 + 5 * 60000), '2 hours and 5 minutes');
});

test('every clock change to 2100 in nine zones gives what zoneinfo gives (tests/dst-vectors.json, data review D-9)', () => {
  const doc = JSON.parse(readFileSync(new URL('./dst-vectors.json', import.meta.url), 'utf8'));
  assert.ok(!doc.zones.includes('Africa/Casablanca'), 'Morocco is left out (data review D-8)');
  let n = 0;
  const words = new Set();
  for (const zone of doc.zones) {
    assert.ok(doc.changes[zone].length >= 140, `${zone}: a change in spring and autumn, every year to 2100`);
    for (const change of doc.changes[zone]) {
      for (const [date, time, want, dst] of change.walls) {
        const got = wallTimeToInstant(zone, date, time);
        assert.deepEqual({ at: iso(got.epochMs), dst: got.dst }, { at: want, dst }, `${zone} ${date} ${time}`);
        words.add(dst);
        n += 1;
      }
    }
  }
  assert.equal(n, doc.rows);
  assert.deepEqual([...words].sort(), ['gap', 'none', 'overlap']);
});
