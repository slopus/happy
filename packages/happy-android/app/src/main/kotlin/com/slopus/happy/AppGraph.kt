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
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.sync.InvalidateSync
import com.slopus.happy.sync.SyncApi
import com.slopus.happy.sync.SyncEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
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
 * While signed in it owns one sync loop for the account; signing out stops
 * it before local data is cleared.
 */
class AppGraph(
    context: Context,
    clientId: String,
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
    private val accountLock = Mutex()
    private var accountJob: Job? = null
    @Volatile private var sync: InvalidateSync? = null

    init {
        scope.launch {
            auth.state.collect { state -> accountLock.withLock { switchAccount(state) } }
        }
    }

    /** Ask for a delta sync now (sign-in, app back in the foreground). No-op when signed out. */
    fun requestSync() {
        sync?.invalidate()
    }

    /**
     * Settings > Account > Logout: credentials, local data and device
     * preferences go; the server choice stays. Runs in the app scope, since
     * the screen that asked is gone as soon as the account is.
     */
    fun logout(): Job = scope.launch {
        accountLock.withLock {
            accountJob?.cancelAndJoin()
            accountJob = null
            sync = null
            withContext(Dispatchers.IO) { store.clearAll() }
            localSettings.clear()
            auth.logout()
        }
    }

    private suspend fun switchAccount(state: AuthState) {
        accountJob?.cancelAndJoin()
        accountJob = null
        sync = null
        if (state !is AuthState.SignedIn) return

        val job = SupervisorJob(scope.coroutineContext[Job])
        val engine = SyncEngine(SyncApi(http, state.credentials.token), store, state.encryption)
        sync = InvalidateSync(CoroutineScope(scope.coroutineContext + job)) {
            val failures = engine.syncAll()
            if (failures.isNotEmpty()) throw failures.first()
        }.also { it.invalidate() }
        accountJob = job
    }
}
