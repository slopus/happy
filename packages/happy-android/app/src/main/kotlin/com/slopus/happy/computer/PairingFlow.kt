package com.slopus.happy.computer

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Where one pairing stands, as the pairing screen draws it. */
sealed interface PairingState {
    /** The code's name for the computer; unverified until paired. */
    val computerName: String?

    data class Connecting(override val computerName: String) : PairingState

    /** Both screens show these four; the person compares them. */
    data class Compare(override val computerName: String, val emoji: List<String>) : PairingState

    /** The phone said they match; waiting for the computer to say so too. */
    data class Confirming(override val computerName: String, val emoji: List<String>) : PairingState

    data class Paired(val account: ComputerAccount) : PairingState {
        override val computerName get() = account.name
    }

    data class Failed(override val computerName: String?, val message: String) : PairingState
}

/**
 * One pairing from a scanned or pasted `happy://direct?` code to a kept
 * computer: connect and exchange keys, show the emoji, and on the person's
 * word wait for the computer's confirmation before keeping anything.
 * Closing at any point before that rejects the pairing.
 */
class PairingFlow(
    private val scope: CoroutineScope,
    private val accounts: ComputerAccounts,
    private val deviceName: String,
    private val makeTransport: (PairingLink) -> Transport = { TailcatTransport(it.address, it.port) },
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val mutableState = MutableStateFlow<PairingState?>(null)
    val state: StateFlow<PairingState?> = mutableState.asStateFlow()

    private var link: PairingLink? = null
    private var transport: Transport? = null
    private var service: PairingService? = null
    private var job: Job? = null

    fun start(code: String) {
        if (mutableState.value != null) return
        val parsed = try {
            PairingLink.parse(code, now())
        } catch (e: ComputerException) {
            mutableState.value = PairingState.Failed(null, e.message ?: "")
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
        mutableState.value = PairingState.Confirming(compare.computerName, compare.emoji)
        run(compare.computerName) {
            val credentials = service.confirm()
            transport?.close()
            mutableState.value = PairingState.Paired(accounts.add(credentials, link.name))
        }
    }

    /** The emoji don't match: the computer is told, and nothing is kept. */
    fun reject() {
        val name = mutableState.value?.computerName
        stop()
        mutableState.value = PairingState.Failed(name, ComputerException.Reason.Rejected.message)
    }

    /** The screen went away. An unfinished pairing is rejected. */
    fun close() {
        if (mutableState.value !is PairingState.Paired) stop()
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
            } catch (e: ComputerException) {
                fail(name, e.message ?: "")
            } catch (e: Exception) {
                fail(name, ComputerException.Reason.Unavailable.message)
            }
        }
    }

    private suspend fun fail(name: String, message: String) {
        mutableState.value = PairingState.Failed(name, message)
        transport?.close()
    }
}
