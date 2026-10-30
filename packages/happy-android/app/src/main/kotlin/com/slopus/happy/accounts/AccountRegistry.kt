package com.slopus.happy.accounts

import android.content.SharedPreferences
import com.slopus.happy.auth.AuthCredentials
import com.slopus.happy.auth.CredentialStore
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.config.ServerConfig
import com.slopus.happy.crypto.deriveKey
import com.slopus.happy.crypto.encodeHex
import com.slopus.happy.model.Profile
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** What the account switcher shows for a Happy account, from its stored profile. */
@Serializable
data class AccountDisplay(
    val name: String? = null,
    val username: String? = null,
    val avatarUrl: String? = null,
    val avatarThumbhash: String? = null,
) {
    companion object {
        fun of(profile: Profile): AccountDisplay? {
            if (profile.id.isEmpty()) return null
            return AccountDisplay(profile.displayName, profile.github?.login, profile.avatarUrl, profile.avatar?.thumbhash)
        }
    }
}

/** Where an account's credentials are: the React Native app's one item, or an item of its own. */
@Serializable
enum class CredentialLocation { Shared, Own }

/** One Happy (relay) account signed in on this phone. Holds no secret. */
@Serializable
data class AccountEntry(
    /** The account's anonymous id: stable, and the same for the same secret. */
    val id: String,
    val serverUrl: String,
    val location: CredentialLocation,
    val addedOrder: Int,
    /** False when the React Native server setting couldn't be read safely: no request until the person confirms it. */
    val serverConfirmed: Boolean = true,
    val display: AccountDisplay? = null,
)

/**
 * The account inventory (iOS's AccountRegistry): the Happy accounts in added
 * order and the one open, which may be an agent connection's id instead.
 * No tokens or secrets.
 */
@Serializable
data class AccountRegistry(val entries: List<AccountEntry> = emptyList(), val activeId: String? = null) {
    val ordered: List<AccountEntry> get() = entries.sortedBy { it.addedOrder }
    fun entry(id: String?): AccountEntry? = entries.firstOrNull { it.id == id }
}

/** An account's own credential item, with its server for recovery. */
@Serializable
data class StoredAccountCredentials(val credentials: AuthCredentials, val serverUrl: String) {
    override fun toString() = "StoredAccountCredentials(serverUrl=$serverUrl)"
}

/** The account id of [credentials]: the first 16 hex of its analytics key, as iOS and happy-app derive it. */
fun accountId(credentials: AuthCredentials): String? = try {
    val secret = credentials.secretBytes()
    if (secret.size != 32) null else encodeHex(deriveKey(secret, "Happy Coder", listOf("analytics", "id"))).substring(0, 16).lowercase()
} catch (_: IllegalArgumentException) {
    null
}

/**
 * The Happy accounts on this phone (iOS's AccountController, storage half).
 * The first account keeps the React Native app's credential item
 * ([CredentialLocation.Shared]), so an upgrade stays signed in and a
 * downgrade still finds it; every other account has its own item in [own].
 * [reconcile] rebuilds the registry from the credentials, importing the
 * React Native server setting for the shared item the first time it is seen.
 *
 * Calls block on storage; the app makes them off the main thread, except
 * the first [reconcile] at start.
 */
class AccountStore(
    private val shared: CredentialStore,
    private val own: ExpoSecureStore,
    private val prefs: SharedPreferences,
    private val defaultServerUrl: String,
    private val importRnServer: () -> ImportedServer,
) {
    private val state = MutableStateFlow(load())
    val registry: StateFlow<AccountRegistry> = state.asStateFlow()

    /**
     * Brings the registry in line with the stored credentials: entries
     * without credentials go, credentials without an entry are added (the
     * shared item with the React Native server). Returns every account's
     * credentials by id.
     */
    @Synchronized
    fun reconcile(): Map<String, StoredAccountCredentials> {
        val values = HashMap<String, StoredAccountCredentials>()
        for (key in own.keys()) {
            val value = try {
                own.getItem(key)?.let { json.decodeFromString(StoredAccountCredentials.serializer(), it) }
            } catch (_: Exception) {
                null
            } ?: continue
            if (accountId(value.credentials) != key || ServerConfig.validate(value.serverUrl) != ServerConfig.Validation.Valid) continue
            values[key] = value
        }
        val sharedCredentials = shared.read()
        val sharedId = sharedCredentials?.let(::accountId)
        // The shared item wins over an own item for the same account.
        if (sharedId != null && values.remove(sharedId) != null) own.deleteItem(sharedId)
        var current = state.value
        val kept = current.ordered.filter { entry ->
            if (entry.location == CredentialLocation.Shared) entry.id == sharedId else entry.id in values
        }.mapIndexed { index, entry -> entry.copy(addedOrder = index) }.toMutableList()
        var imported: ImportedServer? = null
        if (sharedCredentials != null && sharedId != null) {
            val known = kept.firstOrNull { it.id == sharedId }
            val url = known?.serverUrl ?: when (val server = importRnServer().also { imported = it }) {
                is ImportedServer.Confirmed -> server.url
                // A placeholder only: serverConfirmed keeps the token off the network.
                ImportedServer.NeedsConfirmation -> defaultServerUrl
            }
            values[sharedId] = StoredAccountCredentials(sharedCredentials, url)
        }
        for (id in values.keys.sorted()) {
            if (kept.any { it.id == id }) continue
            kept += AccountEntry(
                id = id,
                serverUrl = values.getValue(id).serverUrl,
                location = if (id == sharedId) CredentialLocation.Shared else CredentialLocation.Own,
                addedOrder = (kept.maxOfOrNull { it.addedOrder } ?: -1) + 1,
                serverConfirmed = id != sharedId || imported != ImportedServer.NeedsConfirmation,
            )
        }
        val active = current.activeId?.takeIf { id -> kept.any { it.id == id } || !isAccountId(id) }
            ?: kept.minByOrNull { it.addedOrder }?.id
        current = AccountRegistry(kept, active)
        save(current)
        return values
    }

    /** The credentials of [id], read again from storage. */
    @Synchronized
    fun credentials(id: String): StoredAccountCredentials? = reconcile()[id]

    /**
     * Adds or re-authenticates the account of [credentials] on [serverUrl]
     * and makes it the open one. Other accounts stay signed in. Returns its id.
     */
    @Synchronized
    fun signIn(credentials: AuthCredentials, serverUrl: String): String {
        val id = requireNotNull(accountId(credentials)) { "Invalid credentials" }
        reconcile()
        val current = state.value
        val existing = current.entry(id)
        val location = existing?.location ?: if (shared.read() == null) CredentialLocation.Shared else CredentialLocation.Own
        val url = existing?.serverUrl ?: serverUrl
        when (location) {
            CredentialLocation.Shared -> shared.write(credentials)
            CredentialLocation.Own -> own.setItem(id, json.encodeToString(StoredAccountCredentials.serializer(), StoredAccountCredentials(credentials, url)))
        }
        val entry = AccountEntry(
            id = id,
            serverUrl = url,
            location = location,
            addedOrder = existing?.addedOrder ?: ((current.entries.maxOfOrNull { it.addedOrder } ?: -1) + 1),
            serverConfirmed = existing?.serverConfirmed ?: true,
            display = existing?.display,
        )
        save(AccountRegistry(current.entries.filterNot { it.id == id } + entry, id))
        return id
    }

    /**
     * Signs [id] out on this phone: its credentials and entry go. When it
     * was open, the next account by added order opens, if any.
     */
    @Synchronized
    fun remove(id: String) {
        val current = state.value
        val entry = current.entry(id) ?: return
        when (entry.location) {
            CredentialLocation.Shared -> if (shared.read()?.let(::accountId) == id) shared.clear()
            CredentialLocation.Own -> own.deleteItem(id)
        }
        val rest = current.entries.filterNot { it.id == id }
        val active = if (current.activeId == id) rest.minByOrNull { it.addedOrder }?.id else current.activeId
        save(AccountRegistry(rest, active))
    }

    /** Opens [id]: a Happy account here, or an agent connection's id; null opens nothing. */
    @Synchronized
    fun select(id: String?) {
        save(state.value.copy(activeId = id))
    }

    /** Settles an account whose React Native server couldn't be imported, and opens it. */
    @Synchronized
    fun confirmServer(id: String, url: String) {
        require(ServerConfig.validate(url) == ServerConfig.Validation.Valid) { "Invalid server" }
        val current = state.value
        current.entry(id) ?: return
        save(AccountRegistry(
            current.entries.map { if (it.id == id) it.copy(serverUrl = url.trim().trimEnd('/'), serverConfirmed = true) else it },
            id,
        ))
    }

    /** The open account's profile changed. */
    @Synchronized
    fun updateDisplay(id: String, display: AccountDisplay?) {
        val current = state.value
        if (current.entry(id)?.display == display || current.entry(id) == null) return
        save(current.copy(entries = current.entries.map { if (it.id == id) it.copy(display = display) else it }))
    }

    private fun load(): AccountRegistry = try {
        prefs.getString(KEY, null)?.let { json.decodeFromString(AccountRegistry.serializer(), it) }
            ?.takeIf { registry -> registry.entries.map { it.id }.toSet().size == registry.entries.size && registry.entries.all { isAccountId(it.id) } }
            ?: AccountRegistry()
    } catch (_: Exception) {
        // Rebuilt from the credentials by the next reconcile.
        AccountRegistry()
    }

    private fun save(value: AccountRegistry) {
        prefs.edit().putString(KEY, json.encodeToString(AccountRegistry.serializer(), value)).commit()
        state.value = value
    }

    companion object {
        const val PREFS_NAME = "account-registry"
        const val CREDENTIALS_PREFS_NAME = "account-credentials"
        const val KEYCHAIN_SERVICE = "account"
        private const val KEY = "registry"
        private val json = Json { ignoreUnknownKeys = true }

        fun isAccountId(id: String) = id.length == 16 && id.all { it in '0'..'9' || it in 'a'..'f' }
    }
}
