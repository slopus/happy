package io.elevenlabs.audio

/**
 * Interface for managing audio capture, playback, and processing for voice conversations
 *
 * This interface provides comprehensive audio management including microphone input
 * handling with permission management, speaker output control and volume management,
 * mute/unmute functionality, and audio session configuration for optimal quality.
 */
interface AudioManager {

    /**
     * Start recording from the microphone
     * @throws SecurityException if audio permission is not granted
     * @throws IllegalStateException if already recording
     */
    suspend fun startRecording()

    /**
     * Stop recording from the microphone
     */
    suspend fun stopRecording()

    /**
     * Start audio playback for incoming audio
     * @throws IllegalStateException if already playing
     */
    suspend fun startPlayback()

    /**
     * Stop audio playback
     */
    suspend fun stopPlayback()

    /**
     * Set the microphone mute state
     * @param muted true to mute microphone, false to unmute
     */
    suspend fun setMicMuted(muted: Boolean)

    /**
     * Mute the microphone at the OS/track level
     * @param muted true to mute, false to unmute
     */
    suspend fun setMicrophoneMuted(muted: Boolean)

    /**
     * Check if the microphone is currently muted
     * @return true if muted, false if unmuted
     */
    fun isMuted(): Boolean

    /**
     * Set the playback volume
     * @param volume Volume level from 0.0 (silent) to 1.0 (maximum)
     */
    fun setVolume(volume: Float)

    /**
     * Get the current playback volume
     * @return Volume level from 0.0 to 1.0
     */
    fun getVolume(): Float

    /**
     * Check if audio recording permission is granted
     * @return true if permission is granted, false otherwise
     */
    fun hasAudioPermission(): Boolean

    /**
     * Check if audio recording is currently active
     * @return true if recording, false otherwise
     */
    fun isRecording(): Boolean

    /**
     * Check if audio playback is currently active
     * @return true if playing, false otherwise
     */
    fun isPlaying(): Boolean

    /**
     * Set listener for audio state changes
     * @param listener Callback for audio state events
     */
    fun setAudioStateListener(listener: AudioStateListener?)

    /**
     * Clean up audio resources
     * Should be called when audio management is no longer needed
     */
    fun cleanup()
}

/**
 * Listener interface for audio state changes
 */
interface AudioStateListener {
    /**
     * Called when recording state changes
     * @param isRecording true if recording started, false if stopped
     */
    fun onRecordingStateChanged(isRecording: Boolean) {}

    /**
     * Called when playback state changes
     * @param isPlaying true if playback started, false if stopped
     */
    fun onPlaybackStateChanged(isPlaying: Boolean) {}

    /**
     * Called when mute state changes
     * @param isMuted true if muted, false if unmuted
     */
    fun onMuteStateChanged(isMuted: Boolean) {}

    /**
     * Called when volume changes
     * @param volume New volume level (0.0 to 1.0)
     */
    fun onVolumeChanged(volume: Float) {}

    /**
     * Called when an audio error occurs
     * @param error Description of the error
     * @param exception Optional exception that caused the error
     */
    fun onAudioError(error: String, exception: Throwable? = null) {}
}
