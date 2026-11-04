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
import com.slopus.happy.payments.CallIntro
import com.slopus.happy.payments.Offer
import com.slopus.happy.payments.OfferSheet
import com.slopus.happy.ui.connection.SupportSheet
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        rule.setHappyContent { CallSheet(OfferSheet.Welcome(Offer.Preview("$20")), onStart = { started++ }, onDismiss = {}) }
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
        rule.setHappyContent { CallSheet(OfferSheet.Used(System.currentTimeMillis() + 3_600_000, Offer.Unavailable), onStart = { started++ }, onDismiss = {}) }
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
        rule.setHappyContent { CallSheet(OfferSheet.Used(null, Offer.Unavailable), onStart = {}, onDismiss = {}) }
        rule.waitForIdle()
        text("Your free voice time is used. It comes back as older calls pass 30 days.").assertExists()
    }

    /** Debug builds' preview: the price and what it pays for, its Subscribe a notice that nothing was bought; it never starts or grants. */
    @Test
    fun thePreviewOfferChargesAndGrantsNothing() {
        var started = 0
        var dismissed = 0
        rule.setHappyContent { CallSheet(OfferSheet.Used(null, Offer.Preview("$20")), onStart = { started++ }, onDismiss = { dismissed++ }) }
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
        assertFalse(intro.welcomes(Offer.Unavailable))
        assertTrue(CallIntro(preferences).due)
        val preview = Offer.Preview("$20")
        assertTrue(intro.welcomes(preview))
        // Seen, however it was closed: from now on the button calls.
        assertFalse(CallIntro(preferences).due)
        assertFalse(CallIntro(preferences).welcomes(preview))
        intro.reset()
        assertTrue(intro.due)
    }

    /** The relay's voice refused without the subscription: voice's sheet, no free way on, its start greyed out. */
    @Test
    fun theRelaysRequiredSheetHasNoFreeWayOn() {
        var started = 0
        rule.setHappyContent { CallSheet(OfferSheet.Required(Offer.OnSale("9,99 €")), onStart = { started++ }, onDismiss = {}, onRestore = { com.slopus.happy.payments.RestoreResult.NothingFound }) }
        rule.waitForIdle()
        rule.node(CallSheetTags.PAYWALL).assertExists()
        for (line in listOf("Talk to your agents", "Support Happy for 9,99 €/month", "5 hours of real-time voice included")) text(line).assertExists()
        rule.node(CallSheetTags.SUBSCRIBE).assertExists()
        rule.node(CallSheetTags.RESTORE).assertExists()
        rule.node(CallSheetTags.SESSION).assertIsNotEnabled().performClick()
        rule.waitForIdle()
        assertEquals(0, started)
    }

    /** Support us: the boba's sheet sells the same subscription, says nothing about voice and has no voice session. */
    @Test
    fun supportSellsTheSameSubscriptionWithoutVoice() {
        var subscribed = 0
        rule.setHappyContent { SupportSheet(Offer.OnSale("9,99 €"), onDismiss = {}, onSubscribe = { subscribed++ }, onRestore = { com.slopus.happy.payments.RestoreResult.NothingFound }) }
        rule.waitForIdle()
        text("Support Happy open source").assertExists()
        text("Support Happy for 9,99 €/month").assertExists()
        text("Talk to your agents").assertDoesNotExist()
        text("5 hours of real-time voice included").assertDoesNotExist()
        rule.node(CallSheetTags.SESSION).assertDoesNotExist()
        rule.node(CallSheetTags.SUBSCRIBE).performClick()
        rule.waitForIdle()
        assertEquals(1, subscribed)
        rule.node(CallSheetTags.RESTORE).performClick()
        rule.waitForIdle()
        rule.onNodeWithText(context.getString(R.string.call_restore_none)).assertExists()
    }

    /** Nothing on sale, it still opens and says so; with pro, it thanks and sells nothing more. */
    @Test
    fun supportSaysWhenNothingIsOnSaleAndThanksASubscriber() {
        var offer by androidx.compose.runtime.mutableStateOf<Offer>(Offer.Unavailable)
        rule.setHappyContent { SupportSheet(offer, onDismiss = {}) }
        rule.waitForIdle()
        rule.onNodeWithText(context.getString(R.string.settings_support_unavailable)).assertExists()
        rule.node(CallSheetTags.SUBSCRIBE).assertDoesNotExist()
        offer = Offer.Subscribed
        rule.waitForIdle()
        rule.onNodeWithText(context.getString(R.string.settings_support_us_subtitle_pro)).assertExists()
        rule.node(CallSheetTags.SUBSCRIBE).assertDoesNotExist()
        rule.node(CallSheetTags.RESTORE).assertDoesNotExist()
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
