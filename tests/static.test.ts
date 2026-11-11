// The page and the publishing set-up: the house style of the page text, the module script, the
// cache stamps, and the _config.yml exclusions that keep sources, tooling and tests off the site.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { defined, group } from './helpers.ts';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const page = read('index.html');
const visible = page.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ');

test('page text: no en or em dashes, no double hyphens, no exclamation marks', () => {
  assert.doesNotMatch(visible, /[–—]/);
  assert.doesNotMatch(visible, /--/);
  assert.doesNotMatch(visible, /!/);
  assert.match(page, /<html lang="en-GB">/);
});

test('the page loads only the compiled module, stamped', () => {
  const scripts = [...page.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(scripts.length, 1);
  assert.match(defined(scripts[0], 'the script'), /^<script type="module" src="app\.js\?v=[0-9a-f]{8}">$/);
  assert.match(page, /href="style\.css\?v=[0-9a-f]{8}"/);
  assert.doesNotMatch(page, /src="ts\//);
});

test('every relative import in the compiled JavaScript carries a ?v= stamp', () => {
  const files = ['app.js', ...readdirSync(new URL('../core/', import.meta.url)).filter((n) => n.endsWith('.js')).map((n) => `core/${n}`)];
  assert.ok(files.length >= 8);
  for (const f of files) {
    const text = read(f);
    for (const m of text.matchAll(/\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g)) assert.match(defined(m[1], 'the specifier'), /\.js\?v=[0-9a-f]{8}$/, `${f}: ${m[1]}`);
    // The catalogue's address, written new URL('./cities.js', import.meta.url), is stamped the same way (11 November 2026).
    for (const m of text.matchAll(/new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]/g)) assert.match(defined(m[1], 'the address'), /\.js\?v=[0-9a-f]{8}$/, `${f}: ${m[1]}`);
  }
  const catalogue = read('app.js').match(/new URL\('\.\/cities\.js\?v=([0-9a-f]{8})', import\.meta\.url\)/);
  assert.ok(catalogue, 'app.js names cities.js');
  assert.equal(catalogue[1], createHash('sha256').update(readFileSync(new URL('../cities.js', import.meta.url))).digest('hex').slice(0, 8), 'the stamp is the hash of cities.js');
});

test('_config.yml keeps sources, tooling and tests off the site, and publishes the app', () => {
  const cfg = read('_config.yml');
  const excluded = [...cfg.matchAll(/^ {2}- (\S+)$/gm)].map((m) => m[1]);
  for (const x of ['ts/', 'tools/', 'tests/', 'node_modules/', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.core.json', '.npmrc', 'bump_assets.py', 'README.md', 'CHANGELOG.md', 'DISCLAIMER.md', 'LICENSE', 'android/', 'fastlane/', 'zapstore.yaml']) {
    assert.ok(excluded.includes(x), `${x} is excluded`);
  }
  for (const x of ['core/', 'data/', 'app.js', 'cities.js', 'index.html', 'style.css', 'disclaimer.html']) assert.ok(!excluded.includes(x), `${x} is published`);
  // tools/ stays off the site: it holds tools/nasa-elements/ (the NASA element files), the data tools and the oracle.
  assert.ok(excluded.includes('tools/') && excluded.includes('tests/'));
});

test('the TypeScript set-up follows the Website: TypeScript 6.0.3 pinned, strict, ES modules', () => {
  const pkg = JSON.parse(read('package.json'));
  // TypeScript, and Node's own types for the tests (@types/node, pinned to Node 24's line on
  // 17 October 2026 with Marcos's approval; its one dependency, undici-types, is types only).
  assert.deepEqual(pkg.devDependencies, { '@types/node': '24.19.2', typescript: '6.0.3' });
  assert.deepEqual(pkg.engines, { node: '>=24' });
  assert.equal(pkg.type, 'module');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.packages['node_modules/typescript'].version, '6.0.3');
  assert.equal(lock.packages['node_modules/@types/node'].version, '24.19.2');
  assert.deepEqual(Object.keys(lock.packages).filter((k) => k !== '').sort(), ['node_modules/@types/node', 'node_modules/typescript', 'node_modules/undici-types']);
  for (const [k, v] of Object.entries(lock.packages as Record<string, { integrity?: string; hasInstallScript?: boolean }>)) {
    if (k === '') continue;
    assert.match(v.integrity ?? '', /^sha512-/, `${k} is pinned by its integrity hash`);
    assert.notEqual(v.hasInstallScript, true, `${k} has no install script`);
  }
  const ts = JSON.parse(read('tsconfig.json'));
  assert.equal(ts.compilerOptions.strict, true);
  assert.equal(ts.compilerOptions.rootDir, 'ts');
  assert.equal(ts.compilerOptions.outDir, '.');
  assert.equal(ts.compilerOptions.module, 'ES2020');
  assert.equal(ts.compilerOptions.noUncheckedIndexedAccess, true);
  assert.match(read('.gitignore'), /^node_modules\/$/m);
  // core/ is type-checked on its own without the DOM (code review C-17); tools/build-ts.sh runs it.
  const core = JSON.parse(read('tsconfig.core.json'));
  assert.equal(core.extends, './tsconfig.json');
  assert.deepEqual(core.compilerOptions.lib, ['ES2020']);
  assert.deepEqual(core.include, ['ts/core/**/*.ts']);
  assert.match(read('tools/build-ts.sh'), /tsconfig\.core\.json/);
  // The tests are TypeScript, run by Node 24 directly and type-checked strictly (17 October 2026).
  const tests = JSON.parse(read('tests/tsconfig.json'));
  for (const k of ['strict', 'noUncheckedIndexedAccess', 'erasableSyntaxOnly', 'verbatimModuleSyntax', 'noEmit']) assert.equal(tests.compilerOptions[k], true, `tests/tsconfig.json ${k}`);
  assert.deepEqual(tests.compilerOptions.types, ['node'], 'Node is typed by @types/node');
  assert.deepEqual(tests.compilerOptions.lib, ['ES2023'], 'no DOM library: the tests run in Node, not a browser');
  assert.match(read('tools/build-ts.sh'), /tests\/tsconfig\.json/);
  assert.deepEqual(readdirSync(new URL('./', import.meta.url)).filter((n) => /\.(m?js|cjs)$/.test(n)), [], 'no JavaScript left in tests/');
  // The Android bridge script is TypeScript, compiled to the android-bridge.js the app bundles.
  const bridge = JSON.parse(read('android/web-overlay/tsconfig.json'));
  assert.equal(bridge.extends, '../../tsconfig.json');
  assert.deepEqual(bridge.include, ['android-bridge.ts']);
  assert.match(read('tools/build-ts.sh'), /android\/web-overlay\/tsconfig\.json/);
  assert.match(read('.gitattributes'), /^\/android\/web-overlay\/android-bridge\.js linguist-generated=true$/m);
});

test("the page's own policy: nothing but its own files, no connection, no referrer (code review C-5)", () => {
  const metas = [...page.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/g)].map((m) => m[1]);
  assert.equal(metas.length, 1);
  const policy = Object.fromEntries(defined(metas[0], 'the policy').split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
  assert.deepEqual(policy, {
    'default-src': "'self'", 'script-src': "'self'", 'style-src': "'self'", 'img-src': "'self'", 'font-src': "'self'",
    'connect-src': "'none'", 'form-action': "'none'", 'object-src': "'none'", 'base-uri': "'none'", 'worker-src': "'none'",
  });
  assert.match(page, /<meta name="referrer" content="no-referrer" \/>/);
  // The policy comes before anything the page loads.
  assert.ok(page.indexOf('Content-Security-Policy') < page.indexOf('<link'), 'the policy is read before the first stylesheet');
  assert.ok(page.indexOf('<meta charset="UTF-8" />') < page.indexOf('Content-Security-Policy'));
  // Nothing inline that the policy would refuse.
  assert.doesNotMatch(page, /\sstyle="|\son[a-z]+="|<style|javascript:/i);
});

test("Marcos's three planner sentences, exactly as written (2026-10-16)", () => {
  const app = read('ts/app.ts');
  assert.ok(page.includes('your calendar keeps the eclipse and rings the alarms. Some calendars, Google Calendar among them, leave out the alarms in a file and use their own reminders instead. EclipseTracker sends nothing and keeps nothing.'));
  assert.ok(page.includes('>Some calendar apps keep only the first three alarms.<'));
  assert.ok(app.includes(', after greatest eclipse. Some calendars leave out an alarm set for after the eclipse begins.'));
});

/** WCAG contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r = 0, g = 0, bl = 0] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi = 0, lo = 0] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('contrast: muted text at least 4.5:1, form field borders at least 3:1 (code review C-2, C-9)', () => {
  const css = read('style.css');
  const token = (name: string): string => group(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'), css);
  // The darkest and lightest backgrounds muted text sits on: the card (rgba(20,20,25,0.65) over
  // #030305) and a year group on it (2% white more), with a margin for the page's faint glow.
  for (const bg of ['#0e0e12', '#131317', '#18181c', '#0e0e13']) {
    assert.ok(contrast(token('text-muted'), bg) >= 4.5, `--text-muted on ${bg}: ${contrast(token('text-muted'), bg).toFixed(2)}`);
  }
  assert.match(css, /select, input\[type="time"\] \{[^}]*border: 1px solid var\(--accent-slate\)/);
  for (const bg of ['#0e0e12', '#08080a', '#0e0e13']) assert.ok(contrast(token('accent-slate'), bg) >= 3, `--accent-slate on ${bg}`);
  // The decorative triangle has empty alternative text (code review C-10).
  assert.match(css, /content: '\\25B8' \/ '';/);
});

// S-1 (17 October 2026): the only JavaScript in the repository is compiled output. Every .js, .mjs
// and .cjs git tracks, or would pick up (untracked and not ignored), is one tools/build-ts.sh
// writes: ts/**/*.ts (not .d.ts) to the same path at the root, and android-bridge.ts to
// android-bridge.js beside it. Each is marked linguist-generated, so GitHub's language bar counts
// none of them. A hand-written script anywhere else (android/web-overlay/extra.js, say) fails here.
// The one other file is cities.js (11 November 2026), the shared Labs city catalogue written by
// SunApp's update_cities.py: generated, marked linguist-generated, and starting with its two
// GENERATED FILE lines. The NASA element files are vendored with .txt names, so no .js is tracked.
test('the only JavaScript is compiled output, each file marked linguist-generated (S-1)', (t) => {
  const root = new URL('../', import.meta.url);
  const git = (...args: string[]): string => execFileSync('git', ['-C', root.pathname, ...args], { encoding: 'utf8' });
  let inGit = false;
  try { inGit = git('rev-parse', '--is-inside-work-tree').trim() === 'true'; } catch { inGit = false; }
  if (!inGit) { t.skip('not a git checkout'); return; }
  const walk = (dir: string): string[] => readdirSync(new URL(dir, root)).flatMap((n) => (n.endsWith('.ts') ? [`${dir}${n}`] : /\./.test(n) ? [] : walk(`${dir}${n}/`)));
  const compiled = [...walk('ts/').filter((f) => !f.endsWith('.d.ts')).map((f) => f.replace(/^ts\//, '').replace(/\.ts$/, '.js')), 'android/web-overlay/android-bridge.js'].sort();
  const allowed = [...compiled, 'cities.js'].sort();
  assert.ok(compiled.includes('app.js') && compiled.includes('core/alarms.js'), 'ts/ compiles to app.js and core/');
  const js = git('ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.js', '*.mjs', '*.cjs').split('\0').filter(Boolean);
  assert.deepEqual([...new Set(js)].sort(), allowed, 'JavaScript in the repository other than the compiled files and cities.js');
  const attrs = git('check-attr', '-z', 'linguist-generated', '--', ...allowed).split('\0');
  for (let i = 0; i + 2 < attrs.length; i += 3) assert.equal(attrs[i + 2], 'true', `${attrs[i]} is linguist-generated`);
  assert.equal(attrs.length - 1, allowed.length * 3);
  assert.match(read('cities.js'), /^\/\/ Stormberry Labs shared city catalogue\.\n\/\/ GENERATED FILE, DO NOT EDIT BY HAND\.\n/);
  // The other generated or vendored files of the city filter are marked as well.
  const marks = (name: string, files: string[]): string[] => git('check-attr', '-z', name, '--', ...files).split('\0').filter((_, i, a) => i % 3 === 2 && i < a.length - 1);
  assert.deepEqual(marks('linguist-generated', ['ts/core/elements.ts', 'tests/search-vectors.json', 'tests/local-vectors.json']), ['true', 'true', 'true']);
  assert.deepEqual(marks('linguist-vendored', ['tools/nasa-elements/JSEX_SE2001.txt', 'tools/nasa-elements/JLEX_LE2001.txt']), ['true', 'true']);
  assert.deepEqual(readdirSync(new URL('../tools/nasa-elements/', import.meta.url)).filter((n) => /\.(m?js|cjs)$/.test(n)), [], 'no .js file among the vendored NASA files');
});


test("the Android app section (2026-10-30): Marcos's sentence, both store buttons, website only", () => {
  const section = group(/(<section class="android-app"[\s\S]*?<\/section>)/, page);
  assert.match(section, /^<section class="android-app" id="android-app" aria-labelledby="android-app-title" data-web-only>/);
  assert.ok(section.includes('<p><strong id="android-app-title">Android app</strong>: the same eclipse list and countdown on your phone, with a calendar file for each eclipse. No internet access.</p>'));
  const links = [...section.matchAll(/<a ([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(links, [
    ['class="btn btn-secondary" href="https://zapstore.dev/apps/no.stormberry.eclipsetracker" target="_blank" rel="noopener"', 'Get the Android app on Zapstore<span class="sr-only"> (opens in a new tab)</span>'],
    ['class="btn btn-secondary" href="https://play.google.com/store/apps/details?id=no.stormberry.eclipsetracker.play" target="_blank" rel="noopener"', 'Get the Android app on Google Play<span class="sr-only"> (opens in a new tab)</span>'],
  ]);
  assert.match(section, /<div class="store-links">/);
  // The last thing in main, and the only part of the page marked website only.
  assert.match(page, /<\/section>\s*<\/main>/);
  assert.ok(page.indexOf(section) > page.indexOf('id="list-heading"'));
  assert.equal([...page.replace(/<!--[\s\S]*?-->/g, '').matchAll(/data-web-only/g)].length, 1);
  // The page's [hidden] rule wins over the section's display rule, so the bridge can hide it.
  assert.match(read('style.css'), /\[hidden\] \{ display: none !important; \}/);
});

// ---- The city filter (11 November 2026) --------------------------------------------------------

test('the chooser is a combobox over a listbox, with a visible status line and a clear button that names itself', () => {
  const card = group(/(<section class="city-card"[\s\S]*?<\/section>)/, page);
  assert.match(card, /<section class="city-card" id="city-card" aria-labelledby="city-heading" hidden>/);
  assert.match(card, /<label for="city-search" class="field-label">Search city or country<\/label>/);
  const input = group(/(<input [^>]*id="city-search"[^>]*>)/, card);
  for (const a of ['type="search"', 'role="combobox"', 'aria-autocomplete="list"', 'aria-controls="city-dropdown"', 'aria-expanded="false"', 'aria-describedby="city-intro city-privacy"', 'autocomplete="off"']) assert.ok(input.includes(a), a);
  assert.match(card, /<ul id="city-dropdown" class="dropdown" role="listbox" aria-label="City suggestions" hidden><\/ul>/);
  assert.match(card, /<button type="button" id="city-clear-btn" class="clear-btn">Clear city<\/button>/);
  assert.match(card, /<p id="city-status" class="city-status" role="status" aria-live="polite"><\/p>/);
  assert.match(card, /<h2 id="city-heading" class="list-heading">Filter by city<\/h2>/);
  assert.match(card, /placeholder="e\.g\. Bergen, Tokyo"/);
  assert.ok(card.includes('A solar eclipse counts as seen when the Sun is above the horizon there during some of it. A lunar eclipse counts as seen when the Moon is above the horizon there while the Earth\'s dark shadow is on it, or, for a faint penumbral eclipse, while the Earth\'s pale outer shadow is on it. The countdown then runs to the moment it starts there: first contact, or sunrise or moonrise if the eclipse is already under way.'));
  assert.ok(card.includes('Worked out for sea level and a flat, clear horizon: hills, buildings and clouds can hide an eclipse, and a time close to sunrise, sunset, moonrise or moonset can be a minute or two out.'));
  // It comes after the countdown card and before the list card, as in MeteorWatch; it is not a .card: the Android bridge puts the app's overview after the first `main .card`, which is the countdown card.
  assert.ok(page.indexOf('id="eclipse-type"') < page.indexOf('id="city-card"'));
  assert.ok(page.indexOf('id="city-card"') < page.indexOf('id="list-heading"'));
  assert.ok(page.indexOf('<section class="card" aria-labelledby="eclipse-type">') < page.indexOf('id="city-card"'), 'the countdown card is the first element with the class card');
  assert.equal(page.slice(page.indexOf('id="eclipse-type"'), page.indexOf('id="city-card"')).match(/<\/section>/g)?.length, 1, 'the city card follows the countdown card at once');
  assert.equal([...page.replace(/<noscript>[\s\S]*?<\/noscript>/, '').matchAll(/class="card[ "]/g)].length, 2, 'the countdown card and the list card are the only cards');
});

test('the footer credits NASA, the Five Millennium Canon elements, GeoNames and Kartverket with the licence, and the page still claims nothing about working offline', () => {
  assert.ok(page.includes('<p>Powered by NASA\'s eclipse catalogue (Fred Espenak, NASA GSFC) and the Five Millennium Canon eclipse elements (Fred Espenak and Jean Meeus), built into the page, and city data from <a href="https://www.geonames.org/" target="_blank" rel="noopener">GeoNames</a> and <a href="https://www.kartverket.no/en/api-and-data" target="_blank" rel="noopener">Kartverket</a> (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC&nbsp;BY&nbsp;4.0</a>). Runs entirely in your browser.</p>'));
  assert.ok(page.includes("Local times for a city: Besselian elements and lunar eclipse elements from the Five Millennium Canons (Fred Espenak and Jean Meeus); Eclipse Predictions by Fred Espenak and Chris O'Byrne (NASA's GSFC)."));
  assert.doesNotMatch(visible, /offline/i);
});

test('the page loads nothing from another host: every script, stylesheet, image and font address is this site\'s own', () => {
  const loaded = [...page.replace(/<!--[\s\S]*?-->/g, '').replace(/<link rel="canonical"[^>]*>/, '').matchAll(/<(?:script|link|img|source|iframe|video|audio)\b[^>]*?\s(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? '');
  assert.ok(loaded.length > 20);
  for (const url of loaded) assert.doesNotMatch(url, /^(?:[a-z]+:)?\/\//i, url);
  // The code makes no network call of its own: no fetch, no XMLHttpRequest, no geolocation, no WebSocket, no sendBeacon.
  for (const f of ['app.js', ...readdirSync(new URL('../core/', import.meta.url)).filter((n) => n.endsWith('.js')).map((n) => `core/${n}`)]) {
    assert.doesNotMatch(read(f), /\bfetch\s*\(|XMLHttpRequest|geolocation|WebSocket|sendBeacon|EventSource/, f);
  }
});

test('the city is kept under one key, only on the website, and only inside try and catch', () => {
  const app = read('ts/app.ts');
  assert.equal([...app.matchAll(/CITY_KEY = '([^']+)'/g)].map((m) => m[1]).join(), 'eclipsetracker.city');
  for (const m of app.matchAll(/window\.localStorage\.\w+\(/g)) {
    const before = app.slice(Math.max(0, m.index - 200), m.index);
    assert.match(before, /try \{/, 'localStorage is touched only inside a try');
  }
  assert.doesNotMatch(app, /sessionStorage|indexedDB|document\.cookie/);
  // The storage calls sit in keepCity and readKeptCity, and keepCity returns before them inside the app.
  assert.match(group(/(function keepCity[\s\S]*?\n\}\n)/, app), /if \(host\) \{[\s\S]*?return true;\s*\}\s*try \{/);
});
