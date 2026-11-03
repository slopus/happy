package com.slopus.happy.conversation

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonObject
import kotlin.math.roundToInt

/**
 * One account's plan usage (iOS `AccountUsage`): desktop's
 * `happyAgentComposerModelUsageProject` for one `GET /v0/usage` entry.
 */
@Immutable
data class AccountUsage(
    val week: Window? = null,
    val session: Window? = null,
    /** Milliseconds. */
    val updatedAt: Long? = null,
    val refreshing: Boolean = false,
    val refreshError: String? = null,
    /** The account has spent its limit. */
    val limited: Boolean = false,
    /** When it is usable again, if the service said; milliseconds. */
    val limitResets: Long? = null,
    /** Its sign-in is missing or was refused, so nothing can be sent to it. */
    val signedOut: Boolean = false,
) {
    @Immutable
    data class Window(
        val kind: Kind,
        val usedPercent: Double,
        /** Milliseconds. */
        val resetsAt: Long? = null,
        val capturedAt: Long? = null,
        /** The account can't be used until this window starts over. */
        val blocking: Boolean = false,
    ) {
        enum class Kind { Week, Session }

        /** What is left, 0–100, as the rings read it. */
        val left: Int get() = (100 - usedPercent).coerceIn(0.0, 100.0).roundToInt()
    }

    /** How a ring is coloured. */
    enum class Tone { Ample, Low, Critical }

    /** The one window an account warns about, on the closed model chip and its service's heading alike. */
    @Immutable
    data class Warning(val window: Window, val left: Int, val tone: Tone)

    /**
     * Desktop's `usageWarning`: the week when it is low, otherwise the
     * session, and none while both have room. A window holding a spent
     * account back is critical whatever its number says.
     */
    val warning: Warning?
        get() {
            for (window in listOfNotNull(week, session)) {
                val tone = tone(window.left, window.blocking)
                if (tone != Tone.Ample) return Warning(window, window.left, tone)
            }
            return null
        }

    companion object {
        fun tone(left: Int, blocked: Boolean): Tone = when {
            blocked || left < 10 -> Tone.Critical
            left < 25 -> Tone.Low
            else -> Tone.Ample
        }

        /** Every account with a reading, a read in flight, a failed read or a lost sign-in, by provider id. */
        fun project(response: JsonObject): Map<String, AccountUsage> {
            val usage = LinkedHashMap<String, AccountUsage>()
            for (item in response["providers"].arr.orEmpty()) {
                val entry = item.obj ?: continue
                val providerId = entry["providerId"].str ?: continue
                val reading = entry["usage"].obj
                val windows = reading?.get("windows").obj
                fun raw(key: String) = windows?.get(key).obj?.let { w -> w["usedPercent"].num?.let { Raw(it, w["resetsAt"].num, w["capturedAt"].num) } }
                val fiveHour = raw("fiveHour")
                val weekly = raw("weekly")
                val monthly = raw("monthly")
                val hasPlan = fiveHour != null || weekly != null || reading?.get("planName").str != null
                val refreshedAt = entry["refreshedAt"].num ?: if (hasPlan) reading?.get("capturedAt").num else null
                val refreshError = entry["refreshError"].str ?: entry["error"].str
                val refreshing = entry["refreshing"].bool ?: false
                val signedOut = entry["signIn"].str == "signed_out"
                if (!hasPlan && !refreshing && refreshError == null && !signedOut) continue
                val exhausted = hasPlan && reading?.get("exhausted").bool == true
                // Every full window holds a spent account back; one blocked with none full waits on its fullest.
                val blocking: List<Raw> = if (exhausted) {
                    val all = listOfNotNull(fiveHour, weekly, monthly)
                    all.filter { it.used >= 100 }.ifEmpty { all.sortedByDescending { it.used }.take(1) }
                } else emptyList()
                fun window(kind: Window.Kind, raw: Raw?) = raw?.let {
                    Window(kind, it.used, it.resets?.toLong(), it.captured?.toLong(), blocking.any { b -> b === it })
                }
                usage[providerId] = AccountUsage(
                    week = if (hasPlan) window(Window.Kind.Week, weekly) else null,
                    session = if (hasPlan) window(Window.Kind.Session, fiveHour) else null,
                    updatedAt = refreshedAt?.toLong(),
                    refreshing = refreshing,
                    refreshError = refreshError,
                    limited = exhausted,
                    limitResets = if (exhausted) blocking.mapNotNull { it.resets }.maxOrNull()?.toLong() else null,
                    signedOut = signedOut,
                )
            }
            return usage
        }

        private class Raw(val used: Double, val resets: Double?, val captured: Double?)
    }
}
