package com.slopus.happy.call

import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * The sound of a call that ended without the person asking
 * ([CallEnding.isUnexpected]): the platform's own call-drop tone
 * (`ToneGenerator.TONE_CDMA_CALLDROP_LITE`), no speech. Played on the system
 * stream once the call's audio is let go, so it needs none of it, and only in
 * the normal ringer mode: silent and vibrate keep it quiet, as the completion
 * chime is (iOS `CallDropSound`).
 */
class CallDropSound(context: Context) {
    private val audio = context.applicationContext.getSystemService(AudioManager::class.java)

    fun play() {
        if (audio?.ringerMode != AudioManager.RINGER_MODE_NORMAL) return
        try {
            val tone = ToneGenerator(AudioManager.STREAM_SYSTEM, VOLUME)
            if (!tone.startTone(ToneGenerator.TONE_CDMA_CALLDROP_LITE, MILLIS)) {
                tone.release()
                return
            }
            Handler(Looper.getMainLooper()).postDelayed(tone::release, MILLIS + 200L)
            Log.i(TAG, "call drop tone")
        } catch (error: RuntimeException) {
            Log.w(TAG, "call drop tone failed", error)
        }
    }

    companion object {
        private const val TAG = "CallDropSound"
        private const val VOLUME = 80
        private const val MILLIS = 900
    }
}
