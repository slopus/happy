package io.elevenlabs.audio

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager as SystemAudioManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * Audio utilities for Android-specific functionality
 *
 * This object provides utility functions for runtime permission handling for microphone access,
 * audio focus management for interruptions, volume control and routing configuration,
 * and optimal audio settings for conversation quality.
 */
object AudioUtils {
    /**
     * Check if audio recording permission is granted
     * @param context Android context
     * @return true if permission is granted
     */
    fun hasAudioPermission(context: Context): Boolean {
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
    }

    /**
     * Configure audio session for voice communication
     * @param context Android context
     */
    fun configureAudioSession(context: Context) {
        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as SystemAudioManager

        // Set audio mode for voice communication
        audioManager.mode = SystemAudioManager.MODE_IN_COMMUNICATION

        // Request audio focus for voice calls
        requestAudioFocus(audioManager)
    }

    /**
     * Request audio focus for media playback
     * @param audioManager System audio manager
     */
    private fun requestAudioFocus(audioManager: SystemAudioManager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val audioAttributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()

            val focusRequest = AudioFocusRequest.Builder(SystemAudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(audioAttributes)
                .setAcceptsDelayedFocusGain(true)
                .setOnAudioFocusChangeListener { /* no-op */ }
                .build()

            audioManager.requestAudioFocus(focusRequest)
        } else {
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(
                { /* no-op */ },
                SystemAudioManager.STREAM_VOICE_CALL,
                SystemAudioManager.AUDIOFOCUS_GAIN
            )
        }
    }

    /**
     * Abandon audio focus
     * @param context Android context
     */
    fun abandonAudioFocus(context: Context) {
        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as SystemAudioManager

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // For API 26+, a reference to the AudioFocusRequest would be required to abandon
            // Focus relinquish is intentionally a no-op here due to simplified focus handling
        } else {
            @Suppress("DEPRECATION")
            audioManager.abandonAudioFocus { /* no-op */ }
        }
    }

    /**
     * Set microphone mute state
     * @param context Android context
     * @param muted true to mute microphone, false to unmute
     */
    fun setMicrophoneMuted(context: Context, muted: Boolean) {
        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as SystemAudioManager
        audioManager.isMicrophoneMute = muted
    }

    /**
     * Reset audio session to normal mode
     * @param context Android context
     */
    fun resetAudioSession(context: Context) {
        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as SystemAudioManager
        audioManager.mode = SystemAudioManager.MODE_NORMAL
        abandonAudioFocus(context)
    }
}