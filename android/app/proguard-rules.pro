# R8 is on for release, and these are the reasons it is safe (GDPRLetterBuilder's, plus the alarm engine).
#
# 1. Nothing is reached from JavaScript by name: the page talks to Kotlin through
#    WebViewCompat.addWebMessageListener (the ETBridge object has only postMessage), so there is no
#    @JavascriptInterface class to strip. androidx.webkit ships its own keep rules.
# 2. The alarm engine's entry points (RingActivity, AlarmService, AlarmFireReceiver,
#    SystemEventReceiver) and androidx.core's FileProvider are named in the manifest, which AGP keeps.
# 3. The web app and data/eclipses.json are in assets/, which R8 never touches; org.json is the
#    framework's.
#
# Obfuscation is off so stack traces stay readable; shrinking and optimisation still apply.
-dontobfuscate
