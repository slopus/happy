package com.slopus.happy.push

import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.connection.AgentConnection
import com.slopus.happy.connection.HappyCloud
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** The local binding, not caller-supplied authority for the API. [server] is a sign-in's origin, and a pairing's installation id. */
@Serializable
data class CloudPushAccount(val connectionId: String, val server: String, val userId: String)

/** Whom a standalone Happy Agent's pushes name: the installation's one person (happy-agent's push module). */
const val STANDALONE_PUSH_MEMBER = "standalone"

/**
 * Whom a server's pushes name on this connection, the same rule as iOS's.
 * A sign-in is the member who signed in: nobody while that isn't known, and
 * never the installation's one person, whatever its server calls its user.
 * A pairing is whoever its daemon says it acts for: nobody until the daemon
 * has said ([AgentConnection.memberRead]; registered as `standalone` before
 * a team's daemon names the member, that row would be nobody's to remove),
 * then that member, or the installation's one person when it names none.
 */
val AgentConnection.pushMember: String? get() = when {
    server != null -> userId?.takeIf { it != STANDALONE_PUSH_MEMBER }
    !memberRead -> null
    else -> userId ?: STANDALONE_PUSH_MEMBER
}

/** No push is registered for, shown from or opened on a connection that has to be paired or signed in again. */
internal val AgentConnection.takesPushes: Boolean get() = !revoked && !signInRequired && !profileRequired

/**
 * The binding [connection] registers for push under; null for one that
 * doesn't register: Happy Cloud always does, any other server only while
 * its health says it keeps phones (`capabilities.pushRegistrations`).
 */
internal fun cloudPushAccount(connection: AgentConnection): CloudPushAccount? {
    if (!connection.takesPushes) return null
    if (!HappyCloud.isServer(connection.server) && !connection.pushRegistrations) return null
    val member = connection.pushMember ?: return null
    // A pairing has no origin: it is bound to the installation it paired with.
    return CloudPushAccount(connection.id, connection.server ?: connection.instanceId ?: return null, member)
}

@Serializable
internal data class CloudPushBinding(
    val account: CloudPushAccount,
    val id: String,
    val registration: CloudPushRegistration? = null,
)

/**
 * A forgotten pairing's own way to its daemon (what the pairing kept to
 * reach it), held beside the one removal it is for and only until the
 * daemon answers or the registration would have expired anyway.
 */
@Serializable
data class CloudPushFarewellRoute(val address: String, val port: Int, val deviceToken: String, val publicUrl: String? = null, val tailcatAvailable: Boolean? = null) {
    override fun toString() = "CloudPushFarewellRoute(port=$port)"
}

/** A sign-in's removal keeps no token or refresh credential; a pairing's keeps its [route]. */
@Serializable
internal data class CloudPushRemoval(val server: String, val userId: String, val registration: CloudPushRegistration, val route: CloudPushFarewellRoute? = null)

/** Whether a daemon's answer to a farewell settles it: taken, or refused in a way asking again won't change. */
internal fun farewellAnswered(status: Int): Boolean = status in 200..299 || (status in 400..499 && status != 408 && status != 429)

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
 * Register and remove are serialized per member/server, and a registration
 * sent is never abandoned: its answer is kept even when the work it belongs
 * to is cancelled, because the daemon has by then given the row a version
 * that only the answer names, and a removal naming an older one removes
 * nothing. Pending deletion uses the version actually removed, never a
 * newer registration's version.
 * The owner supplies clients only for the exact account. The ledger holds
 * identifiers, and for a forgotten pairing's removal that pairing's own
 * route ([CloudPushFarewellRoute]) until it is delivered; never a sign-in's
 * credential.
 */
class CloudPushRegistrations(
    private val ledger: CloudPushLedger,
    private val signedIn: (CloudPushAccount) -> Boolean,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    private data class Member(val server: String, val userId: String)
    private val locks = ConcurrentHashMap<Member, Mutex>()
    private fun lock(account: CloudPushAccount) = locks.getOrPut(Member(account.server, account.userId)) { Mutex() }
    private class Leaving(val route: CloudPushFarewellRoute?)
    /** Connections being forgotten in this process, with what their removal is sent over. */
    private val leaving = ConcurrentHashMap<String, Leaving>()

    suspend fun register(account: CloudPushAccount, api: CloudPushApi, token: HappyPushToken, appId: String, locale: String?): Boolean = lock(account).withLock {
        if (!signedIn(account) || leaving.containsKey(account.connectionId)) return@withLock false
        val previous = ledger.snapshot().bindings.firstOrNull { it.account.connectionId == account.connectionId }
        check(previous == null || previous.account == account)
        val binding = previous ?: CloudPushBinding(account, newId()).also { created ->
            // Keep the separate registration UUID before the request, including across a process death.
            ledger.update { it.copy(bindings = it.bindings + created) }
        }
        // Once sent, finished: the request and the keeping of its answer are not cancelled with the caller.
        withContext(NonCancellable) {
            val registration = try {
                withTimeoutOrNull(REGISTER_DEADLINE) { api.register(binding.id, token, appId, locale) } ?: return@withContext false
            } catch (_: Exception) {
                return@withContext false
            }
            ledger.update { state ->
                if (signedIn(account)) state.copy(bindings = state.bindings.map { if (it.account == account) it.copy(registration = registration) else it })
                else state.copy(
                    bindings = state.bindings.filterNot { it.account == account },
                    pending = state.pending + CloudPushRemoval(account.server, account.userId, registration, leaving[account.connectionId]?.route),
                )
            }
            signedIn(account)
        }
    }

    /** Queue first, then try while this binding's authentication is still available. Null means offline/auth gone. */
    suspend fun remove(account: CloudPushAccount, api: CloudPushApi?) = lock(account).withLock {
        ledger.update { state ->
            val old = state.bindings.firstOrNull { it.account == account }
            val removal = old?.registration?.let { CloudPushRemoval(account.server, account.userId, it, leaving[account.connectionId]?.route) }
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

    /**
     * [connectionId] is being forgotten: nothing registers on it again in
     * this process, and its removal goes with [route] (a pairing's; null
     * for a sign-in), also when it is only queued after the connection went.
     */
    fun leaving(connectionId: String, route: CloudPushFarewellRoute?) { leaving[connectionId] = Leaving(route) }

    /**
     * Sends the farewells that outlived their connections, each over its own
     * route ([ask] says whether the daemon answered), and drops every removal
     * whose registration has expired by [now]: the daemon has dropped that
     * row by itself. True while a farewell is still owed.
     */
    suspend fun retire(now: Long, ask: suspend (CloudPushFarewellRoute, CloudPushRegistration) -> Boolean): Boolean {
        if (ledger.snapshot().pending.any { it.registration.expiresAt <= now }) {
            ledger.update { state -> state.copy(pending = state.pending.filter { it.registration.expiresAt > now }) }
        }
        var owed = false
        for (removal in ledger.snapshot().pending) {
            val route = removal.route ?: continue
            locks.getOrPut(Member(removal.server, removal.userId)) { Mutex() }.withLock {
                // Delivered meanwhile by the same member's connection ([cleanup]).
                if (removal !in ledger.snapshot().pending) return@withLock
                if (ask(route, removal.registration)) ledger.update { it.copy(pending = it.pending - removal) } else owed = true
            }
        }
        return owed
    }

    /** Bindings whose connections disappeared while the process was not running still need retirement. */
    fun accounts(): List<CloudPushAccount> = ledger.snapshot().bindings.map { it.account }

    private companion object {
        /** Beyond any transport's own deadline: a registration that never answers must not hold an unpair forever. */
        const val REGISTER_DEADLINE = 60_000L
    }
}