package no.stormberry.eclipsetracker

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import no.stormberry.eclipsetracker.alarm.AlarmCapability
import no.stormberry.eclipsetracker.alarm.AlarmScheduling
import no.stormberry.eclipsetracker.alarm.AlarmService
import no.stormberry.eclipsetracker.alarm.AlarmState
import no.stormberry.eclipsetracker.alarm.Problem
import no.stormberry.eclipsetracker.alarm.RingActivity
import no.stormberry.eclipsetracker.core.BundledCatalogue
import no.stormberry.eclipsetracker.core.Json
import no.stormberry.eclipsetracker.web.AlarmFreeBridge
import no.stormberry.eclipsetracker.web.BridgeMessage
import no.stormberry.eclipsetracker.web.CalendarHandover
import no.stormberry.eclipsetracker.web.NavigationPolicy
import no.stormberry.eclipsetracker.web.TextScale
import no.stormberry.eclipsetracker.web.WebAssetHandler
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * One screen: a WebView running the bundled web app, the same files eclipse.stormberry.as serves
 * (GDPRLetterBuilder's design), and the native alarm engine behind it (SunApp's, ported). Kotlin
 * adds only what a browser cannot do, and checks everything the page asks of it (BridgeMessage,
 * CalendarHandover, the record checks):
 *  - ringing alarms: the page's alarms.set and alarms.list (spec 9.6); the records are stored in
 *    device-protected storage and armed by AlarmScheduling;
 *  - Add to calendar: the page's calendar file handed to the calendar app (ACTION_VIEW through a
 *    FileProvider limited to cache/calendar/), or the share sheet when no calendar app takes it;
 *  - Save the calendar file: Android's save screen, as GDPRLetterBuilder's Save;
 *  - the problems (notifications or exact or full-screen alarms refused) and the screens that fix them;
 *  - the disclaimer in a second WebView over the page, so Back returns to the page as it was;
 *  - Back: the page closes its planner if it is open; otherwise the app closes;
 *  - links: the user's browser, never inside the app;
 *  - while an alarm rings, the ring screen (fix B, A-1): opening the app, from the launcher or
 *    anywhere else, shows it, so an alarm that rings with nothing on screen (notifications off)
 *    can always be stopped.
 * There is no INTERNET permission: nothing can leave the device through this app.
 *
 * THE GOOGLE PLAY EDITION (Edition.ALARMS false, `-PplayBuild=true`, 29 October 2026) has no ringing
 * alarms: every alarm hook here (the notification channels, the ring-screen listener, the re-plan on
 * resume, the notification request, the fix screens) is behind `if (Edition.ALARMS)`, so R8 removes
 * it and the alarm package with it, and a message about alarms is refused (AlarmFreeBridge) without
 * the alarm engine being touched. The page, the calendar file, Save, Back and links work as above.
 */
class MainActivity : ComponentActivity() {

    private lateinit var container: FrameLayout
    private var webView: WebView? = null
    private var sidePage: WebView? = null
    private lateinit var assetLoader: WebViewAssetLoader

    private val main = Handler(Looper.getMainLooper())
    private val io: ExecutorService = Executors.newSingleThreadExecutor()

    private var pageProxy: JavaScriptReplyProxy? = null
    private var bridgeSupported = false
    private var debuggable = false

    /** The Back query the page may still answer, and the watchdog that closes the app if it does not. */
    private var backQuery = 0
    private var backWaiting = 0
    private var backWatchdog: Runnable? = null

    /** The calendar file waiting while Android's save screen is open, in memory only. */
    private class PendingSave(val bytes: ByteArray, val id: Int?, val proxy: JavaScriptReplyProxy)

    private var pendingSave: PendingSave? = null

    /** Asked once per start at most, when the first ringing alarm is set (SunApp: ask late). */
    private var askedNotifications = false

    private val saveCalendar = registerForActivityResult(ActivityResultContracts.CreateDocument(CALENDAR_TYPE)) { onSaveTarget(it) }
    /**
     * The answer to an alarms.set that asked for the notification permission: sent once the person
     * has answered the dialog, so the page's line says what is true then (not "Notifications are
     * off" while the dialog is still open).
     */
    private var pendingSetReply: Pair<JavaScriptReplyProxy, Int?>? = null

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        val waiting = pendingSetReply
        pendingSetReply = null
        if (waiting != null) pushAlarms(waiting.second, waiting.first) else pushAlarms(null)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        val page = ContextCompat.getColor(this, R.color.page_background)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(page), navigationBarStyle = SystemBarStyle.dark(page))
        super.onCreate(savedInstanceState)

        debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        assetLoader = WebViewAssetLoader.Builder()
            .setDomain(NavigationPolicy.ASSET_HOST)
            .setHttpAllowed(false)
            .addPathHandler("/", WebAssetHandler(assets, logMisses = debuggable))
            .build()
        WebView.setWebContentsDebuggingEnabled(debuggable)
        CookieManager.getInstance().setAcceptCookie(false)
        if (Edition.ALARMS) AlarmService.ensureChannels(this)

        container = FrameLayout(this).apply { setBackgroundColor(page) }
        setContentView(container)
        ViewCompat.setOnApplyWindowInsetsListener(container) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        createWebView()
        if (savedInstanceState != null) toast(R.string.page_reloaded)
        // The last calendar file handed over stays in cache/calendar/ only until the app is next
        // opened afresh: by then the calendar app has long read it.
        if (savedInstanceState == null) io.execute { File(cacheDir, CALENDAR_DIR).listFiles()?.forEach { it.delete() } }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = onBack()
        })
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        webView?.let { applyTextSize(it, isSidePage = false) }
        sidePage?.let { applyTextSize(it, isSidePage = true) }
    }

    /**
     * Android's font size, given to the page the way a browser's own font size setting gives it
     * (fix C, S-2, TextScale): the page a larger default font size with textZoom left at 100, so
     * its own caps on large text hold; the disclaimer, plain prose, the text zoom as before.
     */
    private fun applyTextSize(view: WebView, isSidePage: Boolean) {
        val scale = resources.configuration.fontScale
        view.settings.apply {
            if (isSidePage) {
                textZoom = TextScale.sidePageTextZoom(scale)
            } else {
                textZoom = 100
                defaultFontSize = TextScale.defaultFontSize(scale)
                defaultFixedFontSize = TextScale.defaultFixedFontSize(scale)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        webView?.onResume()
        sidePage?.onResume()
        if (Edition.ALARMS) {
            // Back from Settings, or after a journey: the problems and the armed times may have changed.
            pushAlarms(null)
            AlarmService.addListener(ringListener)
            showRingScreenIfRinging()
        }
    }

    override fun onPause() {
        if (Edition.ALARMS) AlarmService.removeListener(ringListener)
        sidePage?.onPause()
        webView?.onPause()
        super.onPause()
    }

    /** While this screen is in front, an alarm that starts ringing brings the ring screen (fix B, A-1). */
    private val ringListener: () -> Unit = { showRingScreenIfRinging() }

    /** Fix B, A-1: the ring screen, whenever an alarm rings and this screen is in front. */
    private fun showRingScreenIfRinging() {
        if (!Edition.ALARMS) return
        if (AlarmService.current() == null || isFinishing || isDestroyed) return
        try {
            startActivity(Intent(this, RingActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: RuntimeException) {
            Log.w(TAG, "could not open the ring screen", e)
        }
    }

    override fun onDestroy() {
        pendingSave = null
        stopBackWatchdog()
        sidePage?.let { destroyWebView(it) }
        sidePage = null
        webView?.let { destroyWebView(it) }
        webView = null
        io.shutdown()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- Back

    /**
     * Back closes the disclaimer. On the page it is a numbered query: the page closes its planner
     * if it is open (handled) and the app stays; otherwise, or if the page does not answer within
     * [BACK_ANSWER_MS], the app closes. Nothing is lost by closing: ringing alarms are stored the
     * moment they are set, and the planner keeps nothing on the website either (PRIV-1).
     */
    private fun onBack() {
        sidePage?.let { side ->
            if (side.canGoBack()) side.goBack() else closeSidePage()
            return
        }
        if (backWaiting != 0) return
        val proxy = pageProxy
        if (proxy == null) {
            finish()
            return
        }
        backQuery = if (backQuery == Int.MAX_VALUE) 1 else backQuery + 1
        val q = backQuery
        backWaiting = q
        val watchdog = Runnable {
            backWatchdog = null
            if (backWaiting == q) {
                backWaiting = 0
                finish()
            }
        }
        backWatchdog = watchdog
        main.postDelayed(watchdog, BACK_ANSWER_MS)
        post(proxy, JSONObject().put("type", "back").put("q", q))
    }

    private fun onBackResult(q: Int, handled: Boolean) {
        if (q != backWaiting) return
        backWaiting = 0
        stopBackWatchdog()
        if (!handled) finish()
    }

    private fun stopBackWatchdog() {
        backWatchdog?.let { main.removeCallbacks(it) }
        backWatchdog = null
    }

    // ---------------------------------------------------------------- WebView

    @SuppressLint("SetJavaScriptEnabled")
    private fun privateView(script: Boolean): WebView {
        val view = WebView(this)
        view.setBackgroundColor(ContextCompat.getColor(this, R.color.page_background))
        view.settings.apply {
            javaScriptEnabled = script
            // The page stores nothing (PRIV-1): no localStorage, no IndexedDB. The alarms the person
            // sets are stored by the app itself, not by the page.
            domStorageEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_NO_CACHE
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
        }
        applyTextSize(view, isSidePage = !script)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        view.webChromeClient = Chrome()
        return view
    }

    private fun createWebView() {
        val view = privateView(script = true)
        view.webViewClient = Client()
        bridgeSupported = false
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            bridgeSupported = true
            WebViewCompat.addWebMessageListener(view, BRIDGE_NAME, setOf(NavigationPolicy.ASSET_ORIGIN)) { _, message, origin, isMainFrame, proxy ->
                onBridgeMessage(message, origin, isMainFrame, proxy)
            }
        }
        container.addView(view, 0, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        if (sidePage != null) view.visibility = View.INVISIBLE
        webView = view
        pageProxy = null
        backWaiting = 0
        stopBackWatchdog()
        view.loadUrl(START_URL)
        if (!bridgeSupported) toast(R.string.webview_too_old)
    }

    /** The disclaimer in a second WebView over the page: same files, same policy, no bridge, no script. */
    private fun openSidePage(url: String) {
        val view = sidePage ?: privateView(script = false).also { v ->
            v.webViewClient = SideClient()
            container.addView(v, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            sidePage = v
            webView?.visibility = View.INVISIBLE
        }
        view.loadUrl(url)
        view.requestFocus()
    }

    private fun closeSidePage() {
        val view = sidePage ?: return
        sidePage = null
        destroyWebView(view)
        webView?.let {
            it.visibility = View.VISIBLE
            it.requestFocus()
        }
    }

    private fun destroyWebView(view: WebView) {
        container.removeView(view)
        view.stopLoading()
        view.destroy()
    }

    @SuppressLint("MissingOnRenderProcessGone")
    private open inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
            val url = request.url.toString()
            if (!NavigationPolicy.isAssetRequest(url)) return WebAssetHandler.forbidden()
            return assetLoader.shouldInterceptRequest(request.url) ?: WebAssetHandler.notFound()
        }

        open fun inApp(url: String, request: WebResourceRequest): Boolean {
            if (request.isForMainFrame && NavigationPolicy.sidePage(url) != null) {
                openSidePage(url)
                return true
            }
            return false
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // Leaving the app needs a press (GDPRLetterBuilder's rule).
            val userTapped = request.isForMainFrame && request.hasGesture()
            val url = request.url.toString()
            return when (NavigationPolicy.decide(url)) {
                NavigationPolicy.Decision.IN_APP -> inApp(url, request)
                NavigationPolicy.Decision.EXTERNAL, NavigationPolicy.Decision.EXTERNAL_APP -> {
                    if (userTapped) openOutside(request.url)
                    true
                }
                NavigationPolicy.Decision.BLOCK -> true
            }
        }

        override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
            if (view != null && view === webView) {
                webView = null
                destroyWebView(view)
                createWebView()
                toast(R.string.page_reloaded)
            }
            return true
        }
    }

    @SuppressLint("MissingOnRenderProcessGone")
    private inner class SideClient : Client() {
        override fun inApp(url: String, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return true
            if (NavigationPolicy.sidePage(url) != null) return false
            if (NavigationPolicy.isStartPage(url)) closeSidePage()
            return true
        }

        override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
            if (view != null && view === sidePage) closeSidePage()
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: android.webkit.GeolocationPermissions.Callback) {
            callback.invoke(origin, false, false)
        }

        override fun onPermissionRequest(request: PermissionRequest) = request.deny()
    }

    private fun openOutside(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: Exception) {
            toast(R.string.no_app_for_link)
        }
    }

    // ---------------------------------------------------------------- bridge

    private fun onBridgeMessage(message: WebMessageCompat, origin: Uri, isMainFrame: Boolean, proxy: JavaScriptReplyProxy) {
        // The listener is registered for the asset origin only; this is the second lock.
        if (!isMainFrame || !NavigationPolicy.isAssetOrigin(origin.toString())) return
        if (message.type != WebMessageCompat.TYPE_STRING) return
        val msg = BridgeMessage.parse(message.data) ?: return
        pageProxy = proxy
        if (!Edition.ALARMS) {
            // The Google Play edition: no alarm engine to ask (AlarmFreeBridge).
            when (AlarmFreeBridge.action(msg)) {
                AlarmFreeBridge.Action.REFUSE -> {
                    post(proxy, AlarmFreeBridge.refusal(AlarmFreeBridge.requestId(msg)))
                    return
                }
                AlarmFreeBridge.Action.IGNORE -> return
                AlarmFreeBridge.Action.HANDLE -> Unit
            }
        }
        when (msg) {
            BridgeMessage.Hello -> Unit
            is BridgeMessage.ListAlarms -> pushAlarms(msg.id, proxy)
            is BridgeMessage.SetAlarms -> setAlarms(msg, proxy)
            is BridgeMessage.Calendar -> calendar(msg, proxy)
            is BridgeMessage.FixProblem -> fixProblem(msg.problem)
            is BridgeMessage.BackResult -> onBackResult(msg.q, msg.handled)
        }
    }

    /** A message to the page; a page that has gone simply does not hear it. */
    private fun post(proxy: JavaScriptReplyProxy, msg: JSONObject) {
        msg.put("v", 1)
        val text = msg.toString()
        main.post {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return@post
            try {
                proxy.postMessage(text)
            } catch (_: Exception) {
                // The page that asked is gone.
            }
        }
    }

    /** The spec's "alarms" message (9.6): every stored record, what is armed and when, and the problems. */
    private fun alarmsMessage(state: AlarmState, id: Int?, ok: Boolean): JSONObject {
        val records = JSONArray().apply { state.records.forEach { put(it.toJson()) } }
        val armed = JSONArray().apply {
            state.armed.forEach { put(JSONObject().put("id", it.record.id).put("fireAt", Json.instant(it.fireAt))) }
        }
        val problems = JSONArray().apply { state.problems.forEach { put(it.wire) } }
        return JSONObject().put("type", "alarms").apply { if (id != null) put("id", id) }
            .put("ok", ok).put("records", records).put("armed", armed).put("problems", problems)
    }

    /** Re-plans (which also refreshes the problems) and tells the page, if one is listening. */
    private fun pushAlarms(id: Int?, to: JavaScriptReplyProxy? = pageProxy) {
        if (!Edition.ALARMS) return
        val proxy = to ?: return
        io.execute {
            val state = AlarmScheduling.replan(applicationContext)
            post(proxy, alarmsMessage(state, id, ok = true))
        }
    }

    private fun setAlarms(msg: BridgeMessage.SetAlarms, proxy: JavaScriptReplyProxy) {
        if (!Edition.ALARMS) return
        io.execute {
            val state = AlarmScheduling.setEclipse(applicationContext, msg.eclipseId, msg.records)
            if (state == null) {
                Log.w(TAG, "alarms.set refused")
                post(proxy, alarmsMessage(AlarmScheduling.replan(applicationContext), msg.id, ok = false))
                return@execute
            }
            main.post {
                if (state.records.isNotEmpty() && maybeAskNotifications()) pendingSetReply = proxy to msg.id
                else post(proxy, alarmsMessage(state, msg.id, ok = true))
            }
        }
    }

    /** Android 13 and later: the notification permission, asked once, when ringing alarms are first set. */
    private fun maybeAskNotifications(): Boolean {
        if (!Edition.ALARMS) return false
        if (askedNotifications || isFinishing || isDestroyed) return false
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return false
        askedNotifications = true
        askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        return true
    }

    private fun fixProblem(wire: String) {
        if (!Edition.ALARMS) return
        val problem = Problem.fromWire(wire) ?: return
        if (problem == Problem.NOTIFICATIONS && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            !askedNotifications
        ) {
            askedNotifications = true
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
            return
        }
        try {
            startActivity(AlarmCapability.settingsIntent(this, problem))
        } catch (_: ActivityNotFoundException) {
            runCatching { startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))) }
        }
    }

    // ---------------------------------------------------------------- the calendar file

    private fun calendarResult(proxy: JavaScriptReplyProxy, id: Int?, ok: Boolean, via: String, cancelled: Boolean = false) {
        val msg = JSONObject().put("type", "calendar.result").put("ok", ok).put("via", via)
        if (id != null) msg.put("id", id)
        if (cancelled) msg.put("cancelled", true)
        post(proxy, msg)
    }

    private fun calendar(msg: BridgeMessage.Calendar, proxy: JavaScriptReplyProxy) {
        val catalogue = BundledCatalogue.get(this)
        val file = CalendarHandover.check(msg.fileName, msg.ics) { catalogue[it] != null }
        if (file == null) {
            Log.w(TAG, "calendar file refused")
            calendarResult(proxy, msg.id, ok = false, via = if (msg.save) "save" else "calendar")
            return
        }
        if (msg.save) startSave(file, msg.id, proxy) else addToCalendar(file, msg.id, proxy)
    }

    /**
     * Spec 9.6 (B-3): written into cache/calendar/ (emptied first), handed to the calendar app with
     * ACTION_VIEW as text/calendar through the FileProvider, with a read grant for that one file;
     * when no app takes it, the share sheet with the same file. No calendar permission.
     */
    private fun addToCalendar(file: CalendarHandover.File, id: Int?, proxy: JavaScriptReplyProxy) {
        val uri = try {
            val dir = File(cacheDir, CALENDAR_DIR)
            dir.listFiles()?.forEach { it.delete() }
            dir.mkdirs()
            val out = File(dir, file.name)
            out.writeBytes(file.bytes)
            FileProvider.getUriForFile(this, "$packageName.calendar", out)
        } catch (e: Exception) {
            Log.w(TAG, "could not write the calendar file", e)
            calendarResult(proxy, id, ok = false, via = "calendar")
            return
        }
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, CALENDAR_TYPE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            startActivity(view)
            calendarResult(proxy, id, ok = true, via = "calendar")
            return
        } catch (_: ActivityNotFoundException) {
            // No calendar app opens .ics files: the share sheet instead.
        } catch (e: Exception) {
            Log.w(TAG, "the calendar app could not be started", e)
        }
        try {
            val send = Intent(Intent.ACTION_SEND).setType(CALENDAR_TYPE).putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            send.clipData = ClipData.newRawUri(file.name, uri)
            startActivity(Intent.createChooser(send, null))
            calendarResult(proxy, id, ok = true, via = "share")
        } catch (e: Exception) {
            Log.w(TAG, "the share sheet could not be started", e)
            calendarResult(proxy, id, ok = false, via = "share")
        }
    }

    /** The page's Save: Android's save screen under the page's own name (the eclipse, nothing about the person). */
    private fun startSave(file: CalendarHandover.File, id: Int?, proxy: JavaScriptReplyProxy) {
        if (pendingSave != null || isFinishing || isDestroyed) {
            calendarResult(proxy, id, ok = false, via = "save")
            return
        }
        pendingSave = PendingSave(file.bytes, id, proxy)
        try {
            saveCalendar.launch(file.name)
        } catch (_: Exception) {
            pendingSave = null
            calendarResult(proxy, id, ok = false, via = "save")
        }
    }

    private fun onSaveTarget(target: Uri?) {
        val waiting = pendingSave ?: return
        pendingSave = null
        if (target == null) {
            calendarResult(waiting.proxy, waiting.id, ok = false, via = "save", cancelled = true)
            return
        }
        io.execute {
            val ok = try {
                contentResolver.openOutputStream(target, "wt")?.use { it.write(waiting.bytes) } != null
            } catch (e: Exception) {
                Log.w(TAG, "could not write the saved file", e)
                false
            }
            calendarResult(waiting.proxy, waiting.id, ok = ok, via = "save")
        }
    }

    private fun toast(res: Int) {
        Toast.makeText(this, res, Toast.LENGTH_LONG).show()
    }

    companion object {
        private const val TAG = "EclipseTracker"
        private const val START_URL = "https://${NavigationPolicy.ASSET_HOST}/index.html"
        private const val BRIDGE_NAME = "ETBridge"
        private const val CALENDAR_TYPE = "text/calendar"
        private const val CALENDAR_DIR = "calendar"
        private const val BACK_ANSWER_MS = 1_500L
    }
}
