// The words and the zone handling for an eclipse seen from a city (city filter, 11 November 2026):
// the local type, the notes, the covered fraction, the Moon's height, times in the city's zone with
// the date when it differs from the start's, and the list functions that take the minute an eclipse
// counts from. The house style (no en or em dash, no double hyphen, no exclamation mark) holds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ECLIPSES } from '#core/data.js';
import { nextEclipse, upcoming } from '#core/eclipses.js';
import { clockWhen, coveredWords, localEndWords, localListWords, localMagnitude, localMaximumWords, localName, localNotes, localWhen, minuteOf, moonHeightWords } from '#core/format.js';
import { localAll, localFor } from '#core/local.js';
import type { Local } from '#core/local.js';
import { defined } from './helpers.ts';

const base: Local = { id: 'x', type: 'partial', start: 0, end: 0, max: 0, startsAtRise: false, endsAtSet: false, gap: false };
const eclipse = (id: string) => defined(ECLIPSES.find((e) => e.id === id), id);

test('the local type names the eclipse as the city sees it', () => {
  assert.equal(localName('solar', { type: 'partial' }), 'Partial solar eclipse');
  assert.equal(localName('solar', { type: 'total' }), 'Total solar eclipse');
  assert.equal(localName('solar', { type: 'annular' }), 'Annular solar eclipse');
  assert.equal(localName('lunar', { type: 'penumbral' }), 'Penumbral lunar eclipse');
});

test('notes: already under way at sunrise or moonrise, sets before it ends, faint', () => {
  assert.deepEqual(localNotes('solar', { ...base, startsAtRise: true, endsAtSet: true }), ['Already under way at sunrise.', 'The Sun sets before it ends.']);
  assert.deepEqual(localNotes('lunar', { ...base, startsAtRise: true, endsAtSet: true }), ['Already under way at moonrise.', 'The Moon sets before it ends.']);
  assert.deepEqual(localNotes('lunar', { ...base, type: 'penumbral' }), ['Faint: the Moon darkens only a little.']);
  // At 66 degrees of latitude or more the body can set and rise again inside the eclipse.
  assert.deepEqual(localNotes('lunar', { ...base, startsAtRise: false, gap: true }), ['The Moon sets and rises again during it.']);
  assert.deepEqual(localNotes('solar', { ...base, gap: true, endsAtSet: true }), ['The Sun sets and rises again during it.', 'The Sun sets before it ends.']);
  assert.deepEqual(localNotes('solar', base), []);
});

test('the covered fraction: whole per cent, under half a per cent reads "less than 1%", only a total eclipse reads 100', () => {
  assert.equal(coveredWords({ type: 'partial', obscuration: 0.8499 }), '85% of the Sun covered');
  assert.equal(coveredWords({ type: 'partial', obscuration: 0 }), 'less than 1% of the Sun covered');
  assert.equal(coveredWords({ type: 'partial', obscuration: 0.0049 }), 'less than 1% of the Sun covered');
  assert.equal(coveredWords({ type: 'partial', obscuration: 0.005 }), '1% of the Sun covered');
  assert.equal(coveredWords({ type: 'partial', obscuration: 0.9996 }), '99% of the Sun covered');
  assert.equal(coveredWords({ type: 'annular', obscuration: 0.9996 }), '99% of the Sun covered');
  assert.equal(coveredWords({ type: 'total', obscuration: 1 }), '100% of the Sun covered');
  assert.equal(localMagnitude({ type: 'partial', magnitude: 0.8765 }), '0.88');
  assert.equal(localMagnitude({ type: 'total', magnitude: 1.0501 }), '1.05');
  // A partial or annular eclipse never reads 1.00 (0.995 and over shows as 0.99); a total one may.
  assert.equal(localMagnitude({ type: 'partial', magnitude: 0.9997 }), '0.99');
  assert.equal(localMagnitude({ type: 'annular', magnitude: 0.9951 }), '0.99');
  assert.equal(localMagnitude({ type: 'total', magnitude: 1.0001 }), '1.00');
});

test('the Moon height: whole degrees, "at the horizon" under half a degree', () => {
  assert.equal(moonHeightWords({ altitude: 12.4 }), 'the Moon 12° above the horizon');
  assert.equal(moonHeightWords({ altitude: 12.5 }), 'the Moon 13° above the horizon');
  assert.equal(moonHeightWords({ altitude: 0.49 }), 'the Moon at the horizon');
  assert.equal(moonHeightWords({ altitude: -0.6 }), 'the Moon at the horizon');
});

test('times in the city\'s zone: the clock alone on the start\'s date, the date with it on another', () => {
  // Sydney is UTC+10 in August: 22:30 UTC on 1 August is 08:30 on 2 August; 06:00 UTC on 2 August is 16:00 the same day; 20:00 UTC is 06:00 on 3 August.
  const start = Date.parse('2027-08-01T22:30:00Z');
  assert.equal(clockWhen('Australia/Sydney', Date.parse('2027-08-02T06:00:00Z'), '2027-08-02'), '16:00');
  assert.equal(clockWhen('Australia/Sydney', Date.parse('2027-08-02T20:00:00Z'), '2027-08-02'), 'Tue 3 Aug 2027, 06:00');
  assert.equal(localWhen('Australia/Sydney', start), 'Monday 2 August 2027 at 08:30 (UTC+10)');
  const l: Local = { ...base, start, max: Date.parse('2027-08-02T23:10:00Z'), end: Date.parse('2027-08-03T00:20:00Z'), magnitude: 0.5, obscuration: 0.4 };
  assert.equal(localEndWords(l, 'Australia/Sydney'), 'Tue 3 Aug 2027, 10:20');
  assert.equal(localMaximumWords('solar', l, 'Australia/Sydney'), 'Tue 3 Aug 2027, 09:10, magnitude 0.50, 40% of the Sun covered');
  assert.equal(localMaximumWords('lunar', { ...l, altitude: 30.2 }, 'Australia/Sydney'), 'Tue 3 Aug 2027, 09:10, the Moon 30° above the horizon');
  // The same instants in Honolulu (UTC-10): the previous day.
  assert.equal(localWhen('Pacific/Honolulu', start), 'Sunday 1 August 2027 at 12:30 (UTC−10)');
});

test('the list line: solar and lunar, and the faint note for a penumbral eclipse', () => {
  assert.equal(localListWords('solar', 'Bergen', { ...base, magnitude: 0.8765, obscuration: 0.8499 }), 'Seen from Bergen: partial, magnitude 0.88, 85% of the Sun covered.');
  assert.equal(localListWords('lunar', 'Bergen', { ...base, type: 'total', altitude: 14.6 }), 'Seen from Bergen: total, the Moon 15° above the horizon at maximum.');
  assert.equal(localListWords('lunar', 'Bergen', { ...base, type: 'penumbral', altitude: 0.2 }), 'Seen from Bergen: penumbral, the Moon at the horizon at maximum. Faint: the Moon darkens only a little.');
});

test('every word the city adds follows the house style: no en or em dash, no double hyphen, no exclamation mark', () => {
  const bergen = { lat: 60.393, lon: 5.3242 };
  const text: string[] = [];
  for (const [id, l] of localAll(bergen)) {
    const kind = id.endsWith('solar') ? 'solar' : 'lunar';
    text.push(localName(kind, l), ...localNotes(kind, l), localListWords(kind, 'Bergen', l), localMaximumWords(kind, l, 'Europe/Oslo'), localEndWords(l, 'Europe/Oslo'));
  }
  assert.ok(text.length > 500);
  for (const t of text) assert.doesNotMatch(t, /[–—]|--|!/, t);
});

test('upcoming and nextEclipse take the minute an eclipse counts from; the default is greatest eclipse', () => {
  const now = Date.parse('2027-08-02T08:40:00Z');
  const e = eclipse('2027-08-02-solar');
  const cairo = { lat: 30.0626, lon: 31.2497 };
  const local = defined(localFor(e, cairo), 'Cairo');
  const startMinute = minuteOf(local.start); // 08:33 UTC, before now
  assert.ok(startMinute < now);
  // By greatest eclipse (09:06 UTC) the eclipse is still to come; by its start at Cairo it has begun.
  assert.equal(nextEclipse(now)?.id, '2027-08-02-solar');
  assert.notEqual(nextEclipse(now, ECLIPSES, (x) => (x.id === e.id ? startMinute : Date.parse(x.greatest)))?.id, '2027-08-02-solar');
  assert.equal(upcoming(now, ECLIPSES).filter((x) => x.id === e.id).length, 1);
  assert.equal(upcoming(now, ECLIPSES, (x) => (x.id === e.id ? startMinute : Date.parse(x.greatest))).filter((x) => x.id === e.id).length, 0);
  // The filter by city: only the eclipses seen from there, in order.
  const seen = localAll(cairo);
  const list = upcoming(Date.parse('2026-11-11T12:00:00Z'), ECLIPSES.filter((x) => seen.has(x.id)), (x) => minuteOf(defined(seen.get(x.id), x.id).start));
  assert.ok(list.length === 140);
  assert.deepEqual(list.map((x) => x.id), [...list.map((x) => x.id)].sort());
});
