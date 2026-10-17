// The stage B contract (spec section 9): everything the Android app calls, in one place. The
// Android app bundles the web files and runs this page in a WebView; its native side never parses
// this JavaScript. It reads data/eclipses.json (the same list, written by
// tools/build-eclipse-data.py, checked equal by the tests) and ports planAlarm() to Kotlin, checked
// against tests/alarm-vectors.json. What the page sends to the native side is a plain JSON message,
// described in the spec; nothing here touches the DOM.

export { ECLIPSES, DATA_FIRST_DAY, DATA_LAST_YEAR, DECADE_COUNTS } from './data.js';
export { eclipseById, groupByYear, matches, nextEclipse, typesFor, upcoming } from './eclipses.js';
export {
  DAYS_BEFORE, DEFAULT_SPEC, DEFAULT_TIME, MAX_ALARMS, MINUTES_BEFORE, RECORD_GRACE_MS, isRecordId, isValidRecord, isValidRecordSet, isValidSpec,
  nextNewSpec, planAlarm, planAlarms, recordFate, recordsFromRows, ringing, rowsFromRecords,
} from './alarms.js';
export { buildIcs, EVENT_MINUTES, PRODID, triggerDuration } from './ics.js';
export { alarmWords, eclipseName, greatestMinute, icsFileName, isIcsFileName, localWhen, magnitudeWords } from './format.js';
export { deviceZone, wallTimeToInstant } from './zoned.js';
export type { AlarmRecord, AlarmSpec, Eclipse, PlannedAlarm, PlannerRow, RecordFate } from './types.js';

/** The version of this contract. Stage B refuses a page whose contract it does not know. */
export const CONTRACT_VERSION = 1;
