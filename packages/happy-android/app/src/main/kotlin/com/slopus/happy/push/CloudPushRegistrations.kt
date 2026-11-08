package com.slopus.happy.push

import com.slopus.happy.auth.ExpoSecureStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** The local binding, not caller-supplied authority for the Cloud API. */
@Serializable
data class CloudPushAccount(val connectionId: String, val server: String, val userId: String)

@Serializable
internal data class CloudPushBinding(
    val account: CloudPushAccount,
    val id: String,
    val registration: CloudPushRegistration? = null,
)

/** No token or refresh credential is kept for a cleanup that outlives sign-out. */
@Serializable
internal data class CloudPushRemoval(val server: String, val userId: String, val registration: CloudPushRegistration)

@Serializable
internal data class CloudPushLedgerState(
    val bindings: List<CloudPushBinding> = emptyList(),
    val pending: List<CloudPushRemoval> = emptyList(),
)

/** One encrypted item, separate from the legacy Expo registration and connection credential stores. */
class CloudPushLedger internal constructor(private val read: () -> String?, private val write: (String) -> Unit) {
    constructor(store: ExpoSecureStore) : this({ store.getItem(KEY) }, { store.setItem(KEY, it) })

    @Synchronized
    internal fun snapshot(): CloudPushLedgerState = read()?.let { Json.decodeFromString(CloudPushLedgerState.serializer(), it) } ?: CloudPushLedgerState()

    @Synchronized
    internal fun update(change: (CloudPushLedgerState) -> CloudPushLedgerState) {
        val next = change(snapshot())
        write(Json.encodeToString(CloudPushLedgerState.serializer(), next))
    }

    companion object { private const val KEY = "cloud-push-ledger" }
}

/**
 * Register and remove are serialized per member/server. The ledger contains identifiers only.
 * Pending deletion uses the version actually removed, never a newer registration's version.
 * The owner supplies clients only for the exact account; no credentials are retained by this class.
 */
class CloudPushRegistrations(
    private val ledger: CloudPushLedger,
    private val signedIn: (CloudPushAccount) -> Boolean,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    private data class Member(val server: String, val userId: String)
    private val locks = ConcurrentHashMap<Member, Mutex>()
    private fun lock(account: CloudPushAccount) = locks.getOrPut(Member(account.server, account.userId)) { Mutex() }

    suspend fun register(account: CloudPushAccount, api: CloudPushApi, token: HappyPushToken, appId: String, locale: String?): Boolean = lock(account).withLock {
        if (!signedIn(account)) return@withLock false
        val previous = ledger.snapshot().bindings.firstOrNull { it.account.connectionId == account.connectionId }
        check(previous == null || previous.account == account)
        val binding = previous ?: CloudPushBinding(account, newId()).also { created ->
            // Keep the separate registration UUID before the request, including across a process death.
            ledger.update { it.copy(bindings = it.bindings + created) }
        }
        val registration = try {
            api.register(binding.id, token, appId, locale)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return@withLock false
        }
        ledger.update { state ->
            if (signedIn(account)) state.copy(bindings = state.bindings.map { if (it.account == account) it.copy(registration = registration) else it })
            else state.copy(
                bindings = state.bindings.filterNot { it.account == account },
                pending = state.pending + CloudPushRemoval(account.server, account.userId, registration),
            )
        }
        signedIn(account)
    }

    /** Queue first, then try while this binding's authentication is still available. Null means offline/auth gone. */
    suspend fun remove(account: CloudPushAccount, api: CloudPushApi?) = lock(account).withLock {
        ledger.update { state ->
            val old = state.bindings.firstOrNull { it.account == account }
            val removal = old?.registration?.let { CloudPushRemoval(account.server, account.userId, it) }
            state.copy(
                bindings = state.bindings.filterNot { it.account == account },
                pending = if (removal != null && removal !in state.pending) state.pending + removal else state.pending,
            )
        }
        if (api != null) clean(account, api)
    }

    /** Called on launch/network return only with current authentication for the same member and server. */
    suspend fun cleanup(account: CloudPushAccount, api: CloudPushApi) = lock(account).withLock {
        if (signedIn(account)) clean(account, api)
    }

    private suspend fun clean(account: CloudPushAccount, api: CloudPushApi) {
        val pending = ledger.snapshot().pending.filter { it.server == account.server && it.userId == account.userId }
        for (removal in pending) {
            try {
                api.unregister(removal.registration)
                ledger.update { it.copy(pending = it.pending - removal) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Keep identifiers/version only. A later same-member sign-in may authorize cleanup.
                return
            }
        }
    }

    /** Bindings whose connections disappeared while the process was not running still need retirement. */
    fun accounts(): List<CloudPushAccount> = ledger.snapshot().bindings.map { it.account }
}