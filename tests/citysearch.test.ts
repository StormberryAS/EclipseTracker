// The city search and the remembered city (city filter, 11 November 2026). core/citysearch.js is
// MoonApp's search made DOM-free; MoonApp's 162 captured results (tests/search-vectors.json, copied
// byte for byte) must come out identical. cities.js is the shared Labs catalogue: it is loaded here
// in a fresh node:vm context, as MoonApp's tests do, so the generated file is exercised unchanged and
// no JavaScript is written for the test. Objects from that context fail instanceof here, so only
// strings and JSON are compared.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MAX_CITY_ROWS, parseStoredCity, searchCities, storedCityText } from '#core/citysearch.js';
import type { City } from '#core/citysearch.js';
import { isKnownZone } from '#core/zoned.js';
import { SEARCH_QUERIES } from './search-queries.ts';

const root = new URL('../', import.meta.url);
const catalogueText = readFileSync(new URL('cities.js', root), 'utf8');

function loadCatalogue(): { cities: City[]; fold: (s: string) => string } {
  const context = vm.createContext({});
  vm.runInContext(catalogueText, context, { filename: 'cities.js' });
  const cities = vm.runInContext('CITIES', context) as City[];
  const fold = vm.runInContext('foldQuery', context) as (s: string) => string;
  return { cities, fold };
}

const { cities, fold } = loadCatalogue();

interface Vector { q: string; open: boolean; rows: Array<[string, string, string]> }
const frozen = JSON.parse(readFileSync(new URL('tests/search-vectors.json', root), 'utf8')) as { capturedFrom: string; vectors: Vector[] };

test('the vectors were captured from the MoonApp 90d11dd page, one per query, in order', () => {
  assert.match(frozen.capturedFrom, /^MoonApp 90d11dd /);
  assert.deepEqual(frozen.vectors.map((v) => v.q), [...SEARCH_QUERIES]);
  assert.equal(frozen.vectors.length, 162);
});

test('every query lists the same cities in the same order as MoonApp 90d11dd', () => {
  const diffs: string[] = [];
  for (const want of frozen.vectors) {
    const rows = searchCities(cities, fold, want.q);
    const got = { q: want.q, open: rows.length > 0, rows: rows.map((c) => [c.name, c.country, c.tz]) };
    if (JSON.stringify(got) !== JSON.stringify(want)) diffs.push(`${JSON.stringify(want.q)}\n  MoonApp: ${JSON.stringify(want.rows)}\n  now:     ${JSON.stringify(got.rows)}`);
  }
  assert.deepEqual(diffs, []);
});

test('the list shows at most 8 rows, and a name that starts with the query comes before one that contains it', () => {
  assert.equal(MAX_CITY_ROWS, 8);
  for (const q of SEARCH_QUERIES) assert.ok(searchCities(cities, fold, q).length <= MAX_CITY_ROWS, q);
  assert.equal(searchCities(cities, fold, 'erdal')[0]?.name, 'Erdal');
  assert.equal(searchCities(cities, fold, '   ').length, 0);
  assert.equal(searchCities(cities, fold, '').length, 0);
});

test('accents fold both ways, and an English exonym finds the local name', () => {
  assert.equal(searchCities(cities, fold, 'tromso')[0]?.name, 'Tromsø');
  assert.equal(searchCities(cities, fold, 'Tromsø')[0]?.name, 'Tromsø');
  assert.equal(searchCities(cities, fold, 'REYKJAVÍK')[0]?.name, 'Reykjavík');
  assert.match(searchCities(cities, fold, 'gothenburg')[0]?.name ?? '', /^G/);
});

test('cities.js: the generated file is untouched, and the catalogue is the one the rows below come from', () => {
  assert.match(catalogueText, /^\/\/ Stormberry Labs shared city catalogue\.\n\/\/ GENERATED FILE, DO NOT EDIT BY HAND\.\n/);
  assert.equal(cities.length, 25007);
});

test('cities.js is byte for byte the SunApp copy when the SunApp checkout is beside this one (or SUNAPP_CITIES names its cities.js)', (t) => {
  const sunapp = new URL('../SunApp/cities.js', root);
  const named = process.env['SUNAPP_CITIES'];
  const path = named && existsSync(named) ? named : existsSync(sunapp) ? sunapp.pathname : undefined;
  if (!path) { t.skip('no SunApp checkout to compare with'); return; }
  assert.ok(readFileSync(path).equals(readFileSync(new URL('cities.js', root))), 'cities.js differs from the SunApp copy');
  // And the Python tool says the same.
  execFileSync('python3', ['-I', new URL('tools/check-city-catalogue.py', root).pathname, path], { encoding: 'utf8' });
});

test('every time zone in the catalogue is known to this runtime (the page shows times in the city\'s zone)', () => {
  const zones = new Set(cities.map((c) => c.tz));
  assert.equal(zones.size, 349);
  const unknown = [...zones].filter((z) => !isKnownZone(z));
  assert.deepEqual(unknown, []);
});

const GOOD = { name: 'Bergen', country: 'Norway', lat: 60.393, lon: 5.3242, tz: 'Europe/Oslo' };
/** The kept record: the version first, then the city (the record MeteorWatch keeps under meteorwatch.city). */
const stored = { v: 1, ...GOOD };

test('parseStoredCity accepts a city this version wrote, and storedCityText writes the version and the five keys in order', () => {
  const text = storedCityText(GOOD);
  assert.equal(text, '{"v":1,"name":"Bergen","country":"Norway","lat":60.393,"lon":5.3242,"tz":"Europe/Oslo"}');
  assert.deepEqual(parseStoredCity(text), GOOD);
  // The catalogue rows round-trip, all of them.
  for (const c of cities.slice(0, 2000)) {
    const kept = { name: c.name, country: c.country, lat: c.lat, lon: c.lon, tz: c.tz };
    assert.deepEqual(parseStoredCity(storedCityText(kept)), kept);
  }
});

test('parseStoredCity rejects anything else', () => {
  const bad: Array<[string, string | null]> = [
    ['null', null],
    ['not JSON', '{"name":'],
    ['an array', '[]'],
    ['a string', '"Bergen"'],
    ['an extra key', JSON.stringify({ ...stored, extra: 1 })],
    ['a missing key', JSON.stringify({ v: 1, name: 'Bergen', country: 'Norway', lat: 60.393, lon: 5.3242 })],
    ['no version (a record without v)', JSON.stringify(GOOD)],
    ['version 2', JSON.stringify({ ...stored, v: 2 })],
    ['version as text', JSON.stringify({ ...stored, v: '1' })],
    ['latitude 91', JSON.stringify({ ...stored, lat: 91 })],
    ['latitude -90.5', JSON.stringify({ ...stored, lat: -90.5 })],
    ['longitude 180.1', JSON.stringify({ ...stored, lon: 180.1 })],
    ['longitude NaN (null in JSON)', JSON.stringify({ ...stored, lon: Number.NaN })],
    ['latitude as text', JSON.stringify({ ...stored, lat: '60.39' })],
    ['an unknown zone', JSON.stringify({ ...stored, tz: 'Mars/Olympus' })],
    ['a zone that is not text', JSON.stringify({ ...stored, tz: 1 })],
    ['a 201-character name', JSON.stringify({ ...stored, name: 'x'.repeat(201) })],
    ['an empty name', JSON.stringify({ ...stored, name: '' })],
    ['an empty country', JSON.stringify({ ...stored, country: '' })],
    ['a line break in the name', JSON.stringify({ ...stored, name: 'Ber\ngen' })],
    ['a tab in the country', JSON.stringify({ ...stored, country: 'Nor\tway' })],
    ['a NUL in the name', JSON.stringify({ ...stored, name: 'Ber\u0000gen' })],
    ['a DEL in the country', JSON.stringify({ ...stored, country: 'Nor\u007fway' })],
    ['a C1 control in the name', JSON.stringify({ ...stored, name: 'Ber\u0085gen' })],
  ];
  for (const [what, text] of bad) assert.equal(parseStoredCity(text), null, what);
  // The edges that are allowed.
  assert.deepEqual(parseStoredCity(JSON.stringify({ ...stored, name: 'x'.repeat(200), lat: -90, lon: 180 })), { ...GOOD, name: 'x'.repeat(200), lat: -90, lon: 180 });
});
