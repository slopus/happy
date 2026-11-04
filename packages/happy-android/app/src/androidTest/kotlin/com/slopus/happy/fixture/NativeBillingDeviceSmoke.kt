package com.slopus.happy.fixture

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.BuildConfig
import com.slopus.happy.HappyApplication
import com.slopus.happy.R
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.payments.Offer
import com.slopus.happy.payments.OfferSheet
import com.slopus.happy.ui.call.CallSheet
import com.slopus.happy.ui.call.CallSheetTags
import com.slopus.happy.ui.call.OfferHost
import com.slopus.happy.ui.chat.ChatScreen
import com.slopus.happy.ui.chat.ChatScreenActions
import com.slopus.happy.ui.chat.ComposerTags
import com.slopus.happy.ui.connection.AgentHomeActions
import com.slopus.happy.ui.connection.AgentHomeScreen
import com.slopus.happy.ui.connection.AgentHomeTags
import com.slopus.happy.ui.connection.AgentVoiceScreen
import com.slopus.happy.ui.connection.AgentVoiceSummary
import com.slopus.happy.ui.connection.SupportSheet
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.settings.AboutActions
import com.slopus.happy.ui.settings.AboutInfo
import com.slopus.happy.ui.settings.SettingsProfile
import com.slopus.happy.ui.settings.SettingsScreen
import com.slopus.happy.ui.settings.supportAction
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import com.slopus.happy.ui.voice.LocalVoiceController
import com.slopus.happy.voice.MicrophoneAccess
import com.slopus.happy.voice.MicrophonePermission
import com.slopus.happy.voice.VoiceStart
import com.slopus.happy.voice.VoiceState
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The native billing owner and the relay voice gate on a device, through
 * the app's own graph: a Happy session's chat has no voice and its engine
 * asks for nothing; the agent home's voice button shows the debug preview
 * welcome and, closed, starts nothing; Support us opens the shared host,
 * whose Restore answers without a key. Pro is drawn from fixtures only.
 * No sign-in, purchase, microphone, grant or provider. Shots go to the
 * app's external files under `native-billing/`. Run on an assigned emulator.
 */
@RunWith(AndroidJUnit4::class)
class NativeBillingDeviceSmoke {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext
    private val graph by lazy { (app.applicationContext as HappyApplication).graph }
    private val dir = File(app.getExternalFilesDir(null), "native-billing").apply { mkdirs() }
    private var microphones = 0
    private val microphone = object : MicrophonePermission {
        override suspend fun request(): MicrophoneAccess { microphones++; return MicrophoneAccess(false, false) }
        override fun openSettings() {}
    }

    @After fun reset() {
        graph.offers.dismiss()
        graph.offers.preview(null)
    }

    private fun show(content: @Composable () -> Unit) {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent { HappyTheme(ThemePreference.Light) { content() } }
        rule.waitForIdle()
    }

    private fun capture(name: String, wait: Long = 1_200) {
        SystemClock.sleep(wait)
        device.takeScreenshot(File(dir, "$name.png"))
        android.util.Log.i("NativeBillingSmoke", "captured $name")
    }

    private fun relayChat() = ChatState(
        ChatSnapshot(loaded = true),
        ChatSessionInfo.from(SessionRecord("s", 0, 0, 1, true, 0, """{"path":"/p","host":"h"}""", 1, null, 1, "", null)),
        sessionLoaded = true, online = true, thinking = false,
    )

    @Test fun relayChatHasNoVoiceAndItsEngineAsksForNothing() {
        val voice = graph.voice
        assertFalse(voice.available)
        show {
            CompositionLocalProvider(LocalVoiceController provides voice) {
                ChatScreen(relayChat(), "", "gray", ChatScreenActions())
            }
        }
        rule.onNodeWithTag(ComposerTags.PRIMARY).assert(hasContentDescription("Send"))
        assertEquals(0, rule.onAllNodesWithText("Voice").fetchSemanticsNodes().size)
        capture("relay-chat-no-voice")
        assertEquals(VoiceStart.NotAvailable, runBlocking { voice.start("s", microphone) })
        assertEquals(0, microphones)
        assertEquals(VoiceState(), voice.state.value)
    }

    @Test fun agentVoiceShowsThePreviewWelcomeAndClosedStartsNothing() {
        graph.offers.intro.reset()
        graph.offers.preview("$20")
        val accounts = AccountMenu(listOf(AccountMenuEntry("fx-connection", "Studio Mac", agent = true, active = true)))
        show {
            AgentHomeScreen("Studio Mac", AgentFeed(loaded = true), AgentLinkStatus.Connected, accounts,
                AgentHomeActions({}, {}, {}, {}, {}, {}, onVoice = { graph.calls.start("fx-connection") { microphones++; false } }))
            OfferHost(graph.offers)
        }
        rule.onNodeWithTag(AgentHomeTags.VOICE, useUnmergedTree = true).performClick()
        rule.waitForIdle()
        assertTrue(graph.offers.sheet.value is OfferSheet.Welcome)
        rule.onNodeWithTag(CallSheetTags.WELCOME).assertExists()
        rule.onNodeWithTag(CallSheetTags.SUBSCRIBE).assertExists()
        rule.onNodeWithTag(CallSheetTags.RESTORE).assertExists()
        capture("agent-welcome-preview", 2_000)
        rule.onNodeWithTag(CallSheetTags.CLOSE).performClick()
        rule.waitForIdle()
        assertNull(graph.offers.sheet.value)
        // Seen: the next tap goes straight to the call, which this unknown connection doesn't have.
        rule.onNodeWithTag(AgentHomeTags.VOICE, useUnmergedTree = true).performClick()
        rule.waitForIdle()
        assertNull(graph.offers.sheet.value)
        assertEquals(0, microphones)
        assertFalse(graph.calls.state.value.isLive)
        capture("agent-after-close")
    }

    @Test fun supportUsOpensTheSharedHostAndRestoreAnswers() {
        graph.offers.preview("$20")
        show {
            SettingsScreen(SettingsProfile("fx", "Kai", "Happy account"), AboutInfo("1.8.0 (412)"),
                aboutActions = AboutActions(onSupport = supportAction(graph.offers)))
            OfferHost(graph.offers)
        }
        rule.onNodeWithText("Support us").performScrollTo().performClick()
        rule.waitForIdle()
        assertTrue(graph.offers.sheet.value is OfferSheet.Support)
        rule.onNodeWithText(app.getString(R.string.agent_voice_sheet_pledge, "$20")).assertExists()
        capture("support-pledge-preview", 2_000)
        // Without a key nothing reaches RevenueCat: Restore says it failed. With one, don't create a customer from a test.
        if (BuildConfig.REVENUE_CAT_GOOGLE_KEY.isBlank()) {
            rule.onNodeWithTag(CallSheetTags.RESTORE).performClick()
            rule.waitForIdle()
            capture("support-restore-answer")
        }
        android.util.Log.i("NativeBillingSmoke", "key present: ${BuildConfig.REVENUE_CAT_GOOGLE_KEY.isNotBlank()}")
    }

    /** Pro, drawn from fixtures: no purchase and no answer from RevenueCat. */
    @Test fun proFixtures() {
        val step = mutableIntStateOf(0)
        show {
            when (step.intValue) {
                0 -> SupportSheet(Offer.Subscribed, onDismiss = {}, onSubscribe = {}, onRestore = null, unconfirmed = false)
                1 -> AgentVoiceScreen(AgentVoiceSummary(4 * 3_600_000L + 12 * 60_000L, offer = Offer.Subscribed)) {}
                else -> CallSheet(OfferSheet.Used(System.currentTimeMillis() + 9 * 86_400_000L, Offer.Subscribed), onStart = {}, onDismiss = {})
            }
        }
        capture("pro-support-thanks", 2_000)
        rule.runOnUiThread { step.intValue = 1 }
        rule.waitForIdle()
        capture("pro-voice-page")
        rule.runOnUiThread { step.intValue = 2 }
        rule.waitForIdle()
        capture("pro-month-used", 2_000)
    }
}
