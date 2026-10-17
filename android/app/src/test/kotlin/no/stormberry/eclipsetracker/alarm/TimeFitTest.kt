package no.stormberry.eclipsetracker.alarm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Fix D (17 October 2026, N-1, found by the independent verification of fix C): the ring screen's
 * time was cut to one line, so at 320 dp in a 12-hour locale "10:07 AM" showed as "10:07". It is
 * now made smaller until it fits whole (TimeFit), and may take a second line only below the least size.
 */
class TimeFitTest {
    @Test fun aTimeThatFitsKeepsTheLargestSize() {
        assertEquals(TimeFit.Fit(168f, false), TimeFit.size(maxPx = 168f, minPx = 84f, widthAtMax = 600f, availablePx = 693f))
        assertEquals(TimeFit.Fit(168f, false), TimeFit.size(168f, 84f, 693f, 693f))
    }

    /** The verifier's case in numbers: 320 dp at density 2.625 less the side margins, 64 sp, "10:07 AM" too wide. */
    @Test fun aTimeTooWideIsMadeSmallerToFitWhole() {
        val fit = TimeFit.size(maxPx = 168f, minPx = 84f, widthAtMax = 760f, availablePx = 693f)
        assertFalse(fit.wrap)
        assertTrue("smaller", fit.px < 168f)
        assertTrue("whole: ${fit.px}", 760f * fit.px / 168f <= 693f)
        assertTrue("not needlessly small: ${fit.px}", 760f * fit.px / 168f >= 0.97f * 693f)
    }

    @Test fun belowTheLeastSizeItWrapsInsteadOfBeingCut() {
        assertEquals(TimeFit.Fit(84f, true), TimeFit.size(168f, 84f, 2000f, 693f))
        // A largest size under the least one is never raised.
        assertEquals(TimeFit.Fit(60f, true), TimeFit.size(60f, 84f, 2000f, 300f))
    }

    @Test fun nothingMeasuredKeepsTheLargestSize() {
        assertEquals(TimeFit.Fit(168f, false), TimeFit.size(168f, 84f, 0f, 693f))
    }
}
