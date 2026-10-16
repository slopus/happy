package com.slopus.happy.usage

import com.slopus.happy.chat.ContextUsage
import com.slopus.happy.chat.UsageLimits
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

/** AgentInput.tsx `formatTokenCount`: 950, 12k, 1.5M, 12M. */
fun formatTokenCount(tokens: Double): String {
    if (tokens < 1000) return max(0L, jsRound(tokens)).toString()
    if (tokens < 999_500) return "${jsRound(tokens / 1000)}k"
    val millions = tokens / 1_000_000
    if (millions >= 10) return "${jsRound(millions)}M"
    val tenths = jsRound(millions * 10)
    return if (tenths % 10 == 0L) "${tenths / 10}M" else "${tenths / 10}.${tenths % 10}M"
}

/** JS `Math.round`: halves go up, toward +∞. */
private fun jsRound(value: Double): Long = Math.floor(value + 0.5).roundToLong()

enum class ContextLevel { Normal, Warning, Critical }

/** What the usage row shows for the context: the percent used, the exact counts, and how loud. */
data class ContextStatus(val percent: Int, val used: String, val total: String, val level: ContextLevel)

/**
 * AgentInput.tsx `getContextStatus`. Nothing until the session reports its
 * window (a guessed denominator would later "refill"). Critical at 5% or
 * less remaining, warning at 10% or less, otherwise only when
 * [alwaysShow] (in the secondary colour). A context size of 0 shows nothing.
 */
fun contextStatus(usage: ContextUsage?, alwaysShow: Boolean): ContextStatus? {
    usage ?: return null
    val size = usage.contextSize.toDouble()
    val window = usage.contextWindow?.toDouble() ?: return null
    if (size == 0.0 || window <= 0) return null
    val used = max(0.0, min(100.0, size / window * 100))
    val remaining = 100 - used
    val level = when {
        remaining <= 5 -> ContextLevel.Critical
        remaining <= 10 -> ContextLevel.Warning
        alwaysShow -> ContextLevel.Normal
        else -> return null
    }
    return ContextStatus(jsRound(used).toInt(), formatTokenCount(size), formatTokenCount(window), level)
}

/** sessionStatusBar.ts `UsageLimitRow`: utilization rounded and clamped to 0–100, or null. */
data class UsageLimitRow(val id: String, val label: String, val utilization: Int?, val resetsAt: Double?)

private val KNOWN_WINDOWS = listOf("five_hour", "seven_day")

/** sessionStatusBar.ts `getUsageLimitRows`: every window, five_hour and seven_day first. */
fun usageLimitRows(limits: UsageLimits?): List<UsageLimitRow> {
    limits ?: return emptyList()
    fun rank(id: String) = KNOWN_WINDOWS.indexOf(id).let { if (it < 0) KNOWN_WINDOWS.size else it }
    return limits.windows.sortedBy { rank(it.id) }.map { w ->
        UsageLimitRow(
            id = w.id,
            label = w.label ?: w.id.replace('_', ' '),
            utilization = w.utilization?.let { jsRound(min(100.0, max(0.0, it))).toInt() },
            resetsAt = w.resetsAt,
        )
    }
}

/** `getUsageLimitDisplayPercentage`: utilization is percent used; "remaining" flips it for display. */
fun usageLimitDisplayPercentage(utilization: Int, showRemaining: Boolean): Int = if (showRemaining) 100 - utilization else utilization

/** One line of the week popup: "Session · 32%", then the reset moment. */
data class UsagePopupRow(val key: String, val percent: Int, val resetsAt: Double?)

/** The usage row's model: the context gauge, the week figure, and the popup behind it. */
data class UsageRowState(val context: ContextStatus?, val weekPercent: Int?, val popup: List<UsagePopupRow>) {
    val isEmpty: Boolean get() = context == null && weekPercent == null
}

/**
 * AgentInput.tsx's usage row inputs. Only the session (`five_hour`) and
 * week (`seven_day`) windows matter to users; the week figure shows only
 * alongside the context status, or always with [alwaysShowContextSize].
 */
fun usageRowState(usage: ContextUsage?, limits: UsageLimits?, alwaysShowContextSize: Boolean, showRemaining: Boolean): UsageRowState {
    val context = contextStatus(usage, alwaysShowContextSize)
    val rows = usageLimitRows(limits)
    val session = rows.firstOrNull { it.id == "five_hour" }
    val week = rows.firstOrNull { it.id == "seven_day" }
    val weekPercent = week?.utilization
        ?.takeIf { alwaysShowContextSize || context != null }
        ?.let { usageLimitDisplayPercentage(it, showRemaining) }
    val popup = listOfNotNull(session?.let { "session" to it }, week?.let { "week" to it }).mapNotNull { (key, row) ->
        row.utilization?.let { UsagePopupRow(key, usageLimitDisplayPercentage(it, showRemaining), row.resetsAt) }
    }
    return UsageRowState(context, weekPercent, popup)
}

/**
 * sessionStatusBar.ts `formatUsageLimitResetTime`: a clock time when the
 * reset is under 22 hours away, else a short date. [timePattern] and
 * [datePattern] are the locale's (DateFormat.getBestDateTimePattern for
 * `hh:mm a`/`HH:mm` and `MMM d`).
 */
fun formatUsageLimitResetTime(
    ms: Double,
    now: Long,
    timePattern: String,
    datePattern: String,
    locale: Locale = Locale.getDefault(),
    zone: TimeZone = TimeZone.getDefault(),
): String {
    val pattern = if (ms - now < 22 * 3_600_000.0) timePattern else datePattern
    return SimpleDateFormat(pattern, locale).apply { timeZone = zone }.format(Date(ms.toLong()))
}
