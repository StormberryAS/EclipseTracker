/*! app.js and core/*.js are compiled from ts/ by tools/build-ts.sh, which leaves out every comment
    but this one: the explanations are in the source. Edit ts/, never the .js: the build refuses to
    overwrite a hand edit, and its check mode fails on one. */
import { DEFAULT_SPEC, MAX_ALARMS, RECORD_GRACE_MS, choiceOf, isValidRecordSet, nextNewSpec, planAlarm, planAlarms, recordsFromRows, ringing, rowsFromRecords, specForChoice } from './core/alarms.js?v=4a8fb0af';
import { ECLIPSES, eclipseById, groupByYear, matches, nextEclipse, typesFor, upcoming } from './core/eclipses.js?v=d0629f00';
import { BEFORE_CHOICES, DAY_CHOICES, alarmWords, countdownParts, countdownWords, dateWords, eclipseName, greatestMinute, icsFileName, localWhen, longDate, magnitudeWords, offsetWords, shortDate } from './core/format.js?v=be22d0d5';
import { buildIcs } from './core/ics.js?v=e0c1da29';
import { deviceZone, isWallTime, localDateTime, offsetMinutes } from './core/zoned.js?v=d3e47120';
let ZONE = deviceZone();
function $(id) {
    const el = document.getElementById(id);
    if (!el)
        throw new Error(`missing #${id}`);
    return el;
}
function el(tag, props = {}, text = '') {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined)
            continue;
        if (k === 'class')
            node.className = v;
        else
            node.setAttribute(k, v);
    }
    if (text)
        node.textContent = text;
    return node;
}
function setText(node, text) {
    if (node.textContent === text)
        return false;
    node.textContent = text;
    return true;
}
function shortWhen(e) {
    const t = greatestMinute(e);
    const { date, time } = localDateTime(ZONE, t);
    return `${shortDate(date)}, ${time}`;
}
let shown;
let wordsMinute = Number.NaN;
const DIGITS = ['cd-days', 'cd-hours', 'cd-minutes', 'cd-seconds'];
function showDigits(values) {
    DIGITS.forEach((id, i) => setText($(id), String(values[i] ?? 0).padStart(2, '0')));
}
function showNext(e) {
    shown = e;
    const button = $('next-alarms');
    $('event-details').hidden = !e;
    if (!e) {
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
function checkZone() {
    const zone = deviceZone();
    if (zone === ZONE)
        return;
    ZONE = zone;
    showNext(shown);
    renderList(true);
    if (planning) {
        plannerHeader(planning);
        updateResults();
    }
}
function tick() {
    const now = Date.now();
    if (!shown || greatestMinute(shown) <= now) {
        const passed = shown !== undefined;
        showNext(nextEclipse(now));
        if (passed)
            renderList(true);
    }
    const minute = Math.floor(now / 60000);
    if (minute !== wordsMinute) {
        wordsMinute = minute;
        checkZone();
        if (planning)
            updateResults();
    }
    if (shown) {
        const left = greatestMinute(shown) - now;
        const p = countdownParts(left);
        showDigits([p.days, p.hours, p.minutes, p.seconds]);
        setText($('countdown-words'), `Greatest eclipse in ${countdownWords(left)}.`);
    }
    window.setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
}
const TYPE_LABELS = {
    total: 'Total', annular: 'Annular', hybrid: 'Hybrid', partial: 'Partial', penumbral: 'Penumbral',
};
function currentFilter() {
    const kind = $('filter-kind').value;
    const type = $('filter-type').value;
    return { kind, type };
}
function fillTypes() {
    const select = $('filter-type');
    const kind = $('filter-kind').value;
    const keep = select.value;
    select.replaceChildren(el('option', { value: 'all' }, 'Any type'));
    for (const t of typesFor(kind))
        select.append(el('option', { value: t }, TYPE_LABELS[t]));
    select.value = typesFor(kind).includes(keep) ? keep : 'all';
}
function itemFor(e) {
    const li = el('li', { class: `eclipse-item eclipse-${e.kind}`, 'data-id': e.id });
    const head = el('div', { class: 'eclipse-head' });
    head.append(el('span', { class: `badge badge-${e.kind}` }, e.kind === 'solar' ? 'Solar' : 'Lunar'));
    head.append(el('h4', { class: 'eclipse-name' }, eclipseName(e)));
    li.append(head);
    const when = el('p', { class: 'eclipse-when' });
    when.append(el('time', { datetime: new Date(greatestMinute(e)).toISOString().replace(/:00\.000Z$/, 'Z') }, `${shortWhen(e)} (${offsetWords(offsetMinutes(ZONE, greatestMinute(e)))})`));
    li.append(when);
    li.append(el('p', { class: 'eclipse-region' }, `Visible from ${e.region}.`));
    if (e.path)
        li.append(el('p', { class: 'eclipse-path' }, `Central path: ${e.path}.`));
    const mag = magnitudeWords(e);
    li.append(el('p', { class: 'eclipse-mag' }, `${mag.label} ${mag.value}`));
    const button = el('button', { type: 'button', class: 'btn btn-alarm', 'data-id': e.id }, 'Set alarms');
    button.append(el('span', { class: 'sr-only' }, ` for the ${eclipseName(e).toLowerCase()} of ${dateWords(localDateTime(ZONE, greatestMinute(e)).date)}`));
    li.append(button);
    return li;
}
function countWords(n, years) {
    return `${n} ${n === 1 ? 'eclipse' : 'eclipses'} in ${years} ${years === 1 ? 'year' : 'years'}.`;
}
function renderList(keep = false) {
    const host = $('eclipse-list');
    const openYears = new Set();
    let focusId;
    let focusYear;
    if (keep) {
        host.querySelectorAll('details.year-group[open]').forEach((d) => { if (d.dataset.year)
            openYears.add(d.dataset.year); });
        const active = document.activeElement;
        if (active instanceof HTMLElement && host.contains(active)) {
            focusId = active.closest('.btn-alarm')?.dataset.id;
            focusYear = active.closest('.year-group')?.dataset.year;
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
            if (details.dataset.filled)
                return;
            details.dataset.filled = 'true';
            const ul = el('ul', { class: 'eclipse-items' });
            for (const e of g.eclipses)
                ul.append(itemFor(e));
            details.append(ul);
        };
        details.addEventListener('toggle', () => { if (details.open)
            fill(); });
        if (i === 0 || openYears.has(String(g.year))) {
            details.open = true;
            fill();
        }
        frag.append(details);
    });
    host.replaceChildren(frag);
    let text;
    if (all.length === 0)
        text = 'There are no more eclipses in the list.';
    else if (list.length === 0)
        text = 'No eclipse of this kind and type is left in the list.';
    else if (list.length === all.length)
        text = countWords(all.length, groups.length);
    else
        text = `Showing ${list.length} of ${all.length} ${all.length === 1 ? 'eclipse' : 'eclipses'}, in ${groups.length} ${groups.length === 1 ? 'year' : 'years'}.`;
    setText($('list-count'), text);
    if (focusId !== undefined || focusYear !== undefined) {
        const button = focusId ? host.querySelector(`.btn-alarm[data-id="${focusId}"]`) : null;
        const year = focusYear ? host.querySelector(`.year-group[data-year="${focusYear}"] > summary`) : null;
        (button ?? year ?? $('list-heading')).focus();
    }
}
let planning;
let rows = [];
let opener = null;
let lastTime = DEFAULT_SPEC.kind === 'day' ? DEFAULT_SPEC.time : '12:00';
let lastMinutes = 30;
let announceTimer = 0;
function announce(text) {
    const live = $('planner-live');
    live.textContent = '';
    window.clearTimeout(announceTimer);
    announceTimer = window.setTimeout(() => { live.textContent = text; }, 60);
}
function say(text) {
    $('planner-status').textContent = text;
    announce(text);
}
function plannerHeader(e) {
    setText($('planner-title'), `Alarms for the ${eclipseName(e).toLowerCase()}`);
    const t = greatestMinute(e);
    setText($('planner-when'), `Greatest eclipse: ${localWhen(ZONE, t)}, which is ${localDateTime('UTC', t).time} UTC.`);
    const travel = host?.travelNote ?? 'If you travel, those alarms still ring at the same moment, which may be a different hour where you are. Alarms before greatest eclipse always follow the eclipse.';
    setText($('planner-zone'), `Times of day are for this device's time zone, ${ZONE}. ${travel}`);
}
function openPlanner(e, from, start = []) {
    planning = e;
    opener = from;
    const initial = start.length > 0 ? start.slice(0, MAX_ALARMS) : [{ spec: DEFAULT_SPEC }];
    rows = initial.map((r) => ({ ...(r.id ? { id: r.id } : {}), spec: r.spec, timeText: r.spec.kind === 'day' ? r.spec.time : lastTime }));
    plannerHeader(e);
    $('planner-status').textContent = '';
    $('planner-live').textContent = '';
    renderRows();
    const dialog = $('planner');
    dialog.showModal();
    dialog.querySelector('.alarm-choice')?.focus();
}
function closePlanner() {
    $('planner').close();
}
function rowSpecs() {
    return rows.map((r) => (r.spec.kind === 'day' && !isWallTime(r.timeText) ? null : r.spec));
}
function resultWords(p, planned) {
    if (p.status === 'past')
        return 'This time has already passed, so this alarm is left out of the file.';
    if (p.status === 'duplicate') {
        const first = planned.findIndex((q) => q !== null && q.status === 'ok' && q.fireAt === p.fireAt);
        return `This rings at the same moment as alarm ${first + 1}, so it is left out of the file.`;
    }
    let words = `Rings ${longDate(p.localDate)} at ${p.localTime} (${offsetWords(p.offsetMinutes)})`;
    words += p.afterGreatest ? ', after greatest eclipse. Some calendars leave out an alarm set for after the eclipse begins.' : '.';
    const spec = p.spec;
    if (spec.kind === 'day' && p.dst === 'gap')
        words += ` The clocks go forward that night and ${spec.time} does not exist, so it rings at ${p.localTime}.`;
    if (spec.kind === 'day' && p.dst === 'overlap')
        words += ` The clocks go back that night and ${spec.time} happens twice; it rings the first time.`;
    return words;
}
function planRows(now) {
    if (!planning)
        return [];
    const specs = rowSpecs();
    const complete = specs.filter((s) => s !== null);
    const planned = planAlarms(planning, complete, ZONE, now);
    let k = 0;
    return specs.map((s) => (s === null ? null : planned[k++] ?? null));
}
function updateResults(edited = -1) {
    const planned = planRows(Date.now());
    const items = $('alarm-rows').querySelectorAll('.alarm-result');
    items.forEach((node, i) => {
        const p = planned[i] ?? null;
        const text = p ? resultWords(p, planned) : 'Choose a time for this alarm.';
        if (setText(node, text) && i === edited)
            announce(text);
        node.classList.toggle('is-warning', !p || p.status !== 'ok' || p.afterGreatest || p.dst !== 'none');
    });
    const inFile = ringing(planned.filter((p) => p !== null)).length;
    const three = $('planner-three');
    three.hidden = inFile <= 3;
    const save = $('save-ics');
    if (three.hidden)
        save.removeAttribute('aria-describedby');
    else
        save.setAttribute('aria-describedby', 'planner-three');
    $('add-alarm').disabled = rows.length >= MAX_ALARMS;
}
function renderRows(focusIndex = -1) {
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
        for (const c of DAY_CHOICES)
            choice.append(el('option', { value: c.value }, c.label));
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
        for (const c of BEFORE_CHOICES)
            minutes.append(el('option', { value: String(c.value) }, c.label));
        minutes.value = String(row.spec.kind === 'before' ? row.spec.minutes : lastMinutes);
        minutesLabel.append(minutes);
        fs.append(minutesLabel);
        const showFields = () => {
            timeLabel.hidden = row.spec.kind !== 'day';
            minutesLabel.hidden = row.spec.kind !== 'before';
        };
        const markTime = () => {
            if (row.spec.kind === 'day' && !isWallTime(row.timeText))
                time.setAttribute('aria-invalid', 'true');
            else
                time.removeAttribute('aria-invalid');
        };
        showFields();
        markTime();
        choice.addEventListener('change', () => {
            row.spec = specForChoice(choice.value, row.spec, lastTime, lastMinutes);
            if (row.spec.kind === 'day') {
                if (!isWallTime(row.timeText)) {
                    row.timeText = row.spec.time;
                    time.value = row.timeText;
                }
                else {
                    row.spec = { ...row.spec, time: row.timeText };
                }
            }
            else {
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
            const m = Number(minutes.value);
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
    if (focusIndex >= 0)
        host.querySelectorAll('.alarm-choice')[focusIndex]?.focus();
}
function addRow() {
    if (rows.length >= MAX_ALARMS)
        return;
    const spec = nextNewSpec(rows.map((r) => r.spec), lastTime);
    rows.push({ spec, timeText: spec.kind === 'day' ? spec.time : lastTime });
    renderRows(rows.length - 1);
    say(rows.length >= MAX_ALARMS
        ? `Alarm ${rows.length} added. ${MAX_ALARMS} alarms is the most for one eclipse.`
        : `Alarm ${rows.length} added.`);
}
function randomHex(bytes) {
    const a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
function checkedPlan(now, kept = false) {
    if (!planning)
        return undefined;
    const g = greatestMinute(planning);
    if (g <= now && !(kept && now < g + RECORD_GRACE_MS)) {
        say('This eclipse has passed, so there is nothing to save.');
        return undefined;
    }
    const planned = planRows(now);
    const missing = planned.findIndex((p) => p === null);
    if (missing >= 0) {
        say(`Alarm ${missing + 1} needs a time.`);
        ($('alarm-rows').querySelectorAll('.alarm-time')[missing])?.focus();
        return undefined;
    }
    return { eclipse: planning, planned: planned.filter((p) => p !== null) };
}
function prepareFile(now) {
    const plan = checkedPlan(now);
    if (!plan)
        return undefined;
    const text = buildIcs({ eclipse: plan.eclipse, alarms: plan.planned, uid: randomHex(16), dtstamp: now });
    return { name: icsFileName(plan.eclipse), text, alarms: ringing(plan.planned).length };
}
function savedWords(name, n) {
    return `Saved ${name} with ${n === 0 ? 'no alarms' : n === 1 ? '1 alarm' : `${n} alarms`}. Open it with your calendar app.`;
}
function save() {
    const file = prepareFile(Date.now());
    if (!file)
        return;
    if (host) {
        void host.saveFile(file.name, file.text).then((ok) => { if (ok)
            say(savedWords(file.name, file.alarms)); }, () => undefined);
        updateResults();
        return;
    }
    const url = URL.createObjectURL(new Blob([file.text], { type: 'text/calendar;charset=utf-8' }));
    const a = el('a', { href: url, download: file.name });
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    say(savedWords(file.name, file.alarms));
    updateResults();
}
function start() {
    fillTypes();
    renderList();
    tick();
    $('filter-kind').addEventListener('change', () => { fillTypes(); renderList(); });
    $('filter-type').addEventListener('change', () => renderList());
    $('eclipse-list').addEventListener('click', (ev) => {
        const button = ev.target.closest('.btn-alarm');
        const e = button?.dataset.id ? eclipseById(button.dataset.id) : undefined;
        if (button && e)
            openFor(e, button);
    });
    $('next-alarms').addEventListener('click', () => {
        if (shown)
            openFor(shown, $('next-alarms'));
    });
    $('add-alarm').addEventListener('click', addRow);
    $('save-ics').addEventListener('click', save);
    $('close-planner').addEventListener('click', closePlanner);
    $('planner').addEventListener('close', () => {
        planning = undefined;
        window.clearTimeout(announceTimer);
        const id = opener?.dataset.id;
        const target = opener?.isConnected ? opener
            : (id ? $('eclipse-list').querySelector(`.btn-alarm[data-id="${id}"]`) : null) ?? $('list-heading');
        target.focus();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden)
        checkZone(); });
    host?.attach(appPage());
    document.documentElement.dataset.ready = 'true';
    document.documentElement.dataset.eclipses = String(ECLIPSES.length);
}
function findHost() {
    const h = window.EclipseTrackerApp;
    if (!h || typeof h !== 'object')
        return undefined;
    const o = h;
    return typeof o.rowsFor === 'function' && typeof o.saveFile === 'function' && typeof o.attach === 'function' ? o : undefined;
}
const host = findHost();
function openFor(e, from) {
    if (!host) {
        openPlanner(e, from);
        return;
    }
    host.rowsFor(e.id).then((stored) => openPlanner(e, from, stored), () => openPlanner(e, from));
}
function appPage() {
    return {
        core: { eclipseById, eclipseName, alarmWords, localWhen, planAlarm, recordsFromRows, rowsFromRecords, isValidRecordSet, greatestMinute, upcoming },
        zone: () => ZONE,
        openFor: (id, opener) => {
            const e = eclipseById(id);
            if (e && greatestMinute(e) + RECORD_GRACE_MS > Date.now())
                openFor(e, opener);
        },
        planning: () => planning,
        ringingRows: () => {
            const plan = checkedPlan(Date.now(), true);
            if (!plan)
                return undefined;
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
            if (ids.length !== rows.length)
                return;
            rows.forEach((row, i) => {
                const id = ids[i];
                if (id)
                    row.id = id;
                else
                    delete row.id;
            });
        },
        file: () => prepareFile(Date.now()),
        say,
    };
}
start();
