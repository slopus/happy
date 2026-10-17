package io.elevenlabs.network

import android.content.Context
import android.util.Log
import io.elevenlabs.ConversationConfig
import io.elevenlabs.models.AudioFrame
import io.elevenlabs.models.ConversationMode
import io.elevenlabs.models.ConversationStatus
import io.elevenlabs.models.DisconnectionDetails
import io.elevenlabs.models.OutgoingEvent
import io.elevenlabs.models.toConversationStatus
import io.livekit.android.room.Room
import io.livekit.android.room.participant.LocalParticipant
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.participant.RemoteParticipant
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.room.track.RemoteAudioTrack
import io.livekit.android.room.track.Track
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import livekit.org.webrtc.AudioTrackSink
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Collections
import io.elevenlabs.ConversationOverridesBuilder


/**
 * WebRTC implementation using LiveKit for real-time communication
 *
 * This class manages room-based architecture for connections, data channels
 * for event messaging, audio tracks for voice communication, and automatic
 * reconnection handling.
 */
class WebRTCConnection(
    private val context: Context,
    private val room: Room,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.Main + SupervisorJob())
) : BaseConnection() {

    private var localParticipant: LocalParticipant? = null
    private var latestConfig: ConversationConfig? = null

    /** Flag to ensure onDisconnect is only called once per session */
    @Volatile
    private var disconnectCallbackInvoked = false

    private var _connectionState = MutableStateFlow(ConnectionState.IDLE)
    override val connectionState: ConnectionState
        get() = _connectionState.value

    private val _audioLevel = MutableStateFlow(0.0f)
    val audioLevel: StateFlow<Float> = _audioLevel

    private var messageListener: ((String) -> Unit)? = null
    private var connectionStateListener: ((ConnectionState) -> Unit)? = null

    private val messageChannel = Channel<String>(Channel.UNLIMITED)
    private var messageJob: Job? = null
    private var audioLevelJob: Job? = null

    private val agentAudioSinks: MutableMap<RemoteAudioTrack, AudioTrackSink> =
        Collections.synchronizedMap(mutableMapOf())

    /**
     * Connect to LiveKit room using the WebRTC token from [config] and the given server URL.
     */
    override suspend fun connect(serverUrl: String, config: ConversationConfig) {
        if (connectionState != ConnectionState.IDLE && connectionState != ConnectionState.DISCONNECTED) {
            throw IllegalStateException("Already connected or connecting")
        }

        val token = requireNotNull(config.conversationToken?.takeIf { it.isNotBlank() }) {
            "WebRTC connection requires a non-blank conversationToken"
        }

        try {
            updateConnectionState(ConnectionState.CONNECTING)
            latestConfig = config

            // Use provided shared room
            localParticipant = room.localParticipant

            // Set up event handlers before connecting
            setupRoomEventHandlers()

            // Connect to the room
            Log.d("WebRTCConnection", "Connecting to LiveKit url: $serverUrl")
            room.connect(
                url = serverUrl,
                token = token
            )

            // Start message processing
            startMessageProcessing()

        } catch (e: Exception) {
            invokeOnDisconnect(DisconnectionDetails.Error(e))
            updateConnectionState(ConnectionState.ERROR)
            throw RuntimeException("Failed to connect to LiveKit room", e)
        }
    }

    /**
     * Disconnect from the room and clean up resources
     * @param details Optional disconnection details. If null, defaults to User-initiated disconnect.
     */
    override fun disconnect(details: DisconnectionDetails?) {
        var disconnectDetails = details ?: DisconnectionDetails.User

        try {
            // Stop message processing first
            messageJob?.cancel()
            messageJob = null

            // Stop audio level monitoring
            audioLevelJob?.cancel()
            audioLevelJob = null

            // Detach any agent audio sinks before the room tears the tracks down
            detachAllAgentAudioSinks()

            // Stop event handling
            eventHandlerJob?.cancel()
            eventHandlerJob = null

            // Disconnect from room
            room.disconnect()
            localParticipant = null

            // Reset audio level to 0
            _audioLevel.value = 0.0f

            // Reset disconnect callback flag to allow reconnection
            disconnectCallbackInvoked = false

            // Reset to IDLE state to allow reconnection
            updateConnectionState(ConnectionState.IDLE)
            Log.d("WebRTCConnection", "Disconnected and reset to IDLE state")

        } catch (e: Exception) {
            Log.d("WebRTCConnection", "Error during disconnect: ${e.message}")
            disconnectDetails = DisconnectionDetails.Error(e)
            updateConnectionState(ConnectionState.ERROR)
        } finally {
            // Invoke onDisconnect callback once after all cleanup is complete
            invokeOnDisconnect(disconnectDetails)
        }
    }

    /**
     * Send a message through the data channel
     */
    override fun sendMessage(message: Any) {
        if (!connectionState.isActive) {
            throw IllegalStateException("Not connected")
        }

        val messageString = when (message) {
            is String -> message
            else -> ConversationEventParser.serializeOutgoingEvent(message as OutgoingEvent)
        }

        val payload = messageString.toByteArray()
        scope.launch {
            try {
                val result = room.localParticipant.publishData(payload)
                if (result.isFailure) {
                    Log.d("WebRTCConnection", "publishData failed - ${result.exceptionOrNull()?.message}")
                }
            } catch (e: Exception) {
                Log.e("WebRTCConnection", "publishData error - ${e.message}")
            }
        }
    }

    /**
     * Set listener for incoming messages
     */
    override fun setOnMessageListener(listener: (String) -> Unit) {
        this.messageListener = listener
    }

    /**
     * Set listener for connection state changes
     */
    override fun setOnConnectionStateListener(listener: (ConnectionState) -> Unit) {
        this.connectionStateListener = listener
    }

    private var eventHandlerJob: Job? = null

    /**
     * Set up LiveKit room event handlers
     */
    private fun setupRoomEventHandlers() {
        // Cancel any existing event handler
        eventHandlerJob?.cancel()

        eventHandlerJob = scope.launch {
            room.events.collect { event ->
                when (event) {
                    is RoomEvent.Connected -> {
                        Log.d("WebRTCConnection", "Connected. roomSid=${room.sid}, name=${room.name}")
                        // Mark connection as connected now that LK confirms
                        updateConnectionState(ConnectionState.CONNECTED)

                        // Start monitoring audio levels from remote participants
                        startAudioLevelMonitoring()

                        // Send initiation overrides payload after actual connection
                        try {
                            latestConfig?.let { cfg ->
                                val payload = ConversationOverridesBuilder
                                    .constructOverrides(cfg)
                                    .toString()
                                sendMessage(payload)
                            }
                        } catch (e: Exception) {
                            Log.d("WebRTCConnection", "failed to send overrides - ${e.message}")
                        }

                        // invoke user callback if provided with extracted conversation id
                        try {
                            val roomName = room.name ?: ""
                            val match = Regex("conv_[A-Za-z0-9_-]+", RegexOption.IGNORE_CASE).find(roomName)
                            val conversationId = match?.value ?: roomName
                            latestConfig?.onConnect?.invoke(conversationId)
                        } catch (t: Throwable) {
                            Log.d("WebRTCConnection", "onConnect callback threw: ${t.message}")
                        }
                    }

                    is RoomEvent.Disconnected -> {
                        Log.d("WebRTCConnection", "LiveKit room disconnected: ${event.reason}")
                        if (connectionState == ConnectionState.CONNECTED) {
                            updateConnectionState(ConnectionState.DISCONNECTED)
                        }
                    }

                    is RoomEvent.Reconnecting -> {
                        Log.d("WebRTCConnection", "LiveKit room reconnecting")
                        updateConnectionState(ConnectionState.RECONNECTING)
                    }

                    is RoomEvent.Reconnected -> {
                        Log.d("WebRTCConnection", "LiveKit room reconnected")
                        updateConnectionState(ConnectionState.CONNECTED)
                    }

                    is RoomEvent.ParticipantDisconnected -> {
                        Log.d("WebRTCConnection", "Participant disconnected: ${event.participant.sid}")
                        handleParticipantDisconnected(event.participant)
                    }

                    is RoomEvent.TrackSubscribed -> {
                        Log.d("WebRTCConnection", "Audio track subscribed from ${event.participant.sid}")
                        handleTrackSubscribed(event.track, event.participant)
                    }

                    is RoomEvent.TrackUnsubscribed -> {
                        Log.d("WebRTCConnection", "Track unsubscribed from ${event.participant.sid}")
                        handleTrackUnsubscribed(event.track)
                    }

                    is RoomEvent.DataReceived -> {
                        handleDataReceived(event.data, event.participant)
                    }

                    else -> {
                        Log.d("WebRTCConnection", "Unhandled event: ${event.javaClass.simpleName}")
                    }
                }
            }
        }
    }

    /**
     * Start processing incoming messages
     */
    private fun startMessageProcessing() {
        messageJob = scope.launch {
            messageChannel.consumeAsFlow().collect { message ->
                messageListener?.invoke(message)
            }
        }
    }

    /**
     * Handle participant disconnected event
     */
    private fun handleParticipantDisconnected(participant: RemoteParticipant) {
        val identityStr = participant.identity?.value

        // If the agent disconnects, shut down the connection with agent disconnect reason
        if (identityStr?.startsWith("agent") == true) {
            disconnect(DisconnectionDetails.Agent)
        }
    }

    /**
     * Handle track subscribed event
     */
    private fun handleTrackSubscribed(track: Track, participant: Participant) {
        when (track) {
            is RemoteAudioTrack -> {
                Log.d("WebRTCConnection", "Audio track subscribed from ${participant.sid}")
                attachAgentAudioSink(track)
            }
            else -> {
                Log.d("WebRTCConnection", "Other track type subscribed: ${track.javaClass.simpleName}")
            }
        }
    }

    private fun handleTrackUnsubscribed(track: Track) {
        if (track is RemoteAudioTrack) detachAgentAudioSink(track)
    }

    private fun attachAgentAudioSink(track: RemoteAudioTrack) {
        synchronized(agentAudioSinks) {
            if (agentAudioSinks.containsKey(track)) return
            val sink = AudioFrameSink { latestConfig?.onAudioFrame }
            agentAudioSinks[track] = sink
            try {
                track.addSink(sink)
            } catch (t: Throwable) {
                agentAudioSinks.remove(track)
                Log.d("WebRTCConnection", "Failed to attach agent audio sink: ${t.message}")
            }
        }
    }

    private fun detachAgentAudioSink(track: RemoteAudioTrack) {
        synchronized(agentAudioSinks) {
            val sink = agentAudioSinks.remove(track) ?: return
            try {
                track.removeSink(sink)
            } catch (t: Throwable) {
                Log.d("WebRTCConnection", "Failed to detach agent audio sink: ${t.message}")
            }
        }
    }

    private fun detachAllAgentAudioSinks() {
        val snapshot = synchronized(agentAudioSinks) {
            agentAudioSinks.toMap().also { agentAudioSinks.clear() }
        }
        snapshot.forEach { (track, sink) ->
            try {
                track.removeSink(sink)
            } catch (t: Throwable) {
                Log.d("WebRTCConnection", "Failed to detach agent audio sink: ${t.message}")
            }
        }
    }

    /**
     * Handle data received event
     */
    private fun handleDataReceived(data: ByteArray, participant: Participant?) {
        try {
            val message = String(data)
            // Send message to processing queue
            messageChannel.trySend(message)
            // Invoke user onMessage callback with source classification
            try {
                val source = when (participant) {
                    is RemoteParticipant -> "ai"
                    is LocalParticipant -> "user"
                    else -> "ai"
                }
                latestConfig?.onMessage?.invoke(source, message)

                // Toggle mode based on source
                val mode = if (participant?.isSpeaking == true) ConversationMode.SPEAKING else ConversationMode.LISTENING
                latestConfig?.onModeChange?.invoke(mode)
            } catch (t: Throwable) {
                Log.d("WebRTCConnection", "onMessage callback threw: ${t.message}")
            }
        } catch (e: Exception) {
            Log.d("WebRTCConnection", "Failed to process received data: ${e.message}")
        }
    }

    /**
     * Start monitoring audio levels from remote participants (agent)
     */
    private fun startAudioLevelMonitoring() {
        // Cancel any existing monitoring
        audioLevelJob?.cancel()

        audioLevelJob = scope.launch {
            while (isActive) {
                try {
                    // Get the first remote participant (the agent)
                    val remoteParticipant = room.remoteParticipants.values.firstOrNull()

                    if (remoteParticipant != null) {
                        // Get audio level from the remote participant (0.0 to 1.0)
                        val level = remoteParticipant.audioLevel

                        // Update StateFlow
                        _audioLevel.value = level

                        // Invoke callback if provided
                        try {
                            latestConfig?.onAudioLevelChanged?.invoke(level)
                        } catch (t: Throwable) {
                            Log.d("WebRTCConnection", "onAudioLevelChanged callback threw: ${t.message}")
                        }
                    } else {
                        // No remote participant, reset to 0
                        _audioLevel.value = 0.0f
                    }
                } catch (e: Exception) {
                    Log.d("WebRTCConnection", "Error reading audio level: ${e.message}")
                }

                // Update every 50ms for smooth animation (20 FPS)
                delay(50)
            }
        }
    }

    /**
     * Update connection state and notify listeners
     */
    private fun updateConnectionState(newState: ConnectionState) {
        if (_connectionState.value != newState) {
            _connectionState.value = newState
            connectionStateListener?.invoke(newState)
            // Invoke user status change callback if provided
            try {
                latestConfig?.onStatusChange?.invoke(newState.toConversationStatus())
            } catch (_: Throwable) { }
        }
    }

    /**
     * Invoke onDisconnect callback with the given details.
     * This method ensures the callback is only invoked once per session.
     */
    private fun invokeOnDisconnect(details: DisconnectionDetails) {
        if (disconnectCallbackInvoked) return
        disconnectCallbackInvoked = true

        try {
            latestConfig?.onDisconnect?.invoke(details)
        } catch (t: Throwable) {
            Log.d("WebRTCConnection", "onDisconnect callback threw: ${t.message}")
        }
    }

    /**
     * Clean up resources when the connection is no longer needed
     */
    fun cleanup() {
        disconnect()
        scope.cancel()
    }

    private class AudioFrameSink(
        private val callback: () -> ((AudioFrame) -> Unit)?,
    ) : AudioTrackSink {
        override fun onData(
            audioData: ByteBuffer,
            bitsPerSample: Int,
            sampleRate: Int,
            numberOfChannels: Int,
            numberOfFrames: Int,
            absoluteCaptureTimestampMs: Long,
        ) {
            val cb = callback() ?: return
            val frame = AudioFrame(
                audioData = audioData.order(ByteOrder.LITTLE_ENDIAN),
                bitsPerSample = bitsPerSample,
                sampleRate = sampleRate,
                channelCount = numberOfChannels,
                numberOfFrames = numberOfFrames,
                absoluteCaptureTimestampMs = absoluteCaptureTimestampMs,
            )
            try {
                cb(frame)
            } catch (t: Throwable) {
                Log.d("WebRTCConnection", "onAudioFrame callback threw: ${t.message}")
            }
        }
    }
}