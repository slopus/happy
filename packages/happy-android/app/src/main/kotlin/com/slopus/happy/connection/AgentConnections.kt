package com.slopus.happy.connection

import android.content.SharedPreferences
import com.slopus.happy.auth.ExpoSecureStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID

/** A paired agent as listed beside relay accounts. Holds no secret. */
@Serializable
data class AgentConnection(
    val id: String,
    val name: String,
    val thumbhash: String? = null,
    /** The agent's own picture, kept on this phone, and the ETag it came with. */
    val avatarFile: String? = null,
    val avatarETag: String? = null,
    /** The agent removed this phone (401/403); it must be paired again. */
    val revoked: Boolean = false,
    val addedAt: Long,
    /** A team server signed in with OAuth (edge SSO), not a paired agent: its origin. */
    val server: String? = null,
    /** The team server's sign-in expired and couldn't be refreshed: the person signs in again. */
    val signInRequired: Boolean = false,
    /** Signed in, but the team server has no profile for the person yet: they give a name (with [signInRequired]). */
    val profileRequired: Boolean = false,
    /** Health's `instanceId` when last read: external `happy://<instanceId>/…` links open here (edge SSO §7). */
    val instanceId: String? = null,
    /**
     * The team server's member signed in here ([OAuthCredential.userId]). A
     * connection is one person's on one server: another person signing in
     * gets one of their own, never this one's sessions, caches or cursor.
     */
    val userId: String? = null,
)

/**
 * The paired agents (iOS's AgentConnections). Each one's credentials
 * (address, port, device id and token) are kept in a Keystore-encrypted
 * store of their own, never in the React Native app's credential item; the
 * registry beside them holds only the cached name, avatar placeholder,
 * revocation and order; each agent's picture is a file in [pictures]
 * (none kept without one). Nothing here touches a relay account.
 */
class AgentConnections(
    private val secrets: ExpoSecureStore,
    private val registry: SharedPreferences,
    private val makeTransport: (AgentConnectionCredentials) -> Transport = { agentTransport(it.address, it.port, it.publicUrl, it.tailcatAvailable != false) },
    private val now: () -> Long = System::currentTimeMillis,
    private val pictures: File? = null,
    /** Refreshes team servers' access tokens; without it they sign in again when one expires. */
    private val serverAuth: ServerAuthClient? = null,
    /** Where a disconnected pairing's device goes to be removed from its agent; without it, nothing is sent. */
    private val revokes: DeviceRevokes? = null,
) {
    private val lock = Mutex()
    /** Team servers' access tokens: in memory only, by connection id. */
    private val tokens = mutableMapOf<String, AccessToken>()
    private val refreshing = mutableMapOf<String, Mutex>()
    /** Each connection's current grant, counted up by every sign-in: a refresh of an older one is dropped. */
    private val generations = mutableMapOf<String, Long>()
    private val state = MutableStateFlow(readRegistry())
    private val endpointLock = Any()
    private val endpoints = mutableMapOf<String, AgentEndpoint>()

    init {
        revokes?.inUse = { token -> holds(token) }
    }

    /**
     * Whether a connection on this phone holds [deviceToken] now. Under
     * [lock], so a connection [remove] is taking away reads as gone, never
     * as one still held.
     */
    private suspend fun holds(deviceToken: String): Boolean = lock.withLock {
        withContext(Dispatchers.IO) { state.value.any { read(it.id)?.deviceToken == deviceToken } }
    }

    internal fun transport(id: String, credentials: AgentConnectionCredentials, make: (AgentConnectionCredentials) -> Transport): Transport {
        val endpoint = synchronized(endpointLock) {
            endpoints.getOrPut(id) { AgentEndpoint(credentials) { next -> saveEndpoint(id, next) } }
        }
        return AgentEndpointTransport(endpoint, make)
    }

    private suspend fun saveEndpoint(id: String, next: AgentConnectionCredentials) = lock.withLock {
        withContext(Dispatchers.IO) {
            if (state.value.none { it.id == id } || read(id)?.deviceToken != next.deviceToken) throw CancellationException("connection removed")
            secrets.setItem(id, json.encodeToString(AgentConnectionCredentials.serializer(), next))
        }
    }

    /** Oldest first. */
    val accounts: StateFlow<List<AgentConnection>> = state.asStateFlow()

    /** The credentials of [id], read from the secure store; null when gone. */
    suspend fun credentials(id: String): AgentConnectionCredentials? = withContext(Dispatchers.IO) { read(id) }

    /**
     * [id]'s credentials to link with. A team server's that are gone (their
     * Keystore key missing: restored or moved to another phone, which never
     * carries it) leave it signed out, "Sign in again", rather than revoked.
     * [afterRead] runs between the first read and the check (tests).
     */
    suspend fun linkCredentials(id: String, afterRead: suspend () -> Unit = {}): AgentConnectionCredentials? {
        val grant = grant(id)
        credentials(id)?.let { return it }
        afterRead()
        if (state.value.firstOrNull { it.id == id }?.server == null) return null
        // Read again and signed out under one hold of the lock: a sign-in that landed since stands.
        val signedIn = lock.withLock {
            withContext(Dispatchers.IO) { read(id) } ?: run {
                if (grant(id) == grant) change(id) { it.copy(signInRequired = true, profileRequired = false) }
                null
            }
        }
        return signedIn ?: throw AgentConnectionException(AgentConnectionException.Reason.SignInRequired)
    }

    /**
     * What [id]'s placeholder picture is picked by (happy-ios's
     * `placeholderSeed(for:)`): its computer's address, the same on every
     * phone paired with it; null when its credentials are gone.
     */
    suspend fun placeholderSeed(id: String): String? = credentials(id)?.let { "agent:${it.address}" }

    /**
     * Keeps a freshly paired agent. Its own name and avatar are read first
     * when it answers; otherwise it is listed under [fallbackName] (the
     * pairing code's) until it does. Re-reading the same completed handshake
     * updates its entry; a fresh pairing has its own device ID and account.
     * An agent that refuses the new token is not kept.
     */
    suspend fun add(credentials: AgentConnectionCredentials, fallbackName: String): AgentConnection = lock.withLock {
        withContext(Dispatchers.IO) {
            val id = state.value.firstOrNull { existing ->
                read(existing.id)?.let { it.address == credentials.address && it.deviceId == credentials.deviceId && it.deviceToken == credentials.deviceToken } == true
            }?.id ?: "agent-connection-${UUID.randomUUID()}"
            // Re-reading a completed handshake is idempotent: keep its live
            // endpoint (including any newer discovery) and stable clients.
            // A different token gets a new account lifetime, never a retired
            // endpoint still held by an existing AgentSession.
            val savedCredentials = read(id) ?: credentials
            val transport = makeTransport(credentials)
            val agent = try {
                AgentIdentity.refresh(transport, credentials.deviceToken, fallbackName)
            } catch (e: CancellationException) {
                throw e
            } catch (e: AgentConnectionException) {
                if (e.reason == AgentConnectionException.Reason.Revoked) throw e
                null
            } catch (_: Exception) {
                null // Unreachable for now: kept under the code's name.
            } finally {
                transport.close()
            }
            secrets.setItem(id, json.encodeToString(AgentConnectionCredentials.serializer(), savedCredentials))
            val previous = state.value.firstOrNull { it.id == id }
            val account = keep(
                AgentConnection(
                    id = id,
                    name = agent?.name ?: previous?.name ?: fallbackName,
                    thumbhash = agent?.thumbhash ?: previous?.thumbhash,
                    avatarFile = previous?.avatarFile,
                    avatarETag = previous?.avatarETag,
                    addedAt = previous?.addedAt ?: now(),
                    instanceId = agent?.instanceId ?: previous?.instanceId,
                ),
                agent?.avatar ?: NodeAvatar.Unchanged,
            )
            write(state.value.filterNot { it.id == id } + account)
            // An agent was just reached: a pairing disconnected while it
            // couldn't be is revoked now, with its own old token.
            revokes?.resume()
            account
        }
    }

    /** Updates what is shown for [id] after a refresh, [avatar] kept or let go; a removed account stays removed. */
    suspend fun update(id: String, avatar: NodeAvatar = NodeAvatar.Unchanged, transform: (AgentConnection) -> AgentConnection) = lock.withLock {
        change(id, avatar, transform)
    }

    /** [update], holding [lock]. */
    private suspend fun change(id: String, avatar: NodeAvatar = NodeAvatar.Unchanged, transform: (AgentConnection) -> AgentConnection) =
        withContext(Dispatchers.IO) {
            val list = state.value
            val index = list.indexOfFirst { it.id == id }.takeIf { it >= 0 } ?: return@withContext
            val next = keep(transform(list[index]), avatar)
            if (next != list[index]) write(list.toMutableList().also { it[index] = next })
        }

    /**
     * Keeps a team server signed in with OAuth ([origin], edge SSO): its
     * [credential] (the refresh token, Keystore-encrypted like a device
     * token, and who signed in) and [access] (in memory). A connection is
     * one member's on one server, as on iOS: the same member signing in to
     * a server already on the phone, or [replacing] one, renews it in place;
     * another member gets a new connection, and the one they replaced (its
     * session, caches and cursor) is wiped. Its name is the server's own
     * once it answers, else [fallbackName].
     */
    suspend fun addServer(origin: AgentOrigin, credential: OAuthCredential, access: AccessToken, fallbackName: String, replacing: String? = null): AgentConnection {
        val credentials = AgentConnectionCredentials(
            address = origin.host,
            port = origin.port,
            deviceId = "",
            deviceToken = "",
            publicUrl = origin.value,
            tailcatAvailable = false,
            oauth = credential,
        )
        // Who the server is, asked before anything here changes: cancelled or failed, everything stays as it was.
        val agent = withContext(Dispatchers.IO) {
            val transport = makeTransport(credentials)
            try {
                AgentIdentity.refresh(transport, access.value, fallbackName, oauth = true)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            } finally {
                withContext(NonCancellable) { transport.close() }
            }
        }
        return lock.withLock {
            withContext(Dispatchers.IO) {
                val userId = credential.userId
                fun sameMember(account: AgentConnection) = userId != null && account.server == origin.value && account.userId == userId
                val replaced = state.value.firstOrNull { it.id == replacing }
                val existing = replaced?.takeIf(::sameMember) ?: state.value.firstOrNull(::sameMember)
                // Another member's: nothing of theirs stays for this one to see.
                val dropped = replaced?.takeIf { it.id != existing?.id }
                val id = existing?.id ?: "agent-connection-${UUID.randomUUID()}"
                // This member's credential first: if it can't be kept, nothing else changes.
                secrets.setItem(id, json.encodeToString(AgentConnectionCredentials.serializer(), credentials))
                withContext(NonCancellable) {
                    val account = keep(
                        AgentConnection(
                            id = id,
                            name = agent?.name ?: existing?.name ?: fallbackName,
                            thumbhash = agent?.thumbhash ?: existing?.thumbhash,
                            avatarFile = existing?.avatarFile,
                            avatarETag = existing?.avatarETag,
                            addedAt = existing?.addedAt ?: now(),
                            server = origin.value,
                            instanceId = agent?.instanceId ?: existing?.instanceId,
                            userId = userId,
                        ),
                        agent?.avatar ?: NodeAvatar.Unchanged,
                    )
                    synchronized(tokens) {
                        generations[id] = (generations[id] ?: 0) + 1
                        tokens[id] = access
                    }
                    // One write: the list changes once, from the replaced member's to this one's; then theirs is let go.
                    write(state.value.filterNot { it.id == id || it.id == dropped?.id } + account)
                    if (dropped != null) forget(dropped, keepEntry = true)
                    account
                }
            }
        }
    }

    /**
     * What [id]'s requests are authorized with: a paired agent's device
     * token, or a team server's access token, refreshed first when it is
     * missing or within a minute of expiring. Throws
     * [AgentConnectionException]: SignInRequired when it can't be refreshed,
     * Unavailable when the refresh URL can't be reached.
     */
    suspend fun bearer(id: String, credentials: AgentConnectionCredentials): String {
        if (credentials.oauth == null) return credentials.deviceToken
        synchronized(tokens) { tokens[id] }?.takeIf(::fresh)?.let { return it.value }
        return refresh(id, stale = null)
    }

    /**
     * [id]'s team server wants signing in again ([profileRequired]: only a
     * name): its links wait, and home says so, until the person has.
     */
    suspend fun signedOut(id: String, profileRequired: Boolean = false, grant: Long? = null) = lock.withLock {
        // Refused under an older sign-in than [id]'s now: the newer one stands.
        if (grant != null && grant != grant(id)) return@withLock
        change(id) { it.copy(signInRequired = true, profileRequired = profileRequired) }
    }

    /**
     * [id]'s current sign-in, counted up by each one: what a request is
     * made under, so that its failure signs out only that sign-in
     * ([signedOut]), never one that landed meanwhile.
     */
    fun grant(id: String): Long = synchronized(tokens) { generations[id] ?: 0 }

    /** After [stale] was refused with a 401: a newer token, refreshed unless another request already did. */
    suspend fun renew(id: String, stale: String): String = refresh(id, stale)

    private fun fresh(token: AccessToken) = token.expiresAtMillis == null || token.expiresAtMillis - now() > REFRESH_MARGIN_MILLIS

    private suspend fun refresh(id: String, stale: String?): String {
        val gate = synchronized(tokens) { refreshing.getOrPut(id) { Mutex() } }
        return gate.withLock {
            synchronized(tokens) { tokens[id] }?.takeIf { it.value != stale && fresh(it) }?.let { return@withLock it.value }
            val generation = grant(id)
            val credential = credentials(id)?.oauth ?: throw AgentConnectionException(AgentConnectionException.Reason.SignInRequired)
            val (access, next) = try {
                val server = state.value.firstOrNull { it.id == id }?.server?.let { runCatching { AgentOrigin.parse(it) }.getOrNull() }
                    ?: throw ServerAuthException(ServerAuthException.Reason.SignInRequired)
                serverAuth?.refresh(credential, server) ?: throw ServerAuthException(ServerAuthException.Reason.SignInRequired)
            } catch (e: ServerAuthException) {
                if (e.reason == ServerAuthException.Reason.Unreachable) {
                    throw AgentConnectionException(AgentConnectionException.Reason.Unavailable).initCause(e)
                }
                // Checked and signed out under one hold of the lock, so no sign-in lands in between.
                val signedOutHere = lock.withLock {
                    current(id, generation, credential).also { current ->
                        if (current) {
                            synchronized(tokens) { tokens.remove(id) }
                            change(id) { it.copy(signInRequired = true, profileRequired = false) }
                        }
                    }
                }
                if (signedOutHere) throw AgentConnectionException(AgentConnectionException.Reason.SignInRequired).initCause(e)
                // A sign-in landed meanwhile and stands: an older grant's refusal is no auth failure, and the request goes on with the new token.
                return@withLock synchronized(tokens) { tokens[id] }?.value ?: throw AgentConnectionException(AgentConnectionException.Reason.Unavailable).initCause(e)
            }
            lock.withLock {
                // A sign-in landed while this refresh was out: its grant stands, this one is dropped.
                if (!current(id, generation, credential)) {
                    // Not an auth failure: the newer sign-in's token, or try again.
                    return@withLock synchronized(tokens) { tokens[id] }?.value ?: throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
                }
                if (next != credential) {
                    // A rotated refresh token: the old one may already be spent.
                    withContext(Dispatchers.IO) {
                        val saved = read(id) ?: return@withContext
                        secrets.setItem(id, json.encodeToString(AgentConnectionCredentials.serializer(), saved.copy(oauth = next)))
                    }
                }
                synchronized(tokens) { tokens[id] = access }
                access.value
            }
        }
    }

    /** Whether [credential], read at [generation], is still [id]'s grant. */
    private suspend fun current(id: String, generation: Long, credential: OAuthCredential): Boolean =
        grant(id) == generation && withContext(Dispatchers.IO) { read(id)?.oauth } == credential

    /**
     * [account] with [avatar] in its file: new bytes go to a file named by
     * their hash, so a picture's path changes with it and no cache shows the
     * old one; the file it replaces is deleted.
     */
    private fun keep(account: AgentConnection, avatar: NodeAvatar): AgentConnection {
        val dir = pictures ?: return account
        val next = when (avatar) {
            NodeAvatar.Unchanged -> return account
            NodeAvatar.None -> account.copy(avatarFile = null, avatarETag = null)
            is NodeAvatar.Picture -> {
                val digest = MessageDigest.getInstance("SHA-256").digest(avatar.bytes).take(8).joinToString("") { "%02x".format(it) }
                val file = File(dir, "${account.id}-$digest")
                try {
                    dir.mkdirs()
                    if (!file.exists()) File(dir, "${file.name}.tmp").also { it.writeBytes(avatar.bytes) }.renameTo(file)
                } catch (_: IOException) {
                }
                if (!file.exists()) return account
                account.copy(avatarFile = file.path, avatarETag = avatar.etag)
            }
        }
        account.avatarFile?.takeIf { it != next.avatarFile }?.let { File(it).delete() }
        return next
    }

    /**
     * Forgets the agent on this phone, and hands its device's removal from
     * the agent to [revokes] (`DELETE /v0/mobile-connector/device` with this
     * pairing's own token), kept before the credentials go and sent once
     * they have (a token still held here is never sent), now or once the
     * agent can be reached, so pairing again leaves one device there, not
     * two.
     */
    suspend fun remove(id: String) = lock.withLock {
        withContext(Dispatchers.IO) {
            val account = state.value.firstOrNull { it.id == id }
            if (account != null) {
                read(id)?.let { revokes?.keep(id, it) }
                forget(account)
                revokes?.resume()
            }
        }
    }

    /** [account] gone from this phone: its endpoint, tokens, credentials, picture and entry (its session and caches go with the entry, `AgentSessions`). Holding [lock], on IO. */
    private suspend fun forget(account: AgentConnection, keepEntry: Boolean = false) {
        val id = account.id
        synchronized(endpointLock) { endpoints.remove(id) }?.retire()
        synchronized(tokens) {
            tokens.remove(id)
            generations.remove(id)
        }
        secrets.deleteItem(id)
        account.avatarFile?.let { File(it).delete() }
        if (!keepEntry) write(state.value.filterNot { it.id == id })
    }

    private fun read(id: String): AgentConnectionCredentials? = try {
        secrets.getItem(id)?.let { json.decodeFromString(AgentConnectionCredentials.serializer(), it) }
    } catch (_: Exception) {
        null
    }

    private fun readRegistry(): List<AgentConnection> = try {
        registry.getString(KEY, null)?.let { json.decodeFromString<List<AgentConnection>>(it) } ?: emptyList()
    } catch (_: Exception) {
        emptyList()
    }

    private fun write(list: List<AgentConnection>) {
        registry.edit().putString(KEY, json.encodeToString(list)).commit()
        state.value = list
    }

    companion object {
        /** The registry; the credentials live in [SECRETS_PREFS] under the keychain service [KEYCHAIN_SERVICE]. */
        const val REGISTRY_PREFS = "agent-connection-registry"
        const val SECRETS_PREFS = "agent-connection-credentials"
        const val KEYCHAIN_SERVICE = "agent-connection"
        private const val KEY = "accounts"
        /** A team server's access token is refreshed this long before it expires (edge SSO contract §1). */
        const val REFRESH_MARGIN_MILLIS = 60_000L
        private val json = Json { ignoreUnknownKeys = true }
    }
}
