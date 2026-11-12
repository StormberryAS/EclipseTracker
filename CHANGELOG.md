# Changelog

EclipseTracker for Android, newest first. The release text of each version, which GitHub Releases and Zapstore show, is in `fastlane/metadata/android/en-US/changelogs/<versionCode>.txt`. The website, eclipse.stormberry.as, is published from the same repository.

## 2.1.0 (versionCode 20100)

- New, in both editions: Filter by city. Choose a city by hand from the built-in list (the shared Stormberry Labs catalogue, 25,007 cities, city data from GeoNames and Kartverket under CC BY 4.0). The countdown and the list then show only the eclipses that can be seen from there, with the time each starts there in that city's time zone, and the planner and the calendar file count from that start. The app keeps the city in its own preferences, left out of backups, not in the page: the WebView still has no storage. Clear city forgets it.
- Ringing alarms with a city (the app from Zapstore and GitHub): an alarm set while a city is chosen rings at its time in that city, wherever the phone is, and its words name the city. Alarms set before 2.1.0, or with no city chosen, are unchanged and still follow the phone's time zone.
- The Google Play edition (versionCode 1020100) has the city filter and the city calendar file, and still no ringing alarms and no permissions.
- The app now bundles the city list and the eclipse elements for local times, about 420 KB more. The release workflow's list of expected web files now names `cities.js`, and a test makes it equal to `WebAssets.INCLUDES`.

## 2.0.1 (versionCode 20001)

- The app you install from Zapstore or GitHub is unchanged apart from the version: the same eclipse list, countdown, ringing alarms and screens as 2.0.0, and the same nine permissions (`android/expected-permissions.txt`). No internet permission.
- New: a Google Play edition built from the same source with `-PplayBuild=true`, as the package `no.stormberry.eclipsetracker.play` (versionName 2.0.1, versionCode 1020001). It keeps the eclipse list, the countdown, the filters and the calendar file (Save the calendar file and Add to calendar) and has no ringing alarms, so it asks for no permission at all. A manifest overlay (`android/app/src/play/AndroidManifest.xml`) removes the nine alarm permissions and the four alarm components, a compile-time switch (`Edition.ALARMS`) turns off every alarm hook so the build leaves the alarm package out, and the bridge script, told the edition by the line the build injects, adds only Add to calendar and a closing sentence in the planner that says the app keeps the last file added to the calendar until it next starts afresh. The Play version line is in `README.md`.
- The build refuses a release bundle without `-PplayBuild=true` and a complete Play upload key, a release APK with it, an upload key that is the release key, and a Play upload password with the configuration cache on.
- The bundled eclipse list is read outside the alarm package (`core/BundledCatalogue.kt`), so the Play edition does not need that package.

## 2.0.0 (versionCode 20000), 2026-10-17

First Android release. EclipseTracker lists every solar and lunar eclipse to the end of 2100 from NASA's catalogue, counts down to the next one, and sets alarms for any of them: on the day or up to a week before at a time you choose, or up to 2 hours before greatest eclipse. The phone rings them itself, over the lock screen, or hands a calendar file to your calendar app. Nine permissions, all for the alarms. No internet access.
