// The stage B contract (spec section 9): everything the Android app calls, in one place. The
// Android app bundles the web files and runs this page in a WebView; its native side never parses
// this JavaScript. It reads data/eclipses.json (the same list, written by
// tools/build-eclipse-data.py, checked equal by the tests) and ports planAlarm() to Kotlin, checked
// against tests/alarm-vectors.json. What the page sends to the native side is a plain JSON message,
// described in the spec; nothing here touches the DOM.

export { ECLIPSES, DATA_FIRST_DAY, DATA_LAST_YEAR, DECADE_COUNTS } from './data.js';
export { eclipseById, groupByYear, matches, nextEclipse, typesFor, upcoming } from './eclipses.js';
export {
  DAYS_BEFORE, DEFAULT_SPEC, DEFAULT_TIME, defaultSpecAt, MAX_ALARMS, MAX_START_OFFSET_MS, MINUTES_BEFORE, RECORD_GRACE_MS, isPlace, isRecordId, isValidRecord, isValidRecordSet, isValidSpec,
  nextNewSpec, planAlarm, planAlarms, planRecord, recordAnchor, recordFate, recordsFromRows, recordZone, ringing, rowsFromRecords,
} from './alarms.js';
export { buildIcs, EVENT_MINUTES, PRODID, triggerDuration } from './ics.js';
export { alarmWords, eclipseName, greatestMinute, icsFileName, isIcsFileName, localWhen, magnitudeWords } from './format.js';
export { deviceZone, wallTimeToInstant } from './zoned.js';
export type { AlarmRecord, AlarmRecordV1, AlarmRecordV2, AlarmSpec, Eclipse, LocalAnchor, PlannedAlarm, PlannerRow, RecordFate } from './types.js';

/**
 * The version of this contract. Nothing reads it; it documents the change of 12 November 2026:
 * 2 added the version 2 alarm record (a city's start and zone) beside the version 1 record.
 */
export const CONTRACT_VERSION = 2;
