package com.slopus.happy.conversation

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonElement
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * `AgentContextUsage`: the provider's latest measurement of one agent's
 * conversation context, from the bootstrap and then replaced whole by each
 * `agent.context.updated`.
 */
@Immutable
data class ContextMeasurement(
    val approximate: Boolean,
    val contextTokens: Double,
    /** The configured hard limit; null for a custom model with no known limit. */
    val contextWindow: Double?,
    val modelId: String?,
    val providerId: String,
) {
    companion object {
        fun parse(value: JsonElement?): ContextMeasurement? {
            val o = value.obj ?: return null
            return ContextMeasurement(
                approximate = o["approximate"].bool ?: false,
                contextTokens = o["contextTokens"].num ?: return null,
                contextWindow = o["contextWindow"].num,
                modelId = o["modelId"].str,
                providerId = o["providerId"].str ?: return null,
            )
        }
    }
}

/** A model's own context window and where the daemon compacts it, as `GET /v0/config` defines the model. */
@Immutable
data class ContextWindow(val tokens: Long?, val autoCompact: Long?)

/**
 * How much of the model's context window a conversation has spent, as the
 * composer's meter shows it (iOS `AgentContextGauge`, 083c30df4; desktop's
 * `contextGaugeDerive` and ContextMeter).
 */
@Immutable
data class ContextGauge(
    /** Tokens already spent in the window, never past it. */
    val usedTokens: Long,
    val totalTokens: Long,
    /** Where the daemon compacts on its own, below the window; null when the model publishes none. */
    val compactTokens: Long? = null,
    /** The count is estimated rather than reported. */
    val approximate: Boolean = false,
    /** False while the window is known but nothing has been measured yet. */
    val measured: Boolean = true,
) {
    enum class Tone { Ample, Compact, Critical }

    /** The share of the window spent, 0–1; none before a measurement. */
    val fraction: Double get() = if (totalTokens <= 0 || !measured) 0.0 else usedTokens.coerceIn(0, totalTokens).toDouble() / totalTokens

    val percent: Int get() = (fraction * 100).roundToInt()

    /** Where the notch sits, as a share of the track. */
    val compactFraction: Double get() = compactTokens?.takeIf { it in 1 until totalTokens }?.let { it.toDouble() / totalTokens } ?: DEFAULT_COMPACT_FRACTION

    /** Quiet with room to spare; coloured only once compacting is next. */
    val tone: Tone get() = when {
        fraction >= compactFraction -> Tone.Critical
        fraction >= compactFraction * (1 - WARNING_MARGIN) -> Tone.Compact
        else -> Tone.Ample
    }

    companion object {
        /** Where compaction is marked when the model publishes no threshold. */
        const val DEFAULT_COMPACT_FRACTION = 0.75
        /** The warning colour comes within this share of the compaction point, the error colour at it. */
        const val WARNING_MARGIN = 0.2

        /**
         * The meter for a conversation: its last measurement against its
         * model's window or, before the first, the window [selection]'s
         * model declares with nothing spent. Null when no window is known.
         */
        fun derive(catalog: ModeCatalog?, context: ContextMeasurement?, selection: Mode?): ContextGauge? {
            // The daemon compacts at the model's published threshold; one at or past the window is none.
            fun compact(window: ContextWindow?, total: Long) = window?.autoCompact?.takeIf { it in 1 until total }
            if (context == null) {
                val window = selection?.let { catalog?.windows?.get(it.modelId) } ?: return null
                val total = window.tokens?.takeIf { it > 0 } ?: return null
                return ContextGauge(0, total, compact(window, total), measured = false)
            }
            val window = context.modelId?.let { catalog?.windows?.get(it) }
            val total = (context.contextWindow?.toLong() ?: window?.tokens)?.takeIf { it > 0 } ?: return null
            val used = context.contextTokens.roundToLong().coerceIn(0, total)
            return ContextGauge(used, total, compact(window, total), context.approximate)
        }

        /** `tokensFormat`: 950, 1.2k, 84k, 128k, 1M. */
        fun tokens(count: Long): String {
            if (count < 1000) return count.coerceAtLeast(0).toString()
            val thousands = count / 1000.0
            if (thousands < 1000) return if (thousands < 100) trimmed(thousands) + "k" else thousands.roundToLong().toString() + "k"
            return trimmed(thousands / 1000) + "M"
        }

        /** One decimal without a trailing ".0", a half rounded up as `toFixed(1)` rounds 1.25. */
        private fun trimmed(value: Double): String {
            val tenths = (value * 10).roundToLong()
            return if (tenths % 10 == 0L) (tenths / 10).toString() else "${tenths / 10}.${tenths % 10}"
        }
    }
}
