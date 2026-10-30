package com.slopus.happy.ui.home

import android.content.SharedPreferences
import com.slopus.happy.model.NewSessionDraft
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** persistence.ts's draft under `new-session-draft-v1`, published as it changes. */
class NewSessionDraftStore(private val prefs: SharedPreferences, private val clock: () -> Long = System::currentTimeMillis) {
    private val state = MutableStateFlow(NewSessionDraft.parse(prefs.getString(KEY, null)) ?: NewSessionDraft())
    val draft: StateFlow<NewSessionDraft> = state.asStateFlow()

    @Synchronized
    fun change(transform: (NewSessionDraft) -> NewSessionDraft) {
        val next = transform(state.value)
        if (next == state.value) return
        val stamped = next.copy(updatedAt = clock())
        prefs.edit().putString(KEY, stamped.toJson().toString()).apply()
        state.value = stamped
    }

    /**
     * Logout: the draft goes, stored and in memory, under [change]'s lock. The
     * logout's wipe of the file runs first, and a change landing between the
     * two (the dock following its computer) would otherwise store it again.
     */
    @Synchronized
    fun reset() {
        prefs.edit().remove(KEY).commit()
        state.value = NewSessionDraft()
    }

    companion object {
        const val PREFS_NAME = "new-session"
        const val KEY = "new-session-draft-v1"
    }
}
