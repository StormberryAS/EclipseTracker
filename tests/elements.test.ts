// The element sets for a city (ts/core/elements.ts): written by tools/build-local-elements.py from
// the NASA files vendored in tools/nasa-elements/. The tool stops on any difference from the list;
// these tests check the generated module against the list again from the TypeScript side, and the
// vendored files against their recorded sha256.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ECLIPSES } from '#core/data.js';
import { LUNAR_ELEMENTS, SOLAR_ELEMENTS } from '#core/elements.js';
import { defined } from './helpers.ts';

const root = new URL('../', import.meta.url);
const sha256 = (name: string): string => createHash('sha256').update(readFileSync(new URL(name, root))).digest('hex');

test('the vendored NASA element files match their FETCHLOG rows', () => {
  const rows = readFileSync(new URL('tools/nasa-elements/FETCHLOG.tsv', root), 'utf8').trim().split('\n').map((l) => l.split('\t'));
  assert.equal(rows.length, 2);
  for (const [fetched, url, status, name, sha] of rows) {
    assert.match(defined(fetched, 'time'), /^2026-11-11T\d\d:\d\d:\d\dZ$/);
    assert.match(defined(url, 'url'), /^https:\/\/eclipse\.gsfc\.nasa\.gov\/(JSEX\/SE2001|JLEX\/LE2001)\.js$/);
    assert.equal(status, '200');
    assert.equal(sha256(`tools/nasa-elements/${defined(name, 'name')}`), sha);
  }
  assert.deepEqual(rows.map((r) => r[3]), ['JSEX_SE2001.txt', 'JLEX_LE2001.txt']);
});

test('the generated module has one element set for every eclipse of the list, and none more', () => {
  const ids = [...SOLAR_ELEMENTS, ...LUNAR_ELEMENTS].map((el) => el.id).sort();
  assert.deepEqual(ids, ECLIPSES.map((e) => e.id).sort());
  assert.equal(SOLAR_ELEMENTS.length, 168);
  assert.equal(LUNAR_ELEMENTS.length, 169);
});

test('Delta T within 1 s of the list; the reference instant within 1800 s of greatest eclipse in TD', () => {
  for (const e of ECLIPSES) {
    const el = defined([...SOLAR_ELEMENTS, ...LUNAR_ELEMENTS].find((x) => x.id === e.id), e.id);
    assert.ok(Math.abs(el.dT - e.deltaT) <= 1, `${e.id}: Delta T ${el.dT} against ${e.deltaT}`);
    const td = Date.parse(e.greatest) + e.deltaT * 1000; // the list's greatest eclipse is UT; TD is later by Delta T
    assert.ok(Math.abs(Date.parse(el.t0) - td) <= 1800_000 + 1000, `${e.id}: T0 ${el.t0} is far from ${e.greatest}`);
    assert.match(el.t0, /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/);
  }
});

test('lunar contacts: the contacts a type lacks are null, the others increase', () => {
  const types = new Map(ECLIPSES.map((e) => [e.id, e.type] as const));
  for (const el of LUNAR_ELEMENTS) {
    const [p1, u1, u2, g, u3, u4, p4] = el.c;
    const type = types.get(el.id);
    const have = el.c.map((v) => v !== null);
    if (type === 'total') assert.deepEqual(have, [true, true, true, true, true, true, true], el.id);
    else if (type === 'partial') assert.deepEqual(have, [true, true, false, true, false, true, true], el.id);
    else assert.deepEqual(have, [true, false, false, true, false, false, true], el.id);
    const order = [p1, u1, u2, g, u3, u4, p4].filter((v): v is number => v !== null);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), `${el.id}: contacts in order`);
  }
});

test('the data tool says the module is current', () => {
  const out = execFileSync('python3', ['-I', new URL('tools/build-local-elements.py', root).pathname, '--check'], { encoding: 'utf8' });
  assert.match(out, /matches tools\/nasa-elements/);
});

test('the data tool stops on a changed source (a copy with one digit changed)', () => {
  // Run the tool against a scratch copy of the repository files it reads; the real files are not touched.
  const dir = execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim();
  try {
    execFileSync('mkdir', ['-p', `${dir}/tools/nasa-elements`, `${dir}/tools/nasa`, `${dir}/data`, `${dir}/ts/core`]);
    execFileSync('cp', [new URL('tools/build-local-elements.py', root).pathname, `${dir}/tools/`]);
    for (const f of ['FETCHLOG.tsv', 'JSEX_SE2001.txt', 'JLEX_LE2001.txt']) execFileSync('cp', [new URL(`tools/nasa-elements/${f}`, root).pathname, `${dir}/tools/nasa-elements/`]);
    execFileSync('cp', [new URL('tools/nasa/LEcat5_LE2001-2100.html', root).pathname, `${dir}/tools/nasa/`]);
    execFileSync('cp', [new URL('data/eclipses.json', root).pathname, `${dir}/data/`]);
    execFileSync('cp', [new URL('ts/core/elements.ts', root).pathname, `${dir}/ts/core/`]);
    execFileSync('python3', ['-I', `${dir}/tools/build-local-elements.py`, '--check'], { encoding: 'utf8' });
    const file = `${dir}/tools/nasa-elements/JLEX_LE2001.txt`;
    writeFileEdit(file);
    assert.throws(() => execFileSync('python3', ['-I', `${dir}/tools/build-local-elements.py`, '--check'], { encoding: 'utf8', stdio: 'pipe' }), /sha256|status 1/);
  } finally {
    execFileSync('rm', ['-rf', dir]);
  }
});

function writeFileEdit(path: string): void {
  const text = readFileSync(path, 'ascii');
  execFileSync('python3', ['-I', '-c', 'import sys;p=sys.argv[1];t=open(p).read();open(p,"w").write(t.replace("2451919.348374","2451919.348375",1))', path]);
  assert.notEqual(readFileSync(path, 'ascii'), text);
}
