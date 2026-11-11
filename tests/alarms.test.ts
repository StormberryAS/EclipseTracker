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
  DEFAULT_SPEC, DEFAULT_TIME, MAX_ALARMS, defaultSpecAt, RECORD_GRACE_MS, choiceOf, fireInstantAt, isRecordId, isValidRecord, isValidRecordSet, isValidSpec, nextNewSpec, planAlarm, planAlarmAt, planAlarms, planAlarmsAt,
  recordFate, recordsFromRows, ringing, rowsFromRecords, specForChoice,
} from '#core/alarms.js';
import { ECLIPSES } from '#core/data.js';
import { greatestMinute } from '#core/format.js';
import type { AlarmSpec, DaysBefore, MinutesBefore, PlannerRow, RecordFate } from '#core/types.js';
import { defined } from './helpers.ts';

/** tests/alarm-vectors.json: hand-worked plans, each alarm as the planner gives it. */
interface AlarmVectors {
  readonly cases: ReadonlyArray<{
    readonly name: string; readonly greatest: string; readonly zone: string; readonly now: string; readonly specs: AlarmSpec[];
    readonly want: ReadonlyArray<{ readonly fireAt: string; readonly dst: string }>;
  }>;
}
/** tests/record-vectors.json: what a re-plan does with one stored record. */
interface RecordVectors {
  readonly graceHours: number;
  readonly cases: ReadonlyArray<{
    readonly name: string; readonly record: unknown; readonly eclipse: { readonly id: string; readonly greatest: string } | null;
    readonly zone: string; readonly now: string;
    readonly want: { readonly action: 'arm'; readonly fireAt: string } | { readonly action: 'delete'; readonly reason: string };
  }>;
}

const vectors = JSON.parse(readFileSync(new URL('./alarm-vectors.json', import.meta.url), 'utf8')) as AlarmVectors;
const records = JSON.parse(readFileSync(new URL('./record-vectors.json', import.meta.url), 'utf8')) as RecordVectors;
const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

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
    const got: RecordFate = recordFate(c.record, c.eclipse ?? undefined, c.zone, Date.parse(c.now));
    assert.deepEqual(got.action === 'arm' ? { action: 'arm', fireAt: iso(got.fireAt) } : got, c.want);
  });
}

test('the record vectors keep what code review C-1 asked for, and the grace period is the one in core', () => {
  assert.equal(records.graceHours * 3600000, RECORD_GRACE_MS);
  const want = records.cases.map((c) => c.want.action === 'arm' ? 'arm' : c.want.reason);
  for (const k of ['arm', 'passed', 'expired', 'unknown-eclipse', 'invalid']) assert.ok(want.includes(k), k);
  // An alarm after greatest eclipse survives a re-plan after greatest eclipse (the C-1 defect).
  const c1 = defined(records.cases[0], 'the first record case');
  assert.ok(Date.parse(c1.now) > Date.parse(defined(c1.eclipse, 'its eclipse').greatest) && c1.want.action === 'arm');
  // Some alarm rings more than 24 hours after greatest eclipse, so 24 hours would not be a safe grace.
  assert.ok(records.cases.some((c) => c.want.action === 'arm' && c.eclipse !== null && Date.parse(c.want.fireAt) - Date.parse(c.eclipse.greatest) > 24 * 3600000));
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
  const specs = ([0, 1, 2, 3, 7] as const).map((d): AlarmSpec => ({ kind: 'day', daysBefore: d, time: '23:59' }));
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

test('with a city the default alarm is the day before at 12:00 when the eclipse starts before 12:00 local time, else the day itself (Marcos, 2026-11-11)', () => {
  const day0 = { kind: 'day', daysBefore: 0, time: '12:00' };
  const day1 = { kind: 'day', daysBefore: 1, time: '12:00' };
  // Sydney, eclipse 2027-07-18: the penumbral start is Monday 19 July at 01:57 local time (UTC+10), 15:57 UTC on 18 July.
  const night = Date.parse('2027-07-18T15:57:00Z');
  assert.deepEqual(defaultSpecAt(night, 'Australia/Sydney'), day1);
  assert.deepEqual(defaultSpecAt(Date.parse('2027-07-18T01:57:00Z'), 'Australia/Sydney'), day1, '11:57 local');
  assert.deepEqual(defaultSpecAt(Date.parse('2027-07-18T02:00:00Z'), 'Australia/Sydney'), day0, '12:00 local');
  // The edges: 11:59 is before noon, 12:00 and 12:01 are not; 00:00 is before noon.
  assert.deepEqual(defaultSpecAt(Date.parse('2027-03-10T10:59:00Z'), 'Europe/Oslo'), day1, '11:59 in Oslo');
  assert.deepEqual(defaultSpecAt(Date.parse('2027-03-10T11:00:00Z'), 'Europe/Oslo'), day0, '12:00 in Oslo');
  assert.deepEqual(defaultSpecAt(Date.parse('2027-03-10T11:01:00Z'), 'Europe/Oslo'), day0, '12:01 in Oslo');
  assert.deepEqual(defaultSpecAt(Date.parse('2027-03-09T23:00:00Z'), 'Europe/Oslo'), day1, '00:00 in Oslo');
  // The zone decides, not the device: the same minute is the night in Oslo and the afternoon in Sydney.
  const same = Date.parse('2027-03-10T05:00:00Z');
  assert.deepEqual(defaultSpecAt(same, 'Europe/Oslo'), day1, '06:00 in Oslo');
  assert.deepEqual(defaultSpecAt(same, 'Australia/Sydney'), day0, '16:00 in Sydney');
  // A new object each time, and the plain default is untouched.
  assert.notEqual(defaultSpecAt(night, 'Australia/Sydney'), defaultSpecAt(night, 'Australia/Sydney'));
  assert.deepEqual(DEFAULT_SPEC, day0);
  // The day-before alarm rings before the start, so it needs no "after the start" warning.
  const planned = planAlarmAt(night, defaultSpecAt(night, 'Australia/Sydney'), 'Australia/Sydney', Date.parse('2027-01-01T00:00:00Z'));
  assert.equal(new Date(planned.fireAt).toISOString(), '2027-07-18T02:00:00.000Z', 'Sunday 18 July 2027 at 12:00 in Sydney');
  assert.equal(planned.afterGreatest, false);
});

test('every real eclipse plans every option in five zones without throwing, and before-alarms come before greatest eclipse', () => {
  // Nine options, more than the eight one eclipse can have, so in two plans.
  const day = ([0, 1, 2, 3, 7] as const satisfies readonly DaysBefore[]).map((d): AlarmSpec => ({ kind: 'day', daysBefore: d, time: '12:00' }));
  const before = ([15, 30, 60, 120] as const satisfies readonly MinutesBefore[]).map((m): AlarmSpec => ({ kind: 'before', minutes: m }));
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
      assert.equal((Date.parse(defined(p[0], 'the day-of alarm').localDate) - Date.parse(defined(p[4], 'the week-before alarm').localDate)) / 86400000, 7);
    }
  }
});

test('after the eclipse every alarm has passed; ringing() keeps only ok alarms, in order', () => {
  const e = defined(ECLIPSES[0], 'the first eclipse');
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
  const first = defined(ECLIPSES[0], 'the first eclipse');
  // A spec the planner does not offer, from outside: the type says it cannot happen, the guard checks.
  assert.throws(() => planAlarm(first, { kind: 'before', minutes: 45 } as unknown as AlarmSpec, 'UTC', 0), RangeError);
  assert.throws(() => planAlarm(first, DEFAULT_SPEC, 'Mars/Olympus_Mons', 0), RangeError);
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
  const first = defined(ECLIPSES[0], 'the first eclipse');
  const nine = Array.from({ length: 9 }, (_, i): AlarmSpec => ({ kind: 'day', daysBefore: 0, time: `1${i}:00` }));
  assert.throws(() => planAlarms(first, nine, 'UTC', 0), RangeError);
  assert.equal(planAlarms(first, nine.slice(0, MAX_ALARMS), 'UTC', 0).length, 8);
  const id = (n: number): string => n.toString(16).padStart(32, '0');
  const set = nine.map((spec, i) => ({ v: 1, id: id(i), eclipseId: '2027-02-06-solar', spec }));
  assert.ok(isValidRecordSet(set.slice(0, 8)));
  assert.ok(!isValidRecordSet(set), 'nine for one eclipse');
  assert.ok(isValidRecordSet([...set.slice(0, 8), { ...set[8], eclipseId: '2027-02-20-lunar' }]), 'eight for one and one for another');
  assert.ok(!isValidRecordSet([set[0], { ...set[1], id: set[0]?.id }]), 'an id twice');
  assert.ok(!isValidRecordSet({}) && isValidRecordSet([]));
});

test('stage B: rows from stored records keep their ids, and records from rows keep them too (code review C-14)', () => {
  const a = { v: 1, id: 'a'.repeat(32), eclipseId: '2027-02-06-solar', spec: { kind: 'before', minutes: 15 } } as const;
  const b = { v: 1, id: 'b'.repeat(32), eclipseId: '2027-02-20-lunar', spec: DEFAULT_SPEC } as const;
  const c = { v: 1, id: 'c'.repeat(32), eclipseId: '2027-02-06-solar', spec: { kind: 'day', daysBefore: 7, time: '08:30' } } as const;
  const rows: PlannerRow[] = rowsFromRecords([a, b, { junk: true }, c], '2027-02-06-solar');
  assert.deepEqual(rows, [{ id: a.id, spec: a.spec }, { id: c.id, spec: c.spec }]);
  const newId = () => 'd'.repeat(32);
  const back = recordsFromRows('2027-02-06-solar', [...rows, { spec: DEFAULT_SPEC }], newId);
  assert.deepEqual(back, [a, c, { v: 1, id: 'd'.repeat(32), eclipseId: '2027-02-06-solar', spec: DEFAULT_SPEC }]);
  assert.ok(isValidRecordSet(back));
  assert.throws(() => recordsFromRows('2027-02-06', rows, newId), RangeError);
  const row0 = defined(rows[0], 'the first row');
  assert.throws(() => recordsFromRows('2027-02-06-solar', [row0, row0], newId), RangeError, 'an id twice');
  assert.throws(() => recordsFromRows('2027-02-06-solar', Array.from({ length: 9 }, () => ({ spec: DEFAULT_SPEC })), newId), RangeError);
});

test('a new alarm row starts as the first option not yet used, with the last time typed (ALARM-8)', () => {
  const order: string[] = [];
  const specs: AlarmSpec[] = [];
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
  const day: AlarmSpec = { kind: 'day', daysBefore: 0, time: '08:30' };
  assert.equal(choiceOf(day), 'day-0');
  assert.deepEqual(specForChoice('day-7', day), { kind: 'day', daysBefore: 7, time: '08:30' });
  assert.deepEqual(specForChoice('before', day, '12:00', 60), { kind: 'before', minutes: 60 });
  assert.deepEqual(specForChoice('day-1', { kind: 'before', minutes: 15 }, '09:00'), { kind: 'day', daysBefore: 1, time: '09:00' });
  assert.equal(choiceOf({ kind: 'before', minutes: 15 }), 'before');
  assert.throws(() => specForChoice('day-5', day), RangeError);
});

// ==== Counted from an anchor minute (city filter, 11 November 2026) ===========================

test('planAlarmsAt from greatest eclipse is exactly planAlarms, for every alarm vector', () => {
  for (const c of vectors.cases) {
    const anchor = greatestMinute({ greatest: c.greatest });
    assert.deepEqual(planAlarmsAt(anchor, c.specs, c.zone, Date.parse(c.now)), planAlarms({ greatest: c.greatest }, c.specs, c.zone, Date.parse(c.now)), c.name);
  }
  const e = defined(ECLIPSES[0], 'the first eclipse');
  const spec: AlarmSpec = { kind: 'day', daysBefore: 2, time: '08:30' };
  assert.deepEqual(planAlarmAt(greatestMinute(e), spec, 'Europe/Oslo', 0), planAlarm(e, spec, 'Europe/Oslo', 0));
});

test('with a city: "before" counts from the anchor, and a day alarm uses the date of the anchor in the city\'s zone', () => {
  // An eclipse that starts at 23:30 UTC on 1 August is already 2 August in Sydney (UTC+10) and still 1 August in Honolulu (UTC-10).
  const anchor = Date.parse('2027-08-01T23:30:00Z');
  const before = fireInstantAt(anchor, { kind: 'before', minutes: 60 }, 'Australia/Sydney');
  assert.equal(new Date(before.epochMs).toISOString(), '2027-08-01T22:30:00.000Z');
  const sydney = fireInstantAt(anchor, { kind: 'day', daysBefore: 0, time: '12:00' }, 'Australia/Sydney');
  assert.equal(new Date(sydney.epochMs).toISOString(), '2027-08-02T02:00:00.000Z'); // 12:00 on 2 August, UTC+10
  const honolulu = fireInstantAt(anchor, { kind: 'day', daysBefore: 0, time: '12:00' }, 'Pacific/Honolulu');
  assert.equal(new Date(honolulu.epochMs).toISOString(), '2027-08-01T22:00:00.000Z'); // 12:00 on 1 August, UTC-10
  const week = fireInstantAt(anchor, { kind: 'day', daysBefore: 7, time: '08:30' }, 'Australia/Sydney');
  assert.equal(new Date(week.epochMs).toISOString(), '2027-07-25T22:30:00.000Z'); // 08:30 on 26 July
});

test('with a city: an alarm after the anchor is flagged, a duplicate is found, and a passed one is past', () => {
  const anchor = Date.parse('2027-08-02T08:33:00Z');
  const specs: AlarmSpec[] = [{ kind: 'day', daysBefore: 0, time: '12:00' }, { kind: 'before', minutes: 30 }, { kind: 'before', minutes: 30 }];
  const planned = planAlarmsAt(anchor, specs, 'Africa/Cairo', Date.parse('2027-08-02T08:00:00Z'));
  assert.equal(planned[0]?.afterGreatest, true);
  assert.equal(planned[1]?.status, 'ok');
  assert.equal(planned[2]?.status, 'duplicate');
  assert.equal(planAlarmAt(anchor, { kind: 'before', minutes: 15 }, 'UTC', Date.parse('2027-08-02T08:30:00Z')).status, 'past');
  assert.throws(() => planAlarmAt(anchor, DEFAULT_SPEC, 'Mars/Olympus', 0), RangeError);
});
