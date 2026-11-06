package com.slopus.happy.connection

import com.slopus.happy.analytics.Analytics
import com.slopus.happy.analytics.AnalyticsEvent
import com.slopus.happy.analytics.AnalyticsReasons
import com.slopus.happy.analytics.PairingError
import com.slopus.happy.analytics.PairingMethod
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** How a pairing code reached the phone: scanned, pasted, or a link that opened the app. */
enum class PairingStart { Scan, PasteLink, OpenedLink }

/** Where one pairing stands, as the pairing screen draws it. */
sealed interface PairingState {
    /** The code's name for the agent; unverified until paired. */
    val agentName: String?

    data class Connecting(override val agentName: String) : PairingState

    /** Both screens show these four; the person compares them. */
    data class Compare(override val agentName: String, val emoji: List<String>) : PairingState

    /** The phone said they match; waiting for the agent to say so too. */
    data class Confirming(override val agentName: String, val emoji: List<String>) : PairingState

    data class Paired(val account: AgentConnection) : PairingState {
        override val agentName get() = account.name
    }

    /** [reason], when there is one, is [message] in the person's language. */
    data class Failed(override val agentName: String?, val message: String, val reason: AgentConnectionException.Reason? = null) : PairingState
}

/**
 * One pairing from a scanned or pasted `happy://direct?` code to a kept
 * agent: connect and exchange keys, show the emoji, and on the person's
 * word wait for the agent's confirmation before keeping anything.
 * Closing at any point before that rejects the pairing. Closing records
 * how it ended: `mobile_pairing_completed`, `_failed` and why, or `_cancelled`.
 */
class PairingFlow(
    private val scope: CoroutineScope,
    private val accounts: AgentConnections,
    private val deviceName: String,
    /** How the code reached the phone. */
    private val start: PairingStart = PairingStart.Scan,
    private val makeTransport: (PairingLink) -> Transport = { agentTransport(it.address, it.port, it.publicUrl) },
    private val now: () -> Long = System::currentTimeMillis,
    private val record: (AnalyticsEvent) -> Unit = Analytics::record,
) {
    private val mutableState = MutableStateFlow<PairingState?>(null)
    val state: StateFlow<PairingState?> = mutableState.asStateFlow()

    private var link: PairingLink? = null
    private var transport: Transport? = null
    private var service: PairingService? = null
    private var job: Job? = null
    /** The person said the emoji don't match. */
    private var mismatch = false
    private var reported = false

    fun start(code: String) {
        if (mutableState.value != null) return
        val parsed = try {
            PairingLink.parse(code, now())
        } catch (e: AgentConnectionException) {
            mutableState.value = PairingState.Failed(null, e.message ?: "", e.reason)
            return
        }
        link = parsed
        val transport = makeTransport(parsed).also { transport = it }
        val service = PairingService(parsed, transport, now = now).also { service = it }
        mutableState.value = PairingState.Connecting(parsed.name)
        run(parsed.name) {
            val emoji = service.start(deviceName)
            mutableState.value = PairingState.Compare(parsed.name, emoji)
        }
    }

    /** The person says the emoji match. */
    fun confirm() {
        val compare = mutableState.value as? PairingState.Compare ?: return
        val service = service ?: return
        val link = link ?: return
        mutableState.value = PairingState.Confirming(compare.agentName, compare.emoji)
        run(compare.agentName) {
            val credentials = service.confirm()
            transport?.close()
            mutableState.value = PairingState.Paired(accounts.add(credentials, link.name))
        }
    }

    /** The emoji don't match: the agent is told, and nothing is kept. */
    fun reject() {
        val name = mutableState.value?.agentName
        mismatch = true
        stop()
        mutableState.value = PairingState.Failed(name, AgentConnectionException.Reason.Rejected.message, AgentConnectionException.Reason.Rejected)
    }

    /** The screen went away. An unfinished pairing is rejected. */
    fun close() {
        if (mutableState.value !is PairingState.Paired) stop()
        report()
    }

    private fun report() {
        val state = mutableState.value ?: return
        if (reported) return
        reported = true
        val method = PairingMethod.Direct
        record(
            when {
                state is PairingState.Paired -> AnalyticsEvent.MobilePairingCompleted(method, AnalyticsReasons.start(start))
                mismatch -> AnalyticsEvent.MobilePairingFailed(method, AnalyticsReasons.start(start), PairingError.EmojiMismatch)
                state is PairingState.Failed -> AnalyticsEvent.MobilePairingFailed(
                    method,
                    AnalyticsReasons.start(start),
                    state.reason?.let(AnalyticsReasons::pairing) ?: PairingError.Unknown,
                )
                else -> AnalyticsEvent.MobilePairingCancelled(method, AnalyticsReasons.start(start))
            },
        )
    }

    private fun stop() {
        job?.cancel()
        val service = service
        val transport = transport
        this.service = null
        this.transport = null
        scope.launch {
            service?.cancel()
            transport?.close()
        }
    }

    private fun run(name: String, block: suspend () -> Unit) {
        job = scope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: AgentConnectionException) {
                fail(name, e.reason)
            } catch (e: Exception) {
                fail(name, AgentConnectionException.Reason.Unavailable)
            }
        }
    }

    private suspend fun fail(name: String, reason: AgentConnectionException.Reason) {
        mutableState.value = PairingState.Failed(name, reason.message, reason)
        transport?.close()
    }
}
