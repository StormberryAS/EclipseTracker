/*! app.js and core/*.js are compiled from ts/ by tools/build-ts.sh, which leaves out every comment
    but this one: the explanations are in the source. Edit ts/, never the .js: the build refuses to
    overwrite a hand edit, and its check mode fails on one. */

// The page: the countdown to the next eclipse, the list of every eclipse to 2100, and the alarm
// planner that saves a calendar file. Everything that can be pure lives in core/ (no DOM there);
// this file only reads the page, writes the page and saves the file.
//
// Privacy (spec section 10): no network request, no cookie, no storage. The planner's choices live
// in this page only and are gone when it closes. The page's own Content-Security-Policy (index.html)
// allows no connection at all.
//
// Inside the Android app (spec section 9, stage B) the page is the same file. The app's bridge
// script (android/web-overlay/android-bridge.js, loaded only by the APK, before this module) sets
// window.EclipseTrackerApp; when it is there, the planner opens with the alarms the app has stored,
// Save goes to Android's save screen, and the travel sentence is the app's. That object carries
// every word of the app's own: nothing here adds a text, and on the website, where it is absent,
// nothing below changes what the page does (see "Inside the Android app" at the end).

import { DEFAULT_SPEC, MAX_ALARMS, RECORD_GRACE_MS, choiceOf, isValidRecordSet, nextNewSpec, planAlarm, planAlarms, recordsFromRows, ringing, rowsFromRecords, specForChoice } from './core/alarms.js';
import { ECLIPSES, eclipseById, groupByYear, matches, nextEclipse, typesFor, upcoming } from './core/eclipses.js';
import type { Filter } from './core/eclipses.js';
import { BEFORE_CHOICES, DAY_CHOICES, alarmWords, countdownParts, countdownWords, dateWords, eclipseName, greatestMinute, icsFileName, localWhen, longDate, magnitudeWords, offsetWords, shortDate } from './core/format.js';
import { buildIcs } from './core/ics.js';
import type { AlarmSpec, Eclipse, EclipseKind, EclipseType, MinutesBefore, PlannedAlarm, PlannerRow } from './core/types.js';
import { deviceZone, isWallTime, localDateTime, offsetMinutes } from './core/zoned.js';

/**
 * The device's time zone. Read again once a minute and when the page comes back into view, so a
 * person who travels with the page open sees their new zone (code review C-22).
 */
let ZONE = deviceZone();

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

/** "Sat 6 Feb 2027, 16:59 (UTC+1)": an eclipse's greatest eclipse in the device's zone, short. */
function shortWhen(e: Eclipse): string {
  const t = greatestMinute(e);
  const { date, time } = localDateTime(ZONE, t);
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
  if (!e) {
    // After the last eclipse in the list (2100): nothing to show but that (code review C-19).
    setText($('eclipse-type'), 'No more eclipses in the list');
    showDigits([0, 0, 0, 0]);
    setText($('countdown-words'), 'No more eclipses in the list.');
    button.disabled = true;
    delete button.dataset.id;
    return;
  }
  setText($('eclipse-type'), eclipseName(e));
  setText($('eclipse-date'), localWhen(ZONE, greatestMinute(e)));
  setText($('eclipse-region'), e.region);
  setText($('eclipse-path'), e.path);
  $('eclipse-path-row').hidden = !e.path;
  setText($('eclipse-type-detail'), eclipseName(e));
  const mag = magnitudeWords(e);
  setText($('eclipse-magnitude-label'), mag.label);
  setText($('eclipse-magnitude'), mag.value);
  button.disabled = false;
  button.dataset.id = e.id;
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

/**
 * Once a second, on the second: the digits; once a minute: the words a screen reader reads, the
 * zone check and the planner's results (an alarm can pass while it is open). The countdown runs to
 * greatest eclipse rounded to the minute, the time shown beside it (code review C-20).
 */
function tick(): void {
  const now = Date.now();
  if (!shown || greatestMinute(shown) <= now) {
    const passed = shown !== undefined;
    showNext(nextEclipse(now));
    if (passed) renderList(true);
  }
  const minute = Math.floor(now / 60_000);
  if (minute !== wordsMinute) {
    wordsMinute = minute;
    checkZone();
    if (planning) updateResults();
  }
  if (shown) {
    const left = greatestMinute(shown) - now;
    const p = countdownParts(left);
    showDigits([p.days, p.hours, p.minutes, p.seconds]);
    // The words count whole minutes; they change once a minute, and the timer is not a live region.
    setText($('countdown-words'), `Greatest eclipse in ${countdownWords(left)}.`);
  }
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
  when.append(el('time', { datetime: new Date(greatestMinute(e)).toISOString().replace(/:00\.000Z$/, 'Z') }, `${shortWhen(e)} (${offsetWords(offsetMinutes(ZONE, greatestMinute(e)))})`));
  li.append(when);
  li.append(el('p', { class: 'eclipse-region' }, `Visible from ${e.region}.`));
  if (e.path) li.append(el('p', { class: 'eclipse-path' }, `Central path: ${e.path}.`));
  const mag = magnitudeWords(e);
  li.append(el('p', { class: 'eclipse-mag' }, `${mag.label} ${mag.value}`));
  const button = el('button', { type: 'button', class: 'btn btn-alarm', 'data-id': e.id }, 'Set alarms');
  button.append(el('span', { class: 'sr-only' }, ` for the ${eclipseName(e).toLowerCase()} of ${dateWords(localDateTime(ZONE, greatestMinute(e)).date)}`));
  li.append(button);
  return li;
}

/** "{n} eclipses in {y} years.", in the singular where it is one (code review C-19). */
function countWords(n: number, years: number): string {
  return `${n} ${n === 1 ? 'eclipse' : 'eclipses'} in ${years} ${years === 1 ? 'year' : 'years'}.`;
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
  const all = upcoming(Date.now());
  const list = all.filter((e) => matches(e, filter));
  const groups = groupByYear(list, (e) => Number(localDateTime(ZONE, greatestMinute(e)).date.slice(0, 4)));
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
  if (all.length === 0) text = 'There are no more eclipses in the list.';
  else if (list.length === 0) text = 'No eclipse of this kind and type is left in the list.';
  else if (list.length === all.length) text = countWords(all.length, groups.length);
  else text = `Showing ${list.length} of ${all.length} ${all.length === 1 ? 'eclipse' : 'eclipses'}, in ${groups.length} ${groups.length === 1 ? 'year' : 'years'}.`;
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
  const t = greatestMinute(e);
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
  const initial = start.length > 0 ? start.slice(0, MAX_ALARMS) : [{ spec: DEFAULT_SPEC }];
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
  words += p.afterGreatest ? ', after greatest eclipse. Some calendars leave out an alarm set for after the eclipse begins.' : '.';
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
  const planned = planAlarms(planning, complete, ZONE, now);
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
    for (const c of DAY_CHOICES) choice.append(el('option', { value: c.value }, c.label));
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
  const g = greatestMinute(planning);
  if (g <= now && !(kept && now < g + RECORD_GRACE_MS)) {
    say('This eclipse has passed, so there is nothing to save.');
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
  const text = buildIcs({ eclipse: plan.eclipse, alarms: plan.planned, uid: randomHex(16), dtstamp: now });
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

// ---- Start ----------------------------------------------------------------------------------

function start(): void {
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

/**
 * What the Android app's bridge script offers the page (spec 9.1, B-4). Absent on the website.
 *   travelNote  the app's travel note, which replaces the website's two travel sentences (9.9)
 *   rowsFor     the stored alarms of one eclipse as planner rows (9.6, 9.8): the planner opens
 *               with them instead of the default
 *   saveFile    Save through Android's save screen; resolves true once the file is written
 *   attach      called once at start with what the page lets the app do (AppPage)
 */
interface AppHost {
  readonly travelNote?: string;
  rowsFor(eclipseId: string): Promise<readonly PlannerRow[]>;
  saveFile(name: string, text: string): Promise<boolean>;
  attach(page: AppPage): void;
}

/** What the page lets the app's bridge script do. No words: the script has its own. */
interface AppPage {
  /** The pure modules the app's parts work with (spec 9.2). */
  readonly core: {
    eclipseById: typeof eclipseById; eclipseName: typeof eclipseName; alarmWords: typeof alarmWords; localWhen: typeof localWhen;
    planAlarm: typeof planAlarm; recordsFromRows: typeof recordsFromRows; rowsFromRecords: typeof rowsFromRecords;
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
   */
  ringingRows(): { eclipse: Eclipse; count: number; rows: Array<{ index: number; id?: string; spec: AlarmSpec }> } | undefined;
  /** Gives rows their record ids once stored; a row not stored loses any id it had. */
  setRowIds(ids: ReadonlyArray<string | undefined>): void;
  /** The calendar file Save would make, or undefined (and the reason said). */
  file(): { name: string; text: string; alarms: number } | undefined;
  /** A status line in the planner, said through its one live region. */
  say(text: string): void;
}

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
    core: { eclipseById, eclipseName, alarmWords, localWhen, planAlarm, recordsFromRows, rowsFromRecords, isValidRecordSet, greatestMinute, upcoming },
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
      return {
        eclipse: plan.eclipse,
        count: rows.length,
        rows: plan.planned.flatMap((p, index) => {
          const id = rows[index]?.id;
          return p.status === 'ok' ? [{ index, ...(id ? { id } : {}), spec: p.spec }] : [];
        }),
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
