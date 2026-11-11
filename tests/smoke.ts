// The browser smoke test (spec section 12): the page as production serves it (tests/serve.py, with
// the zone's Content-Security-Policy and the _config.yml exclusions), in headless Chromium.
//
//   node tests/smoke.ts [--chromium /usr/bin/chromium] [--shots DIR]
//
// Every page runs on a frozen clock: Date.now starts at NOW (16 October 2026, 10:30 UTC) and runs on
// from there, so the results never depend on the day the test runs (code review C-6). Some checks
// move the clock to just before an eclipse, or past the last one.
//
// Checks: no request leaves the origin and no request at all after load; no console error or
// policy violation, under the page's own strict policy (code review C-5) as well as the zone's
// header; the icons and fonts still load; the sources and tooling are not served (fetched from
// Node: the page itself may not connect anywhere); the countdown changes once a second, not every
// frame; the list, the year groups and the filters; the planner end to end with the keyboard and
// the mouse (four alarms, the times it shows, a duplicate, removing one, a cleared time, the
// three-alarm note, Escape returning focus); one live region in the planner and no announcement per
// tick; the saved calendar file byte for byte equal to core/ics.js's output for the same inputs, with
// only duration triggers; the moment an eclipse passes, with the planner open and with focus in the
// list; the end of the list after 2100; a southern zone; no sideways scroll at 1280, 390 and 320 px,
// with text at 100% and 200%, in the dark theme, the planner open and closed, every select showing
// every option whole (K-2); and the page text in
// the house style; and the city filter (11 November 2026): the catalogue is requested only when the
// chooser is used, Bergen picked by keyboard, kept in localStorage and restored without the
// catalogue, cleared, storage that throws, a catalogue that does not load, a city in another zone,
// the planner and the saved file for a city, 400 px with 200% text, Escape and Tab in the list.
// Prints one line per check and exits 1 on the first failure.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { launchChromium, openPage, selectsCut, sleep } from './cdp.ts';
import type { FromBrowser, Page, PageOptions } from './cdp.ts';
import { planAlarms } from '#core/alarms.js';
import { ECLIPSES, eclipseById } from '#core/eclipses.js';
import { localName, localWhen, minuteOf } from '#core/format.js';
import { buildIcs } from '#core/ics.js';
import { localAll } from '#core/local.js';
import { localDateTime } from '#core/zoned.js';
import type { AlarmSpec } from '#core/types.js';
import { defined, group } from './helpers.ts';

const arg = <T extends string | null>(name: string, dflt: T): string | T => {
  // (process.argv[i + 1] may be missing: the default then, as before.)
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] ?? dflt) : dflt;
};
const chromium = arg('--chromium', '/usr/bin/chromium');
const shots = arg('--shots', null);
const work = mkdtempSync(join(tmpdir(), 'eclipse-smoke-'));
/** The frozen clock: the page's Date.now starts here and runs on in real time. */
const NOW = Date.parse('2026-10-16T10:30:00Z');
const clockAt = (t: number): string => `(() => { const real = Date.now.bind(Date); const off = ${t} - real(); Date.now = () => real() + off; })();`;
/** Opens a page with the clock frozen at `at` (NOW unless given). */
const open = (opts: PageOptions = {}, at = NOW): Promise<Page> => openPage(browser, base, { timezone: 'Europe/Oslo', ...opts, init: clockAt(at) });
/** The countdown's digits as one string, 112:05:29:31. */
const digits = (p: Page): Promise<string> => p.ev("[...document.querySelectorAll('#countdown-timer .cd-num')].map((n) => n.textContent).join(':')");
/** Every element that is a live region (polite or assertive), by id or class. */
const LIVE = "[...document.querySelectorAll('[aria-live]:not([aria-live=\"off\"]), [role=status], [role=alert], [role=log]')].map((n) => n.id || n.className)";
/** Starts recording every change inside a live region; the list comes back from takeLive(). */
const watchLive = (p: Page): Promise<void> => p.ev(`(() => {
  window.__live = [];
  window.__liveMo?.disconnect();
  window.__liveMo = new MutationObserver((ms) => { for (const m of ms) { const t = m.target.nodeType === 1 ? m.target : m.target.parentElement; const n = t && t.closest('[aria-live]:not([aria-live="off"]), [role=status], [role=alert], [role=log]'); if (n) window.__live.push((n.id || n.className) + ': ' + n.textContent); } });
  window.__liveMo.observe(document.body, { childList: true, subtree: true, characterData: true });
})()`);
const takeLive = (p: Page): Promise<string[]> => p.ev('window.__live.splice(0)');
if (shots) mkdirSync(shots, { recursive: true });
const J = JSON.stringify;

let passed = 0;
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

const server = spawn('python3', ['-I', new URL('./serve.py', import.meta.url).pathname, '--quiet'], { stdio: ['ignore', 'pipe', 'inherit'] });
const base = await new Promise<string>((res, rej) => {
  const t = setTimeout(() => rej(new Error('serve.py did not start')), 15000);
  server.stdout.on('data', (d) => {
    const m = /READY (\S+)/.exec(String(d));
    if (m && m[1]) { clearTimeout(t); res(m[1]); }
  });
});
const browser = await launchChromium({ chromium, out: join(work, 'chromium') });
async function cleanup(): Promise<void> {
  await browser.close().catch(() => {});
  server.kill();
  rmSync(work, { recursive: true, force: true });
}

const setSelect = (p: Page, selector: string, value: string): Promise<void> => p.ev(`(() => { const s = ${selector}; s.focus(); s.value = ${J(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const setTime = (p: Page, selector: string, value: string): Promise<void> => p.ev(`(() => { const t = ${selector}; t.focus(); t.value = ${J(value)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const results = (p: Page): Promise<string[]> => p.ev("[...document.querySelectorAll('#alarm-rows .alarm-result')].map((n) => n.textContent)");
const houseStyle = (text: string, where: string): void => {
  assert.doesNotMatch(text, /[–—]/, `${where}: no en or em dash`);
  assert.doesNotMatch(text, /--/, `${where}: no double hyphen`);
  assert.doesNotMatch(text, /!/, `${where}: no exclamation mark`);
};

// ---- Desktop, Europe/Oslo ---------------------------------------------------------------------
const downloads = join(work, 'downloads');
mkdirSync(downloads, { recursive: true });
const p = await open({ width: 1280, height: 900, downloads });

await check('the page loads with no error, no policy violation and no request off the origin', async () => {
  assert.equal(await p.ev("document.documentElement.dataset.ready"), 'true');
  assert.equal(await p.ev("document.documentElement.dataset.eclipses"), '337');
  assert.deepEqual(p.log.errors, []);
  assert.deepEqual(p.log.csp, []);
  assert.deepEqual(await p.ev('window.__csp'), []);
  assert.deepEqual(p.log.offsite, []);
  const kinds = new Set(p.log.requests.map((r) => new URL(r.url).pathname.split('?')[0] ?? ''));
  assert.ok(kinds.has('/app.js') && kinds.has('/core/alarms.js') && kinds.has('/core/data.js'), 'the modules load');
  assert.ok(![...kinds].some((k) => k.startsWith('/ts/') || k.startsWith('/tools/')), 'no source is requested');
});

await check("the page's own policy is in force and the icons and fonts still load under it", async () => {
  assert.match(await p.ev("document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]').content"), /connect-src 'none'/);
  // The policy refuses a connection: the page could not send anything even if it tried.
  const refused = await p.ev("fetch('/data/eclipses.json').then(() => 'fetched', () => 'refused')");
  assert.equal(refused, 'refused');
  const violations = await p.ev('window.__csp.splice(0)');
  assert.deepEqual(violations, ['connect-src ' + base + 'data/eclipses.json'], 'that refusal is the only violation, and it is this check\'s own');
  p.log.csp.splice(0);
  p.log.errors.splice(0);
  const icons = await p.ev("[...document.querySelectorAll('.switcher-card img, .logo-icon')].map((i) => i.complete && i.naturalWidth > 0)");
  assert.ok(icons.length >= 20 && icons.every(Boolean), 'every icon loaded');
  assert.equal(await p.ev("document.fonts.check('16px InterVariable')"), true);
  assert.equal(await p.ev("[...document.fonts].some((f) => f.family === 'InterVariable' && f.status === 'loaded')"), true);
  const statuses = p.log.requests.filter((r) => /\.(woff2|svg|css|js)(\?|$)/.test(r.url)).length;
  assert.ok(statuses > 25);
});

await check('the countdown shows the next eclipse and changes once a second, not every frame', async () => {
  assert.equal(await p.ev("document.getElementById('eclipse-type').textContent"), 'Annular solar eclipse');
  assert.equal(await p.ev("document.getElementById('eclipse-date').textContent"), 'Saturday 6 February 2027 at 17:00 (UTC+1)');
  await watchLive(p);
  const changes = await p.ev(`new Promise((res) => {
    let n = 0;
    const mo = new MutationObserver(() => { n += 1; });
    mo.observe(document.getElementById('cd-seconds'), { childList: true, characterData: true, subtree: true });
    setTimeout(() => { mo.disconnect(); res(n); }, 3200);
  })`);
  assert.ok(changes >= 2 && changes <= 5, `the seconds changed ${changes} times in 3.2 s`);
  assert.deepEqual(await takeLive(p), [], 'nothing is announced while it counts');
  // The frozen clock: 16 October 2026 10:30 UTC is 113 days, 5 hours, 29 minutes and some seconds before 16:00 UTC on 6 February 2027.
  assert.match(await digits(p), /^113:05:2[89]:\d{2}$/);
  assert.match(await p.ev("document.getElementById('countdown-words').textContent"), /^Greatest eclipse in 113 days, 5 hours and 2[89] minutes\.$/);
  assert.equal(await p.ev("document.getElementById('countdown-timer').getAttribute('role')"), 'timer');
  assert.deepEqual(await p.ev("[...document.querySelectorAll('#countdown-timer .cd-group')].map((g) => [g.children[0].className, g.children[1].textContent, g.children[1].getAttribute('aria-hidden')])"),
    [['cd-num', 'Days', 'true'], ['cd-num', 'Hrs', 'true'], ['cd-num', 'Min', 'true'], ['cd-num', 'Sec', 'true']], 'each number has its label under it');
});

await check('no request after load (the page is quiet while it counts down)', async () => {
  const before = p.log.requests.length;
  await sleep(1500);
  assert.equal(p.log.requests.length, before);
});

await check('the list: 74 year groups, the first open, a group fills when opened', async () => {
  assert.equal(await p.ev("document.getElementById('list-count').textContent"), '337 eclipses in 74 years.');
  assert.equal(await p.ev("document.querySelectorAll('.year-group').length"), 74);
  assert.equal(await p.ev("document.querySelectorAll('.year-group[open]').length"), 1);
  assert.equal(await p.ev("document.querySelectorAll('.eclipse-item').length"), 5, 'only 2027 is built at first');
  await p.click('.year-group:last-of-type > summary');
  assert.equal(await p.ev("document.querySelector('.year-group:last-of-type').open"), true);
  assert.equal(await p.ev("document.querySelector('.year-group:last-of-type').querySelectorAll('.eclipse-item').length"), 4);
  assert.match(await p.ev("document.querySelector('.year-group:last-of-type .eclipse-name').textContent"), /eclipse$/);
});

await check('the filters: lunar only, then penumbral, then back', async () => {
  await setSelect(p, "document.getElementById('filter-kind')", 'lunar');
  assert.equal(await p.ev("document.getElementById('list-count').textContent"), 'Showing 169 of 337 eclipses, in 74 years.');
  assert.deepEqual(await p.ev("[...document.getElementById('filter-type').options].map((o) => o.textContent)"), ['Any type', 'Total', 'Partial', 'Penumbral']);
  await setSelect(p, "document.getElementById('filter-type')", 'penumbral');
  const text = await p.ev("document.getElementById('list-count').textContent");
  assert.match(text, /^Showing \d+ of 337 eclipses, in \d+ years\.$/);
  assert.ok(await p.ev("[...document.querySelectorAll('.eclipse-item')].every((li) => li.querySelector('.eclipse-name').textContent === 'Penumbral lunar eclipse')"));
  await setSelect(p, "document.getElementById('filter-kind')", 'solar');
  assert.equal(await p.ev("document.getElementById('filter-type').value"), 'all', 'penumbral does not apply to solar eclipses');
  await setSelect(p, "document.getElementById('filter-kind')", 'all');
  assert.equal(await p.ev("document.getElementById('list-count').textContent"), '337 eclipses in 74 years.');
});

const SPECS: AlarmSpec[] = [
  { kind: 'day', daysBefore: 0, time: '12:00' },
  { kind: 'day', daysBefore: 1, time: '12:00' },
  { kind: 'before', minutes: 30 },
  { kind: 'day', daysBefore: 7, time: '08:30' },
];

await check('the planner opens from the list with the default alarm, focus inside', async () => {
  await p.click('.year-group[open] .btn-alarm');
  assert.equal(await p.ev("document.getElementById('planner').open"), true);
  assert.equal(await p.ev("document.activeElement.className"), 'alarm-choice');
  assert.equal(await p.ev("document.getElementById('planner-title').textContent"), 'Alarms for the annular solar eclipse');
  assert.equal(await p.ev("document.getElementById('planner-when').textContent"), 'Greatest eclipse: Saturday 6 February 2027 at 17:00 (UTC+1), which is 16:00 UTC.');
  assert.match(await p.ev("document.getElementById('planner-zone').textContent"), /Europe\/Oslo/);
  assert.equal(await p.ev("document.querySelector('.alarm-choice').value"), 'day-0');
  assert.equal(await p.ev("document.querySelector('.alarm-time').value"), '12:00');
  assert.deepEqual(await results(p), ['Rings Saturday 6 February 2027 at 12:00 (UTC+1).']);
  // The dialog's description is the greatest-eclipse line and the time-zone line (code review C-21).
  assert.equal(await p.ev("document.getElementById('planner').getAttribute('aria-describedby')"), 'planner-when planner-zone');
  assert.equal(await p.ev("document.getElementById('planner-three').hidden"), true);
});

await check('one live region in the planner; each result line is its controls\' description and is read out only when that alarm changes', async () => {
  const live = await p.ev(LIVE);
  // The city chooser's status line (11 November 2026) is the third live region on the page; it is quiet until the chooser is used.
  assert.deepEqual(live, ['city-status', 'list-count', 'planner-live'], 'the chooser\'s status line, the list count, and one in the planner');
  assert.equal(await p.ev("document.querySelectorAll('#planner [aria-live], #planner [role=status]').length"), 1);
  assert.equal(await p.ev("document.querySelector('.alarm-result').getAttribute('aria-live')"), null);
  assert.deepEqual(await p.ev("[...document.querySelectorAll('#alarm-rows .alarm-row:first-child select, #alarm-rows .alarm-row:first-child input')].map((n) => n.getAttribute('aria-describedby'))"),
    ['alarm-result-1', 'alarm-result-1', 'alarm-result-1']);
  await watchLive(p);
  await sleep(2200);
  assert.deepEqual(await takeLive(p), [], 'nothing is read out while the planner is open and nobody types');
  await setTime(p, "document.querySelector('.alarm-time')", '12:30');
  await sleep(150);
  assert.equal(await p.ev("document.getElementById('planner-live').textContent"), 'Rings Saturday 6 February 2027 at 12:30 (UTC+1).');
  // The same time again changes nothing, so nothing is written or read out.
  await takeLive(p);
  await setTime(p, "document.querySelector('.alarm-time')", '12:30');
  await sleep(150);
  assert.deepEqual(await takeLive(p), []);
  await setTime(p, "document.querySelector('.alarm-time')", '12:00');
  await sleep(150);
});

await check('a cleared time, then another option: the field shows the time the alarm uses (code review C-4)', async () => {
  await setTime(p, "document.querySelector('.alarm-time')", '');
  assert.equal(await p.ev("document.querySelector('.alarm-time').getAttribute('aria-invalid')"), 'true', 'an empty time is marked invalid (code review C-21)');
  await setSelect(p, "document.querySelector('.alarm-choice')", 'day-1');
  assert.equal(await p.ev("document.querySelector('.alarm-time').value"), '12:00');
  assert.equal(await p.ev("document.querySelector('.alarm-time').getAttribute('aria-invalid')"), null);
  assert.deepEqual(await results(p), ['Rings Friday 5 February 2027 at 12:00 (UTC+1).']);
  await setSelect(p, "document.querySelector('.alarm-choice')", 'day-0');
  assert.deepEqual(await results(p), ['Rings Saturday 6 February 2027 at 12:00 (UTC+1).']);
});

await check('several alarms: add three, choose each, see the times', async () => {
  for (let i = 0; i < 3; i++) await p.click('#add-alarm');
  assert.equal(await p.ev("document.querySelectorAll('#alarm-rows .alarm-row').length"), 4);
  assert.deepEqual(await p.ev("[...document.querySelectorAll('.alarm-choice')].map((c) => c.value)"), ['day-0', 'day-1', 'before', 'day-7'], 'new alarms start as different options');
  assert.equal(await p.ev("document.activeElement === document.querySelectorAll('.alarm-choice')[3]"), true, 'focus moves to the new alarm');
  await setSelect(p, "document.querySelectorAll('.alarm-choice')[1]", 'day-1');
  await setSelect(p, "document.querySelectorAll('.alarm-choice')[2]", 'before');
  assert.equal(await p.ev("document.querySelectorAll('.alarm-time-field')[2].hidden"), true);
  assert.equal(await p.ev("document.querySelectorAll('.alarm-minutes-field')[2].hidden"), false);
  await setSelect(p, "document.querySelectorAll('.alarm-minutes')[2]", '30');
  await setSelect(p, "document.querySelectorAll('.alarm-choice')[3]", 'day-7');
  await setTime(p, "document.querySelectorAll('.alarm-time')[3]", '08:30');
  assert.deepEqual(await results(p), [
    'Rings Saturday 6 February 2027 at 12:00 (UTC+1).',
    'Rings Friday 5 February 2027 at 12:00 (UTC+1).',
    'Rings Saturday 6 February 2027 at 16:30 (UTC+1).',
    'Rings Saturday 30 January 2027 at 08:30 (UTC+1).',
  ]);
  // Four alarms go in the file: the note about calendars that keep three shows, and Save says so to a screen reader.
  assert.equal(await p.ev("document.getElementById('planner-three').hidden"), false);
  assert.equal(await p.ev("document.getElementById('planner-three').textContent"), 'Some calendar apps keep only the first three alarms.');
  assert.equal(await p.ev("document.getElementById('save-ics').getAttribute('aria-describedby')"), 'planner-three');
});

await check('a fifth alarm that repeats the first is flagged, then removed', async () => {
  await p.click('#add-alarm');
  // A new alarm takes the time of day last typed (08:30), so on the day at 08:30 is not a copy yet.
  assert.equal(await p.ev("document.querySelectorAll('.alarm-choice')[4].value"), 'day-0');
  assert.equal(await p.ev("document.querySelectorAll('.alarm-time')[4].value"), '08:30');
  assert.equal((await results(p))[4], 'Rings Saturday 6 February 2027 at 08:30 (UTC+1).');
  await setTime(p, "document.querySelectorAll('.alarm-time')[4]", '12:00');
  assert.equal((await results(p))[4], 'This rings at the same moment as alarm 1, so it is left out of the file.');
  await p.click('#alarm-rows .alarm-row:nth-child(5) .btn-remove');
  assert.equal(await p.ev("document.querySelectorAll('#alarm-rows .alarm-row').length"), 4);
  assert.equal(await p.ev("document.getElementById('planner-status').textContent"), 'Alarm 5 removed.');
  await sleep(150);
  assert.equal(await p.ev("document.getElementById('planner-live').textContent"), 'Alarm 5 removed.', 'and read out once, in the live region');
  assert.equal(await p.ev("document.activeElement.className"), 'alarm-choice', 'focus stays in the planner');
});

await check('an empty time stops the save and says which alarm', async () => {
  await setTime(p, "document.querySelectorAll('.alarm-time')[0]", '');
  assert.equal((await results(p))[0], 'Choose a time for this alarm.');
  await p.click('#save-ics');
  assert.equal(await p.ev("document.getElementById('planner-status').textContent"), 'Alarm 1 needs a time.');
  assert.equal(p.log.downloads.length, 0);
  await setTime(p, "document.querySelectorAll('.alarm-time')[0]", '12:00');
});

await check('the saved calendar file is byte for byte what core/ics.js makes from the same inputs', async () => {
  await p.click('#save-ics');
  let done: FromBrowser = null;
  for (let i = 0; i < 100 && !done; i++) {
    done = p.log.downloads.find((d) => d.state === 'completed');
    if (!done) await sleep(50);
  }
  assert.ok(done, 'the download completed');
  assert.equal(p.log.downloads.find((d) => d.begin)?.begin, 'eclipse-2027-02-06-solar.ics');
  const files = readdirSync(downloads);
  assert.equal(files.length, 1);
  const saved = readFileSync(join(downloads, defined(files[0], 'the saved file')), 'utf8');
  const uid = group(/UID:([0-9a-f]{32})@eclipse\.stormberry\.as/, saved);
  const stamp = group(/DTSTAMP:(\d{8}T\d{6}Z)/, saved);
  const dtstamp = Date.parse(stamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
  const e = defined(eclipseById('2027-02-06-solar'), 'the 2027-02-06 solar eclipse');
  // The page's dtstamp has milliseconds the file drops; planning only compares against it, and all four alarms are months away.
  const want = buildIcs({ eclipse: e, alarms: planAlarms(e, SPECS, 'Europe/Oslo', dtstamp), uid, dtstamp });
  assert.equal(saved, want);
  assert.equal((saved.match(/BEGIN:VALARM/g) || []).length, 4);
  // Every trigger is a duration from the start; none is an absolute time (data review D-1).
  assert.deepEqual(saved.split('\r\n').filter((l) => l.startsWith('TRIGGER')), ['TRIGGER:-P7DT8H30M', 'TRIGGER:-P1DT5H', 'TRIGGER:-PT5H', 'TRIGGER:-PT30M']);
  assert.equal(await p.ev("document.getElementById('planner-status').textContent"), 'Saved eclipse-2027-02-06-solar.ics with 4 alarms. Open it with your calendar app.');
  assert.deepEqual(p.log.offsite, []);
});

await check('Escape closes the planner and focus returns to the button that opened it', async () => {
  await p.key('Escape');
  assert.equal(await p.ev("document.getElementById('planner').open"), false);
  assert.equal(await p.ev("document.activeElement.classList.contains('btn-alarm')"), true);
});

await check('keyboard only: Tab reaches the next-eclipse button, Enter opens the planner, Escape closes it', async () => {
  await p.ev("document.getElementById('next-alarms').focus()");
  await p.key('Enter');
  assert.equal(await p.ev("document.getElementById('planner').open"), true);
  await p.key('Tab');
  assert.equal(await p.ev("document.activeElement.className"), 'alarm-time');
  await p.key('Escape');
  assert.equal(await p.ev("document.activeElement.id"), 'next-alarms');
});

await check('the sources, tooling and tests are not served; the app and the data are', async () => {
  // Fetched from Node, not the page: the page's own policy lets it connect nowhere.
  const paths = ['/ts/app.ts', '/ts/core/alarms.ts', '/tools/build-ts.sh', '/tools/nasa/FETCHLOG.tsv', '/tools/vectors/build-vectors.py', '/tests/smoke.ts', '/tests/tsconfig.json', '/tests/dst-vectors.json',
    '/package.json', '/package-lock.json', '/tsconfig.json', '/tsconfig.core.json', '/node_modules/typescript/package.json', '/bump_assets.py', '/README.md',
    '/ts/app-host.d.ts', '/android/web-overlay/android-bridge.ts', '/android/web-overlay/android-bridge.js',
    '/app.js', '/core/ics.js', '/data/eclipses.json', '/disclaimer.html'];
  const status = await Promise.all(paths.map((u) => fetch(new URL(u, base)).then((r) => r.status)));
  assert.deepEqual(status, [...Array(18).fill(404), 200, 200, 200, 200]);
});

await check('the page text keeps the house style, the planner included', async () => {
  await p.ev("document.querySelectorAll('.year-group').forEach((d) => { d.open = true; })");
  await sleep(200);
  houseStyle(await p.ev('document.body.innerText'), 'page');
  await p.click('#next-alarms');
  houseStyle(await p.ev("document.getElementById('planner').innerText"), 'planner');
  await p.key('Escape');
  assert.equal(await p.ev("document.querySelectorAll('.eclipse-item').length"), 337);
  assert.deepEqual(p.log.errors, []);
});
await check('clock changes in Oslo: a time that does not exist, and one that happens twice, are explained', async () => {
  // 2033-03-30: 3 days before is 27 March 2033, when 02:00 becomes 03:00.
  await p.click('.year-group:nth-child(7) .eclipse-item:nth-child(1) .btn-alarm');
  assert.equal(await p.ev("document.getElementById('planner-title').textContent"), 'Alarms for the total solar eclipse');
  await setSelect(p, "document.querySelector('.alarm-choice')", 'day-3');
  await setTime(p, "document.querySelector('.alarm-time')", '02:30');
  assert.deepEqual(await results(p), ['Rings Sunday 27 March 2033 at 03:30 (UTC+2). The clocks go forward that night and 02:30 does not exist, so it rings at 03:30.']);
  await p.key('Escape');
  // 2032-11-03: 3 days before is 31 October 2032, when 03:00 becomes 02:00.
  await p.click('.year-group:nth-child(6) .eclipse-item:nth-child(4) .btn-alarm');
  assert.match(await p.ev("document.getElementById('planner-when').textContent"), /3 November 2032/);
  await setSelect(p, "document.querySelector('.alarm-choice')", 'day-3');
  await setTime(p, "document.querySelector('.alarm-time')", '02:30');
  assert.deepEqual(await results(p), ['Rings Sunday 31 October 2032 at 02:30 (UTC+2). The clocks go back that night and 02:30 happens twice; it rings the first time.']);
  houseStyle(await p.ev("document.getElementById('planner').innerText"), 'planner');
  await p.key('Escape');
});
if (shots) await p.shot(join(shots, 'desktop-1280.png'));
await p.close();

// ---- A southern zone ----------------------------------------------------------------------------
await check('Australia/Sydney: the day is the local day, and an alarm after greatest eclipse says so', async () => {
  const s = await open({ width: 1280, height: 900, timezone: 'Australia/Sydney' });
  await s.click('.year-group[open] .eclipse-item:nth-child(3) .btn-alarm');
  assert.equal(await s.ev("document.getElementById('planner-title').textContent"), 'Alarms for the penumbral lunar eclipse');
  assert.equal(await s.ev("document.getElementById('planner-when').textContent"), 'Greatest eclipse: Monday 19 July 2027 at 02:03 (UTC+10), which is 16:03 UTC.');
  // Marcos's sentence beside the flag (data review D-3, 2026-10-16).
  assert.deepEqual(await results(s), ['Rings Monday 19 July 2027 at 12:00 (UTC+10), after greatest eclipse. Some calendars leave out an alarm set for after the eclipse begins.']);
  await setSelect(s, "document.querySelector('.alarm-choice')", 'day-1');
  assert.deepEqual(await results(s), ['Rings Sunday 18 July 2027 at 12:00 (UTC+10).']);
  // Eight alarms is the most: the button stops and the status line says why.
  for (let i = 0; i < 7; i++) await s.click('#add-alarm');
  assert.equal(await s.ev("document.querySelectorAll('#alarm-rows .alarm-row').length"), 8);
  assert.equal(await s.ev("document.getElementById('add-alarm').disabled"), true);
  assert.equal(await s.ev("document.getElementById('planner-status').textContent"), 'Alarm 8 added. 8 alarms is the most for one eclipse.');
  houseStyle(await s.ev("document.getElementById('planner').innerText"), 'planner, Sydney');
  assert.deepEqual(s.log.errors, []);
  assert.deepEqual(s.log.csp, []);
  await s.close();
});

// ---- A change of time zone while the page is open (code review C-22) --------------------------
await check('the device changes time zone with the page open: the page and the planner follow it', async () => {
  const z = await open({ width: 1280, height: 900 });
  await z.ev("document.querySelectorAll('.year-group')[1].open = true");
  await z.click('#next-alarms');
  assert.deepEqual(await results(z), ['Rings Saturday 6 February 2027 at 12:00 (UTC+1).']);
  await z.s('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' });
  // The page looks again once a minute and whenever it comes back into view; the second is quicker to test.
  await z.ev("document.dispatchEvent(new Event('visibilitychange'))");
  assert.equal(await z.ev("document.getElementById('eclipse-date').textContent"), 'Sunday 7 February 2027 at 01:00 (UTC+9)');
  assert.match(await z.ev("document.getElementById('planner-zone').textContent"), /time zone, Asia\/Tokyo\./);
  assert.equal(await z.ev("document.getElementById('planner-when').textContent"), 'Greatest eclipse: Sunday 7 February 2027 at 01:00 (UTC+9), which is 16:00 UTC.');
  // The day is now 7 February in Tokyo, and noon on it is after greatest eclipse.
  assert.deepEqual(await results(z), ['Rings Sunday 7 February 2027 at 12:00 (UTC+9), after greatest eclipse. Some calendars leave out an alarm set for after the eclipse begins.']);
  assert.equal(await z.ev("document.querySelector('.eclipse-item .eclipse-when').textContent"), 'Sun 7 Feb 2027, 01:00 (UTC+9)');
  assert.deepEqual(await z.ev("[...document.querySelectorAll('.year-group[open]')].map((g) => g.dataset.year)"), ['2027', '2028']);
  await z.key('Escape');
  assert.equal(await z.ev('document.activeElement.id'), 'next-alarms');
  assert.deepEqual(z.log.errors, []);
  await z.close();
});

// ---- The moment an eclipse passes (code review C-6, C-18, C-20) --------------------------------
// Greatest eclipse of 6 February 2027 is 15:59:32 UTC, shown and counted to as 16:00.
const PASS = Date.parse('2027-02-06T16:00:00Z');

await check('an eclipse passes: the countdown moves on at the minute shown, the open years stay open and focus stays put', async () => {
  const d = await open({ width: 1280, height: 900 }, PASS - 8000);
  assert.equal(await d.ev("document.getElementById('eclipse-type').textContent"), 'Annular solar eclipse');
  assert.match(await digits(d), /^00:00:00:0[1-8]$/);
  assert.equal(await d.ev("document.getElementById('list-count').textContent"), '337 eclipses in 74 years.');
  // Open 2028 too, and put the keyboard on the second eclipse of 2027.
  await d.ev("document.querySelectorAll('.year-group')[1].open = true");
  await d.ev("document.querySelectorAll('.year-group')[0].querySelectorAll('.btn-alarm')[1].focus()");
  const focused = await d.ev('document.activeElement.dataset.id');
  assert.equal(focused, '2027-02-20-lunar');
  await sleep(9000);
  assert.equal(await d.ev("document.getElementById('eclipse-type').textContent"), 'Penumbral lunar eclipse');
  assert.equal(await d.ev("document.getElementById('eclipse-date').textContent"), 'Sunday 21 February 2027 at 00:13 (UTC+1)');
  assert.equal(await d.ev("document.getElementById('list-count').textContent"), '336 eclipses in 74 years.');
  assert.deepEqual(await d.ev("[...document.querySelectorAll('.year-group[open]')].map((g) => g.dataset.year)"), ['2027', '2028'], 'the years that were open stay open');
  assert.equal(await d.ev('document.activeElement.dataset.id'), focused, 'focus is still on the same button');
  assert.equal(await d.ev("document.querySelector('.eclipse-item').dataset.id"), '2027-02-20-lunar');
  assert.deepEqual(d.log.errors, []);
  await d.close();
});

await check('with the planner open, an alarm passes at the minute and shows as passed; once the eclipse passes Save says so', async () => {
  // 15:58:57 UTC: 16:59 in Oslo is three seconds away.
  const d = await open({ width: 1280, height: 900 }, PASS - 63000);
  await d.click('#next-alarms');
  await setSelect(d, "document.querySelector('.alarm-choice')", 'before');
  await setSelect(d, "document.querySelector('.alarm-minutes')", '15');
  await d.click('#add-alarm');
  await setSelect(d, "document.querySelectorAll('.alarm-choice')[1]", 'day-0');
  await setTime(d, "document.querySelectorAll('.alarm-time')[1]", '16:59');
  assert.deepEqual(await results(d), ['This time has already passed, so this alarm is left out of the file.', 'Rings Saturday 6 February 2027 at 16:59 (UTC+1).']);
  await sleep(150); // the time just typed is read out a moment later; let that pass first
  await watchLive(d);
  await sleep(4500);
  // At the minute the results are worked out again, quietly: 16:59 has passed.
  assert.equal((await results(d))[1], 'This time has already passed, so this alarm is left out of the file.');
  assert.deepEqual(await takeLive(d), [], 'a result that changes on its own is not read out');
  await d.key('Escape');
  await d.close();
  const e = await open({ width: 1280, height: 900 }, PASS - 6000);
  await e.click('#next-alarms');
  await sleep(7000);
  await e.click('#save-ics');
  assert.equal(await e.ev("document.getElementById('planner-status').textContent"), 'This eclipse has passed, so there is nothing to save.');
  assert.equal(await e.ev("document.getElementById('eclipse-type').textContent"), 'Penumbral lunar eclipse', 'the countdown moved on behind the planner');
  await e.key('Escape');
  assert.equal(await e.ev('document.activeElement.id'), 'next-alarms');
  assert.deepEqual(e.log.errors, []);
  await e.close();
});

await check('after the last eclipse in the list (2100): the countdown and the list say so, nothing is empty (code review C-19)', async () => {
  const d = await open({ width: 390, height: 800 }, Date.parse('2100-09-05T00:00:00Z'));
  assert.equal(await d.ev("document.getElementById('eclipse-type').textContent"), 'No more eclipses in the list');
  assert.equal(await d.ev("document.getElementById('countdown-to').hidden"), true, 'no label for a countdown that counts to nothing');
  assert.equal(await digits(d), '00:00:00:00');
  assert.equal(await d.ev("document.getElementById('countdown-words').textContent"), 'No more eclipses in the list.');
  assert.equal(await d.ev("document.getElementById('event-details').hidden"), true, 'no empty date, region or type');
  assert.equal(await d.ev("document.getElementById('next-alarms').disabled"), true);
  assert.equal(await d.ev("document.getElementById('list-count').textContent"), 'There are no more eclipses in the list.');
  assert.equal(await d.ev("document.querySelectorAll('.year-group').length"), 0);
  houseStyle(await d.ev('document.body.innerText'), 'page after 2100');
  await d.close();
  // One eclipse left: the singular.
  const one = await open({ width: 390, height: 800 }, Date.parse('2100-08-20T00:00:00Z'));
  assert.equal(await one.ev("document.getElementById('list-count').textContent"), '1 eclipse in 1 year.');
  await setSelect(one, "document.getElementById('filter-kind')", 'lunar');
  assert.equal(await one.ev("document.getElementById('list-count').textContent"), 'No eclipse of this kind and type is left in the list.');
  assert.deepEqual(one.log.errors, []);
  await one.close();
});

// ==== The city filter (11 November 2026) =========================================================
// Expectations come from core/local.js (which tests/local.test.ts checks against a separate
// Python implementation); the page is checked for using them: the list, the countdown, the zone, the file.

const CITY_KEY = 'eclipsetracker.city';
const BERGEN_TEXT = '{"v":1,"name":"Bergen","country":"Norway","lat":60.393,"lon":5.3242,"tz":"Europe/Oslo"}';
const SYDNEY = { lat: -33.8678, lon: 151.2073 };

/** What the page must show for a city with the frozen clock: the eclipses still to start, in order. */
function expectFor(point: { lat: number; lon: number }, zone: string) {
  const locals = localAll(point);
  const list = ECLIPSES.filter((e) => locals.has(e.id)).filter((e) => minuteOf(defined(locals.get(e.id), e.id).start) > NOW);
  const first = defined(list[0], 'a first eclipse');
  const local = defined(locals.get(first.id), first.id);
  const years = new Set(list.map((e) => localDateTime(zone, minuteOf(defined(locals.get(e.id), e.id).start)).date.slice(0, 4)));
  return { list, first, local, start: minuteOf(local.start), years: years.size };
}
const bergen = expectFor({ lat: 60.393, lon: 5.3242 }, 'Europe/Oslo');
const openedList = (c: Page): Promise<boolean> => c.waitFor("document.querySelectorAll('#city-dropdown li').length > 0");
const catalogueRequests = (c: Page): number => c.log.requests.filter((r) => r.url.includes('cities.js')).length;
/** Types a name into the chooser and picks the first suggestion with the keyboard, as a person does. */
async function pickFirst(c: Page, typed: string): Promise<void> {
  await c.type('#city-search', typed);
  assert.ok(await openedList(c), `suggestions for ${typed}`);
  await c.key('ArrowDown');
  await c.key('Enter');
  await sleep(150);
}
const text = (c: Page, id: string): Promise<string> => c.ev(`document.getElementById(${J(id)}).textContent`);

await check('B1 no city: the page as before, the label says what it counts to, the catalogue is not requested, nothing is stored', async () => {
  const p = await open({ width: 1280, height: 900 });
  assert.equal(await text(p, 'countdown-to'), 'Greatest eclipse in');
  assert.equal(await text(p, 'countdown-eyebrow'), 'Next eclipse');
  assert.equal(await text(p, 'eclipse-date-label'), 'Date');
  assert.deepEqual(await p.ev("['eclipse-max-row', 'eclipse-end-row', 'eclipse-seen-row'].map((id) => document.getElementById(id).hidden)"), [true, true, true]);
  assert.equal(await p.ev("document.getElementById('city-card').hidden"), false);
  assert.equal(await p.ev("document.getElementById('city-selected').hidden"), true);
  assert.equal(catalogueRequests(p), 0, 'cities.js is not requested before the chooser is used');
  assert.equal(await p.ev("'CITIES' in globalThis"), false);
  assert.equal(await p.ev('localStorage.length + sessionStorage.length'), 0);
  assert.equal(await text(p, 'city-privacy'), 'EclipseTracker remembers your city in this browser only and sends it nowhere. Clear it with the Clear city button.');
  assert.equal(await p.ev("document.getElementById('city-search').getAttribute('role')"), 'combobox');
  assert.equal(await p.ev("document.getElementById('city-search').getAttribute('aria-expanded')"), 'false');
  assert.equal(await text(p, 'list-count'), '337 eclipses in 74 years.');
  assert.deepEqual(p.log.errors, []);
  await p.close();
});

const downloadsCity = join(work, 'downloads-city');
mkdirSync(downloadsCity, { recursive: true });
const c = await open({ width: 1280, height: 900, downloads: downloadsCity });

await check('B2 the chooser: the first use requests cities.js once, with its stamp, and no error or policy report', async () => {
  assert.equal(catalogueRequests(c), 0);
  await c.click('#city-search');
  assert.ok(await c.waitFor("'CITIES' in globalThis"), 'the catalogue script ran');
  await sleep(200);
  const asked = c.log.requests.filter((r) => r.url.includes('cities.js')).map((r) => new URL(r.url).pathname + new URL(r.url).search);
  assert.deepEqual(asked, ['/cities.js?v=2f08782c']);
  assert.equal(await text(c, 'city-status'), '', 'the loading message is cleared');
  assert.equal(await c.ev("document.getElementById('city-search').getAttribute('aria-busy')"), null);
  assert.deepEqual(c.log.errors, []);
  assert.deepEqual(c.log.csp, []);
  assert.deepEqual(c.log.offsite, []);
  await c.ev("document.getElementById('city-search').blur()");
  await c.click('#city-search');
  assert.equal(catalogueRequests(c), 1, 'a second use does not ask again');
});

await check('B3 Bergen by keyboard: the highlighted row is announced, the countdown and the list show only what Bergen sees, the city is kept', async () => {
  await c.type('#city-search', 'bergen');
  assert.ok(await openedList(c));
  assert.equal(await c.ev("document.getElementById('city-search').getAttribute('aria-expanded')"), 'true');
  assert.equal(await c.ev("document.querySelectorAll('#city-dropdown li').length"), 8);
  assert.deepEqual(await c.ev("[...document.querySelectorAll('#city-dropdown li')].slice(0, 2).map((li) => li.textContent)"), ['BergenNorway', 'BergenThe Netherlands']);
  await sleep(500);
  assert.equal(await text(c, 'city-status'), '8 suggestions.');
  await c.key('ArrowDown');
  assert.equal(await c.ev("document.getElementById('city-search').getAttribute('aria-activedescendant')"), 'city-option-0');
  assert.deepEqual(await c.ev("[...document.querySelectorAll('#city-dropdown li')].map((li) => li.getAttribute('aria-selected'))"), ['true', 'false', 'false', 'false', 'false', 'false', 'false', 'false']);
  await c.key('Enter');
  await sleep(150);
  assert.equal(await text(c, 'city-selected-text'), 'Bergen, Norway');
  assert.equal(await c.ev("document.getElementById('city-search').value"), '');
  assert.equal(await text(c, 'city-status'), 'Showing eclipses seen from Bergen, Norway.');
  assert.equal(await text(c, 'countdown-eyebrow'), 'Next eclipse seen from Bergen');
  assert.equal(await text(c, 'countdown-to'), 'Starts in');
  assert.equal(await text(c, 'eclipse-type'), localName(bergen.first.kind, bergen.local));
  assert.equal(await text(c, 'eclipse-date-label'), 'Starts');
  assert.equal(await text(c, 'eclipse-date'), localWhen('Europe/Oslo', bergen.start));
  assert.match(await text(c, 'countdown-words'), /^Starts in \d+ days?, /);
  assert.equal(await c.ev("['eclipse-max-row', 'eclipse-end-row', 'eclipse-seen-row'].map((id) => document.getElementById(id).hidden).join()"), 'false,false,false');
  assert.equal(await text(c, 'list-count'), `${bergen.list.length} eclipses seen from Bergen in ${bergen.years} years.`);
  assert.equal(await c.ev("document.querySelector('.eclipse-item').dataset.id"), bergen.first.id);
  assert.match(await text(c, 'list-intro'), /^Eclipses that can be seen from Bergen, from NASA's eclipse catalogue, with the time each starts there in that city's time zone\./);
  assert.equal(await c.ev('localStorage.getItem(' + J(CITY_KEY) + ')'), BERGEN_TEXT);
  assert.match(await c.ev("document.querySelector('.eclipse-item .eclipse-local').textContent"), /^Seen from Bergen: /);
  assert.match(await c.ev("document.querySelector('.eclipse-item .eclipse-when').textContent"), /^Starts \w{3} \d+ \w{3} 20\d\d, \d\d:\d\d \(UTC\+[12]\)$/);
  const countdown = await digits(c);
  const [d = 0, h = 0, m = 0] = countdown.split(':').map(Number);
  const left = bergen.start - NOW;
  assert.ok(Math.abs((d * 86400 + h * 3600 + m * 60) * 1000 - left) < 120_000, `the digits ${countdown} count to ${new Date(bergen.start).toISOString()}`);
  assert.deepEqual(c.log.errors, []);
});

await check('B4 reload: the city is restored, with no request for cities.js, the same countdown and list', async () => {
  c.log.requests.splice(0);
  await c.load();
  assert.equal(catalogueRequests(c), 0);
  assert.equal(await c.ev("'CITIES' in globalThis"), false);
  assert.equal(await text(c, 'city-selected-text'), 'Bergen, Norway');
  assert.equal(await c.ev("document.getElementById('city-selected').hidden"), false);
  assert.equal(await text(c, 'countdown-to'), 'Starts in');
  assert.equal(await text(c, 'eclipse-date'), localWhen('Europe/Oslo', bergen.start));
  assert.equal(await text(c, 'list-count'), `${bergen.list.length} eclipses seen from Bergen in ${bergen.years} years.`);
  assert.match(await c.ev("document.getElementById('planner-note').textContent"), /EclipseTracker sends nothing; it keeps only the city you chose, in this browser\.$/);
});

await check('B8 the planner and the saved file for Bergen: the start in its zone, alarms counted from it, the place in the file', async () => {
  await c.click('#next-alarms');
  assert.equal(await text(c, 'planner-when'), `Starts in Bergen: ${localWhen('Europe/Oslo', bergen.start)}, which is ${localDateTime('UTC', bergen.start).time} UTC.`);
  assert.equal(await text(c, 'planner-zone'), 'Times of day are for the time zone of Bergen, Europe/Oslo. The alarms ring at those moments wherever you are, so your calendar can show another hour. Alarms before the start always follow the eclipse.');
  assert.ok((await c.ev("[...document.querySelectorAll('.alarm-choice option')].map((o) => o.textContent)")).includes('Before the eclipse starts'));
  await c.click('#save-ics');
  let done: FromBrowser = null;
  for (let i = 0; i < 100 && !done; i++) {
    done = c.log.downloads.find((x) => x.state === 'completed');
    if (!done) await sleep(50);
  }
  assert.ok(done, 'the download completed');
  const saved = readFileSync(join(downloadsCity, defined(readdirSync(downloadsCity)[0], 'the saved file')), 'utf8');
  assert.match(saved, /\r\nLOCATION:Bergen\\, Norway\r\n/);
  const stamp = new Date(bergen.start).toISOString().replace(/[-:]/g, '').replace('.000Z', 'Z');
  assert.ok(saved.includes(`\r\nDTSTART:${stamp}\r\n`), `DTSTART is the minute the countdown counts to: ${stamp}`);
  assert.match(saved.replace(/\r\n /g, ''), /SUMMARY:\w+ (solar|lunar) eclipse seen from Bergen\r\n/);
  await c.key('Escape');
});

await check('B5 the Clear city button: the city and the stored entry are gone, the page is the page with no city, the status says so, focus is on the search box', async () => {
  await c.click('#city-clear-btn');
  assert.equal(await c.ev('localStorage.getItem(' + J(CITY_KEY) + ')'), null);
  assert.equal(await c.ev("document.getElementById('city-selected').hidden"), true);
  assert.equal(await text(c, 'countdown-to'), 'Greatest eclipse in');
  assert.equal(await text(c, 'countdown-eyebrow'), 'Next eclipse');
  assert.equal(await text(c, 'eclipse-type'), 'Annular solar eclipse');
  assert.equal(await text(c, 'eclipse-date'), 'Saturday 6 February 2027 at 17:00 (UTC+1)');
  assert.equal(await text(c, 'list-count'), '337 eclipses in 74 years.');
  assert.equal(await text(c, 'city-status'), 'Showing every eclipse.');
  assert.equal(await c.ev('document.activeElement.id'), 'city-search');
  assert.equal(await c.ev("document.querySelector('.eclipse-local')"), null);
  assert.match(await c.ev("document.getElementById('planner-note').textContent"), /EclipseTracker sends nothing and keeps nothing\.$/);
  assert.deepEqual(c.log.errors, []);
});

await check('B10 Escape and Tab close the list: aria-expanded false, no active descendant', async () => {
  await c.type('#city-search', 'ber');
  assert.ok(await openedList(c));
  await c.key('ArrowDown');
  assert.equal(await c.ev("document.getElementById('city-search').hasAttribute('aria-activedescendant')"), true);
  await c.key('Escape');
  assert.equal(await c.ev("document.getElementById('city-dropdown').hidden"), true);
  assert.equal(await c.ev("document.getElementById('city-search').getAttribute('aria-expanded')"), 'false');
  assert.equal(await c.ev("document.getElementById('city-search').hasAttribute('aria-activedescendant')"), false);
  assert.equal(await c.ev("document.getElementById('city-search').value"), 'ber', 'the first Escape closes the list only; the typed text stays');
  await c.type('#city-search', 'ber');
  assert.ok(await openedList(c));
  await c.key('Tab');
  assert.equal(await c.ev("document.getElementById('city-dropdown').hidden"), true);
  assert.equal(await c.ev("document.getElementById('city-search').getAttribute('aria-expanded')"), 'false');
  assert.equal(await c.ev("document.getElementById('city-search').hasAttribute('aria-activedescendant')"), false);
  // Typing keeps the chosen city; only a pick or the Clear city button changes it. And nothing is picked by Enter with no row highlighted.
  await c.type('#city-search', 'tokyo');
  assert.ok(await openedList(c));
  await c.key('Enter');
  assert.equal(await c.ev("document.getElementById('city-selected').hidden"), true, 'no city yet: nothing was highlighted');
  await sleep(500);
  assert.match(await text(c, 'city-status'), /suggestion/, 'the count is said once, after the last key');
  await c.type('#city-search', '');
  assert.equal(await text(c, 'city-status'), '', 'an emptied box takes the count back and announces nothing');
  assert.deepEqual(c.log.errors, []);
  await c.close();
});

await check('a city in another zone: Sydney\'s times are Sydney\'s, not the device\'s, and the list is grouped by Sydney\'s years', async () => {
  const y = await open({ width: 1280, height: 900 });
  await pickFirst(y, 'sydney');
  const sydney = expectFor(SYDNEY, 'Australia/Sydney');
  assert.equal(await text(y, 'city-selected-text'), 'Sydney, Australia');
  assert.equal(await text(y, 'eclipse-date'), localWhen('Australia/Sydney', sydney.start));
  assert.match(await text(y, 'eclipse-date'), /\(UTC\+(10|11)\)$/);
  assert.equal(await text(y, 'list-count'), `${sydney.list.length} eclipses seen from Sydney in ${sydney.years} years.`);
  assert.equal(await y.ev("document.querySelector('.year-group').dataset.year"), localDateTime('Australia/Sydney', sydney.start).date.slice(0, 4));
  // The kind filter works on the worldwide kind, and the count says so.
  await setSelect(y, "document.getElementById('filter-kind')", 'solar');
  assert.match(await text(y, 'list-count'), /^Showing \d+ of \d+ eclipses seen from Sydney, in \d+ years?\.$/);
  houseStyle(await y.ev('document.body.innerText'), 'page with a city');
  assert.deepEqual(y.log.errors, []);
  await y.close();
});

await check('B6 storage that throws: the page loads, a pick works for the visit, nothing is thrown; a stored value that is not a city is removed', async () => {
  const KEPT = 'EclipseTracker remembers your city in this browser only and sends it nowhere. Clear it with the Clear city button.';
  const NOT_KEPT = 'This browser would not let EclipseTracker keep your city, so it is forgotten when you close the page. EclipseTracker sends it nowhere. Clear it with the Clear city button.';
  const blocked: Array<[string, boolean]> = [
    ["Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });", true],
    ["for (const m of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) Storage.prototype[m] = function () { throw new DOMException('blocked', 'QuotaExceededError'); };", true],
    // Reading works and writing is refused (a full store): the page learns it at the first pick.
    ["Storage.prototype.setItem = function () { throw new DOMException('full', 'QuotaExceededError'); };", false],
  ];
  for (const [script, blockedAtLoad] of blocked) {
    const b = await openPage(browser, base, { timezone: 'Europe/Oslo', width: 1280, height: 900, init: clockAt(NOW) + script });
    assert.equal(await b.ev("document.documentElement.dataset.ready"), 'true');
    assert.equal(await text(b, 'countdown-to'), 'Greatest eclipse in');
    assert.equal(await text(b, 'city-privacy'), blockedAtLoad ? NOT_KEPT : KEPT);
    await pickFirst(b, 'bergen');
    assert.equal(await text(b, 'city-selected-text'), 'Bergen, Norway');
    assert.equal(await text(b, 'countdown-to'), 'Starts in');
    assert.equal(await text(b, 'city-privacy'), NOT_KEPT, 'nothing is kept, and the page does not say it remembers');
    assert.match(await text(b, 'planner-note'), /EclipseTracker sends nothing and keeps nothing\.$/, 'the planner note does not say a city is kept');
    await b.click('#city-clear-btn');
    assert.equal(await text(b, 'countdown-to'), 'Greatest eclipse in');
    assert.deepEqual(b.log.errors, []);
    await b.close();
  }
  const bad = await openPage(browser, base, { timezone: 'Europe/Oslo', width: 1280, height: 900, init: clockAt(NOW) + `localStorage.setItem(${J(CITY_KEY)}, '{"v":1,"name":"Bergen","country":"Norway","lat":91,"lon":5,"tz":"Europe/Oslo"}');` });
  assert.equal(await text(bad, 'countdown-to'), 'Greatest eclipse in');
  assert.equal(await bad.ev('localStorage.getItem(' + J(CITY_KEY) + ')'), null, 'the invalid entry was removed');
  assert.equal(await bad.ev("document.getElementById('city-selected').hidden"), true);
  await bad.close();
  // The record of an earlier build, without the version (v: 1), is not a record of this page: it is removed, as MeteorWatch removes one.
  const unversioned = await openPage(browser, base, { timezone: 'Europe/Oslo', width: 1280, height: 900, init: clockAt(NOW) + `localStorage.setItem(${J(CITY_KEY)}, '{"name":"Bergen","country":"Norway","lat":60.393,"lon":5.3242,"tz":"Europe/Oslo"}');` });
  assert.equal(await text(unversioned, 'countdown-to'), 'Greatest eclipse in');
  assert.equal(await unversioned.ev('localStorage.getItem(' + J(CITY_KEY) + ')'), null, 'the record without v was removed');
  assert.equal(await unversioned.ev("document.getElementById('city-selected').hidden"), true);
  await unversioned.close();
  // A well-formed city whose time zone this browser does not know is not used, and is not deleted.
  const stale = `{"v":1,"name":"Bergen","country":"Norway","lat":60.393,"lon":5.3242,"tz":"Mars/Olympus"}`;
  const odd = await openPage(browser, base, { timezone: 'Europe/Oslo', width: 1280, height: 900, init: clockAt(NOW) + `localStorage.setItem(${J(CITY_KEY)}, ${J(stale)});` });
  assert.equal(await text(odd, 'countdown-to'), 'Greatest eclipse in');
  assert.equal(await odd.ev("document.getElementById('city-selected').hidden"), true);
  assert.equal(await odd.ev('localStorage.getItem(' + J(CITY_KEY) + ')'), stale, 'kept: a newer browser may know the zone');
  await odd.close();
});

await check('B11 a city kept from an earlier visit and cleared with the Clear city button: no request for cities.js, the first typing asks for it once', async () => {
  const k = await openPage(browser, base, { timezone: 'Europe/Oslo', width: 1280, height: 900, init: clockAt(NOW) + `localStorage.setItem(${J(CITY_KEY)}, ${J(BERGEN_TEXT)});` });
  assert.equal(await text(k, 'city-selected-text'), 'Bergen, Norway');
  assert.equal(catalogueRequests(k), 0);
  await k.click('#city-clear-btn');
  await sleep(300);
  assert.equal(await text(k, 'countdown-to'), 'Greatest eclipse in');
  assert.equal(await text(k, 'city-status'), 'Showing every eclipse.');
  assert.equal(await k.ev('document.activeElement.id'), 'city-search', 'the focus is on the search box');
  assert.equal(catalogueRequests(k), 0, 'clearing a city does not download the city list');
  assert.equal(await k.ev("'CITIES' in globalThis"), false);
  await k.type('#city-search', 'ber');
  assert.ok(await openedList(k), 'typing loads the list and shows suggestions');
  assert.equal(catalogueRequests(k), 1);
  assert.deepEqual(k.log.errors, []);
  await k.close();
});

await check('B12 a bridge that offers cities (the branch the next APK will use): the chooser shows, a pick is handed to saveCity, and a late loadCity answer does not undo the pick', async () => {
  const fake = (resolveWith: string) => `window.EclipseTrackerApp = { cities: true, rowsFor: () => Promise.resolve([]), saveFile: () => Promise.resolve(true), attach: () => {},
    saveCity: (t) => { window.__saved = t; return Promise.resolve(true); },
    loadCity: () => new Promise((r) => { window.__answer = () => r(${J(resolveWith)}); }) };`;
  const SYDNEY_TEXT = '{"v":1,"name":"Sydney","country":"Australia","lat":-33.8678,"lon":151.2073,"tz":"Australia/Sydney"}';
  const a = await openPage(browser, base, { timezone: 'Europe/Oslo', width: 1280, height: 900, init: clockAt(NOW) + fake(SYDNEY_TEXT) });
  assert.equal(await a.ev("document.getElementById('city-card').hidden"), false);
  assert.equal(await text(a, 'city-privacy'), 'Your city stays on this phone only. Clear it with the Clear city button.');
  await pickFirst(a, 'bergen');
  assert.equal(await a.ev('window.__saved'), BERGEN_TEXT, 'the pick went to saveCity');
  await a.ev('window.__answer()');
  await sleep(200);
  assert.equal(await text(a, 'city-selected-text'), 'Bergen, Norway', 'the late answer did not replace the pick');
  assert.equal(await a.ev('localStorage.length'), 0, 'in the app the page never touches DOM storage');
  await a.close();
  // Answered before any pick: the kept city is used.
  const b = await openPage(browser, base, { timezone: 'Europe/Oslo', width: 1280, height: 900, init: clockAt(NOW) + fake(SYDNEY_TEXT) });
  await b.ev('window.__answer()');
  assert.ok(await b.waitFor("document.getElementById('city-selected-text').textContent === 'Sydney, Australia'"));
  assert.equal(await text(b, 'countdown-to'), 'Starts in');
  await b.click('#city-clear-btn');
  assert.equal(await b.ev('window.__saved'), null, 'Clear city hands null to saveCity');
  assert.deepEqual(b.log.errors, []);
  await b.close();
});

await check('B7 the catalogue does not load: the message says so, every eclipse still shows, the next use tries again', async () => {
  const f = await open({ width: 1280, height: 900 });
  await f.s('Network.setBlockedURLs', { urls: ['*cities.js*'] });
  await f.click('#city-search');
  assert.ok(await f.waitFor("document.getElementById('city-status').textContent.startsWith('The city list did not load')"));
  assert.equal(await text(f, 'city-status'), 'The city list did not load. Reload the page to try again.');
  assert.equal(await f.ev("document.getElementById('city-search').getAttribute('aria-busy')"), null);
  assert.equal(await text(f, 'list-count'), '337 eclipses in 74 years.');
  assert.equal(await f.ev("document.querySelectorAll('script[src*=\"cities.js\"]').length"), 0, 'the failed script element is removed');
  assert.deepEqual(f.log.errors.filter((e) => !/Failed to load resource|ERR_BLOCKED_BY_CLIENT/.test(e)), []);
  await f.s('Network.setBlockedURLs', { urls: [] });
  await f.ev("document.getElementById('city-search').blur()");
  await f.click('#city-search');
  assert.ok(await f.waitFor("'CITIES' in globalThis"), 'the next use loads it');
  await sleep(200);
  assert.equal(await text(f, 'city-status'), '');
  await f.type('#city-search', 'oslo');
  assert.ok(await openedList(f));
  await f.close();
});

await check('B9 400 px wide with text at 200%: a city chosen, no sideways scroll, the clear button at least 44 by 44, the list inside the window', async () => {
  const m = await open({ width: 400, height: 800 });
  await m.s('Page.setFontSizes', { fontSizes: { standard: 32, fixed: 26 } });
  await pickFirst(m, 'bergen');
  await m.ev("document.querySelectorAll('.year-group').forEach((d) => { d.open = true; })");
  await sleep(300);
  assert.equal(await m.ev('document.documentElement.scrollWidth'), await m.ev('document.documentElement.clientWidth'), 'no sideways scroll');
  const box = await m.ev("(() => { const b = document.getElementById('city-clear-btn').getBoundingClientRect(); return [b.width, b.height]; })()");
  assert.ok(box[0] >= 44 && box[1] >= 44, `the clear button is ${box}`);
  assert.deepEqual(await m.ev("[...document.querySelectorAll('body *')].filter((n) => !n.closest('.app-switcher-marquee') && n.getBoundingClientRect().right > 400.5).map((n) => n.className || n.tagName)"), []);
  await m.type('#city-search', 'ber');
  assert.ok(await openedList(m));
  assert.ok(await m.ev("document.getElementById('city-dropdown').getBoundingClientRect().right <= document.documentElement.clientWidth + 0.5"));
  if (shots) await m.viewShot(join(shots, 'city-400-200.png'));
  assert.deepEqual(m.log.errors, []);
  await m.close();
});

await check('B13 the card as MeteorWatch has it: after the countdown card and before the list, "Filter by city", the short placeholder whole at 360 px, a "Clear city" text button, the record with v: 1', async () => {
  for (const width of [1280, 360]) {
    const m = await open({ width, height: 800 });
    const order = await m.ev("(() => { const top = (id) => document.getElementById(id).closest('section').getBoundingClientRect(); const cd = top('eclipse-type'), ci = top('city-card'), li = top('list-heading'); return [cd.bottom <= ci.top + 1, ci.bottom <= li.top + 1, [...document.querySelectorAll('main > section')].map((n) => n.className).join('|')]; })()");
    assert.equal(order[0], true, `${width} px: the city card is below the countdown card`);
    assert.equal(order[1], true, `${width} px: the list card is below the city card`);
    assert.match(order[2], /^card\|city-card\|card list-card\|/, `${width} px: the order of the sections`);
    assert.equal(await text(m, 'city-heading'), 'Filter by city');
    assert.equal(await m.ev("document.querySelector('#city-card h2').tagName"), 'H2');
    assert.equal(await m.ev("document.getElementById('city-search').placeholder"), 'e.g. Bergen, Tokyo');
    assert.equal(await m.ev("document.getElementById('city-search').getAttribute('aria-describedby')"), 'city-intro city-privacy');
    // The placeholder fits inside the box: its width in the box's own font, less the box's padding, is no wider than the box's content.
    const fit = await m.ev("(() => { const i = document.getElementById('city-search'); const cs = getComputedStyle(i); const g = document.createElement('canvas').getContext('2d'); g.font = cs.font; const w = g.measureText(i.placeholder).width; const room = i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); return [w, room, i.getBoundingClientRect().right <= document.documentElement.clientWidth]; })()");
    assert.ok(fit[0] <= fit[1], `${width} px: the placeholder is ${fit[0]} px wide in a box with ${fit[1]} px of room`);
    assert.equal(fit[2], true, 'the box is inside the window');
    if (shots) await m.viewShot(join(shots, `city-card-${width}.png`));
    await pickFirst(m, 'bergen');
    assert.equal(await text(m, 'city-clear-btn'), 'Clear city');
    assert.equal(await m.ev("document.getElementById('city-clear-btn').hasAttribute('aria-label')"), false, 'the visible text is the name');
    const box = await m.ev("(() => { const b = document.getElementById('city-clear-btn').getBoundingClientRect(); return [b.width, b.height, b.right <= document.documentElement.clientWidth]; })()");
    assert.ok(box[0] >= 44 && box[1] >= 44 && box[2], `${width} px: the button is ${box}`);
    assert.equal(await m.ev('document.documentElement.scrollWidth'), await m.ev('document.documentElement.clientWidth'), 'no sideways scroll');
    if (shots) await m.viewShot(join(shots, `city-card-chosen-${width}.png`));
    // The kept record: the six keys in order, the first being v: 1; MeteorWatch keeps the same record under its own key.
    const kept = await m.ev('localStorage.getItem(' + J(CITY_KEY) + ')');
    assert.equal(kept, BERGEN_TEXT);
    assert.deepEqual(Object.keys(JSON.parse(kept)), ['v', 'name', 'country', 'lat', 'lon', 'tz']);
    assert.equal(JSON.parse(kept).v, 1);
    assert.equal(await m.ev('localStorage.length'), 1, 'one key and no other');
    assert.deepEqual(m.log.errors, []);
    assert.deepEqual(m.log.offsite, []);
    await m.close();
  }
});

await check('B14 the default alarm: with a city and a local start before 12:00 it is the day before at 12:00; later in the day it is the day itself; with no city it is unchanged', async () => {
  const sydney = localAll(SYDNEY);
  const startOf = (id: string): number => minuteOf(defined(sydney.get(id), id).start);
  const timeIn = (id: string): string => localDateTime('Australia/Sydney', startOf(id)).time;
  const id0718 = '2027-07-18-lunar';
  assert.equal(timeIn(id0718), '01:57', 'Sydney, eclipse 2027-07-18: the penumbral eclipse starts at 01:57 local time, on Monday 19 July');
  const later = ECLIPSES.filter((e) => sydney.has(e.id) && startOf(e.id) > NOW).find((e) => timeIn(e.id) >= '12:00');
  const daytime = defined(later, 'a Sydney eclipse that starts at 12:00 or later');
  const chosen = (y: Page): Promise<string[]> => y.ev("[document.querySelector('.alarm-choice').value, document.querySelector('.alarm-time').value, document.querySelector('.alarm-result').textContent]");
  const openFor = async (y: Page, id: string): Promise<string[]> => {
    await y.ev(`document.querySelector('.btn-alarm[data-id=${J(id)}]').click()`);
    assert.ok(await y.waitFor("document.getElementById('planner').open"));
    const got = await chosen(y);
    await y.key('Escape');
    return got;
  };
  const y = await open({ width: 1280, height: 900 });
  // No city: the default is on the day at 12:00, whatever the hour of the eclipse.
  assert.deepEqual((await openFor(y, id0718)).slice(0, 2), ['day-0', '12:00']);
  await pickFirst(y, 'sydney');
  const night = await openFor(y, id0718);
  assert.deepEqual(night.slice(0, 2), ['day-1', '12:00'], 'the day before at 12:00');
  assert.match(night[2] ?? '', /^Rings Sunday 18 July 2027 at 12:00 \(UTC\+10\)\.$/, 'it rings before the start (Monday 19 July at 01:57), and without the warning for an alarm after it');
  const day = await openFor(y, daytime.id);
  assert.deepEqual(day.slice(0, 2), ['day-0', '12:00'], `${daytime.id} starts at ${timeIn(daytime.id)} in Sydney: the day itself at 12:00`);
  // Clear the city: the default is the old one again.
  await y.click('#city-clear-btn');
  assert.deepEqual((await openFor(y, id0718)).slice(0, 2), ['day-0', '12:00']);
  assert.deepEqual(y.log.errors, []);
  await y.close();
});

// ---- Layout: three widths, two text sizes, the dark theme -----------------------------------

for (const width of [1280, 390, 320]) {
  for (const text of [100, 200]) {
    await check(`${width} px, text at ${text}%, dark theme: no sideways scroll, nothing cut off, no error, no policy violation, no request off the origin`, async () => {
      const m = await open({ width, height: 800 });
      await m.s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
      // The reader's own text size, as the browser's font settings set it (the page's root is 100%).
      await m.s('Page.setFontSizes', { fontSizes: { standard: 16 * text / 100, fixed: 13 * text / 100 } });
      await m.ev("document.querySelectorAll('.year-group').forEach((d) => { d.open = true; })");
      await sleep(300);
      assert.equal(await m.ev('getComputedStyle(document.documentElement).fontSize'), `${16 * text / 100}px`);
      // Not wider than the window less its scroll bar (a desktop window has one; a phone's overlays).
      assert.equal(await m.ev('document.documentElement.scrollWidth'), await m.ev('document.documentElement.clientWidth'), 'no sideways scroll');
      assert.ok(await m.ev('document.documentElement.clientWidth') > width - 20);
      const wide = `[...document.querySelectorAll('body *')].filter((n) => !n.closest('.app-switcher-marquee') && n.getBoundingClientRect().right > ${width} + 0.5).map((n) => n.className || n.tagName)`;
      assert.deepEqual(await m.ev(wide), []);
      // The countdown's numbers all inside its card (code review C-8).
      assert.equal(await m.ev(`(() => { const card = document.getElementById('countdown-timer').closest('.card').getBoundingClientRect(); return [...document.querySelectorAll('.cd-num, .cd-label')].every((n) => { const b = n.getBoundingClientRect(); return b.left >= card.left && b.right <= card.right; }); })()`), true);
      assert.deepEqual(await selectsCut(m), [], 'the filters show their chosen option whole');
      if (shots) await m.viewShot(join(shots, `page-${width}-${text}.png`));
      await m.click('#next-alarms');
      for (let i = 0; i < 3; i++) await m.ev("document.getElementById('add-alarm').click()");
      await setSelect(m, "document.querySelectorAll('.alarm-choice')[2]", 'before');
      assert.deepEqual(await m.ev(`[...document.querySelectorAll('#planner *')].filter((n) => n.getBoundingClientRect().right > ${width} + 0.5).map((n) => n.className || n.tagName)`), []);
      assert.equal(await m.ev('document.documentElement.scrollWidth'), await m.ev('document.documentElement.clientWidth'));
      assert.ok(await m.ev("document.getElementById('planner').scrollWidth <= document.getElementById('planner').clientWidth"));
      assert.deepEqual(await selectsCut(m), [], "the planner's selects show their chosen option whole (K-2)");
      if (shots) await m.viewShot(join(shots, `planner-${width}-${text}.png`));
      await m.key('Escape');
      assert.deepEqual(m.log.errors, []);
      assert.deepEqual(m.log.csp, []);
      assert.deepEqual(await m.ev('window.__csp'), []);
      assert.deepEqual(m.log.offsite, []);
      if (width === 320 && text === 100) assert.equal(await m.ev("getComputedStyle(document.querySelector('.app-switcher-track')).animationName"), 'none');
      await m.close();
    });
  }
}

console.log(`smoke: ${passed} checks passed`);
await cleanup();
