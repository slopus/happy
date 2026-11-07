package com.slopus.happy

import android.content.Context
import androidx.core.app.NotificationManagerCompat
import com.slopus.happy.accounts.AccountDisplay
import com.slopus.happy.accounts.AccountRemovals
import com.slopus.happy.accounts.AccountStore
import com.slopus.happy.accounts.RnServerConfigImporter
import com.slopus.happy.accounts.accountId
import com.slopus.happy.call.CallController
import com.slopus.happy.agent.AgentSessions
import com.slopus.happy.analytics.Analytics
import com.slopus.happy.analytics.AnalyticsAgent
import com.slopus.happy.analytics.AnalyticsBuild
import com.slopus.happy.analytics.AnalyticsEvent
import com.slopus.happy.analytics.AnalyticsReasons
import com.slopus.happy.analytics.AnalyticsSwitch
import com.slopus.happy.analytics.AnalyticsTarget
import com.slopus.happy.analytics.accountsOptedOut
import com.slopus.happy.analytics.Bucket
import com.slopus.happy.analytics.ConnectionIncidents
import com.slopus.happy.analytics.LinkTransport
import com.slopus.happy.analytics.Notifications
import com.slopus.happy.connection.PairingStart
import com.slopus.happy.agent.CompletionChime
import com.slopus.happy.auth.AndroidKeyStoreKeys
import com.slopus.happy.auth.AuthCredentials
import com.slopus.happy.auth.CredentialStore
import com.slopus.happy.model.Profile
import com.slopus.happy.model.Settings
import java.io.File
import com.slopus.happy.auth.AuthApi
import com.slopus.happy.auth.AuthRepository
import com.slopus.happy.auth.AuthState
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.auth.SecureStoreCredentialStore
import com.slopus.happy.auth.SecureStoreKeys
import com.slopus.happy.auth.tokenSubject
import com.slopus.happy.config.FeatureFlags
import com.slopus.happy.config.LiveAvatarsSetting
import com.slopus.happy.config.LocalSettings
import com.slopus.happy.config.ServerConfig
import com.slopus.happy.data.HappyDatabase
import com.slopus.happy.data.HappyStore
import com.slopus.happy.data.LocalCaches
import com.slopus.happy.model.settings.LanguageController
import com.slopus.happy.model.settings.SettingsRepository
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.payments.PlayBilling
import com.slopus.happy.payments.RevenueCatApi
import com.slopus.happy.payments.CallIntro
import com.slopus.happy.payments.Offers
import com.slopus.happy.payments.Subscription
import com.slopus.happy.call.PreferencesCallUsageStore
import com.slopus.happy.push.PushApi
import com.slopus.happy.push.PushUnregisterQueue
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.PairingFlow
import com.slopus.happy.connection.ServerAuthClient
import com.slopus.happy.connection.ServerSignInFlow
import com.slopus.happy.connection.CloudAccount
import com.slopus.happy.connection.HappyCloud
import com.slopus.happy.connection.TailcatTransport
import com.slopus.happy.connection.networkPath
import com.slopus.happy.sync.AccountSync
import com.slopus.happy.sync.SessionFileCache
import com.slopus.happy.ui.changelog.ChangelogReadMarker
import com.slopus.happy.ui.home.HomeServices
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
import com.slopus.happy.voice.VoiceStatus
import com.slopus.happy.voice.VoiceUpsell
import com.slopus.happy.chat.AgentState
import com.slopus.happy.sync.SendOptions
import com.slopus.happy.sync.SendResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.joinAll
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
    secureStoreKeys: SecureStoreKeys = AndroidKeyStoreKeys(strongBox = AndroidKeyStoreKeys.hasStrongBox(context)),
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

    /** Animated Avatars, kept on this phone for every account (not cleared with local settings). */
    val liveAvatars = LiveAvatarsSetting(context.getSharedPreferences(LiveAvatarsSetting.PREFS_NAME, Context.MODE_PRIVATE))

    /** Where Happy account [publicId] keeps its attachments for good, a folder of its own (no backup: the server has them); gone with its sign-out. */
    fun legacyMediaDirectory(publicId: String?): File? =
        publicId?.filter { it.isLetterOrDigit() || it == '-' || it == '_' }?.takeIf { it.isNotEmpty() }?.let { File(appContext.noBackupFilesDir, "legacy-media/$it") }

    /** Data and Storage's Automatic Media Download, kept on this phone for every account. */
    val mediaAutoDownload = com.slopus.happy.media.MediaAutoDownloadSetting(context.getSharedPreferences(com.slopus.happy.media.MediaAutoDownloadSetting.PREFS_NAME, Context.MODE_PRIVATE))

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

    private val removals = AccountRemovals(context.getSharedPreferences(AccountRemovals.PREFS_NAME, Context.MODE_PRIVATE))

    /** A sign-out an earlier run didn't finish took the last account: the language goes back to the device's once it can. */
    private val wipedAtStart = finishInterruptedRemovals(databaseName != null)

    /**
     * Sign-outs the process didn't live to finish ([AccountRemovals]): the
     * account's credentials, database and kept file reads go now, before anything reads
     * them, and with the last account this phone's preferences too. True
     * when that took the last account.
     */
    private fun finishInterruptedRemovals(onDisk: Boolean): Boolean {
        val pending = removals.pending()
        if (pending.isEmpty()) return false
        for (id in pending) {
            val publicId = accountStore.credentials(id)?.credentials?.token?.let(::tokenSubject)
            accountStore.remove(id)
            if (onDisk) {
                appContext.deleteDatabase("account-$id.db")
                SessionFileCache.directory(appContext.noBackupFilesDir, id).deleteRecursively()
                if (!hasMediaOwner(publicId)) legacyMediaDirectory(publicId)?.deleteRecursively()
            }
            removals.finish(id)
        }
        if (accountStore.registry.value.entries.isNotEmpty() || accountStore.registry.value.activeId != null) return false
        localSettings.clear()
        for (name in WIPED_PREFS + ChangelogReadMarker.PREFS_NAME) appContext.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
        LocalCaches.wipe(appContext)
        return true
    }

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

    /** The account's synced settings; a change is uploaded by the next sync. */
    val settings = SettingsRepository(store, scope, onChanged = ::requestSync)

    /** The UI language (text/index.ts), from the synced preferredLanguage at start. */
    val language = LanguageController(context, context.getSharedPreferences(LanguageController.PREFS_NAME, Context.MODE_PRIVATE))
        .also { if (wipedAtStart) it.apply(null) }
        .also { it.follow(settings.settings, scope) }

    /** The newest What's New entry the user has seen (changelog/storage.ts). */
    val changelog = ChangelogReadMarker(context.getSharedPreferences(ChangelogReadMarker.PREFS_NAME, Context.MODE_PRIVATE))
    /** The Happy CLI home's migration cards closed on this phone (iOS ea1a0902f). */
    val desktopMigration = com.slopus.happy.ui.migration.DesktopMigrationCards(
        context.getSharedPreferences(com.slopus.happy.ui.migration.DesktopMigrationCards.PREFS_NAME, Context.MODE_PRIVATE),
    )
    /** Where this build sends analytics ([AnalyticsTarget]), or nowhere: never a test or an instrumented run. */
    private val analyticsTarget = AnalyticsTarget.of(
        appContext,
        AnalyticsBuild(debug = BuildConfig.DEBUG, buildType = BuildConfig.BUILD_TYPE, postHogKey = BuildConfig.POSTHOG_KEY, version = BuildConfig.VERSION_NAME),
    )
    /** PostHog's flags for this install, as analytics last heard them; none in a build that doesn't ask. */
    val featureFlags = FeatureFlags()
    /** This phone's own analytics switch, apart from each Happy account's (Settings › Data and Storage). */
    val analyticsSwitch = AnalyticsSwitch(context.getSharedPreferences(AnalyticsSwitch.PREFS_NAME, Context.MODE_PRIVATE))

    /** Every Happy account here, the open one as it is now ([accountsOptedOut]). */
    private fun analyticsOptOuts(): Flow<Boolean> = accountsOptedOut(
        ids = accountStore.registry.map { registry -> registry.entries.map { it.id } },
        open = settings.document.map(Settings::analyticsOptOut),
        changes = store.changes,
        optedOut = { id -> Settings.analyticsOptOut(HappyStore(database(id)).effectiveSettingsOrThrow()) },
    )
    private val accountLock = Mutex()
    /** Selection and removal publish atomically without waiting for another account's sync startup. */
    private val accountSelectionLock = Mutex()
    private val foreground = MutableStateFlow(false)
    private val accountState = MutableStateFlow<AccountSync?>(null)

    /** The signed-in account's sync, or null when signed out. */
    val account: StateFlow<AccountSync?> = accountState.asStateFlow()

    val voicePreferences = VoicePreferences(context.getSharedPreferences(VoicePreferences.PREFS_NAME, Context.MODE_PRIVATE))

    /**
     * The relay sessions' voice. Switched off: a Happy session's chat shows
     * no voice button and nothing reaches ElevenLabs. Agent connections call
     * through [calls]. The SDK is allocated only inside connect(), never
     * while constructing the app graph.
     */
    val voice: VoiceEngine = VoiceEngine(
        scope = scope,
        enabled = false,
        foreground = foreground,
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
            override fun hasPro() = subscription.hasPro()
            override suspend fun present(flow: String) = offers.relayVoice(flow)
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
    /** Team server sign-in and token refresh (edge SSO): discovery, code exchange, refresh; never follows a redirect. */
    val serverAuth = ServerAuthClient(okHttp)

    val agentConnections = AgentConnections(
        serverAuth = serverAuth,
        secrets = ExpoSecureStore(
            prefs = context.getSharedPreferences(AgentConnections.SECRETS_PREFS, Context.MODE_PRIVATE),
            keys = secureStoreKeys,
            keychainService = AgentConnections.KEYCHAIN_SERVICE,
        ),
        registry = context.getSharedPreferences(AgentConnections.REGISTRY_PREFS, Context.MODE_PRIVATE),
        pictures = File(context.filesDir, "agent-avatars"),
    )

    /** The Happy Cloud account, where the build offers it: signed in once, then its servers are picked, created or joined. */
    val cloudAccount: CloudAccount? = HappyCloud.accounts?.let { origin ->
        CloudAccount(
            scope = scope,
            origin = origin,
            auth = serverAuth,
            http = okHttp,
        )
    }

    /**
     * The open agent connection's id, or null when a Happy account (or
     * nothing) is open. Only one account of either kind is open at a time.
     */
    val openAgentId: StateFlow<String?> = combine(accountStore.registry, agentConnections.accounts) { registry, agents ->
        registry.activeId?.takeIf { id -> agents.any { it.id == id } }
    }.stateIn(scope, SharingStarted.Eagerly, accountStore.registry.value.activeId?.takeIf { id -> agentConnections.accounts.value.any { it.id == id } })

    /** Guards [switching] and [openState]: a switch's start and the state it hides change together. */
    private val openLock = Any()

    /** Switches under way ([whileSwitching]); while there are any, [openAccount] holds still. */
    private var switching = 0

    private val openState = MutableStateFlow(computeOpenAccount())

    /**
     * The account the screens are of: the open agent connection, else the
     * signed-in Happy account, else none. One switch is one change of it,
     * published once the new account is read whole ([whileSwitching]): never
     * the moment between leaving an agent connection and the Happy account's
     * sign-in being read, which is "none" and would show the first screen.
     */
    val openAccount: StateFlow<OpenAccount> = openState.asStateFlow()

    private fun computeOpenAccount(): OpenAccount {
        val active = accountStore.registry.value.activeId
        if (active != null && agentConnections.accounts.value.any { it.id == active }) return OpenAccount.Agent(active)
        return openAccountId()?.let { OpenAccount.Happy(it) } ?: OpenAccount.None
    }

    private fun publishOpenAccount() = synchronized(openLock) {
        if (switching == 0) openState.value = computeOpenAccount()
    }

    init {
        // Changes made outside a switch (sign-in, logout, an agent paired or forgotten) show as they come.
        scope.launch {
            combine(accountStore.registry, agentConnections.accounts, auth.state) { _, _, _ -> }.collect { publishOpenAccount() }
        }
    }

    /** Runs [block], a switch from one open account to another, as one change of [openAccount]. */
    suspend fun <T> whileSwitching(block: suspend () -> T): T {
        synchronized(openLock) { switching++ }
        try {
            return block()
        } finally {
            synchronized(openLock) { switching-- }
            publishOpenAccount()
        }
    }

    /**
     * Opens the account [id] from Home's account menu: a Happy account or
     * an agent connection. Whatever was open stays signed in.
     */
    fun open(id: String): Job = scope.launch {
        if (accountStore.registry.value.activeId == id && (openAgentId.value == id || openAccountId() == id)) return@launch
        whileSwitching {
            accountSelectionLock.withLock {
                // A row tapped just before its removal must not reopen the forgotten account.
                if (accountStore.registry.value.entry(id) == null && agentConnections.accounts.value.none { it.id == id }) return@withLock
                withContext(Dispatchers.IO) { accountStore.select(id) }
                auth.reload()
            }
        }
    }

    private val agentPairingState = MutableStateFlow<PairingFlow?>(null)

    /** The pairing on screen, if any. In memory only: its code is a secret. */
    val agentPairing: StateFlow<PairingFlow?> = agentPairingState.asStateFlow()

    /** Starts connecting the agent behind a `happy://direct?` code, replacing any unfinished pairing. */
    fun startAgentPairing(code: String, start: PairingStart) {
        agentPairingState.value?.close()
        agentPairingState.value = PairingFlow(scope, agentConnections, deviceName, start).also { it.start(code) }
    }

    /** The pairing screen left. */
    fun endAgentPairing(flow: PairingFlow) {
        flow.close()
        agentPairingState.compareAndSet(flow, null)
    }

    private val serverSignInState = MutableStateFlow<ServerSignInFlow?>(null)

    /** The team server sign-in on screen, if any. In memory only: its PKCE verifier is a secret. */
    val serverSignIn: StateFlow<ServerSignInFlow?> = serverSignInState.asStateFlow()

    /**
     * Starts signing in to the team server at [address] (a scanned code's),
     * or signing [replacing] in again; replaces any unfinished one. It is
     * kept only as [instanceId]'s installation: the code's, or the one
     * [replacing] was.
     */
    fun startServerSignIn(address: String, replacing: String? = null, instanceId: String? = null, cloudId: String? = null) {
        serverSignInState.value?.close()
        val existing = agentConnections.accounts.value.firstOrNull { it.id == replacing }
        val onboarding = existing?.takeIf { it.profileRequired }?.server
        // A Happy Cloud server with the account signed in: its token comes from the account, no browser.
        val cloud = cloudAccount?.takeIf { HappyCloud.isServer(address) && it.signedIn() }
        // Another member signing in again on [replacing]: their own connection takes its place, and opens.
        serverSignInState.value = ServerSignInFlow(scope, agentConnections, serverAuth, replacing, instanceId ?: existing?.instanceId, onReplaced = { open(it) })
            .also { flow ->
                when {
                    onboarding != null -> flow.onboard(onboarding)
                    cloud != null -> flow.startWith(address) { origin -> cloud.serverToken(origin, cloudId) }
                    else -> flow.start(address)
                }
            }
    }

    /** The sign-in screen left. */
    fun endServerSignIn(flow: ServerSignInFlow) {
        flow.close()
        serverSignInState.compareAndSet(flow, null)
    }

    /** The browser came back to [ServerSignInFlow.REDIRECT_URI] (MainActivity). */
    fun oauthCallback(uri: String) {
        // Any app can send the redirect URI: nothing it holds takes the app down.
        try {
            serverSignInState.value?.callback(uri)
            cloudAccount?.callback(uri)
        } catch (e: RuntimeException) {
            // Only the kind: the callback may carry a code.
            android.util.Log.w("ServerSignIn", "Ignored a callback that couldn't be read: ${e.javaClass.simpleName}")
        }
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

    /**
     * The Happy CLI home's migration card may show: a Happy account is open
     * and PostHog's flag is on for this install, which analytics asks only
     * while it is on.
     */
    val migrationNote: StateFlow<Boolean> = combine(accountState, featureFlags.on) { account, on ->
        account != null && FeatureFlags.DIRECT_CONNECTION_MIGRATION_NOTE in on
    }.stateIn(scope, SharingStarted.Eagerly, false)

    /** The open relay account is catching up its stored state. */
    @OptIn(ExperimentalCoroutinesApi::class)
    val isSyncing: StateFlow<Boolean> = accountState
        .flatMapLatest { it?.isSyncing ?: flowOf(false) }
        .stateIn(scope, SharingStarted.Eagerly, false)

    /**
     * The app's one subscription, RevenueCat's `pro` through Play and
     * RevenueCat's REST API, this install's whatever account is signed in.
     * Without the build's RevenueCat key it offers nothing; the preview app's grants it, with no store.
     */
    val subscription: Subscription by lazy {
        val key = BuildConfig.REVENUE_CAT_GOOGLE_KEY
        val granted = Subscription.grantsPro(BuildConfig.BUILD_TYPE)
        val sells = key.isNotBlank() && !granted
        Subscription(
            scope,
            store = PlayBilling(appContext).takeIf { sells },
            revenueCat = RevenueCatApi(okHttp, key).takeIf { sells },
            preferences = appContext.getSharedPreferences(Subscription.PREFS_NAME, Context.MODE_PRIVATE),
            grantsPro = granted,
        )
    }

    /** The app's offer sheets, one at a time, for everything that sells the [subscription]. */
    val offers: Offers by lazy {
        Offers(scope, subscription, CallIntro(appContext.getSharedPreferences(PreferencesCallUsageStore.PREFS_NAME, Context.MODE_PRIVATE)))
    }

    init {
        scope.launch {
            foreground.collect { if (it) subscription.refresh() }
        }
        scope.launch(Dispatchers.IO) {
            // Older builds kept each account's flags here; they are asked per install now, and kept in memory.
            appContext.deleteSharedPreferences(FeatureFlags.RETIRED_PREFS_NAME)
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

    /** Ask for a delta sync now (sign-in, app back in the foreground). No-op when signed out. */
    fun requestSync() {
        accountState.value?.requestSync()
    }

    /** Whether the app is in the foreground (one of its activities started). */
    val isForeground: StateFlow<Boolean> = foreground.asStateFlow()
    private var started = 0

    /**
     * One of the app's activities started or stopped (MainActivity, the QR
     * scanner). Going from one to the other, the next starts before the last
     * stops, so the app stays in the foreground throughout. Main thread.
     */
    fun setForeground(value: Boolean) {
        started = (started + if (value) 1 else -1).coerceAtLeast(0)
        foreground.value = started > 0
    }

    /** Each agent connection's live link and cached home (AgentSessions). */
    val agentSessions = AgentSessions(
        connections = agentConnections,
        scope = scope,
        cacheDir = File(appContext.noBackupFilesDir, "agent-connections"),
        stagedFiles = File(appContext.cacheDir, com.slopus.happy.conversation.MediaFiles.DIRECTORY),
        openId = openAgentId,
        foreground = isForeground,
        network = appContext.networkPath(),
        chime = CompletionChime(appContext)::play,
    )

    init {
        analyticsTarget?.let(::startAnalytics)
    }

    /**
     * Analytics, in a build that sends: kept and sent only while this
     * phone's switch is on and no account here opted out; until they are
     * read nothing is kept.
     */
    @OptIn(ExperimentalCoroutinesApi::class)
    private fun startAnalytics(target: AnalyticsTarget) {
        val link = openAccount.flatMapLatest<OpenAccount, ConnectionIncidents.Link?> { open ->
            when (open) {
                is OpenAccount.Agent -> agentSessions.session(open.id)?.let { session ->
                    val transport = if (agentConnections.accounts.value.firstOrNull { it.id == open.id }?.server != null) LinkTransport.Remote else LinkTransport.Direct
                    session.status.map { ConnectionIncidents.Link(open.key, transport, AnalyticsReasons.link(it)) }
                } ?: flowOf(null)
                is OpenAccount.Happy -> connectionStatus.map { ConnectionIncidents.Link(open.key, LinkTransport.Relay, AnalyticsReasons.link(it)) }
                OpenAccount.None -> flowOf(null)
            }
        }
        Analytics.start(
            context = appContext,
            target = target,
            switch = analyticsSwitch,
            accountsOptedOut = analyticsOptOuts(),
            scope = scope,
            http = okHttp,
            foreground = isForeground,
            agent = ::analyticsAgent,
            configuration = ::analyticsConfiguration,
            links = link,
            network = appContext.networkPath(),
            flags = featureFlags::set,
        )
    }

    /** The open account's side of every event: where its agent is, and which Happy Agent. */
    private fun analyticsAgent(): AnalyticsAgent = when (val open = openAccount.value) {
        is OpenAccount.Agent -> AnalyticsAgent(
            location = "remote",
            version = agentConnections.accounts.value.firstOrNull { it.id == open.id }?.daemonVersion,
        )
        is OpenAccount.Happy -> AnalyticsAgent(location = "relay")
        OpenAccount.None -> AnalyticsAgent()
    }

    /** `app_opened`'s configuration, as it is when the app opens. */
    private fun analyticsConfiguration() = AnalyticsEvent.AppOpened.Configuration(
        notifications = if (NotificationManagerCompat.from(appContext).areNotificationsEnabled()) Notifications.Granted else Notifications.Denied,
        agentsConnected = Bucket.of(agentConnections.accounts.value.size),
    )

    /**
     * The agent connection's voice call, apart from the relay's [voice]:
     * made the first time home's voice button or the bar asks for it.
     */
    val calls: CallController by lazy {
        CallController(
            appContext,
            agentSessions,
            foreground = isForeground,
            openAccount = openAccount.map { (it as? OpenAccount.Agent)?.id },
            relayVoiceActive = voice.state.map { it.status != VoiceStatus.Disconnected },
            stopRelayVoice = voice::stop,
            subscription = subscription,
            offers = offers,
        )
    }



    /**
     * Starts reading the open account's home from disk: the agent
     * connection's kept catalog, or the Happy account's stored sessions.
     * The app graph's thread calls it as soon as the graph is built, while
     * the window is still composing; home asks for the same once composed,
     * 100 to 150 ms later on the Fold, and finds it read or on its way.
     */
    fun warmHome() {
        when (val open = openAccount.value) {
            is OpenAccount.Agent -> agentSessions.session(open.id)
            is OpenAccount.Happy -> HomeServices.of(this)
            OpenAccount.None -> Unit
        }
    }

    private val logoutHooks = CopyOnWriteArrayList<suspend (authToken: String, serverUrl: String) -> Unit>()
    private val accountRemovalHooks = CopyOnWriteArrayList<suspend (authToken: String, serverUrl: String, open: Boolean) -> Unit>()

    /**
     * [hook] runs first on every logout, on IO, with the account's token and
     * server (AuthContext.tsx unregisters the push token there). The screens
     * wait for it, so it only hands work on; it must not throw.
     */
    fun beforeLogout(hook: suspend (authToken: String, serverUrl: String) -> Unit) {
        logoutHooks += hook
    }

    /** Every CLI account removal, including a row that isn't open; only an open one forgets this phone's current push registration. */
    fun beforeAccountRemoval(hook: suspend (authToken: String, serverUrl: String, open: Boolean) -> Unit) {
        accountRemovalHooks += hook
    }

    /** Signed-out accounts' push tokens, still to be dropped on their servers (iOS c7d74a4e8). */
    val pushUnregisters = PushUnregisterQueue(
        items = ExpoSecureStore(
            prefs = context.getSharedPreferences(PushUnregisterQueue.PREFS_NAME, Context.MODE_PRIVATE),
            keys = secureStoreKeys,
            keychainService = PushUnregisterQueue.KEYCHAIN_SERVICE,
        ),
        scope = scope,
        unregister = { removal -> PushApi(HappyHttp(okHttp, { removal.serverUrl }, clientId)).unregisterOnce(removal.authToken, removal.pushToken) },
    )

    /**
     * Settings > Account > Logout, as iOS's c7d74a4e8 signs out: the
     * account leaves the list and the next one (or the first screen) opens
     * as soon as its sync has stopped; the job completes then. Its push
     * token's removal is queued ([pushUnregisters]), and its database goes
     * behind the screens. Written to [removals] first, so a kill from there
     * on is finished at the next start. With the last account this phone's
     * preferences and caches go too; the server choice stays. Runs in the
     * app scope, since the screen that asked is gone as soon as the account is.
     * [accountIdToRemove] targets an accounts-card row; an inactive row leaves
     * the open account, its sync and this phone's preferences in place.
     */
    fun logout(accountIdToRemove: String? = null): Job = scope.launch {
        accountSelectionLock.withLock {
            accountLock.withLock accountRemoval@ {
                val leaving = auth.state.value as? AuthState.SignedIn
                val id = leaving?.let { accountId(it.credentials) }
                if (accountIdToRemove != null && accountIdToRemove != id) {
                    removeInactiveAccount(accountIdToRemove)
                    return@accountRemoval
                }
                val server = serverUrl
                val last = accountStore.registry.value.entries.size <= 1
                withContext(Dispatchers.IO) {
                    id?.let(removals::begin)
                    leaving?.let { signedIn ->
                        accountRemovalHooks.forEach { it(signedIn.credentials.token, server, true) }
                        logoutHooks.forEach { it(signedIn.credentials.token, server) }
                    }
                }
                stopAccount()
                auth.logout()
                store.use(database(openAccountId()))
                if (last) {
                    // After the store moved off the account, so nothing that follows it writes these again.
                    withContext(Dispatchers.IO) {
                        // persistence.ts clearPersistence: with the last account, everything in the default MMKV goes.
                        localSettings.clear()
                        changelog.clear()
                        for (name in WIPED_PREFS) appContext.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
                    }
                    wipeHooks.forEach { it() }
                    // The language was the account's setting: back to the device's, as after happy-app's reload.
                    language.apply(null)
                }
                if (id != null) forget(id, leaving.publicId, synchronized(databases) { databases.remove(id) }, wipeCaches = last)
            }
        }
    }

    /** Under [accountLock], removes only [id]'s kept state: the selected account and its sync keep running. */
    private suspend fun removeInactiveAccount(id: String) {
        val entry = accountStore.registry.value.entry(id) ?: return
        val publicId = withContext(Dispatchers.IO) {
            val stored = accountStore.credentials(id)
            removals.begin(id)
            if (entry.serverConfirmed && stored != null) {
                accountRemovalHooks.forEach { it(stored.credentials.token, stored.serverUrl, false) }
            }
            accountStore.remove(id)
            stored?.credentials?.token?.let(::tokenSubject)
        }
        forget(id, publicId, synchronized(databases) { databases.remove(id) }, wipeCaches = false)
    }

    private val removalJobs = CopyOnWriteArrayList<Job>()

    /** The legacy media folder is keyed by the server's public id; another server can issue the same id. */
    private fun hasMediaOwner(publicId: String?): Boolean = publicId != null && accountStore.registry.value.entries.any { entry ->
        accountStore.credentials(entry.id)?.credentials?.token?.let(::tokenSubject) == publicId
    }

    /** What is slow in a sign-out, once the store has moved off [database]: the file, its kept media and file reads, the caches with the last account. */
    private fun forget(id: String, publicId: String?, database: HappyDatabase?, wipeCaches: Boolean) {
        val job = scope.launch(Dispatchers.IO) {
            database?.let(store::retire)
            if (!inMemoryDatabases) appContext.deleteDatabase("account-$id.db")
            if (!hasMediaOwner(publicId)) legacyMediaDirectory(publicId)?.deleteRecursively()
            // The file viewer's kept reads go with the account (its cache closed with its sync).
            SessionFileCache.directory(appContext.noBackupFilesDir, id).deleteRecursively()
            if (wipeCaches) LocalCaches.wipe(appContext)
            removals.finish(id)
        }
        removalJobs += job
        job.invokeOnCompletion { removalJobs -= job }
    }

    /** Every sign-out's work behind the screens, done. */
    suspend fun awaitRemovals() {
        removalJobs.toList().joinAll()
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
        val fileCache = accountId(state.credentials)?.let { SessionFileCache.directory(appContext.noBackupFilesDir, it) }
        fileCache?.let { withContext(Dispatchers.IO) { it.mkdirs() } }
        val account = AccountSync(
            fileCacheDirectory = fileCache,
            http = http,
            okHttp = okHttp,
            serverUrl = { serverUrl },
            clientId = clientId,
            token = state.credentials.token,
            encryption = state.encryption,
            store = store,
            parent = scope.coroutineContext[Job]!!,
            foreground = foreground,
            network = appContext.networkPath(),
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

/** Which account the screens are of ([AppGraph.openAccount]). */
sealed interface OpenAccount {
    /** The account's or agent connection's id; null for none. */
    val id: String?

    /** What tells one apart from another across a recreation: its kind and id. */
    val key: String

    data object None : OpenAccount {
        override val id: String? get() = null
        override val key: String get() = "none"
    }

    data class Happy(override val id: String) : OpenAccount {
        override val key: String get() = "happy:$id"
    }

    data class Agent(override val id: String) : OpenAccount {
        override val key: String get() = "agent:$id"
    }
}

/**
 * Preferences that hold this account's data or choices and go with it on
 * logout (happy-app keeps them in the default MMKV, which clearPersistence
 * empties). The server choice, the secure store (cleared by [AuthRepository])
 * and the push token store (cleared by its own logout hook) are not here.
 */
private val WIPED_PREFS = listOf(NewSessionDraftStore.PREFS_NAME, PrefsReviewStamps.PREFS_NAME, VoicePreferences.PREFS_NAME)
