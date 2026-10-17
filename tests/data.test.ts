// The eclipse list (spec section 3): every solar and lunar eclipse from 2026-10-16 to the end of
// 2100, as NASA's catalogue gives it. These tests count the eclipses per decade straight from the
// archived NASA decade tables (tools/nasa/), independently of tools/build-eclipse-data.py, and check
// order, ids, types, magnitudes, times and the house style of the region text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DATA_FIRST_DAY, DATA_LAST_YEAR, DECADE_COUNTS, ECLIPSES } from '#core/data.js';
import { eclipseById, groupByYear, matches, nextEclipse, typesFor, upcoming } from '#core/eclipses.js';
import type { EclipseKind } from '#core/types.js';
import { defined } from './helpers.ts';

type Counts = Record<string, Record<EclipseKind, number>>;
/** The two NASA page families and the kind each lists. */
const FAMILIES: ReadonlyArray<readonly ['SE' | 'LE', EclipseKind]> = [['SE', 'solar'], ['LE', 'lunar']];

const nasa = (name: string): string => readFileSync(new URL(`../tools/nasa/${name}`, import.meta.url), 'latin1');
/** NASA's decade tables, named by their first year: 2021 is 2021 to 2030, 2091 is 2091 to 2100. */
const DECADES = [2021, 2031, 2041, 2051, 2061, 2071, 2081, 2091];
const MONTHS: Readonly<Record<string, number>> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

/** The dates (YYYY-MM-DD) of every row of one NASA decade table. */
function decadeDates(kind: string, decade: number): string[] {
  const html = nasa(`${kind}decade_${kind}decade${decade}.html`);
  const out: string[] = [];
  for (const m of html.matchAll(/target=GLOBE>\s*(\d{4}) (\w{3}) (\d{2})\s*<\/a>/g)) out.push(`${m[1]}-${String(MONTHS[m[2] ?? '']).padStart(2, '0')}-${m[3]}`);
  return out;
}

test('the archived NASA pages match the SHA-256 recorded when they were fetched', () => {
  const log = readFileSync(new URL('../tools/nasa/FETCHLOG.tsv', import.meta.url), 'utf8').trim().split('\n');
  assert.equal(log.length, 18);
  for (const line of log) {
    const [when = '', url = '', status, name, sha] = line.split('\t');
    assert.match(when, /^2026-10-16T\d{2}:\d{2}:\d{2}Z$/);
    assert.match(url, /^https:\/\/eclipse\.gsfc\.nasa\.gov\/(SE|LE)(decade|cat5)\//);
    assert.equal(status, '200');
    assert.equal(createHash('sha256').update(readFileSync(new URL(`../tools/nasa/${name}`, import.meta.url))).digest('hex'), sha, name);
  }
});

test('the count per decade matches the NASA decade tables, solar and lunar', () => {
  const want: Counts = {};
  for (const [kind, family] of FAMILIES) {
    for (const decade of DECADES) {
      for (const d of decadeDates(kind, decade)) {
        if (d < DATA_FIRST_DAY || Number(d.slice(0, 4)) > DATA_LAST_YEAR) continue;
        const key = `${decade}-${decade + 9}`;
        want[key] ??= { solar: 0, lunar: 0 };
        want[key][family] += 1;
      }
    }
  }
  const got: Counts = {};
  for (const e of ECLIPSES) {
    const y = Number(e.id.slice(0, 4));
    const first = Math.floor((y - 1) / 10) * 10 + 1;
    const key = `${first}-${first + 9}`;
    got[key] ??= { solar: 0, lunar: 0 };
    got[key][e.kind] += 1;
  }
  assert.deepEqual(got, want);
  assert.deepEqual(DECADE_COUNTS, want);
  // The totals, written out so a change to the list is a visible change here.
  assert.deepEqual(want, {
    '2021-2030': { solar: 10, lunar: 10 },
    '2031-2040': { solar: 22, lunar: 23 },
    '2041-2050': { solar: 22, lunar: 22 },
    '2051-2060': { solar: 23, lunar: 23 },
    '2061-2070': { solar: 23, lunar: 22 },
    '2071-2080': { solar: 22, lunar: 23 },
    '2081-2090': { solar: 23, lunar: 22 },
    '2091-2100': { solar: 23, lunar: 24 },
  });
  assert.equal(ECLIPSES.length, 337);
});

test('every NASA decade-table date from 2026-10-16 to 2100 is in the list, and nothing else', () => {
  const want = new Set<string>();
  for (const [kind, family] of FAMILIES) {
    for (const decade of DECADES) {
      for (const d of decadeDates(kind, decade)) if (d >= DATA_FIRST_DAY && Number(d.slice(0, 4)) <= DATA_LAST_YEAR) want.add(`${d}-${family}`);
    }
  }
  assert.deepEqual(new Set(ECLIPSES.map((e) => e.id)), want);
});

test('order, ids and the range', () => {
  const ids = new Set();
  let last = '';
  for (const e of ECLIPSES) {
    assert.ok(e.greatest > last, `${e.id} is in order`);
    last = e.greatest;
    assert.ok(!ids.has(e.id), `${e.id} is unique`);
    ids.add(e.id);
    assert.match(e.id, /^\d{4}-\d{2}-\d{2}-(solar|lunar)$/);
    assert.equal(e.id.slice(-5), e.kind);
    assert.match(e.greatest, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // The id carries NASA's calendar date (TD); in this range it is always the UTC date too.
    assert.equal(e.id.slice(0, 10), e.greatest.slice(0, 10), e.id);
    // UTC = TD - Delta T, exactly.
    const td = Date.parse(`${e.id.slice(0, 10)}T${e.td}Z`);
    assert.equal(Date.parse(e.greatest), td - e.deltaT * 1000, e.id);
    assert.ok(e.deltaT >= 70 && e.deltaT <= 210, `${e.id} Delta T ${e.deltaT}`);
    assert.ok(e.saros > 100 && e.saros < 170);
    // (deepEqual: eclipses.js imports data.js with its ?v= stamp, a separate module instance.)
    assert.deepEqual(eclipseById(e.id), e);
  }
  const first = defined(ECLIPSES[0], 'the first eclipse');
  const final = defined(ECLIPSES.at(-1), 'the last eclipse');
  assert.ok(first.id >= DATA_FIRST_DAY);
  assert.equal(first.id, '2027-02-06-solar');
  assert.equal(final.greatest.slice(0, 4), '2100');
  assert.equal(final.id, '2100-09-04-solar');
});

test('types and magnitudes are consistent with each other', () => {
  for (const e of ECLIPSES) {
    if (e.kind === 'solar') {
      assert.ok(['total', 'annular', 'hybrid', 'partial'].includes(e.type), e.id);
      assert.equal(e.penMagnitude, undefined);
      if (e.type === 'total') assert.ok(e.magnitude >= 1, e.id);
      if (e.type === 'annular' || e.type === 'partial') assert.ok(e.magnitude < 1 && e.magnitude > 0, e.id);
      if (e.type === 'hybrid') assert.ok(e.magnitude > 0.99 && e.magnitude < 1.02, e.id);
      assert.equal(Boolean(e.path), e.type !== 'partial', `${e.id}: a path exactly for central eclipses`);
      assert.ok(Math.abs(e.gamma) < 1.6);
    } else {
      assert.ok(['total', 'partial', 'penumbral'].includes(e.type), e.id);
      assert.equal(typeof e.penMagnitude, 'number');
      if (e.type === 'total') assert.ok(e.magnitude >= 1, e.id);
      if (e.type === 'partial') assert.ok(e.magnitude > 0 && e.magnitude < 1, e.id);
      if (e.type === 'penumbral') assert.ok(e.magnitude < 0 && (e.penMagnitude ?? 0) > 0, e.id);
      assert.equal(e.path, '');
      assert.ok(Math.abs(e.gamma) < 1.6);
    }
  }
});

test("the magnitude shown is the decade table's own, to 3 decimals; a penumbral one is rounded half up (data review D-5)", () => {
  const table = new Map<string, string | undefined>();
  for (const [kind, family] of FAMILIES) {
    for (const decade of DECADES) {
      const html = nasa(`${kind}decade_${kind}decade${decade}.html`);
      for (const tr of html.split(/<tr[^>]*>/).slice(1)) {
        const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => (m[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
        const d = /^(\d{4}) (\w{3}) (\d{2})$/.exec(cells[0] ?? '');
        if (cells.length !== 7 || !d) continue;
        table.set(`${d[1]}-${String(MONTHS[d[2] ?? '']).padStart(2, '0')}-${d[3]}-${family}`, cells[4]);
      }
    }
  }
  let fromTable = 0;
  for (const e of ECLIPSES) {
    assert.match(e.shownMagnitude, /^-?\d+\.\d{3}$/, e.id);
    if (e.type === 'penumbral') {
      // Half up on the catalogue's 4 decimals, in integer arithmetic.
      const t = Math.round(defined(e.penMagnitude, `${e.id} penMagnitude`) * 10000);
      const want = (Math.floor((t + 5) / 10) / 1000).toFixed(3);
      assert.equal(e.shownMagnitude, want, e.id);
    } else {
      assert.equal(e.shownMagnitude, table.get(e.id), e.id);
      // NASA rounds from more digits than the catalogue prints: within 0.001 (2047-07-22: 0.3604 printed 0.361).
      assert.ok(Math.abs(Number(e.shownMagnitude) - e.magnitude) <= 0.001 + 1e-9, e.id);
      fromTable += 1;
    }
  }
  assert.equal(fromTable, 337 - ECLIPSES.filter((e) => e.type === 'penumbral').length);
  // Two the old toFixed(3) got wrong: NASA prints 1.299 (catalogue 1.2995) and 1.049 (1.0495).
  assert.equal(eclipseById('2036-02-11-lunar')?.shownMagnitude, '1.299');
  assert.equal(eclipseById('2064-08-12-solar')?.shownMagnitude, '1.049');
});

test('region text: present, British English, house style', () => {
  for (const e of ECLIPSES) {
    for (const [field, text] of [['region', e.region], ['path', e.path]] as const) {
      if (field === 'path' && !text) continue;
      assert.ok(text.length > 2, `${e.id} ${field}`);
      assert.doesNotMatch(text, /[–—!]|--/, `${e.id} ${field}: no en or em dash, double hyphen or exclamation mark`);
      assert.doesNotMatch(text, /(^|[ ,])(n|s|e|w|ne|nw|se|sw|c)\.? /, `${e.id} ${field}: no NASA direction abbreviation left`);
      assert.doesNotMatch(text, /\b(N\.|S\.|C\.|E\.|Mid East|Oc\.|U\.S|US|UAE|Dom\.|Fr\.)/, `${e.id} ${field}: no abbreviation left`);
      assert.doesNotMatch(text, /Scandanavia|Indondesia|Afganistan|Nambia|Carribean|Quatar|Zaire|Swaziland|,\s*,|\. [A-Z]/, `${e.id} ${field}: NASA's slips corrected`);
      assert.doesNotMatch(text, /\bCenter\b|\bcenter\b/);
      assert.doesNotMatch(text, /western East Indies/, `${e.id}: "western Indonesia" (data review D-10)`);
      assert.doesNotMatch(text, /eastern East Indies/, `${e.id}: "eastern Indonesia" (K-1)`);
    }
    assert.ok(e.nasa.length > 2);
  }
  // K-1 (approved by Marcos 2026-10-16): NASA's "e Indies" reads "eastern Indonesia", as "w Indies"
  // reads "western Indonesia"; NASA's own words stay in the nasa field.
  const eIndies = ECLIPSES.filter((e) => /(^|, )e Indies/.test(e.nasa));
  assert.deepEqual(eIndies.map((e) => e.id), ['2059-05-27-lunar', '2064-07-28-lunar']);
  for (const e of eIndies) {
    assert.match(e.region, /^eastern Indonesia, /);
    assert.match(e.nasa, /^e Indies, /);
  }
});

test('data/eclipses.json is the same list, for stage B', () => {
  const doc = JSON.parse(readFileSync(new URL('../data/eclipses.json', import.meta.url), 'utf8'));
  assert.equal(doc.firstDay, DATA_FIRST_DAY);
  assert.equal(doc.lastYear, DATA_LAST_YEAR);
  assert.deepEqual(doc.eclipses, ECLIPSES.map((e) => ({ ...e })));
  assert.equal(doc.pages.length, 18);
});

test('next, upcoming, filters and year groups', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  assert.equal(nextEclipse(now)?.id, '2027-02-06-solar');
  // Greatest eclipse 15:59:32 UTC is shown as 16:00; the countdown and the list follow the minute shown (code review C-20).
  assert.equal(nextEclipse(Date.parse('2027-02-06T15:59:59Z'))?.id, '2027-02-06-solar', 'still next until the minute shown');
  assert.equal(nextEclipse(Date.parse('2027-02-06T16:00:00Z'))?.id, '2027-02-20-lunar', 'at the minute shown it is no longer next');
  assert.equal(upcoming(Date.parse('2027-02-06T16:00:00Z')).length, 336);
  assert.equal(nextEclipse(Date.parse('2101-01-01T00:00:00Z')), undefined);
  assert.equal(upcoming(now).length, 337);
  assert.equal(upcoming(Date.parse('2100-06-01T00:00:00Z')).length, 2);
  const solar = ECLIPSES.filter((e) => matches(e, { kind: 'solar', type: 'all' }));
  const lunar = ECLIPSES.filter((e) => matches(e, { kind: 'lunar', type: 'all' }));
  assert.equal(solar.length + lunar.length, 337);
  assert.equal(solar.length, 168);
  assert.equal(lunar.length, 169);
  const totalLunar = ECLIPSES.filter((e) => matches(e, { kind: 'lunar', type: 'total' }));
  assert.ok(totalLunar.every((e) => e.kind === 'lunar' && e.type === 'total'));
  assert.deepEqual(typesFor('lunar'), ['total', 'partial', 'penumbral']);
  assert.deepEqual(typesFor('solar'), ['total', 'annular', 'hybrid', 'partial']);
  const groups = groupByYear(ECLIPSES);
  assert.equal(groups.length, 74);
  assert.equal(groups[0]?.year, 2027);
  assert.equal(groups.at(-1)?.year, 2100);
  assert.equal(groups.reduce((n, g) => n + g.eclipses.length, 0), 337);
});
