package com.slopus.happy.call

import android.content.SharedPreferences
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The voice time this device has spent on calls (iOS `CallUsage`): one span
 * per call, from the moment it connected to the moment it ended, or the last
 * time it was counted should the app die mid-call. Connecting and failed
 * calls spend nothing. Times are wall-clock milliseconds.
 */
@Serializable
data class CallUsage(val spans: List<Span> = emptyList()) {
    @Serializable
    data class Span(val id: String, val start: Long, val end: Long)

    /**
     * Milliseconds spent since [window] before [now]; a span across that
     * edge counts only the part after it. A span after [now] (the clock was
     * put back) counts whole: turning the clock back gives no time back.
     */
    fun used(now: Long, window: Long): Long {
        val from = now - window
        return spans.sumOf { maxOf(0L, it.end - maxOf(it.start, from)) }
    }

    /** Counts a call up to [end]; the same call again only grows its span. */
    fun record(id: String, start: Long, end: Long): CallUsage {
        val index = spans.indexOfFirst { it.id == id }
        return if (index >= 0) {
            CallUsage(spans.toMutableList().also { it[index] = it[index].copy(end = maxOf(it[index].end, end)) })
        } else {
            CallUsage(spans + Span(id, start, maxOf(start, end)))
        }
    }

    fun forget(before: Long): CallUsage = CallUsage(spans.filter { it.end >= before })
}

interface CallUsageStore {
    fun load(): CallUsage
    fun save(usage: CallUsage)
}

/** This device's spans, kept across sign-outs: they count the device, not an account. */
class PreferencesCallUsageStore(private val preferences: SharedPreferences) : CallUsageStore {
    override fun load(): CallUsage = preferences.getString(KEY, null)
        ?.let { runCatching { Json.decodeFromString<CallUsage>(it) }.getOrNull() } ?: CallUsage()

    override fun save(usage: CallUsage) {
        preferences.edit().putString(KEY, Json.encodeToString(CallUsage.serializer(), usage)).apply()
    }

    companion object {
        const val PREFS_NAME = "call-usage"
        private const val KEY = "usage"
    }
}

/**
 * The free voice time a device has on agent calls (iOS `CallAllowance`): 20
 * minutes in any 30 days, rolling, counted here. Provisional, like the public
 * agent it goes with: no server to ask yet, nothing bought lifts it. Not a
 * number of calls, and no other cap. Used on the main thread.
 */
class CallAllowance(
    private val store: CallUsageStore,
    private val free: Long = FREE_MILLIS,
    private val window: Long = WINDOW_MILLIS,
) {
    private var usage = store.load()

    fun remaining(now: Long): Long = maxOf(0L, free - usage.used(now, window))

    fun record(id: String, start: Long, end: Long) {
        usage = usage.record(id, start, end).forget(end - window)
        store.save(usage)
    }

    companion object {
        const val FREE_MILLIS = 20 * 60 * 1000L
        const val WINDOW_MILLIS = 30 * 24 * 60 * 60 * 1000L
    }
}
