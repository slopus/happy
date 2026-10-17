package io.elevenlabs.models

import java.nio.ByteBuffer

/**
 * One decoded PCM chunk from the agent's remote audio track. [audioData] is little-endian and
 * only valid for the duration of the callback — copy what you need.
 */
data class AudioFrame(
    val audioData: ByteBuffer,
    val bitsPerSample: Int,
    val sampleRate: Int,
    val channelCount: Int,
    val numberOfFrames: Int,
    val absoluteCaptureTimestampMs: Long,
)
