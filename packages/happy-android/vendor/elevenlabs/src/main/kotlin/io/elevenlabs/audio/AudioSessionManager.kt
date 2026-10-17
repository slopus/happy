package io.elevenlabs.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager as SystemAudioManager
import android.os.Build
import androidx.annotation.RequiresApi
import android.util.Log

/**
 * Audio session management for optimal conversation quality
 *
 * This class handles audio session configuration, focus management,
 * and quality optimization for voice conversations.
 */
class AudioSessionManager(private val context: Context) {

    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as SystemAudioManager
    private var audioFocusRequest: AudioFocusRequest? = null
    private var hasAudioFocus = false

    private val audioFocusChangeListener = SystemAudioManager.OnAudioFocusChangeListener { focusChange ->
        handleAudioFocusChange(focusChange)
    }

    /**
     * Configure audio session for voice communication
     */
    fun configureForVoiceCall() {
        try {
            // Set audio mode for voice communication
            audioManager.mode = SystemAudioManager.MODE_IN_COMMUNICATION

            // Request audio focus
            requestAudioFocus()

            // Ensure audio routes to speaker (important on emulator/voice calls)
            setSpeakerphoneEnabledCompat(true)
            val vol = audioManager.getStreamVolume(SystemAudioManager.STREAM_VOICE_CALL)
            val max = audioManager.getStreamMaxVolume(SystemAudioManager.STREAM_VOICE_CALL)
            Log.d("AudioSessionManager", "MODE_IN_COMMUNICATION, speakerphoneOn=${isSpeakerphoneEnabledCompat()}, voiceVol=$vol/$max")

        } catch (e: Exception) {
            Log.d("AudioSessionManager", "Failed to configure audio session: ${e.message}")
        }
    }

    /**
     * Configure audio session for media playback
     */
    fun configureForMedia() {
        try {
            // Set audio mode for media playback
            audioManager.mode = SystemAudioManager.MODE_NORMAL

            // Request audio focus
            requestAudioFocus()

        } catch (e: Exception) {
            Log.d("AudioSessionManager", "Failed to configure audio session for media: ${e.message}")
        }
    }

    /**
     * Request audio focus for the current session
     */
    private fun requestAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            requestAudioFocusV26()
        } else {
            requestAudioFocusLegacy()
        }
    }

    /**
     * Request audio focus for Android O and above
     */
    @RequiresApi(Build.VERSION_CODES.O)
    private fun requestAudioFocusV26() {
        val audioAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()

        audioFocusRequest = AudioFocusRequest.Builder(SystemAudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(audioAttributes)
            .setAcceptsDelayedFocusGain(true)
            .setOnAudioFocusChangeListener(audioFocusChangeListener)
            .build()

        val result = audioManager.requestAudioFocus(audioFocusRequest!!)
        hasAudioFocus = result == SystemAudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    /**
     * Request audio focus for devices below Android O
     */
    @Suppress("DEPRECATION")
    private fun requestAudioFocusLegacy() {
        val result = audioManager.requestAudioFocus(
            audioFocusChangeListener,
            SystemAudioManager.STREAM_VOICE_CALL,
            SystemAudioManager.AUDIOFOCUS_GAIN
        )
        hasAudioFocus = result == SystemAudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    /**
     * Abandon audio focus
     */
    fun abandonAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let { request ->
                audioManager.abandonAudioFocusRequest(request)
            }
        } else {
            @Suppress("DEPRECATION")
            audioManager.abandonAudioFocus(audioFocusChangeListener)
        }
        hasAudioFocus = false
    }

    /**
     * Handle audio focus changes
     */
    private fun handleAudioFocusChange(focusChange: Int) {
        when (focusChange) {
            SystemAudioManager.AUDIOFOCUS_GAIN -> {
                hasAudioFocus = true
                onAudioFocusGained()
            }
            SystemAudioManager.AUDIOFOCUS_LOSS -> {
                hasAudioFocus = false
                onAudioFocusLost()
            }
            SystemAudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                hasAudioFocus = false
                onAudioFocusLostTransient()
            }
            SystemAudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                onAudioFocusLostCanDuck()
            }
        }
    }

    /**
     * Called when audio focus is gained
     */
    private fun onAudioFocusGained() {
        // Resume normal audio operations
        Log.d("AudioSessionManager", "Audio focus gained - resuming audio")
    }

    /**
     * Called when audio focus is lost permanently
     */
    private fun onAudioFocusLost() {
        // Stop all audio operations
        Log.d("AudioSessionManager", "Audio focus lost - stopping audio")
    }

    /**
     * Called when audio focus is lost temporarily
     */
    private fun onAudioFocusLostTransient() {
        // Pause audio operations
        Log.d("AudioSessionManager", "Audio focus lost temporarily - pausing audio")
    }

    /**
     * Called when audio focus is lost but can duck (lower volume)
     */
    private fun onAudioFocusLostCanDuck() {
        // Lower volume but continue playing
        Log.d("AudioSessionManager", "Audio focus lost - ducking volume")
    }

    /**
     * Set speakerphone enabled/disabled using modern API when available
     */
    private fun setSpeakerphoneEnabledCompat(enabled: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Use modern communication device API (Android 12+)
            setSpeakerphoneModern(enabled)
        } else {
            // Fallback to deprecated API for older devices
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = enabled
        }
    }

    /**
     * Check if speakerphone is enabled using modern API when available
     */
    private fun isSpeakerphoneEnabledCompat(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Use modern communication device API (Android 12+)
            getSpeakerphoneStateModern()
        } else {
            // Fallback to deprecated API for older devices
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn
        }
    }

    /**
     * Set speakerphone using modern communication device API (Android 12+)
     */
    @RequiresApi(Build.VERSION_CODES.S)
    private fun setSpeakerphoneModern(enabled: Boolean) {
        if (enabled) {
            // Enable speakerphone by setting communication device to built-in speaker
            val speakerDevice = audioManager.availableCommunicationDevices.find {
                it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
            }
            speakerDevice?.let { device ->
                audioManager.setCommunicationDevice(device)
            } ?: run {
                Log.w("AudioSessionManager", "Built-in speaker device not found, falling back to deprecated API")
                @Suppress("DEPRECATION")
                audioManager.isSpeakerphoneOn = true
            }
        } else {
            // Disable speakerphone by clearing communication device
            audioManager.clearCommunicationDevice()
        }
    }

    /**
     * Check speakerphone state using modern communication device API (Android 12+)
     */
    @RequiresApi(Build.VERSION_CODES.S)
    private fun getSpeakerphoneStateModern(): Boolean {
        val currentDevice = audioManager.communicationDevice
        return currentDevice?.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
    }

    /**
     * Reset audio session to normal state
     */
    fun resetAudioSession() {
        try {
            abandonAudioFocus()
            audioManager.mode = SystemAudioManager.MODE_NORMAL
            setSpeakerphoneEnabledCompat(false)

        } catch (e: Exception) {
            Log.d("AudioSessionManager", "Failed to reset audio session: ${e.message}")
        }
    }

    /**
     * Check if we currently have audio focus
     */
    fun hasAudioFocus(): Boolean = hasAudioFocus

    /**
     * Get current audio mode
     */
    fun getCurrentAudioMode(): Int = audioManager.mode

    /**
     * Set speaker phone enabled/disabled
     */
    fun setSpeakerPhoneEnabled(enabled: Boolean) {
        setSpeakerphoneEnabledCompat(enabled)
    }

    /**
     * Check if speaker phone is enabled
     */
    fun isSpeakerPhoneEnabled(): Boolean = isSpeakerphoneEnabledCompat()

    /**
     * Set microphone mute state
     */
    fun setMicrophoneMuted(muted: Boolean) {
        audioManager.isMicrophoneMute = muted
    }

    /**
     * Check if microphone is muted
     */
    fun isMicrophoneMuted(): Boolean = audioManager.isMicrophoneMute
}