package com.slopus.happy

import android.content.Context
import com.slopus.happy.accounts.AccountDisplay
import com.slopus.happy.accounts.AccountStore
import com.slopus.happy.accounts.RnServerConfigImporter
import com.slopus.happy.accounts.accountId
import com.slopus.happy.agent.AgentSessions
import com.slopus.happy.auth.AndroidKeyStoreKeys
import com.slopus.happy.auth.AuthCredentials
import com.slopus.happy.auth.CredentialStore
import com.slopus.happy.model.Profile
import java.io.File
import com.slopus.happy.auth.AuthApi
import com.slopus.happy.auth.AuthRepository
import com.slopus.happy.auth.AuthState
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.auth.SecureStoreCredentialStore
import com.slopus.happy.auth.SecureStoreKeys
import com.slopus.happy.config.LocalSettings
import com.slopus.happy.config.ServerConfig
import com.slopus.happy.data.HappyDatabase
import com.slopus.happy.data.HappyStore
import com.slopus.happy.data.LocalCaches
import com.slopus.happy.model.settings.LanguageController
import com.slopus.happy.model.settings.SettingsRepository
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.payments.PreferencesPurchasesCache
import com.slopus.happy.payments.PurchaseAccount
import com.slopus.happy.payments.PurchasesRepository
import com.slopus.happy.payments.RevenueCatPurchases
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.PairingFlow
import com.slopus.happy.connection.TailcatTransport
import com.slopus.happy.sync.AccountSync
import com.slopus.happy.ui.changelog.ChangelogReadMarker
import com.slopus.happy.ui.home.NewSessionDraftStore
import com.slopus.happy.ui.home.PrefsReviewStamps
import com.slopus.happy.voice.ElevenLabsTransport
import com.slopus.happy.voice.StoreVoiceContext
import com.slopus.happy.voice.VoiceApi
import com.slopus.happy.voice.VoiceEngine
import com.slopus.happy.voice.VoiceLanguages
import com.slopus.happy.voice.VoiceOptions
import com.slopus.happy.voice.VoicePaywall
import com.slopus.happy.voice.VoicePreferences
import com.slopus.happy.voice.VoiceTools
import com.slopus.happy.voice.VoiceUpsell
import com.slopus.happy.chat.AgentState
import com.slopus.happy.sync.SendOptions
import com.slopus.happy.sync.SendResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * The app's object graph, built once in [HappyApplication]. Hand-wired: the
 * graph is small enough that a DI framework would cost more than it saves.
 *
 * While signed in it owns one [AccountSync] for the account (delta sync,
 * live updates, presence, history); signing out stops it before local data
 * is cleared.
 */
class AppGraph(
    context: Context,
    private val clientId: String,
    defaultServerUrl: String,
    secureStoreKeys: SecureStoreKeys = AndroidKeyStoreKeys(),
    databaseName: String? = HappyDatabase.NAME,
) {
    private val appContext: Context = context.applicationContext ?: context

    init {
        // Before accounts had databases of their own. Local data resets rather than migrates.
        if (databaseName != null) appContext.deleteDatabase(HappyDatabase.NAME)
        TailcatTransport.persistDerpMap(File(appContext.noBackupFilesDir, "tailcat/derpmap.json"))
    }

    val serverConfig = ServerConfig(
        context.getSharedPreferences(ServerConfig.PREFS_NAME, Context.MODE_PRIVATE),
        defaultServerUrl,
    )
    val localSettings = LocalSettings(context.getSharedPreferences(LocalSettings.PREFS_NAME, Context.MODE_PRIVATE))

    private val okHttp = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    /**
     * The Happy accounts signed in here. The first keeps the React Native
     * app's credential item and server setting, so an upgrade stays signed in.
     */
    val accountStore = AccountStore(
        shared = SecureStoreCredentialStore(
            ExpoSecureStore(
                prefs = context.getSharedPreferences(ExpoSecureStore.PREFS_NAME, Context.MODE_PRIVATE),
                keys = secureStoreKeys,
                defaultPrefs = context.getSharedPreferences("${context.packageName}_preferences", Context.MODE_PRIVATE),
            ),
        ),
        own = ExpoSecureStore(
            prefs = context.getSharedPreferences(AccountStore.CREDENTIALS_PREFS_NAME, Context.MODE_PRIVATE),
            keys = secureStoreKeys,
            keychainService = AccountStore.KEYCHAIN_SERVICE,
        ),
        prefs = context.getSharedPreferences(AccountStore.PREFS_NAME, Context.MODE_PRIVATE),
        defaultServerUrl = defaultServerUrl,
        importRnServer = { RnServerConfigImporter.read(File(appContext.filesDir, "mmkv"), defaultServerUrl) },
    ).also { it.reconcile() }

    /**
     * The server the open Happy account lives on; with none open, the
     * server chosen for signing in. An account added while another is open
     * joins that one's server.
     */
    val serverUrl: String
        get() = accountStore.registry.value.let { registry -> registry.entry(registry.activeId) }
            ?.takeIf { it.serverConfirmed }?.serverUrl ?: serverConfig.url.value

    val http = HappyHttp(okHttp, serverUrl = { serverUrl }, clientId = clientId)
    val authApi = AuthApi(http)

    /** The open Happy account's credentials, as sign-in, sign-out and switching see them. */
    private val openAccountCredentials = object : CredentialStore {
        override fun read(): AuthCredentials? {
            val registry = accountStore.registry.value
            val entry = registry.entry(registry.activeId)?.takeIf { it.serverConfirmed } ?: return null
            return accountStore.credentials(entry.id)?.credentials
        }

        override fun write(credentials: AuthCredentials) {
            accountStore.signIn(credentials, serverUrl)
        }

        override fun clear() {
            accountStore.registry.value.activeId?.let(accountStore::remove)
        }
    }

    val auth = AuthRepository(openAccountCredentials, authApi)

    private val inMemoryDatabases = databaseName == null
    private val databases = HashMap<String, HappyDatabase>()

    /** No account open: nothing to show. */
    private val signedOutDatabase = HappyDatabase(context, null)

    /** Each Happy account has a database of its own; the account's id names it. */
    private fun database(accountId: String?): HappyDatabase = if (accountId == null) signedOutDatabase else synchronized(databases) {
        databases.getOrPut(accountId) { HappyDatabase(appContext, if (inMemoryDatabases) null else "account-$accountId.db") }
    }

    private fun openAccountId(): String? = (auth.state.value as? AuthState.SignedIn)?.let { accountId(it.credentials) }

    val store = HappyStore(database(openAccountId()))

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val purchases = PurchasesRepository(
        scope,
        RevenueCatPurchases(appContext, BuildConfig.REVENUE_CAT_GOOGLE_KEY, BuildConfig.DEBUG),
        PreferencesPurchasesCache(context.getSharedPreferences(PreferencesPurchasesCache.PREFS_NAME, Context.MODE_PRIVATE)),
        currentAccount = { purchaseAccount() },
    )

    /** The account's synced settings; a change is uploaded by the next sync. */
    val settings = SettingsRepository(store, scope, onChanged = ::requestSync)

    /** The UI language (text/index.ts), from the synced preferredLanguage at start. */
    val language = LanguageController(context, context.getSharedPreferences(LanguageController.PREFS_NAME, Context.MODE_PRIVATE))
        .also { it.follow(settings.settings, scope) }

    /** The newest What's New entry the user has seen (changelog/storage.ts). */
    val changelog = ChangelogReadMarker(context.getSharedPreferences(ChangelogReadMarker.PREFS_NAME, Context.MODE_PRIVATE))
    private val accountLock = Mutex()
    private val foreground = MutableStateFlow(false)
    private val accountState = MutableStateFlow<AccountSync?>(null)

    /** The signed-in account's sync, or null when signed out. */
    val account: StateFlow<AccountSync?> = accountState.asStateFlow()

    val voicePreferences = VoicePreferences(context.getSharedPreferences(VoicePreferences.PREFS_NAME, Context.MODE_PRIVATE))

    /** The SDK is allocated only inside connect(), never while constructing the app graph. */
    val voice: VoiceEngine = VoiceEngine(
        scope = scope,
        service = VoiceApi(okHttp, clientId, { serverUrl }, { serverConfig.voiceUrl }, BuildConfig.ELEVENLABS_AGENT_ID),
        transport = ElevenLabsTransport(appContext),
        credentials = { (auth.state.value as? AuthState.SignedIn)?.credentials },
        options = {
            val values = settings.settings.value
            val local = localSettings.values.value
            VoiceOptions(values.voiceBypassToken, values.voiceCustomAgentId,
                VoiceLanguages.elevenLabsCode(values.voiceAssistantLanguage),
                VoiceUpsell.resolve(override = local.voiceUpsellOverride, overrideEnabled = BuildConfig.DEBUG || local.devModeEnabled))
        },
        paywall = object : VoicePaywall {
            override fun hasPro() = purchases.hasPro()
            override suspend fun present(flow: String) = purchases.present(flow).purchased
        },
        preferences = voicePreferences,
        contextFactory = {
            StoreVoiceContext(store, checkNotNull(accountState.value).messages.stored, scope, onSessionDeleted = ::onVoiceSessionDeleted)
        },
        toolsFactory = { isCurrent, onSent ->
            // Capture this call's account, never a later sign-in or whichever session UI is now open.
            val bound = checkNotNull(accountState.value)
            VoiceTools(
                send = { id, message ->
                    check(accountState.value === bound && isCurrent())
                    val result = bound.sender.send(id, message, SendOptions(source = "voice", isCurrent = { accountState.value === bound && isCurrent() }))
                    check(result is SendResult.Accepted) { "Voice message was not queued" }
                },
                permissionOwner = { requestId -> withContext(Dispatchers.IO) {
                    check(accountState.value === bound && isCurrent())
                    store.sessions().firstOrNull { AgentState.parse(it.agentStateJson)?.requests?.containsKey(requestId) == true }?.id
                } },
                decide = { id, requestId, allow ->
                    check(accountState.value === bound && isCurrent())
                    if (allow) bound.sessionOps.allow(id, requestId) else bound.sessionOps.deny(id, requestId)
                },
                sent = onSent,
                isCurrent = { accountState.value === bound && isCurrent() },
            )
        },
    )

    /**
     * Agent connections over Happy Protocol V2: accounts of their own beside
     * the relay account, kept through a relay sign-out.
     */
    val agentConnections = AgentConnections(
        secrets = ExpoSecureStore(
            prefs = context.getSharedPreferences(AgentConnections.SECRETS_PREFS, Context.MODE_PRIVATE),
            keys = secureStoreKeys,
            keychainService = AgentConnections.KEYCHAIN_SERVICE,
        ),
        registry = context.getSharedPreferences(AgentConnections.REGISTRY_PREFS, Context.MODE_PRIVATE),
    )

    /**
     * The open agent connection's id, or null when a Happy account (or
     * nothing) is open. Only one account of either kind is open at a time.
     */
    val openAgentId: StateFlow<String?> = combine(accountStore.registry, agentConnections.accounts) { registry, agents ->
        registry.activeId?.takeIf { id -> agents.any { it.id == id } }
    }.stateIn(scope, SharingStarted.Eagerly, accountStore.registry.value.activeId?.takeIf { id -> agentConnections.accounts.value.any { it.id == id } })

    /**
     * Opens the account [id] from Home's account menu: a Happy account or
     * an agent connection. Whatever was open stays signed in.
     */
    fun open(id: String): Job = scope.launch {
        if (accountStore.registry.value.activeId == id && (openAgentId.value == id || openAccountId() == id)) return@launch
        withContext(Dispatchers.IO) { accountStore.select(id) }
        auth.reload()
    }

    private val agentPairingState = MutableStateFlow<PairingFlow?>(null)

    /** The pairing on screen, if any. In memory only: its code is a secret. */
    val agentPairing: StateFlow<PairingFlow?> = agentPairingState.asStateFlow()

    /** Starts connecting the agent behind a `happy://direct?` code, replacing any unfinished pairing. */
    fun startAgentPairing(code: String) {
        agentPairingState.value?.close()
        agentPairingState.value = PairingFlow(scope, agentConnections, deviceName).also { it.start(code) }
    }

    /** The pairing screen left. */
    fun endAgentPairing(flow: PairingFlow) {
        flow.close()
        agentPairingState.compareAndSet(flow, null)
    }

    /** What the agent lists this phone as: the name the person gave it, else the model. */
    private val deviceName: String =
        android.provider.Settings.Global.getString(appContext.contentResolver, "device_name")?.takeIf { it.isNotBlank() }
            ?: android.os.Build.MODEL.orEmpty()

    /** The updates socket's state; disconnected when signed out. */
    @OptIn(ExperimentalCoroutinesApi::class)
    val connectionStatus: StateFlow<ConnectionStatus> = accountState
        .flatMapLatest { it?.connectionStatus ?: flowOf(ConnectionStatus.DISCONNECTED) }
        .stateIn(scope, SharingStarted.Eagerly, ConnectionStatus.DISCONNECTED)

    /** The open relay account is catching up its stored state. */
    @OptIn(ExperimentalCoroutinesApi::class)
    val isSyncing: StateFlow<Boolean> = accountState
        .flatMapLatest { it?.isSyncing ?: flowOf(false) }
        .stateIn(scope, SharingStarted.Eagerly, false)

    init {
        scope.launch {
            combine(auth.state, serverConfig.url, accountStore.registry) { _, _, _ -> purchaseAccount() }.collect(purchases::setAccount)
        }
        scope.launch {
            foreground.collect { if (it) purchases.refresh() }
        }
        scope.launch {
            auth.state.collect { state -> accountLock.withLock { openAccount(state) } }
        }
        scope.launch(Dispatchers.IO) {
            // The open account's profile names it in the account switcher.
            store.changes.collect {
                val id = openAccountId() ?: return@collect
                accountStore.updateDisplay(id, AccountDisplay.of(Profile.parse(store.profile())))
            }
        }
    }

    private fun purchaseAccount(): PurchaseAccount? = (auth.state.value as? AuthState.SignedIn)?.publicId
        ?.takeIf { it.isNotBlank() }?.let { PurchaseAccount(serverUrl, it) }

    /** Ask for a delta sync now (sign-in, app back in the foreground). No-op when signed out. */
    fun requestSync() {
        accountState.value?.requestSync()
    }

    /** Whether the app is in the foreground (MainActivity started). */
    val isForeground: StateFlow<Boolean> = foreground.asStateFlow()

    /** The app came to the foreground or left it (MainActivity onStart/onStop). */
    fun setForeground(value: Boolean) {
        foreground.value = value
    }

    /** Each agent connection's live link and cached home (AgentSessions). */
    val agentSessions = AgentSessions(
        connections = agentConnections,
        scope = scope,
        cacheDir = File(appContext.noBackupFilesDir, "agent-connections"),
        openId = openAgentId,
        foreground = isForeground,
    )

    private val logoutHooks = CopyOnWriteArrayList<suspend (authToken: String) -> Unit>()

    /**
     * [hook] runs first on every logout, while the account's token still
     * works (AuthContext.tsx unregisters the push token there). It must be
     * bounded and must not throw.
     */
    fun beforeLogout(hook: suspend (authToken: String) -> Unit) {
        logoutHooks += hook
    }

    /**
     * Settings > Account > Logout: credentials, local data and device
     * preferences go; the server choice stays. Runs in the app scope, since
     * the screen that asked is gone as soon as the account is.
     */
    fun logout(): Job = scope.launch {
        accountLock.withLock {
            voice.stop()
            val leaving = auth.state.value as? AuthState.SignedIn
            leaving?.let { signedIn -> logoutHooks.forEach { it(signedIn.credentials.token) } }
            purchases.setAccount(null)
            stopAccount()
            val last = accountStore.registry.value.entries.size <= 1
            withContext(Dispatchers.IO) {
                store.clearAll()
                // persistence.ts clearPersistence: with the last account, everything in the default MMKV goes; the server choice stays.
                if (last) {
                    localSettings.clear()
                    changelog.clear()
                    for (name in WIPED_PREFS) appContext.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
                    LocalCaches.wipe(appContext)
                }
            }
            if (last) wipeHooks.forEach { it() }
            auth.logout()
            store.use(database(openAccountId()))
            withContext(Dispatchers.IO) { leaving?.let { forgetDatabase(accountId(it.credentials)) } }
        }
    }

    /** The account's database goes with its sign-out, once the store has moved off it. */
    private fun forgetDatabase(id: String?) {
        id ?: return
        val database = synchronized(databases) { databases.remove(id) } ?: return
        store.retire(database)
        if (!inMemoryDatabases) appContext.deleteDatabase("account-$id.db")
    }

    private val wipeHooks = CopyOnWriteArrayList<() -> Unit>()

    /**
     * [hook] runs on logout once the stored data is gone, for in-memory
     * state that mirrors it (the new-session draft). It must not throw.
     */
    fun afterLogoutWipe(hook: () -> Unit) {
        wipeHooks += hook
    }

    private suspend fun openAccount(state: AuthState) {
        stopAccount()
        store.use(database((state as? AuthState.SignedIn)?.let { accountId(it.credentials) }))
        if (state !is AuthState.SignedIn) return
        val account = AccountSync(
            http = http,
            okHttp = okHttp,
            serverUrl = { serverUrl },
            clientId = clientId,
            token = state.credentials.token,
            encryption = state.encryption,
            store = store,
            parent = scope.coroutineContext[Job]!!,
            foreground = foreground,
        )
        accountState.value = account
        account.start()
    }

    private suspend fun stopAccount() {
        voice.stop()
        val account = accountState.value ?: return
        accountState.value = null
        account.stop()
    }

    private fun onVoiceSessionDeleted(id: String) {
        if (voice.state.value.sessionId == id) scope.launch { voice.stop() }
    }
}

/**
 * Preferences that hold this account's data or choices and go with it on
 * logout (happy-app keeps them in the default MMKV, which clearPersistence
 * empties). The server choice, the secure store (cleared by [AuthRepository])
 * and the push token store (cleared by its own logout hook) are not here.
 */
private val WIPED_PREFS = listOf(NewSessionDraftStore.PREFS_NAME, PrefsReviewStamps.PREFS_NAME, VoicePreferences.PREFS_NAME)
