package com.slopus.happy.ui.connection

import android.content.SharedPreferences
import java.util.concurrent.ConcurrentHashMap

/**
 * Where each agent connection's home list sits: its first item, the offset
 * into it and that item's key. Kept in memory while home shows it, because
 * the tablet shell swaps the phone's home for the sidebar's at the
 * breakpoint and the sidebar leaves while hidden, which throws the list away
 * (iOS 50f34ed9f keeps its rows in place). Once home is left or the app
 * goes to the background it is also kept on the phone, and it is good for
 * an hour from then (Kirill), so a chat, another connection or a relaunch
 * comes back to the same rows. Keyed by connection, so one never opens on
 * another's place; as legacy home's
 * [com.slopus.happy.ui.home.HomeServices.homeListOffsets].
 */
class AgentHomePlaces(private val prefs: SharedPreferences) {
    /** [at] is when home last showed it; [Long.MAX_VALUE] while it does. */
    data class Place(val index: Int, val offset: Int, val key: String?, val at: Long = Long.MAX_VALUE)

    private val places = ConcurrentHashMap<String, Place>()

    /** Where [id]'s home was, if it shows it now or did within the hour. */
    operator fun get(id: String): Place? =
        (places[id] ?: stored(id))?.takeIf { System.currentTimeMillis() - it.at < LIFETIME_MILLIS }

    /** Home shows [place] for [id]. */
    fun showing(id: String, place: Place) {
        places[id] = place
    }

    /** Home leaves [place] for [id] ([showing] still, for a trip to the background): it is good for an hour from now. */
    fun left(id: String, place: Place, showing: Boolean = false) {
        val now = System.currentTimeMillis()
        places[id] = if (showing) place else place.copy(at = now)
        val edit = prefs.edit()
        for ((other, value) in prefs.all) if (((value as? String)?.let(::decode)?.at ?: 0) <= now - LIFETIME_MILLIS) edit.remove(other)
        edit.putString(id, "$now|${place.index}|${place.offset}|${place.key.orEmpty()}").apply()
    }

    private fun stored(id: String): Place? = prefs.getString(id, null)?.let(::decode)

    private fun decode(value: String): Place? {
        val parts = value.split('|', limit = 4).takeIf { it.size == 4 } ?: return null
        return Place(parts[1].toIntOrNull() ?: return null, parts[2].toIntOrNull() ?: return null, parts[3].ifEmpty { null }, parts[0].toLongOrNull() ?: return null)
    }

    companion object {
        const val PREFS_NAME = "agent-home-places"
        /** How long a place is good after home last showed it. */
        const val LIFETIME_MILLIS = 60 * 60 * 1000L
    }
}
