package com.slopus.happy.call

import com.slopus.happy.analytics.Analytics
import com.slopus.happy.analytics.AnalyticsEvent
import com.slopus.happy.analytics.AnalyticsSpan
import com.slopus.happy.analytics.DurationBucket
import com.slopus.happy.analytics.VoiceError
import android.content.Context
import android.os.SystemClock
import com.slopus.happy.BuildConfig
import com.slopus.happy.agent.AgentSessions
import com.slopus.happy.payments.OfferResult
import com.slopus.happy.payments.OfferSheet
import com.slopus.happy.payments.Offers
import com.slopus.happy.payments.Subscription
import com.slopus.happy.ui.conversation.Typesetter
import com.slopus.happy.ui.conversation.failureText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The agent connection's voice call (iOS `CallController`): started from
 * home's voice button, shown as the bar across the window's top
 * (`ui/call/CallFrame`), bound to the one connection it started on. It ends
 * when the app leaves the foreground, and when another account opens. What
 * each call said is kept for the connection's next one ([CallHistory]), and a
 * call that ends unasked plays [CallDropSound]. Apart from the relay's voice
 * ([stopRelayVoice]), whose call it stops first.
 */
class CallController(
    private val appContext: Context,
    private val sessions: AgentSessions,
    foreground: StateFlow<Boolean>,
    /** The open account's id: a call bound to another connection ends. */
    openAccount: Flow<String?>,
    /** The relay's voice is on: one call at a time, the newer wins. */
    relayVoiceActive: Flow<Boolean>,
    private val stopRelayVoice: suspend () -> Unit,
    /** The subscription: the month of hours it gives. */
    private val subscription: Subscription,
    /** The app's offer sheets: voice's welcome and used-up sheet among them. */
    private val offers: Offers,
    /** The build's public hosted agent, if it has one ([CallAgent]). */
    private val grants: CallGrants = CallAgent.hostedAgentId?.let(::PublicAgentCallGrants) ?: UnconfiguredCallGrants,
    private val preferences: android.content.SharedPreferences = appContext.getSharedPreferences(PreferencesCallUsageStore.PREFS_NAME, Context.MODE_PRIVATE),
    private val allowance: CallAllowance = CallAllowance(PreferencesCallUsageStore(preferences), period = subscription::period),
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutableState = MutableStateFlow<CallState>(CallState.Idle)
    /** What the bar shows. */
    val state: StateFlow<CallState> = mutableState.asStateFlow()
    private val mutableLevel = MutableStateFlow(0f)
    /** The waves' level. */
    val level: StateFlow<Float> = mutableLevel.asStateFlow()
    private var session: CallSession? = null
    private var context: CallContext? = null
    private var targets: ConnectionCallTargets? = null
    /** What follows this call (its state, home, its conversations); cancelled with it. */
    private var calling: CoroutineScope? = null
    private var connectionId: String? = null
    private var focus: String? = null
    private var report: CallReport? = null
    private val dropSound = CallDropSound(appContext)
    /** Set by the screen while it is up. */
    var screen: CallScreen? = null

    init {
        // Leaving the foreground hangs up: no microphone behind the person's back.
        foreground.filter { !it }.onEach { hangUp(CallEnding.Background) }.launchIn(scope)
        openAccount.drop(1).distinctUntilChanged().onEach { id -> if (state.value.isShown && id != connectionId) close() }.launchIn(scope)
        relayVoiceActive.distinctUntilChanged().filter { it }.onEach { if (state.value.isLive) close() }.launchIn(scope)
        // Subscribed while the used-up sheet is up: it goes once there is time again.
        subscription.pro.filter { it }.onEach {
            if (offers.sheet.value is OfferSheet.Used && allowance.remaining(System.currentTimeMillis()) > 0) offers.close(OfferResult.Pro)
        }.launchIn(scope)
    }

    /**
     * The voice button: a call on this connection, or the one already on.
     * While a subscription is on sale, a device's first tap is voice's
     * welcome instead, once: its "Start Voice Session" calls, and from then
     * on the button does. With nothing on sale there is no welcome.
     */
    fun start(connection: String, microphone: suspend () -> Boolean) {
        if (state.value.isLive && connectionId == connection) return
        if (offers.sheet.value != null) return
        if (offers.welcomes()) {
            // Its "Start Voice Session" calls; closing it starts nothing.
            scope.launch { if (offers.ask(OfferSheet.Welcome(offers.offer)) == OfferResult.Start) start(connection, microphone) }
            return
        }
        close()
        val account = sessions.session(connection) ?: return
        connectionId = connection
        val targets = ConnectionCallTargets(account, appContext.resources::failureText, Typesetter.of(appContext)) { screen }
        val context = CallContext(targets)
        val history = CallHistory(sessions.keptFile(connection, HISTORY_FILE)?.let(::FileCallHistoryStore))
        val call = CallSession(
            scope, grants, permission = { stopRelayVoice(); microphone() }, now = SystemClock::elapsedRealtime, allowance = allowance, history = history,
        ) { grant, request, events ->
            ElevenLabsCallConnection.connect(appContext, scope, grant, request, events)
        }
        // Not the person's own end, nor the agent's goodbye: those were heard coming.
        call.onEnded = { ending -> if (ending.isUnexpected) dropSound.play() }
        val calling = CoroutineScope(scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job]))
        this.calling = calling
        this.targets = targets
        this.context = context
        session = call
        // Begun now: a call started while analytics is off, or on through an opt-out, is never told.
        val report = CallReport(Analytics.span()).also { this.report = it }
        call.onLevel = { level -> if (session === call) mutableLevel.value = level }
        // The agent hung up: as if End were tapped, with no bar left.
        call.onHangUp = { if (session === call) close() }
        call.onOverflow = {
            calling.launch {
                val update = context.resync()
                if (session === call) call.deliver(update)
            }
        }
        // Each callback belongs to this call: once it ends, or another one starts, what it still says goes nowhere.
        targets.onChange = { state ->
            if (session === call) calling.launch {
                val update = context.targetChanged(state)
                if (session === call) call.deliver(update)
            }
        }
        call.state.onEach { state ->
            if (session !== call) return@onEach
            report.observe(state)
            show(state)
        }.launchIn(calling)
        focus = targets.focusedNow
        calling.launch { context.onRestart { withContext(Dispatchers.Main) { call.requestRestart() } } }
        call.start(language = null, context = {
            context.initial(history.slots).also { hold(context.followed(), targets) }
        }, tool = { context.handle(it) })
    }

    /** Exactly the conversations the call hears from stay read: one that dropped out of the last visited is let go. */
    private suspend fun hold(followed: List<String>, targets: ConnectionCallTargets) {
        for (id in targets.following) if (id !in followed) targets.follow(id, false)
        for (id in followed) if (id !in targets.following) targets.follow(id, true)
    }

    /** The screen on top changed: the conversation in front is the call's focus, and the latest it has visited. */
    fun topDidChange() {
        val targets = targets ?: return
        val context = context ?: return
        val call = session ?: return
        if (!state.value.isLive) return
        val now = targets.focusedNow
        if (now == focus) return
        focus = now
        val calling = calling ?: return
        calling.launch {
            val update = context.focusChanged(now)
            if (session !== call) return@launch
            call.deliver(update)
            hold(context.followed(), targets)
        }
    }

    fun toggleMute() { session?.toggleMute() }

    /** The bar says the free time is used: the used-up sheet, which then stays until it is put away. */
    fun showPaywall() {
        if (state.value == CallState.Ended(CallProblem.LimitReached)) showUsed()
    }

    private fun showUsed() {
        if (offers.sheet.value == null) scope.launch { offers.ask(OfferSheet.Used(freeAgain(), offers.offer)) }
    }

    /** When some free voice time is back on the wall clock; null if never, or if some is free now. */
    fun freeAgain(): Long? {
        val now = System.currentTimeMillis()
        return allowance.freeAgain(now)?.takeIf { it > now }
    }

    private fun show(state: CallState) {
        val before = mutableState.value
        mutableState.value = state
        // The free time is used, on a tap or mid-call: the used-up sheet, once.
        if (state == CallState.Ended(CallProblem.LimitReached) && before != state) showUsed()
    }

    /** End: the call, or the bar of one that ended; [ending] says why, for the call's history. */
    fun close(ending: CallEnding = CallEnding.HungUp) {
        report?.closed()
        report = null
        val old = session
        session = null
        old?.stop(ending)
        val context = context
        this.context = null
        context?.let { scope.launch { it.close() } }
        targets?.close()
        targets = null
        calling?.cancel()
        calling = null
        connectionId = null
        focus = null
        mutableLevel.value = 0f
        mutableState.value = CallState.Idle
    }

    /** The call stops for the system; one that was live leaves no bar. */
    private fun hangUp(ending: CallEnding) {
        if (state.value.isShown) close(ending)
    }

    /**
     * Test runs only, in debug builds: the welcome due again ([intro]
     * `due`) or never (`seen`), the free time spent ([used]: a
     * 20-minute call that ended now), the subscription drawn as if on sale
     * at [offerPrice]. Nothing here charges or grants anything.
     */
    fun applyTestEnvironment(intro: String?, used: Boolean, offerPrice: String?) {
        if (!BuildConfig.DEBUG) return
        when (intro) {
            "due" -> offers.intro.reset()
            "seen" -> offers.intro.seen()
        }
        if (used) {
            val now = System.currentTimeMillis()
            allowance.record("test-used", now - CallAllowance.FREE_MILLIS, now)
        }
        offers.preview(offerPrice)
    }

    /** Test runs' log line: what is up after a step. */
    val testSummary: String get() = "sheet ${offers.sheet.value}, call ${state.value}, intro due ${offers.intro.due}"

    /** Screenshots only, in debug builds: the bar in [state], with no microphone, provider or grant. Never a call. */
    fun showFixture(state: CallState, level: Float) {
        if (!BuildConfig.DEBUG) return
        if (session != null) close()
        show(state)
        mutableLevel.value = level
    }

    companion object {
        /** Each connection's call history, beside its catalog. */
        const val HISTORY_FILE = "call-history.json"

        /** Telegram's call clock: m:ss, then h:mm:ss. */
        fun clock(seconds: Long): String =
            if (seconds < 3600) "%d:%02d".format(seconds / 60, seconds % 60)
            else "%d:%02d:%02d".format(seconds / 3600, (seconds % 3600) / 60, seconds % 60)
    }
}

/**
 * How one call ended, once: `voice_session_stopped` when it was closed
 * after it connected, `voice_session_error` when it failed to start or
 * dropped, with how long it was live (none if it never was). A call never
 * set up on this build, or closed before it connected, reports nothing;
 * nor does one analytics was off for at any point ([span]).
 */
private class CallReport(private val span: AnalyticsSpan) {
    private var since: Long? = null
    private var done = false

    fun observe(state: CallState) {
        when (state) {
            is CallState.Active -> if (since == null) since = state.since
            is CallState.Ended -> end(state.problem)
            else -> Unit
        }
    }

    fun closed() {
        if (since != null) end(null)
    }

    private fun end(problem: CallProblem?) {
        if (done || problem == CallProblem.NotSetUp) return
        done = true
        val live = since?.let { DurationBucket.of(SystemClock.elapsedRealtime() - it) }
        val error = when (problem) {
            // Ended as asked: only a call that connected counts.
            null -> return live?.let { span.record(AnalyticsEvent.VoiceSessionStopped(it)) } ?: Unit
            CallProblem.MicrophonePermission -> VoiceError.MicDenied
            CallProblem.SubscriptionRequired, CallProblem.LimitReached -> VoiceError.QuotaExhausted
            CallProblem.Connection -> if (since != null) VoiceError.Dropped else VoiceError.ConnectFailed
            CallProblem.Authentication -> VoiceError.ConnectFailed
            CallProblem.NotSetUp -> VoiceError.Unknown
        }
        span.record(AnalyticsEvent.VoiceSessionError(error, live))
    }
}
