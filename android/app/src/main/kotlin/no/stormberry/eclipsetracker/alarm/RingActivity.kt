package no.stormberry.eclipsetracker.alarm

import android.content.Intent
import android.content.res.Configuration
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import no.stormberry.eclipsetracker.R

/**
 * The ring screen (SunApp's, in plain views): the time, the eclipse, the alarm, and Snooze and
 * Dismiss, over the lock screen with the display on. It only shows what rings now
 * ([AlarmService.current]: the ringing service, or the backup ring notification of fix B); when
 * nothing rings any more (Dismiss or Snooze from here or the notification, the ring timeout) it
 * closes itself. Snooze and Dismiss do not close it themselves: it closes once the ringing has
 * actually stopped, so a snooze that could not be armed leaves the alarm ringing with Dismiss
 * still in reach (fix B, A-7). Back does nothing: a half-awake press must not silence an alarm by
 * accident. The app's own screen opens it while an alarm rings (fix B, A-1). Fix C (17 October
 * 2026): the text scrolls with the buttons fixed below it, side by side in landscape (S-3); light
 * bar icons (C-1); built again when the phone turns or the font size changes (C-2). Fix D (17 October
 * 2026, N-1): the time is made smaller until it fits the width whole ([TimeFit]); before, it was cut
 * to one line, so on a 320 dp screen in a 12-hour locale "10:07 AM" showed as "10:07".
 */
class RingActivity : ComponentActivity() {

    private val handler = Handler(Looper.getMainLooper())
    private val listener: () -> Unit = { if (AlarmService.current() == null) finish() else render() }
    private lateinit var time: TextView
    /** The time's largest size in px for this configuration (fix C, S-3); [fitTime] shrinks it from there. */
    private var timeMaxPx = 0f
    private lateinit var title: TextView
    private lateinit var text: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        // Fix C (C-1): light status-bar and navigation-bar icons on the black screen, as on the page.
        // The default style follows the phone's light or dark mode and drew dark icons, nearly
        // invisible on this background, whenever the phone was in light mode.
        val page = ContextCompat.getColor(this, R.color.page_background)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(page), navigationBarStyle = SystemBarStyle.dark(page))
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                    WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD,
            )
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = Unit
        })
        buildScreen()
        adoptBackup(intent)
        render()
    }

    /**
     * Fix C (C-2, S-3): the manifest keeps this screen alive across a turn of the phone and a change
     * of the font size (configChanges), so it is built again for the new configuration: before, an
     * open ring screen kept the old text sizes, and its layout was the portrait one in landscape.
     */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        buildScreen()
        render()
    }

    /**
     * The time, the eclipse and the alarm scroll; Snooze and Dismiss stay fixed below them, so
     * Dismiss is always on screen whole (fix C, S-3: before, nothing scrolled, and in landscape
     * Dismiss was half cut at the normal font size and gone at 2.0). In landscape the two buttons
     * sit side by side to leave the text more height, and the time is smaller; its size has an
     * upper bound in dp, so the largest font sizes cannot make it fill the screen.
     */
    private fun buildScreen() {
        val landscape = resources.configuration.screenWidthDp > resources.configuration.screenHeightDp
        val primary = ContextCompat.getColor(this, R.color.text_primary)
        val secondary = ContextCompat.getColor(this, R.color.text_secondary)
        val match = ViewGroup.LayoutParams.MATCH_PARENT
        val wrap = ViewGroup.LayoutParams.WRAP_CONTENT
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(ContextCompat.getColor(this@RingActivity, R.color.page_background))
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val side = dp(if (landscape) 24 else 28)
            v.setPadding(bars.left + side, bars.top + dp(if (landscape) 12 else 48), bars.right + side, bars.bottom + dp(if (landscape) 12 else 24))
            WindowInsetsCompat.CONSUMED
        }
        val texts = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
        }
        timeMaxPx = minOf(sp(if (landscape) 48f else 64f), dp(if (landscape) 64 else 96).toFloat())
        time = TextView(this).apply {
            setTextColor(primary)
            setTextSize(TypedValue.COMPLEX_UNIT_PX, timeMaxPx)
            typeface = Typeface.create("sans-serif-light", Typeface.NORMAL)
            gravity = Gravity.CENTER
            maxLines = 1
            // Fix D, N-1: fitted again whenever its width changes (the first layout, a turn of the phone).
            addOnLayoutChangeListener { v, left, _, right, _, oldLeft, _, oldRight, _ ->
                if (right - left != oldRight - oldLeft) v.post { fitTime() }
            }
        }
        title = TextView(this).apply {
            setTextColor(primary)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, if (landscape) 22f else 24f)
            gravity = Gravity.CENTER
            setPadding(0, dp(if (landscape) 8 else 16), 0, 0)
        }
        text = TextView(this).apply {
            setTextColor(secondary)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, dp(16))
        }
        texts.addView(time, LinearLayout.LayoutParams(match, wrap))
        texts.addView(title, LinearLayout.LayoutParams(match, wrap))
        texts.addView(text, LinearLayout.LayoutParams(match, wrap))
        val scroll = ScrollView(this).apply {
            isFillViewport = true
            isVerticalScrollBarEnabled = true
            addView(texts, ViewGroup.LayoutParams(match, wrap))
        }
        val snooze = Button(this).apply {
            text = getString(R.string.action_snooze)
            isAllCaps = false
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            minHeight = dp(56)
            setOnClickListener {
                sendBroadcast(AlarmFireReceiver.snoozeIntent(this@RingActivity, AlarmService.current()))
            }
        }
        val dismiss = Button(this).apply {
            text = getString(R.string.action_dismiss)
            isAllCaps = false
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
            minHeight = dp(if (landscape) 56 else 64)
            setOnClickListener {
                sendBroadcast(AlarmFireReceiver.dismissIntent(this@RingActivity, AlarmService.current()?.recordId))
            }
        }
        val buttons = LinearLayout(this).apply {
            orientation = if (landscape) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
            if (landscape) {
                addView(snooze, LinearLayout.LayoutParams(0, wrap, 1f).apply { marginEnd = dp(16) })
                addView(dismiss, LinearLayout.LayoutParams(0, wrap, 1f))
            } else {
                addView(snooze, LinearLayout.LayoutParams(match, wrap).apply { bottomMargin = dp(16) })
                addView(dismiss, LinearLayout.LayoutParams(match, wrap))
            }
        }
        root.addView(scroll, LinearLayout.LayoutParams(match, 0, 1f))
        root.addView(buttons, LinearLayout.LayoutParams(match, wrap).apply { topMargin = dp(8) })
        setContentView(root)
        ViewCompat.requestApplyInsets(root)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        adoptBackup(intent)
        render()
    }

    /**
     * Opened by the backup ring notification, perhaps in a process that did not post it: the
     * alarm comes with the intent, and is shown until its ring timeout unless something else rings.
     */
    private fun adoptBackup(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_BACKUP, false) != true || AlarmService.ringing != null) return
        val alarm = AlarmService.alarmFrom(this, intent)
        if (System.currentTimeMillis() < alarm.fireAt + AlarmService.AUTO_SILENCE_MS && AlarmService.current()?.key != alarm.key) {
            AlarmService.setBackup(alarm)
        }
    }

    override fun onStart() {
        super.onStart()
        AlarmService.addListener(listener)
        if (AlarmService.current() == null) finish() else render()
    }

    override fun onStop() {
        AlarmService.removeListener(listener)
        handler.removeCallbacksAndMessages(null)
        super.onStop()
    }

    private fun render() {
        val alarm = AlarmService.current() ?: return
        time.text = AlarmService.formatTime(this, alarm.fireAt)
        fitTime()
        title.text = alarm.title
        text.text = alarm.text
        // A backup ring has no service to stop it: look again when its ring timeout comes.
        handler.removeCallbacksAndMessages(null)
        val left = alarm.fireAt + AlarmService.AUTO_SILENCE_MS - System.currentTimeMillis()
        if (left > 0) handler.postDelayed({ listener() }, left + 500L)
    }

    /**
     * Fix D (N-1): the time at the largest size that shows it whole on one line, never above
     * [timeMaxPx]; below [TimeFit.MIN_DP] it may take a second line instead of being cut.
     */
    private fun fitTime() {
        val available = (time.width - time.paddingLeft - time.paddingRight).toFloat()
        if (available <= 0f) return
        val atMax = Paint(time.paint).apply { textSize = timeMaxPx }.measureText(time.text.toString())
        val fit = TimeFit.size(timeMaxPx, dp(TimeFit.MIN_DP).toFloat(), atMax, available)
        time.maxLines = if (fit.wrap) 2 else 1
        if (fit.px != time.textSize) time.setTextSize(TypedValue.COMPLEX_UNIT_PX, fit.px)
    }

    companion object {
        /** On the backup ring notification's intent: the alarm rides along in the extras. */
        const val EXTRA_BACKUP = "no.stormberry.eclipsetracker.extra.BACKUP"
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun sp(v: Float): Float = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, v, resources.displayMetrics)
}

/**
 * Fix D (17 October 2026, N-1): the ring screen's time size, pure so the JVM tests check it. The
 * largest size [maxPx] when the text, measured at that size ([widthAtMax]), fits [availablePx];
 * otherwise the size scaled down in proportion with a 2 per cent margin for rounding, but never
 * below [minPx]: then the text keeps [minPx] and may take a second line ([Fit.wrap]), as the time
 * must never be cut.
 */
internal object TimeFit {
    /** The smallest the time is made, in dp, before it may wrap (larger than the title's 24 sp at font size 1.0). */
    const val MIN_DP = 32

    data class Fit(val px: Float, val wrap: Boolean)

    fun size(maxPx: Float, minPx: Float, widthAtMax: Float, availablePx: Float): Fit {
        if (widthAtMax <= availablePx || widthAtMax <= 0f) return Fit(maxPx, false)
        val scaled = maxPx * (availablePx / widthAtMax) * 0.98f
        val floor = minOf(minPx, maxPx)
        return if (scaled >= floor) Fit(scaled, false) else Fit(floor, true)
    }
}
