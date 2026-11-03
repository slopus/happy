package com.slopus.happy.conversation

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateMapOf
import kotlin.math.floor

/** Where one picture of an outgoing message is on its way to the computer (iOS `UploadPhase`). */
@Immutable
sealed interface UploadPhase {
    /** Waiting its turn, or its files going first: the ring's short arc turns. */
    data object Preparing : UploadPhase

    /** This share of its bytes written to the link. */
    data class Uploading(val share: Float) : UploadPhase

    /** All of it is there. */
    data object Done : UploadPhase
}

/**
 * Every outgoing picture's upload, by [pictureKey] (iOS
 * `UploadProgressBoard`). The send writes from whatever thread writes the
 * body; each tile reads its own key, so a share moving redraws that ring
 * and nothing else. Shares finer than [STEP] move nothing.
 */
@Stable
class UploadBoard {
    private val phases = mutableStateMapOf<String, UploadPhase>()

    fun phase(key: String): UploadPhase? = phases[key]

    internal fun set(key: String, phase: UploadPhase) {
        val shown = if (phase is UploadPhase.Uploading) UploadPhase.Uploading(floor(phase.share.coerceIn(0f, 1f) / STEP) * STEP) else phase
        if (phases[key] != shown) phases[key] = shown
    }

    /** Message [id]'s pictures are forgotten: it went, failed, or was taken back. */
    internal fun clear(id: String) {
        val prefix = "$id:"
        phases.keys.filter { it.startsWith(prefix) }.forEach { phases.remove(it) }
    }

    companion object {
        /** A ring is a few hundred pixels round at most. */
        const val STEP = 1f / 512

        /** The [index]th inline picture of message [id]. */
        fun pictureKey(id: String, index: Int) = "$id:${index + 1}"
    }
}

/**
 * Where each inline picture's base64 is in a request body, so the bytes
 * written say how far each picture is (iOS `UploadRanges`).
 */
internal class UploadRanges(body: ByteArray, encoded: List<String>) {
    private val ranges: List<IntRange>

    init {
        var from = 0
        ranges = encoded.map { string ->
            val probe = string.substring(0, minOf(64, string.length)).toByteArray()
            val found = if (probe.isEmpty()) -1 else indexOf(body, probe, from)
            if (found < 0) from until from else (found until minOf(body.size, found + string.length)).also { from = it.last + 1 }
        }
    }

    /** Each picture's share written once [sent] bytes of the body are. */
    fun shares(sent: Int): List<Float> = ranges.map { range ->
        if (range.isEmpty()) (if (sent > range.first) 1f else 0f)
        else ((sent - range.first).toFloat() / (range.last - range.first + 1)).coerceIn(0f, 1f)
    }

    private companion object {
        fun indexOf(body: ByteArray, probe: ByteArray, from: Int): Int {
            outer@ for (i in from..body.size - probe.size) {
                for (j in probe.indices) if (body[i + j] != probe[j]) continue@outer
                return i
            }
            return -1
        }
    }
}
