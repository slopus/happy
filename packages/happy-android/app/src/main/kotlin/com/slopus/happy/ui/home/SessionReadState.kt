package com.slopus.happy.ui.home

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.slopus.happy.AppGraph
import com.slopus.happy.model.Session
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * storage.ts's unread tracking: which chats finished work the person hasn't
 * looked at, and which chat they are looking at (`currentViewingSessionId`).
 * Memory-only, as in happy-app: a restarted app has nothing unread.
 *
 * A chat turns unread when its agent goes from working (thinking, or a
 * permission request pending) to idle (online, not thinking, no request),
 * unless it is the one being viewed. Viewing a chat reads it.
 */
class SessionReadState {
    private class Activity(val working: Boolean, val idle: Boolean)

    private val unread = MutableStateFlow<Set<String>>(emptySet())
    val unreadSessionIds: StateFlow<Set<String>> = unread.asStateFlow()

    private val viewing = MutableStateFlow<String?>(null)
    val viewingSessionId: StateFlow<String?> = viewing.asStateFlow()

    private var previous: Map<String, Activity>? = null

    /** applySessions: compares each session with its last sighting. The first list only sets the baseline. */
    @Synchronized
    fun observe(sessions: List<Session>) {
        val next = sessions.associate { session ->
            val requests = session.attention.permissionRequests > 0
            session.id to Activity(working = session.thinking || requests, idle = !session.thinking && session.isOnline && !requests)
        }
        val before = previous
        previous = next
        if (before == null) return
        var changed = unread.value
        for ((id, now) in next) {
            val was = before[id] ?: continue
            if (was.working && now.idle && id != viewing.value && id !in changed) changed = changed + id
        }
        unread.value = changed
    }

    /** `setCurrentViewingSession`: a chat opened is a chat read. */
    @Synchronized
    fun setViewing(sessionId: String?) {
        if (viewing.value == sessionId) return
        viewing.value = sessionId
        if (sessionId != null && sessionId in unread.value) unread.value = unread.value - sessionId
    }

    /** Lets go of [sessionId] only if it is still the viewed one, so a closing chat can't clear its successor. */
    @Synchronized
    fun release(sessionId: String) {
        if (viewing.value == sessionId) viewing.value = null
    }

    /** Another account, or none: nothing carries over. */
    @Synchronized
    fun reset() {
        previous = null
        unread.value = emptySet()
        viewing.value = null
    }
}

/**
 * useSessionVisibility for a chat screen: while it is on screen [sessionId]
 * is the viewed chat, so it reads at once and can't turn unread. A screen
 * pushed over it (session info, files) keeps the claim; it ends when the
 * chat's back-stack entry is destroyed. Null (no session yet) claims nothing.
 */
@Composable
fun SessionViewingEffect(graph: AppGraph, sessionId: String?) {
    val reads = remember(graph) { HomeServices.of(graph).reads }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(reads, lifecycle, sessionId) {
        if (sessionId == null || lifecycle.currentState == Lifecycle.State.DESTROYED) return@DisposableEffect onDispose {}
        reads.setViewing(sessionId)
        val observer = object : LifecycleEventObserver {
            override fun onStateChanged(source: androidx.lifecycle.LifecycleOwner, event: Lifecycle.Event) {
                if (event == Lifecycle.Event.ON_DESTROY) {
                    reads.release(sessionId)
                    lifecycle.removeObserver(this)
                }
            }
        }
        lifecycle.addObserver(observer)
        onDispose {
            // Left the composition for good (popped, or the session changed): let go now.
            // Covered by a pushed screen: the entry lives on, and so does the claim.
            if (lifecycle.currentState == Lifecycle.State.DESTROYED || !lifecycle.currentState.isAtLeast(Lifecycle.State.CREATED)) {
                reads.release(sessionId)
                lifecycle.removeObserver(observer)
            }
        }
    }
}
