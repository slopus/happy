package com.slopus.happy.voice

import android.os.SystemClock
import com.slopus.happy.auth.AuthCredentials
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class VoiceOptions(val bypass: Boolean = false, val customAgentId: String? = null, val language: String? = null, val upsell: VoiceUpsell = VoiceUpsell.Control)

interface VoiceSessionContext {
    suspend fun initial(sessionId: String): String
    fun connected(connection: VoiceConnection, mode: VoiceMode)
    fun mode(mode: VoiceMode)
    suspend fun focus(sessionId: String)
    fun stop()
}

/** RealtimeSession.ts's gating and call lifecycle. All mutations run on [dispatcher]. */
class VoiceEngine(
    private val scope: CoroutineScope,
    private val service: VoiceService,
    private val transport: VoiceTransport,
    private val credentials: () -> AuthCredentials?,
    private val options: () -> VoiceOptions,
    private val paywall: VoicePaywall,
    private val preferences: VoicePreferences,
    private val contextFactory: () -> VoiceSessionContext,
    private val toolsFactory: (isCurrent: () -> Boolean, onSent: () -> Unit) -> VoiceTools,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Main.immediate,
    private val clock: () -> Long = SystemClock::elapsedRealtime,
) : VoiceController {
    private val mutableState = MutableStateFlow(VoiceState())
    override val state = mutableState.asStateFlow()
    @Volatile private var generation = 0L
    private var starting: Job? = null
    @Volatile private var closing: CompletableDeferred<Unit>? = null
    private var connection: VoiceConnection? = null
    private var context: VoiceSessionContext? = null
    private var silence: Job? = null
    private var agentSpeaking = false

    override suspend fun start(sessionId: String, microphone: MicrophonePermission): VoiceStart = withContext(dispatcher) {
        if (closing != null || state.value.status in listOf(VoiceStatus.Connecting, VoiceStatus.Connected)) return@withContext VoiceStart.Declined
        val epoch = ++generation
        starting = currentCoroutineContext()[Job]
        mutableState.value = VoiceState(status = VoiceStatus.Connecting)
        var opened: VoiceConnection? = null
        try {
            val permission = microphone.request()
            currentCoroutineContext().ensureActive()
            if (!permission.granted) return@withContext fail(VoiceStart.MicrophoneDenied(permission.canAskAgain))
            val selected = options()
            var config: VoiceSessionConfig
            var hasPro = false
            var grant: VoiceCredentials.Granted? = null
            if (selected.bypass && !selected.customAgentId.isNullOrEmpty()) {
                config = VoiceSessionConfig(sessionId, "", agentId = selected.customAgentId, language = selected.language)
            } else {
                var bought = false
                while (true) {
                    val auth = credentials() ?: return@withContext fail(VoiceStart.NotSignedIn)
                    when (val response = service.credentials(auth)) {
                        is VoiceCredentials.Granted -> { grant = response; break }
                        is VoiceCredentials.Denied -> {
                            if (response.reason == "voice_conversation_limit_reached") return@withContext fail(VoiceStart.LimitReached)
                            // Guard a server that still denies after a completed purchase, avoiding an endless paywall loop.
                            if (bought || !paywall.present("voice_must_pay")) return@withContext fail(VoiceStart.Declined)
                            bought = true
                        }
                    }
                }
                hasPro = paywall.hasPro()
                if (!hasPro && selected.upsell == VoiceUpsell.SoftPaywall && preferences.softPaywalls < 1) {
                    preferences.incrementSoftPaywalls()
                    paywall.present("voice_trial_eligible")
                }
                config = VoiceSessionConfig(sessionId, "", token = grant.conversationToken, agentId = grant.agentId,
                    userId = grant.userId, language = selected.language)
            }
            currentCoroutineContext().ensureActive()
            check(epoch == generation)
            val sessionContext = contextFactory().also { context = it }
            val initial = sessionContext.initial(sessionId)
            config = config.copy(initialContext = initial)
            if (grant != null) {
                config = config.copy(
                    systemPrompt = VoicePrompts.system(initial, preferences.onboardingLoads, preferences.messages, !hasPro && selected.upsell == VoiceUpsell.Onboarding),
                    firstMessage = VoicePrompts.first(hasPro, preferences.onboardingLoads, selected.upsell == VoiceUpsell.Onboarding),
                )
            }
            val tools = toolsFactory({ epoch == generation && state.value.status != VoiceStatus.Disconnected }) {
                scope.launch(dispatcher) {
                    if (epoch == generation && connection != null) {
                        preferences.incrementMessages()
                        connection?.context("# Runtime counters updated\n- voice_message_count: ${preferences.messages}")
                    }
                }
            }
            opened = transport.connect(config, events(epoch), tools)
            currentCoroutineContext().ensureActive()
            if (epoch != generation) throw CancellationException("Voice call ended while connecting")
            connection = opened
            val observedMode = state.value.mode
            mutableState.value = VoiceState(VoiceStatus.Connected, mode = observedMode, sessionId = sessionId, connectedAtElapsed = clock())
            sessionContext.connected(opened, observedMode)
            if (grant != null && !hasPro && selected.upsell == VoiceUpsell.Onboarding) preferences.incrementOnboarding()
            VoiceStart.Started(grant?.conversationId ?: opened.conversationId)
        } catch (e: CancellationException) {
            withContext(NonCancellable) { runCatching { opened?.end() } }
            if (epoch == generation) clear()
            throw e
        } catch (_: Exception) {
            withContext(NonCancellable) { runCatching { opened?.end() } }
            if (epoch == generation) clear()
            VoiceStart.Unavailable
        } finally {
            if (epoch == generation) starting = null
        }
    }

    private fun fail(result: VoiceStart): VoiceStart { clear(); return result }

    override suspend fun stop() {
        // Most account switches have never opened voice; don't dispatch to Android's main looper for those.
        if (state.value.status == VoiceStatus.Disconnected && starting == null && connection == null && closing == null) return
        withContext(dispatcher) {
            closing?.let { it.await(); return@withContext }
            val completed = CompletableDeferred<Unit>().also { closing = it }
            ++generation // Invalidate callbacks before cancellation or SDK teardown can deliver more callbacks.
            val pending = starting
            starting = null
            val opened = connection
            connection = null
            clear()
            try {
                withContext(NonCancellable) {
                    if (pending != currentCoroutineContext()[Job]) pending?.cancelAndJoin()
                    runCatching { opened?.end() }
                }
            } finally {
                closing = null
                completed.complete(Unit)
            }
        }
    }

    private fun clear() {
        connection = null
        silence?.cancel(); silence = null
        agentSpeaking = false
        context?.stop(); context = null
        mutableState.value = VoiceState()
    }

    override fun focus(sessionId: String) {
        scope.launch(dispatcher) {
            if (state.value.status == VoiceStatus.Connected && state.value.sessionId != sessionId) {
                mutableState.value = state.value.copy(sessionId = sessionId)
                context?.focus(sessionId)
            }
        }
    }

    override fun setMuted(muted: Boolean) {
        scope.launch(dispatcher) {
            val opened = connection ?: return@launch
            val epoch = generation
            try {
                opened.mute(muted)
                if (epoch == generation) mutableState.value = state.value.copy(muted = muted)
            } catch (e: CancellationException) { throw e } catch (_: Exception) { /* Leave the UI's actual mute state intact. */ }
        }
    }

    override suspend fun usage(): VoiceUsage? = try {
        credentials()?.let { service.usage(it) }
    } catch (e: CancellationException) { throw e } catch (_: Exception) { null }

    private fun events(epoch: Long) = object : VoiceEvents {
        private fun update(block: suspend () -> Unit) { scope.launch(dispatcher) { if (epoch == generation) block() } }
        override fun disconnected() = update { stop() }
        override fun error() = update { stop() }
        override fun agentSpeaking(speaking: Boolean) = update {
            agentSpeaking = speaking
            silence?.cancel(); silence = null
            mode(if (speaking) VoiceMode.AgentSpeaking else VoiceMode.Idle)
        }
        override fun vad(score: Float) = update {
            if (agentSpeaking) return@update
            if (score > 0.5f) {
                silence?.cancel(); silence = null
                mode(VoiceMode.UserSpeaking)
            } else if (silence == null) {
                silence = scope.launch(dispatcher) {
                    delay(300)
                    silence = null
                    if (epoch == generation && !agentSpeaking) mode(VoiceMode.Idle)
                }
            }
        }
    }

    private fun mode(value: VoiceMode) {
        if (state.value.status !in listOf(VoiceStatus.Connecting, VoiceStatus.Connected)) return
        mutableState.value = state.value.copy(mode = value)
        context?.mode(value)
    }
}