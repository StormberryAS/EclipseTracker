# EclipseTracker

Every solar and lunar eclipse from October 2026 to the end of 2100, from NASA's eclipse catalogue, with a countdown to the next one and alarms you can save to your own calendar.

**Live:** [eclipse.stormberry.as](https://eclipse.stormberry.as)

## Features
- **Every eclipse to 2100**: 337 solar and lunar eclipses (total, annular, hybrid and partial solar; total, partial and penumbral lunar), with the time of greatest eclipse in your own time zone, the magnitude, where it can be seen and, for central solar eclipses, the path. Grouped by year, with a filter by kind and type.
- **Countdown**: to the next eclipse, updated once a second.
- **Alarms**: for any eclipse, one or more alarms: on the day at a time you choose (12:00 unless you change it), 1, 2 or 3 days or a week before at a time you choose, or 15 minutes, 30 minutes, 1 hour or 2 hours before greatest eclipse. You see exactly when each one rings, then save a calendar file (.ics) for your own calendar app, which rings them.
- **Filter by city, if you want it**: choose a city by hand from the built-in city list (no GPS, no location permission, no network) and the countdown and the list show only the eclipses that can be seen from there, with every time in that city's time zone. The countdown then runs to the moment the eclipse starts there: first contact, or sunrise or moonrise if it is already under way. The alarm planner and the calendar file count from that moment too, and the file names the city. In the planner, the first alarm is set for the day before at 12:00 when the eclipse starts at the city before 12:00 local time, and for the day itself at 12:00 otherwise. A penumbral lunar eclipse counts when the Moon is up at some moment of its penumbral phase, and the page says it is faint. The rule is worked out for sea level and a flat, clear horizon: hills, buildings and clouds can hide an eclipse, and a time close to sunrise, sunset, moonrise or moonset can be a minute or two out. With no city chosen the page is as before and counts down to greatest eclipse.
- **Private**: no cookies, no tracking, no request leaves the page. Nothing is stored unless you choose a city: then, on the website, that one city (its name, country, coordinates and time zone from the city list) is kept in this browser's localStorage under `eclipsetracker.city` (the same record as MeteorWatch keeps under `meteorwatch.city`: `v` 1, name, country, latitude, longitude and time zone), never sent anywhere, and removed with the Clear city button. The Android app stores nothing on the page's side. The page's own Content-Security-Policy allows no connection at all.

## Data
The list comes from Fred Espenak's catalogue at NASA Goddard Space Flight Center (eclipse.gsfc.nasa.gov, free to reproduce with an acknowledgment): the Five Millennium Canon catalogues for 2001 to 2100 and the decade tables for 2021 to 2100. The pages are archived byte for byte in `tools/nasa/` with their URLs, fetch times and SHA-256 hashes (`tools/nasa/FETCHLOG.tsv`). `tools/build-eclipse-data.py` turns them into `ts/core/data.ts` and `data/eclipses.json`, cross-checking every eclipse between the two sources; the tests count the eclipses per decade against the decade tables. Times are UTC, the catalogue's Terrestrial Dynamical Time minus its own Delta T, shown to the minute.

### Local circumstances

With a city chosen, the page works out each eclipse as seen from there (`ts/core/local.ts`, pure functions with no DOM). The solar part uses NASA's Besselian elements (Fred Espenak and Jean Meeus, Five Millennium Canon of Solar Eclipses) and the standard method: the observer on the fundamental plane, the penumbral and umbral cone radii there, and the four contacts. The lunar part uses NASA's lunar eclipse elements (contact times and the Moon's position). The Sun counts as up above -0.833 degrees and the Moon when its upper limb is above the refracted horizon; a window is sampled every 60 s and narrowed to 1 s. Where the body sets and rises again inside one eclipse (66 degrees of latitude or more) the start is the first moment it is up, the end the last, the maximum is the moment of greatest eclipse if the body is up then and else the end of an up stretch nearest to it, and the page says the body sets and rises again. The element files are archived byte for byte in `tools/nasa-elements/` (with `.txt` names, so that no JavaScript is tracked) and `tools/build-local-elements.py` writes `ts/core/elements.ts` from them after checking every set against the eclipse list (date, time of greatest eclipse, Delta T, type, magnitudes, contacts and the durations in the archived catalogue). `tools/vectors/build-local-vectors.py` is a separate Python implementation of the method (it shares the element parser and the T0 rule with `tools/build-local-elements.py`) that writes `tests/local-vectors.json` (16 cities, all 337 eclipses); `tests/local.test.ts` replays it, and also checks NASA's own catalogue values and the table of cities published for the total eclipse of 2026-08-12. The program code of NASA's explorers (GPL) is not used: only its published numbers.

The city list is the shared Stormberry Labs catalogue, `cities.js` (25,007 cities), written by SunApp's `update_cities.py` and copied here byte for byte; the page adds it only when the city chooser is first used, and decodes it only when the first search reads it. The search is MoonApp's (`ts/core/citysearch.ts`), checked against MoonApp's 162 captured results.

## Architecture
- **TypeScript**, compiled with a pinned TypeScript 6.0.3 (`package-lock.json`) into the JavaScript the page loads: `ts/app.ts` becomes `app.js`, `ts/core/*.ts` become `core/*.js`. ES modules, no framework, no runtime dependency. The compiled files are committed, because GitHub Pages publishes the repository as it is. Edit `ts/`, never the `.js`.
- The Android app's bridge script is TypeScript too: `android/web-overlay/android-bridge.ts`, a classic script (the app injects it with a plain script tag), compiled to `android-bridge.js` beside it, which the app bundles. Its contract with the page is `ts/app-host.d.ts`, which both sides are type-checked against.
- **Tests in TypeScript**, run by Node 24 directly (its built-in type stripping, so erasable syntax only) and type-checked by `tsc -p tests/tsconfig.json` (strict). They import the compiled `core/*.js` the page runs through `#core/*.js` (package.json `imports`), which tsc types from `ts/core/*.ts`. Node's built-ins are typed by `@types/node`, pinned to Node 24's line (24.19.2) in `package-lock.json`, and the tests have no DOM library; `package.json` asks for Node 24 or later (`engines`).
- `core/` holds pure modules with no DOM (`tsconfig.core.json` type-checks them without the browser's library): the eclipse list, time-zone arithmetic, the alarm planner, the alarm records the Android app will store, and the calendar file. The Android app reuses them, and its Kotlin port must pass the same test vectors (`tests/alarm-vectors.json`, `tests/record-vectors.json`, `tests/dst-vectors.json`).
- Stormberry dark glassmorphism design, Inter typography, locally hosted.

## Android app

The Android app (package `no.stormberry.eclipsetracker`) runs the same files as the website, bundled inside it, offline, in a WebView, and adds alarms that the phone rings itself, worked out by a Kotlin port of `core/alarms.ts` that passes the same test vectors. Each `android-v*` tag runs the release workflow, which publishes `eclipsetracker-v<version>.apk` on this repository's releases page with a `.sha256` file and a build provenance attestation. The release is then listed on Zapstore. 2.0.0 is the first Android release.

### Nine permissions, all for the ringing alarms

```bash
aapt dump permissions eclipsetracker-v2.0.0.apk
```

| Permission | Why |
|-|-|
| `USE_EXACT_ALARM` (Android 13 and later), `SCHEDULE_EXACT_ALARM` (Android 12 and 12L only) | to ring at the minute chosen |
| `POST_NOTIFICATIONS` | the ringing alarm and the snoozed and missed notices; asked once, on Android 13 and later, when ringing alarms are first set |
| `USE_FULL_SCREEN_INTENT` | the ring screen over the lock screen |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SYSTEM_EXEMPTED` | to keep an alarm ringing until it is stopped, for up to 10 minutes |
| `WAKE_LOCK` | to keep the phone awake while an alarm starts |
| `VIBRATE` | to vibrate while it rings |
| `RECEIVE_BOOT_COMPLETED` | to set the alarms again after a restart |

There is no internet permission, no location permission (the time zone comes from the phone's settings) and no calendar or storage permission: Add to calendar hands the calendar file to the calendar app through Android. The app stores only the alarms and what it needs to ring them, in its own storage, with backup off; each is removed once it has rung, or at the latest 48 hours after its eclipse. `android/expected-permissions.txt` holds the list, and the build and the release workflow both fail if the APK asks for one more or one fewer.

### Verify a release

```bash
sha256sum -c eclipsetracker-v2.0.0.apk.sha256
apksigner verify --print-certs eclipsetracker-v2.0.0.apk
gh attestation verify eclipsetracker-v2.0.0.apk -R StormberryAS/EclipseTracker
```

**Signing certificate SHA-256:** `0d7d023957a40dc8471e9c476eb1468b05604c3634c5b4c440971145fcbe2ae4`

The release workflow (`.github/workflows/android-release.yml`, started by `android-v*` tags only) builds the APK unsigned in a job that holds no key. A second job, which runs no Gradle, checks that APK before the key is decoded: exactly the permissions in `android/expected-permissions.txt`, not debuggable, the version the tag names, every bundled web file byte for byte the tagged commit's, and the licence texts. Only then does it align the APK and sign it with apksigner, and it refuses to publish unless there is exactly one signer, with the certificate above. Each release also waits for an approval on GitHub before the key is used.

### Reproducible build

The build is reproducible: the same commit gives the same APK, byte for byte. To check a release against its tag, build it unsigned, sign it with a key of your own the way the workflow signs, and compare the two with their signatures taken out (`android/tools/apk-without-signature.ts`, run by Node 24):

```bash
git clone https://github.com/StormberryAS/EclipseTracker.git
cd EclipseTracker && git checkout android-v2.0.0
cd android && ./gradlew --no-daemon -PunsignedRelease=true :app:assembleRelease
BT="$ANDROID_HOME/build-tools/36.0.0"
"$BT/zipalign" -f 4 app/build/outputs/apk/release/app-release-unsigned.apk aligned.apk
keytool -genkeypair -keystore mine.p12 -storetype PKCS12 -alias mine -keyalg RSA -keysize 4096 -validity 1 -dname CN=mine
"$BT/apksigner" sign --ks mine.p12 --ks-key-alias mine \
  --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled false \
  --out mine.apk aligned.apk
cd .. && node android/tools/apk-without-signature.ts android/mine.apk /path/to/eclipsetracker-v2.0.0.apk
```

The two lines must show the same SHA-256. Use JDK 21, as the workflow does (Temurin 21), and a 4096-bit key as above, the size of the release key, so the signing block takes the same room.

### Build from source

Requirements: JDK 21 and the Android SDK with platform 37.1 and build-tools 36.0.0. From `android/`:

```bash
./gradlew :app:testDebugUnitTest :app:assembleDebug   # unit tests and a debug APK
./gradlew :app:verifyWebAssets                         # prove the bundled web files match
```

The app bundles an explicit list of web files (`WebAssets.INCLUDES` in `android/app/build.gradle.kts`): the page, its modules, the style sheet, the disclaimer, the fonts, the carousel icons and `data/eclipses.json`, which the alarm engine reads. Every build checks that each bundled file is byte for byte the one GitHub Pages publishes (apart from one line in `index.html` that loads `android/web-overlay/android-bridge.js`), that every file the page refers to is bundled, and that nothing else is; a release build also checks them against the commit `HEAD` points at. `fastlane/`, `zapstore.yaml` and this README are never bundled.

A signed release needs the release key, which never enters this repository: the release workflow signs with apksigner from the `release` environment's secrets.

### Google Play edition, without ringing alarms

Since 2.0.1 the same source also builds a Google Play edition, a separate package, `no.stormberry.eclipsetracker.play`. It has the eclipse list, the countdown, the filters and the calendar file (Save the calendar file, and Add to calendar, which hands the file to your calendar app), and no ringing alarms: no alarm permission, no alarm component and none of the alarm engine (the app only reads and refuses alarm messages), so it asks for no permission at all and, like the full app, has no internet permission. Alarms in a calendar file are rung by your calendar app; some calendar apps, Google Calendar among them, leave them out and use their own reminders instead. The full app, with ringing alarms, stays on Zapstore and GitHub Releases as `no.stormberry.eclipsetracker`. The two packages install side by side and neither can update the other.

```bash
./gradlew --no-configuration-cache :app:bundleRelease -PplayBuild=true   # needs the Play upload key (PLAY_UPLOAD_*)
```

- `android/app/src/play/AndroidManifest.xml`, merged over the main manifest, removes the nine permissions and the four alarm components; `PlayManifestTest` fails when main names a permission or component the overlay does not remove.
- `Edition.ALARMS` (`android/app/src/sovereign/kotlin` or `android/app/src/play/kotlin`) is a compile-time constant: false in the Play edition, so every alarm hook in `MainActivity` is dead code that R8 deletes with the alarm package. Should the page ask for alarms anyway, the app answers no (`AlarmFreeBridge.kt`).
- The bridge script learns the edition from the line the build injects into `index.html` (`data-edition="play"`) and then adds only Add to calendar; the page keeps the website's wording.
- The build refuses a release bundle without `-PplayBuild=true` or without a complete upload key, a release APK with `-PplayBuild=true`, an upload key that is the release key, and an upload password with the configuration cache on. Google re-signs the bundle with an app signing key it holds; the upload key (certificate SHA-256 `a6d1575aef50e2de85d8e01f8f882fcc205d83c0ab097e75e995c8e048d7f9a6`) only proves who uploaded it.

Every Play bundle is built from a sovereign release tag that shipped on GitHub Releases. Play shows the same version name; its versionCode is 1,000,000 plus the sovereign one. The offset is a million, not the 1000 of the other Stormberry apps, because sovereign codes here are major * 10000 + minor * 100 + patch, so 1000 + 20001 would read like a future sovereign 2.10.1.

| Sovereign tag | Sovereign versionCode | Play versionName | Play versionCode |
|-|-|-|-|
| `android-v2.0.1` | 20001 | 2.0.1 | 1020001 |

## Development
```bash
tools/build-ts.sh            # compile ts/ and the Android bridge script, type-check the tests, restamp the assets (needs Node 24, npm, python3)
tools/build-ts.sh --check    # fail if the compiled JavaScript (the bridge's included), the eclipse list or a ?v= stamp is stale, a stray .js is left, or a test does not type-check
tools/test-build-check.sh    # prove the check fails on each defect it exists to catch
python3 -I tools/vectors/build-vectors.py --check   # the test vectors against Python's zoneinfo
python3 -I tools/build-local-elements.py --check    # ts/core/elements.ts against the NASA element files in tools/nasa-elements/
python3 -I tools/vectors/build-local-vectors.py --check   # tests/local-vectors.json against the separate Python implementation
python3 -I tools/check-city-catalogue.py            # cities.js: header, 25,007 rows, byte for byte SunApp's copy when it is beside this one
node --test tests/*.test.ts  # unit tests (npm test)
node tests/smoke.ts          # headless Chromium smoke test on a frozen clock (needs /usr/bin/chromium)
node tests/app-mode-smoke.ts # the page as the Android app loads it, with the bridge script
python3 tests/serve.py       # serve the site locally with the production headers
```

## Credits
Built by [Stormberry AS](https://stormberry.as). Proudly powered by sovereign AI agents.

| Project | What it provides | Licence |
|---|---|---|
| [GeoNames](https://www.geonames.org/) and [Kartverket](https://www.kartverket.no/en/api-and-data) | The city catalogue (`cities.js`) | CC BY 4.0 |
| Fred Espenak, NASA's Goddard Space Flight Center | The eclipse catalogue and decade tables (`tools/nasa/`) | Free to reproduce with the acknowledgment NASA asks for |
| Fred Espenak, Jean Meeus and Chris O'Byrne, NASA's GSFC | Eclipse elements for local circumstances (`tools/nasa-elements/`): Besselian elements of the solar eclipses and lunar eclipse elements, from the Five Millennium Canons | Free to reproduce with the acknowledgment NASA asks for: "Eclipse Predictions by Fred Espenak and Chris O'Byrne (NASA's GSFC)" |
| [Inter](https://rsms.me/inter/) | The typeface | SIL OFL 1.1 |

## Disclaimer

Supplied free of charge, **as is**, with no warranty of any kind. Using it creates no client or advisory relationship with Stormberry AS, and nothing it produces is professional advice.


This is a **functioning prototype**, not a certified instrument and not a professional service. Values are computed or modelled, not measured. Check anything that matters against an authoritative source before you act on it. Stormberry AS reimburses no cost or loss arising from use of this application.

Full terms: [DISCLAIMER.md](DISCLAIMER.md).
