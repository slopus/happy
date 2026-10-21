package com.slopus.happy.voice

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.auth.AuthCredentials
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class VoiceEngineTest {
    private class Fixture(val test: TestScope) {
        val log = mutableListOf<String>()
        val prefs = VoicePreferences(ApplicationProvider.getApplicationContext<Context>()
            .getSharedPreferences("voice-test", Context.MODE_PRIVATE).also { it.edit().clear().commit() })
        var options = VoiceOptions()
        var auth: AuthCredentials? = AuthCredentials("token", "secret")
        var response: VoiceCredentials = grant
        var pro = false
        var purchased = false
        var connect: suspend () -> Unit = {}
        var credentials: suspend () -> Unit = {}
        lateinit var events: VoiceEvents
        lateinit var config: VoiceSessionConfig
        val connection = object : VoiceConnection {
            override val conversationId = "sdk-id"
            override suspend fun end() { log += "end" }
            override fun context(text: String) { log += text }
            override fun prompt(text: String) { log += text }
            override suspend fun mute(muted: Boolean) { log += "mute:$muted" }
        }
        val engine = VoiceEngine(
            scope = test.backgroundScope,
            service = object : VoiceService {
                override suspend fun credentials(credentials: AuthCredentials): VoiceCredentials {
                    log += "credentials"; this@Fixture.credentials(); return response
                }
                override suspend fun usage(credentials: AuthCredentials) = VoiceUsage(1, 2, 3, 4)
            },
            transport = VoiceTransport { config, events, _ ->
                log += "connect"; this.config = config; this.events = events; connect(); connection
            },
            credentials = { auth }, options = { options },
            paywall = object : VoicePaywall {
                override fun hasPro() = pro
                override suspend fun present(flow: String): Boolean {
                    log += flow
                    if (purchased) { response = grant; pro = true }
                    return purchased
                }
            },
            preferences = prefs,
            contextFactory = { object : VoiceSessionContext {
                override suspend fun initial(sessionId: String): String { log += "initial:$sessionId"; return "history" }
                override fun connected(connection: VoiceConnection, mode: VoiceMode) { log += "connected" }
                override fun mode(mode: VoiceMode) { log += mode.name }
                override suspend fun focus(sessionId: String) { log += "focus:$sessionId" }
                override fun stop() { log += "context-stop" }
            } },
            toolsFactory = { current, sent -> VoiceTools({ _, _ -> }, { null }, { _, _, _ -> }, sent, current) },
            dispatcher = StandardTestDispatcher(test.testScheduler), clock = { 123L },
        )
        fun microphone(granted: Boolean = true, canAsk: Boolean = false) = object : MicrophonePermission {
            override suspend fun request(): MicrophoneAccess { log += "mic"; return MicrophoneAccess(granted, canAsk) }
            override fun openSettings() {}
        }
    }

    @Test fun deniedMicrophoneAllocatesNoConversation() = runTest {
        val f = Fixture(this)
        assertEquals(VoiceStart.MicrophoneDenied(false), f.engine.start("s", f.microphone(false)))
        assertEquals(listOf("mic"), f.log)
        assertEquals(VoiceState(), f.engine.state.value)
    }

    @Test fun openingSpeechReportedInsideConnectSurvivesConnectedTransition() = runTest {
        val f = Fixture(this)
        f.connect = { f.events.agentSpeaking(true); yield() }
        f.engine.start("s", f.microphone())
        assertEquals(VoiceMode.AgentSpeaking, f.engine.state.value.mode)
        f.engine.stop()
    }

    @Test fun bypassUsesPublicAgentAfterMicrophoneWithoutHappyAuthOrPaywall() = runTest {
        val f = Fixture(this)
        f.auth = null; f.options = VoiceOptions(bypass = true, customAgentId = "custom", language = "pt-br")
        assertEquals(VoiceStart.Started("sdk-id"), f.engine.start("s", f.microphone()))
        assertEquals(listOf("mic", "initial:s", "connect", "connected"), f.log)
        assertEquals("custom", f.config.agentId); assertNull(f.config.token); assertNull(f.config.systemPrompt)
        assertEquals("pt-br", f.config.language)
        f.engine.stop()
    }

    @Test fun missingAuthIsReportedAfterPermission() = runTest {
        val f = Fixture(this); f.auth = null
        assertEquals(VoiceStart.NotSignedIn, f.engine.start("s", f.microphone()))
        assertEquals(listOf("mic"), f.log)
    }

    @Test fun conversationLimitShowsAlertWithoutPaywall() = runTest {
        val f = Fixture(this); f.response = VoiceCredentials.Denied("voice_conversation_limit_reached")
        assertEquals(VoiceStart.LimitReached, f.engine.start("s", f.microphone()))
        assertEquals(listOf("mic", "credentials"), f.log)
    }

    @Test fun hardGateRetriesCredentialsOnlyAfterPurchase() = runTest {
        val f = Fixture(this); f.response = VoiceCredentials.Denied("subscription_required"); f.purchased = true
        assertEquals(VoiceStart.Started("server-id"), f.engine.start("s", f.microphone()))
        assertEquals(listOf("mic", "credentials", "voice_must_pay", "credentials", "initial:s", "connect", "connected"), f.log)
        assertEquals("jwt", f.config.token); assertEquals("user", f.config.userId)
        f.engine.stop()
    }

    @Test fun cancelledHardPaywallDoesNotStartTransport() = runTest {
        val f = Fixture(this); f.response = VoiceCredentials.Denied("voice_hard_limit_reached")
        assertEquals(VoiceStart.Declined, f.engine.start("s", f.microphone()))
        assertEquals(listOf("mic", "credentials", "voice_must_pay"), f.log)
    }

    @Test fun softPaywallIsOnceAndDismissalContinues() = runTest {
        val f = Fixture(this); f.options = VoiceOptions(upsell = VoiceUpsell.SoftPaywall)
        assertTrue(f.engine.start("s", f.microphone()) is VoiceStart.Started)
        f.engine.stop()
        assertTrue(f.engine.start("s", f.microphone()) is VoiceStart.Started)
        assertEquals(1, f.log.count { it == "voice_trial_eligible" }); assertEquals(1, f.prefs.softPaywalls)
        f.engine.stop()
    }

    @Test fun onboardingCounterOnlyAdvancesOnSuccessfulFreeCall() = runTest {
        val f = Fixture(this); f.options = VoiceOptions(upsell = VoiceUpsell.Onboarding)
        f.connect = { error("network failed") }
        assertEquals(VoiceStart.Unavailable, f.engine.start("s", f.microphone()))
        assertEquals(0, f.prefs.onboardingLoads)
        f.connect = {}
        f.engine.start("s", f.microphone())
        assertEquals(1, f.prefs.onboardingLoads)
        assertTrue(f.config.systemPrompt!!.contains("# Paid voice onboarding"))
        assertEquals("Hi, Happy here, ask me what I can do", f.config.firstMessage)
        f.engine.stop()
    }

    @Test fun stopDuringUncooperativeConnectClosesLateConnectionAndIgnoresOldCallbacks() = runTest {
        val f = Fixture(this); val ready = CompletableDeferred<Unit>()
        f.connect = { withContext(NonCancellable) { ready.await() } }
        val start = async { f.engine.start("s", f.microphone()) }
        runCurrent()
        val oldEvents = f.events
        val stop = launch { f.engine.stop() }
        runCurrent()
        assertEquals(VoiceState(), f.engine.state.value)
        assertEquals(VoiceStart.Declined, f.engine.start("too-soon", f.microphone()))
        ready.complete(Unit); runCurrent(); stop.join()
        assertTrue(start.isCancelled); assertEquals(1, f.log.count { it == "end" })
        f.connect = {}; f.engine.start("new", f.microphone())
        oldEvents.agentSpeaking(true); oldEvents.disconnected(); runCurrent()
        assertEquals(VoiceStatus.Connected, f.engine.state.value.status)
        assertEquals("new", f.engine.state.value.sessionId)
        f.engine.stop()
    }

    @Test fun stopDuringCredentialsCannotLaterOpenMicrophoneTransport() = runTest {
        val f = Fixture(this); val response = CompletableDeferred<Unit>()
        f.credentials = { response.await() }
        val start = async { f.engine.start("s", f.microphone()) }; runCurrent()
        f.engine.stop(); response.complete(Unit); runCurrent()
        assertTrue(start.isCancelled); assertFalse(f.log.contains("connect")); assertEquals(VoiceState(), f.engine.state.value)
    }

    @Test fun speakingPriorityVadSilenceMuteAndFocusUseTheLiveCall() = runTest {
        val f = Fixture(this); f.engine.start("s", f.microphone())
        assertEquals(123L, f.engine.state.value.connectedAtElapsed)
        f.events.vad(0.9f); runCurrent(); assertEquals(VoiceMode.UserSpeaking, f.engine.state.value.mode)
        f.events.vad(0f); runCurrent(); advanceTimeBy(299); runCurrent()
        assertEquals(VoiceMode.UserSpeaking, f.engine.state.value.mode)
        advanceTimeBy(1); runCurrent(); assertEquals(VoiceMode.Idle, f.engine.state.value.mode)
        f.events.agentSpeaking(true); f.events.vad(1f); runCurrent()
        assertEquals(VoiceMode.AgentSpeaking, f.engine.state.value.mode)
        f.engine.setMuted(true); f.engine.focus("other"); runCurrent()
        assertTrue(f.engine.state.value.muted); assertEquals("other", f.engine.state.value.sessionId)
        assertTrue(f.log.contains("focus:other"))
        f.events.disconnected(); runCurrent(); assertEquals(VoiceState(), f.engine.state.value)
    }

    companion object { private val grant = VoiceCredentials.Granted("jwt", "server-id", "agent", "user") }
}