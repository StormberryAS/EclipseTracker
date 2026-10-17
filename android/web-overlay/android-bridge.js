"use strict";
/*! android-bridge.js is compiled from android-bridge.ts beside it by tools/build-ts.sh, which leaves
    out every comment but this one: the explanations are in the source. Edit the .ts, never the .js:
    the build refuses to overwrite a hand edit, and its check mode fails on one. */
(function () {
    'use strict';
    const bridge = window.ETBridge;
    if (!bridge || typeof bridge.postMessage !== 'function')
        return;
    const channel = bridge;
    const T = {
        SET: 'Set ringing alarms',
        ADD: 'Add to calendar',
        TRAVEL: "Ringing alarms follow your phone's time zone: if you travel, a 12.00 alarm rings at 12.00 where you are. Alarms before greatest eclipse always follow the eclipse.",
        KEEPS: 'EclipseTracker sends nothing; the ringing alarms you set are kept on this phone only.',
        SET_ONE: '1 ringing alarm set.',
        SET_MANY: '{n} ringing alarms set.',
        SET_NONE: 'No ringing alarm is set for this eclipse.',
        SET_FAILED: 'The ringing alarms could not be set. Try again.',
        CAL_OPENED: 'Your calendar app opens with the file.',
        CAL_SHARED: "No calendar app took the file, so Android's share screen opens instead.",
        CAL_FAILED: 'The file could not be handed to another app.',
        SAVE_FAILED: 'The file could not be saved. Try Save again.',
        HEADING: 'Ringing alarms',
        INTRO: 'Every alarm this phone will ring, by eclipse, at the time it rings where the phone is now.',
        EMPTY: 'No ringing alarms yet. Choose Set alarms on any eclipse, then Set ringing alarms.',
        CHANGE: 'Change',
        DELETE: 'Delete',
        DELETED: 'Alarm deleted.',
        DELETE_FAILED: 'The alarm could not be deleted. Try again.',
        PROBLEMS: {
            'notifications-denied': ['Notifications are off or turned down for EclipseTracker, so an alarm still rings but may show nothing on screen. Open EclipseTracker to stop it.', 'Turn on notifications'],
            'exact-alarms-denied': ['Exact alarms are not allowed, so an alarm may ring late or not at all.', 'Allow exact alarms'],
            'full-screen-denied': ['Full-screen alarms are not allowed, so a ringing alarm shows only as a notification.', 'Allow full-screen alarms']
        }
    };
    const WEB_KEEPS = 'EclipseTracker sends nothing and keeps nothing.';
    let nextId = 1;
    const waiting = new Map();
    const TIMEOUT_MS = 8000;
    function post(msg) {
        msg.v = 1;
        channel.postMessage(JSON.stringify(msg));
    }
    function ask(msg, wait) {
        const limit = wait === undefined ? TIMEOUT_MS : wait;
        return new Promise(function (resolve) {
            const id = nextId++;
            msg.id = id;
            const timer = limit ? window.setTimeout(function () { if (waiting.delete(id))
                resolve(null); }, limit) : 0;
            waiting.set(id, function (answer) { window.clearTimeout(timer); resolve(answer); });
            try {
                post(msg);
            }
            catch (e) {
                window.clearTimeout(timer);
                waiting.delete(id);
                resolve(null);
            }
        });
    }
    function randomId() {
        const a = new Uint8Array(16);
        crypto.getRandomValues(a);
        return Array.prototype.map.call(a, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
    }
    let state = { records: [], armed: new Map(), problems: [] };
    let page = null;
    let lastZone = null;
    function isProblem(p) {
        return typeof p === 'string' && Object.prototype.hasOwnProperty.call(T.PROBLEMS, p);
    }
    function takeAlarms(msg) {
        let records = (Array.isArray(msg.records) ? msg.records : []);
        if (page && !page.core.isValidRecordSet(records))
            records = [];
        const armed = new Map();
        (Array.isArray(msg.armed) ? msg.armed : []).forEach(function (a) {
            const x = a;
            if (x && typeof x.id === 'string' && typeof x.fireAt === 'string') {
                const t = Date.parse(x.fireAt);
                if (!isNaN(t))
                    armed.set(x.id, t);
            }
        });
        const problems = (Array.isArray(msg.problems) ? msg.problems : []).filter(isProblem);
        state = { records: records, armed: armed, problems: problems };
        render();
    }
    function listAlarms() {
        return ask({ type: 'alarms.list' }, 3000).then(function (answer) {
            if (answer && answer.type === 'alarms')
                takeAlarms(answer);
            return state.records;
        });
    }
    window.EclipseTrackerApp = Object.freeze({
        travelNote: T.TRAVEL,
        rowsFor: function (eclipseId) {
            return listAlarms().then(function (records) { return page ? page.core.rowsFromRecords(records, eclipseId) : []; });
        },
        saveFile: function (name, text) {
            return ask({ type: 'calendar.save', fileName: name, ics: text }, 0).then(function (answer) {
                if (answer && answer.ok === true)
                    return true;
                if (!(answer && answer.cancelled === true) && page)
                    page.say(T.SAVE_FAILED);
                return false;
            });
        },
        attach: function (p) {
            page = p;
            lastZone = page.zone();
            setUpPlanner();
            setUpOverview();
            listAlarms();
        }
    });
    function button(id, cls, text) {
        const b = document.createElement('button');
        b.type = 'button';
        b.id = id;
        b.className = cls;
        b.textContent = text;
        return b;
    }
    function problemWords(problems) {
        return problems.map(function (p) { return T.PROBLEMS[p][0]; }).join(' ');
    }
    function setUpPlanner() {
        const save = document.getElementById('save-ics');
        if (!save || document.getElementById('app-set'))
            return;
        const set = touchSize(button('app-set', 'btn btn-primary', T.SET));
        const add = touchSize(button('app-calendar', 'btn btn-secondary', T.ADD));
        save.className = save.className.replace('btn-primary', 'btn-secondary');
        save.insertAdjacentElement('beforebegin', set);
        save.insertAdjacentElement('afterend', add);
        set.addEventListener('click', setRinging);
        add.addEventListener('click', addToCalendar);
        const note = document.querySelector('.planner-note');
        if (note && note.textContent !== null && note.textContent.indexOf(WEB_KEEPS) >= 0)
            note.textContent = note.textContent.replace(WEB_KEEPS, T.KEEPS);
    }
    function setRinging() {
        const pg = page;
        if (!pg)
            return;
        const plan = pg.ringingRows();
        if (!plan)
            return;
        let records;
        try {
            records = pg.core.recordsFromRows(plan.eclipse.id, plan.rows.map(function (r) { return r.id ? { id: r.id, spec: r.spec } : { spec: r.spec }; }), randomId);
        }
        catch (e) {
            pg.say(T.SET_FAILED);
            return;
        }
        ask({ type: 'alarms.set', eclipseId: plan.eclipse.id, records: records }, 0).then(function (answer) {
            if (!answer || answer.type !== 'alarms' || answer.ok !== true) {
                if (answer && answer.type === 'alarms')
                    takeAlarms(answer);
                pg.say(T.SET_FAILED);
                return;
            }
            takeAlarms(answer);
            const ids = [];
            for (let i = 0; i < plan.count; i++)
                ids.push(undefined);
            plan.rows.forEach(function (r, k) { ids[r.index] = records[k]?.id; });
            const open = pg.planning();
            if (open && open.id === plan.eclipse.id)
                pg.setRowIds(ids);
            const n = records.length;
            let words = n === 0 ? T.SET_NONE : n === 1 ? T.SET_ONE : T.SET_MANY.replace('{n}', String(n));
            if (n > 0 && state.problems.length)
                words += ' ' + problemWords(state.problems);
            pg.say(words);
        });
    }
    function addToCalendar() {
        const pg = page;
        if (!pg)
            return;
        const file = pg.file();
        if (!file)
            return;
        ask({ type: 'calendar.add', fileName: file.name, ics: file.text }).then(function (answer) {
            if (!answer || answer.ok !== true)
                pg.say(T.CAL_FAILED);
            else
                pg.say(answer.via === 'share' ? T.CAL_SHARED : T.CAL_OPENED);
        });
    }
    let overview = null;
    function setUpOverview() {
        if (document.getElementById('app-alarms'))
            return;
        const first = document.querySelector('main .card');
        if (!first)
            return;
        const section = document.createElement('section');
        section.className = 'card list-card';
        section.id = 'app-alarms';
        section.setAttribute('aria-labelledby', 'app-alarms-heading');
        const h = document.createElement('h2');
        h.id = 'app-alarms-heading';
        h.className = 'list-heading';
        h.tabIndex = -1;
        h.textContent = T.HEADING;
        const intro = document.createElement('p');
        intro.className = 'list-intro';
        intro.textContent = T.INTRO;
        const problems = document.createElement('div');
        problems.id = 'app-problems';
        const list = document.createElement('div');
        list.id = 'app-alarms-list';
        list.className = 'eclipse-list';
        const status = document.createElement('p');
        status.id = 'app-alarms-status';
        status.className = 'planner-status';
        status.setAttribute('aria-live', 'polite');
        section.append(h, intro, problems, list, status);
        first.insertAdjacentElement('afterend', section);
        overview = { section: section, problems: problems, list: list, status: status };
    }
    const TOUCH_PX = '48px';
    function touchSize(b) {
        b.style.minHeight = TOUCH_PX;
        b.style.minWidth = TOUCH_PX;
        return b;
    }
    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls)
            n.className = cls;
        if (text)
            n.textContent = text;
        return n;
    }
    function render() {
        if (!overview || !page)
            return;
        const ov = overview;
        const pg = page;
        const core = pg.core;
        const zone = pg.zone();
        const now = Date.now();
        const active = document.activeElement;
        const focusKey = active instanceof HTMLElement && ov.section.contains(active) ? active.dataset.key : null;
        ov.problems.replaceChildren();
        (state.records.length ? state.problems : []).forEach(function (p) {
            const row = el('div', 'app-problem');
            row.style.margin = '0.75rem 0';
            row.append(el('p', 'alarm-result is-warning', T.PROBLEMS[p][0]));
            const fix = touchSize(button('app-fix-' + p, 'btn btn-secondary btn-alarm', T.PROBLEMS[p][1]));
            fix.dataset.key = 'fix-' + p;
            fix.addEventListener('click', function () { post({ type: 'problem.fix', problem: p }); });
            row.append(fix);
            ov.problems.append(row);
        });
        const groups = new Map();
        state.records.forEach(function (r) {
            const e = core.eclipseById(r.eclipseId);
            if (!e)
                return;
            const armedAt = state.armed.get(r.id);
            const at = armedAt !== undefined ? armedAt : core.planAlarm(e, r.spec, zone, now).fireAt;
            let g = groups.get(e.id);
            if (!g) {
                g = { e: e, alarms: [] };
                groups.set(e.id, g);
            }
            g.alarms.push({ r: r, at: at });
        });
        const ordered = Array.from(groups.values()).sort(function (a, b) { return core.greatestMinute(a.e) - core.greatestMinute(b.e); });
        ov.list.replaceChildren();
        if (ordered.length === 0)
            ov.list.append(el('p', 'list-count', T.EMPTY));
        ordered.forEach(function (g) {
            const e = g.e;
            const item = el('div', 'eclipse-item eclipse-' + e.kind);
            item.style.borderTop = 'none';
            const head = el('div', 'eclipse-head');
            head.append(el('span', 'badge badge-' + e.kind, e.kind === 'solar' ? 'Solar' : 'Lunar'));
            head.append(el('h3', 'eclipse-name', core.eclipseName(e)));
            item.append(head);
            item.append(el('p', 'eclipse-when', 'Greatest eclipse: ' + core.localWhen(zone, core.greatestMinute(e)) + '.'));
            const ul = el('ul', 'eclipse-items');
            ul.style.padding = '0';
            g.alarms.sort(function (a, b) { return a.at - b.at; }).forEach(function (a) {
                const li = el('li', 'eclipse-item');
                const what = core.alarmWords(a.r.spec);
                li.append(el('p', 'eclipse-region', what));
                li.append(el('p', 'eclipse-when', 'Rings ' + core.localWhen(zone, a.at) + '.'));
                const actions = el('div', 'planner-actions');
                const change = touchSize(button('', 'btn btn-secondary btn-alarm', T.CHANGE));
                change.removeAttribute('id');
                change.dataset.key = 'change-' + a.r.id;
                change.dataset.id = e.id;
                change.append(el('span', 'sr-only', ' ' + what + ', ' + core.eclipseName(e).toLowerCase()));
                change.addEventListener('click', function () { pg.openFor(e.id, change); });
                const del = touchSize(button('', 'btn btn-secondary btn-alarm', T.DELETE));
                del.removeAttribute('id');
                del.dataset.key = 'delete-' + a.r.id;
                del.append(el('span', 'sr-only', ' ' + what + ', ' + core.eclipseName(e).toLowerCase()));
                del.addEventListener('click', function () { deleteRecord(a.r); });
                actions.append(change, del);
                li.append(actions);
                ul.append(li);
            });
            item.append(ul);
            ov.list.append(item);
        });
        if (focusKey) {
            const again = ov.section.querySelector('[data-key="' + focusKey + '"]');
            (again || document.getElementById('app-alarms-heading'))?.focus();
        }
    }
    function deleteRecord(record) {
        const ov = overview;
        if (!ov)
            return;
        const rest = state.records.filter(function (r) { return r.eclipseId === record.eclipseId && r.id !== record.id; });
        ask({ type: 'alarms.set', eclipseId: record.eclipseId, records: rest }, 0).then(function (answer) {
            if (answer && answer.type === 'alarms')
                takeAlarms(answer);
            const ok = !!(answer && answer.type === 'alarms' && answer.ok === true);
            ov.status.textContent = '';
            window.setTimeout(function () { ov.status.textContent = ok ? T.DELETED : T.DELETE_FAILED; }, 60);
            if (ok && !ov.section.contains(document.activeElement))
                document.getElementById('app-alarms-heading')?.focus();
        });
    }
    function refresh() {
        if (!page)
            return;
        const zone = page.zone();
        if (lastZone !== null && zone !== lastZone)
            listAlarms();
        lastZone = zone;
        render();
    }
    window.setInterval(refresh, 60000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden)
        window.setTimeout(refresh, 1200); });
    function onBack(q) {
        const dialog = document.getElementById('planner');
        let handled = false;
        if (dialog && dialog.open) {
            dialog.close();
            handled = true;
        }
        post({ type: 'back.result', q: q, handled: handled });
    }
    const isCount = function (n) { return typeof n === 'number' && n > 0 && n <= 0x7fffffff && Math.floor(n) === n; };
    channel.addEventListener('message', function (ev) {
        let msg;
        try {
            msg = JSON.parse(ev.data);
        }
        catch (e) {
            return;
        }
        if (!msg || typeof msg !== 'object' || msg.v !== 1)
            return;
        if (msg.type === 'back') {
            if (isCount(msg.q))
                onBack(msg.q);
            return;
        }
        if (isCount(msg.id)) {
            const settle = waiting.get(msg.id);
            if (settle) {
                waiting.delete(msg.id);
                settle(msg);
                return;
            }
        }
        if (msg.type === 'alarms' && msg.id === undefined)
            takeAlarms(msg);
    });
    post({ type: 'hello' });
})();
