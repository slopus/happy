package io.elevenlabs.audio

import android.content.Context
import android.util.Log
import io.livekit.android.room.Room
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.room.track.RemoteAudioTrack
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * LiveKit-based audio implementation
 *
 * This class manages local audio tracks for microphone input, handles remote audio tracks
 * for agent speech, configures audio quality and encoding settings, and implements
 * audio focus management for Android.
 */
class LiveKitAudioManager(
    private val context: Context,
    private val room: Room,
    private val softwareMuteProcessor: SoftwareMuteProcessor? = null
) : AudioManager {

    private var localAudioTrack: LocalAudioTrack? = null
    private var remoteAudioTracks: MutableList<RemoteAudioTrack> = mutableListOf()

    private val _isRecording = MutableStateFlow(false)
    private val _isPlaying = MutableStateFlow(false)
    private val _isMuted = MutableStateFlow(false)
    private val _volume = MutableStateFlow(1.0f)

    private var audioStateListener: AudioStateListener? = null
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    init {
        // Configure audio session when manager is created
        AudioUtils.configureAudioSession(context)
    }

    override suspend fun startRecording() {
        if (_isRecording.value) {
            throw IllegalStateException("Already recording")
        }

        val hasPermission = hasAudioPermission()
        Log.d("LiveKitAudioManager", "Checking audio permission - hasPermission: $hasPermission, context: $context")

        if (!hasPermission) {
            throw SecurityException("Audio permission not granted")
        }

        try {
            // Prefer LiveKit API to enable microphone; handles internal track creation/publish
            Log.d("LiveKitAudioManager", "Enabling microphone for roomSid=${room.sid}")
            room.localParticipant.setMicrophoneEnabled(true)

            _isRecording.value = true
            audioStateListener?.onRecordingStateChanged(true)

        } catch (e: Exception) {
            audioStateListener?.onAudioError("Failed to start recording", e)
            Log.d("LiveKitAudioManager", "Failed to start recording - ${e.message}")
            throw e
        }
    }

    override suspend fun stopRecording() {
        if (!_isRecording.value) {
            return
        }

        try {
            // Disable microphone via LiveKit API
            Log.d("LiveKitAudioManager", "Disabling microphone for roomSid=${room.sid}")
            room.localParticipant.setMicrophoneEnabled(false)

            localAudioTrack = null

            _isRecording.value = false
            audioStateListener?.onRecordingStateChanged(false)

        } catch (e: Exception) {
            audioStateListener?.onAudioError("Failed to stop recording", e)
            Log.d("LiveKitAudioManager", "Failed to stop recording - ${e.message}")
        }
    }

    override suspend fun startPlayback() {
        if (_isPlaying.value) {
            throw IllegalStateException("Already playing")
        }

        try {
            _isPlaying.value = true
            audioStateListener?.onPlaybackStateChanged(true)

        } catch (e: Exception) {
            audioStateListener?.onAudioError("Failed to start playback", e)
            throw e
        }
    }

    override suspend fun stopPlayback() {
        if (!_isPlaying.value) {
            return
        }

        try {
            // Unsubscribe from remote audio tracks
            unsubscribeFromRemoteAudioTracks()

            _isPlaying.value = false
            audioStateListener?.onPlaybackStateChanged(false)

        } catch (e: Exception) {
            audioStateListener?.onAudioError("Failed to stop playback", e)
        }
    }

    override suspend fun setMicMuted(muted: Boolean) {
        try {
            softwareMuteProcessor?.setMuted(muted) ?: AudioUtils.setMicrophoneMuted(context, muted)
            _isMuted.value = muted
            audioStateListener?.onMuteStateChanged(muted)
        } catch (e: Exception) {
            audioStateListener?.onAudioError("Failed to set mute state", e)
        }
    }

    override suspend fun setMicrophoneMuted(muted: Boolean) {
        try {
            AudioUtils.setMicrophoneMuted(context, muted)
            _isMuted.value = muted
            audioStateListener?.onMuteStateChanged(muted)
        } catch (e: Exception) {
            audioStateListener?.onAudioError("Failed to set microphone mute state", e)
        }
    }

    override fun isMuted(): Boolean = _isMuted.value

    override fun setVolume(volume: Float) {
        val clampedVolume = volume.coerceIn(0.0f, 1.0f)

        try {
            // Set volume for all remote audio tracks from remote participants
            room.remoteParticipants.values.forEach { participant ->
                participant.audioTrackPublications.forEach { (_, track) ->
                    if (track is RemoteAudioTrack) {
                        track.setVolume(clampedVolume.toDouble())
                    }
                }
            }

            _volume.value = clampedVolume
            audioStateListener?.onVolumeChanged(clampedVolume)

        } catch (e: Exception) {
            audioStateListener?.onAudioError("Failed to set volume", e)
        }
    }

    override fun getVolume(): Float = _volume.value

    override fun hasAudioPermission(): Boolean = AudioUtils.hasAudioPermission(context)

    override fun isRecording(): Boolean = _isRecording.value

    override fun isPlaying(): Boolean = _isPlaying.value

    override fun setAudioStateListener(listener: AudioStateListener?) {
        this.audioStateListener = listener
    }

    override fun cleanup() {
        scope.launch {
            try {
                stopRecording()
                stopPlayback()
                AudioUtils.resetAudioSession(context)
            } catch (e: Exception) {
                // Log cleanup errors but don't throw
                Log.d("LiveKitAudioManager", "Error during audio cleanup: ${e.message}")
            }
        }
        scope.cancel()
    }

    /**
     * Unsubscribe from remote audio tracks
     */
    private fun unsubscribeFromRemoteAudioTracks() {
        remoteAudioTracks.clear()
    }

    /**
     * Add a remote audio track for playback
     * This should be called when a new remote participant joins
     */
    fun addRemoteAudioTrack(track: RemoteAudioTrack) {
        if (!remoteAudioTracks.contains(track)) {
            remoteAudioTracks.add(track)
        }
    }

    /**
     * Remove a remote audio track
     * This should be called when a remote participant leaves
     */
    fun removeRemoteAudioTrack(track: RemoteAudioTrack) {
        remoteAudioTracks.remove(track)
    }

    /**
     * Get current recording state as StateFlow for reactive UI updates
     */
    val recordingState: StateFlow<Boolean> = _isRecording

    /**
     * Get current playback state as StateFlow for reactive UI updates
     */
    val playbackState: StateFlow<Boolean> = _isPlaying

    /**
     * Get current mute state as StateFlow for reactive UI updates
     */
    val muteState: StateFlow<Boolean> = _isMuted

    /**
     * Get current volume as StateFlow for reactive UI updates
     */
    val volumeState: StateFlow<Float> = _volume
}