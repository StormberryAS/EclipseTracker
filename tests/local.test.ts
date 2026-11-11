// An eclipse as seen from a city (core/local.ts): the visibility rule, the contacts, the magnitude.
// Checked five ways, none of them against core/local.js alone:
//   1. tests/local-vectors.json, written by a separate Python implementation of the method
//      (tools/vectors/build-local-vectors.py, which shares the element parser and the T0 rule with the tool that writes elements.ts) for 16 cities and all 337 eclipses;
//   2. NASA's own catalogue values: the point of greatest eclipse of every solar eclipse in the list
//      (tools/nasa/SEcat5) must see it, with the Sun at the height the catalogue gives, and the
//      sub-lunar point of every lunar eclipse (LEcat5) must see the Moon near the zenith; the
//      antipodes of those points must not see it;
//   3. the counts the research found for four cities;
//   4. the 12 cities of the total eclipse of 2026-08-12 whose totality NationalEclipse.com
//      publishes (data credited to Fred Espenak);
//   5. a few hand-worked cases (Bergen's lunar eclipse at sunset, Cairo and Luxor on 2027-08-02).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ECLIPSES } from '#core/data.js';
import { LUNAR_ELEMENTS, SOLAR_ELEMENTS } from '#core/elements.js';
import { localNotes, minuteOf } from '#core/format.js';
import { REFRACTION_DEG, SUN_LIMIT_DEG, localAll, localFor, lunarLocal, moonAltitudeAt, solarContacts, solarLocal, sunAltitude } from '#core/local.js';
import type { City } from '#core/citysearch.js';
import { defined } from './helpers.ts';
import { solarFromText } from './elements-text.ts';

const root = new URL('../', import.meta.url);
const SOLAR = new Map(SOLAR_ELEMENTS.map((el) => [el.id, el] as const));
const LUNAR = new Map(LUNAR_ELEMENTS.map((el) => [el.id, el] as const));
const eclipse = (id: string) => defined(ECLIPSES.find((e) => e.id === id), id);
const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('cities.js', root), 'utf8'), context);
const catalogue = vm.runInContext('CITIES', context) as City[];

interface VectorCity {
  name: string; country: string; lat: number; lon: number; tz: string;
  seen: Array<{ id: string; type: string; start: string; end: string; max: string; gap: boolean; magnitude?: number; obscuration?: number; altitude?: number }>;
  unseen: string[]; edge: string[];
}
const vectors = JSON.parse(readFileSync(new URL('tests/local-vectors.json', root), 'utf8')) as { cities: VectorCity[] };

/** A catalogue row by its display name and country. */
const cityRow = (name: string, country: string): City => defined(catalogue.find((c) => c.name === name && c.country === country), `${name}, ${country}`);

test('the cities of the vectors are the catalogue rows, with the same coordinates and zone', () => {
  assert.equal(vectors.cities.length, 16);
  for (const v of vectors.cities) {
    const row = cityRow(v.name, v.country);
    assert.deepEqual([row.lat, row.lon, row.tz], [v.lat, v.lon, v.tz], v.name);
  }
});

test('the vectors: seen or not, type, start, end, maximum, magnitude, obscuration, altitude (separate Python implementation)', () => {
  let cases = 0;
  let edges = 0;
  const problems: string[] = [];
  for (const v of vectors.cities) {
    const mine = localAll({ lat: v.lat, lon: v.lon });
    const edge = new Set(v.edge);
    const want = new Map(v.seen.map((s) => [s.id, s] as const));
    assert.equal(v.seen.length + v.unseen.length, 337, v.name);
    for (const e of ECLIPSES) {
      cases += 1;
      if (edge.has(e.id)) { edges += 1; continue; }
      const got = mine.get(e.id);
      const w = want.get(e.id);
      if (!w) {
        if (got) problems.push(`${v.name} ${e.id}: seen here, not in the vectors`);
        continue;
      }
      if (!got) { problems.push(`${v.name} ${e.id}: in the vectors, not seen here`); continue; }
      const off = (a: number, b: string): number => Math.abs(a - Date.parse(b));
      if (got.type !== w.type) problems.push(`${v.name} ${e.id}: type ${got.type} against ${w.type}`);
      if (off(got.start, w.start) > 2000) problems.push(`${v.name} ${e.id}: start ${iso(got.start)} against ${w.start}`);
      if (off(got.end, w.end) > 2000) problems.push(`${v.name} ${e.id}: end ${iso(got.end)} against ${w.end}`);
      if (got.gap !== w.gap) problems.push(`${v.name} ${e.id}: gap ${got.gap} against ${w.gap}`);
      if (off(got.max, w.max) > 2000) problems.push(`${v.name} ${e.id}: max ${iso(got.max)} against ${w.max}`);
      if (w.magnitude !== undefined && Math.abs((got.magnitude ?? 99) - w.magnitude) > 0.0005) problems.push(`${v.name} ${e.id}: magnitude ${got.magnitude} against ${w.magnitude}`);
      if (w.obscuration !== undefined && Math.abs((got.obscuration ?? 99) - w.obscuration) > 0.0005) problems.push(`${v.name} ${e.id}: obscuration ${got.obscuration} against ${w.obscuration}`);
      if (w.altitude !== undefined && Math.abs((got.altitude ?? 999) - w.altitude) > 0.02) problems.push(`${v.name} ${e.id}: altitude ${got.altitude} against ${w.altitude}`);
    }
  }
  assert.deepEqual(problems, []);
  assert.equal(cases, 16 * 337);
  assert.ok(edges <= cases * 0.02, `${edges} edge cases of ${cases}`);
});

test('localFor and localAll agree, and an eclipse without a place is not seen', () => {
  const bergen = { lat: 60.393, lon: 5.3242 };
  const all = localAll(bergen);
  for (const e of ECLIPSES) {
    const one = localFor(e, bergen);
    assert.equal(one !== null, all.has(e.id), e.id);
    if (one) assert.deepEqual(one, all.get(e.id));
  }
  assert.equal(localFor({ id: '2999-01-01-solar', kind: 'solar' }, bergen), null);
});

test('NASA catalogue, solar: the point of greatest eclipse sees it, within 2 min of greatest eclipse and 1 degree of the catalogue Sun altitude', () => {
  const text = readFileSync(new URL('tools/nasa/SEcat5_SE2001-2100.html', root), 'latin1').replace(/<[^>]+>/g, '');
  const months = 'JanFebMarAprMayJunJulAugSepOctNovDec';
  let checked = 0;
  let above = 0;
  const problems: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*\d{5}\s+(\d{4}) (\w{3}) (\d\d)\s+\d\d:\d\d:\d\d\s+(.*)$/.exec(line);
    if (!m) continue;
    const id = `${m[1]}-${String(months.indexOf(m[2] ?? '') / 3 + 1).padStart(2, '0')}-${m[3]}-solar`;
    const e = ECLIPSES.find((x) => x.id === id);
    if (!e) continue;
    const f = (m[4] ?? '').trim().split(/\s+/);
    const lat = Number(f[7]?.slice(0, -1)) * (f[7]?.endsWith('S') ? -1 : 1);
    const lon = Number(f[8]?.slice(0, -1)) * (f[8]?.endsWith('W') ? -1 : 1);
    const alt = Number(f[9]);
    checked += 1;
    if (alt < 2) continue;
    above += 1;
    const o = { lat, lon };
    const local = localFor(e, o);
    if (!local) { problems.push(`${id}: not seen at its own greatest-eclipse point ${f[7]} ${f[8]}`); continue; }
    if (Math.abs(local.max - Date.parse(e.greatest)) > 120_000) problems.push(`${id}: maximum ${iso(local.max)} against greatest ${e.greatest}`);
    const here = sunAltitude(defined(SOLAR.get(id), id), o, local.max);
    if (Math.abs(here - alt) > 1) problems.push(`${id}: Sun altitude ${here.toFixed(2)} against the catalogue ${alt}`);
    // The antipode is on the night side, and the shadow is nowhere near it.
    assert.equal(localFor(e, { lat: -lat, lon: lon > 0 ? lon - 180 : lon + 180 }), null, `${id}: seen at the antipode`);
  }
  assert.deepEqual(problems, []);
  assert.equal(checked, 168);
  assert.ok(above >= 100, `${above} with the Sun 2 degrees or more up`);
});

test('NASA catalogue, lunar: at the sub-lunar point the Moon is near the zenith and the eclipse is seen; at its antipode it is not', () => {
  const text = readFileSync(new URL('tools/nasa/LEcat5_LE2001-2100.html', root), 'latin1').replace(/<[^>]+>/g, '');
  const months = 'JanFebMarAprMayJunJulAugSepOctNovDec';
  let checked = 0;
  const problems: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*\d{5}\s+(\d{4}) (\w{3}) (\d\d)\s+\d\d:\d\d:\d\d\s+(.*)$/.exec(line);
    if (!m) continue;
    const id = `${m[1]}-${String(months.indexOf(m[2] ?? '') / 3 + 1).padStart(2, '0')}-${m[3]}-lunar`;
    const e = ECLIPSES.find((x) => x.id === id);
    if (!e) continue;
    const f = (m[4] ?? '').trim().split(/\s+/);
    const latText = f.at(-2) ?? '';
    const lonText = f.at(-1) ?? '';
    const lat = Number(latText.slice(0, -1)) * (latText.endsWith('S') ? -1 : 1);
    const lon = Number(lonText.slice(0, -1)) * (lonText.endsWith('W') ? -1 : 1);
    const el = defined(LUNAR.get(id), id);
    checked += 1;
    const local = lunarLocal(el, { lat, lon });
    if (!local) { problems.push(`${id}: not seen at the sub-lunar point ${latText} ${lonText}`); continue; }
    const g = Date.parse(el.t0) + el.c[3] * 3_600_000 - el.dT * 1000;
    const altitude = moonAltitudeAt(el, { lat, lon }, g);
    if (altitude < 89) problems.push(`${id}: the Moon is ${altitude.toFixed(2)} degrees up at the sub-lunar point`);
    if (lunarLocal(el, { lat: -lat, lon: lon > 0 ? lon - 180 : lon + 180 })) problems.push(`${id}: seen at the antipode`);
  }
  assert.deepEqual(problems, []);
  assert.equal(checked, 169);
});

test('how many eclipses a city keeps: Bergen, Madrid, Sydney and Longyearbyen (research counts, Sun above -0.833 degrees; Moon in the umbral phase or the penumbral phase of a penumbral eclipse)', () => {
  const count = (name: string, country: string): [number, number] => {
    const row = cityRow(name, country);
    const ids = [...localAll({ lat: row.lat, lon: row.lon }).keys()];
    return [ids.filter((i) => i.endsWith('solar')).length, ids.filter((i) => i.endsWith('lunar')).length];
  };
  assert.deepEqual(count('Bergen', 'Norway'), [31, 102]);
  assert.deepEqual(count('Madrid', 'Spain'), [34, 104]);
  assert.deepEqual(count('Sydney', 'Australia'), [29, 105]);
  assert.deepEqual(count('Longyearbyen', 'Svalbard and Jan Mayen'), [30, 88]);
});

test('the total eclipse of 2026-08-12 in 12 cities: second contact within 10 s and duration within 3 s of the published table', () => {
  // NationalEclipse.com, "2026 total solar eclipse cities" (data courtesy of Fred Espenak), read 2026-11-11:
  // the start of totality in UTC and its length in seconds. The table is not bundled. The element set is
  // read from the NASA file (the eclipse is before the list starts). City coordinates are catalogue rows.
  const published: Array<[string, string, string, number]> = [
    ['Reykjavík', 'Iceland', '17:48:19', 59], ['Gijón', 'Spain', '18:26:49', 105], ['Santander', 'Spain', '18:26:58', 63],
    ['Oviedo', 'Spain', '18:27:06', 108], ['Lugo', 'Spain', '18:28:08', 84], ['Logroño', 'Spain', '18:28:10', 81],
    ['León', 'Spain', '18:28:21', 105], ['Burgos', 'Spain', '18:28:25', 103], ['Zaragoza', 'Spain', '18:29:04', 84],
    ['Soria', 'Spain', '18:29:07', 102], ['Palencia', 'Spain', '18:29:09', 102], ['Valladolid', 'Spain', '18:29:53', 88],
  ];
  const el = solarFromText(2026, 8, 12);
  for (const [name, country, c2, seconds] of published) {
    const row = cityRow(name, country);
    const c = defined(solarContacts(el, { lat: row.lat, lon: row.lon }), name);
    assert.ok(c.c2 !== undefined && c.c3 !== undefined, `${name}: totality`);
    const want = Date.parse(`2026-08-12T${c2}Z`);
    assert.ok(Math.abs((c.c2 ?? 0) - want) <= 10_000, `${name}: C2 ${iso(c.c2 ?? 0)} against ${c2}`);
    assert.ok(Math.abs(((c.c3 ?? 0) - (c.c2 ?? 0)) / 1000 - seconds) <= 3, `${name}: duration ${((c.c3 ?? 0) - (c.c2 ?? 0)) / 1000} s against ${seconds} s`);
    assert.equal(solarLocal(el, { lat: row.lat, lon: row.lon })?.type, 'total', name);
  }
});

test('Cairo and Luxor on 2027-08-02, the longest eclipse of the century: partial at Cairo (0.946), total at Luxor', () => {
  const cairo = defined(localFor(eclipse('2027-08-02-solar'), cityRow('Cairo', 'Egypt')), 'Cairo');
  assert.equal(cairo.type, 'partial');
  assert.ok(Math.abs((cairo.magnitude ?? 0) - 0.946) <= 0.001, String(cairo.magnitude));
  assert.ok(Math.abs((cairo.obscuration ?? 0) - 0.947) <= 0.002, String(cairo.obscuration));
  assert.equal(cairo.startsAtRise, false);
  assert.equal(cairo.endsAtSet, false);
  const luxor = defined(localFor(eclipse('2027-08-02-solar'), cityRow('Luxor', 'Egypt')), 'Luxor');
  assert.equal(luxor.type, 'total');
  assert.equal(luxor.obscuration, 1);
  assert.ok((luxor.magnitude ?? 0) > 1);
  // Totality at Luxor starts 10:01:56 UT and lasts 6 min 20 s: the maximum is in the middle of it.
  assert.ok(Math.abs(luxor.max - Date.parse('2027-08-02T10:05:06Z')) <= 15_000, iso(luxor.max));
});

test('a lunar eclipse at moonrise: Bergen, 2028-12-31, total; penumbral phase starts with the Moon down', () => {
  const e = eclipse('2028-12-31-lunar');
  const el = defined(LUNAR.get(e.id), e.id);
  const at = (hours: number | null): number => Date.parse(el.t0) + defined(hours, 'contact') * 3_600_000 - el.dT * 1000;
  const bergen = cityRow('Bergen', 'Norway');
  const local = defined(localFor(e, bergen), 'Bergen');
  assert.equal(local.type, 'total');
  assert.equal(local.startsAtRise, true);
  assert.ok(local.start > at(el.c[0]) && local.start < at(el.c[1]), 'the Moon rises between P1 and U1');
  assert.equal(local.endsAtSet, false);
  assert.ok((local.altitude ?? -90) > 0);
  // The research: P1 14:04 UT with the Moon at -1.8 degrees; U1 15:08 UT at 3.0 degrees.
  assert.ok(moonAltitudeAt(el, bergen, at(el.c[0])) < -1.5);
  assert.ok(Math.abs(moonAltitudeAt(el, bergen, at(el.c[1])) - 3.0) < 0.3);
});

test('a penumbral eclipse counts when the Moon is up during the penumbral phase, and says so as the local type', () => {
  const penumbral = ECLIPSES.filter((e) => e.type === 'penumbral' && e.kind === 'lunar');
  assert.equal(penumbral.length, 65);
  const bergen = cityRow('Bergen', 'Norway');
  const kept = penumbral.map((e) => localFor(e, bergen)).filter((l) => l !== null);
  assert.ok(kept.length > 20 && kept.length < 65, `${kept.length} of 65`);
  for (const l of kept) {
    assert.equal(l.type, 'penumbral');
    assert.ok(l.altitude !== undefined && l.altitude > -1);
  }
});

test('start, end and maximum are in order; the start is exact, and minuteOf rounds half a minute up', () => {
  for (const v of vectors.cities.slice(0, 6)) {
    for (const l of localAll({ lat: v.lat, lon: v.lon }).values()) {
      assert.ok(l.start <= l.max && l.max <= l.end, `${v.name} ${l.id}`);
    }
  }
  assert.equal(minuteOf(Date.parse('2027-02-06T15:59:29.999Z')), Date.parse('2027-02-06T15:59:00Z'));
  assert.equal(minuteOf(Date.parse('2027-02-06T15:59:30Z')), Date.parse('2027-02-06T16:00:00Z'));
});

test('the whole calculation for one city is fast enough to run when the city is chosen', () => {
  const t = performance.now();
  localAll({ lat: -33.8678, lon: 151.2073 });
  const ms = performance.now() - t;
  assert.ok(ms < 2000, `${ms.toFixed(0)} ms`);
});

test('the body sets and rises again inside the eclipse (66 degrees of latitude or more): the maximum is a moment with the body up, and a note says so', () => {
  const tromso = cityRow('Tromsø', 'Norway');
  const e = eclipse('2065-01-22-lunar');
  const el = defined(LUNAR.get(e.id), e.id);
  const local = defined(localFor(e, tromso), 'Tromsø');
  // The Moon is up at U2 (about 09:22 UTC), sets at about 09:54, is down at greatest eclipse and at U3 and U4, and rises again at about 12:20.
  assert.equal(local.gap, true);
  assert.equal(local.type, 'total');
  const limit = -(REFRACTION_DEG + el.sd);
  assert.ok(moonAltitudeAt(el, tromso, Date.parse(e.greatest)) < limit, 'the Moon is down at greatest eclipse');
  assert.ok(moonAltitudeAt(el, tromso, local.max) > limit - 0.01, 'the Moon is up at the maximum that is shown');
  assert.ok(Math.abs(local.max - Date.parse('2065-01-22T09:54:34Z')) <= 5000, iso(local.max));
  assert.ok(local.max < Date.parse('2065-01-22T10:30:00Z'), 'not the end of the later stretch');
  assert.ok(local.start <= local.max && local.max <= local.end);
  assert.deepEqual(localNotes('lunar', local), ['The Moon sets and rises again during it.']);
  // A city with one stretch has no gap.
  assert.equal(defined(localFor(e, cityRow('Bergen', 'Norway')), 'Bergen').gap, false);
});

test('at the Arctic Circle and north of it the maximum is a moment with the body up, and the gap cases are the ones the review found', () => {
  const places: Array<[string, string]> = [['Tromsø', 'Norway'], ['Murmansk', 'Russia'], ['Rovaniemi', 'Finland'], ['Longyearbyen', 'Svalbard and Jan Mayen'], ['Reykjavík', 'Iceland']];
  const gaps: string[] = [];
  for (const [name, country] of places) {
    const row = cityRow(name, country);
    for (const l of localAll(row).values()) {
      const solar = l.id.endsWith('-solar');
      const el = defined(solar ? SOLAR.get(l.id) : LUNAR.get(l.id), l.id);
      const up = 'sd' in el ? moonAltitudeAt(el, row, l.max) > -(REFRACTION_DEG + el.sd) - 0.01 : sunAltitude(el, row, l.max) > SUN_LIMIT_DEG - 0.01;
      assert.ok(up, `${name} ${l.id}: the body is down at the maximum that is shown`);
      if (l.gap) gaps.push(`${name} ${l.id}`);
    }
  }
  assert.deepEqual(gaps, ['Tromsø 2065-01-22-lunar', 'Murmansk 2065-01-22-lunar', 'Rovaniemi 2075-01-02-lunar', 'Rovaniemi 2075-12-22-lunar', 'Rovaniemi 2076-12-10-lunar']);
});

test('the end of what is seen is never before the start of the phase that was tested (Antananarivo, 2088-10-30, a grazing case)', () => {
  const row = cityRow('Antananarivo', 'Madagascar');
  const e = eclipse('2088-10-30-lunar');
  const el = defined(LUNAR.get(e.id), e.id);
  const local = defined(localFor(e, row), 'Antananarivo');
  const u1 = Date.parse(el.t0) + defined(el.c[1], 'U1') * 3_600_000 - el.dT * 1000;
  assert.ok(local.end >= u1, `${iso(local.end)} is before U1 ${iso(u1)}`);
  assert.ok(local.start <= local.max && local.max <= local.end);
});
