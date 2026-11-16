package com.slopus.happy.agent

import android.app.ActivityManager
import android.content.Context
import com.slopus.happy.accounts.AccountStore
import com.slopus.happy.auth.AndroidKeyStoreKeys
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.auth.SecureStoreKeys
import com.slopus.happy.connection.AgentConnection
import com.slopus.happy.connection.AgentConnectionCredentials
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.connection.TailcatTransport
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.agentTransport
import com.slopus.happy.diagnostics.traced
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import java.io.File
import java.util.concurrent.CountDownLatch

/**
 * The open agent connection's tunnel, asked for as the process starts
 * ([com.slopus.happy.HappyApplication.onCreate]), beside the app graph
 * rather than after it, the window and the foreground. Connecting needs
 * only which account opens, its credentials and the relay map; nothing
 * there asks the person or waits for an unlock (the Keystore keys need no
 * authentication), and the bearer isn't sent until the session's first
 * request. [start] reads them and connects the main client ([Transport.warm]
 * of none). The open account's session takes that transport ([take], from
 * [AgentSessions]' makeTransport), so the connection has one transport and
 * one main client, never a second. Until then [follow] lets it go when
 * another account opens or this one is removed, signed out, ended or
 * revoked. Whatever fails here only leaves the session to connect as it
 * would have.
 */
class StartupLink(
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    private val makeTransport: (AgentConnectionCredentials) -> Transport = { agentTransport(it.address, it.port, it.publicUrl, it.tailcatAvailable != false) },
) {
    private class Started(val id: String, val credentials: AgentConnectionCredentials, val transport: Transport)

    private val lock = Any()
    /** Counted down once [start] has made its transport or decided not to; null while it was never asked. */
    @Volatile private var deciding: CountDownLatch? = null
    private var started: Started? = null
    /** Taken or let go: nothing is kept or handed out after. */
    private var settled = false
    @Volatile private var following: Job? = null

    /**
     * Connects [openId]'s agent connection, if one opens: listed in
     * [accounts], neither revoked nor signed out, with [credentials]. Each
     * is read on IO; [relayMap] is set before the connect, which reads it.
     */
    fun start(
        openId: () -> String?,
        accounts: () -> List<AgentConnection>,
        credentials: (String) -> AgentConnectionCredentials?,
        relayMap: () -> Unit = {},
    ): Job {
        val decided = CountDownLatch(1).also { deciding = it }
        return scope.launch {
            val transport = try {
                traced("StartupLink.read") {
                    val id = openId() ?: return@launch
                    val account = accounts().firstOrNull { it.id == id } ?: return@launch
                    if (account.revoked || account.signInRequired) return@launch
                    val read = credentials(id) ?: return@launch
                    relayMap()
                    val made = makeTransport(read)
                    val kept = synchronized(lock) {
                        if (!settled) started = Started(id, read, made)
                        !settled
                    }
                    if (!kept) {
                        made.close()
                        return@launch
                    }
                    made
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                return@launch // The session reads and connects for itself.
            } finally {
                decided.countDown()
            }
            // A failed connect leaves the slot empty: the session's first request connects again.
            transport.warm(0)
        }.also { job -> job.invokeOnCompletion { decided.countDown() } }
    }

    /**
     * The transport [start] made for [credentials], once: what the open
     * session's link is made of. Null for any other credentials, when
     * nothing was started, or once let go. Waits while [start] is still
     * reading (tens of milliseconds, and only at the very start).
     */
    fun take(credentials: AgentConnectionCredentials): Transport? {
        deciding?.await()
        return synchronized(lock) {
            val held = started?.takeIf { !settled && it.credentials == credentials } ?: return null
            settled = true
            started = null
            held.transport
        }.also { following?.cancel() }
    }

    /**
     * Until the session takes it: the transport is closed once [openId] is
     * another account's, or its account is gone, signed out, ended or revoked.
     */
    fun follow(openId: Flow<String?>, accounts: Flow<List<AgentConnection>>): Job = scope.launch(start = CoroutineStart.LAZY) {
        val decided = deciding ?: return@launch
        runInterruptible { decided.await() }
        val held = synchronized(lock) { started } ?: return@launch
        combine(openId, accounts) { open, list ->
            synchronized(lock) { settled } || open != held.id || list.none { it.id == held.id && !it.revoked && !it.signInRequired }
        }.first { it }
        release(held)
    }.also { following = it; it.start() }

    private suspend fun release(held: Started) {
        synchronized(lock) {
            if (settled || started !== held) return
            settled = true
            started = null
        }
        held.transport.close()
    }

    /**
     * [start] over [context]'s stores, as [com.slopus.happy.AppGraph] keeps
     * them. Only reads: the Keystore's StrongBox choice matters only to a
     * key being made, never to one read ([keys] are software keys in tests).
     */
    fun start(context: Context, keys: SecureStoreKeys = AndroidKeyStoreKeys()): Job {
        val app = context.applicationContext ?: context
        return start(
            openId = { AccountStore.openAgentId(app.getSharedPreferences(AccountStore.PREFS_NAME, Context.MODE_PRIVATE)) },
            accounts = { AgentConnections.read(app.getSharedPreferences(AgentConnections.REGISTRY_PREFS, Context.MODE_PRIVATE)) },
            credentials = { id ->
                val secrets = ExpoSecureStore(
                    prefs = app.getSharedPreferences(AgentConnections.SECRETS_PREFS, Context.MODE_PRIVATE),
                    keys = keys,
                    keychainService = AgentConnections.KEYCHAIN_SERVICE,
                )
                AgentConnections.read(secrets, id)
            },
            relayMap = { TailcatTransport.persistDerpMap(derpMapFile(app)) },
        )
    }

    companion object {
        /**
         * The process starts to show a window, not for a push, a broadcast
         * or a file another app reads: while an activity is being launched
         * its importance is foreground already in Application.onCreate.
         */
        fun forWindow(context: Context): Boolean =
            ActivityManager.RunningAppProcessInfo().also(ActivityManager::getMyMemoryState).importance ==
                ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND

        /** Where the relay map is kept, under no-backup files. */
        fun derpMapFile(context: Context) = File(context.noBackupFilesDir, "tailcat/derpmap.json")
    }
}
