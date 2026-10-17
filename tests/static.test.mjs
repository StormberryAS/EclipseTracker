// The page and the publishing set-up: the house style of the page text, the module script, the
// cache stamps, and the _config.yml exclusions that keep sources, tooling and tests off the site.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
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
  assert.match(scripts[0], /^<script type="module" src="app\.js\?v=[0-9a-f]{8}">$/);
  assert.match(page, /href="style\.css\?v=[0-9a-f]{8}"/);
  assert.doesNotMatch(page, /src="ts\//);
});

test('every relative import in the compiled JavaScript carries a ?v= stamp', () => {
  const files = ['app.js', ...readdirSync(new URL('../core/', import.meta.url)).filter((n) => n.endsWith('.js')).map((n) => `core/${n}`)];
  assert.ok(files.length >= 8);
  for (const f of files) {
    const text = read(f);
    for (const m of text.matchAll(/\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g)) assert.match(m[1], /\.js\?v=[0-9a-f]{8}$/, `${f}: ${m[1]}`);
  }
});

test('_config.yml keeps sources, tooling and tests off the site, and publishes the app', () => {
  const cfg = read('_config.yml');
  const excluded = [...cfg.matchAll(/^ {2}- (\S+)$/gm)].map((m) => m[1]);
  for (const x of ['ts/', 'tools/', 'tests/', 'node_modules/', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.core.json', '.npmrc', 'bump_assets.py', 'README.md', 'DISCLAIMER.md', 'LICENSE', 'android/']) {
    assert.ok(excluded.includes(x), `${x} is excluded`);
  }
  for (const x of ['core/', 'data/', 'app.js', 'index.html', 'style.css', 'disclaimer.html']) assert.ok(!excluded.includes(x), `${x} is published`);
});

test('the TypeScript set-up follows the Website: TypeScript 6.0.3 pinned, strict, ES modules', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.devDependencies, { typescript: '6.0.3' });
  assert.equal(pkg.type, 'module');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.packages['node_modules/typescript'].version, '6.0.3');
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
});

test("the page's own policy: nothing but its own files, no connection, no referrer (code review C-5)", () => {
  const metas = [...page.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/g)].map((m) => m[1]);
  assert.equal(metas.length, 1);
  const policy = Object.fromEntries(metas[0].split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
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
function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('contrast: muted text at least 4.5:1, form field borders at least 3:1 (code review C-2, C-9)', () => {
  const css = read('style.css');
  const token = (name) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)[1];
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
