/* EclipseTracker for Android: the bridge between the page and the app (spec section 9, stage B).
 *
 * This file exists ONLY inside the APK. The build copies the web app byte for byte and adds one
 * line to index.html that loads this script before the app module; nothing else in the page is
 * changed. On the website this file is never loaded, and the page behaves exactly as it always has.
 *
 * The page (app.js) looks for window.EclipseTrackerApp, which this script sets, and through it:
 *   - opens the planner with the alarms the app has stored for that eclipse (spec 9.6, 9.8);
 *   - saves the calendar file through Android's save screen instead of a download;
 *   - shows the app's travel note instead of the website's two travel sentences (spec 9.9).
 * Everything the app adds to the page is made here, with the app's own words (every one of them
 * new, awaiting Marcos's approval, listed in the stage B report):
 *   - in the planner, "Set ringing alarms" beside "Save the calendar file" (spec 9.1), and "Add to
 *     calendar", which hands the same file to the calendar app (spec 9.6, B-3);
 *   - "Ringing alarms", the overview of every stored alarm across eclipses, with the time each
 *     rings, a way to change and to delete each, and what the phone refuses with a way to fix it
 *     (spec 9.8);
 *   - Android's Back: it closes the planner when it is open, otherwise the app closes.
 * The planner's closing note says the app keeps the ringing alarms on the phone (the website's
 * "keeps nothing" is not true inside the app).
 *
 * The channel is window.ETBridge, injected by the app through WebViewCompat.addWebMessageListener
 * ONLY into pages from https://appassets.androidplatform.net. It carries JSON text only, and the
 * app checks every message again (BridgeMessage.kt, CalendarHandover.kt, the record checks): the
 * app never takes a fire time, a path or a file name from the page as it is. No fetch, no XHR, no
 * storage: the page's own policy (connect-src 'none') stays intact, and the app keeps the records.
 *
 * THE MESSAGES (JSON text, v: 1; spec 9.6 and the stage B additions marked +):
 *   page to app
 *     { v, type: 'hello' }                                       + once, as this script starts
 *     { v, type: 'alarms.list', id }                             the stored alarms
 *     { v, type: 'alarms.set', id, eclipseId, records }          replaces that eclipse's records
 *     { v, type: 'calendar.add', id, fileName, ics }             the calendar app, or the share sheet
 *     { v, type: 'calendar.save', id, fileName, ics }            + Android's save screen
 *     { v, type: 'problem.fix', problem }                        + the screen that fixes a problem
 *     { v, type: 'back.result', q, handled }                     + the answer to Back q
 *   app to page
 *     { v, type: 'alarms', id?, ok, records, armed: [{ id, fireAt }], problems }
 *     { v, type: 'calendar.result', id?, ok, via: 'calendar' | 'share' | 'save', cancelled? }   +
 *     { v, type: 'back', q }                                     + Android's Back
 *   The optional id (+) is the request an answer is for; an alarms message without one is news
 *   (the app re-planned on its own, after Settings or a change of time zone).
 */
(function () {
  'use strict';

  var bridge = window.ETBridge;
  /* A WebView too old for the message channel (the app says so in a short message): the page
     keeps the website's behaviour. */
  if (!bridge || typeof bridge.postMessage !== 'function') return;

  /* ---------- The app's own words (new in stage B, for Marcos's approval) ---------- */
  var T = {
    SET: 'Set ringing alarms',
    ADD: 'Add to calendar',
    /* Marcos's text, 16 October 2026, exactly as written (spec 9.9, A4). */
    TRAVEL: "Ringing alarms follow your phone's time zone: if you travel, a 12.00 alarm rings at 12.00 where you are. Alarms before greatest eclipse always follow the eclipse.",
    /* Replaces the planner note's last sentence, "EclipseTracker sends nothing and keeps nothing." */
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
    /* Fix B (16 October 2026, A-1 and A-2): the first two say what is true now; for Marcos's approval. */
    PROBLEMS: {
      'notifications-denied': ['Notifications are off or turned down for EclipseTracker, so an alarm still rings but may show nothing on screen. Open EclipseTracker to stop it.', 'Turn on notifications'],
      'exact-alarms-denied': ['Exact alarms are not allowed, so an alarm may ring late or not at all.', 'Allow exact alarms'],
      'full-screen-denied': ['Full-screen alarms are not allowed, so a ringing alarm shows only as a notification.', 'Allow full-screen alarms']
    }
  };
  /* The page's own approved phrases, reused: "Greatest eclipse: {when}." and "Rings {when}." */

  var WEB_KEEPS = 'EclipseTracker sends nothing and keeps nothing.';

  /* ---------- The channel ---------- */

  var nextId = 1;
  var waiting = new Map();
  var TIMEOUT_MS = 8000;

  function post(msg) {
    msg.v = 1;
    bridge.postMessage(JSON.stringify(msg));
  }

  /* Sends one request; resolves with the app's answer, or null when none came in time (wait 0: no limit). */
  function ask(msg, wait) {
    var limit = wait === undefined ? TIMEOUT_MS : wait;
    return new Promise(function (resolve) {
      var id = nextId++;
      msg.id = id;
      var timer = limit ? window.setTimeout(function () { if (waiting.delete(id)) resolve(null); }, limit) : 0;
      waiting.set(id, function (answer) { window.clearTimeout(timer); resolve(answer); });
      try { post(msg); } catch (e) { window.clearTimeout(timer); waiting.delete(id); resolve(null); }
    });
  }

  function randomId() {
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
  }

  /* ---------- The app's state: the latest alarms message ---------- */

  var state = { records: [], armed: new Map(), problems: [] };
  var page = null;
  /* The zone the overview was last drawn in (refresh, below). */
  var lastZone = null;

  function takeAlarms(msg) {
    var records = Array.isArray(msg.records) ? msg.records : [];
    if (page && !page.core.isValidRecordSet(records)) records = [];
    var armed = new Map();
    (Array.isArray(msg.armed) ? msg.armed : []).forEach(function (a) {
      if (a && typeof a.id === 'string' && typeof a.fireAt === 'string') {
        var t = Date.parse(a.fireAt);
        if (!isNaN(t)) armed.set(a.id, t);
      }
    });
    var problems = (Array.isArray(msg.problems) ? msg.problems : []).filter(function (p) { return Object.prototype.hasOwnProperty.call(T.PROBLEMS, p); });
    state = { records: records, armed: armed, problems: problems };
    render();
  }

  function listAlarms() {
    return ask({ type: 'alarms.list' }, 3000).then(function (answer) {
      if (answer && answer.type === 'alarms') takeAlarms(answer);
      return state.records;
    });
  }

  /* ---------- What the page asks of the app (window.EclipseTrackerApp) ---------- */

  window.EclipseTrackerApp = Object.freeze({
    travelNote: T.TRAVEL,
    rowsFor: function (eclipseId) {
      return listAlarms().then(function (records) { return page ? page.core.rowsFromRecords(records, eclipseId) : []; });
    },
    saveFile: function (name, text) {
      return ask({ type: 'calendar.save', fileName: name, ics: text }, 0).then(function (answer) {
        if (answer && answer.ok === true) return true;
        if (!(answer && answer.cancelled === true) && page) page.say(T.SAVE_FAILED);
        return false;
      });
    },
    attach: function (p) {
      page = p;
      /* Fix D (17 October 2026, N-2): the zone the page starts in, so a change of zone in the first
         minute is seen as one at the next look and the armed times are asked for again. */
      lastZone = page.zone();
      setUpPlanner();
      setUpOverview();
      listAlarms();
    }
  });

  /* ---------- The planner: Set ringing alarms, Add to calendar ---------- */

  function button(id, cls, text) {
    var b = document.createElement('button');
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
    var save = document.getElementById('save-ics');
    if (!save || document.getElementById('app-set')) return;
    /* Ringing alarms are the app's first output: Set ringing alarms is the primary button. */
    /* Fix D (17 October 2026, N-4): the app's two planner buttons are 48 px tall too (touchSize, C-4). */
    var set = touchSize(button('app-set', 'btn btn-primary', T.SET));
    var add = touchSize(button('app-calendar', 'btn btn-secondary', T.ADD));
    save.className = save.className.replace('btn-primary', 'btn-secondary');
    save.insertAdjacentElement('beforebegin', set);
    save.insertAdjacentElement('afterend', add);
    set.addEventListener('click', setRinging);
    add.addEventListener('click', addToCalendar);

    var note = document.querySelector('.planner-note');
    if (note && note.textContent.indexOf(WEB_KEEPS) >= 0) note.textContent = note.textContent.replace(WEB_KEEPS, T.KEEPS);
  }

  function setRinging() {
    var plan = page.ringingRows();
    if (!plan) return;
    var records;
    try {
      records = page.core.recordsFromRows(plan.eclipse.id, plan.rows.map(function (r) { return r.id ? { id: r.id, spec: r.spec } : { spec: r.spec }; }), randomId);
    } catch (e) {
      page.say(T.SET_FAILED);
      return;
    }
    /* No time limit: the app answers once the notification dialog it may open has been answered. */
    ask({ type: 'alarms.set', eclipseId: plan.eclipse.id, records: records }, 0).then(function (answer) {
      if (!answer || answer.type !== 'alarms' || answer.ok !== true) {
        if (answer && answer.type === 'alarms') takeAlarms(answer);
        page.say(T.SET_FAILED);
        return;
      }
      takeAlarms(answer);
      var ids = [];
      for (var i = 0; i < plan.count; i++) ids.push(undefined);
      plan.rows.forEach(function (r, k) { ids[r.index] = records[k].id; });
      if (page.planning() && page.planning().id === plan.eclipse.id) page.setRowIds(ids);
      var n = records.length;
      var words = n === 0 ? T.SET_NONE : n === 1 ? T.SET_ONE : T.SET_MANY.replace('{n}', String(n));
      if (n > 0 && state.problems.length) words += ' ' + problemWords(state.problems);
      page.say(words);
    });
  }

  function addToCalendar() {
    var file = page.file();
    if (!file) return;
    ask({ type: 'calendar.add', fileName: file.name, ics: file.text }).then(function (answer) {
      if (!answer || answer.ok !== true) page.say(T.CAL_FAILED);
      else page.say(answer.via === 'share' ? T.CAL_SHARED : T.CAL_OPENED);
    });
  }

  /* ---------- The overview: Ringing alarms (spec 9.8) ---------- */

  var overview = null;

  function setUpOverview() {
    if (document.getElementById('app-alarms')) return;
    var first = document.querySelector('main .card');
    if (!first) return;
    var section = document.createElement('section');
    section.className = 'card list-card';
    section.id = 'app-alarms';
    section.setAttribute('aria-labelledby', 'app-alarms-heading');
    var h = document.createElement('h2');
    h.id = 'app-alarms-heading';
    h.className = 'list-heading';
    h.tabIndex = -1;
    h.textContent = T.HEADING;
    var intro = document.createElement('p');
    intro.className = 'list-intro';
    intro.textContent = T.INTRO;
    var problems = document.createElement('div');
    problems.id = 'app-problems';
    var list = document.createElement('div');
    list.id = 'app-alarms-list';
    list.className = 'eclipse-list';
    var status = document.createElement('p');
    status.id = 'app-alarms-status';
    status.className = 'planner-status';
    /* The overview's own polite region, for its one-line outcomes (an alarm deleted). */
    status.setAttribute('aria-live', 'polite');
    section.append(h, intro, problems, list, status);
    first.insertAdjacentElement('afterend', section);
    overview = { section: section, problems: problems, list: list, status: status };
  }

  /* Fix C (17 October 2026, C-4): the overview's own buttons (Change, Delete and the fix buttons) are
     at least 48 px tall in the app, Android's least touch target; the page's own .btn-alarm, shared
     with the website, stays at 44. Set through the element's style property, which the app's
     policy (style-src 'self') allows, unlike a style attribute in markup. */
  var TOUCH_PX = '48px';
  function touchSize(b) {
    b.style.minHeight = TOUCH_PX;
    b.style.minWidth = TOUCH_PX;
    return b;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  function render() {
    if (!overview || !page) return;
    var core = page.core;
    var zone = page.zone();
    var now = Date.now();
    var focusKey = document.activeElement && overview.section.contains(document.activeElement) ? document.activeElement.dataset.key : null;

    overview.problems.replaceChildren();
    /* Ask late (SunApp's rule): what the phone refuses is shown once there is an alarm it matters for. */
    (state.records.length ? state.problems : []).forEach(function (p) {
      var row = el('div', 'app-problem');
      row.style.margin = '0.75rem 0';
      row.append(el('p', 'alarm-result is-warning', T.PROBLEMS[p][0]));
      var fix = touchSize(button('app-fix-' + p, 'btn btn-secondary btn-alarm', T.PROBLEMS[p][1]));
      fix.dataset.key = 'fix-' + p;
      fix.addEventListener('click', function () { post({ type: 'problem.fix', problem: p }); });
      row.append(fix);
      overview.problems.append(row);
    });

    var groups = new Map();
    state.records.forEach(function (r) {
      var e = core.eclipseById(r.eclipseId);
      if (!e) return;
      var at = state.armed.has(r.id) ? state.armed.get(r.id) : core.planAlarm(e, r.spec, zone, now).fireAt;
      if (!groups.has(e.id)) groups.set(e.id, { e: e, alarms: [] });
      groups.get(e.id).alarms.push({ r: r, at: at });
    });
    var ordered = Array.from(groups.values()).sort(function (a, b) { return core.greatestMinute(a.e) - core.greatestMinute(b.e); });

    overview.list.replaceChildren();
    if (ordered.length === 0) overview.list.append(el('p', 'list-count', T.EMPTY));
    ordered.forEach(function (g) {
      var e = g.e;
      var item = el('div', 'eclipse-item eclipse-' + e.kind);
      item.style.borderTop = 'none';
      var head = el('div', 'eclipse-head');
      head.append(el('span', 'badge badge-' + e.kind, e.kind === 'solar' ? 'Solar' : 'Lunar'));
      head.append(el('h3', 'eclipse-name', core.eclipseName(e)));
      item.append(head);
      item.append(el('p', 'eclipse-when', 'Greatest eclipse: ' + core.localWhen(zone, core.greatestMinute(e)) + '.'));
      var ul = el('ul', 'eclipse-items');
      ul.style.padding = '0';
      g.alarms.sort(function (a, b) { return a.at - b.at; }).forEach(function (a) {
        var li = el('li', 'eclipse-item');
        var what = core.alarmWords(a.r.spec);
        li.append(el('p', 'eclipse-region', what));
        li.append(el('p', 'eclipse-when', 'Rings ' + core.localWhen(zone, a.at) + '.'));
        var actions = el('div', 'planner-actions');
        var change = touchSize(button('', 'btn btn-secondary btn-alarm', T.CHANGE));
        change.removeAttribute('id');
        change.dataset.key = 'change-' + a.r.id;
        change.dataset.id = e.id;
        change.append(el('span', 'sr-only', ' ' + what + ', ' + core.eclipseName(e).toLowerCase()));
        change.addEventListener('click', function () { page.openFor(e.id, change); });
        var del = touchSize(button('', 'btn btn-secondary btn-alarm', T.DELETE));
        del.removeAttribute('id');
        del.dataset.key = 'delete-' + a.r.id;
        del.append(el('span', 'sr-only', ' ' + what + ', ' + core.eclipseName(e).toLowerCase()));
        del.addEventListener('click', function () { deleteRecord(a.r); });
        actions.append(change, del);
        li.append(actions);
        ul.append(li);
      });
      item.append(ul);
      overview.list.append(item);
    });

    if (focusKey) {
      var again = overview.section.querySelector('[data-key="' + focusKey + '"]');
      (again || document.getElementById('app-alarms-heading')).focus();
    }
  }

  function deleteRecord(record) {
    var rest = state.records.filter(function (r) { return r.eclipseId === record.eclipseId && r.id !== record.id; });
    ask({ type: 'alarms.set', eclipseId: record.eclipseId, records: rest }, 0).then(function (answer) {
      if (answer && answer.type === 'alarms') takeAlarms(answer);
      var ok = !!(answer && answer.type === 'alarms' && answer.ok === true);
      overview.status.textContent = '';
      window.setTimeout(function () { overview.status.textContent = ok ? T.DELETED : T.DELETE_FAILED; }, 60);
      if (ok && !overview.section.contains(document.activeElement)) document.getElementById('app-alarms-heading').focus();
    });
  }

  /* Once a minute and when the page comes back into view: the times shown follow the clock and the
     zone; after a change of zone the app has re-planned, so its armed times are asked for again.
     lastZone is set by attach (fix D, N-2: it started as null, so a change of zone before the first
     look went unnoticed and the overview showed the old armed instant in the new zone). */
  function refresh() {
    if (!page) return;
    var zone = page.zone();
    if (lastZone !== null && zone !== lastZone) listAlarms();
    lastZone = zone;
    render();
  }
  window.setInterval(refresh, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) window.setTimeout(refresh, 1200); });

  /* ---------- Back ---------- */

  function onBack(q) {
    var dialog = document.getElementById('planner');
    var handled = false;
    if (dialog && dialog.open) {
      /* As Close, or Escape: the page puts focus back where it was. */
      dialog.close();
      handled = true;
    }
    post({ type: 'back.result', q: q, handled: handled });
  }

  /* ---------- Messages from the app ---------- */

  var isCount = function (n) { return typeof n === 'number' && n > 0 && n <= 0x7fffffff && Math.floor(n) === n; };

  bridge.addEventListener('message', function (ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg || typeof msg !== 'object' || msg.v !== 1) return;
    if (msg.type === 'back') {
      if (isCount(msg.q)) onBack(msg.q);
      return;
    }
    if (isCount(msg.id) && waiting.has(msg.id)) {
      var settle = waiting.get(msg.id);
      waiting.delete(msg.id);
      settle(msg);
      return;
    }
    if (msg.type === 'alarms' && msg.id === undefined) takeAlarms(msg);
  });

  post({ type: 'hello' });
})();
