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
import com.slopus.happy.model.settings.SettingsRepository
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.sync.AccountSync
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
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

    /** The account's synced settings; a change is uploaded by the next sync. */
    val settings = SettingsRepository(store, scope, onChanged = ::requestSync)
    private val accountLock = Mutex()
    private val foreground = MutableStateFlow(false)
    private val accountState = MutableStateFlow<AccountSync?>(null)

    /** The signed-in account's sync, or null when signed out. */
    val account: StateFlow<AccountSync?> = accountState.asStateFlow()

    /** The updates socket's state; disconnected when signed out. */
    @OptIn(ExperimentalCoroutinesApi::class)
    val connectionStatus: StateFlow<ConnectionStatus> = accountState
        .flatMapLatest { it?.connectionStatus ?: flowOf(ConnectionStatus.DISCONNECTED) }
        .stateIn(scope, SharingStarted.Eagerly, ConnectionStatus.DISCONNECTED)

    init {
        scope.launch {
            auth.state.collect { state -> accountLock.withLock { switchAccount(state) } }
        }
    }

    /** Ask for a delta sync now (sign-in, app back in the foreground). No-op when signed out. */
    fun requestSync() {
        accountState.value?.requestSync()
    }

    /** The app came to the foreground or left it (MainActivity onStart/onStop). */
    fun setForeground(value: Boolean) {
        foreground.value = value
    }

    /**
     * Settings > Account > Logout: credentials, local data and device
     * preferences go; the server choice stays. Runs in the app scope, since
     * the screen that asked is gone as soon as the account is.
     */
    fun logout(): Job = scope.launch {
        accountLock.withLock {
            stopAccount()
            withContext(Dispatchers.IO) { store.clearAll() }
            localSettings.clear()
            auth.logout()
        }
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
        val account = accountState.value ?: return
        accountState.value = null
        account.stop()
    }
}
