package com.slopus.happy.ui.voice

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.model.Settings
import com.slopus.happy.ui.*
import com.slopus.happy.ui.chat.*
import com.slopus.happy.ui.components.PromptTags
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.voice.*
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

internal class FakeVoice : VoiceController {
    override val state = MutableStateFlow(VoiceState())
    var starts = 0
    var stops = 0
    var focused: String? = null
    var outcome: VoiceStart = VoiceStart.Started("conversation")
    override suspend fun start(sessionId: String, microphone: MicrophonePermission): VoiceStart {
        starts++
        if (outcome is VoiceStart.Started) state.value = VoiceState(VoiceStatus.Connecting, sessionId = sessionId)
        return outcome
    }
    override suspend fun stop() { stops++; state.value = VoiceState() }
    override fun focus(sessionId: String) { if (state.value.status != VoiceStatus.Connecting) focused = sessionId }
}

/** RN VoiceAssistantStatusBar, AgentInput primary-action ordering, and settings/voice on a phone. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class VoiceUiTest {
    @get:Rule val rule = createComposeRule()

    @Test fun fullPillHasTheHeaderControlGeometryAndEndsInEveryVisibleState() {
        val status = mutableStateOf(VoiceStatus.Connecting)
        var ended = 0
        rule.setHappyContent {
            VoiceStatusBarContent(VoiceState(status.value), "1:23", false, { ended++ })
        }
        val pill = rule.node("voice.pill").bounds
        assertBox("pill", pill, 16.dp, 6.dp, 379.dp, 44.dp)
        assertDp("wrapper adds six above", 50, rule.node("voice.full").bounds.height)
        rule.onNodeWithText("Connecting…").assertExists()
        rule.node("voice.pill").performClick()
        status.value = VoiceStatus.Connected
        rule.node("voice.duration").assertTextEquals("1:23")
        rule.node("voice.pill").performClick()
        status.value = VoiceStatus.Error
        rule.node("voice.pill").performClick()
        assertEquals(3, ended)
        status.value = VoiceStatus.Disconnected
        rule.node("voice.full").assertDoesNotExist()
    }

    private fun chat(online: Boolean = true, thinking: Boolean = false) = ChatState(
        ChatSnapshot(loaded = true),
        ChatSessionInfo.from(SessionRecord("s", 0, 0, 1, online, 0, """{"path":"/p","host":"h"}""", 1, null, 1, "", null)),
        sessionLoaded = true, online = online, thinking = thinking,
    )

    @Test fun emptyComposerStartsVoiceThenThePillIsTheOnlyStopControl() {
        val voice = FakeVoice()
        rule.setHappyContent {
            CompositionLocalProvider(LocalVoiceController provides voice) {
                ChatScreen(chat(), "", "gray", ChatScreenActions())
            }
        }
        rule.node(ComposerTags.PRIMARY).assert(hasContentDescription("Voice")).assertIsEnabled().performClick()
        rule.waitForIdle()
        assertEquals(1, voice.starts)
        assertEquals("s", voice.focused)
        rule.node(ComposerTags.PRIMARY).assert(hasContentDescription("Send")).assertIsNotEnabled()
        rule.node("voice.pill").performClick()
        rule.waitForIdle()
        assertEquals(1, voice.stops)
        rule.node(ComposerTags.PRIMARY).assert(hasContentDescription("Voice")).assertIsEnabled()
    }

    @Test fun offlineSessionHasNoMic() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalVoiceController provides FakeVoice()) {
                ChatScreen(chat(online = false), "", "gray", ChatScreenActions())
            }
        }
        rule.node(ComposerTags.PRIMARY).assert(hasContentDescription("Send")).assertIsNotEnabled()
    }

    @Test fun typedContentSendsAndBlankBusyComposerStopsBeforeVoice() {
        val voice = FakeVoice()
        val draft = mutableStateOf("follow up")
        var sent = ""
        rule.setHappyContent {
            CompositionLocalProvider(LocalVoiceController provides voice) {
                ChatScreen(chat(thinking = true), draft.value, "gray", ChatScreenActions(onSend = { sent = it }))
            }
        }
        rule.node(ComposerTags.PRIMARY).assert(hasContentDescription("Send")).performClick()
        assertEquals("follow up", sent)
        assertEquals(0, voice.starts)
        draft.value = ""
        rule.node(ComposerTags.PRIMARY).assert(hasContentDescription("Stop"))
    }

    @Test fun deniedStartShowsTheSpecificAlertAndOffersRetry() {
        val voice = FakeVoice().apply { outcome = VoiceStart.MicrophoneDenied(true) }
        rule.setHappyContent {
            CompositionLocalProvider(LocalVoiceController provides voice) {
                ChatScreen(chat(), "", "gray", ChatScreenActions())
            }
        }
        rule.node(ComposerTags.PRIMARY).performClick()
        rule.onNodeWithText("Microphone Access Required").assertExists()
        rule.onNodeWithText("Cancel").performClick()
        rule.node(ComposerTags.PRIMARY).assert(hasContentDescription("Voice")).assertIsEnabled()
    }

    @Test fun switchingChatsDuringConnectionRefreshesContextOnceConnected() {
        val voice = FakeVoice().apply { state.value = VoiceState(VoiceStatus.Connecting) }
        val id = mutableStateOf("first")
        rule.setHappyContent {
            CompositionLocalProvider(LocalVoiceController provides voice) { rememberVoiceAction(id.value, true) }
        }
        id.value = "second"
        rule.waitForIdle()
        assertNull(voice.focused)
        voice.state.value = VoiceState(VoiceStatus.Connected, sessionId = "first")
        rule.waitForIdle()
        assertEquals("second", voice.focused)
    }

    @Test fun languageSearchMatchesNativeNameAndSelectionReturnsImmediately() {
        var chosen: String? = null
        var back = false
        rule.setHappyContent { VoiceLanguageScreen("en-US", { chosen = it }, { back = true }) }
        val field = rule.node("voice.searchField").bounds
        assertDp("search side inset", 16, field.left)
        assertDp("search width", 379, field.width)
        rule.node("voice.search").performTextInput("日本")
        rule.node("voice.language.ja-JP").assertExists().performClick()
        assertEquals("ja-JP", chosen)
        assertTrue(back)
        rule.onNodeWithContentDescription("Clear search", useUnmergedTree = true).performClick()
        rule.node("voice.language.auto").assertExists()
    }

    @Test fun customAgentPromptTrimsAndTogglesDirectConnection() {
        val settings = mutableStateOf(Settings())
        rule.setHappyContent {
            VoiceSettingsScreen(settings.value, { settings.value = it(settings.value) }, null, false, true, {}, {}, {})
        }
        rule.node("voice.language").assertExists()
        rule.node("voice.agent").performScrollTo().performClick()
        rule.node(PromptTags.INPUT).performTextReplacement("  agent_123  ")
        rule.node(PromptTags.CONFIRM).performClick()
        assertEquals("agent_123", settings.value.voiceCustomAgentId)
        assertTrue(settings.value.voiceBypassToken)
        rule.node("voice.agent").performScrollTo().performClick()
        rule.node(PromptTags.INPUT).performTextReplacement("   ")
        rule.node(PromptTags.CONFIRM).performClick()
        assertNull(settings.value.voiceCustomAgentId)
        assertFalse(settings.value.voiceBypassToken)
    }

    @Test fun usageAndSupportUseStandardSettingsInsets() {
        rule.setHappyContent { VoiceSettingsScreen(Settings(), {}, VoiceUsage(60, 600, 1, 10), false, false, {}, {}, {}) }
        rule.node("voice.usage").assertExists()
        rule.node("voice.support").assertExists()
        rule.onNodeWithText("1m 0s / 10m 0s").assertExists()
        assertDp("usage inset from group", 16, rule.node("voice.usage").bounds.left)
    }
}

/** Sidebar variant on RN's tablet: a 32-high row; speaking bars take 9×12 and disappear at idle. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w1280dp-h800dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class VoiceTabletTest {
    @get:Rule val rule = createComposeRule()
    @Test fun sidebarGeometrySpeakingAndAllStatuses() {
        val state = mutableStateOf(VoiceState(VoiceStatus.Connected, VoiceMode.AgentSpeaking))
        var stopped = false
        rule.setHappyContent {
            ProvideWindowLayout {
                Column(Modifier.fillMaxWidth()) { VoiceStatusBarContent(state.value, "2:01", true, { stopped = true }) }
            }
        }
        assertDp("sidebar height", 32, rule.node("voice.sidebar").bounds.height)
        assertDp("sidebar fills width", 1280, rule.node("voice.sidebar").bounds.width)
        assertDp("bars height", 12, rule.node("voice.bars").bounds.height)
        assertDp("bars width", 9, rule.node("voice.bars").bounds.width)
        rule.node("voice.sidebar").performClick()
        assertTrue(stopped)
        state.value = state.value.copy(status = VoiceStatus.Connecting, mode = VoiceMode.Idle)
        rule.node("voice.bars").assertDoesNotExist()
        state.value = state.value.copy(status = VoiceStatus.Error)
        rule.node("voice.sidebar").assertExists()
        state.value = VoiceState()
        rule.node("voice.sidebar").assertDoesNotExist()
    }

    @Test fun voiceSettingsAndLanguageRespectTabletContentWidth() {
        rule.setHappyContent {
            ProvideWindowLayout { VoiceSettingsScreen(Settings(), {}, null, false, true, {}, {}, {}) }
        }
        rule.node("voice.support").assertDoesNotExist()
        val row = rule.node("voice.language").bounds
        assertTrue("standard settings content remains centred on tablet", row.width.value <= 800)
        assertDp("centred", (1280.dp - row.width) / 2, row.left)
    }

    @Test fun tabletComposerUsesTheSame42ButtonAnd24VoiceGlyph() {
        rule.setHappyContent {
            ProvideWindowLayout {
                ChatComposer("", {}, null, PrimaryAction.Voice, {})
            }
        }
        val button = rule.node(ComposerTags.PRIMARY)
        button.assert(hasContentDescription("Voice")).assertIsEnabled()
        assertDp("primary width", 42, button.bounds.width)
        assertDp("primary height", 42, button.bounds.height)
    }
}