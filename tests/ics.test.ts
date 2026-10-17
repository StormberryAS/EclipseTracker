// The calendar file (spec section 7): a golden file byte for byte, RFC 5545 shape, every trigger a
// duration from the start (ICS-3 as changed by Marcos on 2026-10-16, data review D-1: never an
// absolute VALUE=DATE-TIME trigger) ringing at exactly the planned instant, alarms left out when
// passed or repeated, at most 8, escaping, folding at 75 octets, and nothing about the person.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_ALARMS, planAlarms, ringing } from '#core/alarms.js';
import { ECLIPSES } from '#core/data.js';
import { icsFileName, isIcsFileName } from '#core/format.js';
import { EVENT_MINUTES, PRODID, buildIcs, escapeText, foldLine, triggerDuration, utcStamp } from '#core/ics.js';
import { goldenIcs } from './golden-case.ts';
import type { AlarmSpec, Eclipse } from '#core/types.js';
import { defined } from './helpers.ts';

const octets = (s: string): number => Buffer.byteLength(s, 'utf8');
const unfold = (ics: string): string => ics.replace(/\r\n[ \t]/g, '');
const lines = (ics: string): string[] => unfold(ics).split('\r\n').slice(0, -1);
const byId = (id: string): Eclipse => defined(ECLIPSES.find((e) => e.id === id), id);

test('the golden calendar file, byte for byte', () => {
  const want = readFileSync(new URL('./goldens/eclipse-2027-02-06-solar.ics', import.meta.url), 'utf8');
  assert.equal(goldenIcs(), want);
});

test('RFC 5545 shape: CRLF everywhere, required properties, the event at greatest eclipse in UTC for EVENT_MINUTES', () => {
  const ics = goldenIcs();
  assert.ok(ics.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'every line ends in CRLF');
  const l = lines(ics);
  assert.equal(l[0], 'BEGIN:VCALENDAR');
  assert.equal(l.at(-1), 'END:VCALENDAR');
  for (const want of ['VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT', 'END:VEVENT', 'TRANSP:TRANSPARENT',
    'UID:0123456789abcdef0123456789abcdef@eclipse.stormberry.as', 'DTSTAMP:20261016T103000Z', 'DTSTART:20270206T160000Z', 'DTEND:20270206T163000Z',
    'SUMMARY:Annular solar eclipse']) assert.ok(l.includes(want), want);
  assert.equal(EVENT_MINUTES, 30);
  assert.ok(!l.some((x) => /TZID|VTIMEZONE|VALUE=DATE:/.test(x)), 'no time zone in the file');
  const depth = l.reduce((d, x) => d + (x.startsWith('BEGIN:') ? 1 : x.startsWith('END:') ? -1 : 0), 0);
  assert.equal(depth, 0);
});

test('one VALARM per alarm, every trigger a duration from the start of the event, in ringing order', () => {
  const l = lines(goldenIcs());
  // The event starts at greatest eclipse, 16:00 UTC (17:00 in Oslo).
  assert.deepEqual(l.filter((x) => x.startsWith('TRIGGER')), [
    'TRIGGER:-P7DT8H30M', // 1 week before at 08:30 Oslo (UTC+1): 07:30 UTC on 30 January
    'TRIGGER:-P1DT5H', // 1 day before at 12:00: 11:00 UTC on 5 February
    'TRIGGER:-PT5H', // on the day at 12:00: 11:00 UTC
    'TRIGGER:-PT30M', // 30 minutes before greatest eclipse
  ]);
  assert.equal(l.filter((x) => x === 'BEGIN:VALARM').length, 4);
  assert.equal(l.filter((x) => x === 'ACTION:DISPLAY').length, 4);
});

test('durations: days and hours and minutes, never weeks; positive after greatest eclipse; zero', () => {
  const cases: Array<[number, string]> = [[-15, '-PT15M'], [-30, '-PT30M'], [-60, '-PT1H'], [-120, '-PT2H'], [-300, '-PT5H'], [-1740, '-P1DT5H'], [-10590, '-P7DT8H30M'],
    [-1440, '-P1D'], [-10080, '-P7D'], [707, 'PT11H47M'], [1, 'PT1M'], [1439, 'PT23H59M'], [0, 'PT0S']];
  for (const [minutes, want] of cases) assert.equal(triggerDuration(minutes), want, String(minutes));
  assert.throws(() => triggerDuration(0.5), RangeError);
});

/** The instant a duration trigger names, from the start of the event. */
function triggerInstant(start: number, trigger: string): number {
  const m = /^TRIGGER:(-?)P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(trigger);
  assert.ok(m, trigger);
  const minutes = (Number(m[2] || 0) * 1440) + (Number(m[3] || 0) * 60) + Number(m[4] || 0) + Number(m[5] || 0) / 60;
  return start + (m[1] ? -1 : 1) * minutes * 60000;
}

test('no absolute trigger is ever written, and every trigger rings at exactly the planned instant (data review D-1)', () => {
  const now = Date.parse('2026-10-16T00:00:00Z');
  const sets: AlarmSpec[][] = [
    [{ kind: 'day', daysBefore: 0, time: '12:00' }, { kind: 'day', daysBefore: 1, time: '00:00' }, { kind: 'day', daysBefore: 7, time: '23:59' }, { kind: 'before', minutes: 120 }],
    [{ kind: 'day', daysBefore: 0, time: '23:59' }, { kind: 'day', daysBefore: 2, time: '02:30' }, { kind: 'day', daysBefore: 3, time: '07:15' }, { kind: 'before', minutes: 15 }],
  ];
  let n = 0;
  for (const zone of ['Europe/Oslo', 'America/New_York', 'Australia/Lord_Howe', 'Pacific/Kiritimati']) {
    for (const e of ECLIPSES) {
      for (const specs of sets) {
        const alarms = planAlarms(e, specs, zone, now);
        const ics = buildIcs({ eclipse: e, alarms, uid: 'e'.repeat(32), dtstamp: now });
        assert.doesNotMatch(ics, /VALUE=DATE-TIME|TRIGGER;/, `${e.id} ${zone}`);
        const l = lines(ics);
        const start = Date.parse(utcStampToIso(defined(l.find((x) => x.startsWith('DTSTART:')), 'DTSTART').slice(8)));
        const got = l.filter((x) => x.startsWith('TRIGGER')).map((t) => triggerInstant(start, t));
        assert.deepEqual(got, ringing(alarms).map((a) => a.fireAt), `${e.id} ${zone}`);
        n += got.length;
      }
    }
  }
  assert.ok(n > 10000);
});

const utcStampToIso = (s: string): string => s.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z');

test('summer time: an alarm at 12:00 in Oslo is 10:00 UTC; Sydney uses its own offset', () => {
  const e = byId('2033-03-30-solar');
  const now = Date.parse('2026-10-16T00:00:00Z');
  const specs: AlarmSpec[] = [{ kind: 'day', daysBefore: 0, time: '12:00' }, { kind: 'day', daysBefore: 7, time: '12:00' }];
  const oslo = lines(buildIcs({ eclipse: e, alarms: planAlarms(e, specs, 'Europe/Oslo', now), uid: 'a'.repeat(32), dtstamp: now }));
  // The event starts at 18:01 UTC on 30 March 2033. 12:00 a week before is 11:00 UTC (winter time),
  // 12:00 on the day 10:00 UTC (summer time): 7 days 7 hours 1 minute and 8 hours 1 minute before.
  assert.deepEqual(oslo.filter((x) => x.startsWith('TRIGGER')), ['TRIGGER:-P7DT7H1M', 'TRIGGER:-PT8H1M']);
  const sydney = lines(buildIcs({ eclipse: e, alarms: planAlarms(e, specs, 'Australia/Sydney', now), uid: 'a'.repeat(32), dtstamp: now }));
  // Greatest eclipse 18:01 UTC is 05:01 on 31 March in Sydney (UTC+11); the day is 31 March, so
  // 12:00 that day (01:00 UTC) is after greatest eclipse: a positive duration.
  assert.deepEqual(sydney.filter((x) => x.startsWith('TRIGGER')), ['TRIGGER:-P6DT17H1M', 'TRIGGER:PT6H59M']);
});

test('passed and repeated alarms are left out; with none left the file still holds the event', () => {
  const e = byId('2027-02-06-solar');
  const now = Date.parse('2027-02-06T15:40:00Z');
  const alarms = planAlarms(e, [{ kind: 'before', minutes: 30 }, { kind: 'before', minutes: 15 }, { kind: 'before', minutes: 15 }, { kind: 'day', daysBefore: 1, time: '12:00' }], 'Europe/Oslo', now);
  const l = lines(buildIcs({ eclipse: e, alarms, uid: 'b'.repeat(32), dtstamp: now }));
  assert.deepEqual(l.filter((x) => x.startsWith('TRIGGER')), ['TRIGGER:-PT15M']);
  const none = lines(buildIcs({ eclipse: e, alarms: [], uid: 'b'.repeat(32), dtstamp: now }));
  assert.ok(none.includes('BEGIN:VEVENT') && !none.includes('BEGIN:VALARM'));
});

test('every eclipse in the list makes a valid file with lines of at most 75 octets', () => {
  const now = Date.parse('2026-10-16T00:00:00Z');
  for (const e of ECLIPSES) {
    const ics = buildIcs({ eclipse: e, alarms: planAlarms(e, [{ kind: 'day', daysBefore: 0, time: '12:00' }, { kind: 'before', minutes: 120 }], 'Europe/Oslo', now), uid: 'c'.repeat(32), dtstamp: now });
    for (const l of ics.split('\r\n')) assert.ok(octets(l) <= 75, `${e.id}: ${l}`);
    const u = unfold(ics);
    assert.ok(u.includes(`DTSTART:${utcStamp(Math.round(Date.parse(e.greatest) / 60000) * 60000)}`));
    assert.ok(u.includes(escapeText(e.region)), `${e.id}: the region survives folding`);
    assert.doesNotMatch(u, /Europe\/Oslo|Oslo|UTC\+/, 'the time zone never reaches the file');
    assert.match(icsFileName(e), /^eclipse-\d{4}-\d{2}-\d{2}-(solar|lunar)\.ics$/);
    assert.ok(isIcsFileName(icsFileName(e)));
  }
});

test('folding: never inside a character, continuation lines count their space', () => {
  assert.equal(foldLine(`${'a'.repeat(73)}æb`).split('\r\n')[0], `${'a'.repeat(73)}æ`);
  assert.deepEqual(foldLine(`${'a'.repeat(74)}æb`).split('\r\n'), ['a'.repeat(74), ' æb']);
  const long = foldLine('ô'.repeat(100));
  for (const l of long.split('\r\n')) assert.ok(octets(l) <= 75);
  assert.equal(long.replace(/\r\n /g, ''), 'ô'.repeat(100));
  assert.equal(foldLine('short'), 'short');
  // Côte d'Ivoire is in a real path, and its ô is two octets.
  const e = defined(ECLIPSES.find((x) => x.path.includes('Côte')), 'an eclipse whose path names Côte d\'Ivoire');
  const ics = buildIcs({ eclipse: e, alarms: [], uid: 'd'.repeat(32), dtstamp: 0 });
  assert.ok(unfold(ics).includes('Côte d\'Ivoire'));
  assert.ok(!ics.includes('�'));
});

test('TEXT escaping: backslash first, then semicolon, comma and line breaks', () => {
  const B = String.fromCharCode(92); // one backslash, spelt out so no editor or shell can halve it
  assert.equal(escapeText(`a${B}b;c,d\ne\r\nf\rg`), `a${B}${B}b${B};c${B},d${B}ne${B}nf${B}ng`);
  assert.equal(escapeText(`${B};`), `${B}${B}${B};`);
});

test('at most 8 alarms in a file (data review D-7)', () => {
  const e = defined(ECLIPSES[0], 'the first eclipse');
  const nine = Array.from({ length: 9 }, (_, i): AlarmSpec => ({ kind: 'day', daysBefore: 0, time: `0${i}:00` }));
  const planned = [...planAlarms(e, nine.slice(0, 8), 'UTC', 0), ...planAlarms(e, nine.slice(8), 'UTC', 0)];
  assert.throws(() => buildIcs({ eclipse: e, alarms: planned, uid: 'f'.repeat(32), dtstamp: 0 }), RangeError);
  const ics = buildIcs({ eclipse: e, alarms: planned.slice(0, MAX_ALARMS), uid: 'f'.repeat(32), dtstamp: 0 });
  assert.equal((ics.match(/BEGIN:VALARM/g) || []).length, 8);
});

test('file names: only the strict pattern (stage B checks a name from the page with it, code review C-13)', () => {
  for (const bad of ['../eclipse-2027-02-06-solar.ics', 'eclipse-2027-02-06-solar.ics/x', 'eclipse-2027-02-06-solar.ICS', 'eclipse-2027-02-06-solar.ics.html', 'eclipse-27-02-06-solar.ics', 'x.ics', '', null, 7]) {
    assert.ok(!isIcsFileName(bad), String(bad));
  }
  assert.throws(() => icsFileName({ id: '../../etc' }), RangeError);
});

test('the uid must be random hex from the caller', () => {
  const e = defined(ECLIPSES[0], 'the first eclipse');
  for (const bad of ['', 'xyz', 'ABCDEF0123456789', '0123456789abcde', 'g'.repeat(32)]) assert.throws(() => buildIcs({ eclipse: e, alarms: [], uid: bad, dtstamp: 0 }), RangeError);
});
