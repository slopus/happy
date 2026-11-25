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
    /**
     * A registration was sent and what the daemon made of it is not known
     * (no answer, or one that settles nothing): the row may carry a version
     * this phone never heard. Written before the request, so a process
     * that dies waiting leaves it.
     */
    val unanswered: Boolean = false,
)

/** What a registration is sent with; kept only beside a farewell that has to register once more first. */
@Serializable
data class CloudPushRenewal(val token: String, val appId: String, val locale: String? = null) {
    override fun toString() = "CloudPushRenewal(appId=$appId)"
}

/** A farewell's own way to its daemon, made for it and closed after. */
class CloudPushFarewellLink(val api: CloudPushApi, val close: suspend () -> Unit = {})

/**
 * A forgotten pairing's own way to its daemon (what the pairing kept to
 * reach it), held beside the one removal it is for and only until the
 * daemon answers or the registration would have expired anyway.
 */
@Serializable
data class CloudPushFarewellRoute(val address: String, val port: Int, val deviceToken: String, val publicUrl: String? = null, val tailcatAvailable: Boolean? = null) {
    override fun toString() = "CloudPushFarewellRoute(port=$port)"
}

/**
 * A sign-in's removal keeps no token or refresh credential; a pairing's
 * keeps its [route]. [putFirst]: the last registration went unanswered, so
 * the version here may be stale (or was never heard, [NO_VERSION]) and a
 * removal naming it would remove nothing. The row is then registered once
 * more, which is the only way to hear its version, and removed with that;
 * a pairing's record keeps [renewal] to do it with, until it has.
 */
@Serializable
internal data class CloudPushRemoval(
    val server: String,
    val userId: String,
    val registration: CloudPushRegistration,
    val route: CloudPushFarewellRoute? = null,
    val putFirst: Boolean = false,
    val renewal: CloudPushRenewal? = null,
)

/** A registration whose version was never heard. Never sent. */
internal const val NO_VERSION = ""

/** Whether a daemon's answer settles a request: taken, or refused in a way asking again won't change. */
internal fun pushAnswerSettles(status: Int): Boolean = status in 200..299 || (status in 400..499 && status != 408 && status != 429)

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
    private val clock: () -> Long = System::currentTimeMillis,
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
        // Keep the separate registration UUID before the request, including across a process death,
        // and that a request went out: until its answer is kept, the row's version is not known.
        val binding = (previous ?: CloudPushBinding(account, newId())).copy(unanswered = MARKS_UNANSWERED)
        if (binding != previous) ledger.update { it.copy(bindings = it.bindings.filterNot { kept -> kept.account == account } + binding) }
        // Once sent, finished: the request and the keeping of its answer are not cancelled with the caller.
        withContext(NonCancellable) {
            val registration = try {
                withTimeoutOrNull(REGISTER_DEADLINE) { api.register(binding.id, token, appId, locale) } ?: return@withContext false
            } catch (e: CloudPushException) {
                // Refused: the daemon answered and changed nothing, so what was known still stands.
                if (e.status?.let(::pushAnswerSettles) == true) {
                    ledger.update { state -> state.copy(bindings = state.bindings.map { if (it.account == account) it.copy(unanswered = false) else it }) }
                }
                return@withContext false
            } catch (_: Exception) {
                return@withContext false
            }
            ledger.update { state ->
                if (signedIn(account)) state.copy(bindings = state.bindings.map { if (it.account == account) it.copy(registration = registration, unanswered = false) else it })
                else state.copy(
                    bindings = state.bindings.filterNot { it.account == account },
                    pending = state.pending + CloudPushRemoval(account.server, account.userId, registration, leaving[account.connectionId]?.route),
                )
            }
            signedIn(account)
        }
    }

    /**
     * Queue first, then try while this binding's authentication is still
     * available. Null means offline/auth gone. [renewal] is what a
     * registration would be sent with now, asked for only when the last one
     * went unanswered ([CloudPushRemoval.putFirst]).
     */
    suspend fun remove(account: CloudPushAccount, api: CloudPushApi?, renewal: suspend () -> CloudPushRenewal? = { null }) = lock(account).withLock {
        val route = leaving[account.connectionId]?.route
        // Taken once, here: a pairing's record keeps it, for the farewell that outlives the pairing.
        val unsure = ledger.snapshot().bindings.firstOrNull { it.account == account }?.unanswered == true
        val with = if (unsure && route != null) renewal() else null
        ledger.update { state ->
            val old = state.bindings.firstOrNull { it.account == account }
            val removal = when {
                old == null -> null
                old.unanswered -> CloudPushRemoval(
                    account.server, account.userId,
                    old.registration ?: CloudPushRegistration(old.id, NO_VERSION, clock() + REGISTRATION_LIFETIME),
                    route, putFirst = true, renewal = with,
                )
                else -> old.registration?.let { CloudPushRemoval(account.server, account.userId, it, route) }
            }
            state.copy(
                bindings = state.bindings.filterNot { it.account == account },
                pending = if (removal != null && removal !in state.pending) state.pending + removal else state.pending,
            )
        }
        if (api != null) clean(account, api, renewal)
    }

    /** Called on launch/network return only with current authentication for the same member and server. */
    suspend fun cleanup(account: CloudPushAccount, api: CloudPushApi, renewal: suspend () -> CloudPushRenewal? = { null }) = lock(account).withLock {
        if (signedIn(account)) clean(account, api, renewal)
    }

    private suspend fun clean(account: CloudPushAccount, api: CloudPushApi, renewal: suspend () -> CloudPushRenewal?) {
        val pending = ledger.snapshot().pending.filter { it.server == account.server && it.userId == account.userId }
        for (removal in pending) {
            try {
                deliver(removal, api, renewal)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Keep identifiers/version only. A later same-member sign-in may authorize cleanup.
                return
            }
        }
    }

    /**
     * One removal over [api], gone from the ledger once the daemon took it.
     * With [CloudPushRemoval.putFirst] the row is registered once more first:
     * its answer is the only thing that names the version the row has now.
     * For that moment the daemon being left holds a fresh row; the removal
     * follows in the same try, and stays owed with the version just heard.
     * With nothing to register with, what is known is all there is: the
     * version last heard, or nothing to send at all.
     */
    private suspend fun deliver(removal: CloudPushRemoval, api: CloudPushApi, renewal: suspend () -> CloudPushRenewal?) {
        var current = removal
        if (current.putFirst) {
            val with = current.renewal ?: renewal()
            val token = with?.let { HappyPushToken.parse(it.token) }
            if (with != null && token != null) {
                val registration = api.register(current.registration.id, token, with.appId, with.locale)
                val heard = current.copy(registration = registration, putFirst = false, renewal = null)
                ledger.update { it.copy(pending = it.pending.map { kept -> if (kept == current) heard else kept }) }
                current = heard
            } else if (current.registration.version == NO_VERSION) {
                ledger.update { it.copy(pending = it.pending - current) }
                return
            }
        }
        api.unregister(current.registration)
        ledger.update { it.copy(pending = it.pending - current) }
    }

    /**
     * [connectionId] is being forgotten: nothing registers on it again in
     * this process, and its removal goes with [route] (a pairing's; null
     * for a sign-in), also when it is only queued after the connection went.
     */
    fun leaving(connectionId: String, route: CloudPushFarewellRoute?) { leaving[connectionId] = Leaving(route) }

    /**
     * Sends the farewells that outlived their connections, each over its own
     * route ([link] makes the way to its daemon), and drops every removal
     * whose registration has expired: the daemon has dropped that row by
     * itself. A farewell is settled by the daemon's answer, also a refusal
     * that asking again won't change (the phone was removed there, 401);
     * not by silence, 408, 429 or a 5xx. True while one is still owed.
     */
    suspend fun retire(link: (CloudPushFarewellRoute) -> CloudPushFarewellLink): Boolean {
        val now = clock()
        if (ledger.snapshot().pending.any { it.registration.expiresAt <= now }) {
            ledger.update { state -> state.copy(pending = state.pending.filter { it.registration.expiresAt > now }) }
        }
        var owed = false
        for (queued in ledger.snapshot().pending) {
            val route = queued.route ?: continue
            locks.getOrPut(Member(queued.server, queued.userId)) { Mutex() }.withLock {
                // Delivered meanwhile by the same member's connection ([cleanup]), or by an earlier try that got as far as the version.
                val removal = ledger.snapshot().pending.firstOrNull { it.route == route && it.registration.id == queued.registration.id } ?: return@withLock
                val way = link(route)
                try {
                    if (withTimeoutOrNull(FAREWELL_DEADLINE) { deliver(removal, way.api) { null } } == null) owed = true
                } catch (e: CancellationException) {
                    throw e
                } catch (e: CloudPushException) {
                    if (e.status?.let(::pushAnswerSettles) == true) {
                        ledger.update { state -> state.copy(pending = state.pending.filterNot { it.route == route && it.registration.id == removal.registration.id }) }
                    } else owed = true
                } catch (_: Exception) {
                    owed = true
                } finally {
                    withContext(NonCancellable) { runCatching { way.close() } }
                }
            }
        }
        return owed
    }

    /** Bindings whose connections disappeared while the process was not running still need retirement. */
    fun accounts(): List<CloudPushAccount> = ledger.snapshot().bindings.map { it.account }

    private companion object {
        /** Beyond any transport's own deadline: a registration that never answers must not hold an unpair forever. */
        const val REGISTER_DEADLINE = 60_000L
        const val FAREWELL_DEADLINE = 20_000L
        /** happy-agent keeps a registration 30 days from the PUT that made it: the bound for one whose answer was never heard. */
        const val REGISTRATION_LIFETIME = 30L * 24 * 60 * 60 * 1000
        /** Whether a registration sent is marked unanswered until its answer is kept. */
        const val MARKS_UNANSWERED = true
    }
}