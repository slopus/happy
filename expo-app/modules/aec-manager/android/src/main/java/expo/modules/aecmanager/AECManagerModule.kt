package expo.modules.aecmanager

import android.content.Context
import android.media.AudioManager
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AECManagerModule : Module() {
    companion object {
        private const val TAG = "AECManagerModule"
    }

    private var aec: AcousticEchoCanceler? = null
    private var ns: NoiseSuppressor? = null
    private var agc: AutomaticGainControl? = null
    private var currentAudioSessionId: Int = 0

    private val context: Context
        get() = requireNotNull(appContext.reactContext)

    override fun definition() = ModuleDefinition {
        Name("AECManager")

        Function("enableAEC") { audioSessionId: Int ->
            enableAECInternal(audioSessionId)
        }

        Function("disableAEC") {
            disableAECInternal()
        }

        Function("setVoiceCommunicationMode") {
            setVoiceCommunicationModeInternal()
        }

        Function("resetAudioMode") {
            resetAudioModeInternal()
        }

        Function("isAECAvailable") {
            AcousticEchoCanceler.isAvailable()
        }

        Function("isNSAvailable") {
            NoiseSuppressor.isAvailable()
        }

        Function("isAGCAvailable") {
            AutomaticGainControl.isAvailable()
        }
    }

    private fun enableAECInternal(audioSessionId: Int) {
        if (audioSessionId == 0) {
            Log.w(TAG, "Invalid audio session ID: 0")
            return
        }

        // Release previous effects if session changed
        if (currentAudioSessionId != audioSessionId) {
            releaseEffects()
        }

        currentAudioSessionId = audioSessionId

        // Enable Acoustic Echo Canceler
        if (AcousticEchoCanceler.isAvailable()) {
            try {
                aec = AcousticEchoCanceler.create(audioSessionId)
                aec?.enabled = true
                Log.i(TAG, "AcousticEchoCanceler enabled for session $audioSessionId")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to create AcousticEchoCanceler: ${e.message}")
            }
        } else {
            Log.w(TAG, "AcousticEchoCanceler not available on this device")
        }

        // Enable Noise Suppressor
        if (NoiseSuppressor.isAvailable()) {
            try {
                ns = NoiseSuppressor.create(audioSessionId)
                ns?.enabled = true
                Log.i(TAG, "NoiseSuppressor enabled for session $audioSessionId")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to create NoiseSuppressor: ${e.message}")
            }
        }

        // Enable Automatic Gain Control
        if (AutomaticGainControl.isAvailable()) {
            try {
                agc = AutomaticGainControl.create(audioSessionId)
                agc?.enabled = true
                Log.i(TAG, "AutomaticGainControl enabled for session $audioSessionId")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to create AutomaticGainControl: ${e.message}")
            }
        }
    }

    private fun disableAECInternal() {
        releaseEffects()
        currentAudioSessionId = 0
    }

    private fun releaseEffects() {
        aec?.let {
            try {
                it.enabled = false
                it.release()
                Log.i(TAG, "AcousticEchoCanceler released")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to release AcousticEchoCanceler: ${e.message}")
            }
        }
        aec = null

        ns?.let {
            try {
                it.enabled = false
                it.release()
                Log.i(TAG, "NoiseSuppressor released")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to release NoiseSuppressor: ${e.message}")
            }
        }
        ns = null

        agc?.let {
            try {
                it.enabled = false
                it.release()
                Log.i(TAG, "AutomaticGainControl released")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to release AutomaticGainControl: ${e.message}")
            }
        }
        agc = null
    }

    private fun setVoiceCommunicationModeInternal() {
        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        Log.i(TAG, "Audio mode set to MODE_IN_COMMUNICATION")
    }

    private fun resetAudioModeInternal() {
        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audioManager.mode = AudioManager.MODE_NORMAL
        Log.i(TAG, "Audio mode reset to MODE_NORMAL")
    }
}
