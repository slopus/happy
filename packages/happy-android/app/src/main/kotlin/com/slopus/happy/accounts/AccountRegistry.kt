package com.slopus.happy.accounts

import android.content.SharedPreferences
import com.slopus.happy.auth.AuthCredentials
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.auth.SecureStoreCredentialStore
import com.slopus.happy.auth.Stored
import com.slopus.happy.auth.UnreadableCredentials
import com.slopus.happy.auth.load
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
    /** For [CredentialLocation.Shared], the sealed item it was last read from ([SecureStoreCredentialStore.fingerprint]). */
    val sharedItem: String? = null,
)

/**
 * The account inventory (iOS's AccountRegistry): the Happy accounts in added
 * order and the one open, which may be an agent connection's id instead.
 * No tokens or secrets.
 */
@Serializable
data class AccountRegistry(
    val entries: List<AccountEntry> = emptyList(),
    val activeId: String? = null,
    /** The Happy account open last, kept while an agent connection is open ([AccountStore] sets it). */
    val lastHappyId: String? = null,
    /** The shared item ([SecureStoreCredentialStore.fingerprint]) of an account removed while it couldn't be read: never brought back. */
    val removedSharedItem: String? = null,
    /** A shared item that couldn't be read when the person went on to another account: it no longer stands in for the first screen. */
    val passedSharedItem: String? = null,
) {
    val ordered: List<AccountEntry> get() = entries.sortedBy { it.addedOrder }
    fun entry(id: String?): AccountEntry? = entries.firstOrNull { it.id == id }

    /**
     * The Happy account a terminal link (`happy://terminal?`) is approved
     * with: the open one, else the one open last, else the newest added;
     * null when the phone has none, and a new one is made for it.
     */
    fun forTerminal(usable: (AccountEntry) -> Boolean = { true }): AccountEntry? =
        entry(activeId)?.takeIf(usable) ?: entry(lastHappyId)?.takeIf(usable) ?: entries.filter(usable).maxByOrNull { it.addedOrder }
}

/**
 * The accounts whose credential items are there but couldn't be read at the
 * last [AccountStore.reconcile]: the React Native app's [shared] item (the
 * sealed [sharedItem]), and [own] items by account id (the sealed
 * [ownItems]). Neither is signed out. A [UnreadableCredentials.permanent]
 * reason is kept until a retry or until the item changes, so other reads
 * don't ask the Keystore for it again; any other is read again, once.
 */
data class UnreadableAccounts(
    val shared: UnreadableCredentials? = null,
    val sharedItem: String? = null,
    val own: Map<String, UnreadableCredentials> = emptyMap(),
    val ownItems: Map<String, String> = emptyMap(),
) {
    fun readable(entry: AccountEntry): Boolean = reason(entry) == null

    /** Why [entry]'s item can't be read; null when it can. */
    fun reason(entry: AccountEntry): UnreadableCredentials? =
        if (entry.location == CredentialLocation.Shared) shared else own[entry.id]

    /** Why the account [id] in [registry] can't be read; for null, the React Native item no entry has. Null when it can. */
    fun reason(registry: AccountRegistry, id: String?): UnreadableCredentials? =
        if (id == null) shared.takeIf { registry.entries.none { it.location == CredentialLocation.Shared } } else registry.entry(id)?.let(::reason)

    /**
     * The open Happy account in [registry], when it can't be opened; with
     * none open, the React Native item no entry has yet (the first start
     * after the upgrade), unless the person went on past it. Null when
     * nothing is locked.
     */
    fun locked(registry: AccountRegistry): LockedAccount? {
        val open = registry.entry(registry.activeId)
        return when {
            open != null -> reason(open)?.let { LockedAccount(open.id, it) }
            registry.activeId == null && registry.entries.none { it.location == CredentialLocation.Shared } && sharedItem != registry.passedSharedItem ->
                shared?.let { LockedAccount(null, it) }
            else -> null
        }
    }
}

/** An account on this phone that can't be opened: the entry [id], or null for the React Native item no entry has; and [reason]. */
data class LockedAccount(val id: String?, val reason: UnreadableCredentials)

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
 * An item that is there but can't be read ([unreadable]) is never taken for
 * a sign-out: its entry keeps its place, and nothing writes over or clears
 * the shared item but the person removing it; a sign-in meanwhile gets an
 * item of its own.
 *
 * Calls block on storage; the app makes them off the main thread, except
 * the first [reconcile] at start.
 */
class AccountStore(
    private val shared: SecureStoreCredentialStore,
    private val own: ExpoSecureStore,
    private val prefs: SharedPreferences,
    private val defaultServerUrl: String,
    private val importRnServer: () -> ImportedServer,
) {
    private val state = MutableStateFlow(load(prefs))
    val registry: StateFlow<AccountRegistry> = state.asStateFlow()

    private val unreadableState = MutableStateFlow(UnreadableAccounts())

    /** What couldn't be read at the last [reconcile]. */
    val unreadable: StateFlow<UnreadableAccounts> = unreadableState.asStateFlow()

    /** [UnreadableAccounts.locked], now. */
    fun locked(): LockedAccount? = unreadableState.value.locked(state.value)

    /** The first account but [excluding] (the open one) that can be read and used, by added order; null for none. */
    fun readableOther(excluding: String? = state.value.activeId): String? {
        val unreadable = unreadableState.value
        return state.value.ordered.firstOrNull { it.id != excluding && it.serverConfirmed && unreadable.readable(it) }?.id
    }

    /** With the open account [locked], opens [readableOther] in its place; false when there is none. */
    @Synchronized
    fun openReadable(): Boolean {
        if (locked() == null) return false
        val other = readableOther() ?: return false
        select(other)
        return true
    }

    /**
     * Brings the registry in line with the stored credentials: entries
     * without credentials go, credentials without an entry are added (the
     * shared item with the React Native server). Returns every account's
     * credentials by id. An item no read will open isn't read again unless
     * [retry]; with it, a read that throws is tried three times.
     */
    @Synchronized
    fun reconcile(retry: Boolean = false): Map<String, StoredAccountCredentials> {
        val before = unreadableState.value
        val values = HashMap<String, StoredAccountCredentials>()
        val unreadableOwn = HashMap<String, UnreadableCredentials>()
        val unreadableOwnItems = HashMap<String, String>()
        for (key in own.keys()) {
            val item = own.fingerprint(key)
            val stored = before.own[key]?.takeIf { !retry && it.permanent && item != null && item == before.ownItems[key] }?.let { Stored.Unreadable(it) }
                ?: own.load(key, retry, StoredAccountCredentials::credentials) { json.decodeFromString(StoredAccountCredentials.serializer(), it) }
            val value = when (stored) {
                is Stored.Present -> stored.value
                is Stored.Unreadable -> {
                    unreadableOwn[key] = stored.reason
                    item?.let { unreadableOwnItems[key] = it }
                    continue
                }
                Stored.Absent -> continue
            }
            if (accountId(value.credentials) != key || ServerConfig.validate(value.serverUrl) != ServerConfig.Validation.Valid) continue
            values[key] = value
        }
        var current = state.value
        val sharedItem = shared.fingerprint()
        val sharedRead = when {
            // Removed by the person while it couldn't be read: as good as gone.
            sharedItem != null && sharedItem == current.removedSharedItem -> Stored.Absent
            !retry && before.shared?.permanent == true && sharedItem == before.sharedItem -> Stored.Unreadable(before.shared)
            else -> shared.load(retry)
        }
        unreadableState.value = UnreadableAccounts((sharedRead as? Stored.Unreadable)?.reason, sharedItem.takeIf { sharedRead is Stored.Unreadable }, unreadableOwn, unreadableOwnItems)
        val sharedCredentials = sharedRead.presentOrNull()
        val sharedId = sharedCredentials?.let(::accountId)
        // The shared item wins over an own item for the same account.
        if (sharedId != null && values.remove(sharedId) != null) own.deleteItem(sharedId)
        val kept = current.ordered.mapNotNull { entry ->
            when {
                // Its place, server and display stay, wherever it was kept.
                entry.id == sharedId -> entry.copy(location = CredentialLocation.Shared, sharedItem = sharedItem)
                // Unreadable is not signed out: such an entry keeps its place, server and display.
                entry.location == CredentialLocation.Shared -> entry.takeIf { sharedRead is Stored.Unreadable }
                else -> entry.takeIf { it.id in values || it.id in unreadableOwn }
            }
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
                sharedItem = sharedItem.takeIf { id == sharedId },
            )
        }
        val active = current.activeId?.takeIf { id -> kept.any { it.id == id } || !isAccountId(id) }
            ?: kept.minByOrNull { it.addedOrder }?.id
        current = current.copy(
            entries = kept,
            activeId = active,
            // Both are of one sealed item only: another (or none) is read as any other.
            removedSharedItem = current.removedSharedItem?.takeIf { it == sharedItem },
            passedSharedItem = current.passedSharedItem?.takeIf { it == sharedItem },
        )
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
        val unreadable = unreadableState.value
        val sharedItem = shared.fingerprint()
        val sharedRead = when {
            unreadable.shared != null -> Stored.Unreadable(unreadable.shared)
            // Removed by the person: free for this one.
            sharedItem != null && sharedItem == current.removedSharedItem -> Stored.Absent
            else -> shared.load()
        }
        val location = when (sharedRead) {
            // Never written over: it may be the only copy of an account that can't be read just now.
            is Stored.Unreadable -> CredentialLocation.Own
            Stored.Absent -> existing?.location ?: CredentialLocation.Shared
            is Stored.Present -> existing?.location ?: CredentialLocation.Own
        }
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
            sharedItem = if (location == CredentialLocation.Shared) shared.fingerprint() else null,
        )
        // Written: no longer the item that couldn't be read.
        if (location == CredentialLocation.Own) unreadableState.value = unreadable.copy(own = unreadable.own - id, ownItems = unreadable.ownItems - id)
        save(current.copy(
            entries = current.entries.filterNot { it.id == id } + entry,
            activeId = id,
            removedSharedItem = current.removedSharedItem.takeIf { location == CredentialLocation.Own },
            // Gone on past the item that couldn't be read: it no longer stands in for the first screen.
            passedSharedItem = (if (sharedRead is Stored.Unreadable) sharedItem else null) ?: current.passedSharedItem,
        ))
        return id
    }

    /**
     * Signs [id] out on this phone: its credentials and entry go. When it
     * was open, the next account by added order opens, if any. A shared
     * item that can't be read goes if it is the one the entry was read
     * from; any other is never brought back as an account.
     */
    @Synchronized
    fun remove(id: String) {
        val current = state.value
        val entry = current.entry(id) ?: return
        val unreadable = unreadableState.value
        var removedSharedItem = current.removedSharedItem
        when (entry.location) {
            CredentialLocation.Shared -> {
                val item = shared.fingerprint()
                if (unreadable.shared != null && item == unreadable.sharedItem) {
                    if (item != null && item == entry.sharedItem) shared.clear() else removedSharedItem = item
                    unreadableState.value = unreadable.copy(shared = null, sharedItem = null)
                } else if (shared.load().presentOrNull()?.let(::accountId) == id) {
                    shared.clear()
                }
            }
            CredentialLocation.Own -> {
                own.deleteItem(id)
                unreadableState.value = unreadable.copy(own = unreadable.own - id, ownItems = unreadable.ownItems - id)
            }
        }
        val rest = current.entries.filterNot { it.id == id }
        // The next one that can be read, if any.
        val next = rest.filter { unreadableState.value.readable(it) }.ifEmpty { rest }
        val active = if (current.activeId == id) next.minByOrNull { it.addedOrder }?.id else current.activeId
        save(current.copy(entries = rest, activeId = active, removedSharedItem = removedSharedItem))
    }

    /** Deletes the React Native item no entry has, which can't be read ([LockedAccount] with no id); the person asked to. */
    @Synchronized
    fun removeUnreadableShared() {
        val unreadable = unreadableState.value
        if (unreadable.shared == null || state.value.entries.any { it.location == CredentialLocation.Shared }) return
        if (shared.fingerprint() == unreadable.sharedItem) shared.clear()
        unreadableState.value = unreadable.copy(shared = null, sharedItem = null)
    }

    /** Opens [id]: a Happy account here, or an agent connection's id; null opens nothing. */
    @Synchronized
    fun select(id: String?) {
        val current = state.value
        // Gone on past the item that couldn't be read (to an agent connection, say): it no longer stands in for the first screen.
        val passed = unreadableState.value.sharedItem?.takeIf { id != null && current.entries.none { it.location == CredentialLocation.Shared } }
        save(current.copy(activeId = id, passedSharedItem = passed ?: current.passedSharedItem))
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

    private fun save(registry: AccountRegistry) {
        // The Happy account open now is the one open last until another opens.
        val value = if (registry.entry(registry.activeId) != null) registry.copy(lastHappyId = registry.activeId) else registry
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

        /**
         * The agent connection open in [prefs], read as the store would read
         * it, before any store is made ([com.slopus.happy.agent.StartupLink]).
         * Null for a Happy account or none: [reconcile] keeps an agent
         * connection's id as it is, and may change only a Happy account's.
         */
        fun openAgentId(prefs: SharedPreferences): String? = load(prefs).activeId?.takeUnless(::isAccountId)

        private fun load(prefs: SharedPreferences): AccountRegistry = try {
            prefs.getString(KEY, null)?.let { json.decodeFromString(AccountRegistry.serializer(), it) }
                ?.takeIf { registry -> registry.entries.map { it.id }.toSet().size == registry.entries.size && registry.entries.all { isAccountId(it.id) } }
                ?: AccountRegistry()
        } catch (_: Exception) {
            // Rebuilt from the credentials by the next reconcile.
            AccountRegistry()
        }
    }
}
