# EclipseTracker

Every solar and lunar eclipse from October 2026 to the end of 2100, from NASA's eclipse catalogue, with a countdown to the next one and alarms you can save to your own calendar.

**Live:** [eclipse.stormberry.as](https://eclipse.stormberry.as)

## Features
- **Every eclipse to 2100**: 337 solar and lunar eclipses (total, annular, hybrid and partial solar; total, partial and penumbral lunar), with the time of greatest eclipse in your own time zone, the magnitude, where it can be seen and, for central solar eclipses, the path. Grouped by year, with a filter by kind and type.
- **Countdown**: to the next eclipse, updated once a second.
- **Alarms**: for any eclipse, one or more alarms: on the day at a time you choose (12:00 unless you change it), 1, 2 or 3 days or a week before at a time you choose, or 15 minutes, 30 minutes, 1 hour or 2 hours before greatest eclipse. You see exactly when each one rings, then save a calendar file (.ics) for your own calendar app, which rings them.
- **Private**: no cookies, no tracking, no request leaves the page, nothing is stored. The page's own Content-Security-Policy allows no connection at all.

## Data
The list comes from Fred Espenak's catalogue at NASA Goddard Space Flight Center (eclipse.gsfc.nasa.gov, public domain): the Five Millennium Canon catalogues for 2001 to 2100 and the decade tables for 2021 to 2100. The pages are archived byte for byte in `tools/nasa/` with their URLs, fetch times and SHA-256 hashes (`tools/nasa/FETCHLOG.tsv`). `tools/build-eclipse-data.py` turns them into `ts/core/data.ts` and `data/eclipses.json`, cross-checking every eclipse between the two sources; the tests count the eclipses per decade against the decade tables. Times are UTC, the catalogue's Terrestrial Dynamical Time minus its own Delta T, shown to the minute.

## Architecture
- **TypeScript**, compiled with a pinned TypeScript 6.0.3 (`package-lock.json`) into the JavaScript the page loads: `ts/app.ts` becomes `app.js`, `ts/core/*.ts` become `core/*.js`. ES modules, no framework, no runtime dependency. The compiled files are committed, because GitHub Pages publishes the repository as it is. Edit `ts/`, never the `.js`.
- `core/` holds pure modules with no DOM (`tsconfig.core.json` type-checks them without the browser's library): the eclipse list, time-zone arithmetic, the alarm planner, the alarm records the Android app will store, and the calendar file. The Android app (in preparation) reuses them, and its Kotlin port must pass the same test vectors (`tests/alarm-vectors.json`, `tests/record-vectors.json`, `tests/dst-vectors.json`).
- Stormberry dark glassmorphism design, Inter typography, locally hosted.

## Development
```bash
tools/build-ts.sh            # compile ts/ and restamp the assets (needs Node 24, npm, python3)
tools/build-ts.sh --check    # fail if the compiled JavaScript, the eclipse list or a ?v= stamp is stale, or a stray .js is left
tools/test-build-check.sh    # prove the check fails on each defect it exists to catch
python3 -I tools/vectors/build-vectors.py --check   # the test vectors against Python's zoneinfo
node --test tests/           # unit tests
node tests/smoke.mjs         # headless Chromium smoke test on a frozen clock (needs /usr/bin/chromium)
python3 tests/serve.py       # serve the site locally with the production headers
```

## Credits
Built by [Stormberry AS](https://stormberry.as). Proudly powered by sovereign AI agents.

## Disclaimer

Supplied free of charge, **as is**, with no warranty of any kind. Using it creates no client or advisory relationship with Stormberry AS, and nothing it produces is professional advice.


This is a **functioning prototype**, not a certified instrument and not a professional service. Values are computed or modelled, not measured. Check anything that matters against an authoritative source before you act on it. Stormberry AS reimburses no cost or loss arising from use of this application.

Full terms: [DISCLAIMER.md](DISCLAIMER.md).
