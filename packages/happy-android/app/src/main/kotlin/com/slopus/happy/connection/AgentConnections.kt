package com.slopus.happy.connection

import android.content.SharedPreferences
import com.slopus.happy.auth.ExpoSecureStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.util.UUID

/** A paired agent as listed beside relay accounts. Holds no secret. */
@Serializable
data class AgentConnection(
    val id: String,
    val name: String,
    val thumbhash: String? = null,
    /** The agent removed this phone (401/403); it must be paired again. */
    val revoked: Boolean = false,
    val addedAt: Long,
)

/**
 * The paired agents (iOS's AgentConnections). Each one's credentials
 * (address, port, device id and token) are kept in a Keystore-encrypted
 * store of their own, never in the React Native app's credential item; the
 * registry beside them holds only the cached name, avatar placeholder,
 * revocation and order. Nothing here touches a relay account.
 */
class AgentConnections(
    private val secrets: ExpoSecureStore,
    private val registry: SharedPreferences,
    private val makeTransport: (AgentConnectionCredentials) -> Transport = { TailcatTransport(it.address, it.port) },
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val lock = Mutex()
    private val state = MutableStateFlow(readRegistry())

    /** Oldest first. */
    val accounts: StateFlow<List<AgentConnection>> = state.asStateFlow()

    /** The credentials of [id], read from the secure store; null when gone. */
    suspend fun credentials(id: String): AgentConnectionCredentials? = withContext(Dispatchers.IO) { read(id) }

    /**
     * Keeps a freshly paired agent. Its own name and avatar are read first
     * when it answers; otherwise it is listed under [fallbackName] (the
     * pairing code's) until it does. Pairing the same device again updates
     * its entry. An agent that refuses the new token is not kept.
     */
    suspend fun add(credentials: AgentConnectionCredentials, fallbackName: String): AgentConnection = lock.withLock {
        withContext(Dispatchers.IO) {
            val id = state.value.firstOrNull { existing ->
                read(existing.id)?.let { it.address == credentials.address && it.deviceId == credentials.deviceId } == true
            }?.id ?: "agent-connection-${UUID.randomUUID()}"
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
            secrets.setItem(id, json.encodeToString(AgentConnectionCredentials.serializer(), credentials))
            val previous = state.value.firstOrNull { it.id == id }
            val account = AgentConnection(
                id = id,
                name = agent?.name ?: previous?.name ?: fallbackName,
                thumbhash = agent?.thumbhash ?: previous?.thumbhash,
                addedAt = previous?.addedAt ?: now(),
            )
            write(state.value.filterNot { it.id == id } + account)
            account
        }
    }

    /** Updates what is shown for [id] after a refresh; a removed account stays removed. */
    suspend fun update(id: String, transform: (AgentConnection) -> AgentConnection) = lock.withLock {
        withContext(Dispatchers.IO) {
            val list = state.value
            val index = list.indexOfFirst { it.id == id }.takeIf { it >= 0 } ?: return@withContext
            write(list.toMutableList().also { it[index] = transform(it[index]) })
        }
    }

    /**
     * Forgets the agent on this phone. A device token can't reach the
     * agent's device management, so the agent keeps listing this
     * phone until it is removed there (API.md, "Credentials on the
     * connector's socket").
     */
    suspend fun remove(id: String) = lock.withLock {
        withContext(Dispatchers.IO) {
            secrets.deleteItem(id)
            write(state.value.filterNot { it.id == id })
        }
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
        private val json = Json { ignoreUnknownKeys = true }
    }
}
