package com.slopus.happy.call

import android.content.Context
import android.os.SystemClock
import com.slopus.happy.BuildConfig
import com.slopus.happy.agent.AgentSessions
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

/**
 * The agent connection's voice call (iOS `CallController`): started from
 * home's voice button, shown as the bar across the window's top
 * (`ui/call/CallFrame`), bound to the one connection it started on. It ends
 * when the app leaves the foreground, and when another account opens. Apart
 * from the relay's voice ([stopRelayVoice]), whose call it stops first.
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
    /** The build's public hosted agent, if it has one ([CallAgent]). */
    private val grants: CallGrants = CallAgent.hostedAgentId?.let(::PublicAgentCallGrants) ?: UnconfiguredCallGrants,
    private val allowance: CallAllowance = CallAllowance(
        PreferencesCallUsageStore(appContext.getSharedPreferences(PreferencesCallUsageStore.PREFS_NAME, Context.MODE_PRIVATE)),
    ),
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutableState = MutableStateFlow<CallState>(CallState.Idle)
    /** What the bar shows. */
    val state: StateFlow<CallState> = mutableState.asStateFlow()
    private val mutableLevel = MutableStateFlow(0f)
    /** The waves' level. */
    val level: StateFlow<Float> = mutableLevel.asStateFlow()
    private val mutablePaywall = MutableStateFlow(false)
    /** The voice paywall is up (`ui/call/CallPaywall`): once the free time runs out, and on a tap on the bar saying so. */
    val paywall: StateFlow<Boolean> = mutablePaywall.asStateFlow()

    private var session: CallSession? = null
    private var context: CallContext? = null
    private var targets: ConnectionCallTargets? = null
    /** What follows this call (its state, home, its conversations); cancelled with it. */
    private var calling: CoroutineScope? = null
    private var connectionId: String? = null
    private var focus: String? = null
    /** Set by the screen while it is up. */
    var screen: CallScreen? = null

    init {
        // Leaving the foreground hangs up: no microphone behind the person's back.
        foreground.filter { !it }.onEach { hangUp() }.launchIn(scope)
        openAccount.drop(1).distinctUntilChanged().onEach { id -> if (state.value.isShown && id != connectionId) close() }.launchIn(scope)
        relayVoiceActive.distinctUntilChanged().filter { it }.onEach { if (state.value.isLive) close() }.launchIn(scope)
    }

    /** The voice button: a call on this connection, or the one already on. */
    fun start(connection: String, microphone: suspend () -> Boolean) {
        if (state.value.isLive && connectionId == connection) return
        close()
        val account = sessions.session(connection) ?: return
        connectionId = connection
        val targets = ConnectionCallTargets(account, appContext.resources::failureText) { screen }
        val context = CallContext(targets)
        val call = CallSession(scope, grants, permission = { stopRelayVoice(); microphone() }, now = SystemClock::elapsedRealtime, allowance = allowance) { grant, request, events ->
            ElevenLabsCallConnection.connect(appContext, scope, grant, request, events)
        }
        val calling = CoroutineScope(scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job]))
        this.calling = calling
        this.targets = targets
        this.context = context
        session = call
        call.onLevel = { level -> if (session === call) mutableLevel.value = level }
        val drain = DirectoryDrain(calling, context, call)
        call.onOverflow = {
            calling.launch {
                val update = context.resync()
                if (session === call) {
                    call.deliver(update)
                    drain.start()
                }
            }
        }
        // Each callback belongs to this call: once it ends, or another one starts, what it still says goes nowhere.
        targets.onChange = { state ->
            if (session === call) calling.launch {
                val update = context.targetChanged(state)
                if (session === call) call.deliver(update)
            }
        }
        // A change to home settles for a second from the first one, never longer, then goes as one update: as home is then.
        val settle = DirectorySettle(calling) {
            if (session !== call) return@DirectorySettle
            val update = context.flushDirectory()
            if (session !== call) return@DirectorySettle
            call.deliver(update)
            hold(context.followed(), targets)
            drain.start()
        }
        account.feed.onEach { feed ->
            if (session === call && context.directoryChanged(CallTarget.from(feed)) && session === call) settle.changed()
        }.launchIn(calling)
        call.state.onEach { state ->
            if (session !== call) return@onEach
            show(state)
            // Connected: whatever the directory still owes goes now.
            if (state is CallState.Active) drain.start()
        }.launchIn(calling)
        focus = targets.focusedNow
        call.start(language = null, context = {
            context.initial().also { hold(context.followed(), targets) }
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

    /** The bar says the free time is used: the paywall, which then stays until it is put away. */
    fun showPaywall() {
        if (state.value == CallState.Ended(CallProblem.LimitReached)) mutablePaywall.value = true
    }

    fun dismissPaywall() { mutablePaywall.value = false }

    /** When some free voice time is back on the wall clock; null if never, or if some is free now. */
    fun freeAgain(): Long? {
        val now = System.currentTimeMillis()
        return allowance.freeAgain(now)?.takeIf { it > now }
    }

    private fun show(state: CallState) {
        val before = mutableState.value
        mutableState.value = state
        // The free time is used, on a tap or mid-call: the paywall, once.
        if (state == CallState.Ended(CallProblem.LimitReached) && before != state) mutablePaywall.value = true
    }

    /** End: the call, or the bar of one that ended. */
    fun close() {
        val old = session
        session = null
        old?.stop()
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
    private fun hangUp() {
        if (state.value.isShown) close()
    }

    /** Screenshots only, in debug builds: the bar in [state], with no microphone, provider or grant. Never a call. */
    fun showFixture(state: CallState, level: Float) {
        if (!BuildConfig.DEBUG) return
        if (session != null) close()
        show(state)
        mutableLevel.value = level
    }

    companion object {
        /** Telegram's call clock: m:ss, then h:mm:ss. */
        fun clock(seconds: Long): String =
            if (seconds < 3600) "%d:%02d".format(seconds / 60, seconds % 60)
            else "%d:%02d:%02d".format(seconds / 3600, (seconds % 3600) / 60, seconds % 60)
    }
}
