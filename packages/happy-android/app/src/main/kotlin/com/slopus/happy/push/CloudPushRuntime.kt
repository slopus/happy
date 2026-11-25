package com.slopus.happy.push

import android.content.Context
import androidx.core.app.NotificationManagerCompat
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.agentTransport
import com.slopus.happy.connection.networkPath
import com.slopus.happy.connection.returns
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * App wiring only. Relay capabilities live in memory; the ledger contains
 * encrypted identifiers, and beside a forgotten pairing's undelivered
 * farewell that pairing's own route to its daemon, until it is delivered.
 */
class CloudPushRuntime(
    private val context: Context,
    private val connections: AgentConnections,
    private val client: (String) -> AgentClient?,
    foreground: StateFlow<Boolean>,
    private val scope: CoroutineScope,
    store: ExpoSecureStore,
    /** This installation's id, shared with the environment reports ([com.slopus.happy.agent.UserEnvironmentRuntime]). */
    private val installation: InstallationId = InstallationId(context),
    private val makeTransport: (CloudPushFarewellRoute) -> Transport = { agentTransport(it.address, it.port, it.publicUrl, it.tailcatAvailable != false) },
) {
    private val accounts = connections.accounts.map { it.mapNotNull(::cloudPushAccount) }
        .stateIn(scope, SharingStarted.Eagerly, connections.accounts.value.mapNotNull(::cloudPushAccount))
    private val registrations = CloudPushRegistrations(CloudPushLedger(store), { candidate ->
        connections.accounts.value.any { cloudPushAccount(it) == candidate }
    })
    private val relay = HappyPushRelay(OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(30, TimeUnit.SECONDS).build())
    private val registeredOn = MutableSharedFlow<String>(extraBufferCapacity = 8)

    /** The connections this phone was just registered on for push, as each server takes it. */
    val registered: SharedFlow<String> = registeredOn
    private val sync = CloudPushSync(
        accounts, foreground, context.networkPath().returns(), registrations, ::api, FcmTokenSource(context),
        exchange = { native -> relay.exchange(native, installation.getOrCreate(), context.packageName, locale()) },
        notificationsAllowed = { NotificationManagerCompat.from(context).areNotificationsEnabled() },
        appId = context.packageName, locale = ::locale,
        registered = { registeredOn.tryEmit(it.connectionId) },
        farewell = ::farewell,
    )

    /**
     * A way to a forgotten pairing's daemon, made for one farewell from what
     * the pairing kept ([route]): the phone forgot the daemon, the daemon
     * still knows the phone's device token until the phone is removed there.
     */
    private fun farewell(route: CloudPushFarewellRoute): CloudPushFarewellLink {
        val transport = makeTransport(route)
        return CloudPushFarewellLink(CloudPushApi(AgentClient(transport, route.deviceToken))) { transport.close() }
    }

    private fun api(account: CloudPushAccount): CloudPushApi? =
        if (connections.accounts.value.none { cloudPushAccount(it) == account }) null else client(account.connectionId)?.let(::CloudPushApi)

    fun start() = sync.start(scope)
    fun refresh() = sync.refresh()
    fun nativeTokenChanged() {
        // A rotated FCM token can start a background process with no Activity or cold-start UI effect.
        start()
        sync.refresh(native = true)
    }

    /**
     * Online disconnect must run this before Accounts revokes the credential
     * or forgets the pairing. A farewell that isn't answered in time stays
     * queued: a sign-in's until the same member signs in again, a pairing's
     * with its own route, asked again until its daemon answers.
     */
    suspend fun beforeRemoval(connectionId: String) = withContext(Dispatchers.IO) {
        val connection = connections.accounts.value.firstOrNull { it.id == connectionId } ?: return@withContext
        try {
            val route = if (connection.server != null) null else connections.credentials(connectionId)?.takeIf { it.oauth == null }?.let {
                CloudPushFarewellRoute(it.address, it.port, it.deviceToken, it.publicUrl, it.tailcatAvailable)
            }
            registrations.leaving(connectionId, route)
            val account = cloudPushAccount(connection) ?: return@withContext
            // What it would register with now, should the last registration have gone unanswered: what is at hand, or soon is.
            withTimeoutOrNull(3_000) { registrations.remove(account, api(account)) { withTimeoutOrNull(1_500) { sync.renewal() } } }
        }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (_: Exception) { /* Push storage failure must not prevent signing out. */ }
        // Registry reconciliation also retires bindings that were still waiting for their lock when time ran out.
        finally { sync.retire() }
    }

    private fun locale() = Locale.getDefault().toLanguageTag().take(64)

    companion object {
        const val PREFS = "cloud-push-registrations"
        const val KEYCHAIN_SERVICE = "cloud-push"
    }
}