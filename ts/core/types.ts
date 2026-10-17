// The shapes every core module shares. Type information only: this file compiles to an empty
// module. Stage B (Android) mirrors these shapes in Kotlin; change them only together with the spec
// (section 9, "The stage B contract").

export type EclipseKind = 'solar' | 'lunar';

export type EclipseType = 'total' | 'annular' | 'hybrid' | 'partial' | 'penumbral';

/** One eclipse as NASA's catalogue gives it (see ts/core/data.ts for the sources). */
export interface Eclipse {
  /**
   * "2027-02-06-solar": NASA's calendar date of greatest eclipse and the kind. Stable: alarm records
   * refer to it. (NASA dates eclipses in TD; in this list that is always the UTC date too, a test checks.)
   */
  readonly id: string;
  readonly kind: EclipseKind;
  readonly type: EclipseType;
  /** The instant of greatest eclipse, UTC, to the second: "2027-02-06T15:59:32Z". */
  readonly greatest: string;
  /** The catalogue's own time of greatest eclipse in Terrestrial Dynamical Time, and its Delta T in seconds. */
  readonly td: string;
  readonly deltaT: number;
  readonly saros: number;
  readonly gamma: number;
  /** Solar: the eclipse magnitude. Lunar: the umbral magnitude (negative for a penumbral eclipse). */
  readonly magnitude: number;
  /** Lunar only: the penumbral magnitude. */
  readonly penMagnitude?: number;
  /**
   * The magnitude the page shows, as text to 3 decimals: the decade table's own value (solar, and
   * the umbral magnitude of a total or partial lunar eclipse), or for a penumbral lunar eclipse its
   * penumbral magnitude rounded half up. Shown as it is, never re-rounded.
   */
  readonly shownMagnitude: string;
  /** Where it can be seen, in British English. */
  readonly region: string;
  /** Total, annular and hybrid solar eclipses: the countries and seas on the central path. Otherwise empty. */
  readonly path: string;
  /** The decade table's own words, before the rewrite. */
  readonly nasa: string;
}

/**
 * One alarm as the person chose it: the question, never the answer. The time it rings is worked
 * out from this, the eclipse and the time zone every time it is needed (as SunApp's AlarmRule).
 *
 *   { kind: 'day', daysBefore: 0, time: '12:00' }      on the day of the eclipse at 12:00
 *   { kind: 'day', daysBefore: 7, time: '08:30' }      a week before, at 08:30
 *   { kind: 'before', minutes: 30 }                    30 minutes before greatest eclipse
 *
 * "The day" is the date of greatest eclipse in the person's own time zone, which can differ from
 * the UTC date.
 */
export type AlarmSpec =
  | { readonly kind: 'day'; readonly daysBefore: DaysBefore; readonly time: string }
  | { readonly kind: 'before'; readonly minutes: MinutesBefore };

export type DaysBefore = 0 | 1 | 2 | 3 | 7;
export type MinutesBefore = 15 | 30 | 60 | 120;

/** Why an alarm will not ring, or what the person should know about it. */
export type AlarmStatus = 'ok' | 'past' | 'duplicate';

/** How a wall time was resolved on a day the clocks change. */
export type DstResolution = 'none' | 'gap' | 'overlap';

/** One alarm worked out for one eclipse, one time zone and one moment ("now"). */
export interface PlannedAlarm {
  readonly spec: AlarmSpec;
  /** The instant it rings, epoch milliseconds (UTC). */
  readonly fireAt: number;
  /** The local date and wall time it rings at, in the zone it was planned for: "2027-02-06", "12:00". */
  readonly localDate: string;
  readonly localTime: string;
  /** The zone's offset from UTC at that instant, in minutes (60 for Oslo in winter). */
  readonly offsetMinutes: number;
  readonly status: AlarmStatus;
  /** True when it rings after greatest eclipse (possible only for the "at a time of day" options). */
  readonly afterGreatest: boolean;
  /** 'gap': the chosen time does not exist that night and moved forward; 'overlap': it exists twice and the first is used. */
  readonly dst: DstResolution;
}

/**
 * The record stage B stores for each alarm (spec section 9.4). Plain JSON, exactly these four keys.
 * The id is random and never reused, so the Android request code derived from it stays stable for
 * the alarm's life. There is no on/off flag: an alarm the person no longer wants is deleted
 * (code review C-14, 2026-10-16).
 */
export interface AlarmRecord {
  readonly v: 1;
  readonly id: string;
  readonly eclipseId: string;
  readonly spec: AlarmSpec;
}

/**
 * One alarm row of the planner: the spec and, once it has been stored by stage B, the id of its
 * record. A row the person has just added has no id yet; recordsFromRows() gives it one.
 */
export interface PlannerRow {
  readonly id?: string;
  readonly spec: AlarmSpec;
}

/**
 * What a re-plan does with one stored record (spec section 9.4): arm it for fireAt, or delete it,
 * and why.
 *   invalid          the record is not one this version understands
 *   unknown-eclipse  its eclipse is not in the bundled list
 *   expired          48 hours have passed since greatest eclipse: no alarm can ring later
 *   passed           its own time is not after now: it has rung, or it was missed (the phone was
 *                    off, or a change of time zone moved it into the past); never rung late
 */
export type RecordFate =
  | { readonly action: 'arm'; readonly fireAt: number }
  | { readonly action: 'delete'; readonly reason: 'invalid' | 'unknown-eclipse' | 'expired' | 'passed' };
