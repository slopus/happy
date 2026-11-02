package com.slopus.happy.agent

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.util.Log
import kotlin.math.PI
import kotlin.math.ceil
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Desktop's completion chime (completionChime.ts): two sine notes, E5 then
 * A5 0.11 s later, each 0.28 s, under a 15 ms exponential attack to 0.12 and
 * an exponential decay to 0.42 s. The samples are made once and played as a
 * sonification, so the phone's silent and vibrate modes keep it quiet. A
 * missing or busy audio device never reaches the link that asked.
 */
class CompletionChime(context: Context) {
    private val audio = context.applicationContext.getSystemService(AudioManager::class.java)
    private val samples by lazy { samples(RATE) }

    fun play() {
        if (audio?.ringerMode != AudioManager.RINGER_MODE_NORMAL) return
        try {
            val track = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build(),
                )
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(samples.size * 2)
                .build()
            track.write(samples, 0, samples.size)
            track.setNotificationMarkerPosition(samples.size)
            track.setPlaybackPositionUpdateListener(object : AudioTrack.OnPlaybackPositionUpdateListener {
                override fun onMarkerReached(track: AudioTrack) = track.release()
                override fun onPeriodicNotification(track: AudioTrack) = Unit
            })
            track.play()
            Log.i(TAG, "chime")
        } catch (error: Exception) {
            Log.w(TAG, "chime failed", error)
        }
    }

    companion object {
        private const val TAG = "CompletionChime"
        private const val RATE = 44_100
        const val SECONDS = 0.42
        private const val ATTACK = 0.015
        private const val PEAK = 0.12
        private const val FLOOR = 0.0001
        private const val NOTE = 0.28
        private val NOTES = listOf(659.25 to 0.0, 880.0 to 0.11)

        /** The chime at [rate] samples a second, as desktop's `completionChimeRender` computes it. */
        fun samples(rate: Int): ShortArray = ShortArray(ceil(rate * SECONDS).toInt()) { index ->
            val time = index.toDouble() / rate
            val envelope = if (time < ATTACK) {
                FLOOR * (PEAK / FLOOR).pow(time / ATTACK)
            } else {
                PEAK * (FLOOR / PEAK).pow((time - ATTACK) / (SECONDS - ATTACK))
            }
            var value = 0.0
            for ((frequency, delay) in NOTES) {
                if (time >= delay && time < delay + NOTE) value += sin(2 * PI * frequency * (time - delay))
            }
            (value * envelope * Short.MAX_VALUE).roundToInt().toShort()
        }
    }
}
