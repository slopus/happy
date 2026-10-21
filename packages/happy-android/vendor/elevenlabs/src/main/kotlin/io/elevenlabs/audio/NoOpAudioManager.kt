package io.elevenlabs.audio

/**
 * No-op AudioManager used by transports that do not capture or play audio
 * (e.g., the WebSocket text-only transport).
 *
 * Returning true from [hasAudioPermission] keeps callers that gate work on
 * permission from short-circuiting; the recording/playback methods are
 * intentionally inert.
 */
class NoOpAudioManager : AudioManager {

    private var listener: AudioStateListener? = null
    private var volume: Float = 1.0f

    override suspend fun startRecording() {}

    override suspend fun stopRecording() {}

    override suspend fun startPlayback() {}

    override suspend fun stopPlayback() {}

    override suspend fun setMicMuted(muted: Boolean) {}

    override suspend fun setMicrophoneMuted(muted: Boolean) {}

    override fun isMuted(): Boolean = false

    override fun setVolume(volume: Float) {
        this.volume = volume.coerceIn(0.0f, 1.0f)
    }

    override fun getVolume(): Float = volume

    override fun hasAudioPermission(): Boolean = true

    override fun isRecording(): Boolean = false

    override fun isPlaying(): Boolean = false

    override fun setAudioStateListener(listener: AudioStateListener?) {
        this.listener = listener
    }

    override fun cleanup() {}
}
