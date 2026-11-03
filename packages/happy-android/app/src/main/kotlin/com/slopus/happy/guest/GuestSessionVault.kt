package com.slopus.happy.guest

import android.content.Context
import com.slopus.happy.auth.AndroidKeyStoreKeys
import com.slopus.happy.auth.ExpoSecureStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.security.SecureRandom
import java.util.Base64

/** A message sent and not yet acknowledged, kept with its stable [localId] so a retry is the same message. */
@Serializable
data class GuestPendingMessage(val localId: String, val text: String) {
    override fun toString() = "GuestPendingMessage($localId, …)"
}

/** One invitation's session as kept: the bridge's [origin], the session, the guest's name, an unacknowledged message. */
@Serializable
data class StoredGuestSession(
    val origin: String,
    val invitationId: String,
    val session: GuestSession,
    val displayName: String? = null,
    val pending: GuestPendingMessage? = null,
    /** The bridge refused a send for good: read only from here on. */
    val readOnlyOverride: Boolean? = null,
)

/**
 * A join under way: what is durable before the redeem reaches the bridge,
 * so a lost answer recovers the same seat ([redeemNonce]).
 */
@Serializable
data class PendingGuestRedemption(
    val invitationUrl: String,
    val origin: String,
    val redeemNonce: String,
    val displayName: String? = null,
    /** The bridge refused the name before claiming a seat: a corrected one may reuse the nonce. */
    val nameRejected: Boolean? = null,
) {
    override fun toString() = "PendingGuestRedemption($origin, …)"
}

/** Where the vault's one item lives: a whole registry in, a whole registry out. */
interface GuestSecretStorage {
    fun read(): String?
    fun write(value: String)
    fun delete()
}

/**
 * The guest's scoped sessions, in a store of their own (happy-ios
 * HappyGuest/GuestSessionVault.swift): never the Happy accounts', agent
 * connections' or any owner credential's. One registry of sessions and
 * pending joins by invitation, and the last one open. A join is durable
 * before it reaches the bridge and finishes in the vault's own scope, so
 * leaving the screen doesn't lose it. Expiry, revocation, a full invite and
 * Leave remove an invitation's session; one more than a day past its expiry
 * is pruned; with nothing left the item itself goes.
 */
class GuestSessionVault(
    private val storage: GuestSecretStorage,
    private val makeClient: (String) -> GuestClient = { GuestClient(it) },
    private val now: () -> Long = System::currentTimeMillis,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    @Serializable
    private data class Registry(
        val activeId: String? = null,
        val sessions: Map<String, StoredGuestSession> = emptyMap(),
        val redemptions: Map<String, PendingGuestRedemption> = emptyMap(),
    )

    private val lock = Mutex()
    private val inFlight = HashMap<String, Deferred<StoredGuestSession>>()
    private val invalidated = HashSet<String>()

    /** [invitationId]'s session, or the last one open. */
    suspend fun restore(invitationId: String? = null): StoredGuestSession? = locked {
        val registry = read()
        (invitationId ?: registry.activeId)?.let { registry.sessions[it] }
    }

    suspend fun pendingRedemption(invitationId: String? = null): PendingGuestRedemption? = locked {
        val registry = read()
        (invitationId ?: registry.activeId)?.let { registry.redemptions[it] }
    }

    /** Keeps [session], [select]ed as the one open; refused once its invitation was removed. */
    suspend fun save(session: StoredGuestSession, select: Boolean = true) = locked { saveLocked(session, select) }

    private fun saveLocked(session: StoredGuestSession, select: Boolean) {
        if (session.invitationId in invalidated) throw GuestError.Revoked
        val registry = read()
        write(
            registry.copy(
                sessions = registry.sessions + (session.invitationId to session),
                redemptions = registry.redemptions - session.invitationId,
                activeId = if (select || registry.activeId == null) session.invitationId else registry.activeId,
            ),
        )
    }

    /**
     * Joins [invitation] as [displayName], or answers with the session it
     * already has. Every caller for one invitation waits on the same join.
     * The nonce and the name are kept before anything is sent; a lost answer
     * is recovered by asking again with them.
     */
    suspend fun redeem(invitation: GuestInvitation, origin: String, displayName: String): StoredGuestSession {
        val id = invitation.identifier
        val join = lock.withLock {
            withContext(Dispatchers.IO) {
                val registry = read()
                registry.sessions[id]?.takeIf { it.origin == origin }?.let { return@withContext null to it }
                inFlight[id]?.let { return@withContext it to null }
                val name = GuestDisplayName.normalized(displayName) ?: throw GuestError.InvalidName
                val saved = registry.redemptions[id]
                val pending = if (saved != null) {
                    if (saved.origin != origin) throw GuestError.InvalidResponse
                    saved.copy(displayName = if (saved.nameRejected == true) name else saved.displayName ?: name, nameRejected = null)
                } else {
                    PendingGuestRedemption(invitation.url, origin, nonce(), name)
                }
                // The name and nonce are kept BEFORE any redeem can reach the bridge.
                write(registry.copy(redemptions = registry.redemptions + (id to pending), activeId = if (saved == null) id else registry.activeId))
                val task = scope.async {
                    val session = makeClient(origin).redeem(invitation, pending.redeemNonce, pending.displayName ?: name)
                    locked {
                        if (id in invalidated) throw GuestError.Revoked
                        StoredGuestSession(origin, id, session, session.displayName ?: pending.displayName ?: name).also { saveLocked(it, select = false) }
                    }
                }
                inFlight[id] = task
                task to null
            }
        }
        join.second?.let { return it }
        val task = join.first!!
        try {
            return task.await()
        } catch (failure: GuestError) {
            when (failure) {
                GuestError.InviteFull, GuestError.Expired, GuestError.Revoked -> remove(id)
                GuestError.InvalidName -> locked {
                    // The bridge answers invalid_name before any seat is claimed: a corrected name may reuse this nonce.
                    val registry = read()
                    registry.redemptions[id]?.let { write(registry.copy(redemptions = registry.redemptions + (id to it.copy(nameRejected = true)))) }
                }
                else -> Unit
            }
            throw failure
        } finally {
            withContext(NonCancellable) { lock.withLock { if (inFlight[id] === task) inFlight.remove(id) } }
        }
    }

    /** Forgets [invitationId] for good: its session and any join under way, and a join landing later is refused. */
    suspend fun remove(invitationId: String) = locked {
        invalidated += invitationId
        val registry = read()
        val sessions = registry.sessions - invitationId
        val redemptions = registry.redemptions - invitationId
        val active = if (registry.activeId == invitationId) sessions.keys.sorted().firstOrNull() else registry.activeId
        write(Registry(active, sessions, redemptions))
    }

    private suspend fun <T> locked(block: () -> T): T = lock.withLock { withContext(Dispatchers.IO) { block() } }

    /** The registry, a session more than a day past its expiry pruned: a day's grace for the phone's clock; the bridge still decides. */
    private fun read(): Registry {
        val stored = storage.read() ?: return Registry()
        val registry = try {
            json.decodeFromString(Registry.serializer(), stored)
        } catch (_: Exception) {
            return Registry()
        }
        val cutoff = (now() - DAY_MS).toDouble()
        val expired = registry.sessions.filterValues { it.session.expiresAt < cutoff }.keys
        if (expired.isEmpty()) return registry
        val sessions = registry.sessions - expired
        val pruned = Registry(if (registry.activeId in expired) sessions.keys.sorted().firstOrNull() else registry.activeId, sessions, registry.redemptions)
        write(pruned)
        return pruned
    }

    private fun write(registry: Registry) {
        if (registry.sessions.isEmpty() && registry.redemptions.isEmpty()) storage.delete()
        else storage.write(json.encodeToString(Registry.serializer(), registry))
    }

    companion object {
        private const val DAY_MS = 86_400_000L
        private val json = Json { ignoreUnknownKeys = true }
        private val random = SecureRandom()

        /** 32 random bytes, base64url without padding: 43 characters. */
        fun nonce(): String = ByteArray(32).also(random::nextBytes).let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }

        @Volatile private var shared: GuestSessionVault? = null

        /**
         * The phone's one guest vault, made when an invitation is first
         * opened: the `guest-sessions` preferences sealed by a Keystore key of
         * its own (`bot-guest`), kept off backups and transfers like every
         * credential, and never the accounts' store.
         */
        fun of(context: Context): GuestSessionVault = shared ?: synchronized(this) {
            shared ?: GuestSessionVault(KeystoreGuestStorage(context.applicationContext)).also { shared = it }
        }
    }
}

/** The vault's item in the Android Keystore's sealing, as expo-secure-store seals one, under its own service. */
class KeystoreGuestStorage(context: Context) : GuestSecretStorage {
    private val store = ExpoSecureStore(
        prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE),
        keys = AndroidKeyStoreKeys(),
        keychainService = KEYCHAIN_SERVICE,
    )

    override fun read(): String? = try {
        store.getItem(ITEM)
    } catch (_: java.security.GeneralSecurityException) {
        // Sealed by a key this phone no longer has: as if nothing were kept.
        null
    }

    override fun write(value: String) = store.setItem(ITEM, value)

    override fun delete() = store.deleteItem(ITEM)

    companion object {
        const val PREFS_NAME = "guest-sessions"
        const val KEYCHAIN_SERVICE = "bot-guest"
        const val ITEM = "scoped-sessions"
    }
}
