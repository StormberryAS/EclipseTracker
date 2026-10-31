/*! android-bridge.js is compiled from android-bridge.ts beside it by tools/build-ts.sh, which leaves
    out every comment but this one: the explanations are in the source. Edit the .ts, never the .js:
    the build refuses to overwrite a hand edit, and its check mode fails on one. */

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
 * THE GOOGLE PLAY EDITION (29 October 2026) has no ringing alarms. The build tells this script so
 * through the one line it injects: <script src="android-bridge.js" data-edition="play"> (the
 * sovereign line has no data-edition; WebAssets.injectedTag in android/app/build.gradle.kts). In
 * the Play edition the script adds "Add to calendar" after "Save the calendar file" (which stays the
 * primary button) and Android's Back, and nothing else: no "Set ringing alarms", no "Ringing alarms"
 * overview, no problems, no app travel note (the website's two travel sentences stay, true of a
 * calendar file), and its own closing sentence (PLAY_KEEPS: Add to calendar leaves the last file
 * handed over in cache/calendar/ until the app next starts afresh, MainActivity.onCreate, so the
 * website's "keeps nothing" is not true here either), and it never asks the app for alarms, so the
 * app never asks for the notification permission. The app answers any alarm message with ok:false all the same
 * (AlarmFreeBridge.kt).
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
/* TypeScript since 17 October 2026 (it was hand-written JavaScript until then). It stays a classic
 * script, not a module: the app injects it with a plain <script> tag before the app module, so it
 * has no import or export, and the types it shares with the page come in as import() types, which
 * leave nothing behind. The contract with the page (AppHost, AppPage) is ts/app-host.d.ts, which
 * ts/app.ts uses too, so both sides are checked against one definition. Compiled on its own with
 * android/web-overlay/tsconfig.json (strict, ES2020, the DOM); tools/build-ts.sh writes
 * android-bridge.js beside this file, which the Android build bundles. The code is the
 * hand-written script's, statement for statement, with types added.
 */

type AppHost = import('../../ts/app-host.js').AppHost;
type AppPage = import('../../ts/app-host.js').AppPage;
type AlarmRecord = import('../../ts/core/types.js').AlarmRecord;
type AlarmSpec = import('../../ts/core/types.js').AlarmSpec;
type Eclipse = import('../../ts/core/types.js').Eclipse;
type PlannerRow = import('../../ts/core/types.js').PlannerRow;

/** The channel the app injects (WebViewCompat.addWebMessageListener): JSON text both ways. */
interface WebMessagePort {
  postMessage(message: string): void;
  addEventListener(type: 'message', listener: (event: { readonly data: string }) => void): void;
}

interface Window {
  readonly ETBridge?: WebMessagePort;
  EclipseTrackerApp?: AppHost;
}

/** A message from the app, as parsed: every field is checked before it is used. */
interface Incoming {
  readonly v?: unknown;
  readonly type?: unknown;
  readonly id?: unknown;
  readonly q?: unknown;
  readonly ok?: unknown;
  readonly via?: unknown;
  readonly cancelled?: unknown;
  readonly records?: unknown;
  readonly armed?: unknown;
  readonly problems?: unknown;
}

/** A message to the app; post() adds v, ask() adds id. */
interface Outgoing {
  type: string;
  v?: 1;
  id?: number;
  [field: string]: unknown;
}

/* WEBSITE-ONLY PARTS (30 October 2026). Every element the page marks data-web-only (the section
   with the "Get the Android app on Zapstore" and "on Google Play" buttons) is hidden inside the
   app, in both editions, and also on a WebView too old for the message channel, so this runs
   before the channel is looked for. The same mechanism as MetadataScrubber's and CheckLink's
   bridge scripts. The app injects this script before the page's first script, at the end of the
   body, while the document is still loading, so it waits for the end of parsing: readyState
   leaves 'loading' before the app.js module runs, whereas DOMContentLoaded fires only after it.
   A MutationObserver hides any data-web-only element the page adds later, and puts back the
   hidden attribute if anything takes it off; its callback runs before the browser paints, so such
   a part is never shown, not even briefly. The page's [hidden] rule (style.css) wins over every
   display rule. */
(function () {
  'use strict';

  function hideWebOnly(root: Node): void {
    if (!(root instanceof Element) && !(root instanceof Document)) return;
    if (root instanceof HTMLElement && root.hasAttribute('data-web-only')) root.hidden = true;
    root.querySelectorAll<HTMLElement>('[data-web-only]').forEach(function (el) { el.hidden = true; });
  }

  function watchWebOnly(): void {
    hideWebOnly(document);
    if (typeof MutationObserver !== 'function') return;
    new MutationObserver(function (records) {
      records.forEach(function (rec) {
        if (rec.type === 'attributes') {
          /* Something took the hidden attribute off a website-only part: put it back. */
          const t = rec.target;
          if (t instanceof HTMLElement && t.hasAttribute('data-web-only') && !t.hidden) t.hidden = true;
          return;
        }
        rec.addedNodes.forEach(hideWebOnly);
      });
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'data-web-only'] });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('readystatechange', function onState() {
      if (document.readyState === 'loading') return;
      document.removeEventListener('readystatechange', onState);
      watchWebOnly();
    });
  } else {
    watchWebOnly();
  }
})();

(function () {
  'use strict';

  const bridge = window.ETBridge;
  /* A WebView too old for the message channel (the app says so in a short message): the page
     keeps the website's behaviour. */
  if (!bridge || typeof bridge.postMessage !== 'function') return;
  /* The channel, known to be there from here on (also inside the functions below). */
  const channel: WebMessagePort = bridge;

  /* The edition, from the tag that loaded this script (read while it runs, the one moment
     document.currentScript is this script): true in the Google Play edition, which has no ringing
     alarms. */
  const loader = document.currentScript;
  const PLAY = loader instanceof HTMLScriptElement && loader.dataset['edition'] === 'play';

  /* ---------- The app's own words (new in stage B, for Marcos's approval) ---------- */
  const T = {
    SET: 'Set ringing alarms',
    ADD: 'Add to calendar',
    /* Marcos's text, 16 October 2026, exactly as written (spec 9.9, A4). */
    TRAVEL: "Ringing alarms follow your phone's time zone: if you travel, a 12.00 alarm rings at 12.00 where you are. Alarms before greatest eclipse always follow the eclipse.",
    /* Replaces the planner note's last sentence, "EclipseTracker sends nothing and keeps nothing." */
    KEEPS: 'EclipseTracker sends nothing; the ringing alarms you set are kept on this phone only.',
    /* The same sentence in the Google Play edition, which keeps no alarm but does keep the last file
       handed to the calendar app until the app next starts afresh (29 October 2026, DRAFT). */
    PLAY_KEEPS: 'EclipseTracker sends nothing; it keeps only the last file you added to your calendar, until the app next starts afresh.',
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
  } as const;
  /* The page's own approved phrases, reused: "Greatest eclipse: {when}." and "Rings {when}." */

  /** A problem the app may report: what the phone refuses, each with its words and its fix button. */
  type Problem = keyof typeof T.PROBLEMS;

  const WEB_KEEPS = 'EclipseTracker sends nothing and keeps nothing.';

  /* ---------- The channel ---------- */

  let nextId = 1;
  const waiting = new Map<number, (answer: Incoming) => void>();
  const TIMEOUT_MS = 8000;

  function post(msg: Outgoing): void {
    msg.v = 1;
    channel.postMessage(JSON.stringify(msg));
  }

  /* Sends one request; resolves with the app's answer, or null when none came in time (wait 0: no limit). */
  function ask(msg: Outgoing, wait?: number): Promise<Incoming | null> {
    const limit = wait === undefined ? TIMEOUT_MS : wait;
    return new Promise(function (resolve) {
      const id = nextId++;
      msg.id = id;
      const timer = limit ? window.setTimeout(function () { if (waiting.delete(id)) resolve(null); }, limit) : 0;
      waiting.set(id, function (answer) { window.clearTimeout(timer); resolve(answer); });
      try { post(msg); } catch (e) { window.clearTimeout(timer); waiting.delete(id); resolve(null); }
    });
  }

  function randomId(): string {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b: number) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
  }

  /* ---------- The app's state: the latest alarms message ---------- */

  interface State {
    readonly records: AlarmRecord[];
    readonly armed: Map<string, number>;
    readonly problems: Problem[];
  }

  let state: State = { records: [], armed: new Map(), problems: [] };
  let page: AppPage | null = null;
  /* The zone the overview was last drawn in (refresh, below). */
  let lastZone: string | null = null;

  function isProblem(p: unknown): p is Problem {
    return typeof p === 'string' && Object.prototype.hasOwnProperty.call(T.PROBLEMS, p);
  }

  function takeAlarms(msg: Incoming): void {
    /* Records are checked with the page's own check once the page is there (attach); until then they
       are kept as the app sent them, as the hand-written script did, and nothing draws them. */
    let records = (Array.isArray(msg.records) ? msg.records : []) as AlarmRecord[];
    if (page && !page.core.isValidRecordSet(records)) records = [];
    const armed = new Map<string, number>();
    (Array.isArray(msg.armed) ? (msg.armed as unknown[]) : []).forEach(function (a) {
      const x = a as { id?: unknown; fireAt?: unknown } | null;
      if (x && typeof x.id === 'string' && typeof x.fireAt === 'string') {
        const t = Date.parse(x.fireAt);
        if (!isNaN(t)) armed.set(x.id, t);
      }
    });
    const problems = (Array.isArray(msg.problems) ? (msg.problems as unknown[]) : []).filter(isProblem);
    state = { records: records, armed: armed, problems: problems };
    render();
  }

  function listAlarms(): Promise<AlarmRecord[]> {
    return ask({ type: 'alarms.list' }, 3000).then(function (answer) {
      if (answer && answer.type === 'alarms') takeAlarms(answer);
      return state.records;
    });
  }

  /* ---------- What the page asks of the app (window.EclipseTrackerApp) ---------- */

  /* The Play edition has no travel note of its own: the page keeps the website's two sentences. */
  const travel: { travelNote?: string } = PLAY ? {} : { travelNote: T.TRAVEL };
  window.EclipseTrackerApp = Object.freeze({
    ...travel,
    rowsFor: function (eclipseId: string): Promise<PlannerRow[]> {
      /* The Play edition stores no alarm: the planner opens with the page's default, as on the website. */
      if (PLAY) return Promise.resolve([]);
      return listAlarms().then(function (records) { return page ? page.core.rowsFromRecords(records, eclipseId) : []; });
    },
    saveFile: function (name: string, text: string): Promise<boolean> {
      return ask({ type: 'calendar.save', fileName: name, ics: text }, 0).then(function (answer) {
        if (answer && answer.ok === true) return true;
        if (!(answer && answer.cancelled === true) && page) page.say(T.SAVE_FAILED);
        return false;
      });
    },
    attach: function (p: AppPage): void {
      page = p;
      /* Fix D (17 October 2026, N-2): the zone the page starts in, so a change of zone in the first
         minute is seen as one at the next look and the armed times are asked for again. */
      lastZone = page.zone();
      setUpPlanner();
      if (PLAY) return;
      setUpOverview();
      listAlarms();
    }
  });

  /* ---------- The planner: Set ringing alarms, Add to calendar ---------- */

  function button(id: string, cls: string, text: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = id;
    b.className = cls;
    b.textContent = text;
    return b;
  }

  function problemWords(problems: readonly Problem[]): string {
    return problems.map(function (p) { return T.PROBLEMS[p][0]; }).join(' ');
  }

  function setUpPlanner(): void {
    const save = document.getElementById('save-ics');
    if (!save || document.getElementById('app-set') || document.getElementById('app-calendar')) return;
    /* Fix D (17 October 2026, N-4): the app's planner buttons are 48 px tall too (touchSize, C-4). */
    const add = touchSize(button('app-calendar', 'btn btn-secondary', T.ADD));
    if (PLAY) {
      /* The Google Play edition: Save stays the primary button, Add to calendar follows it, and the
         note's last sentence says what the app keeps (the last file handed to the calendar app). */
      save.insertAdjacentElement('afterend', add);
      add.addEventListener('click', addToCalendar);
      replaceKeeps(T.PLAY_KEEPS);
      return;
    }
    /* Ringing alarms are the app's first output: Set ringing alarms is the primary button. */
    const set = touchSize(button('app-set', 'btn btn-primary', T.SET));
    save.className = save.className.replace('btn-primary', 'btn-secondary');
    save.insertAdjacentElement('beforebegin', set);
    save.insertAdjacentElement('afterend', add);
    set.addEventListener('click', setRinging);
    add.addEventListener('click', addToCalendar);
    replaceKeeps(T.KEEPS);
  }

  /* Replaces the planner note's last sentence, the website's "keeps nothing", with the app's own. */
  function replaceKeeps(words: string): void {
    const note = document.querySelector('.planner-note');
    if (note && note.textContent !== null && note.textContent.indexOf(WEB_KEEPS) >= 0) note.textContent = note.textContent.replace(WEB_KEEPS, words);
  }

  function setRinging(): void {
    /* The buttons exist only once attach has run, so the page is always there. */
    const pg = page;
    if (!pg) return;
    const plan = pg.ringingRows();
    if (!plan) return;
    let records: AlarmRecord[];
    try {
      records = pg.core.recordsFromRows(plan.eclipse.id, plan.rows.map(function (r): PlannerRow { return r.id ? { id: r.id, spec: r.spec } : { spec: r.spec }; }), randomId);
    } catch (e) {
      pg.say(T.SET_FAILED);
      return;
    }
    /* No time limit: the app answers once the notification dialog it may open has been answered. */
    ask({ type: 'alarms.set', eclipseId: plan.eclipse.id, records: records }, 0).then(function (answer) {
      if (!answer || answer.type !== 'alarms' || answer.ok !== true) {
        if (answer && answer.type === 'alarms') takeAlarms(answer);
        pg.say(T.SET_FAILED);
        return;
      }
      takeAlarms(answer);
      const ids: Array<string | undefined> = [];
      for (let i = 0; i < plan.count; i++) ids.push(undefined);
      plan.rows.forEach(function (r, k) { ids[r.index] = records[k]?.id; });
      const open = pg.planning();
      if (open && open.id === plan.eclipse.id) pg.setRowIds(ids);
      const n = records.length;
      let words: string = n === 0 ? T.SET_NONE : n === 1 ? T.SET_ONE : T.SET_MANY.replace('{n}', String(n));
      if (n > 0 && state.problems.length) words += ' ' + problemWords(state.problems);
      pg.say(words);
    });
  }

  function addToCalendar(): void {
    const pg = page;
    if (!pg) return;
    const file = pg.file();
    if (!file) return;
    ask({ type: 'calendar.add', fileName: file.name, ics: file.text }).then(function (answer) {
      if (!answer || answer.ok !== true) pg.say(T.CAL_FAILED);
      else pg.say(answer.via === 'share' ? T.CAL_SHARED : T.CAL_OPENED);
    });
  }

  /* ---------- The overview: Ringing alarms (spec 9.8) ---------- */

  interface Overview {
    readonly section: HTMLElement;
    readonly problems: HTMLDivElement;
    readonly list: HTMLDivElement;
    readonly status: HTMLParagraphElement;
  }

  let overview: Overview | null = null;

  function setUpOverview(): void {
    if (document.getElementById('app-alarms')) return;
    const first = document.querySelector('main .card');
    if (!first) return;
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
  const TOUCH_PX = '48px';
  function touchSize(b: HTMLButtonElement): HTMLButtonElement {
    b.style.minHeight = TOUCH_PX;
    b.style.minWidth = TOUCH_PX;
    return b;
  }

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  interface Shown {
    readonly r: AlarmRecord;
    readonly at: number;
  }

  function render(): void {
    if (!overview || !page) return;
    const ov = overview;
    const pg = page;
    const core = pg.core;
    const zone = pg.zone();
    const now = Date.now();
    const active = document.activeElement;
    const focusKey = active instanceof HTMLElement && ov.section.contains(active) ? active.dataset.key : null;

    ov.problems.replaceChildren();
    /* Ask late (SunApp's rule): what the phone refuses is shown once there is an alarm it matters for. */
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

    const groups = new Map<string, { e: Eclipse; alarms: Shown[] }>();
    state.records.forEach(function (r) {
      const e = core.eclipseById(r.eclipseId);
      if (!e) return;
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
    if (ordered.length === 0) ov.list.append(el('p', 'list-count', T.EMPTY));
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
      const again = ov.section.querySelector<HTMLElement>('[data-key="' + focusKey + '"]');
      (again || document.getElementById('app-alarms-heading'))?.focus();
    }
  }

  function deleteRecord(record: AlarmRecord): void {
    /* Delete buttons exist only in the overview, so it is always there. */
    const ov = overview;
    if (!ov) return;
    const rest = state.records.filter(function (r) { return r.eclipseId === record.eclipseId && r.id !== record.id; });
    ask({ type: 'alarms.set', eclipseId: record.eclipseId, records: rest }, 0).then(function (answer) {
      if (answer && answer.type === 'alarms') takeAlarms(answer);
      const ok = !!(answer && answer.type === 'alarms' && answer.ok === true);
      ov.status.textContent = '';
      window.setTimeout(function () { ov.status.textContent = ok ? T.DELETED : T.DELETE_FAILED; }, 60);
      if (ok && !ov.section.contains(document.activeElement)) document.getElementById('app-alarms-heading')?.focus();
    });
  }

  /* Once a minute and when the page comes back into view: the times shown follow the clock and the
     zone; after a change of zone the app has re-planned, so its armed times are asked for again.
     lastZone is set by attach (fix D, N-2: it started as null, so a change of zone before the first
     look went unnoticed and the overview showed the old armed instant in the new zone). */
  function refresh(): void {
    if (!page) return;
    const zone = page.zone();
    if (lastZone !== null && zone !== lastZone) listAlarms();
    lastZone = zone;
    render();
  }
  if (!PLAY) {
    window.setInterval(refresh, 60000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) window.setTimeout(refresh, 1200); });
  }

  /* ---------- Back ---------- */

  function onBack(q: number): void {
    const dialog = document.getElementById('planner') as HTMLDialogElement | null;
    let handled = false;
    if (dialog && dialog.open) {
      /* As Close, or Escape: the page puts focus back where it was. */
      dialog.close();
      handled = true;
    }
    post({ type: 'back.result', q: q, handled: handled });
  }

  /* ---------- Messages from the app ---------- */

  const isCount = function (n: unknown): n is number { return typeof n === 'number' && n > 0 && n <= 0x7fffffff && Math.floor(n) === n; };

  channel.addEventListener('message', function (ev) {
    let msg: Incoming | null;
    try { msg = JSON.parse(ev.data) as Incoming | null; } catch (e) { return; }
    if (!msg || typeof msg !== 'object' || msg.v !== 1) return;
    if (msg.type === 'back') {
      if (isCount(msg.q)) onBack(msg.q);
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
    if (msg.type === 'alarms' && msg.id === undefined && !PLAY) takeAlarms(msg);
  });

  post({ type: 'hello' });
})();
