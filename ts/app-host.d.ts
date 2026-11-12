// The contract between the page (ts/app.ts) and the Android app's bridge script
// (android/web-overlay/android-bridge.ts), in one place so both sides are type-checked against it.
// Moved here from ts/app.ts on 17 October 2026, when the bridge script became TypeScript.
// Types only: a declaration file, so tsc emits nothing for it and the page loads nothing more.

import type { alarmWords, eclipseName, greatestMinute, localWhen } from './core/format.js';
import type { isValidRecordSet, planAlarm, planRecord, recordsFromRows, rowsFromRecords } from './core/alarms.js';
import type { eclipseById, upcoming } from './core/eclipses.js';
import type { AlarmSpec, Eclipse, LocalAnchor, PlannerRow } from './core/types.js';

/**
 * What the Android app's bridge script offers the page (spec 9.1, B-4). Absent on the website.
 *   travelNote  the app's travel note, which replaces the website's two travel sentences (9.9)
 *   rowsFor     the stored alarms of one eclipse as planner rows (9.6, 9.8): the planner opens
 *               with them instead of the default
 *   saveFile    Save through Android's save screen; resolves true once the file is written
 *   attach      called once at start with what the page lets the app do (AppPage)
 *   cities      true when the app offers the city chooser (city filter, 11 November 2026). Set in
 *               both editions since EclipseTracker 2.1.0: with ringing alarms that count from the
 *               city's start (sovereign, version 2 records), or with no ringing alarms at all (Google
 *               Play); the page keeps the chooser hidden when it is not set
 *   loadCity    the kept city's text (core/citysearch storedCityText), or null; the app keeps it in
 *               its own preferences, because the WebView's DOM storage stays off
 *   saveCity    keeps that text, or forgets the city for null; resolves true once done
 */
export interface AppHost {
  readonly travelNote?: string;
  rowsFor(eclipseId: string): Promise<readonly PlannerRow[]>;
  saveFile(name: string, text: string): Promise<boolean>;
  attach(page: AppPage): void;
  readonly cities?: boolean;
  loadCity?(): Promise<string | null>;
  saveCity?(text: string | null): Promise<boolean>;
}

/** What the page lets the app's bridge script do. No words: the script has its own. */
export interface AppPage {
  /** The pure modules the app's parts work with (spec 9.2). */
  readonly core: {
    eclipseById: typeof eclipseById; eclipseName: typeof eclipseName; alarmWords: typeof alarmWords; localWhen: typeof localWhen;
    planAlarm: typeof planAlarm; planRecord: typeof planRecord; recordsFromRows: typeof recordsFromRows; rowsFromRecords: typeof rowsFromRecords;
    isValidRecordSet: typeof isValidRecordSet; greatestMinute: typeof greatestMinute; upcoming: typeof upcoming;
  };
  /** The device's zone, as the page last read it. */
  zone(): string;
  /**
   * Opens the planner for an eclipse, with its stored alarms, as Set alarms does; also after
   * greatest eclipse while the app keeps its records (fix B, A-9).
   */
  openFor(eclipseId: string, opener: HTMLElement): void;
  /** The open planner's eclipse, or undefined. */
  planning(): Eclipse | undefined;
  /**
   * The planner's rows that would go into the calendar file (passed and repeated alarms left out),
   * each with its row number and record id, after Save's checks (except that the eclipse may have
   * passed while the app keeps its records, fix B A-9); undefined (and the reason said) otherwise.
   * `local` is there when a city is chosen: the records are then version 2 and count from it
   * (EclipseTracker 2.1.0).
   */
  ringingRows(): { eclipse: Eclipse; count: number; rows: Array<{ index: number; id?: string; spec: AlarmSpec }>; local?: LocalAnchor } | undefined;
  /** Gives rows their record ids once stored; a row not stored loses any id it had. */
  setRowIds(ids: ReadonlyArray<string | undefined>): void;
  /** The calendar file Save would make, or undefined (and the reason said). */
  file(): { name: string; text: string; alarms: number } | undefined;
  /** A status line in the planner, said through its one live region. */
  say(text: string): void;
}
