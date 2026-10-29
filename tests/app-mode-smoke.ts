#!/usr/bin/env node
// Browser smoke test of EclipseTracker in APP MODE: the page as the Android app loads it, in
// headless Chromium over the DevTools protocol (tests/cdp.ts), modelled on GDPRLetterBuilder's
// tests/app-mode-smoke.mjs (its review A3-3).
//
//   node tests/app-mode-smoke.ts [--chromium /usr/bin/chromium] [--shots DIR]
//
// What it serves is what the APK holds: index.html with the one line the build injects
// (<script src="android-bridge.js"></script> before the first script, as WebAssets.inject does in
// android/app/build.gradle.kts), android/web-overlay/android-bridge.js beside it (compiled from
// android-bridge.ts by tools/build-ts.sh: what the APK bundles), and every response
// with the headers the app's asset handler sends (ResponseHeaders.kt). The app's side of the
// window.ETBridge channel is a stand-in (STUB below), injected before the page loads as the WebView
// injects the real one; it answers as MainActivity does (spec 9.6), and each check chooses how.
// The real android-bridge.js runs on top of it, so this tests the bridge script and the page
// (the words the checks expect are read from the TypeScript source, so the compiled script is
// held to its source too)
// together, on a frozen clock (16 October 2026, 10:30 UTC), in Europe/Oslo:
//   * the bridge says hello; no request leaves the page, none after load, no policy violation,
//     no error, no storage, no cookie, no download;
//   * the planner gains Set ringing alarms (primary, before Save) and Add to calendar (after it),
//     shows the app's travel note (spec 9.9, exactly as Marcos wrote it) instead of the website's
//     two travel sentences, and says the app keeps the ringing alarms;
//   * Set ringing alarms sends alarms.set with valid records (recordsFromRows), only the alarms
//     the file would hold (no passed, no repeated alarm), and says how many were set; a refusal
//     says so; an empty time stops it with the page's own line and sends nothing;
//   * the planner opens with the stored alarms (alarms.list, rowsFromRecords); a changed row keeps
//     its record id and a new row gets a new one; removing a row deletes its record;
//   * Add to calendar sends calendar.add with the page's file name and the very file Save makes;
//     the line under it follows the app's answer (calendar, share sheet, failure);
//   * Save sends calendar.save, and says "Saved ..." only once the app has written the file;
//     cancelled, nothing; failed, the app's line;
//   * the Ringing alarms overview: every stored alarm by eclipse in time order with the time it
//     rings (the app's armed time, or worked out), Change opens the planner with that eclipse's
//     alarms, Delete removes one; the problems with their fix buttons (problem.fix);
//   * Back closes an open planner (handled) and otherwise lets the app close;
//   * a change of time zone: the planner's line, the overview's times and a fresh alarms.list;
//     fix D (N-2): also when the zone changes before the bridge's first look, in the first minute;
//   * fix C: the text enlarged as the app does it (TextScale.kt) at 1.3, 1.5 and 2.0, at 320 px and
//     412 px: the title whole, no sideways scroll, every select whole, the overview's buttons 48 px;
//   * fix D (N-4): the planner's two app buttons are 48 px tall too, at 1.0 and when enlarged;
//   * fix C: the disclaimer with the app's headers, readable in the dark and the light scheme;
//   * the website, and the APK's files on a WebView too old for the channel, show none of it;
//   * the Google Play edition (/play/: the line the build injects with data-edition="play",
//     WebAssets.PLAY_INJECTED_TAG): Add to calendar after Save, which stays primary, and nothing
//     about ringing alarms: no Set ringing alarms, no overview, no app travel note, a closing note
//     that says the app keeps the last calendar file, and no alarm message ever posted, even when
//     the app sends alarm news.
// Nothing leaves the machine: the browser can reach only this server.
//
// The file name does not end in .test.ts, so `node --test tests/*.test.ts` does not run it.

import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { launchChromium, openPage, selectsCut, sleep } from './cdp.ts';
import type { FromBrowser, Page } from './cdp.ts';
import { planAlarms } from '#core/alarms.js';
import { eclipseById } from '#core/eclipses.js';
import { buildIcs } from '#core/ics.js';
import type { AlarmSpec } from '#core/types.js';
import { defined, group } from './helpers.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const arg = <T extends string | null>(name: string, dflt: T): string | T => {
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] ?? dflt) : dflt;
};
const CHROMIUM = arg('--chromium', '/usr/bin/chromium');
const SHOTS = arg('--shots', null);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const J = JSON.stringify;

// The app's headers (ResponseHeaders.kt, ALL).
const KT = join(ROOT, 'android/app/src/main/kotlin/no/stormberry/eclipsetracker/web');
const APP_CSP = defined(group(/CONTENT_SECURITY_POLICY =\s*([\s\S]*?)\n\n/, readFileSync(join(KT, 'ResponseHeaders.kt'), 'utf8'))
  .match(/"([^"]*)"/g), 'the policy strings').map((s) => s.slice(1, -1)).join('');
const HEADERS = { 'Content-Security-Policy': APP_CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
// Fix C (M-1): the disclaimer's response allows its one style element by hash (ResponseHeaders.DISCLAIMER),
// made here from the Kotlin constant exactly as ResponseHeaders.kt makes it.
const KT_HEADERS = readFileSync(join(KT, 'ResponseHeaders.kt'), 'utf8');
const DISCLAIMER_HASH = group(/DISCLAIMER_STYLE_HASH = "([^"]+)"/, KT_HEADERS);
const DISCLAIMER_CSP = APP_CSP.replace("style-src 'self';", `style-src 'self' '${DISCLAIMER_HASH}';`);
const DISCLAIMER_HEADERS = { ...HEADERS, 'Content-Security-Policy': DISCLAIMER_CSP };
// Fix C (S-2): the app enlarges the page's text as a browser's font size setting does, with a larger
// default font size (TextScale.kt); the two base sizes are read from there.
const TEXT_SCALE_KT = readFileSync(join(KT, 'TextScale.kt'), 'utf8');
const BASE_FONT_PX = Number(group(/const val BASE_FONT_PX = (\d+)/, TEXT_SCALE_KT));
const BASE_FIXED_FONT_PX = Number(group(/const val BASE_FIXED_FONT_PX = (\d+)/, TEXT_SCALE_KT));
const appFontSizes = (scale: number): { standard: number; fixed: number } => ({ standard: Math.round(BASE_FONT_PX * scale), fixed: Math.round(BASE_FIXED_FONT_PX * scale) });
const BRIDGE_TAG = '<script src="android-bridge.js"></script>';
/** The Google Play edition's line (WebAssets.PLAY_INJECTED_TAG): the same script, told the edition. */
const PLAY_TAG = '<script src="android-bridge.js" data-edition="play"></script>';
// Both lines are the build's own (android/app/build.gradle.kts, WebAssets), escaped as Kotlin writes them.
{
  const gradle = readFileSync(join(ROOT, 'android/app/build.gradle.kts'), 'utf8');
  for (const tag of [BRIDGE_TAG, PLAY_TAG]) assert.ok(gradle.includes(`"${tag.replace(/"/g, '\\"')}"`), `build.gradle.kts injects ${tag}`);
}
const TYPES: Readonly<Record<string, string>> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
/** What the app serves: the compiled bridge script. */
const BRIDGE_SRC = readFileSync(join(ROOT, 'android/web-overlay/android-bridge.js'), 'utf8');
/** Its TypeScript source, where the words are written. */
const BRIDGE_TS = readFileSync(join(ROOT, 'android/web-overlay/android-bridge.ts'), 'utf8');

// The bridge's own words, read from its source so a change there shows here.
const W = (name: string): string => {
  const m = BRIDGE_TS.match(new RegExp(`\\n    ${name}: ('([^']*)'|"([^"]*)"),`));
  const word = m ? (m[2] ?? m[3]) : undefined;
  if (word === undefined) throw new Error(`no ${name} in android-bridge.ts`);
  return word;
};
const WORDS = ['SET', 'ADD', 'TRAVEL', 'KEEPS', 'SET_ONE', 'SET_MANY', 'SET_NONE', 'SET_FAILED', 'CAL_OPENED', 'CAL_SHARED', 'CAL_FAILED', 'SAVE_FAILED', 'HEADING', 'INTRO', 'EMPTY', 'CHANGE', 'DELETE', 'DELETED', 'PLAY_KEEPS'] as const;
const T = Object.fromEntries(WORDS.map((k) => [k, W(k)])) as Record<typeof WORDS[number], string>;
const A4 = "Ringing alarms follow your phone's time zone: if you travel, a 12.00 alarm rings at 12.00 where you are. Alarms before greatest eclipse always follow the eclipse.";
const WEB_TRAVEL = 'If you travel, those alarms still ring at the same moment, which may be a different hour where you are.';

// WebAssets.inject: the bridge tag on its own line, before the first <script, same indent.
function inject(source: string, tag: string = BRIDGE_TAG): string {
  const first = source.indexOf('<script');
  const lineStart = source.lastIndexOf('\n', first) + 1;
  const indent = source.slice(lineStart, first);
  return `${source.slice(0, lineStart)}${indent}${tag}\n${source.slice(lineStart)}`;
}

// /app/... is the APK's copy, /web/... the website, both from the same files; anything else (the
// carousel's /switcher-icons/...) is the website's. /nohash/... is the APK's copy with the policy of
// every other response on the disclaimer too (the control for fix C, M-1: what stage B sent).
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let path = decodeURIComponent(url.pathname);
  const nohash = path.startsWith('/nohash/');
  if (nohash) path = path.replace(/^\/nohash\//, '/app/');
  // /play/... is the Google Play edition's copy: the APK's files with the Play edition's line.
  const play = path.startsWith('/play/');
  if (play) path = path.replace(/^\/play\//, '/app/');
  const app = path.startsWith('/app/');
  if (!app && !path.startsWith('/web/')) path = `/web${path}`;
  const rel = path.replace(/^\/(app|web)\//, '/');
  let body: Buffer | null = null;
  let type: string | undefined;
  if (app && rel === '/android-bridge.js') {
    body = Buffer.from(BRIDGE_SRC);
    type = TYPES['.js'];
  } else {
    const file = normalize(join(ROOT, rel.endsWith('/') ? `${rel}index.html` : rel));
    const relFile = file.slice(ROOT.length);
    if (req.method === 'GET' && file.startsWith(ROOT) && !/^\/(android|tests|tools|ts|node_modules)\//.test(relFile) && existsSync(file) && statSync(file).isFile() && TYPES[extname(file)]) {
      body = readFileSync(file);
      type = TYPES[extname(file)];
      if (app && file === join(ROOT, 'index.html')) body = Buffer.from(inject(body.toString('utf8'), play ? PLAY_TAG : BRIDGE_TAG));
    }
  }
  if (!body) {
    res.writeHead(404, HEADERS);
    res.end('');
    return;
  }
  const headers = app && !nohash && rel === '/disclaimer.html' ? DISCLAIMER_HEADERS : HEADERS;
  res.writeHead(200, { ...headers, 'Content-Type': type ?? 'application/octet-stream' });
  res.end(body);
});
await new Promise<void>((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r); });
const address = server.address();
if (!address || typeof address === 'string') throw new Error('the test server has no port');
const ORIGIN = `http://127.0.0.1:${address.port}`;

// The app's side of ETBridge, as MainActivity answers (spec 9.6). window.__et: posted (every
// message, in order), records (what the app stores), armed (what it reports armed: [{ id, fireAt }]),
// problems, mode (per type: set 'ok' | 'fail'; add 'calendar' | 'share' | 'fail'; save 'ok' |
// 'cancel' | 'fail'), send(msg) (a message from the app).
const STUB = `(() => {
  const et = window.__et = { posted: [], records: [], armed: [], problems: [], mode: {} };
  const listeners = new Set();
  const send = et.send = (msg) => { msg.v = 1; const data = JSON.stringify(msg); listeners.forEach((fn) => fn({ data })); };
  const alarms = (id, ok) => ({ type: 'alarms', ...(id ? { id } : {}), ok, records: et.records, armed: et.armed, problems: et.problems });
  const answer = (m) => {
    if (m.type === 'alarms.list') send(alarms(m.id, true));
    else if (m.type === 'alarms.set') {
      if (et.mode.set === 'fail') { send(alarms(m.id, false)); return; }
      et.records = et.records.filter((r) => r.eclipseId !== m.eclipseId).concat(m.records);
      send(alarms(m.id, true));
    } else if (m.type === 'calendar.add') {
      const mode = et.mode.add || 'calendar';
      send({ type: 'calendar.result', id: m.id, ok: mode !== 'fail', via: mode === 'share' ? 'share' : 'calendar' });
    } else if (m.type === 'calendar.save') {
      const mode = et.mode.save || 'ok';
      send({ type: 'calendar.result', id: m.id, ok: mode === 'ok', via: 'save', ...(mode === 'cancel' ? { cancelled: true } : {}) });
    }
  };
  window.ETBridge = {
    postMessage(text) { const m = JSON.parse(text); et.posted.push(m); setTimeout(() => answer(m), 5); },
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
  };
})();`;

const NOW = Date.parse('2026-10-16T10:30:00Z');
const clockAt = (t: number): string => `(() => { const real = Date.now.bind(Date); const off = ${t} - real(); Date.now = () => real() + off; })();`;
const work = mkdtempSync(join(tmpdir(), 'eclipse-app-mode-'));
const downloads = join(work, 'downloads');
mkdirSync(downloads, { recursive: true });
const browser = await launchChromium({ chromium: CHROMIUM, out: join(work, 'chromium') });
const open = (path: string, { stub = true, width = 1280, height = 900, timezone = 'Europe/Oslo', now = NOW }: { stub?: boolean; width?: number; height?: number; timezone?: string; now?: number } = {}): Promise<Page> =>
  openPage(browser, `${ORIGIN}${path}`, { width, height, timezone, base: ORIGIN, downloads, init: stub ? `${clockAt(now)}\n${STUB}` : clockAt(now) });

let passed = 0;
async function cleanup(): Promise<void> {
  await browser.close().catch(() => {});
  server.close();
  rmSync(work, { recursive: true, force: true });
}
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${passed} ${name}`);
  } catch (err) {
    console.log(`not ok ${name}\n  ${String((err as Error | null)?.stack || err).split('\n').join('\n  ')}`);
    await cleanup();
    process.exit(1);
  }
}

const houseStyle = (text: string, where: string): void => {
  assert.doesNotMatch(text, /[–—]/, `${where}: no en or em dash`);
  assert.doesNotMatch(text, /--/, `${where}: no double hyphen`);
  assert.doesNotMatch(text, /!/, `${where}: no exclamation mark`);
};
const posted = (p: Page, type: string): Promise<FromBrowser[]> => p.ev(`window.__et.posted.filter((m) => m.type === ${J(type)})`);
const status = (p: Page): Promise<string> => p.ev("document.getElementById('planner-status').textContent");
const setSelect = (p: Page, selector: string, value: string): Promise<void> => p.ev(`(() => { const s = ${selector}; s.focus(); s.value = ${J(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const setTime = (p: Page, selector: string, value: string): Promise<void> => p.ev(`(() => { const t = ${selector}; t.focus(); t.value = ${J(value)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const waitStatus = (p: Page, text: string): Promise<boolean> => p.waitFor(`document.getElementById('planner-status').textContent === ${J(text)}`, 4000);
const RECORD_ID = /^[0-9a-f]{32}$/;

const p = await open('/app/');

await check('the bridge says hello, the page starts with the app parts, and nothing leaves or is stored', async () => {
  const first = await p.ev('window.__et.posted[0]');
  assert.deepEqual(first, { type: 'hello', v: 1 });
  assert.equal(await p.ev("typeof window.EclipseTrackerApp.rowsFor"), 'function');
  assert.equal(await p.ev("Object.isFrozen(window.EclipseTrackerApp)"), true);
  assert.equal(await p.ev("!!document.getElementById('app-alarms')"), true);
  assert.equal(await p.ev("document.getElementById('app-alarms-heading').textContent"), T.HEADING);
  assert.equal(await p.ev("document.getElementById('app-alarms').previousElementSibling.querySelector('#countdown-timer') !== null"), true, 'the overview follows the countdown card');
  await p.waitFor("document.querySelector('#app-alarms-list .list-count')?.textContent.length > 0");
  assert.equal(await p.ev("document.querySelector('#app-alarms-list .list-count').textContent"), T.EMPTY);
  // Ask late: with no alarm stored, what the phone refuses is not shown yet.
  await p.ev("window.__et.send({ type: 'alarms', ok: true, records: [], armed: [], problems: ['notifications-denied'] })");
  await sleep(200);
  assert.equal(await p.ev("document.getElementById('app-problems').children.length"), 0);
  assert.ok((await posted(p, 'alarms.list')).length >= 1, 'the stored alarms were asked for');
  assert.deepEqual(p.log.errors, []);
  assert.deepEqual(p.log.csp, []);
  assert.deepEqual(await p.ev('window.__csp'), []);
  assert.deepEqual(p.log.offsite, []);
  assert.equal(await p.ev('localStorage.length + sessionStorage.length'), 0);
  assert.equal(await p.ev('document.cookie'), '');
});

await check("the planner gains Set ringing alarms and Add to calendar, and shows the app's travel note", async () => {
  await p.click('#next-alarms');
  await p.waitFor("document.getElementById('planner').open");
  const order = await p.ev("[...document.querySelectorAll('.planner-actions button')].map((b) => [b.id, b.className, b.textContent])");
  assert.deepEqual(order, [
    ['app-set', 'btn btn-primary', T.SET],
    ['save-ics', 'btn btn-secondary', 'Save the calendar file'],
    ['app-calendar', 'btn btn-secondary', T.ADD],
    ['close-planner', 'btn btn-secondary', 'Close'],
  ]);
  // Fix D (N-4): the app's two planner buttons are at least 48 px tall at the normal text size.
  assert.deepEqual(await p.ev("['app-set', 'app-calendar'].map((id) => document.getElementById(id).getBoundingClientRect().height >= 47.5)"), [true, true]);
  assert.equal(T.TRAVEL, A4, "the travel note is Marcos's text exactly (spec 9.9)");
  assert.equal(await p.ev("document.getElementById('planner-zone').textContent"), `Times of day are for this device's time zone, Europe/Oslo. ${A4}`);
  assert.equal(await p.ev(`document.body.innerText.includes(${J(WEB_TRAVEL)})`), false, "the website's travel sentence is not shown in the app");
  const note = await p.ev("document.querySelector('.planner-note').textContent");
  assert.ok(note.endsWith(T.KEEPS) && !note.includes('keeps nothing'), note);
  assert.ok(note.startsWith('Open the saved file with your calendar app'), 'the rest of the note is the approved text');
});

let firstId: string | undefined;
await check('Set ringing alarms stores the default alarm and says so; the overview shows it', async () => {
  await p.click('#app-set');
  await waitStatus(p, T.SET_ONE);
  const sets = await posted(p, 'alarms.set');
  assert.equal(sets.length, 1);
  const m = sets[0];
  assert.equal(m.eclipseId, '2027-02-06-solar');
  assert.equal(m.records.length, 1);
  const r = m.records[0];
  assert.deepEqual(Object.keys(r).sort(), ['eclipseId', 'id', 'spec', 'v']);
  assert.match(r.id, RECORD_ID);
  assert.deepEqual(r.spec, { kind: 'day', daysBefore: 0, time: '12:00' });
  firstId = r.id;
  await p.key('Escape');
  await p.waitFor("document.querySelectorAll('#app-alarms-list li').length === 1");
  const text = await p.ev("document.getElementById('app-alarms-list').innerText");
  assert.match(text, /Annular solar eclipse/);
  assert.match(text, /Greatest eclipse: Saturday 6 February 2027 at 17:00 \(UTC\+1\)\./);
  assert.match(text, /On the day of the eclipse at 12:00/);
  assert.match(text, /Rings Saturday 6 February 2027 at 12:00 \(UTC\+1\)\./);
});

await check('the planner opens with the stored alarms; a changed row keeps its id, a new row gets a new one', async () => {
  await p.click('#next-alarms');
  await p.waitFor("document.getElementById('planner').open");
  assert.equal(await p.ev("document.querySelectorAll('.alarm-row').length"), 1);
  await setTime(p, "document.querySelector('.alarm-time')", '08:30');
  await p.ev("document.getElementById('add-alarm').click()");
  await setSelect(p, "document.querySelectorAll('.alarm-choice')[1]", 'before');
  await p.click('#app-set');
  await waitStatus(p, T.SET_MANY.replace('{n}', '2'));
  const m = (await posted(p, 'alarms.set')).at(-1);
  assert.equal(m.records.length, 2);
  assert.equal(m.records[0].id, firstId, 'the changed row keeps its record id (spec 9.6)');
  assert.deepEqual(m.records[0].spec, { kind: 'day', daysBefore: 0, time: '08:30' });
  assert.match(m.records[1].id, RECORD_ID);
  assert.notEqual(m.records[1].id, firstId);
  assert.deepEqual(m.records[1].spec, { kind: 'before', minutes: 30 });
  // Setting again changes no id: the rows now carry theirs.
  await p.click('#app-set');
  await p.waitFor(`window.__et.posted.filter((m) => m.type === 'alarms.set').length === ${(await posted(p, 'alarms.set')).length + 1}`);
  const again = (await posted(p, 'alarms.set')).at(-1);
  assert.deepEqual(again.records.map((r: FromBrowser) => r.id), m.records.map((r: FromBrowser) => r.id));
});

await check('only the alarms the file would hold are stored: no repeated alarm; an empty time sends nothing', async () => {
  // Alarm 3 repeats alarm 1 (on the day at 08:30).
  await p.ev("document.getElementById('add-alarm').click()");
  await setSelect(p, "document.querySelectorAll('.alarm-choice')[2]", 'day-0');
  await setTime(p, "document.querySelectorAll('.alarm-time')[2]", '08:30');
  assert.match(await p.ev("document.querySelectorAll('.alarm-result')[2].textContent"), /same moment as alarm 1/);
  const before = (await posted(p, 'alarms.set')).length;
  await p.click('#app-set');
  await waitStatus(p, T.SET_MANY.replace('{n}', '2'));
  const m = (await posted(p, 'alarms.set')).at(-1);
  assert.equal((await posted(p, 'alarms.set')).length, before + 1);
  assert.equal(m.records.length, 2, 'the repeated alarm is left out, as from the file');
  // An empty time: the page's own line, nothing posted.
  await setTime(p, "document.querySelectorAll('.alarm-time')[2]", '');
  await p.click('#app-set');
  await waitStatus(p, 'Alarm 3 needs a time.');
  assert.equal((await posted(p, 'alarms.set')).length, before + 1);
  // Removing the third row again.
  await p.ev("document.querySelectorAll('.btn-remove')[2].click()");
});

await check('a refused set says so', async () => {
  await p.ev("window.__et.mode.set = 'fail'");
  await p.click('#app-set');
  await waitStatus(p, T.SET_FAILED);
  await p.ev("window.__et.mode.set = 'ok'");
});

await check('Add to calendar hands over the very file Save makes, and the line follows the answer', async () => {
  const count = (await posted(p, 'calendar.add')).length;
  await p.click('#app-calendar');
  await waitStatus(p, T.CAL_OPENED);
  const m = (await posted(p, 'calendar.add')).at(-1);
  assert.equal((await posted(p, 'calendar.add')).length, count + 1);
  assert.equal(m.fileName, 'eclipse-2027-02-06-solar.ics');
  const e = defined(eclipseById('2027-02-06-solar'), 'the 2027-02-06 solar eclipse');
  const specs: AlarmSpec[] = [{ kind: 'day', daysBefore: 0, time: '08:30' }, { kind: 'before', minutes: 30 }];
  const uid = group(/UID:([0-9a-f]+)@/, m.ics);
  const stamp = group(/DTSTAMP:(\d{8}T\d{6}Z)/, m.ics);
  const dtstamp = Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(9, 11), +stamp.slice(11, 13), +stamp.slice(13, 15));
  const want = buildIcs({ eclipse: e, alarms: planAlarms(e, specs, 'Europe/Oslo', NOW), uid, dtstamp });
  assert.equal(m.ics, want, 'byte for byte what core/ics.js makes');
  assert.ok(m.ics.length < 64 * 1024 && m.ics.startsWith('BEGIN:VCALENDAR\r\n') && m.ics.endsWith('END:VCALENDAR\r\n'));
  await p.ev("window.__et.mode.add = 'share'");
  await p.click('#app-calendar');
  await waitStatus(p, T.CAL_SHARED);
  await p.ev("window.__et.mode.add = 'fail'");
  await p.click('#app-calendar');
  await waitStatus(p, T.CAL_FAILED);
  await p.ev("window.__et.mode.add = 'calendar'");
});

await check('Save goes to the save screen and says Saved only once the file is written', async () => {
  await p.click('#save-ics');
  await waitStatus(p, 'Saved eclipse-2027-02-06-solar.ics with 2 alarms. Open it with your calendar app.');
  const m = (await posted(p, 'calendar.save')).at(-1);
  assert.equal(m.fileName, 'eclipse-2027-02-06-solar.ics');
  assert.match(m.ics, /^BEGIN:VCALENDAR\r\n/);
  await p.ev("document.getElementById('planner-status').textContent = ''");
  await p.ev("window.__et.mode.save = 'cancel'");
  await p.click('#save-ics');
  await sleep(300);
  assert.equal(await status(p), '', 'a cancelled save says nothing');
  await p.ev("window.__et.mode.save = 'fail'");
  await p.click('#save-ics');
  await waitStatus(p, T.SAVE_FAILED);
  await p.ev("window.__et.mode.save = 'ok'");
  assert.deepEqual(p.log.downloads, [], 'no download in the app');
});

await check('Back closes the open planner; with none open the app may close', async () => {
  await p.ev("window.__et.send({ type: 'back', q: 1 })");
  await p.waitFor("!document.getElementById('planner').open");
  await p.waitFor("window.__et.posted.some((m) => m.type === 'back.result' && m.q === 1)");
  assert.deepEqual((await posted(p, 'back.result')).at(-1), { type: 'back.result', q: 1, handled: true, v: 1 });
  assert.equal(await p.ev("document.activeElement.id"), 'next-alarms', 'focus goes back to the button that opened it');
  await p.ev("window.__et.send({ type: 'back', q: 2 })");
  await p.waitFor("window.__et.posted.some((m) => m.type === 'back.result' && m.q === 2)");
  assert.deepEqual((await posted(p, 'back.result')).at(-1), { type: 'back.result', q: 2, handled: false, v: 1 });
});

await check('the overview: alarms by eclipse in time order, the armed time, Change and Delete', async () => {
  // A second eclipse, from its list item: the lunar eclipse of 20 February 2027 (23:13 UTC).
  await p.ev("document.querySelector('.btn-alarm[data-id=\"2027-02-20-lunar\"]').scrollIntoView()");
  await p.click('.btn-alarm[data-id="2027-02-20-lunar"]');
  await p.waitFor("document.getElementById('planner').open");
  assert.match(await p.ev("document.getElementById('planner-title').textContent"), /penumbral lunar eclipse/);
  await p.click('#app-set');
  await waitStatus(p, T.SET_ONE);
  await p.key('Escape');
  // The app reports the solar one armed at another instant than worked out here: the overview shows the app's.
  const solar = await p.ev("window.__et.records.filter((r) => r.eclipseId === '2027-02-06-solar').map((r) => r.id)");
  await p.ev(`window.__et.armed = [{ id: ${J(solar[1])}, fireAt: '2027-02-06T15:00:00Z' }]; window.__et.send({ type: 'alarms', ok: true, records: window.__et.records, armed: window.__et.armed, problems: [] })`);
  await p.waitFor("document.querySelectorAll('#app-alarms-list li').length === 3");
  const groups = await p.ev("[...document.querySelectorAll('#app-alarms-list > .eclipse-item')].map((g) => [g.querySelector('h3').textContent, [...g.querySelectorAll('li')].map((li) => li.innerText.split('\\n').filter(Boolean).slice(0, 2).join(' | '))])");
  assert.deepEqual(groups, [
    ['Annular solar eclipse', [
      'On the day of the eclipse at 08:30 | Rings Saturday 6 February 2027 at 08:30 (UTC+1).',
      '30 minutes before greatest eclipse | Rings Saturday 6 February 2027 at 16:00 (UTC+1).',
    ]],
    ['Penumbral lunar eclipse', [
      // 23:13 UTC is 00:13 on 21 February in Oslo: "the day" is the 21st (ALARM-1).
      'On the day of the eclipse at 12:00 | Rings Sunday 21 February 2027 at 12:00 (UTC+1).',
    ]],
  ]);
  // Delete the solar eclipse's 30-minute alarm.
  const del = await p.ev("[...document.querySelectorAll('#app-alarms-list li')].findIndex((li) => li.innerText.startsWith('30 minutes'))");
  await p.ev(`document.querySelectorAll('#app-alarms-list li')[${del}].querySelectorAll('button')[1].focus()`);
  await p.ev(`document.querySelectorAll('#app-alarms-list li')[${del}].querySelectorAll('button')[1].click()`);
  await p.waitFor(`document.getElementById('app-alarms-status').textContent === ${J(T.DELETED)}`, 4000);
  const m = (await posted(p, 'alarms.set')).at(-1);
  assert.equal(m.eclipseId, '2027-02-06-solar');
  assert.deepEqual(m.records.map((r: FromBrowser) => r.id), [solar[0]]);
  assert.equal(await p.ev("document.querySelectorAll('#app-alarms-list li').length"), 2);
  assert.ok(await p.ev("document.getElementById('app-alarms').contains(document.activeElement)"), 'focus stays in the overview');
  assert.equal(await p.ev("document.getElementById('app-alarms-status').getAttribute('aria-live')"), 'polite');
  // Change opens the planner for that eclipse with its stored alarms.
  await p.ev("[...document.querySelectorAll('#app-alarms-list li')].find((li) => li.innerText.startsWith('On the day of the eclipse at 12:00')).querySelector('button').click()");
  await p.waitFor("document.getElementById('planner').open && document.querySelectorAll('.alarm-row').length === 1");
  assert.match(await p.ev("document.getElementById('planner-title').textContent"), /penumbral lunar eclipse/);
  assert.equal(await p.ev("document.querySelector('.alarm-time').value"), '12:00');
  await p.key('Escape');
});

await check('the problems show with a way to fix each', async () => {
  await p.ev("window.__et.problems = ['notifications-denied', 'exact-alarms-denied', 'full-screen-denied', 'made-up']; window.__et.send({ type: 'alarms', ok: true, records: window.__et.records, armed: [], problems: window.__et.problems })");
  await p.waitFor("document.querySelectorAll('#app-problems .app-problem').length === 3");
  const rows = await p.ev("[...document.querySelectorAll('#app-problems .app-problem')].map((r) => r.innerText.split('\\n').filter(Boolean))");
  assert.deepEqual(rows, [
    ['Notifications are off or turned down for EclipseTracker, so an alarm still rings but may show nothing on screen. Open EclipseTracker to stop it.', 'Turn on notifications'],
    ['Exact alarms are not allowed, so an alarm may ring late or not at all.', 'Allow exact alarms'],
    ['Full-screen alarms are not allowed, so a ringing alarm shows only as a notification.', 'Allow full-screen alarms'],
  ]);
  await p.click('#app-fix-notifications-denied');
  assert.deepEqual((await posted(p, 'problem.fix')).at(-1), { type: 'problem.fix', problem: 'notifications-denied', v: 1 });
  // Setting alarms while notifications are refused says so in the planner too.
  await p.click('#next-alarms');
  await p.waitFor("document.getElementById('planner').open");
  await p.click('#app-set');
  await p.waitFor(`document.getElementById('planner-status').textContent.startsWith(${J(T.SET_ONE)})`, 4000);
  assert.ok((await status(p)).includes('Notifications are off or turned down for EclipseTracker, so an alarm still rings but may show nothing on screen. Open EclipseTracker to stop it.'), await status(p));
  await p.key('Escape');
  await p.ev("window.__et.problems = []; window.__et.send({ type: 'alarms', ok: true, records: window.__et.records, armed: [], problems: [] })");
  await p.waitFor("document.querySelectorAll('#app-problems .app-problem').length === 0");
});

await check('a change of time zone: the planner line, the overview times and a fresh list from the app', async () => {
  const lists = (await posted(p, 'alarms.list')).length;
  await p.s('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' });
  await p.ev("document.dispatchEvent(new Event('visibilitychange'))");
  await p.waitFor(`window.__et.posted.filter((m) => m.type === 'alarms.list').length > ${lists}`, 5000);
  await p.waitFor("document.getElementById('app-alarms-list').innerText.includes('UTC+9')", 5000);
  const text = await p.ev("document.getElementById('app-alarms-list').innerText");
  // A time of day on the Tokyo day of greatest eclipse (B-2): 7 February for the solar eclipse at
  // 01:00 Tokyo time, 21 February for the lunar one at 08:13.
  assert.match(text, /On the day of the eclipse at 08:30\s+Rings Sunday 7 February 2027 at 08:30 \(UTC\+9\)\./);
  assert.match(text, /Rings Sunday 21 February 2027 at 12:00 \(UTC\+9\)\./);
  await p.click('#next-alarms');
  await p.waitFor("document.getElementById('planner').open");
  assert.equal(await p.ev("document.getElementById('planner-zone').textContent"), `Times of day are for this device's time zone, Asia/Tokyo. ${A4}`);
  await p.key('Escape');
  await p.s('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Oslo' });
  await p.ev("document.dispatchEvent(new Event('visibilitychange'))");
  await sleep(1500);
});

// Fix D (N-2, found by the independent verification of fix C): the bridge's last zone started empty,
// so a change of zone before its first look (in the first minute after load) was not seen as one: the
// armed times were not asked for again and the overview showed the old armed instant in the new zone.
// A fresh page, the noon alarm on the day of the 6 February 2027 eclipse armed for 11:00 UTC (noon in
// Oslo); the zone becomes Tokyo at once and the app re-plans it to noon on 7 February in Tokyo.
await check('fix D, N-2: a change of time zone in the first minute after load asks for the armed times again', async () => {
  const f = await open('/app/');
  const rec = { v: 1, id: 'abcdefabcdefabcdefabcdefabcdef01', eclipseId: '2027-02-06-solar', spec: { kind: 'day', daysBefore: 0, time: '12:00' } };
  await f.ev(`window.__et.records = [${J(rec)}]; window.__et.armed = [{ id: ${J(rec.id)}, fireAt: '2027-02-06T11:00:00Z' }]; window.__et.send({ type: 'alarms', ok: true, records: window.__et.records, armed: window.__et.armed, problems: [] })`);
  await f.waitFor("document.getElementById('app-alarms-list').innerText.includes('Rings Saturday 6 February 2027 at 12:00')", 4000);
  const lists = (await posted(f, 'alarms.list')).length;
  // The app's re-plan after the change of zone, as SystemEventReceiver does it: no message to the page.
  await f.ev("window.__et.armed = [{ id: window.__et.records[0].id, fireAt: '2027-02-07T03:00:00Z' }]");
  await f.s('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' });
  await f.ev("document.dispatchEvent(new Event('visibilitychange'))");
  await f.waitFor(`window.__et.posted.filter((m) => m.type === 'alarms.list').length > ${lists}`, 5000);
  await f.waitFor("document.getElementById('app-alarms-list').innerText.includes('(UTC+9)')", 5000);
  await sleep(300);
  const text = await f.ev("document.getElementById('app-alarms-list').innerText");
  assert.match(text, /Rings Sunday 7 February 2027 at 12:00 \(UTC\+9\)\./, text);
  assert.doesNotMatch(text, /Rings Saturday 6 February 2027 at 20:00/, 'not the old armed instant in the new zone');
  assert.deepEqual(f.log.errors, []);
  await f.close();
});

await check('the whole page in app mode keeps the house style, with no error, violation or request after load', async () => {
  const n0 = p.log.requests.length;
  await p.click('#next-alarms');
  await p.waitFor("document.getElementById('planner').open");
  houseStyle(await p.ev('document.body.innerText'), 'app mode page');
  for (const [k, v] of Object.entries(T)) houseStyle(v, `bridge text ${k}`);
  houseStyle(group(/PROBLEMS: \{([\s\S]*?)\n {4}\}/, BRIDGE_TS).replace(/'[a-z-]+':/g, ''), 'problem texts');
  if (SHOTS) await p.viewShot(join(SHOTS, 'app-planner-1280.png'));
  await p.key('Escape');
  if (SHOTS) await p.shot(join(SHOTS, 'app-page-1280.png'));
  // Using the planner and the overview loads nothing (the browser's own data: icons apart).
  assert.deepEqual(p.log.requests.slice(n0).filter((r) => !r.url.startsWith('data:')).map((r) => r.url), []);
  assert.ok(p.log.requests.every((r) => r.url.startsWith(ORIGIN) || r.url.startsWith('data:')), 'every request in the whole session stayed in the app');
  assert.deepEqual(p.log.errors, []);
  assert.deepEqual(p.log.csp, []);
  assert.deepEqual(await p.ev('window.__csp'), []);
  assert.deepEqual(p.log.offsite, []);
  assert.equal(await p.ev('localStorage.length + sessionStorage.length'), 0);
  assert.equal(await p.ev("[...document.querySelectorAll('[aria-live]:not([aria-live=\"off\"]), [role=status]')].map((n) => n.id).sort().join(' ')"), 'app-alarms-status list-count planner-live');
});
await p.close();

// Fix C (S-2): the text enlarged as the app enlarges it (TextScale.kt: a larger default font size,
// textZoom 100), at 1.3, 1.5 and 2.0, on a 320 px screen and a common one (412 px): the title whole,
// no sideways scroll anywhere on the page, the overview and the planner inside the screen, every select
// whole. The footer's app carousel scrolls sideways by design and is left out of the page-wide look.
const overflowing = (w: number): string => `(() => { const out = []; for (const n of document.querySelectorAll('body *')) {
  if (n.closest('.app-switcher-track') || n.closest('dialog')) continue;
  const r = n.getBoundingClientRect(); if (!r.width || getComputedStyle(n).position === 'fixed') continue;
  if (r.right > ${w} + 0.5 || r.left < -0.5) out.push((n.id || n.className || n.tagName) + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); }
  return out.slice(0, 12); })()`;
for (const width of [320, 412]) {
  for (const scale of [1.3, 1.5, 2.0]) {
    await check(`${width} px with the app's text at ${scale}: the title whole, no sideways scroll, the overview and the planner fit, every select whole`, async () => {
      const m = await open('/app/', { width, height: 800 });
      await m.s('Page.setFontSizes', { fontSizes: appFontSizes(scale) });
      await sleep(200);
      assert.equal(await m.ev("parseFloat(getComputedStyle(document.documentElement).fontSize)"), appFontSizes(scale).standard, 'the root font size is the app\'s default font size');
      await m.ev("window.__et.records = [{ v: 1, id: '0123456789abcdef0123456789abcdef', eclipseId: '2027-02-06-solar', spec: { kind: 'before', minutes: 120 } }]; window.__et.send({ type: 'alarms', ok: true, records: window.__et.records, armed: [], problems: ['notifications-denied', 'exact-alarms-denied'] })");
      await m.waitFor("document.querySelectorAll('#app-alarms-list li').length === 1");
      await sleep(300);
      const title = await m.ev("(() => { const h = document.querySelector('h1'); const r = h.getBoundingClientRect(); return { sw: h.scrollWidth, cw: h.clientWidth, left: r.left, right: r.right }; })()");
      assert.ok(title.sw <= title.cw + 0.5 && title.left >= -0.5 && title.right <= width + 0.5, `the title is whole: ${J(title)}`);
      assert.deepEqual(await m.ev(overflowing(width)), [], 'nothing on the page reaches past the screen');
      assert.equal(await m.ev('document.documentElement.scrollWidth'), await m.ev('document.documentElement.clientWidth'), 'no sideways scroll');
      // C-4: the overview's own buttons are at least 48 px tall and wide.
      const small = await m.ev("[...document.querySelectorAll('#app-alarms button')].map((b) => b.getBoundingClientRect()).filter((r) => r.height < 47.5 || r.width < 47.5).length");
      assert.equal(small, 0, 'every overview button is at least 48 px');
      if (SHOTS) await m.viewShot(join(SHOTS, `app-overview-${width}-${scale}.png`));
      await m.click('#next-alarms');
      await m.waitFor("document.getElementById('planner').open");
      const wide = `[...document.querySelectorAll('#planner *')].filter((n) => n.getBoundingClientRect().right > ${width} + 0.5).map((n) => n.id || n.className || n.tagName)`;
      assert.deepEqual(await m.ev(wide), []);
      // Fix D (N-4): the app's two planner buttons are at least 48 px tall.
      assert.deepEqual(await m.ev("['app-set', 'app-calendar'].map((id) => document.getElementById(id).getBoundingClientRect().height >= 47.5)"), [true, true]);
      assert.deepEqual(await selectsCut(m), [], 'every select shows its chosen option whole (K-2)');
      assert.ok(await m.ev("document.getElementById('planner').scrollWidth <= document.getElementById('planner').clientWidth"));
      if (SHOTS) await m.viewShot(join(SHOTS, `app-planner-${width}-${scale}.png`));
      assert.deepEqual(m.log.errors, []);
      assert.deepEqual(m.log.csp, []);
      await m.close();
    });
  }
}

// Fix C (M-1): the disclaimer as the app serves it, its style element allowed by hash: readable in the
// dark and in the light colour scheme, with no policy violation; and the control, served as stage B
// served it (no hash), refused and unstyled, which is the fault the hash fixes.
const contrast = (fg: string, bg: string): number => {
  const lum = (c: string): number => { const [r = 0, g = 0, b = 0] = defined(c.match(/\d+(\.\d+)?/g), `a colour in ${c}`).slice(0, 3).map(Number).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const [a = 0, b = 0] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};
const DISCLAIMER_LOOK = "(() => { const b = getComputedStyle(document.body); const h2 = getComputedStyle(document.querySelector('h2')); return { fg: b.color, bg: b.backgroundColor, h2: h2.color, maxWidth: getComputedStyle(document.querySelector('main')).maxWidth }; })()";
await check("the disclaimer in the app: its own colours in the dark and the light scheme, no violation", async () => {
  const want = {
    dark: { fg: 'rgb(215, 221, 229)', bg: 'rgb(13, 17, 23)', h2: 'rgb(216, 163, 64)' },
    light: { fg: 'rgb(29, 36, 44)', bg: 'rgb(251, 250, 247)', h2: 'rgb(138, 100, 18)' },
  };
  for (const scheme of ['dark', 'light'] as const) {
    const d = await open('/app/disclaimer.html', { stub: false, width: 412, height: 800 });
    await d.s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await sleep(200);
    const look = await d.ev(DISCLAIMER_LOOK);
    assert.equal(look.fg, want[scheme].fg, `${scheme}: body text colour`);
    assert.equal(look.bg, want[scheme].bg, `${scheme}: background`);
    assert.equal(look.h2, want[scheme].h2, `${scheme}: headings in the accent colour`);
    assert.equal(look.maxWidth, '736px', `${scheme}: the main column is styled`);
    assert.ok(contrast(look.fg, look.bg) >= 7, `${scheme}: contrast ${contrast(look.fg, look.bg).toFixed(2)}`);
    assert.deepEqual(d.log.csp, [], `${scheme}: no policy violation`);
    assert.deepEqual(await d.ev('window.__csp'), []);
    // The disclaimer names no icon, so the browser asks for /favicon.ico on its own (the app's WebView too);
    // that one 404 apart, no error.
    assert.ok(d.log.requests.some((r) => r.url === `${ORIGIN}/favicon.ico`) || d.log.errors.length === 0);
    assert.deepEqual(d.log.errors.filter((e) => !/status of 404/.test(e)), []);
    assert.ok(d.log.errors.length <= 1);
    if (SHOTS) await d.viewShot(join(SHOTS, `app-disclaimer-${scheme}.png`));
    await d.close();
  }
  const c = await open('/nohash/disclaimer.html', { stub: false, width: 412, height: 800 });
  await c.s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(200);
  const bare = await c.ev(DISCLAIMER_LOOK);
  assert.ok(c.log.csp.length >= 1 || (await c.ev('window.__csp')).length >= 1, 'the control: the style element is refused without the hash');
  assert.equal(bare.fg, 'rgb(0, 0, 0)', 'the control: unstyled black text, which on the app window\'s near-black background is unreadable');
  await c.close();
});

await check('fix B, A-9: Change works for an alarm kept after greatest eclipse; the calendar file still says the eclipse has passed', async () => {
  // 21 February 2027 at 04:00 in Oslo: the penumbral lunar eclipse was at 00:13; its noon alarm is still to ring.
  const m = await open('/app/', { now: Date.parse('2027-02-21T03:00:00Z') });
  const id = 'fedcba9876543210fedcba9876543210';
  await m.ev(`window.__et.records = [{ v: 1, id: ${J(id)}, eclipseId: '2027-02-20-lunar', spec: { kind: 'day', daysBefore: 0, time: '12:00' } }]; window.__et.armed = [{ id: ${J(id)}, fireAt: '2027-02-21T11:00:00Z' }]; window.__et.send({ type: 'alarms', ok: true, records: window.__et.records, armed: window.__et.armed, problems: [] })`);
  await m.waitFor("document.querySelectorAll('#app-alarms-list li').length === 1");
  assert.match(await m.ev("document.getElementById('app-alarms-list').innerText"), /Rings Sunday 21 February 2027 at 12:00 \(UTC\+1\)\./);
  await m.ev("document.querySelector('#app-alarms-list li button').click()");
  await m.waitFor("document.getElementById('planner').open && document.querySelectorAll('.alarm-row').length === 1", 4000);
  assert.match(await m.ev("document.getElementById('planner-title').textContent"), /penumbral lunar eclipse/);
  assert.match(await m.ev("document.querySelector('.alarm-result').textContent"), /^Rings Sunday 21 February 2027 at 12:00/);
  // Changed to 18:00 and set: the same record, a new time.
  await setTime(m, "document.querySelector('.alarm-time')", '18:00');
  await m.click('#app-set');
  await m.waitFor(`document.getElementById('planner-status').textContent === ${J(T.SET_ONE)}`, 4000);
  const set = (await m.ev("window.__et.posted.filter((x) => x.type === 'alarms.set')")).at(-1);
  assert.equal(set.eclipseId, '2027-02-20-lunar');
  assert.deepEqual(set.records.map((r: FromBrowser) => [r.id, r.spec]), [[id, { kind: 'day', daysBefore: 0, time: '18:00' }]]);
  // An alarm already passed is left out, as from the file; the eclipse's file is still refused.
  await m.ev("document.getElementById('add-alarm').click()");
  await setSelect(m, "document.querySelectorAll('.alarm-choice')[1]", 'before');
  await m.click('#app-set');
  await m.waitFor(`document.getElementById('planner-status').textContent === ${J(T.SET_ONE)}`, 4000);
  assert.equal((await m.ev("window.__et.posted.filter((x) => x.type === 'alarms.set')")).at(-1).records.length, 1);
  const files = (await m.ev("window.__et.posted.filter((x) => x.type === 'calendar.save' || x.type === 'calendar.add')")).length;
  await m.click('#save-ics');
  await m.waitFor("document.getElementById('planner-status').textContent === 'This eclipse has passed, so there is nothing to save.'", 4000);
  await m.click('#app-calendar');
  await sleep(200);
  assert.equal(await m.ev("document.getElementById('planner-status').textContent"), 'This eclipse has passed, so there is nothing to save.');
  assert.equal((await m.ev("window.__et.posted.filter((x) => x.type === 'calendar.save' || x.type === 'calendar.add')")).length, files, 'no file for a passed eclipse');
  await m.key('Escape');
  // Once the records have gone (48 hours after greatest eclipse) Change opens nothing.
  await m.ev(`(() => { const off = ${Date.parse('2027-02-23T00:00:00Z')} - Date.now(); const was = Date.now; Date.now = () => was() + off; })()`);
  await m.ev("document.querySelector('#app-alarms-list li button')?.click()");
  await sleep(300);
  assert.equal(await m.ev("document.getElementById('planner').open"), false);
  assert.deepEqual(m.log.errors, []);
  assert.deepEqual(m.log.csp, []);
  await m.close();
});

await check('the Google Play edition: Add to calendar after Save, nothing about ringing alarms, no alarm message', async () => {
  const g = await open('/play/');
  await g.waitFor("document.documentElement.dataset.ready === 'true'");
  assert.deepEqual(await g.ev('window.__et.posted[0]'), { type: 'hello', v: 1 });
  assert.equal(await g.ev("document.querySelector('script[src=\"android-bridge.js\"]').dataset.edition"), 'play', 'the page carries the Play line');
  assert.equal(await g.ev("typeof window.EclipseTrackerApp.saveFile"), 'function', 'the bridge is there');
  assert.equal(await g.ev("Object.isFrozen(window.EclipseTrackerApp)"), true);
  assert.equal(await g.ev("'travelNote' in window.EclipseTrackerApp"), false, 'no app travel note');
  assert.equal(await g.ev("!!document.getElementById('app-alarms') || !!document.getElementById('app-set') || !!document.getElementById('app-problems')"), false, 'no ringing alarms, no overview');
  await g.click('#next-alarms');
  await g.waitFor("document.getElementById('planner').open");
  const order = await g.ev("[...document.querySelectorAll('.planner-actions button')].map((b) => [b.id, b.className, b.textContent])");
  assert.deepEqual(order, [
    ['save-ics', 'btn btn-primary', 'Save the calendar file'],
    ['app-calendar', 'btn btn-secondary', T.ADD],
    ['close-planner', 'btn btn-secondary', 'Close'],
  ]);
  assert.equal(await g.ev("document.getElementById('app-calendar').getBoundingClientRect().height >= 47.5"), true, 'Add to calendar is 48 px tall (fix D, N-4)');
  assert.match(await g.ev("document.getElementById('planner-zone').textContent"), new RegExp(WEB_TRAVEL.replace(/[.()]/g, '\\$&')), "the website's travel sentences");
  assert.equal(await g.ev(`document.body.innerText.includes(${J(A4)})`), false, "no app travel note");
  const playNote = await g.ev("document.querySelector('.planner-note').textContent");
  assert.ok(playNote.endsWith(T.PLAY_KEEPS) && !playNote.includes('keeps nothing'), `the Play closing note says the app keeps the last calendar file: ${playNote}`);
  assert.ok(playNote.startsWith('Open the saved file with your calendar app'), 'the rest of the note is the approved text');
  assert.equal(await g.ev("document.querySelectorAll('.alarm-row').length"), 1, 'the planner opens with the default alarm, as on the website');
  // Add to calendar and Save work as in the sovereign edition.
  await g.click('#app-calendar');
  await waitStatus(g, T.CAL_OPENED);
  const add = (await posted(g, 'calendar.add')).at(-1);
  assert.equal(add.fileName, 'eclipse-2027-02-06-solar.ics');
  assert.ok(add.ics.startsWith('BEGIN:VCALENDAR\r\n') && add.ics.endsWith('END:VCALENDAR\r\n'));
  await g.click('#save-ics');
  await waitStatus(g, 'Saved eclipse-2027-02-06-solar.ics with 1 alarm. Open it with your calendar app.');
  assert.equal((await posted(g, 'calendar.save')).at(-1).fileName, 'eclipse-2027-02-06-solar.ics');
  assert.deepEqual(g.log.downloads, [], 'no download in the app');
  // Back closes the planner, as in the sovereign edition.
  await g.ev("window.__et.send({ type: 'back', q: 1 })");
  await g.waitFor("!document.getElementById('planner').open");
  await g.waitFor("window.__et.posted.some((m) => m.type === 'back.result' && m.q === 1)");
  assert.deepEqual((await posted(g, 'back.result')).at(-1), { type: 'back.result', q: 1, handled: true, v: 1 });
  // Alarm news from the app (which the Play app never sends) draws nothing, and nothing asks for alarms.
  await g.ev("window.__et.send({ type: 'alarms', ok: true, records: [], armed: [], problems: ['notifications-denied'] })");
  await g.ev("document.dispatchEvent(new Event('visibilitychange'))");
  await sleep(1500);
  assert.equal(await g.ev("!!document.getElementById('app-alarms') || !!document.getElementById('app-problems')"), false);
  const types = [...new Set((await g.ev('window.__et.posted.map((m) => m.type)')) as string[])].sort();
  assert.deepEqual(types, ['back.result', 'calendar.add', 'calendar.save', 'hello'], 'no alarms.list, alarms.set or problem.fix');
  const text = await g.ev('document.body.innerText');
  for (const w of [T.SET, T.HEADING, T.KEEPS, 'ringing alarm']) assert.ok(!text.toLowerCase().includes(w.toLowerCase()), `the Play page does not say ${w}`);
  houseStyle(text, 'Play edition page');
  if (SHOTS) await g.shot(join(SHOTS, 'play-page-1280.png'));
  assert.deepEqual(g.log.errors, []);
  assert.deepEqual(g.log.csp, []);
  assert.deepEqual(await g.ev('window.__csp'), []);
  assert.deepEqual(g.log.offsite, []);
  assert.equal(await g.ev('localStorage.length + sessionStorage.length'), 0);
  await g.close();
});

await check('the website, and the APK files on a WebView too old for the channel, show none of the app parts', async () => {
  for (const [path, stub] of [['/web/', true], ['/app/', false]] as const) {
    const w = await open(path, { stub });
    assert.equal(await w.ev("typeof window.EclipseTrackerApp"), 'undefined');
    assert.equal(await w.ev("!!document.getElementById('app-alarms') || !!document.getElementById('app-set')"), false);
    await w.click('#next-alarms');
    await w.waitFor("document.getElementById('planner').open");
    assert.match(await w.ev("document.getElementById('planner-zone').textContent"), new RegExp(WEB_TRAVEL.replace(/[.()]/g, '\\$&')));
    assert.equal(await w.ev("document.getElementById('save-ics').className"), 'btn btn-primary');
    assert.match(await w.ev("document.querySelector('.planner-note').textContent"), /EclipseTracker sends nothing and keeps nothing\.$/);
    if (path === '/web/') assert.deepEqual(await w.ev('window.__et.posted'), [], 'the website never posts to a bridge');
    assert.deepEqual(w.log.errors, []);
    assert.deepEqual(w.log.csp, []);
    await w.close();
  }
});

console.log(`app-mode smoke: ${passed} checks passed`);
await cleanup();
