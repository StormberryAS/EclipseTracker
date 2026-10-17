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
// the house style. Prints one line per check and exits 1 on the first failure.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { launchChromium, openPage, selectsCut, sleep } from './cdp.ts';
import type { FromBrowser, Page, PageOptions } from './cdp.ts';
import { planAlarms } from '#core/alarms.js';
import { eclipseById } from '#core/eclipses.js';
import { buildIcs } from '#core/ics.js';
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
  assert.deepEqual(live, ['list-count', 'planner-live'], 'one live region on the page and one in the planner');
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
