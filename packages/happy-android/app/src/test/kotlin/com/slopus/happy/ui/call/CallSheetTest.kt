package com.slopus.happy.ui.call

import android.content.Context
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.R
import com.slopus.happy.call.CallIntro
import com.slopus.happy.call.CallOffer
import com.slopus.happy.call.CallSheet
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.security.MessageDigest

/** Voice's welcome and used-up sheet ([CallSheet]), as iOS's `CallSheetViewController` draws them. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CallSheetTest {
    @get:Rule val rule = createComposeRule()
    private val context = ApplicationProvider.getApplicationContext<Context>()

    private fun text(text: String) = rule.onNodeWithText(text, useUnmergedTree = true)

    @Test
    fun theWelcomeSaysWhatVoiceDoesAndStartsTheFreeCall() {
        var started = 0
        rule.setHappyContent { CallSheet(CallSheet.Welcome(CallOffer.Preview("$20")), onStart = { started++ }, onDismiss = {}) }
        rule.waitForIdle()
        rule.node(CallSheetTags.WELCOME).assertExists()
        for (line in listOf("Talk to your agents", "Ask how your work is going", "Open and send by voice", "20 free minutes", "Support Happy for $20/month")) text(line).assertExists()
        rule.node(CallSheetTags.SUBSCRIBE).assertExists()
        rule.node(CallSheetTags.WARNING).assertDoesNotExist()
        rule.node(CallSheetTags.SESSION).assertIsEnabled().performClick()
        rule.waitForIdle()
        assertEquals(1, started)
    }

    @Test
    fun usedUpItIsTheSameScreenWithItsStartGreyedOutAndSaysWhenTimeIsBack() {
        var started = 0
        rule.setHappyContent { CallSheet(CallSheet.Used(System.currentTimeMillis() + 3_600_000, CallOffer.Unavailable), onStart = { started++ }, onDismiss = {}) }
        rule.waitForIdle()
        rule.node(CallSheetTags.PAYWALL).assertExists()
        text("Talk to your agents").assertExists()
        text("20 free minutes").assertExists()
        val warning = rule.node(CallSheetTags.WARNING).fetchSemanticsNode().config[SemanticsProperties.Text].joinToString()
        assertTrue(warning, warning.startsWith("Your free voice time is used. More comes back "))
        rule.node(CallSheetTags.SESSION).assertIsNotEnabled().performClick()
        rule.waitForIdle()
        assertEquals(0, started)
    }

    @Test
    fun withNoTimeComingBackItSaysHowItComesBack() {
        rule.setHappyContent { CallSheet(CallSheet.Used(null, CallOffer.Unavailable), onStart = {}, onDismiss = {}) }
        rule.waitForIdle()
        text("Your free voice time is used. It comes back as older calls pass 30 days.").assertExists()
    }

    /** Debug builds' preview: the price and what it pays for, its Subscribe a notice that nothing was bought; it never starts or grants. */
    @Test
    fun thePreviewOfferChargesAndGrantsNothing() {
        var started = 0
        var dismissed = 0
        rule.setHappyContent { CallSheet(CallSheet.Used(null, CallOffer.Preview("$20")), onStart = { started++ }, onDismiss = { dismissed++ }) }
        rule.waitForIdle()
        for (line in listOf("Support Happy for $20/month", "5 hours of real-time voice included", "Happy is open source. Subscribing to voice pays for its development.", "Test preview. Nothing is charged.")) text(line).assertExists()
        rule.node(CallSheetTags.SUBSCRIBE).performClick()
        rule.waitForIdle()
        rule.onNodeWithText(context.getString(R.string.call_preview_message)).assertExists()
        assertEquals(0, started)
        assertEquals(0, dismissed)
        rule.node(CallSheetTags.SESSION).assertIsNotEnabled()
    }

    @Test
    fun theWelcomeShowsOnceAndOnlyWhileSomethingIsOnSale() {
        val preferences = context.getSharedPreferences("call-intro-test", Context.MODE_PRIVATE)
        val intro = CallIntro(preferences)
        intro.reset()
        // Nothing on sale: the button just calls, and the welcome stays due for when something is.
        assertNull(intro.welcome(CallOffer.Unavailable))
        assertTrue(CallIntro(preferences).due)
        val preview = CallOffer.Preview("$20")
        assertEquals(CallSheet.Welcome(preview), intro.welcome(preview))
        // Seen, however it was closed: from now on the button calls.
        assertFalse(CallIntro(preferences).due)
        assertNull(CallIntro(preferences).welcome(preview))
        intro.reset()
        assertTrue(intro.due)
    }

    @Test
    fun aTimeBackIsCountedInCalendarDays() {
        val day = 86_400_000L
        val now = java.util.Calendar.getInstance().apply { set(2026, 10, 4, 12, 0) }.timeInMillis
        assertEquals(0, CallSheetDays.between(now, now + 3_600_000))
        assertEquals(1, CallSheetDays.between(now, now + day))
        assertEquals(8, CallSheetDays.between(now, now + 8 * day))
    }

    /** The podcast mic is the sticker iOS ships, gunzipped and otherwise unmodified (iOS Animations/PROVENANCE.md). */
    @Test
    fun theMicIsItsExactBytes() {
        val bytes = context.resources.openRawResource(R.raw.call_podcast_mic).use { it.readBytes() }
        val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        assertEquals("f90db7a207596916bc5c0b22db6e3ca40f2e24008b015bc654ee1aa5ff724284", hash)
    }
}
