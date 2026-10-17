// The Android app's files that touch the website (spec section 9, stage B), checked from Node with
// the rest of the unit tests: the policy header the app sends is the page's own policy plus the
// two directives only a header can carry; the permissions are exactly the nine of
// android/expected-permissions.txt, never INTERNET; backup is off and only the launcher is
// exported; the bridge script keeps the page's privacy (no fetch, no storage) and the house style;
// the travel note is Marcos's text exactly, in the app only; and the website's own files know
// nothing of the app's words.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const KT = 'android/app/src/main/kotlin/no/stormberry/eclipsetracker';
const A4 = "Ringing alarms follow your phone's time zone: if you travel, a 12.00 alarm rings at 12.00 where you are. Alarms before greatest eclipse always follow the eclipse.";

test("the app's policy header is the page's meta policy plus frame-ancestors and upgrade-insecure-requests", () => {
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(read('index.html'))[1];
  const kt = read(`${KT}/web/ResponseHeaders.kt`);
  const header = /CONTENT_SECURITY_POLICY =\s*([\s\S]*?)\n\n/.exec(kt)[1].match(/"([^"]*)"/g).map((s) => s.slice(1, -1)).join('');
  assert.equal(header, `${meta}; frame-ancestors 'none'; upgrade-insecure-requests`);
  assert.match(header, /connect-src 'none'/);
});

test("fix C, M-1: the disclaimer's one style element is allowed by its hash, on the disclaimer's response only", () => {
  const html = read('disclaimer.html');
  const blocks = [...html.matchAll(/<style(\s[^>]*)?>([\s\S]*?)<\/style>/gi)];
  assert.equal(blocks.length, 1, 'one style element');
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'no style attribute');
  assert.doesNotMatch(html, /<script\b/i, 'no script');
  const hash = `sha256-${createHash('sha256').update(blocks[0][2], 'utf8').digest('base64')}`;
  const kt = read(`${KT}/web/ResponseHeaders.kt`);
  assert.equal(/DISCLAIMER_STYLE_HASH = "([^"]+)"/.exec(kt)[1], hash, 'ResponseHeaders.DISCLAIMER_STYLE_HASH is the hash of the style element');
  assert.match(kt, /DISCLAIMER_ASSET = "web\/disclaimer\.html"/);
  assert.match(kt, /CONTENT_SECURITY_POLICY\.replace\("style-src 'self';", "style-src 'self' '\$DISCLAIMER_STYLE_HASH';"\)/);
  assert.match(read(`${KT}/web/WebAssetHandler.kt`), /ResponseHeaders\.forAsset\(assetPath\)/);
  // The website's disclaimer is the house file, untouched: no policy of its own, nothing of the app's.
  assert.doesNotMatch(html, /Content-Security-Policy|sha256-|android/i);
});

test('fix C, S-2: the app enlarges text with a larger default font size, not textZoom', () => {
  const ts = read(`${KT}/web/TextScale.kt`);
  assert.match(ts, /const val BASE_FONT_PX = 16\n/);
  assert.match(ts, /const val BASE_FIXED_FONT_PX = 13\n/);
  const main = read(`${KT}/MainActivity.kt`);
  assert.match(main, /textZoom = 100\n\s*defaultFontSize = TextScale\.defaultFontSize\(scale\)/);
  assert.match(main, /textZoom = TextScale\.sidePageTextZoom\(scale\)/, 'the disclaimer keeps the text zoom');
  assert.doesNotMatch(main, /fontScale \* 100/);
});

test('exactly the nine alarm permissions, never INTERNET', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml').replace(/<!--[\s\S]*?-->/g, '');
  const asked = [...manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"(?![^>]*tools:node="remove")[^>]*\/>/g)].map((m) => m[1]).sort();
  const removed = [...manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"\s+tools:node="remove"/g)].map((m) => m[1]);
  const expected = [...read('android/expected-permissions.txt').matchAll(/^uses-permission: name='([^']+)'/gm)].map((m) => m[1]).sort();
  assert.deepEqual(asked, expected);
  assert.equal(expected.length, 9);
  assert.deepEqual(expected, [
    'android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_SYSTEM_EXEMPTED', 'android.permission.POST_NOTIFICATIONS',
    'android.permission.RECEIVE_BOOT_COMPLETED', 'android.permission.SCHEDULE_EXACT_ALARM', 'android.permission.USE_EXACT_ALARM',
    'android.permission.USE_FULL_SCREEN_INTENT', 'android.permission.VIBRATE', 'android.permission.WAKE_LOCK',
  ]);
  assert.match(read('android/expected-permissions.txt'), /^package: no\.stormberry\.eclipsetracker$/m);
  assert.match(read('android/expected-permissions.txt'), /SCHEDULE_EXACT_ALARM' maxSdkVersion='32'$/m);
  for (const p of ['android.permission.INTERNET', 'android.permission.ACCESS_NETWORK_STATE', 'android.permission.READ_CALENDAR', 'android.permission.WRITE_CALENDAR']) {
    assert.ok(removed.includes(p), `${p} is stripped if a library merges it in`);
  }
  assert.match(manifest, /android:maxSdkVersion="32"/);
  assert.match(manifest, /android:foregroundServiceType="systemExempted"/);
});

test('no backup, and only the launcher is exported', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml').replace(/<!--[\s\S]*?-->/g, '');
  assert.match(manifest, /<application[^>]*android:allowBackup="false"/);
  const exported = [...manifest.matchAll(/<(activity|service|receiver|provider)\s+android:name="([^"]+)"[^>]*android:exported="true"/g)].map((m) => m[2]);
  assert.deepEqual(exported, ['.MainActivity']);
  for (const f of ['backup_rules.xml', 'data_extraction_rules.xml']) {
    const x = read(`android/app/src/main/res/xml/${f}`);
    assert.match(x, /domain="root"/);
    assert.match(x, /domain="device_root"/, `${f}: the device-protected alarm records are excluded too`);
  }
  assert.match(read('android/app/src/main/res/xml/calendar_paths.xml'), /<cache-path name="calendar" path="calendar\/" \/>/);
});

test('the bridge script keeps the page private and is the only channel', () => {
  const js = read('android/web-overlay/android-bridge.js');
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const bad of [/\bfetch\s*\(/, /XMLHttpRequest/, /localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /\beval\s*\(/, /new Function/, /innerHTML/, /addJavascriptInterface/]) {
    assert.doesNotMatch(code, bad);
  }
  assert.match(code, /window\.ETBridge/);
  assert.match(read(`${KT}/MainActivity.kt`), /BRIDGE_NAME = "ETBridge"/);
  assert.match(code, /window\.EclipseTrackerApp = Object\.freeze/);
});

test("the travel note is Marcos's text exactly, and only in the app", () => {
  const js = read('android/web-overlay/android-bridge.js');
  assert.ok(js.includes(`TRAVEL: "${A4}"`));
  for (const f of ['index.html', 'app.js', 'ts/app.ts', 'style.css']) {
    assert.ok(!read(f).includes('Ringing alarms follow'), `${f} does not carry the app's travel note`);
    assert.ok(!read(f).includes('Set ringing alarms'), `${f} does not carry the app's words`);
  }
});

test("the app's own words keep the house style", () => {
  const js = read('android/web-overlay/android-bridge.js');
  const words = /var T = \{([\s\S]*?)\n {2}\};/.exec(js)[1];
  const strings = [...words.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]).filter((s) => / /.test(s));
  assert.ok(strings.length >= 20, `${strings.length} texts`);
  const xml = read('android/app/src/main/res/values/strings.xml').replace(/<!--[\s\S]*?-->/g, '');
  const res = [...xml.matchAll(/<string name="([^"]+)">([^<]*)<\/string>/g)].map((m) => [m[1], m[2]]);
  assert.ok(res.length >= 14);
  for (const s of [...strings, ...res.map((r) => r[1])]) {
    assert.doesNotMatch(s, /[–—!]|--/, s);
    assert.doesNotMatch(s, /\b(color|center|organize|canceled)\b/i, `${s}: British English`);
  }
  for (const [name, text] of res.filter(([n]) => ['no_app_for_link', 'page_reloaded'].includes(n))) {
    assert.ok(text.length <= 66, `${name}: a toast of at most 66 characters`);
  }
});

test('the alarm engine never rings late and arms the nearest 100 (the numbers the spec gives)', () => {
  const sched = read(`${KT}/alarm/AlarmScheduler.kt`);
  assert.match(sched, /const val MAX_ARMED = 100/);
  const planner = read(`${KT}/core/Alarms.kt`);
  assert.match(planner, /RECORD_GRACE_MS = 48L \* 3_600_000L/);
  assert.match(planner, /Math\.floorDiv\(Instant\.parse\(greatest\)\.toEpochMilli\(\) \+ 30_000L, MINUTE\) \* MINUTE/);
  assert.match(planner, /withEarlierOffsetAtOverlap/);
  assert.match(read(`${KT}/alarm/AlarmScheduling.kt`), /setAlarmClock/);
  assert.match(read(`${KT}/alarm/AlarmScheduling.kt`), /createDeviceProtectedStorageContext/);
  assert.match(read(`${KT}/alarm/AlarmService.kt`), /isLooping = true/);
  assert.match(read(`${KT}/alarm/AlarmService.kt`), /setFullScreenIntent/);
});
