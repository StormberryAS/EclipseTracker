// The alarm planner (spec section 6): every option, the default 12:00, several alarms per eclipse,
// the local day, clock changes in Europe/Oslo and Australia/Sydney, an eclipse too close for an
// offset, duplicates, and the guards stage B relies on. The hand-worked cases live in
// alarm-vectors.json, which stage B's Kotlin port must also pass, as it must record-vectors.json
// (what a re-plan does with a stored record, code review C-1); tools/vectors/build-vectors.py
// --check proves all of them against Python's zoneinfo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_SPEC, DEFAULT_TIME, MAX_ALARMS, RECORD_GRACE_MS, choiceOf, isRecordId, isValidRecord, isValidRecordSet, isValidSpec, nextNewSpec, planAlarm, planAlarms,
  recordFate, recordsFromRows, ringing, rowsFromRecords, specForChoice,
} from '../core/alarms.js';
import { ECLIPSES } from '../core/data.js';
import { greatestMinute } from '../core/format.js';

const vectors = JSON.parse(readFileSync(new URL('./alarm-vectors.json', import.meta.url), 'utf8'));
const records = JSON.parse(readFileSync(new URL('./record-vectors.json', import.meta.url), 'utf8'));
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

for (const c of vectors.cases) {
  test(`vector: ${c.name}`, () => {
    const got = planAlarms({ greatest: c.greatest }, c.specs, c.zone, Date.parse(c.now));
    assert.equal(got.length, c.want.length);
    got.forEach((g, i) => {
      assert.deepEqual(
        { fireAt: iso(g.fireAt), localDate: g.localDate, localTime: g.localTime, offsetMinutes: g.offsetMinutes, status: g.status, afterGreatest: g.afterGreatest, dst: g.dst },
        c.want[i],
        `alarm ${i + 1}`,
      );
      assert.deepEqual(g.spec, c.specs[i]);
    });
  });
}

for (const c of records.cases) {
  test(`record: ${c.name}`, () => {
    const got = recordFate(c.record, c.eclipse ?? undefined, c.zone, Date.parse(c.now));
    assert.deepEqual(got.action === 'arm' ? { action: 'arm', fireAt: iso(got.fireAt) } : got, c.want);
  });
}

test('the record vectors keep what code review C-1 asked for, and the grace period is the one in core', () => {
  assert.equal(records.graceHours * 3600000, RECORD_GRACE_MS);
  const want = records.cases.map((c) => c.want.action === 'arm' ? 'arm' : c.want.reason);
  for (const k of ['arm', 'passed', 'expired', 'unknown-eclipse', 'invalid']) assert.ok(want.includes(k), k);
  // An alarm after greatest eclipse survives a re-plan after greatest eclipse (the C-1 defect).
  const c1 = records.cases[0];
  assert.ok(Date.parse(c1.now) > Date.parse(c1.eclipse.greatest) && c1.want.action === 'arm');
  // Some alarm rings more than 24 hours after greatest eclipse, so 24 hours would not be a safe grace.
  assert.ok(records.cases.some((c) => c.want.action === 'arm' && Date.parse(c.want.fireAt) - Date.parse(c.eclipse.greatest) > 24 * 3600000));
});

test('greatest eclipse is rounded half a minute up: floor((ms + 30000) / 60000) (code review C-7)', () => {
  assert.equal(new Date(greatestMinute({ greatest: '2039-06-21T17:11:30Z' })).toISOString(), '2039-06-21T17:12:00.000Z');
  assert.equal(new Date(greatestMinute({ greatest: '2039-06-21T17:11:29Z' })).toISOString(), '2039-06-21T17:11:00.000Z');
  assert.equal(new Date(greatestMinute({ greatest: '2027-02-06T15:59:32Z' })).toISOString(), '2027-02-06T16:00:00.000Z');
  for (const e of ECLIPSES) {
    const ms = Date.parse(e.greatest);
    assert.equal(greatestMinute(e), Math.floor((ms + 30000) / 60000) * 60000);
  }
  assert.ok(vectors.cases.some((c) => c.greatest.endsWith(':30Z')), 'a vector at exactly half a minute');
});

test('no alarm in any real eclipse rings 48 hours or more after greatest eclipse, in any zone the tests use', () => {
  const specs = [0, 1, 2, 3, 7].map((d) => ({ kind: 'day', daysBefore: d, time: '23:59' }));
  for (const zone of ['Europe/Oslo', 'Antarctica/Troll', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Australia/Lord_Howe']) {
    for (const e of ECLIPSES) {
      for (const a of planAlarms(e, specs, zone, 0)) assert.ok(a.fireAt - greatestMinute(e) < 26 * 3600000, `${e.id} ${zone}`);
    }
  }
});

test('the vectors cover every option the planner offers', () => {
  const seen = new Set(vectors.cases.flatMap((c) => c.specs.map((s) => (s.kind === 'day' ? `day-${s.daysBefore}` : `before-${s.minutes}`))));
  for (const k of ['day-0', 'day-1', 'day-2', 'day-3', 'day-7', 'before-15', 'before-30', 'before-60', 'before-120']) assert.ok(seen.has(k), k);
  const zones = new Set(vectors.cases.map((c) => c.zone));
  for (const z of ['Europe/Oslo', 'Australia/Sydney', 'America/New_York', 'Australia/Lord_Howe', 'Asia/Kolkata', 'UTC']) assert.ok(zones.has(z), z);
  const dst = new Set(vectors.cases.flatMap((c) => c.want.map((w) => `${c.zone} ${w.dst}`)));
  for (const k of ['Europe/Oslo gap', 'Europe/Oslo overlap', 'Australia/Sydney gap', 'Australia/Sydney overlap', 'America/New_York gap', 'America/New_York overlap',
    'Australia/Lord_Howe gap', 'Australia/Lord_Howe overlap']) assert.ok(dst.has(k), k);
  // Every instant in the file is written one way (code review C-23).
  for (const c of vectors.cases) for (const t of [c.now, ...c.want.map((w) => w.fireAt)]) assert.match(t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('the default alarm is on the day of the eclipse at 12:00 (Marcos, 2026-10-16)', () => {
  assert.equal(DEFAULT_TIME, '12:00');
  assert.deepEqual(DEFAULT_SPEC, { kind: 'day', daysBefore: 0, time: '12:00' });
  assert.equal(MAX_ALARMS, 8);
});

test('every real eclipse plans every option in five zones without throwing, and before-alarms come before greatest eclipse', () => {
  // Nine options, more than the eight one eclipse can have, so in two plans.
  const day = [0, 1, 2, 3, 7].map((d) => ({ kind: 'day', daysBefore: d, time: '12:00' }));
  const before = [15, 30, 60, 120].map((m) => ({ kind: 'before', minutes: m }));
  for (const zone of ['Europe/Oslo', 'Australia/Sydney', 'America/Sao_Paulo', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    for (const e of ECLIPSES) {
      const p = planAlarms(e, day, zone, Date.parse('2026-10-16T00:00:00Z'));
      const q = planAlarms(e, before, zone, Date.parse('2026-10-16T00:00:00Z'));
      for (const a of p) {
        assert.equal(a.status, 'ok', `${e.id} ${zone}`);
        assert.equal(a.localTime, '12:00', `${e.id} ${zone}: noon always exists`);
      }
      for (const a of q) {
        assert.equal(a.status, 'ok', `${e.id} ${zone}`);
        assert.equal(a.afterGreatest, false);
      }
      // A week before is always 7 local days before the day-of alarm.
      assert.equal((Date.parse(p[0].localDate) - Date.parse(p[4].localDate)) / 86400000, 7);
    }
  }
});

test('after the eclipse every alarm has passed; ringing() keeps only ok alarms, in order', () => {
  const e = ECLIPSES[0];
  const after = Date.parse(e.greatest) + 1;
  const p = planAlarms(e, [{ kind: 'before', minutes: 15 }, { kind: 'day', daysBefore: 7, time: '08:00' }], 'Europe/Oslo', after);
  assert.deepEqual(p.map((a) => a.status), ['past', 'past']);
  assert.deepEqual(ringing(p), []);
  const q = planAlarms(e, [{ kind: 'before', minutes: 15 }, { kind: 'day', daysBefore: 7, time: '08:00' }, { kind: 'before', minutes: 15 }], 'Europe/Oslo', 0);
  assert.deepEqual(ringing(q).map((a) => a.spec), [{ kind: 'day', daysBefore: 7, time: '08:00' }, { kind: 'before', minutes: 15 }]);
});

test('guards: specs and records from outside (a bridge, storage) are checked', () => {
  for (const good of [{ kind: 'day', daysBefore: 0, time: '00:00' }, { kind: 'day', daysBefore: 7, time: '23:59' }, { kind: 'before', minutes: 120 }]) assert.ok(isValidSpec(good));
  for (const bad of [null, {}, { kind: 'day', daysBefore: 4, time: '12:00' }, { kind: 'day', daysBefore: 0, time: '24:00' }, { kind: 'day', daysBefore: 0, time: '9:00' },
    { kind: 'day', daysBefore: 0 }, { kind: 'before', minutes: 45 }, { kind: 'before', minutes: '15' }, { kind: 'before', minutes: 15, extra: 1 }, { kind: 'after', minutes: 15 }]) assert.ok(!isValidSpec(bad), JSON.stringify(bad));
  assert.throws(() => planAlarm(ECLIPSES[0], { kind: 'before', minutes: 45 }, 'UTC', 0), RangeError);
  assert.throws(() => planAlarm(ECLIPSES[0], DEFAULT_SPEC, 'Mars/Olympus_Mons', 0), RangeError);
  const rec = { v: 1, id: '0123456789abcdef0123456789abcdef', eclipseId: '2027-02-06-solar', spec: DEFAULT_SPEC };
  assert.ok(isValidRecord(rec));
  assert.ok(!isValidRecord({ ...rec, v: 2 }));
  assert.ok(!isValidRecord({ ...rec, id: 'x' }));
  assert.ok(!isValidRecord({ ...rec, id: '0123456789ABCDEF0123456789ABCDEF' }));
  assert.ok(!isValidRecord({ ...rec, eclipseId: '2027-02-06' }));
  assert.ok(!isValidRecord({ ...rec, spec: { kind: 'before', minutes: 5 } }));
  assert.ok(!isValidRecord({ ...rec, enabled: true }), 'the on/off flag is gone (code review C-14)');
  assert.ok(!isValidRecord([rec]));
  assert.ok(isRecordId(rec.id) && !isRecordId(1));
});

test('the cap of 8 alarms per eclipse holds in core (data review D-7)', () => {
  const nine = Array.from({ length: 9 }, (_, i) => ({ kind: 'day', daysBefore: 0, time: `1${i}:00` }));
  assert.throws(() => planAlarms(ECLIPSES[0], nine, 'UTC', 0), RangeError);
  assert.equal(planAlarms(ECLIPSES[0], nine.slice(0, MAX_ALARMS), 'UTC', 0).length, 8);
  const id = (n) => n.toString(16).padStart(32, '0');
  const set = nine.map((spec, i) => ({ v: 1, id: id(i), eclipseId: '2027-02-06-solar', spec }));
  assert.ok(isValidRecordSet(set.slice(0, 8)));
  assert.ok(!isValidRecordSet(set), 'nine for one eclipse');
  assert.ok(isValidRecordSet([...set.slice(0, 8), { ...set[8], eclipseId: '2027-02-20-lunar' }]), 'eight for one and one for another');
  assert.ok(!isValidRecordSet([set[0], { ...set[1], id: set[0].id }]), 'an id twice');
  assert.ok(!isValidRecordSet({}) && isValidRecordSet([]));
});

test('stage B: rows from stored records keep their ids, and records from rows keep them too (code review C-14)', () => {
  const a = { v: 1, id: 'a'.repeat(32), eclipseId: '2027-02-06-solar', spec: { kind: 'before', minutes: 15 } };
  const b = { v: 1, id: 'b'.repeat(32), eclipseId: '2027-02-20-lunar', spec: DEFAULT_SPEC };
  const c = { v: 1, id: 'c'.repeat(32), eclipseId: '2027-02-06-solar', spec: { kind: 'day', daysBefore: 7, time: '08:30' } };
  const rows = rowsFromRecords([a, b, { junk: true }, c], '2027-02-06-solar');
  assert.deepEqual(rows, [{ id: a.id, spec: a.spec }, { id: c.id, spec: c.spec }]);
  const newId = () => 'd'.repeat(32);
  const back = recordsFromRows('2027-02-06-solar', [...rows, { spec: DEFAULT_SPEC }], newId);
  assert.deepEqual(back, [a, c, { v: 1, id: 'd'.repeat(32), eclipseId: '2027-02-06-solar', spec: DEFAULT_SPEC }]);
  assert.ok(isValidRecordSet(back));
  assert.throws(() => recordsFromRows('2027-02-06', rows, newId), RangeError);
  assert.throws(() => recordsFromRows('2027-02-06-solar', [rows[0], rows[0]], newId), RangeError, 'an id twice');
  assert.throws(() => recordsFromRows('2027-02-06-solar', Array.from({ length: 9 }, () => ({ spec: DEFAULT_SPEC })), newId), RangeError);
});

test('a new alarm row starts as the first option not yet used, with the last time typed (ALARM-8)', () => {
  const order = [];
  const specs = [];
  for (let i = 0; i < MAX_ALARMS; i++) {
    const s = nextNewSpec(specs, '08:30');
    order.push(s.kind === 'before' ? `before-${s.minutes}` : `day-${s.daysBefore}-${s.time}`);
    specs.push(s);
  }
  assert.deepEqual(order, ['day-0-08:30', 'day-1-08:30', 'before-30', 'day-7-08:30', 'before-60', 'day-2-08:30', 'day-3-08:30', 'before-15']);
  // On the day at 12:00 is taken, but at 08:30 it is not.
  assert.deepEqual(nextNewSpec([DEFAULT_SPEC], '08:30'), { kind: 'day', daysBefore: 0, time: '08:30' });
  assert.deepEqual(nextNewSpec([DEFAULT_SPEC]), { kind: 'day', daysBefore: 1, time: '12:00' });
});

test('changing the option keeps what still applies', () => {
  const day = { kind: 'day', daysBefore: 0, time: '08:30' };
  assert.equal(choiceOf(day), 'day-0');
  assert.deepEqual(specForChoice('day-7', day), { kind: 'day', daysBefore: 7, time: '08:30' });
  assert.deepEqual(specForChoice('before', day, '12:00', 60), { kind: 'before', minutes: 60 });
  assert.deepEqual(specForChoice('day-1', { kind: 'before', minutes: 15 }, '09:00'), { kind: 'day', daysBefore: 1, time: '09:00' });
  assert.equal(choiceOf({ kind: 'before', minutes: 15 }), 'before');
  assert.throws(() => specForChoice('day-5', day), RangeError);
});
