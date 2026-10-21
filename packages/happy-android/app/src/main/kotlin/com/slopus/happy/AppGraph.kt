package com.slopus.happy

import android.content.Context
import com.slopus.happy.auth.AndroidKeyStoreKeys
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

    val serverConfig = ServerConfig(
        context.getSharedPreferences(ServerConfig.PREFS_NAME, Context.MODE_PRIVATE),
        defaultServerUrl,
    )
    val localSettings = LocalSettings(context.getSharedPreferences(LocalSettings.PREFS_NAME, Context.MODE_PRIVATE))

    private val okHttp = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    val http = HappyHttp(okHttp, serverUrl = { serverConfig.url.value }, clientId = clientId)
    val authApi = AuthApi(http)
    val auth = AuthRepository(
        SecureStoreCredentialStore(
            ExpoSecureStore(
                prefs = context.getSharedPreferences(ExpoSecureStore.PREFS_NAME, Context.MODE_PRIVATE),
                keys = secureStoreKeys,
                defaultPrefs = context.getSharedPreferences("${context.packageName}_preferences", Context.MODE_PRIVATE),
            ),
        ),
        authApi,
    )
    val store = HappyStore(HappyDatabase(context, databaseName))

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
        service = VoiceApi(okHttp, clientId, { serverConfig.url.value }, { serverConfig.voiceUrl }, BuildConfig.ELEVENLABS_AGENT_ID),
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

    /** The updates socket's state; disconnected when signed out. */
    @OptIn(ExperimentalCoroutinesApi::class)
    val connectionStatus: StateFlow<ConnectionStatus> = accountState
        .flatMapLatest { it?.connectionStatus ?: flowOf(ConnectionStatus.DISCONNECTED) }
        .stateIn(scope, SharingStarted.Eagerly, ConnectionStatus.DISCONNECTED)

    init {
        scope.launch {
            combine(auth.state, serverConfig.url) { _, _ -> purchaseAccount() }.collect(purchases::setAccount)
        }
        scope.launch {
            foreground.collect { if (it) purchases.refresh() }
        }
        scope.launch {
            auth.state.collect { state -> accountLock.withLock { switchAccount(state) } }
        }
    }

    private fun purchaseAccount(): PurchaseAccount? = (auth.state.value as? AuthState.SignedIn)?.publicId
        ?.takeIf { it.isNotBlank() }?.let { PurchaseAccount(serverConfig.url.value, it) }

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
            (auth.state.value as? AuthState.SignedIn)?.let { signedIn -> logoutHooks.forEach { it(signedIn.credentials.token) } }
            purchases.setAccount(null)
            stopAccount()
            withContext(Dispatchers.IO) {
                store.clearAll()
                // persistence.ts clearPersistence: everything in the default MMKV goes, the server choice stays.
                localSettings.clear()
                changelog.clear()
                for (name in WIPED_PREFS) appContext.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
                LocalCaches.wipe(appContext)
            }
            wipeHooks.forEach { it() }
            auth.logout()
        }
    }

    private val wipeHooks = CopyOnWriteArrayList<() -> Unit>()

    /**
     * [hook] runs on logout once the stored data is gone, for in-memory
     * state that mirrors it (the new-session draft). It must not throw.
     */
    fun afterLogoutWipe(hook: () -> Unit) {
        wipeHooks += hook
    }

    private suspend fun switchAccount(state: AuthState) {
        stopAccount()
        if (state !is AuthState.SignedIn) return
        val account = AccountSync(
            http = http,
            okHttp = okHttp,
            serverUrl = { serverConfig.url.value },
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
