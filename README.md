# EclipseTracker

Deterministic offline eclipse dashboard. EclipseTracker provides countdowns, magnitude, and path information for upcoming solar and lunar eclipses using an embedded astronomical dataset.

**Live:** [eclipse.stormberry.as](https://eclipse.stormberry.as)

## Features
- **Eclipse database**: embedded dates, types, and primary visibility regions for all major upcoming eclipses.
- **Offline countdown**: real-time countdown to the next solar and lunar events calculated locally in your browser.
- **Responsive layout**: optimised for mobile and desktop with a cinematic "diamond ring" monochrome glassmorphism theme.

## Architecture
- **Vanilla HTML/CSS/JS**, no frameworks, no build step.
- **Privacy first**, no cookies, no tracking. Zero external API calls.
- Stormberry dark-mode glassmorphism design system, Inter typography.
- **Sovereign AI**, built and maintained using high-speed agentic workflows.

## Stack
- Browser `Date` for real-time countdown calculations.
- Hardcoded localized astronomical dataset (NASA eclipse tables).
- [Inter](https://rsms.me/inter/) typeface, locally hosted.

## Local development
```bash
git clone https://github.com/StormberryAS/EclipseTracker.git
cd EclipseTracker
python3 -m http.server 3003
```
Open `http://localhost:3003` in your browser.

## Credits
Built by [Stormberry AS](https://stormberry.as). Proudly powered by sovereign AI agents.
