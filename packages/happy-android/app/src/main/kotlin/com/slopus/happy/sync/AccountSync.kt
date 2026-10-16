package com.slopus.happy.sync

import com.slopus.happy.chat.PlanModeFollower
import com.slopus.happy.crypto.AccountEncryption
import com.slopus.happy.data.HappyStore
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.net.SocketEvent
import com.slopus.happy.net.SocketIoClient
import com.slopus.happy.net.SocketIoUrl
import com.slopus.happy.net.socketIoBackoff
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * Everything that keeps one signed-in account in sync, from sign-in to
 * sign-out: the delta sync, the `/v1/updates` socket (apiSocket.ts) and
 * what it delivers, presence, and message history.
 *
 * Network, decryption and store writes all run on [io]; the flows it exposes
 * can be collected from the main thread.
 */
class AccountSync(
    http: HappyHttp,
    okHttp: OkHttpClient,
    serverUrl: () -> String,
    private val clientId: String,
    private val token: String,
    encryption: AccountEncryption,
    private val store: HappyStore,
    parent: Job,
    /** Whether the app is in the foreground; the server routes pushes by it. */
    private val foreground: StateFlow<Boolean>,
    clock: () -> Long = System::currentTimeMillis,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    reconnectDelayMs: (Int) -> Long = { socketIoBackoff(it) },
) {
    private val job = SupervisorJob(parent)
    private val scope = CoroutineScope(job + io)

    val api = SyncApi(http, token)
    val decoder = RecordDecoder(encryption)
    val presence = Presence(clock)

    val messages = MessageSync(api, store, decoder, scope, io, onSessionGone = presence::removeSession)

    private val engine = SyncEngine(api, store, encryption, clock, io, decoder, messages)
    private val deltaSync = InvalidateSync(scope) {
        val failures = engine.syncAll()
        if (failures.isNotEmpty()) throw failures.first()
    }

    private val socket = SocketIoClient(
        // The socket lives for hours; liveness is the heartbeat watchdog's job, not a read timeout.
        client = okHttp.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build(),
        url = { SocketIoUrl.create(serverUrl()) },
        scope = scope,
        headers = mapOf("X-Happy-Client" to clientId),
        reconnectDelayMs = reconnectDelayMs,
        auth = ::handshake,
    )

    /** The file viewer's and changes screen's last reads, shown while they fetch again. */
    val fileCache = SessionFileCache()

    val live = LiveUpdates(store, decoder, presence, messages, requestSync = deltaSync::invalidate, onSessionDeleted = fileCache::forgetSession)

    private val rpc = RpcClient(socket, store, decoder, io)

    /** Abort, permissions, kill, archive, delete, files and shell for one session (ops.ts). */
    val sessionOps = SessionOps(rpc, api, store, io)

    /** Spawn, resume, stop, fork and the daemon's shell (ops.ts). */
    val machineOps = MachineOps(rpc, api, store, decoder, refreshSessions = ::syncNow, io = io)

    /** Happy Agent's native Git changes: snapshot and file sides (happyAgentGit.ts). */
    val git = HappyAgentGit(rpc, store, io)

    /** Each session's draft and picks, synced through its metadata (ops.ts sessionSetAgentModes, rigComposer.ts). */
    val composer = SessionComposer(
        store,
        decoder,
        emitWithAck = rpc::emitWithAck,
        isConnected = { socket.status.value == ConnectionStatus.CONNECTED },
        parent = job,
        dispatcher = io.limitedParallelism(1),
        clock = clock,
    )

    /** Sending and the stored outbox (sync.ts sendMessage, flushOutbox). */
    val sender = MessageSender(
        api, store, decoder, messages, composer,
        isThinking = { presence.sessions.value[it]?.thinking == true },
        scope = scope,
        refreshSessions = ::syncNow,
        io = io,
        clock = clock,
    )

    /** The socket's state, as Home's header shows it (homeConnectionStatus.ts). */
    val connectionStatus: StateFlow<ConnectionStatus> = socket.status

    /** True while a delta sync is running. */
    val isSyncing: StateFlow<Boolean> = deltaSync.isRunning

    // sync.ts applyMessages: the switch lands in the mirror and in metadata,
    // so other devices see plan mode and the next metadata update keeps it.
    private val planMode = PlanModeFollower(permissionMode = { composer.mirrors.value[it]?.permissionMode }) { sessionId ->
        composer.setAgentModes(sessionId, mapOf(AgentModeField.PERMISSION_MODE to "plan"))
    }

    fun start() {
        scope.launch {
            messages.stored.collect { batch ->
                try {
                    planMode.onStored(batch)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // A batch that cannot be read changes no mode.
                }
            }
        }
        scope.launch {
            for (event in socket.events) {
                try {
                    when (event) {
                        SocketEvent.Connected -> onConnected()
                        is SocketEvent.Message -> live.handle(event.name, event.payload)
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // One update that cannot be applied must not stop the rest;
                    // the next delta sync settles whatever it would have changed.
                    deltaSync.invalidate()
                }
            }
        }
        scope.launch {
            store.versions.map { it.sessionActivity }.distinctUntilChanged().collect {
                presence.reconcileSessions(store.sessionActivity())
            }
        }
        scope.launch {
            store.versions.map { it.machineActivity }.distinctUntilChanged().collect {
                presence.reconcileMachines(store.machineActivity())
            }
        }
        scope.launch {
            foreground.drop(1).collect { active ->
                socket.emit("app-state", appState(active))
                sender.setForeground(active)
                if (active) {
                    socket.reconnectNow()
                    requestSync()
                    refreshViewing()
                }
            }
        }
        composer.start()
        sender.setForeground(foreground.value)
        scope.launch { sender.resume() }
        socket.connect()
        deltaSync.invalidate()
    }

    /** Sign-out or account switch: the socket closes and every job of this account stops. */
    suspend fun stop() {
        socket.disconnect()
        job.cancelAndJoin()
    }

    private val viewingRefreshes = MutableSharedFlow<Set<String>>(extraBufferCapacity = 8, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /**
     * The open chats, each time they are refreshed after a reconnect or a
     * return to the foreground (sync.ts onSessionVisible for
     * currentViewingSessionId): their messages here, their git status by
     * whoever follows this.
     */
    val viewingRefreshed: SharedFlow<Set<String>> = viewingRefreshes.asSharedFlow()

    private fun refreshViewing() {
        messages.invalidateViewing()
        messages.viewingSessionIds().takeIf { it.isNotEmpty() }?.let(viewingRefreshes::tryEmit)
    }

    /** Ask for a delta sync now. */
    fun requestSync() = deltaSync.invalidate()

    suspend fun syncNow() = deltaSync.invalidateAndAwait()

    /**
     * Every connect is a fresh socket session (the server keeps no
     * recovery state), so whatever was sent while it was down was missed.
     */
    private fun onConnected() {
        // The handshake carried the state for the first connect; this covers reconnects.
        socket.emit("app-state", appState(foreground.value))
        deltaSync.invalidate()
        refreshViewing()
        scope.launch { composer.flushAhead() }
        scope.launch { sender.resume() }
    }

    /** Read at every connect, so a reconnect in the background does not claim the app is active. */
    private fun handshake(): JsonObject = buildJsonObject {
        put("token", token)
        put("clientType", "user-scoped")
        put("happyClient", clientId)
        put("appState", if (foreground.value) "active" else "background")
    }

    private fun appState(active: Boolean) = buildJsonObject { put("state", JsonPrimitive(if (active) "active" else "background")) }
}
