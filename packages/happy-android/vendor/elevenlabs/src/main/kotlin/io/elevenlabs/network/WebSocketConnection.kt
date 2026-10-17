package io.elevenlabs.network

import android.util.Log
import io.elevenlabs.ConversationConfig
import io.elevenlabs.ConversationOverridesBuilder
import io.elevenlabs.models.DisconnectionDetails
import io.elevenlabs.models.OutgoingEvent
import io.elevenlabs.models.toConversationStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.consumeAsFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * WebSocket transport for ElevenLabs Conversational AI.
 *
 * Used for text-only sessions where LiveKit/WebRTC would tear down the room
 * after a few seconds because no audio/video tracks are published. Speaks the
 * same JSON event protocol as the existing data channel; serialization and
 * parsing are reused from [ConversationEventParser].
 */
class WebSocketConnection(
    private val client: OkHttpClient = OkHttpClient(),
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
) : BaseConnection() {

    private val _connectionState = MutableStateFlow(ConnectionState.IDLE)
    override val connectionState: ConnectionState
        get() = _connectionState.value

    private var messageListener: ((String) -> Unit)? = null
    private var connectionStateListener: ((ConnectionState) -> Unit)? = null

    private var webSocket: WebSocket? = null
    private var latestConfig: ConversationConfig? = null

    private val messageChannel = Channel<String>(Channel.UNLIMITED)
    private var messageJob: Job? = null

    private val disconnectCallbackInvoked = AtomicBoolean(false)

    /**
     * The listener owning the live socket, claimed before the socket is created and
     * released before it is closed. Every other listener is stale and its callbacks are
     * ignored, because okhttp keeps reading after [WebSocket.close] until the peer answers
     * - reporting an EOFException through [WebSocketListener.onFailure] if the peer drops
     * the connection first - and a reconnect would otherwise let the previous socket
     * disturb the new session.
     *
     * Releasing it before we close also records *who* ended the conversation: a callback
     * that is still current cannot be the result of a local [disconnect].
     */
    @Volatile
    private var activeListener: ConnectionListener? = null

    @Volatile
    private var conversationIdNotified = false

    override suspend fun connect(serverUrl: String, config: ConversationConfig) {
        if (connectionState != ConnectionState.IDLE && connectionState != ConnectionState.DISCONNECTED) {
            throw IllegalStateException("Already connected or connecting")
        }

        try {
            updateConnectionState(ConnectionState.CONNECTING)
            latestConfig = config
            disconnectCallbackInvoked.set(false)
            conversationIdNotified = false

            val url = buildWebSocketUrl(serverUrl, config.signedUrl, config.agentId)
            Log.d("WebSocketConnection", "Connecting to $url")

            val request = Request.Builder().url(url).build()
            // Take ownership before the socket exists, so an immediate callback is never
            // mistaken for a stale one.
            val connectionListener = ConnectionListener()
            activeListener = connectionListener
            webSocket = client.newWebSocket(request, connectionListener)

            startMessageProcessing()
        } catch (e: Exception) {
            activeListener = null
            invokeOnDisconnect(DisconnectionDetails.Error(e))
            updateConnectionState(ConnectionState.ERROR)
            throw RuntimeException("Failed to open WebSocket", e)
        }
    }

    override fun disconnect(details: DisconnectionDetails?) {
        var disconnectDetails = details ?: DisconnectionDetails.User
        // Release ownership before closing: everything the socket reports from here on
        // belongs to a connection we are already reporting as closed.
        activeListener = null

        try {
            messageJob?.cancel()
            messageJob = null

            webSocket?.close(NORMAL_CLOSURE, "client closed")
            webSocket = null

            updateConnectionState(ConnectionState.IDLE)
            Log.d("WebSocketConnection", "Disconnected and reset to IDLE state")
        } catch (e: Exception) {
            Log.d("WebSocketConnection", "Error during disconnect: ${e.message}")
            disconnectDetails = DisconnectionDetails.Error(e)
            updateConnectionState(ConnectionState.ERROR)
        } finally {
            invokeOnDisconnect(disconnectDetails)
        }
    }

    override fun sendMessage(message: Any) {
        if (!connectionState.isActive) {
            throw IllegalStateException("Not connected")
        }
        val ws = webSocket ?: throw IllegalStateException("WebSocket not initialized")

        val text = when (message) {
            is String -> message
            else -> ConversationEventParser.serializeOutgoingEvent(message as OutgoingEvent)
        }

        val sent = ws.send(text)
        if (!sent) {
            Log.d("WebSocketConnection", "WebSocket.send returned false (queue full or closed)")
        }
    }

    override fun setOnMessageListener(listener: (String) -> Unit) {
        this.messageListener = listener
    }

    override fun setOnConnectionStateListener(listener: (ConnectionState) -> Unit) {
        this.connectionStateListener = listener
    }

    fun cleanup() {
        disconnect()
        scope.cancel()
    }

    /**
     * Listener for a single connection attempt. okhttp holds on to it for the lifetime of
     * its socket, which outlives the session: it keeps delivering callbacks after we close
     * and after we have opened a replacement connection. Once [activeListener] points
     * elsewhere this instance is stale and every callback becomes a no-op, so a finished
     * connection can neither move the state nor reach the app's callbacks.
     */
    private inner class ConnectionListener : WebSocketListener() {

        private val isStale: Boolean
            get() = activeListener !== this

        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (isStale) {
                // Disconnected while the handshake was still in flight.
                Log.d("WebSocketConnection", "WebSocket opened on a stale connection, ignoring")
                webSocket.close(NORMAL_CLOSURE, "client closed")
                return
            }

            Log.d("WebSocketConnection", "WebSocket opened")
            updateConnectionState(ConnectionState.CONNECTED)

            try {
                val cfg = latestConfig ?: return
                val payload = ConversationOverridesBuilder.constructOverrides(cfg).toString()
                webSocket.send(payload)
            } catch (e: Exception) {
                Log.d("WebSocketConnection", "Failed to send initiation payload: ${e.message}")
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (isStale) return
            handleIncomingText(text)
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            if (isStale) return
            handleIncomingText(bytes.utf8())
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            Log.d("WebSocketConnection", "WebSocket closing: code=$code reason=$reason")
            // Complete the handshake even when stale, so the peer's close is acknowledged
            // instead of being left to time out.
            webSocket.close(code, reason)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (isStale) {
                Log.d(
                    "WebSocketConnection",
                    "WebSocket closed on a stale connection, ignoring: code=$code reason=$reason"
                )
                return
            }

            Log.d("WebSocketConnection", "WebSocket closed: code=$code reason=$reason")
            // The close code alone can't tell us who ended the conversation: a server-enforced
            // idle timeout closes with the same normal-closure code (1000) as an explicit
            // client-side disconnect. Reaching this point already rules out the latter -
            // [disconnect] releases ownership before closing, so a local close arrives here
            // stale and is reported as [DisconnectionDetails.User] by [disconnect] itself.
            // A normal closure we didn't request therefore came from the remote side (agent
            // ending the conversation, idle timeout, etc.) and is reported as
            // [DisconnectionDetails.Agent]. Anything else (going away, abnormal, server
            // unreachable, etc.) is reported as an error.
            val details = if (code == NORMAL_CLOSURE) {
                DisconnectionDetails.Agent
            } else {
                DisconnectionDetails.Error(RuntimeException("WebSocket closed: $code $reason"))
            }
            updateConnectionState(ConnectionState.DISCONNECTED)
            invokeOnDisconnect(details)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (isStale) {
                // Expected after a client-initiated close: the peer usually drops the
                // connection before its close frame reaches us, which okhttp surfaces as an
                // EOFException. That connection already ended cleanly, so it is not an error.
                Log.d(
                    "WebSocketConnection",
                    "WebSocket failure on a stale connection, ignoring: $t"
                )
                return
            }

            Log.e("WebSocketConnection", "WebSocket failure: ${t.message}", t)
            updateConnectionState(ConnectionState.ERROR)
            val cause = if (t is Exception) t else RuntimeException(t)
            invokeOnDisconnect(DisconnectionDetails.Error(cause))
        }
    }

    private fun handleIncomingText(text: String) {
        messageChannel.trySend(text)

        try {
            latestConfig?.onMessage?.invoke("ai", text)
        } catch (t: Throwable) {
            Log.d("WebSocketConnection", "onMessage callback threw: ${t.message}")
        }

        if (!conversationIdNotified) {
            tryNotifyConversationId(text)
        }
    }

    private fun tryNotifyConversationId(text: String) {
        try {
            val obj = JSONObject(text)
            if (obj.optString("type") != "conversation_initiation_metadata") return

            // Server nests the payload under conversation_initiation_metadata_event;
            // the unsuffixed key and flat root are tolerated for forwards/backwards compatibility.
            val meta = obj.optJSONObject("conversation_initiation_metadata_event")
                ?: obj.optJSONObject("conversation_initiation_metadata")
                ?: obj
            val id = meta.optString("conversation_id", "")
            if (id.isEmpty()) return

            conversationIdNotified = true
            try {
                latestConfig?.onConnect?.invoke(id)
            } catch (t: Throwable) {
                Log.d("WebSocketConnection", "onConnect callback threw: ${t.message}")
            }
        } catch (_: Exception) {
            // Parser will surface malformed payloads downstream.
        }
    }

    private fun startMessageProcessing() {
        messageJob = scope.launch {
            messageChannel.consumeAsFlow().collect { msg ->
                messageListener?.invoke(msg)
            }
        }
    }

    private fun updateConnectionState(newState: ConnectionState) {
        if (_connectionState.value != newState) {
            _connectionState.value = newState
            connectionStateListener?.invoke(newState)
            try {
                latestConfig?.onStatusChange?.invoke(newState.toConversationStatus())
            } catch (_: Throwable) {
            }
        }
    }

    private fun invokeOnDisconnect(details: DisconnectionDetails) {
        if (!disconnectCallbackInvoked.compareAndSet(false, true)) return
        try {
            latestConfig?.onDisconnect?.invoke(details)
        } catch (t: Throwable) {
            Log.d("WebSocketConnection", "onDisconnect callback threw: ${t.message}")
        }
    }

    companion object {
        private const val WS_PATH = "/v1/convai/conversation"
        private const val NORMAL_CLOSURE = 1000

        internal fun buildWebSocketUrl(serverUrl: String, signedUrl: String?, agentId: String?): String {
            // Private agent: open the backend-issued signed URL verbatim.
            if (!signedUrl.isNullOrBlank()) {
                require(signedUrl.startsWith("ws://") || signedUrl.startsWith("wss://")) {
                    "signedUrl must be a ws:// or wss:// URL"
                }
                return signedUrl
            }

            // Public agent: build the URL from agentId. The ConvAI WebSocket lives on the same
            // host as the REST API, so accept either an https:// or wss:// serverUrl.
            require(!agentId.isNullOrBlank()) {
                "WebSocket connection requires either signedUrl (private) or agentId (public)"
            }
            val base = serverUrl
                .replaceFirst("https://", "wss://")
                .replaceFirst("http://", "ws://")
                .trimEnd('/')
            return "$base$WS_PATH?agent_id=$agentId"
        }
    }
}
