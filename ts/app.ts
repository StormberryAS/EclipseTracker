/*! app.js and core/*.js are compiled from ts/ by tools/build-ts.sh, which leaves out every comment
    but this one: the explanations are in the source. Edit ts/, never the .js: the build refuses to
    overwrite a hand edit, and its check mode fails on one. */

// The page: the countdown to the next eclipse, the list of every eclipse to 2100, and the alarm
// planner that saves a calendar file. Everything that can be pure lives in core/ (no DOM there);
// this file only reads the page, writes the page and saves the file.
//
// Privacy (spec section 10): no network request to any other host, no cookie. The planner's choices
// live in this page only and are gone when it closes. The page's own Content-Security-Policy
// (index.html) allows no connection at all. The one thing kept is the city the person chooses (city
// filter, Marcos, 2026-11-11): on the website, and only after they choose one, in this browser's
// localStorage under 'eclipsetracker.city' (a record with v: 1 and the name, country, latitude,
// longitude and time zone of the catalogue row, the record MeteorWatch keeps under its own key; it
// never leaves the device), inside try/catch, with the Clear city button to remove it.
// The Android app's WebView has DOM storage off and the page never touches storage there.
//
// Inside the Android app (spec section 9, stage B) the page is the same file. The app's bridge
// script (android/web-overlay/android-bridge.ts, compiled to android-bridge.js beside it, loaded
// only by the APK, before this module) sets window.EclipseTrackerApp (its type, AppHost, is in
// ts/app-host.d.ts); when it is there, the planner opens with the alarms the app has stored,
// Save goes to Android's save screen, and the travel sentence is the app's. That object carries
// every word of the app's own: nothing here adds a text, and on the website, where it is absent,
// nothing below changes what the page does (see "Inside the Android app" at the end).
//
// The city filter (see "The city" below): the person picks a city by hand from the shared Labs
// city catalogue (cities.js, loaded the first time the chooser is used). With a city, only the
// eclipses that can be seen from there are counted and listed (core/local.ts), every time shows in
// the city's zone, the countdown runs to the minute the eclipse starts there, and the calendar file
// and the alarm planner count from that minute. No GPS, no permission, no network. With no city the
// page is as it was. In the Android app the chooser stays hidden until the app's bridge says it can
// keep a city (AppHost.cities, ts/app-host.d.ts).

import { DEFAULT_SPEC, MAX_ALARMS, MAX_START_OFFSET_MS, defaultSpecAt, RECORD_GRACE_MS, choiceOf, isPlace, isValidRecordSet, nextNewSpec, planAlarm, planAlarmsAt, planRecord, plannerFrame, recordsFromRows, ringing, rowsFromRecords, specForChoice } from './core/alarms.js';
import { parseStoredCity, searchCities, storedCityText } from './core/citysearch.js';
import type { City, StoredCity } from './core/citysearch.js';
import { ECLIPSES, eclipseById, groupByYear, matches, nextEclipse, typesFor, upcoming } from './core/eclipses.js';
import type { Filter } from './core/eclipses.js';
import { BEFORE_CHOICES, DAY_CHOICES, alarmWords, countdownParts, countdownWords, dateWords, eclipseName, greatestMinute, icsFileName, localEndWords, localListWords, localMaximumWords, localName, localNotes, localWhen, longDate, magnitudeWords, minuteOf, offsetWords, shortDate } from './core/format.js';
import { buildIcs } from './core/ics.js';
import { localAll } from './core/local.js';
import type { Local } from './core/local.js';
import type { PlannerFrame } from './core/alarms.js';
import type { AlarmSpec, Eclipse, EclipseKind, EclipseType, MinutesBefore, PlannedAlarm, PlannerRow } from './core/types.js';
import type { AppHost, AppPage } from './app-host.js';
import { deviceZone, isKnownZone, isWallTime, localDateTime, offsetMinutes } from './core/zoned.js';

/**
 * The device's time zone. Read again once a minute and when the page comes back into view, so a
 * person who travels with the page open sees their new zone (code review C-22).
 */
let ZONE = deviceZone();

// ==== The chosen city (state; the chooser is further down) ===================================

/** The chosen city, or none: then the page is exactly the page without the city filter. */
let city: StoredCity | undefined;
/** The city's time zone when this runtime knows it, else UTC. */
let cityZone = 'UTC';
/** Every eclipse that can be seen from the city, by id (empty with no city). */
let locals = new Map<string, Local>();

/** The zone every time on the page shows in: the city's when one is chosen, else the device's. */
function zoneNow(): string {
  return city ? cityZone : ZONE;
}

/** The minute an eclipse counts from: with a city the minute it starts there, else greatest eclipse. */
function anchorOf(e: Eclipse): number {
  const l = city ? locals.get(e.id) : undefined;
  return l ? minuteOf(l.start) : greatestMinute(e);
}

/**
 * Where the planner counts from for an eclipse (plan Q4, Marcos, 2026-11-12): with a chosen city
 * that sees it, the start there in the city's zone; else greatest eclipse in the device's zone, as
 * with no city. The overview's Change can open an eclipse the city cannot see (an alarm set with no
 * city or for another city): its alarms then stay version 1 records and the planner says so.
 */
function frameOf(e: Eclipse): PlannerFrame {
  return plannerFrame(e, city ? locals.get(e.id)?.start : undefined, cityZone, ZONE);
}

/** The chosen city when the planner's eclipse is seen from it, else none. */
function plannerCity(): StoredCity | undefined {
  return planning && frameOf(planning).local ? city : undefined;
}

/** The eclipses the countdown and the list work with: all of them, or those seen from the city. */
function visibleEclipses(): readonly Eclipse[] {
  return city ? ECLIPSES.filter((e) => locals.has(e.id)) : ECLIPSES;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, string>> = {}, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  if (text) node.textContent = text;
  return node;
}

/** Writes text only when it differs, so nothing is rewritten (or re-announced) for nothing. */
function setText(node: HTMLElement, text: string): boolean {
  if (node.textContent === text) return false;
  node.textContent = text;
  return true;
}

/** "Sat 6 Feb 2027, 16:59": the minute an eclipse counts from (greatest eclipse, or its start at the city), short, in the page's zone. */
function shortWhen(e: Eclipse): string {
  const { date, time } = localDateTime(zoneNow(), anchorOf(e));
  return `${shortDate(date)}, ${time}`;
}

// ---- The countdown --------------------------------------------------------------------------

let shown: Eclipse | undefined;
let wordsMinute = Number.NaN;

const DIGITS = ['cd-days', 'cd-hours', 'cd-minutes', 'cd-seconds'];

function showDigits(values: readonly number[]): void {
  DIGITS.forEach((id, i) => setText($(id), String(values[i] ?? 0).padStart(2, '0')));
}

function showNext(e: Eclipse | undefined): void {
  shown = e;
  const button = $('next-alarms') as HTMLButtonElement;
  $('event-details').hidden = !e;
  setText($('countdown-eyebrow'), city ? `Next eclipse seen from ${city.name}` : 'Next eclipse');
  setText($('countdown-to'), city ? 'Starts in' : 'Greatest eclipse in');
  $('countdown-to').hidden = !e;
  if (!e) {
    // After the last eclipse in the list (2100), or the last one seen from the city: nothing to show but that (code review C-19).
    const none = city ? `No more eclipses seen from ${city.name} in the list` : 'No more eclipses in the list';
    setText($('eclipse-type'), none);
    showDigits([0, 0, 0, 0]);
    setText($('countdown-words'), `${none}.`);
    button.disabled = true;
    delete button.dataset.id;
    return;
  }
  const local = city ? locals.get(e.id) : undefined;
  setText($('eclipse-type'), local ? localName(e.kind, local) : eclipseName(e));
  setText($('eclipse-date-label'), local ? 'Starts' : 'Date');
  setText($('eclipse-date'), localWhen(zoneNow(), anchorOf(e)));
  for (const id of ['eclipse-max-row', 'eclipse-end-row', 'eclipse-seen-row']) $(id).hidden = !local;
  if (local) {
    setText($('eclipse-max'), localMaximumWords(e.kind, local, cityZone));
    setText($('eclipse-end'), localEndWords(local, cityZone));
    const notes = localNotes(e.kind, local);
    setText($('eclipse-seen'), notes.length > 0 ? `${localName(e.kind, local)}. ${notes.join(' ')}` : localName(e.kind, local));
  }
  setText($('eclipse-region'), e.region);
  setText($('eclipse-path'), e.path);
  $('eclipse-path-row').hidden = !e.path;
  setText($('eclipse-type-detail'), eclipseName(e));
  const mag = magnitudeWords(e);
  setText($('eclipse-magnitude-label'), mag.label);
  setText($('eclipse-magnitude'), mag.value);
  button.disabled = false;
  button.dataset.id = e.id;
  paintCountdown(Date.now());
}

/** Re-reads the device's zone; when it has changed, everything that shows a local time is redrawn. */
function checkZone(): void {
  const zone = deviceZone();
  if (zone === ZONE) return;
  ZONE = zone;
  showNext(shown);
  renderList(true);
  if (planning) {
    plannerHeader(planning);
    updateResults();
  }
}

/** The digits and the words for the eclipse shown, now. The words count whole minutes; the timer is not a live region. */
function paintCountdown(now: number): void {
  if (!shown) return;
  const left = anchorOf(shown) - now;
  const p = countdownParts(left);
  showDigits([p.days, p.hours, p.minutes, p.seconds]);
  setText($('countdown-words'), `${city ? 'Starts in' : 'Greatest eclipse in'} ${countdownWords(left)}.`);
}

/**
 * Once a second, on the second: the digits; once a minute: the words a screen reader reads, the
 * zone check and the planner's results (an alarm can pass while it is open). The countdown runs to
 * the minute the page shows beside it (code review C-20): greatest eclipse rounded to the minute,
 * or with a city chosen the minute the eclipse starts there.
 */
function tick(): void {
  const now = Date.now();
  if (!shown || anchorOf(shown) <= now) {
    const passed = shown !== undefined;
    showNext(nextEclipse(now, visibleEclipses(), anchorOf));
    if (passed) renderList(true);
  }
  const minute = Math.floor(now / 60_000);
  if (minute !== wordsMinute) {
    wordsMinute = minute;
    checkZone();
    if (planning) updateResults();
  }
  paintCountdown(now);
  window.setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
}

// ---- The list -------------------------------------------------------------------------------

const TYPE_LABELS: Readonly<Record<EclipseType, string>> = {
  total: 'Total', annular: 'Annular', hybrid: 'Hybrid', partial: 'Partial', penumbral: 'Penumbral',
};

function currentFilter(): Filter {
  const kind = ($('filter-kind') as HTMLSelectElement).value as EclipseKind | 'all';
  const type = ($('filter-type') as HTMLSelectElement).value as EclipseType | 'all';
  return { kind, type };
}

/** Refills the type choices for the kind shown, keeping the type chosen when it still applies. */
function fillTypes(): void {
  const select = $('filter-type') as HTMLSelectElement;
  const kind = ($('filter-kind') as HTMLSelectElement).value as EclipseKind | 'all';
  const keep = select.value;
  select.replaceChildren(el('option', { value: 'all' }, 'Any type'));
  for (const t of typesFor(kind)) select.append(el('option', { value: t }, TYPE_LABELS[t]));
  select.value = typesFor(kind).includes(keep as EclipseType) ? keep : 'all';
}

function itemFor(e: Eclipse): HTMLLIElement {
  const li = el('li', { class: `eclipse-item eclipse-${e.kind}`, 'data-id': e.id });
  const head = el('div', { class: 'eclipse-head' });
  head.append(el('span', { class: `badge badge-${e.kind}` }, e.kind === 'solar' ? 'Solar' : 'Lunar'));
  head.append(el('h4', { class: 'eclipse-name' }, eclipseName(e)));
  li.append(head);
  const when = el('p', { class: 'eclipse-when' });
  const local = city ? locals.get(e.id) : undefined;
  const offset = offsetWords(offsetMinutes(zoneNow(), anchorOf(e)));
  when.append(el('time', { datetime: new Date(anchorOf(e)).toISOString().replace(/:00\.000Z$/, 'Z') }, `${local ? 'Starts ' : ''}${shortWhen(e)} (${offset})`));
  li.append(when);
  li.append(el('p', { class: 'eclipse-region' }, `Visible from ${e.region}.`));
  if (city && local) li.append(el('p', { class: 'eclipse-local' }, localListWords(e.kind, city.name, local)));
  if (e.path) li.append(el('p', { class: 'eclipse-path' }, `Central path: ${e.path}.`));
  const mag = magnitudeWords(e);
  li.append(el('p', { class: 'eclipse-mag' }, `${mag.label} ${mag.value}`));
  const button = el('button', { type: 'button', class: 'btn btn-alarm', 'data-id': e.id }, 'Set alarms');
  const name = (local ? localName(e.kind, local) : eclipseName(e)).toLowerCase();
  button.append(el('span', { class: 'sr-only' }, ` for the ${name} of ${dateWords(localDateTime(zoneNow(), anchorOf(e)).date)}`));
  li.append(button);
  return li;
}

/** "{n} eclipses in {y} years.", in the singular where it is one (code review C-19). */
function countWords(n: number, years: number): string {
  const seen = city ? ` seen from ${city.name}` : '';
  return `${n} ${n === 1 ? 'eclipse' : 'eclipses'}${seen} in ${years} ${years === 1 ? 'year' : 'years'}.`;
}

/**
 * The year groups. A group's eclipses are built the first time it opens, so the page starts fast.
 * keep: redraw after an eclipse has passed or the zone has changed, keeping the years that were
 * open and the keyboard focus where it was (code review C-18); a filter change starts afresh with
 * the first year open.
 */
function renderList(keep = false): void {
  const host = $('eclipse-list');
  const openYears = new Set<string>();
  let focusId: string | undefined;
  let focusYear: string | undefined;
  if (keep) {
    host.querySelectorAll<HTMLDetailsElement>('details.year-group[open]').forEach((d) => { if (d.dataset.year) openYears.add(d.dataset.year); });
    const active = document.activeElement;
    if (active instanceof HTMLElement && host.contains(active)) {
      focusId = active.closest<HTMLElement>('.btn-alarm')?.dataset.id;
      focusYear = active.closest<HTMLElement>('.year-group')?.dataset.year;
    }
  }
  const filter = currentFilter();
  const all = upcoming(Date.now(), visibleEclipses(), anchorOf);
  const list = all.filter((e) => matches(e, filter));
  const groups = groupByYear(list, (e) => Number(localDateTime(zoneNow(), anchorOf(e)).date.slice(0, 4)));
  const frag = document.createDocumentFragment();
  groups.forEach((g, i) => {
    const details = el('details', { class: 'year-group', 'data-year': String(g.year) });
    const summary = el('summary', { class: 'year-summary' });
    summary.append(el('h3', { class: 'year-title' }, String(g.year)));
    summary.append(el('span', { class: 'year-count' }, `${g.eclipses.length} ${g.eclipses.length === 1 ? 'eclipse' : 'eclipses'}`));
    details.append(summary);
    const fill = () => {
      if (details.dataset.filled) return;
      details.dataset.filled = 'true';
      const ul = el('ul', { class: 'eclipse-items' });
      for (const e of g.eclipses) ul.append(itemFor(e));
      details.append(ul);
    };
    details.addEventListener('toggle', () => { if (details.open) fill(); });
    if (i === 0 || openYears.has(String(g.year))) {
      details.open = true;
      fill();
    }
    frag.append(details);
  });
  host.replaceChildren(frag);
  let text: string;
  if (all.length === 0) text = city ? `No eclipse in the list can be seen from ${city.name}.` : 'There are no more eclipses in the list.';
  else if (list.length === 0) text = 'No eclipse of this kind and type is left in the list.';
  else if (list.length === all.length) text = countWords(all.length, groups.length);
  else text = `Showing ${list.length} of ${all.length} ${all.length === 1 ? 'eclipse' : 'eclipses'}${city ? ` seen from ${city.name}` : ''}, in ${groups.length} ${groups.length === 1 ? 'year' : 'years'}.`;
  setText($('list-count'), text);
  if (focusId !== undefined || focusYear !== undefined) {
    // Back to the same button; if its eclipse has just passed, to its year, else to the list's heading.
    const button = focusId ? host.querySelector<HTMLElement>(`.btn-alarm[data-id="${focusId}"]`) : null;
    const year = focusYear ? host.querySelector<HTMLElement>(`.year-group[data-year="${focusYear}"] > summary`) : null;
    (button ?? year ?? $('list-heading')).focus();
  }
}

// ---- The planner ----------------------------------------------------------------------------

interface Row {
  /** The id of the stored record this row edits (stage B), or none for a new row. */
  id?: string;
  spec: AlarmSpec;
  /** What the time field holds, valid or not. */
  timeText: string;
}

let planning: Eclipse | undefined;
let rows: Row[] = [];
let opener: HTMLElement | null = null;
let lastTime = DEFAULT_SPEC.kind === 'day' ? DEFAULT_SPEC.time : '12:00';
let lastMinutes: MinutesBefore = 30;

/** The planner's one live region (code review C-3): status messages and the result of the alarm just changed. */
let announceTimer = 0;
function announce(text: string): void {
  const live = $('planner-live');
  live.textContent = '';
  window.clearTimeout(announceTimer);
  // Emptied first and filled a moment later, so the same message twice is read twice.
  announceTimer = window.setTimeout(() => { live.textContent = text; }, 60);
}

/** The status line under the alarms, shown and read out. */
function say(text: string): void {
  $('planner-status').textContent = text;
  announce(text);
}

function plannerHeader(e: Eclipse): void {
  setText($('planner-title'), `Alarms for the ${eclipseName(e).toLowerCase()}`);
  const { anchor: t, local } = frameOf(e);
  if (city && local) {
    // With a city the alarms count from the minute the eclipse starts there, in the city's zone,
    // wherever the person is: they ring at fixed moments (spec 9.9 does not apply).
    setText($('planner-when'), `Starts in ${city.name}: ${localWhen(cityZone, t)}, which is ${localDateTime('UTC', t).time} UTC.`);
    setText($('planner-zone'), `Times of day are for the time zone of ${city.name}, ${cityZone}. The alarms ring at those moments wherever you are, so your calendar can show another hour. Alarms before the start always follow the eclipse.`);
    return;
  }
  setText($('planner-when'), `Greatest eclipse: ${localWhen(ZONE, t)}, which is ${localDateTime('UTC', t).time} UTC.`);
  // Inside the app ringing alarms follow the phone's zone, so the app's travel note replaces the
  // website's two sentences about the calendar file (spec 9.9).
  const travel = host?.travelNote ?? 'If you travel, those alarms still ring at the same moment, which may be a different hour where you are. Alarms before greatest eclipse always follow the eclipse.';
  setText($('planner-zone'), `Times of day are for this device's time zone, ${ZONE}. ${travel}`);
}

/**
 * Opens the planner for an eclipse. On the website it always starts with the default alarm; stage
 * B passes the rows of the alarms already stored for that eclipse (core rowsFromRecords), each
 * keeping its record id (code review C-14).
 */
function openPlanner(e: Eclipse, from: HTMLElement, start: readonly PlannerRow[] = []): void {
  planning = e;
  opener = from;
  // With a city that sees the eclipse the default depends on the local start: before 12:00 there, "the day before at 12:00" (Marcos, 2026-11-11).
  const frame = frameOf(e);
  const initial = start.length > 0 ? start.slice(0, MAX_ALARMS) : [{ spec: frame.local ? defaultSpecAt(frame.anchor, frame.zone) : DEFAULT_SPEC }];
  rows = initial.map((r) => ({ ...(r.id ? { id: r.id } : {}), spec: r.spec, timeText: r.spec.kind === 'day' ? r.spec.time : lastTime }));
  plannerHeader(e);
  $('planner-status').textContent = '';
  $('planner-live').textContent = '';
  renderRows();
  const dialog = $('planner') as HTMLDialogElement;
  dialog.showModal();
  (dialog.querySelector('.alarm-choice') as HTMLElement | null)?.focus();
}

function closePlanner(): void {
  ($('planner') as HTMLDialogElement).close();
}

function rowSpecs(): Array<AlarmSpec | null> {
  return rows.map((r) => (r.spec.kind === 'day' && !isWallTime(r.timeText) ? null : r.spec));
}

/** The words under one alarm. */
function resultWords(p: PlannedAlarm, planned: Array<PlannedAlarm | null>): string {
  if (p.status === 'past') return 'This time has already passed, so this alarm is left out of the file.';
  if (p.status === 'duplicate') {
    const first = planned.findIndex((q) => q !== null && q.status === 'ok' && q.fireAt === p.fireAt);
    return `This rings at the same moment as alarm ${first + 1}, so it is left out of the file.`;
  }
  let words = `Rings ${longDate(p.localDate)} at ${p.localTime} (${offsetWords(p.offsetMinutes)})`;
  // An alarm after greatest eclipse is a positive trigger, which some calendars drop (data review D-3).
  const after = plannerCity()
    ? ', after the eclipse starts. Some calendars leave out an alarm set for after the eclipse begins.'
    : ', after greatest eclipse. Some calendars leave out an alarm set for after the eclipse begins.';
  words += p.afterGreatest ? after : '.';
  const spec = p.spec;
  if (spec.kind === 'day' && p.dst === 'gap') words += ` The clocks go forward that night and ${spec.time} does not exist, so it rings at ${p.localTime}.`;
  if (spec.kind === 'day' && p.dst === 'overlap') words += ` The clocks go back that night and ${spec.time} happens twice; it rings the first time.`;
  return words;
}

/** Plans every row that is complete; null for a row whose time is not filled in. */
function planRows(now: number): Array<PlannedAlarm | null> {
  if (!planning) return [];
  const specs = rowSpecs();
  const complete = specs.filter((s): s is AlarmSpec => s !== null);
  const frame = frameOf(planning);
  const planned = planAlarmsAt(frame.anchor, complete, frame.zone, now);
  let k = 0;
  return specs.map((s) => (s === null ? null : planned[k++] ?? null));
}

/**
 * Writes each alarm's result line, only where it changed. The lines are not live regions (they are
 * each control's description); when `edited` is given, that alarm's new line is read out once
 * through the planner's live region.
 */
function updateResults(edited = -1): void {
  const planned = planRows(Date.now());
  const items = $('alarm-rows').querySelectorAll<HTMLElement>('.alarm-result');
  items.forEach((node, i) => {
    const p = planned[i] ?? null;
    const text = p ? resultWords(p, planned) : 'Choose a time for this alarm.';
    if (setText(node, text) && i === edited) announce(text);
    node.classList.toggle('is-warning', !p || p.status !== 'ok' || p.afterGreatest || p.dst !== 'none');
  });
  // Several calendar apps keep three alarms of a file at most (data review D-1).
  const inFile = ringing(planned.filter((p): p is PlannedAlarm => p !== null)).length;
  const three = $('planner-three');
  three.hidden = inFile <= 3;
  const save = $('save-ics');
  if (three.hidden) save.removeAttribute('aria-describedby');
  else save.setAttribute('aria-describedby', 'planner-three');
  ($('add-alarm') as HTMLButtonElement).disabled = rows.length >= MAX_ALARMS;
}

function renderRows(focusIndex = -1): void {
  const host = $('alarm-rows');
  host.replaceChildren();
  rows.forEach((row, i) => {
    const li = el('li', { class: 'alarm-row' });
    const fs = el('fieldset', { class: 'alarm-fieldset' });
    fs.append(el('legend', { class: 'alarm-legend' }, `Alarm ${i + 1}`));
    const resultId = `alarm-result-${i + 1}`;

    const choiceLabel = el('label', { class: 'field' });
    choiceLabel.append(el('span', { class: 'field-label' }, 'When'));
    const choice = el('select', { class: 'alarm-choice', 'aria-describedby': resultId });
    const seen = plannerCity() !== undefined;
    for (const c of DAY_CHOICES) choice.append(el('option', { value: c.value }, seen && c.value === 'before' ? 'Before the eclipse starts' : c.label));
    choice.value = choiceOf(row.spec);
    choiceLabel.append(choice);
    fs.append(choiceLabel);

    const timeLabel = el('label', { class: 'field alarm-time-field' });
    timeLabel.append(el('span', { class: 'field-label' }, 'At'));
    const time = el('input', { type: 'time', class: 'alarm-time', step: '60', required: '', 'aria-describedby': resultId });
    time.value = row.timeText;
    timeLabel.append(time);
    fs.append(timeLabel);

    const minutesLabel = el('label', { class: 'field alarm-minutes-field' });
    minutesLabel.append(el('span', { class: 'field-label' }, 'How long before'));
    const minutes = el('select', { class: 'alarm-minutes', 'aria-describedby': resultId });
    for (const c of BEFORE_CHOICES) minutes.append(el('option', { value: String(c.value) }, c.label));
    minutes.value = String(row.spec.kind === 'before' ? row.spec.minutes : lastMinutes);
    minutesLabel.append(minutes);
    fs.append(minutesLabel);

    const showFields = () => {
      timeLabel.hidden = row.spec.kind !== 'day';
      minutesLabel.hidden = row.spec.kind !== 'before';
    };
    /** An empty or partial time is marked invalid for assistive technology too (code review C-21). */
    const markTime = () => {
      if (row.spec.kind === 'day' && !isWallTime(row.timeText)) time.setAttribute('aria-invalid', 'true');
      else time.removeAttribute('aria-invalid');
    };
    showFields();
    markTime();

    choice.addEventListener('change', () => {
      row.spec = specForChoice(choice.value, row.spec, lastTime, lastMinutes);
      if (row.spec.kind === 'day') {
        if (!isWallTime(row.timeText)) {
          // A cleared field takes the time the alarm now uses, on the page as well as in the file
          // (code review C-4, data review D-4).
          row.timeText = row.spec.time;
          time.value = row.timeText;
        } else {
          row.spec = { ...row.spec, time: row.timeText };
        }
      } else {
        minutes.value = String(row.spec.minutes);
      }
      showFields();
      markTime();
      updateResults(i);
    });
    time.addEventListener('input', () => {
      row.timeText = time.value;
      if (row.spec.kind === 'day' && isWallTime(time.value)) {
        row.spec = { ...row.spec, time: time.value };
        lastTime = time.value;
      }
      markTime();
      updateResults(i);
    });
    minutes.addEventListener('change', () => {
      const m = Number(minutes.value) as MinutesBefore;
      row.spec = { kind: 'before', minutes: m };
      lastMinutes = m;
      updateResults(i);
    });

    fs.append(el('p', { class: 'alarm-result', id: resultId }));

    if (rows.length > 1) {
      const remove = el('button', { type: 'button', class: 'btn btn-remove' }, 'Remove');
      remove.append(el('span', { class: 'sr-only' }, ` alarm ${i + 1}`));
      remove.addEventListener('click', () => {
        rows.splice(i, 1);
        renderRows(Math.min(i, rows.length - 1));
        say(`Alarm ${i + 1} removed.`);
      });
      fs.append(remove);
    }
    li.append(fs);
    host.append(li);
  });
  updateResults();
  if (focusIndex >= 0) host.querySelectorAll<HTMLElement>('.alarm-choice')[focusIndex]?.focus();
}

function addRow(): void {
  if (rows.length >= MAX_ALARMS) return;
  const spec = nextNewSpec(rows.map((r) => r.spec), lastTime);
  rows.push({ spec, timeText: spec.kind === 'day' ? spec.time : lastTime });
  renderRows(rows.length - 1);
  say(rows.length >= MAX_ALARMS
    ? `Alarm ${rows.length} added. ${MAX_ALARMS} alarms is the most for one eclipse.`
    : `Alarm ${rows.length} added.`);
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Every row planned, after the checks Save makes: the eclipse still to come and every time filled
 * in. Says what is wrong (and focuses the empty time) and gives undefined otherwise.
 *
 * `kept` (the app's ringing alarms only, fix B A-9): the eclipse may have passed as long as the app
 * still keeps its records (RECORD_GRACE_MS, spec 9.4), because an alarm after greatest eclipse
 * (ALARM-2) can still be ahead; only the alarms still to ring are then set. The calendar file is
 * never made for a passed eclipse.
 */
function checkedPlan(now: number, kept = false): { eclipse: Eclipse; planned: PlannedAlarm[] } | undefined {
  if (!planning) return undefined;
  const g = frameOf(planning).anchor;
  const seenFrom = plannerCity();
  if (g <= now && !(kept && now < g + RECORD_GRACE_MS)) {
    say(seenFrom ? `This eclipse has already started in ${seenFrom.name}, so there is nothing to save.` : 'This eclipse has passed, so there is nothing to save.');
    return undefined;
  }
  const planned = planRows(now);
  const missing = planned.findIndex((p) => p === null);
  if (missing >= 0) {
    say(`Alarm ${missing + 1} needs a time.`);
    ($('alarm-rows').querySelectorAll<HTMLElement>('.alarm-time')[missing])?.focus();
    return undefined;
  }
  return { eclipse: planning, planned: planned.filter((p): p is PlannedAlarm => p !== null) };
}

/** The calendar file for the planner as it stands, as Save makes it, or undefined (and the reason said). */
function prepareFile(now: number): { name: string; text: string; alarms: number } | undefined {
  const plan = checkedPlan(now);
  if (!plan) return undefined;
  const local = city ? locals.get(plan.eclipse.id) : undefined;
  const text = buildIcs({
    eclipse: plan.eclipse, alarms: plan.planned, uid: randomHex(16), dtstamp: now,
    ...(city && local ? { local: { place: `${city.name}, ${city.country}`, city: city.name, zone: cityZone, local } } : {}),
  });
  return { name: icsFileName(plan.eclipse), text, alarms: ringing(plan.planned).length };
}

function savedWords(name: string, n: number): string {
  return `Saved ${name} with ${n === 0 ? 'no alarms' : n === 1 ? '1 alarm' : `${n} alarms`}. Open it with your calendar app.`;
}

function save(): void {
  const file = prepareFile(Date.now());
  if (!file) return;
  if (host) {
    // Inside the app: Android's save screen. The page says "Saved" only once the file is written.
    void host.saveFile(file.name, file.text).then((ok) => { if (ok) say(savedWords(file.name, file.alarms)); }, () => undefined);
    updateResults();
    return;
  }
  const url = URL.createObjectURL(new Blob([file.text], { type: 'text/calendar;charset=utf-8' }));
  const a = el('a', { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  say(savedWords(file.name, file.alarms));
  updateResults();
}

// ==== The city ==============================================================================
//
// The chooser: a combobox over the shared Labs city catalogue. cities.js (about 1.1 MB, 0.4 MB
// compressed) is added to the page only when the person first uses the chooser, and its 25,007
// cities are decoded only when the first search reads them; a city kept from an earlier visit needs
// neither, because what is kept is the version and the five values the filter needs (the record MeteorWatch keeps). The search is core/citysearch
// (MoonApp's, checked against its 162 captured results).

const CITY_KEY = 'eclipsetracker.city';
/** The shared Labs city catalogue. bump_assets.py stamps this literal with the file's hash, as it stamps an import. */
const CATALOGUE_URL = new URL('./cities.js', import.meta.url).href;
const INTRO_ALL = $('list-intro').textContent ?? '';
const NOTE_ALL = $('planner-note').textContent ?? '';
const KEEPS_NOTHING = 'EclipseTracker sends nothing and keeps nothing.';
/** The line under the chooser (website): what is kept, or that the browser would not keep it. */
const PRIVACY_KEPT = 'EclipseTracker remembers your city in this browser only and sends it nowhere. Clear it with the Clear city button.';
const PRIVACY_NOT_KEPT = 'This browser would not let EclipseTracker keep your city, so it is forgotten when you close the page. EclipseTracker sends it nowhere. Clear it with the Clear city button.';

let catalogue: Promise<void> | undefined;

/** Adds cities.js to the page, once. A failure is forgotten, so the next use tries again. */
function loadCatalogue(): Promise<void> {
  if (catalogue) return catalogue;
  const loaded = new Promise<void>((resolve, reject) => {
    // 'in' does not run the catalogue's getter, so nothing is decoded here.
    if ('CITIES' in globalThis && 'foldQuery' in globalThis) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = CATALOGUE_URL;
    script.async = true;
    script.addEventListener('load', () => {
      if ('CITIES' in globalThis && 'foldQuery' in globalThis) {
        resolve();
      } else {
        script.remove();
        reject(new Error('cities.js defined no catalogue'));
      }
    });
    script.addEventListener('error', () => {
      script.remove();
      reject(new Error('cities.js did not load'));
    });
    document.head.append(script);
  });
  catalogue = loaded;
  loaded.catch(() => { if (catalogue === loaded) catalogue = undefined; });
  return loaded;
}

/**
 * Keeps the chosen city, or forgets it: on the website in localStorage, in the app through the
 * bridge if it offers that. Never throws. True when the write worked (or the bridge took it), false
 * when the browser refused: the choice then lasts for this visit only, and the page says so.
 */
function keepCity(c: StoredCity | undefined): boolean {
  if (host) {
    if (typeof host.saveCity === 'function') host.saveCity(c ? storedCityText(c) : null).then(() => undefined, () => undefined);
    return true;
  }
  try {
    if (c) window.localStorage.setItem(CITY_KEY, storedCityText(c));
    else window.localStorage.removeItem(CITY_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * The city kept from an earlier visit, or undefined. A kept value that is not a city is removed. A
 * well-formed city whose time zone this browser does not know is left in place (a newer browser
 * may know it) and not used now. `blocked` is true when the browser would not let the page read
 * its storage at all.
 */
function readKeptCity(): { city: StoredCity | undefined; blocked: boolean } {
  let text: string | null;
  try {
    text = window.localStorage.getItem(CITY_KEY);
  } catch {
    return { city: undefined, blocked: true };
  }
  if (text === null) return { city: undefined, blocked: false };
  const c = parseStoredCity(text);
  if (c) return { city: c, blocked: false };
  if (!parseStoredCity(text, { anyZone: true })) {
    try {
      window.localStorage.removeItem(CITY_KEY);
    } catch {
      // Nothing more to do.
    }
  }
  return { city: undefined, blocked: false };
}

/**
 * Sets the city (or none) and everything that depends on it but the countdown and the list, which
 * the caller redraws. `stored` is true when the city is kept in this browser: the planner's closing
 * note then says so, and otherwise it keeps its sentence that nothing is kept.
 */
function setCityState(c: StoredCity | undefined, stored = false): void {
  city = c;
  cityZone = c && isKnownZone(c.tz) ? c.tz : 'UTC';
  locals = c ? localAll({ lat: c.lat, lon: c.lon }) : new Map();
  $('city-selected').hidden = !c;
  setText($('city-selected-text'), c ? `${c.name}, ${c.country}` : '');
  setText($('list-intro'), c
    ? `Eclipses that can be seen from ${c.name}, from NASA's eclipse catalogue, with the time each starts there in that city's time zone. Open a year to see its eclipses.`
    : INTRO_ALL);
  // On the website the planner's closing note must say that the chosen city is kept. In the app the bridge owns that sentence.
  if (!host) setText($('planner-note'), c && stored ? NOTE_ALL.replace(KEEPS_NOTHING, 'EclipseTracker sends nothing; it keeps only the city you chose, in this browser.') : NOTE_ALL);
}

/** Redraws the countdown and the list for the city now chosen, the list from its first year. */
function redrawForCity(): void {
  showNext(nextEclipse(Date.now(), visibleEclipses(), anchorOf));
  renderList();
}

/**
 * Starts the chooser: restores a kept city, shows the card where the page can use it, and wires
 * the combobox. A kept city is worked out here, before the first paint (about 20 to 30 ms on a
 * desktop; a slow phone may need some hundred): the page then opens on the right city and does not
 * flash the worldwide countdown first. Accepted on purpose.
 */
function initCity(): void {
  const card = $('city-card');
  const privacy = $('city-privacy');
  /** True once the person has picked or cleared a city: a late answer from the app's store must not undo that. */
  let touched = false;
  if (host) {
    if (host.cities !== true) return;
    privacy.textContent = typeof host.saveCity === 'function'
      ? 'Your city stays on this phone only. Clear it with the Clear city button.'
      : 'Your city stays on this phone and is forgotten when the app closes.';
    if (typeof host.loadCity === 'function') {
      host.loadCity().then((text) => {
        const kept = parseStoredCity(text);
        if (kept && !touched) {
          setCityState(kept);
          redrawForCity();
        }
      }, () => undefined);
    }
  } else {
    const kept = readKeptCity();
    privacy.textContent = kept.blocked ? PRIVACY_NOT_KEPT : PRIVACY_KEPT;
    if (kept.city) setCityState(kept.city, true);
  }
  card.hidden = false;

  const input = $('city-search') as HTMLInputElement;
  const dropdown = $('city-dropdown');
  const status = $('city-status');
  const LOADING = 'Loading the city list.';
  const rowsOf = new Map<HTMLLIElement, City>();
  let highlighted = -1;
  let statusTimer = 0;
  let suggestionsSaid = false;
  /** True while clear() puts the focus back in the search box itself: that focus must not start the catalogue's loading. */
  let focusIsOurs = false;

  const closeDropdown = (): void => {
    dropdown.hidden = true;
    dropdown.replaceChildren();
    rowsOf.clear();
    highlighted = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const highlight = (index: number): void => {
    highlighted = index;
    [...dropdown.children].forEach((li, i) => {
      li.classList.toggle('highlighted', i === index);
      li.setAttribute('aria-selected', i === index ? 'true' : 'false');
    });
    input.setAttribute('aria-activedescendant', `city-option-${index}`);
    dropdown.children[index]?.scrollIntoView?.({ block: 'nearest' });
  };
  const openDropdown = (matches: readonly City[]): void => {
    dropdown.replaceChildren();
    rowsOf.clear();
    highlighted = -1;
    input.removeAttribute('aria-activedescendant');
    matches.forEach((c, i) => {
      const li = el('li', { role: 'option', id: `city-option-${i}`, 'aria-selected': 'false' });
      li.append(el('span', { class: 'city-name' }, c.name), el('span', { class: 'city-country' }, c.country));
      rowsOf.set(li, c);
      dropdown.append(li);
    });
    dropdown.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  /** The suggestions for what is typed, announced once, 400 ms after the last key. */
  const search = (): void => {
    const cities = globalThis.CITIES;
    const fold = globalThis.foldQuery;
    if (!cities || !fold) return;
    // A row whose time zone this browser does not know is left out: its times could only show in UTC.
    const matches = searchCities(cities, fold, input.value).filter((c) => isKnownZone(c.tz));
    if (matches.length === 0) closeDropdown();
    else openDropdown(matches);
    window.clearTimeout(statusTimer);
    if (input.value.trim() === '') {
      // An empty box announces nothing; only a count of suggestions is taken back, not a message about a pick.
      if (suggestionsSaid) status.textContent = '';
      suggestionsSaid = false;
      return;
    }
    statusTimer = window.setTimeout(() => {
      status.textContent = matches.length === 0 ? 'No city found.' : matches.length === 1 ? '1 suggestion.' : `${matches.length} suggestions.`;
      suggestionsSaid = true;
    }, 400);
  };

  /** Starts loading the catalogue the first time the chooser is used. */
  const ensureCatalogue = (): void => {
    if (catalogue || focusIsOurs) return;
    input.setAttribute('aria-busy', 'true');
    status.textContent = LOADING;
    loadCatalogue().then(() => {
      input.removeAttribute('aria-busy');
      // Only the loading message is cleared: a message about a pick or Clear city, set meanwhile, stays.
      if (status.textContent === LOADING) status.textContent = '';
      search();
    }, () => {
      input.removeAttribute('aria-busy');
      status.textContent = 'The city list did not load. Reload the page to try again.';
    });
  };

  const pick = (c: City): void => {
    const kept: StoredCity = { name: c.name, country: c.country, lat: c.lat, lon: c.lon, tz: c.tz };
    touched = true;
    const stored = keepCity(kept);
    if (!host) privacy.textContent = stored ? PRIVACY_KEPT : PRIVACY_NOT_KEPT;
    setCityState(kept, stored);
    window.clearTimeout(statusTimer);
    input.value = '';
    closeDropdown();
    suggestionsSaid = false;
    status.textContent = `Showing eclipses seen from ${c.name}, ${c.country}.`;
    redrawForCity();
  };
  const clear = (): void => {
    touched = true;
    const forgotten = keepCity(undefined);
    if (!host && !forgotten) privacy.textContent = PRIVACY_NOT_KEPT;
    setCityState(undefined);
    window.clearTimeout(statusTimer);
    input.value = '';
    closeDropdown();
    redrawForCity();
    // The person only wanted the city gone: this focus must not download the city list (1.1 MB).
    focusIsOurs = true;
    input.focus();
    focusIsOurs = false;
    suggestionsSaid = false;
    status.textContent = 'Showing every eclipse.';
  };

  input.addEventListener('focus', ensureCatalogue);
  input.addEventListener('pointerdown', ensureCatalogue);
  input.addEventListener('input', () => {
    ensureCatalogue();
    search();
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Tab') {
      closeDropdown();
      return;
    }
    if (dropdown.hidden) return;
    const count = dropdown.children.length;
    if (count === 0) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      highlight(Math.min(highlighted + 1, count - 1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      highlight(Math.max(highlighted - 1, 0));
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const chosen = highlighted >= 0 ? rowsOf.get(dropdown.children[highlighted] as HTMLLIElement) : undefined;
      if (chosen) pick(chosen);
    } else if (ev.key === 'Escape') {
      // Closes the list only; the browser's own Escape would also empty the box (a second Escape does that).
      ev.preventDefault();
      closeDropdown();
    }
  });
  dropdown.addEventListener('click', (ev) => {
    const row = (ev.target as Element).closest('li');
    const chosen = row ? rowsOf.get(row as HTMLLIElement) : undefined;
    if (chosen) pick(chosen);
  });
  document.addEventListener('click', (ev) => {
    if (!(ev.target as Element).closest('.search-wrapper')) closeDropdown();
  });
  $('city-clear-btn').addEventListener('click', clear);
}

// ---- Start ----------------------------------------------------------------------------------

function start(): void {
  initCity();
  fillTypes();
  renderList();
  tick();

  $('filter-kind').addEventListener('change', () => { fillTypes(); renderList(); });
  $('filter-type').addEventListener('change', () => renderList());
  $('eclipse-list').addEventListener('click', (ev) => {
    const button = (ev.target as HTMLElement).closest<HTMLElement>('.btn-alarm');
    const e = button?.dataset.id ? eclipseById(button.dataset.id) : undefined;
    if (button && e) openFor(e, button);
  });
  $('next-alarms').addEventListener('click', () => {
    if (shown) openFor(shown, $('next-alarms'));
  });
  $('add-alarm').addEventListener('click', addRow);
  $('save-ics').addEventListener('click', save);
  $('close-planner').addEventListener('click', closePlanner);
  $('planner').addEventListener('close', () => {
    planning = undefined;
    window.clearTimeout(announceTimer);
    // Back to the button that opened it; if the list was redrawn meanwhile, to the same eclipse's
    // new button, or to the list's heading when that eclipse has passed (code review C-18).
    const id = opener?.dataset.id;
    const target = opener?.isConnected ? opener
      : (id ? $('eclipse-list').querySelector<HTMLElement>(`.btn-alarm[data-id="${id}"]`) : null) ?? $('list-heading');
    target.focus();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkZone(); });
  host?.attach(appPage());
  document.documentElement.dataset.ready = 'true';
  document.documentElement.dataset.eclipses = String(ECLIPSES.length);
}

// ---- Inside the Android app (stage B) -------------------------------------------------------

function findHost(): AppHost | undefined {
  const h = (window as unknown as { EclipseTrackerApp?: unknown }).EclipseTrackerApp;
  if (!h || typeof h !== 'object') return undefined;
  const o = h as Partial<AppHost>;
  return typeof o.rowsFor === 'function' && typeof o.saveFile === 'function' && typeof o.attach === 'function' ? (o as AppHost) : undefined;
}

const host = findHost();

/** Opens the planner: inside the app with the eclipse's stored alarms (spec 9.6), on the website with the default. */
function openFor(e: Eclipse, from: HTMLElement): void {
  if (!host) {
    openPlanner(e, from);
    return;
  }
  host.rowsFor(e.id).then((stored) => openPlanner(e, from, stored), () => openPlanner(e, from));
}

function appPage(): AppPage {
  return {
    core: { eclipseById, eclipseName, alarmWords, localWhen, planAlarm, planRecord, recordsFromRows, rowsFromRecords, isValidRecordSet, greatestMinute, upcoming },
    zone: () => ZONE,
    // Fix B, A-9: Change works while the app keeps the eclipse's records, also after greatest
    // eclipse (an alarm at noon on the day of a lunar eclipse at 00:13 is kept until it rings).
    openFor: (id, opener) => {
      const e = eclipseById(id);
      if (e && greatestMinute(e) + RECORD_GRACE_MS > Date.now()) openFor(e, opener);
    },
    planning: () => planning,
    ringingRows: () => {
      const plan = checkedPlan(Date.now(), true);
      if (!plan) return undefined;
      // With a city that sees the eclipse the alarms count from the minute it starts there, in the
      // city's zone (version 2 records, EclipseTracker 2.1.0); the app checks the start against
      // greatest eclipse again. An eclipse the city cannot see keeps version 1 records (plan Q4).
      const frame = frameOf(plan.eclipse);
      const seenFrom = frame.local ? city : undefined;
      const place = seenFrom ? `${seenFrom.name}, ${seenFrom.country}` : undefined;
      if (place !== undefined && (!isPlace(place) || Math.abs(frame.anchor - greatestMinute(plan.eclipse)) > MAX_START_OFFSET_MS)) {
        say('The ringing alarms could not be set. Try again.');
        return undefined;
      }
      return {
        eclipse: plan.eclipse,
        count: rows.length,
        rows: plan.planned.flatMap((p, index) => {
          const id = rows[index]?.id;
          return p.status === 'ok' ? [{ index, ...(id ? { id } : {}), spec: p.spec }] : [];
        }),
        ...(place !== undefined ? { local: { start: frame.anchor, zone: frame.zone, place } } : {}),
      };
    },
    setRowIds: (ids) => {
      if (ids.length !== rows.length) return;
      rows.forEach((row, i) => {
        const id = ids[i];
        if (id) row.id = id;
        else delete row.id;
      });
    },
    file: () => prepareFile(Date.now()),
    say,
  };
}

start();
