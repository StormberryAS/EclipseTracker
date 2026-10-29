import java.io.File
import java.io.FileInputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.util.Base64
import java.util.Properties
import javax.inject.Inject

plugins {
    alias(libs.plugins.android.application)
}

// EclipseTracker for Android (spec section 9, stage B, built 16 October 2026). Copied from
// GDPRLetterBuilder's android/app/build.gradle.kts (the WebView template: the web app bundled
// byte for byte, the signing guards, the reproducible unsigned release, the merged-manifest
// checks) and changed where this app differs: it rings alarms, so it declares exactly the
// permissions in android/expected-permissions.txt instead of none; it uses java.time through
// SunApp's library desugaring; and it bundles data/eclipses.json for its native alarm engine.

// Signing credentials never live in this repo. android/keystore.properties (gitignored)
// names the key file, its type and the alias, and deliberately holds NO passwords: those
// come from the RELEASE_STORE_PASSWORD and RELEASE_KEY_PASSWORD Gradle properties, which
// Gradle also reads from ORG_GRADLE_PROJECT_* env vars (CI) and which a local build passes
// as env vars read from the keyring. Missing credentials must not break assembleDebug, so
// everything below is optional. The release key is ~/.android-keys/stormberry-eclipsetracker-release.p12
// (created 17 October 2026, certificate SHA-256 0d7d0239...2ae4); the release workflow signs the
// unsigned APK with apksigner from the release environment's secrets, never through Gradle.
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) FileInputStream(keystorePropertiesFile).use { load(it) }
}

fun signingValue(propKey: String, gradleKey: String): String? =
    keystoreProperties.getProperty(propKey)
        ?: providers.gradleProperty(gradleKey).orNull
        ?: providers.environmentVariable(gradleKey).orNull

val releaseStoreFile = signingValue("storeFile", "RELEASE_STORE_FILE")
val releaseStoreType = signingValue("storeType", "RELEASE_STORE_TYPE")
val releaseStorePassword = signingValue("storePassword", "RELEASE_STORE_PASSWORD")
val releaseKeyAlias = signingValue("keyAlias", "RELEASE_KEY_ALIAS")
val releaseKeyPassword = signingValue("keyPassword", "RELEASE_KEY_PASSWORD")
val canSignRelease = releaseStoreFile != null && file(releaseStoreFile).exists() &&
    releaseStorePassword != null && releaseKeyAlias != null && releaseKeyPassword != null

// THE GOOGLE PLAY EDITION (EclipseTracker 2.0.1, 29 October 2026; MoonApp's and SunApp's pattern of
// 25 October 2026). Google Play is a SEPARATE package, deliberately: `no.stormberry.eclipsetracker`
// stays the sovereign build (our key, our certificate, GitHub Releases and Zapstore, with the NIP-C1
// certificate link vouching for it), and `-PplayBuild=true` builds `no.stormberry.eclipsetracker.play`
// instead, which Google re-signs with an app signing key it holds. Two package names are two apps to
// Android: they install side by side and neither can ever update the other, so nothing that happens
// on Play can reach a Zapstore install.
//
// THE PLAY EDITION HAS NO RINGING ALARMS (Marcos, 2026-10-29: "prepare eclipsetracker on play without
// alarms, it's not a problem that google calendar ignores alarms, it is what it is"). The ringing
// alarms need USE_EXACT_ALARM, USE_FULL_SCREEN_INTENT and a foreground service of type
// systemExempted, each a Play review gate of its own (a declaration form, a video, an "up to several
// weeks" extended review). The Play package keeps the eclipse list, the countdown and the calendar
// file (Save the calendar file and Add to calendar, which need no permission) and ships with no
// permission at all. Three switches do it, and there are no product flavours (a flavour-level
// signingConfig is overridden by the build type's, and a flavour dimension renames every task and
// breaks the workflow's APK paths and the Zapstore regex):
//   1. src/play/AndroidManifest.xml, merged over the main manifest, removes the nine alarm
//      permissions and the four alarm components with tools:node="remove" (PlayManifestTest pins it
//      against main, so an alarm permission added later cannot reach Play unnoticed);
//   2. Edition.ALARMS, a compile-time constant (src/play/kotlin or src/sovereign/kotlin), switches off
//      every alarm hook in MainActivity, and R8 then drops the alarm package it can no longer reach;
//   3. the bridge script learns the edition from the one line the build injects into index.html
//      (WebAssets.injectedTag: data-edition="play"), and in the Play edition adds Add to calendar
//      only: no Set ringing alarms, no overview, no app travel note, no notification request.
// src/play/res overrides the one in-app sentence of main that speaks of ringing alarms (a toast).
val playBuild = when (providers.gradleProperty("playBuild").orNull?.lowercase()) {
    null -> false
    // A bare `-PplayBuild` arrives as an empty string. Treating that as false would hand back a
    // sovereign artefact from a command that plainly meant Play.
    "", "true", "1", "yes" -> true
    "false", "0", "no" -> false
    else -> error(
        "-PplayBuild=${providers.gradleProperty("playBuild").orNull} is not a recognised " +
            "value. Use -PplayBuild=true, or omit the property for the sovereign build.",
    )
}

// The Play upload key is a separate key with a separate job: it proves who uploaded the bundle and
// never reaches a device, so it must never be the release key. If it is ever compromised it can be
// reset from the Play Console without touching a single install. keystore.properties (or the
// PLAY_UPLOAD_* Gradle properties, or the environment) names the file, type and alias; the two
// passwords come from the keyring and are never written into a file. The key is
// ~/.android-keys/stormberry-eclipsetracker-play-upload.p12 (created 29 October 2026, certificate
// SHA-256 a6d1575a...f9a6), its password in the keyring as app=eclipsetracker-play-upload.
val uploadStoreFile = signingValue("playUploadStoreFile", "PLAY_UPLOAD_STORE_FILE")
val uploadStoreType = signingValue("playUploadStoreType", "PLAY_UPLOAD_STORE_TYPE")
val uploadStorePassword = signingValue("playUploadStorePassword", "PLAY_UPLOAD_STORE_PASSWORD")
val uploadKeyAlias = signingValue("playUploadKeyAlias", "PLAY_UPLOAD_KEY_ALIAS")
val uploadKeyPassword = signingValue("playUploadKeyPassword", "PLAY_UPLOAD_KEY_PASSWORD")
val canSignPlayUpload = uploadStoreFile != null && file(uploadStoreFile).exists() &&
    uploadStorePassword != null && uploadKeyAlias != null && uploadKeyPassword != null

// The two keys must be two different files. A Play upload config pointing at the release keystore
// (or a byte-for-byte copy of it) would enrol the sovereign certificate in Play App Signing, which
// cannot be undone. Refused before anything is built.
if (releaseStoreFile != null && uploadStoreFile != null) {
    val rel = file(releaseStoreFile)
    val upl = file(uploadStoreFile)
    if (rel.exists() && upl.exists() &&
        (rel.canonicalFile == upl.canonicalFile || rel.readBytes().contentEquals(upl.readBytes()))
    ) {
        error(
            "The Play upload keystore and the release keystore are the same key " +
                "($uploadStoreFile). The release key signs the Zapstore APK only and must never " +
                "reach Play; the upload key signs the Play bundle only.",
        )
    }
}

// The release APK is built UNSIGNED, in a job that never sees the key, and signed afterwards
// with apksigner (GDPRLetterBuilder's SEC-6). That unsigned APK is asked for explicitly with
// -PunsignedRelease=true; without the switch a release task that would produce an unsigned APK
// fails (below), and with it a build that has a signing password in reach fails here.
val unsignedRelease = providers.gradleProperty("unsignedRelease").orNull == "true"
if (unsignedRelease && (releaseStorePassword != null || releaseKeyPassword != null)) {
    error(
        "-PunsignedRelease=true builds the release unsigned, for CI's separate signing job; " +
            "unset RELEASE_STORE_PASSWORD and RELEASE_KEY_PASSWORD first.",
    )
}

// STAGING BUILDS. The website and this app live in one repository, and a release must bundle
// exactly the committed website (verifyWebAssetsCommitted) and only files git tracks
// (checkWebSourcesTracked). The stage B build of 16 October 2026 was made in a staging copy whose
// web changes (stage A, K-1 to K-3, the app seam) are not committed yet, by decision: no commit
// without Marcos. -PstagingBuild=true turns those two refusals into warnings for such a build; it
// is refused on a CI runner, and an APK built with it is for testing only.
val stagingBuild = providers.gradleProperty("stagingBuild").orNull == "true"
// Fix B (16 October 2026, A-3): a staging build must never be signed. Before, the switch was
// refused only on CI, so a local build with the signing passwords in reach could make a
// release-signed APK whose web files match no commit. Now any signing password in reach (from
// keystore.properties, a Gradle property or the environment) refuses the staging build outright,
// whatever the task: the testing APK is the debug one, or the release built with
// -PunsignedRelease=true (which itself refuses a password in reach).
if (stagingBuild && (releaseStorePassword != null || releaseKeyPassword != null || canSignRelease ||
        uploadStorePassword != null || uploadKeyPassword != null)
) {
    error(
        "-PstagingBuild=true is for testing builds only and must never be signed, but signing " +
            "passwords are set. Unset RELEASE_STORE_PASSWORD and RELEASE_KEY_PASSWORD (and the " +
            "PLAY_UPLOAD_* passwords, and any password in keystore.properties), or build from the " +
            "web commit without the switch.",
    )
}

// The passwords are read while Gradle configures the build, and gradle.properties turns the
// configuration cache on, which would store them. So the build refuses to configure whenever a
// password is set and the cache is in use.
abstract class BuildFeaturesHolder @Inject constructor(val features: org.gradle.api.configuration.BuildFeatures)

val configurationCacheRequested =
    objects.newInstance<BuildFeaturesHolder>().features.configurationCache.requested.getOrElse(false)
if (configurationCacheRequested && (releaseStorePassword != null || releaseKeyPassword != null)) {
    error(
        "Signing passwords are set, so this build must run with " +
            "--no-configuration-cache; otherwise Gradle would store them in its configuration cache.",
    )
}
// The same for the Play upload passwords (MoonApp's guard): refused before any cache entry exists.
if (configurationCacheRequested && (uploadStorePassword != null || uploadKeyPassword != null)) {
    error(
        "A Play upload password is set, so this build must run with --no-configuration-cache; " +
            "otherwise Gradle would store it in its configuration cache.",
    )
}

// Guards on the RESOLVED TASK GRAPH, not on the command line (GDPRLetterBuilder's reasons):
// `build`, `assemble` and Gradle's `bR` abbreviation reach a release artefact without containing
// "bundleRelease" or "assembleRelease". packageRelease (APK) and signReleaseBundle (AAB) are the two
// tasks that consume a signing config, so the checks belong on them.
//   - A release BUNDLE is built only with -PplayBuild=true and a complete upload key. Without the
//     flag it would carry the SOVEREIGN application ID signed with the release key; uploading it
//     would permanently claim no.stormberry.eclipsetracker on Play and enrol the release certificate
//     in Play App Signing, which cannot be undone.
//   - A release APK with -PplayBuild=true is refused: Play takes the bundle, and an installable .play
//     APK has no destination and must never be mistaken for the Zapstore one.
//   - The sovereign release APK that would silently come out unsigned is refused unless asked for.
tasks.matching { it.name == "packageRelease" || it.name == "signReleaseBundle" }.configureEach {
    val isBundle = name == "signReleaseBundle"
    val signed = canSignRelease
    val unsigned = unsignedRelease
    val play = playBuild
    val haveUploadKey = canSignPlayUpload
    inputs.property("unsignedRelease", unsigned)
    inputs.property("playBuild", play)
    doFirst {
        if (isBundle && !play) {
            error(
                "Refusing to build a release bundle without -PplayBuild=true. This AAB would carry " +
                    "the sovereign application ID signed with the release key, and uploading it " +
                    "would permanently claim that package on Play. The sovereign channel ships " +
                    "APKs; Play takes the bundle, with -PplayBuild=true.",
            )
        }
        if (!isBundle && play) {
            error(
                "Refusing to build a release APK with -PplayBuild=true. Play takes the app bundle: " +
                    "run :app:bundleRelease -PplayBuild=true. An installable .play APK has no " +
                    "destination and must never be mistaken for the Zapstore one.",
            )
        }
        if (isBundle) {
            if (!haveUploadKey) {
                error(
                    "playBuild=true but the Play upload keystore is not fully configured. " +
                        "playUploadStoreFile and playUploadKeyAlias (android/keystore.properties, or " +
                        "PLAY_UPLOAD_STORE_FILE and PLAY_UPLOAD_KEY_ALIAS) and the passwords " +
                        "PLAY_UPLOAD_STORE_PASSWORD and PLAY_UPLOAD_KEY_PASSWORD (from the keyring) " +
                        "must all be set, and the store file must exist.",
                )
            }
            return@doFirst
        }
        if (!signed && !unsigned) {
            error(
                "Release signing is not configured. Set RELEASE_STORE_PASSWORD and " +
                    "RELEASE_KEY_PASSWORD (see android/keystore.properties) for a local release, " +
                    "or pass -PunsignedRelease=true for an unsigned build, signed afterwards with " +
                    "apksigner. Use assembleDebug for a test build.",
            )
        }
    }
}

// The Play versionCode offset (see defaultConfig): 1,000,000 for EclipseTracker, whose sovereign codes
// are major * 10000 + minor * 100 + patch.
val PLAY_VERSION_CODE_OFFSET = 1_000_000

// Under -PplayBuild=true the artefact is named for what it is, so a Play bundle can never be mistaken
// for a sovereign one on disk. Deliberately NOT set for the sovereign build, whose file name
// app-release-unsigned.apk is hardcoded in .github/workflows/android-release.yml.
if (playBuild) {
    base { archivesName = "eclipsetracker-play" }
}

android {
    namespace = "no.stormberry.eclipsetracker"
    // compileSdk 37.1 because androidx core-ktx 1.19.0 requires compiling against API 37 or
    // later. targetSdk stays at 36; the two are deliberately independent (as GDPRLetterBuilder).
    compileSdk = 37
    compileSdkMinor = 1

    defaultConfig {
        // Sovereign build: no.stormberry.eclipsetracker, permanent from the first Zapstore release.
        // Google Play build (-PplayBuild=true): no.stormberry.eclipsetracker.play.
        applicationId = if (playBuild) "no.stormberry.eclipsetracker.play" else "no.stormberry.eclipsetracker"
        minSdk = 24
        targetSdk = 36
        // 2.0.0 (code 20000): the first Android build (stage B, 16 October 2026), with the
        // website's version (2.0, VER-1). Codes follow major * 10000 + minor * 100 + patch, so
        // 2.0.1 is 20001 and 2.1.0 is 20100. First released on Zapstore as 2.0.0.
        //
        // 2.0.1 (code 20001), 29 October 2026: the Google Play switch (see playBuild above). The
        // sovereign APK keeps every permission, component and screen it had; Edition.ALARMS is true
        // in it. See fastlane changelogs/20001.txt.
        //
        // ONE VISIBLE VERSION, TWO CODE LINES. The sovereign versionCode and versionName on the next
        // lines are the only numbers bumped by hand. The Play build derives its code from them and
        // shows the same name:
        //   Play versionCode = 1,000,000 + sovereign versionCode   (2.0.1 code 20001 -> code 1020001)
        //   Play versionName = sovereign versionName               (2.0.1 -> 2.0.1)
        // EclipseTracker's offset is 1,000,000, not the 1000 of MoonApp, SunApp and CheckLink: its
        // sovereign codes are major * 10000 + minor * 100 + patch, so 1000 + 20001 = 21001 would be
        // the code of a future sovereign 2.10.1 and the two lines would read alike. A million keeps
        // every Play code above every sovereign code this scheme can write (up to 99.99.99), still
        // rising with it and far below Play's limit of 2,100,000,000. Play needs monotonic codes
        // within its own package only; the package name and the signing key are what keep the two
        // apart, not the version. Every Play upload is built from a sovereign release tag that
        // shipped on GitHub Releases, never from an untagged tree (the table is in README.md).
        versionCode = 20001
        versionName = "2.0.1"
        if (playBuild) {
            versionCode = PLAY_VERSION_CODE_OFFSET + versionCode!!
        }

        // Density PNGs generated from vectors are a source of build nondeterminism, and the
        // app ships vector icons only.
        vectorDrawables.generatedDensities()
    }

    signingConfigs {
        if (canSignRelease) {
            create("release") {
                storeFile = file(releaseStoreFile!!)
                if (releaseStoreType != null) storeType = releaseStoreType
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
                enableV4Signing = false
            }
        }
        if (canSignPlayUpload) {
            create("playUpload") {
                storeFile = file(uploadStoreFile!!)
                if (uploadStoreType != null) storeType = uploadStoreType
                storePassword = uploadStorePassword
                keyAlias = uploadKeyAlias
                keyPassword = uploadKeyPassword
                // v1 stays ON here, unlike the release config above (MoonApp's reason). An app bundle
                // is signed like a JAR, and this signature exists only so Play can verify who
                // uploaded it: Play strips it and re-signs the split APKs it generates with the app
                // signing key it holds.
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            // R8 is on. The page talks to Kotlin through WebViewCompat.addWebMessageListener, so
            // there is no @JavascriptInterface class for R8 to strip; every component the alarm
            // engine uses is named in the manifest, which AGP keeps. See proguard-rules.pro.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // The Play build never touches the release key and the sovereign build never touches
            // the upload key. Both stay conditional so a clean checkout with no keystore can still
            // run assembleDebug and an unsigned assembleRelease.
            if (playBuild) {
                if (canSignPlayUpload) signingConfig = signingConfigs.getByName("playUpload")
            } else if (canSignRelease && !unsignedRelease) {
                signingConfig = signingConfigs.getByName("release")
            }
            vcsInfo {
                include = false
            }
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    buildFeatures {
        buildConfig = false
        resValues = false
        shaders = false
    }

    // The edition (see playBuild above). Edition.kt is compiled with the main source set from
    // src/sovereign/kotlin or src/play/kotlin; the tiny file in each is the only source that
    // differs. The Play edition also overlays a manifest that REMOVES the alarm permissions and
    // components, and src/play/res, whose one string replaces main's toast that speaks of ringing
    // alarms (a build type's sources win over main's). Both are set on both build types so that a
    // Play debug build shows the same manifest and words as the bundle; the release APK with the
    // flag is refused by the guard above, so the bundle is the only Play artefact. The sovereign
    // build adds no manifest and no resource, so its merged manifest and resources are main's.
    sourceSets["main"].kotlin.directories.add(if (playBuild) "src/play/kotlin" else "src/sovereign/kotlin")
    if (playBuild) {
        for (type in listOf("release", "debug")) {
            sourceSets[type].manifest.srcFile("src/play/AndroidManifest.xml")
            sourceSets[type].res.directories.add("src/play/res")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // java.time is API 26 and later and minSdk is 24, so the alarm planner's java.time is
        // desugared, as in SunApp and MoonApp. The desugar library carries its own copy of the
        // tz database on Android 7.x (API 24 and 25), so a government moving a clock change can
        // leave those two versions stale until this dependency is bumped (SunApp's README).
        isCoreLibraryDesugaringEnabled = true
    }

    packaging {
        resources {
            excludes += setOf(
                "/META-INF/{AL2.0,LGPL2.1}",
                "DebugProbesKt.bin",
                "kotlin-tooling-metadata.json",
            )
        }
    }

    androidResources {
        // The fonts are already compressed (woff2) and the page reads every file through the
        // asset loader; leaving them stored keeps the copy byte-identical and cheap to open.
        noCompress += listOf("woff2")
    }

    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }

    lint {
        warningsAsErrors = true
        abortOnError = true
        disable += setOf(
            // Version bumps are a deliberate, reviewed act, not something lint should fail on.
            "GradleDependency",
            "AndroidGradlePluginVersion",
            "ObsoleteLintCustomCheck",
            "NewerVersionAvailable",
            // targetSdk 36 is intentional; compileSdk is already 37.1.
            "OldTargetApi",
        )
        // The Play edition removes POST_NOTIFICATIONS from its manifest and, with it, every
        // notification the alarms post. Lint reads the SOURCE, where AlarmService still posts one,
        // and cannot see that Edition.ALARMS (false there) makes that code unreachable and that R8
        // deletes it (SunApp's finding). The check stays ON for the sovereign build, which declares
        // the permission, and the kit's check-play-bundle.sh proves that the Play bundle holds no
        // alarm class at all.
        if (playBuild) disable += "NotificationPermission"
    }

    testOptions {
        unitTests.isReturnDefaultValues = false
    }
}

kotlin {
    // The JDK that compiles is pinned to 21, as GDPRLetterBuilder and SunApp. Bytecode stays at 17.
    jvmToolchain(21)
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

// =====================================================================================
// THE WEB APP, COPIED AT BUILD TIME (GDPRLetterBuilder's design, unchanged in spirit)
//
// The APK runs the same files that GitHub Pages serves at eclipse.stormberry.as. They are never
// committed twice: this task copies them from the repository root into generated assets on
// every build, then a check task proves the copy is byte-identical to its source. The ONE
// permitted difference is a single line in index.html that loads android-bridge.js
// (android/web-overlay/) before the app module.
//
// WHICH files: an explicit list (WebAssets.INCLUDES), taken from what the page actually loads,
// plus data/eclipses.json, which the page does not load but the native alarm engine reads
// (spec 9.3). Three checks prove the list right on every build: every local file a copied
// page, style sheet or script refers to was copied; every copied file is reached from
// index.html (the eclipse list apart, which ships for the native side); and verifyWebAssets
// compares the copy with what GitHub Pages publishes.
// =====================================================================================

object WebAssets {
    const val INJECTED_TAG = "<script src=\"android-bridge.js\"></script>"
    // The Google Play edition's line (29 October 2026): the same script, told the edition by the tag
    // that loads it (android-bridge.ts reads document.currentScript's data-edition), so one bridge
    // script serves both editions and the Play one adds nothing about ringing alarms. The sovereign
    // line is unchanged, so the sovereign APK's index.html is byte for byte what 2.0.0 bundled.
    const val PLAY_INJECTED_TAG = "<script src=\"android-bridge.js\" data-edition=\"play\"></script>"
    const val BRIDGE_FILE = "android-bridge.js"

    fun injectedTag(play: Boolean): String = if (play) PLAY_INJECTED_TAG else INJECTED_TAG

    //   index.html, app.js, style.css  the page, its module and its style sheet
    //   core/*.js                      the pure modules app.js imports (spec 9.2)
    //   favicon.svg                    the page's icon and the picture beside the title
    //   apple-touch-icon.png           the iPhone and iPad Home Screen icon (2026-10-21); no
    //                                  meaning in the app, bundled because index.html and
    //                                  disclaimer.html link it relatively and the reference
    //                                  check must find it
    //   disclaimer.html                the footer's Disclaimer, opened over the page in the app
    //   fonts/**/*.css, *.woff2        Inter, self-hosted
    //   switcher-icons/*.svg           the footer carousel, referenced from the site root
    //   data/eclipses.json             the eclipse list for the native alarm engine (spec 9.3)
    val INCLUDES = listOf(
        "index.html", "app.js", "style.css", "favicon.svg", "apple-touch-icon.png", "disclaimer.html",
        "core/*.js",
        "data/eclipses.json",
        "fonts/**/*.css", "fonts/**/*.woff2",
        "switcher-icons/*.svg",
    )

    // Published by GitHub Pages but deliberately not in the APK, each for its reason.
    val LEFT_OUT = mapOf(
        "CNAME" to "tells GitHub Pages the site's address; no meaning in an app",
        "robots.txt" to "for search engines; no meaning in an app",
        "core/api.js" to "the contract's index of core/ (spec 9.2); the page never loads it, and the native side reads data/eclipses.json",
        "core/types.js" to "types only, an empty module; the page never loads it",
    )

    val EXCLUDES = LEFT_OUT.keys.toList()

    /** Copied files that need no reference from the page: the eclipse list the native side reads. */
    fun shippedForItsOwnSake(rel: String): Boolean = rel == "data/eclipses.json"

    // Every type the copy may hold. json is bundled for the native side only: the asset loader
    // (AssetPaths.TYPES) does not serve it to the page, whose own policy forbids fetching it.
    val ALLOWED_EXTENSIONS = setOf("html", "js", "css", "svg", "png", "woff2", "json")

    val JEKYLL_DEFAULT_EXCLUDES = listOf("**/.*", "**/.*/**", "**/_*", "**/_*/**", "**/#*", "**/*~")

    // Repository files that are never part of the web app, as a second fence around the include
    // list: the Android project, the TypeScript sources, the tooling, the tests and the vectors,
    // the package files, the documents and the website's own files.
    val APK_EXCLUDES = listOf(
        "android/**", "fastlane/**", "tests/**", "tools/**", "ts/**", ".github/**",
        "zapstore.yaml", "README*", "CHANGELOG.md", "DISCLAIMER.md", "LICENSE", "NOTICE", "CNAME", "robots.txt",
        "_config.yml", "bump_assets.py", "package.json", "package-lock.json", "tsconfig.json",
        "tsconfig.core.json", "node_modules/**",
        "**/__pycache__/**", "**/*.pyc", "**/*.bak*", "**/.DS_Store", "**/*sync-conflict*",
    )

    fun publishedFiles(root: File): Set<String> {
        val config = File(root, "_config.yml").readText()
        val excluded = Regex("""^ {2}- (.+)$""", RegexOption.MULTILINE).findAll(config).map { it.groupValues[1].trim() }.toList()
        require(excluded.isNotEmpty()) { "_config.yml lists no exclusions; has its format changed?" }
        return root.walkTopDown()
            .onEnter { dir ->
                val rel = dir.relativeTo(root).invariantSeparatorsPath
                dir == root || (!dir.name.startsWith(".") && !dir.name.startsWith("_") && dir.name != "node_modules" &&
                    excluded.none { it.endsWith("/") && (rel == it.trimEnd('/') || rel.startsWith(it)) })
            }
            .filter { it.isFile }
            .map { it.relativeTo(root).invariantSeparatorsPath }
            .filter { rel ->
                val name = rel.substringAfterLast('/')
                rel !in excluded && !name.startsWith(".") && !name.startsWith("_") && !name.startsWith("#") &&
                    !name.endsWith("~") && !name.endsWith(".pyc") && !name.contains(".bak") && !rel.contains("__pycache__/")
            }
            .toSortedSet()
    }

    fun gitRun(dir: File, vararg args: String): Pair<Int, ByteArray> {
        val process = try {
            ProcessBuilder(listOf("git", "-C", dir.path) + args).start()
        } catch (e: java.io.IOException) {
            error("git is needed to build the app, because the bundled web files are checked against the repository: ${e.message}")
        }
        process.outputStream.close()
        val errReader = Thread { process.errorStream.readBytes() }.apply { start() }
        val out = process.inputStream.readBytes()
        val code = process.waitFor()
        errReader.join()
        return code to out
    }

    fun git(dir: File, vararg args: String): ByteArray {
        val (code, out) = gitRun(dir, *args)
        if (code != 0) error("git ${args.joinToString(" ")} failed (exit $code)")
        return out
    }

    fun inGitRepository(root: File): Boolean {
        val (code, out) = gitRun(root, "rev-parse", "--is-inside-work-tree")
        return code == 0 && String(out, Charsets.UTF_8).trim() == "true"
    }

    fun onCi(): Boolean =
        System.getenv("CI").equals("true", ignoreCase = true) || System.getenv("GITHUB_ACTIONS").equals("true", ignoreCase = true)

    fun trackedFiles(root: File): Set<String> =
        String(git(root, "ls-files", "-z", "--cached", "--", "."), Charsets.UTF_8)
            .split('\u0000').filter { it.isNotEmpty() }.toSet()

    fun committedBytes(root: File, rel: String): ByteArray? {
        val spec = "HEAD:./$rel"
        val (code, typeOut) = gitRun(root, "cat-file", "-t", spec)
        if (code != 0 || String(typeOut, Charsets.UTF_8).trim() != "blob") return null
        return git(root, "cat-file", "blob", spec)
    }

    fun throughSymlink(root: File, rel: String): Boolean {
        var f = root
        for (part in rel.split('/')) {
            f = File(f, part)
            if (Files.isSymbolicLink(f.toPath())) return true
        }
        return false
    }

    fun removeInjected(text: String, tag: String): Result<String> {
        val count = Regex(Regex.escape(tag)).findAll(text).count()
        if (count != 1) return Result.failure(IllegalStateException("expected the bridge tag exactly once, found $count"))
        if (Regex(Regex.escape(BRIDGE_FILE)).findAll(text).count() != 1) {
            return Result.failure(IllegalStateException("$BRIDGE_FILE is named outside the one injected tag"))
        }
        val at = text.indexOf(tag)
        val lineStart = text.lastIndexOf('\n', at) + 1
        val lineEnd = text.indexOf('\n', at)
        if (lineEnd < 0 || text.substring(lineStart, at).isNotBlank() ||
            text.substring(at + tag.length, lineEnd).isNotEmpty()
        ) {
            return Result.failure(IllegalStateException("the bridge tag is not alone on its own line"))
        }
        return Result.success(text.substring(0, lineStart) + text.substring(lineEnd + 1))
    }

    /** Inserts the bridge tag on its own line directly before the first script tag. */
    fun inject(source: String, tag: String): String {
        val first = source.indexOf("<script")
        require(first >= 0) { "index.html has no <script> tag to inject the Android bridge before" }
        require(!source.contains(BRIDGE_FILE)) { "index.html already mentions $BRIDGE_FILE" }
        val lineStart = source.lastIndexOf('\n', first) + 1
        val indent = source.substring(lineStart, first)
        require(indent.isBlank()) { "the first <script> in index.html does not start its own line" }
        return source.substring(0, lineStart) + indent + tag + "\n" + source.substring(lineStart)
    }

    private val HTML_REF = Regex("""(?:src|href)\s*=\s*"([^"]*)"""")
    private val CSS_REF = Regex("""url\(\s*['"]?([^'")]+)['"]?\s*\)""")
    private val JS_FROM = Regex("""(?:^|[;\s])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]""")
    private val JS_BARE = Regex("""(?:^|[;\s])import\s*['"]([^'"]+)['"]""")
    private val JS_DYNAMIC = Regex("""import\s*\(\s*['"]([^'"]+)['"]\s*\)""")
    private val JS_URL = Regex("""new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)""")

    private val SCHEME = Regex("^[a-z][a-z0-9+.-]*:")

    private fun isExternal(ref: String): Boolean {
        val r = ref.trim().lowercase()
        return r.isEmpty() || r.startsWith("#") || r.startsWith("//") || SCHEME.containsMatchIn(r)
    }

    private fun resolve(from: String, ref: String): String {
        val clean = ref.substringBefore('#').substringBefore('?')
        val base = if (clean.startsWith("/")) "" else from.substringBeforeLast('/', "")
        val parts = mutableListOf<String>()
        (if (base.isEmpty()) clean else "$base/$clean").split('/').forEach {
            when (it) {
                "", "." -> Unit
                ".." -> require(parts.isNotEmpty()) { "$from references $ref, which climbs out of the web root" }
                    .also { parts.removeAt(parts.size - 1) }
                else -> parts += it
            }
        }
        val joined = parts.joinToString("/")
        return if (joined.isEmpty() || clean.endsWith("/")) (if (joined.isEmpty()) "" else "$joined/") + "index.html" else joined
    }

    private fun references(webDir: File, rel: String, problems: MutableSet<String>): List<String> {
        val f = File(webDir, rel)
        val text = when (f.extension) { "html", "css", "js" -> f.readText() else -> return emptyList() }
        val refs = mutableListOf<String>()
        if (f.extension == "html" || f.extension == "js") {
            HTML_REF.findAll(text).forEach { refs += it.groupValues[1] }
        }
        if (f.extension == "html" || f.extension == "css") {
            CSS_REF.findAll(text).forEach { refs += it.groupValues[1] }
        }
        if (f.extension == "js") {
            listOf(JS_FROM, JS_BARE, JS_DYNAMIC, JS_URL).forEach { re -> re.findAll(text).forEach { refs += it.groupValues[1] } }
        }
        val out = mutableListOf<String>()
        for (ref in refs) {
            if (isExternal(ref)) continue
            if (f.extension == "js" && !(ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("/") ||
                    ref.endsWith(".html"))) {
                problems += "$rel: bare module specifier '$ref' (there is no bundler)"
                continue
            }
            out += resolve(rel, ref)
        }
        return out
    }

    fun missingReferences(webDir: File): List<String> {
        val missing = sortedSetOf<String>()
        webDir.walkTopDown().filter { it.isFile }.forEach { f ->
            val rel = f.relativeTo(webDir).invariantSeparatorsPath
            for (target in references(webDir, rel, missing)) {
                if (!File(webDir, target).isFile) missing += "$rel references $target, which was not copied"
            }
        }
        return missing.toList()
    }

    fun unreferencedFiles(webDir: File): List<String> {
        val reached = mutableSetOf<String>()
        val queue = ArrayDeque(listOf("index.html", BRIDGE_FILE))
        val ignored = mutableSetOf<String>()
        while (queue.isNotEmpty()) {
            val rel = queue.removeFirst()
            if (!reached.add(rel) || !File(webDir, rel).isFile) continue
            references(webDir, rel, ignored).forEach { queue.addLast(it) }
        }
        return webDir.walkTopDown().filter { it.isFile }
            .map { it.relativeTo(webDir).invariantSeparatorsPath }
            .filter { it !in reached && !shippedForItsOwnSake(it) }
            .sorted().toList()
    }
}

val webRootDir: File = rootProject.projectDir.parentFile
val webOverlayDir: File = rootProject.file("web-overlay")
val webAssetsOutDir = layout.buildDirectory.dir("generated/webAssets")
val webSourceTree = fileTree(webRootDir) {
    include(WebAssets.INCLUDES)
    exclude(WebAssets.JEKYLL_DEFAULT_EXCLUDES + WebAssets.APK_EXCLUDES + WebAssets.EXCLUDES)
}
val webRootTree = fileTree(webRootDir) {
    exclude("android/**", "tests/**", "tools/**", "ts/**", "**/.*", "**/.*/**", "**/__pycache__/**", "node_modules/**")
}

abstract class CheckWebSourcesTracked : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sources: ConfigurableFileCollection

    @get:Internal
    abstract val webRoot: DirectoryProperty

    @get:Input
    abstract val staging: Property<Boolean>
}

val checkWebSourcesTracked = tasks.register<CheckWebSourcesTracked>("checkWebSourcesTracked") {
    description = "Fails unless every web file the APK would bundle is tracked by git and is not a symbolic link."
    group = "verification"
    sources.from(webSourceTree)
    webRoot.set(webRootDir)
    staging.set(stagingBuild)
    doLast {
        val root = webRoot.get().asFile
        val problems = mutableListOf<String>()
        val untracked = mutableListOf<String>()
        val inGit = WebAssets.inGitRepository(root)
        if (!inGit && WebAssets.onCi()) {
            error("The web root is not a git checkout, so the bundled web files cannot be checked against the repository.")
        }
        if (staging.get() && WebAssets.onCi()) error("-PstagingBuild=true is for local staging builds only, never on CI.")
        val tracked = if (inGit) WebAssets.trackedFiles(root) else emptySet()
        for (f in sources.files) {
            val rel = f.relativeTo(root).invariantSeparatorsPath
            if (WebAssets.throughSymlink(root, rel)) problems += "symbolic link: $rel"
            else if (inGit && rel !in tracked) untracked += rel
        }
        if (untracked.isNotEmpty() && !staging.get()) problems += untracked.map { "not tracked by git: $it" }
        if (problems.isNotEmpty()) {
            error(
                "These files in the web root would be bundled into the APK, but they are not part " +
                    "of the website git holds. Commit them, remove them or exclude them:\n  " +
                    problems.sorted().joinToString("\n  "),
            )
        }
        if (untracked.isNotEmpty()) {
            logger.warn(
                "checkWebSourcesTracked: STAGING BUILD, ${untracked.size} bundled web files are not tracked " +
                    "by git yet (the web commit is still to be made). This APK is for testing only.",
            )
        }
        if (!inGit) logger.warn("checkWebSourcesTracked: ${root.path} is not a git work tree; git could not vouch for the web files.")
    }
}

abstract class PrepareWebAssets : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sources: ConfigurableFileCollection

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val overlay: ConfigurableFileCollection

    @get:Internal
    abstract val webRoot: DirectoryProperty

    @get:Internal
    abstract val overlayRoot: DirectoryProperty

    /** True for the Google Play edition: the injected line tells the bridge so (WebAssets.injectedTag). */
    @get:Input
    abstract val playEdition: Property<Boolean>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty
}

val prepareWebAssets = tasks.register<PrepareWebAssets>("prepareWebAssets") {
    description = "Copies the web app from the repository root into generated assets and injects the Android bridge."
    group = "build"
    sources.from(webSourceTree)
    overlay.from(webOverlayDir)
    webRoot.set(webRootDir)
    overlayRoot.set(webOverlayDir)
    playEdition.set(playBuild)
    outputDir.set(webAssetsOutDir)
    dependsOn(checkWebSourcesTracked)
    doLast {
        val root = webRoot.get().asFile
        val out = outputDir.get().asFile.resolve("web")
        outputDir.get().asFile.deleteRecursively()
        out.mkdirs()
        val unexpected = mutableListOf<String>()
        val files = sources.files.sortedBy { it.relativeTo(root).invariantSeparatorsPath }
        for (src in files) {
            val rel = src.relativeTo(root).invariantSeparatorsPath
            if (src.extension.lowercase() !in WebAssets.ALLOWED_EXTENSIONS) {
                unexpected += rel
                continue
            }
            val dest = out.resolve(rel)
            dest.parentFile.mkdirs()
            if (rel == "index.html") {
                dest.writeText(WebAssets.inject(src.readText(), WebAssets.injectedTag(playEdition.get())))
            } else {
                src.copyTo(dest, overwrite = false)
            }
        }
        if (unexpected.isNotEmpty()) {
            error(
                "These files match the web include list but have a type the app does not serve, so " +
                    "they would break or bloat the APK. Remove them or narrow WebAssets.INCLUDES:\n  " +
                    unexpected.joinToString("\n  "),
            )
        }
        val bridge = overlayRoot.get().asFile.resolve(WebAssets.BRIDGE_FILE)
        require(bridge.isFile) { "missing ${bridge.path}" }
        val bridgeDest = out.resolve(WebAssets.BRIDGE_FILE)
        require(!bridgeDest.exists()) { "${WebAssets.BRIDGE_FILE} collides with a file of the web app" }
        bridge.copyTo(bridgeDest)

        require(out.resolve("index.html").isFile) { "index.html was not copied; is the web root right? ($root)" }
        require(out.resolve("data/eclipses.json").isFile) { "data/eclipses.json was not copied; the alarm engine needs it" }
        val missing = WebAssets.missingReferences(out)
        if (missing.isNotEmpty()) {
            error(
                "The copied web app references files that were not copied. Add them to " +
                    "WebAssets.INCLUDES:\n  " + missing.joinToString("\n  "),
            )
        }
        val stray = WebAssets.unreferencedFiles(out)
        if (stray.isNotEmpty()) {
            error(
                "These copied files are not reached from index.html, so the app does not need " +
                    "them. Remove them from the web root or narrow WebAssets.INCLUDES:\n  " +
                    stray.joinToString("\n  "),
            )
        }
    }
}

abstract class VerifyWebAssets : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sources: ConfigurableFileCollection

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val webRootFiles: ConfigurableFileCollection

    @get:Internal
    abstract val webRoot: DirectoryProperty

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val bridgeSource: RegularFileProperty

    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val copied: DirectoryProperty

    /** ResponseHeaders.kt, whose DISCLAIMER_STYLE_HASH must match disclaimer.html's style element (fix C, M-1). */
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val responseHeaders: RegularFileProperty

    /** True for the Google Play edition, whose injected line carries data-edition="play". */
    @get:Input
    abstract val playEdition: Property<Boolean>

    @get:OutputFile
    abstract val report: RegularFileProperty
}

// Fix C (17 October 2026, M-1): the disclaimer styles itself with one inline style element, which the
// app's policy allows by its SHA-256 alone (ResponseHeaders.DISCLAIMER_STYLE_HASH). Worked out again
// from the copy on every build: a changed style, a second style element, a style attribute or a
// script in the disclaimer fails the build instead of leaving it unreadable in the app.
object DisclaimerStyle {
    private val STYLE = Regex("""<style(\s[^>]*)?>([\s\S]*?)</style>""", RegexOption.IGNORE_CASE)

    fun problems(html: String, kotlin: String): List<String> {
        val out = mutableListOf<String>()
        val blocks = STYLE.findAll(html).toList()
        if (blocks.size != 1) out += "disclaimer.html: expected one style element, found ${blocks.size}"
        if (Regex("""\sstyle\s*=""", RegexOption.IGNORE_CASE).containsMatchIn(html)) out += "disclaimer.html: a style attribute, which the app's policy refuses"
        if (Regex("""<script\b""", RegexOption.IGNORE_CASE).containsMatchIn(html)) out += "disclaimer.html: a script, which the app's side page does not run"
        val declared = Regex("""DISCLAIMER_STYLE_HASH = "([^"]+)"""").find(kotlin)?.groupValues?.get(1)
        if (declared == null) out += "ResponseHeaders.kt: DISCLAIMER_STYLE_HASH not found"
        val block = blocks.firstOrNull()
        if (block != null && declared != null) {
            val digest = MessageDigest.getInstance("SHA-256").digest(block.groupValues[2].toByteArray(Charsets.UTF_8))
            val actual = "sha256-" + Base64.getEncoder().encodeToString(digest)
            if (actual != declared) {
                out += "disclaimer.html's style element hashes to $actual, but ResponseHeaders.DISCLAIMER_STYLE_HASH is $declared: " +
                    "the disclaimer would show unstyled (black on black) in the app. Put the new hash there."
            }
        }
        return out
    }
}

val verifyWebAssets = tasks.register<VerifyWebAssets>("verifyWebAssets") {
    description = "Asserts every bundled web file is byte-identical to its source, except the one injected line in index.html."
    group = "verification"
    sources.from(webSourceTree)
    webRootFiles.from(webRootTree)
    webRoot.set(webRootDir)
    bridgeSource.set(webOverlayDir.resolve(WebAssets.BRIDGE_FILE))
    copied.set(prepareWebAssets.flatMap { it.outputDir })
    responseHeaders.set(file("src/main/kotlin/no/stormberry/eclipsetracker/web/ResponseHeaders.kt"))
    playEdition.set(playBuild)
    report.set(layout.buildDirectory.file("reports/webAssets/verify.txt"))
    doLast {
        val tag = WebAssets.injectedTag(playEdition.get())
        val root = webRoot.get().asFile
        val web = copied.get().asFile.resolve("web")
        val problems = mutableListOf<String>()
        val expected = sources.files.associateBy { it.relativeTo(root).invariantSeparatorsPath }
        val actual = web.walkTopDown().filter { it.isFile }.associateBy { it.relativeTo(web).invariantSeparatorsPath }

        val extra = actual.keys - expected.keys - WebAssets.BRIDGE_FILE
        val absent = expected.keys - actual.keys
        extra.sorted().forEach { problems += "in the APK copy but not in the web root: $it" }
        absent.sorted().forEach { problems += "in the web root but missing from the APK copy: $it" }

        val published = WebAssets.publishedFiles(root)
        (published - expected.keys - WebAssets.LEFT_OUT.keys).sorted()
            .forEach { problems += "published by GitHub Pages but not in the APK, and not on WebAssets.LEFT_OUT: $it" }
        (expected.keys - published).sorted()
            .forEach { problems += "in the APK but GitHub Pages would not publish it (_config.yml): $it" }
        (WebAssets.LEFT_OUT.keys - published).sorted()
            .forEach { problems += "WebAssets.LEFT_OUT names a file GitHub Pages does not publish: $it" }

        val lines = StringBuilder()
        for ((rel, src) in expected.toSortedMap()) {
            val dst = actual[rel] ?: continue
            if (rel == "index.html") {
                val s = src.readBytes()
                val text = String(dst.readBytes(), Charsets.UTF_8)
                val restored = WebAssets.removeInjected(text, tag).getOrElse {
                    problems += "index.html: ${it.message}"
                    continue
                }
                val at = text.indexOf(tag)
                if (!restored.toByteArray(Charsets.UTF_8).contentEquals(s)) {
                    problems += "index.html: differs from its source by more than the injected line"
                }
                // The bridge must run before the app module, so window.EclipseTrackerApp exists
                // when app.js starts (spec 9.1, B-4).
                val module = text.indexOf("type=\"module\"")
                if (module < 0 || at > module) problems += "index.html: the bridge must load before the app module"
                lines.append("MODIFIED  ").append(rel).append(" (one injected line, otherwise identical: ").append(tag).append(")\n")
            } else if (!src.readBytes().contentEquals(dst.readBytes())) {
                problems += "$rel: bytes differ from the source"
            } else {
                lines.append("IDENTICAL ").append(rel).append('\n')
            }
        }
        val bridge = actual[WebAssets.BRIDGE_FILE]
        if (bridge == null || !bridge.readBytes().contentEquals(bridgeSource.get().asFile.readBytes())) {
            problems += "${WebAssets.BRIDGE_FILE}: missing from the copy or differs from android/web-overlay"
        } else {
            lines.append("ADDED     ").append(WebAssets.BRIDGE_FILE).append(" (android/web-overlay)\n")
        }
        val disclaimer = actual["disclaimer.html"]
        if (disclaimer == null) {
            problems += "disclaimer.html: missing from the copy"
        } else {
            val found = DisclaimerStyle.problems(disclaimer.readText(), responseHeaders.get().asFile.readText())
            problems += found
            if (found.isEmpty()) lines.append("CHECKED   disclaimer.html style element matches ResponseHeaders.DISCLAIMER_STYLE_HASH\n")
        }
        if (problems.isNotEmpty()) {
            error("Bundled web app does not match its source:\n  " + problems.joinToString("\n  "))
        }
        WebAssets.LEFT_OUT.toSortedMap().forEach { (rel, why) -> lines.append("LEFT OUT  ").append(rel).append(" (").append(why).append(")\n") }
        val out = report.get().asFile
        out.parentFile.mkdirs()
        out.writeText(lines.toString())
        logger.lifecycle(
            "verifyWebAssets: ${expected.size - 1} web files byte-identical to source, index.html identical apart from the " +
                "one injected line, android-bridge.js added; ${published.size} files published by GitHub Pages, " +
                "${WebAssets.LEFT_OUT.size} of them left out on purpose; the disclaimer's style hash matches the app's policy",
        )
    }
}

// A RELEASE goes one step further: every bundled web file must equal the copy in the commit HEAD
// points at, so a signed APK can only carry what GitHub Pages serves from that commit. Refused
// on CI outside git; with -PstagingBuild=true (local only) a difference is reported, not fatal.
abstract class VerifyWebAssetsCommitted : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val copied: DirectoryProperty

    @get:Internal
    abstract val webRoot: DirectoryProperty

    @get:Input
    abstract val staging: Property<Boolean>

    @get:Input
    abstract val playEdition: Property<Boolean>
}

val verifyWebAssetsCommitted = tasks.register<VerifyWebAssetsCommitted>("verifyWebAssetsCommitted") {
    description = "Asserts every bundled web file equals the committed copy at HEAD (release builds)."
    group = "verification"
    copied.set(prepareWebAssets.flatMap { it.outputDir })
    webRoot.set(webRootDir)
    staging.set(stagingBuild)
    playEdition.set(playBuild)
    doLast {
        val root = webRoot.get().asFile
        val tag = WebAssets.injectedTag(playEdition.get())
        if (staging.get() && WebAssets.onCi()) error("-PstagingBuild=true is for local staging builds only, never on CI.")
        if (!WebAssets.inGitRepository(root)) {
            if (WebAssets.onCi()) error("The web root is not a git checkout, so a release cannot be checked against a commit.")
            logger.warn("verifyWebAssetsCommitted: SKIPPED, ${root.path} is not a git work tree. This APK is fit for testing only.")
            return@doLast
        }
        val web = copied.get().asFile.resolve("web")
        val problems = mutableListOf<String>()
        var count = 0
        web.walkTopDown().filter { it.isFile }.sortedBy { it.path }.forEach { f ->
            val rel = f.relativeTo(web).invariantSeparatorsPath
            if (rel == WebAssets.BRIDGE_FILE) return@forEach
            val committed = WebAssets.committedBytes(root, rel)
            if (committed == null) {
                problems += "$rel: not in the commit HEAD points at"
                return@forEach
            }
            val bundled = if (rel == "index.html") {
                WebAssets.removeInjected(String(f.readBytes(), Charsets.UTF_8), tag).getOrElse {
                    problems += "index.html: ${it.message}"
                    return@forEach
                }.toByteArray(Charsets.UTF_8)
            } else {
                f.readBytes()
            }
            if (!bundled.contentEquals(committed)) problems += "$rel: differs from the committed copy (uncommitted change?)"
            count++
        }
        if (problems.isNotEmpty()) {
            if (staging.get()) {
                logger.warn(
                    "verifyWebAssetsCommitted: STAGING BUILD, ${problems.size} bundled web files are not the committed " +
                        "website yet. This APK is for testing only; a release is built from the web commit.",
                )
                return@doLast
            }
            error("A release must bundle exactly the committed website. Commit or revert these first:\n  " + problems.joinToString("\n  "))
        }
        logger.lifecycle("verifyWebAssetsCommitted: $count web files equal the committed copies at HEAD")
    }
}

// Licences. What only the app adds lives outside assets/web/, under assets/licences/: the
// Apache-2.0 text for the AndroidX and Kotlin libraries, the Inter typeface's OFL text (the web
// repository carries the fonts without their licence text; android/licences/ supplies it), the
// app's own MIT licence copied from LICENSE at build time, and THIRD-PARTY.txt, which lists them.
// The list of bundled libraries is taken from what the release build actually resolves, and the
// build fails on a library whose licence is not accounted for.
object Licences {
    val APACHE_GROUPS = listOf("androidx.", "org.jetbrains.kotlin", "org.jetbrains.kotlinx", "org.jspecify", "com.google.guava")

    fun isApache(group: String): Boolean =
        APACHE_GROUPS.any { if (it.endsWith(".")) group.startsWith(it) else group == it || group.startsWith("$it.") } ||
            group == "org.jetbrains"
}

abstract class PrepareLicenceAssets : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NAME_ONLY)
    abstract val texts: ConfigurableFileCollection

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val appLicence: RegularFileProperty

    @get:Input
    abstract val modules: ListProperty<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty
}

val licenceAssetsOutDir = layout.buildDirectory.dir("generated/licenceAssets")

val prepareLicenceAssets = tasks.register<PrepareLicenceAssets>("prepareLicenceAssets") {
    description = "Puts the app's own and the bundled libraries' and typeface's licence texts into assets/licences/."
    group = "build"
    texts.from(rootProject.fileTree("licences"))
    appLicence.set(webRootDir.resolve("LICENSE"))
    outputDir.set(licenceAssetsOutDir)
    doLast {
        val out = outputDir.get().asFile.resolve("licences")
        outputDir.get().asFile.deleteRecursively()
        out.mkdirs()
        texts.files.sortedBy { it.name }.forEach { it.copyTo(out.resolve(it.name)) }
        require(out.resolve("Inter-OFL-1.1.txt").isFile) { "android/licences/Inter-OFL-1.1.txt is missing" }
        appLicence.get().asFile.copyTo(out.resolve("EclipseTracker-MIT.txt"))
        val mods = modules.get()
        val unknown = mods.filter { !Licences.isApache(it.substringBefore(':')) }
        if (unknown.isNotEmpty()) {
            error(
                "These bundled libraries have no licence on record in assets/licences/. Check " +
                    "their licences and extend Licences in app/build.gradle.kts:\n  " + unknown.joinToString("\n  "),
            )
        }
        require(mods.isNotEmpty()) { "the release runtime classpath resolved to no libraries" }
        out.resolve("THIRD-PARTY.txt").writeText(
            buildString {
                append("EclipseTracker for Android: third-party components\n\n")
                append("The bundled web app (assets/web/, the same files eclipse.stormberry.as serves) ships no\n")
                append("third-party code. It carries the Inter typeface (assets/web/fonts/inter/), under the SIL\n")
                append("Open Font License 1.1, full text in Inter-OFL-1.1.txt, and NASA's eclipse catalogue\n")
                append("(Fred Espenak, NASA Goddard Space Flight Center), which is in the public domain.\n\n")
                append("The Android app's release build depends on the libraries below, all licensed under the\n")
                append("Apache License, Version 2.0, full text in Apache-2.0.txt. R8 leaves out the parts the app\n")
                append("does not use, so some of them add no code at all.\n\n")
                mods.forEach { append("  ").append(it).append('\n') }
                append("\nThe java.time support for Android 7 (com.android.tools:desugar_jdk_libs) is compiled into\n")
                append("the app by the build; it is OpenJDK code under the GNU General Public License, version 2,\n")
                append("with the Classpath Exception.\n")
                append("\nEclipseTracker itself: MIT licence, in EclipseTracker-MIT.txt.\n")
            },
        )
    }
}

// THE PERMISSIONS (spec 9.1). The merged manifest, the app's own and every library's together, is
// what the APK carries, so that is what is checked, on every variant and before anything is
// packaged: exactly the permissions android/expected-permissions.txt names, no more and no fewer
// (a vanished RECEIVE_BOOT_COMPLETED would silently kill every alarm at the next reboot, so that
// fails as loudly as an extra one, SunApp's rule); no <permission> of its own; allowBackup false;
// no cleartext traffic; and no exported component but the launcher's MainActivity.
abstract class CheckMergedManifest : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val manifest: RegularFileProperty

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val expected: RegularFileProperty

    /** The Google Play edition: no permission at all and no alarm component, instead of the nine. */
    @get:Input
    abstract val playEdition: Property<Boolean>

    @get:OutputFile
    abstract val report: RegularFileProperty
}

object ManifestRules {
    /** The permission names expected-permissions.txt lists (its uses-permission lines). */
    fun expectedPermissions(text: String): Set<String> =
        Regex("""^uses-permission: name='([^']+)'""", RegexOption.MULTILINE).findAll(text).map { it.groupValues[1] }.toSortedSet()

    /** What is wrong with a merged manifest, or nothing. */
    fun problems(xml: String, expected: Set<String>): List<String> {
        val body = xml.replace(Regex("<!--[\\s\\S]*?-->"), "")
        val out = mutableListOf<String>()
        val asked = Regex("<uses-permission(?:-sdk-23|-sdk-m)?\\b[^>]*android:name=\"([^\"]+)\"[^>]*>").findAll(body).map { it.groupValues[1] }.toList()
        (asked.toSet() - expected).sorted().forEach { out += "the merged manifest asks for a permission not in expected-permissions.txt: $it" }
        (expected - asked.toSet()).sorted().forEach { out += "expected-permissions.txt names a permission the merged manifest lacks: $it" }
        if (asked.size != asked.toSet().size) out += "a permission is asked for twice"
        Regex("<(permission|permission-group|permission-tree)\\b[^>]*>").findAll(body).forEach {
            out += "the merged manifest declares a permission: ${it.value}"
        }
        val apps = Regex("<application\\b[^>]*>").findAll(body).toList()
        if (apps.size != 1) out += "expected one <application>, found ${apps.size}"
        apps.firstOrNull()?.let { app ->
            if (!app.value.contains("android:allowBackup=\"false\"")) out += "allowBackup is not false"
            if (app.value.contains("android:usesCleartextTraffic=\"true\"")) out += "cleartext traffic is allowed"
        }
        Regex("<(activity|activity-alias|service|receiver|provider)\\b[^>]*>").findAll(body).forEach { m ->
            val tag = m.value
            val name = Regex("android:name=\"([^\"]+)\"").find(tag)?.groupValues?.get(1) ?: "(no name)"
            val exported = tag.contains("android:exported=\"true\"")
            val isLauncher = m.groupValues[1] == "activity" && name == "no.stormberry.eclipsetracker.MainActivity"
            if (exported && !isLauncher) out += "an exported ${m.groupValues[1]} other than the launcher: $name"
        }
        return out
    }

    /**
     * The Google Play edition's extra rules (29 October 2026): no component of the alarm package and
     * no activity but MainActivity. Its permissions are checked by [problems] against an empty list.
     */
    fun alarmFreeProblems(xml: String): List<String> {
        val body = xml.replace(Regex("<!--[\\s\\S]*?-->"), "")
        val out = mutableListOf<String>()
        Regex("<(activity|activity-alias|service|receiver|provider)\\b[^>]*>").findAll(body).forEach { m ->
            val name = Regex("android:name=\"([^\"]+)\"").find(m.value)?.groupValues?.get(1) ?: "(no name)"
            if (name.contains(".alarm.")) out += "the Play edition's merged manifest keeps an alarm component: $name"
            if (m.groupValues[1].startsWith("activity") && name != "no.stormberry.eclipsetracker.MainActivity") {
                out += "the Play edition's merged manifest has an activity other than MainActivity: $name"
            }
        }
        return out
    }
}

androidComponents {
    onVariants { variant ->
        val cap = variant.name.replaceFirstChar { it.uppercase() }
        val manifestCheck = tasks.register<CheckMergedManifest>("check${cap}MergedManifest") {
            description = "Fails unless the merged manifest asks for exactly the expected permissions, keeps allowBackup false and exports only MainActivity."
            group = "verification"
            manifest.set(variant.artifacts.get(com.android.build.api.artifact.SingleArtifact.MERGED_MANIFEST))
            expected.set(rootProject.file("expected-permissions.txt"))
            playEdition.set(playBuild)
            report.set(layout.buildDirectory.file("reports/manifest/${variant.name}.txt"))
            doLast {
                val listed = ManifestRules.expectedPermissions(expected.get().asFile.readText())
                require(listed.isNotEmpty()) { "expected-permissions.txt lists no permission; has its format changed?" }
                // The Google Play edition asks for no permission at all (src/play/AndroidManifest.xml).
                val play = playEdition.get()
                val want: Set<String> = if (play) emptySet() else listed
                val xml = manifest.get().asFile.readText()
                val problems = ManifestRules.problems(xml, want) + (if (play) ManifestRules.alarmFreeProblems(xml) else emptyList())
                if (problems.isNotEmpty()) error("The ${manifest.get().asFile.name} of this variant breaks the permission and launcher-only rules:\n  " + problems.joinToString("\n  "))
                val line = if (play) {
                    "Google Play edition: no permission at all; no alarm component; MainActivity the only activity; allowBackup false; only MainActivity exported"
                } else {
                    "exactly the ${want.size} expected permissions; allowBackup false; only MainActivity exported"
                }
                report.get().asFile.writeText(line + "\n" + want.joinToString("\n") + "\n")
                logger.lifecycle("check${cap}MergedManifest: $line")
            }
        }
        tasks.matching { it.name == "package$cap" || it.name == "assemble$cap" || it.name == "check" }.configureEach { dependsOn(manifestCheck) }
        variant.sources.assets?.addGeneratedSourceDirectory(prepareWebAssets, PrepareWebAssets::outputDir)
        variant.sources.assets?.addGeneratedSourceDirectory(prepareLicenceAssets, PrepareLicenceAssets::outputDir)
        if (variant.name == "release") {
            val resolved = variant.runtimeConfiguration.incoming.resolutionResult.rootComponent.map { rootComponent ->
                val seen = sortedSetOf<String>()
                val queue = ArrayDeque(listOf(rootComponent))
                val visited = mutableSetOf<org.gradle.api.artifacts.component.ComponentIdentifier>()
                while (queue.isNotEmpty()) {
                    val c = queue.removeFirst()
                    if (!visited.add(c.id)) continue
                    (c.id as? org.gradle.api.artifacts.component.ModuleComponentIdentifier)?.let {
                        seen += "${it.group}:${it.module}:${it.version}"
                    }
                    c.dependencies.filterIsInstance<org.gradle.api.artifacts.result.ResolvedDependencyResult>()
                        .forEach { queue.addLast(it.selected) }
                }
                seen.toList()
            }
            prepareLicenceAssets.configure { modules.set(resolved) }
        }
    }
}

// The Kotlin tests read the web app's own test vectors and eclipse list (tests/*.json,
// data/eclipses.json), the files the TypeScript passes, so the two sides are held to one set of
// answers (spec 9.4, 9.5).
tasks.withType<Test>().configureEach {
    systemProperty("eclipsetracker.webRoot", webRootDir.absolutePath)
    inputs.files(
        File(webRootDir, "tests/alarm-vectors.json"), File(webRootDir, "tests/record-vectors.json"),
        File(webRootDir, "tests/dst-vectors.json"), File(webRootDir, "tests/goldens/eclipse-2027-02-06-solar.ics"),
        File(webRootDir, "data/eclipses.json"), File(webRootDir, "index.html"),
        // The edition tests (PlayManifestTest, EditionTest) read these sources (29 October 2026).
        file("src/main/AndroidManifest.xml"), file("src/play"), file("src/sovereign"), file("build.gradle.kts"),
        file("src/main/res/values/strings.xml"), file("src/main/kotlin/no/stormberry/eclipsetracker/MainActivity.kt"),
        rootProject.file("expected-permissions.txt"), rootProject.file("web-overlay/android-bridge.js"),
    ).withPathSensitivity(PathSensitivity.RELATIVE)
}

tasks.named("preBuild") { dependsOn(verifyWebAssets) }
tasks.named("check") { dependsOn(verifyWebAssets) }
tasks.matching { it.name == "preReleaseBuild" }.configureEach { dependsOn(verifyWebAssetsCommitted) }

dependencies {
    coreLibraryDesugaring(libs.desugar.jdk.libs)

    testImplementation(libs.junit)
    testImplementation(libs.json)

    implementation(libs.androidx.activity)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.webkit)
}
