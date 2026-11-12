package com.slopus.happy.push

import android.content.Context
import androidx.core.app.NotificationManagerCompat
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.connection.AgentConnection
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.HappyCloud
import com.slopus.happy.connection.networkPath
import com.slopus.happy.connection.returns
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import java.util.Locale
import java.util.concurrent.TimeUnit

/** App wiring only. Relay capabilities live in memory; the ledger contains encrypted identifiers, not credentials. */
class CloudPushRuntime(
    private val context: Context,
    private val connections: AgentConnections,
    private val client: (String) -> AgentClient?,
    foreground: StateFlow<Boolean>,
    private val scope: CoroutineScope,
    store: ExpoSecureStore,
    /** This installation's id, shared with the environment reports ([com.slopus.happy.agent.UserEnvironmentRuntime]). */
    private val installation: InstallationId = InstallationId(context),
) {
    private fun account(value: AgentConnection): CloudPushAccount? = value.userId?.let { user ->
        value.server?.takeIf { HappyCloud.isServer(it) && !value.revoked && !value.signInRequired && !value.profileRequired }
            ?.let { CloudPushAccount(value.id, it, user) }
    }
    private val accounts = connections.accounts.map { it.mapNotNull(::account) }
        .stateIn(scope, SharingStarted.Eagerly, connections.accounts.value.mapNotNull(::account))
    private val registrations = CloudPushRegistrations(CloudPushLedger(store), { candidate ->
        connections.accounts.value.any { account(it) == candidate }
    })
    private val relay = HappyPushRelay(OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(30, TimeUnit.SECONDS).build())
    private val sync = CloudPushSync(
        accounts, foreground, context.networkPath().returns(), registrations, ::api, FcmTokenSource(context),
        exchange = { native -> relay.exchange(native, installation.getOrCreate(), context.packageName, locale()) },
        notificationsAllowed = { NotificationManagerCompat.from(context).areNotificationsEnabled() },
        appId = context.packageName, locale = ::locale,
    )

    private fun api(account: CloudPushAccount): CloudPushApi? =
        if (connections.accounts.value.none { this.account(it) == account }) null else client(account.connectionId)?.takeIf { it.cloud }?.let(::CloudPushApi)

    fun start() = sync.start(scope)
    fun refresh() = sync.refresh()
    fun nativeTokenChanged() {
        // A rotated FCM token can start a background process with no Activity or cold-start UI effect.
        start()
        sync.refresh(native = true)
    }

    /** Online disconnect must run this before Accounts revokes the credential. Offline failures remain queued. */
    suspend fun beforeRemoval(connectionId: String) = withContext(Dispatchers.IO) {
        val account = connections.accounts.value.firstOrNull { it.id == connectionId }?.let(::account) ?: return@withContext
        try { withTimeoutOrNull(3_000) { registrations.remove(account, api(account)) } }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (_: Exception) { /* Push storage failure must not prevent signing out. */ }
        // Registry reconciliation also retires bindings that were still waiting for their lock when time ran out.
    }

    private fun locale() = Locale.getDefault().toLanguageTag().take(64)

    companion object {
        const val PREFS = "cloud-push-registrations"
        const val KEYCHAIN_SERVICE = "cloud-push"
    }
}