package com.slopus.happy.voice

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.data.SessionRecord
import io.elevenlabs.ConversationOverridesBuilder
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class VoiceContextTest {
    private fun session(id: String) = SessionRecord(id, 0, 0, 0, true, 0, """{"path":"/work","host":"host","summary":{"text":"Summary","updatedAt":0}}""", 0, null, 0, "", null)

    @Test fun fullInitialContextAndFocusAreInjectedOnceWithFiftyHistoryRows() {
        val context = mutableListOf<String>(); val prompts = mutableListOf<String>()
        val hooks = VoiceHooks({ session(it) }, { (1..55).map { ChatMessage.AgentText("$it", it.toLong(), "message $it") } }, context::add, prompts::add)
        val initial = hooks.start("a", listOf(session("a"), session("b")))
        assertTrue(initial.startsWith("Available sessions:\n- a: \"Summary\"\n- b: \"Summary\""))
        assertTrue(initial.contains("CURRENT SESSION:\n\n# Session ID: a"))
        assertTrue(initial.contains("<text>message 50</text>")); assertFalse(initial.contains("<text>message 51</text>"))
        hooks.focus("b"); hooks.focus("b")
        assertEquals(1, context.count { it.contains("# Session ID: b") })
        assertEquals("Session became focused: b", context.last())
        assertTrue(prompts.isEmpty())
    }

    @Test fun messagesAreSilentWhileReadyAndPermissionPromptsBatchUntilIdleAndClearOnStop() {
        val context = mutableListOf<String>(); val prompts = mutableListOf<String>()
        val hooks = VoiceHooks({ session(it) }, { emptyList() }, context::add, prompts::add)
        hooks.start("a", listOf(session("a")))
        hooks.mode(VoiceMode.AgentSpeaking)
        hooks.messages("a", listOf(ChatMessage.AgentText("m", 0, "done")))
        assertEquals("New messages in session: a\n\nClaude Code: \n<text>done</text>", context.single())
        hooks.ready("a"); hooks.permission("a", "request", "Bash", null)
        assertTrue(prompts.isEmpty())
        hooks.mode(VoiceMode.Idle)
        assertEquals(1, prompts.size)
        assertTrue(prompts.single().contains("Report this to the human immediately."))
        assertTrue(prompts.single().contains("<request_id>request</request_id>"))
        hooks.mode(VoiceMode.UserSpeaking); hooks.ready("a"); hooks.stop(); hooks.mode(VoiceMode.Idle)
        assertEquals(1, prompts.size)
    }

    @Test fun officialSdkPayloadUsesJwtDynamicVariablesAndOverrides() {
        val events = object : VoiceEvents {
            override fun disconnected() {}; override fun error() {}; override fun agentSpeaking(speaking: Boolean) {}; override fun vad(score: Float) {}
        }
        val tools = VoiceTools({ _, _ -> }, { null }, { _, _, _ -> }, {})
        val config = ElevenLabsTransport(ApplicationProvider.getApplicationContext<Context>()).configuration(
            VoiceSessionConfig("s", "history", agentId = "ignored", token = "jwt", userId = "u", systemPrompt = "prompt", firstMessage = "hello", language = "pt-br"), events, tools)
        assertNull(config.agentId); assertEquals("jwt", config.conversationToken)
        assertEquals(setOf("sendMessageToSession", "processPermissionRequest"), config.clientTools.keys)
        val payload = ConversationOverridesBuilder.constructOverrides(config)
        assertEquals("u", payload.getString("user_id"))
        assertEquals("s", payload.getJSONObject("dynamic_variables").getString("sessionId"))
        assertEquals("history", payload.getJSONObject("dynamic_variables").getString("initialConversationContext"))
        val agent = payload.getJSONObject("conversation_config_override").getJSONObject("agent")
        assertEquals("pt-br", agent.getString("language")); assertEquals("hello", agent.getString("first_message"))
        assertEquals("prompt", agent.getJSONObject("prompt").getString("prompt"))
    }

    @Test fun promptsAndExperimentsUsePersistentCountersAndGateDeveloperOverride() {
        assertEquals(VoiceUpsell.Control, VoiceUpsell.resolve(raw = "unknown", override = VoiceUpsell.Onboarding.wire))
        assertEquals(VoiceUpsell.Onboarding, VoiceUpsell.resolve(override = VoiceUpsell.Onboarding.wire, overrideEnabled = true))
        assertEquals(VoiceUpsell.SoftPaywall, VoiceUpsell.resolve(raw = VoiceUpsell.SoftPaywall.wire))
        assertEquals("Hi, Happy here", VoicePrompts.first(false, 2, true))
        assertEquals("Hi, Happy here", VoicePrompts.first(true, 0, true))
        val prompt = VoicePrompts.system("  history  ", 3, 9, false)
        assertFalse(prompt.contains("# Paid voice onboarding"))
        assertTrue(prompt.endsWith("# Conversation history so far\nhistory"))
        assertTrue(prompt.contains("- onboarding_prompt_load_count: 3\n- voice_message_count: 9"))
        val prefs = VoicePreferences(ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("counter-test", Context.MODE_PRIVATE))
        prefs.reset(); prefs.incrementMessages(); prefs.incrementOnboarding(); prefs.incrementSoftPaywalls()
        assertEquals(1, prefs.messages); assertEquals(1, prefs.onboardingLoads); assertEquals(1, prefs.softPaywalls)
        prefs.reset(); assertEquals(0, prefs.messages)
    }
}