package com.slopus.happy.computer

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

/** A paired computer as listed beside relay accounts. Holds no secret. */
@Serializable
data class ComputerAccount(
    val id: String,
    val name: String,
    val thumbhash: String? = null,
    /** The computer removed this phone (401/403); it must be paired again. */
    val revoked: Boolean = false,
    val addedAt: Long,
)

/**
 * The paired computers (iOS's ComputerAccounts). Each one's credentials
 * (address, port, device id and token) are kept in a Keystore-encrypted
 * store of their own, never in the React Native app's credential item; the
 * registry beside them holds only the cached name, avatar placeholder,
 * revocation and order. Nothing here touches a relay account.
 */
class ComputerAccounts(
    private val secrets: ExpoSecureStore,
    private val registry: SharedPreferences,
    private val makeTransport: (ComputerCredentials) -> Transport = { TailcatTransport(it.address, it.port) },
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val lock = Mutex()
    private val state = MutableStateFlow(readRegistry())

    /** Oldest first. */
    val accounts: StateFlow<List<ComputerAccount>> = state.asStateFlow()

    /** The credentials of [id], read from the secure store; null when gone. */
    suspend fun credentials(id: String): ComputerCredentials? = withContext(Dispatchers.IO) { read(id) }

    /**
     * Keeps a freshly paired computer. Its own name and avatar are read first
     * when it answers; otherwise it is listed under [fallbackName] (the
     * pairing code's) until it does. Pairing the same device again updates
     * its entry. A computer that refuses the new token is not kept.
     */
    suspend fun add(credentials: ComputerCredentials, fallbackName: String): ComputerAccount = lock.withLock {
        withContext(Dispatchers.IO) {
            val id = state.value.firstOrNull { existing ->
                read(existing.id)?.let { it.address == credentials.address && it.deviceId == credentials.deviceId } == true
            }?.id ?: "computer-${UUID.randomUUID()}"
            val transport = makeTransport(credentials)
            val computer = try {
                ComputerIdentity.refresh(transport, credentials.deviceToken, fallbackName)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ComputerException) {
                if (e.reason == ComputerException.Reason.Revoked) throw e
                null
            } catch (_: Exception) {
                null // Unreachable for now: kept under the code's name.
            } finally {
                transport.close()
            }
            secrets.setItem(id, json.encodeToString(ComputerCredentials.serializer(), credentials))
            val previous = state.value.firstOrNull { it.id == id }
            val account = ComputerAccount(
                id = id,
                name = computer?.name ?: previous?.name ?: fallbackName,
                thumbhash = computer?.thumbhash ?: previous?.thumbhash,
                addedAt = previous?.addedAt ?: now(),
            )
            write(state.value.filterNot { it.id == id } + account)
            account
        }
    }

    /** Updates what is shown for [id] after a refresh; a removed account stays removed. */
    suspend fun update(id: String, transform: (ComputerAccount) -> ComputerAccount) = lock.withLock {
        withContext(Dispatchers.IO) {
            val list = state.value
            val index = list.indexOfFirst { it.id == id }.takeIf { it >= 0 } ?: return@withContext
            write(list.toMutableList().also { it[index] = transform(it[index]) })
        }
    }

    /**
     * Forgets the computer on this phone. A device token can't reach the
     * computer's device management, so the computer keeps listing this
     * phone until it is removed there (API.md, "Credentials on the
     * connector's socket").
     */
    suspend fun remove(id: String) = lock.withLock {
        withContext(Dispatchers.IO) {
            secrets.deleteItem(id)
            write(state.value.filterNot { it.id == id })
        }
    }

    private fun read(id: String): ComputerCredentials? = try {
        secrets.getItem(id)?.let { json.decodeFromString(ComputerCredentials.serializer(), it) }
    } catch (_: Exception) {
        null
    }

    private fun readRegistry(): List<ComputerAccount> = try {
        registry.getString(KEY, null)?.let { json.decodeFromString<List<ComputerAccount>>(it) } ?: emptyList()
    } catch (_: Exception) {
        emptyList()
    }

    private fun write(list: List<ComputerAccount>) {
        registry.edit().putString(KEY, json.encodeToString(list)).commit()
        state.value = list
    }

    companion object {
        /** The registry; the credentials live in [SECRETS_PREFS] under the keychain service [KEYCHAIN_SERVICE]. */
        const val REGISTRY_PREFS = "computer-accounts"
        const val SECRETS_PREFS = "computer-credentials"
        const val KEYCHAIN_SERVICE = "computer"
        private const val KEY = "accounts"
        private val json = Json { ignoreUnknownKeys = true }
    }
}
