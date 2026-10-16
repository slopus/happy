package com.slopus.happy.ui.chat

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import com.slopus.happy.sync.ComposerMirror
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

/**
 * The composer's text (useDraft.ts): typed here at once, written to the
 * session's composer mirror in order behind it, and replaced when the
 * mirror changes for another reason (a Happy Agent draft edited on another
 * device, cleared by a send). The mirror's echo of this device's own
 * writes never moves the text back.
 */
@Stable
class ComposerDraft internal constructor() {
    var text by mutableStateOf("")
        private set

    /** Texts written and not yet seen back from the mirror, oldest first. */
    private val written = ArrayDeque<String>()
    internal val writes = Channel<String>(Channel.UNLIMITED)

    fun set(value: String) {
        if (value == text) return
        text = value
        written.addLast(value)
        while (written.size > MAX_IN_FLIGHT) written.removeFirst()
        writes.trySend(value)
    }

    internal fun onMirror(remote: String) {
        val echo = written.indexOf(remote)
        if (echo >= 0) {
            repeat(echo + 1) { written.removeFirst() }
            return
        }
        text = remote
    }

    private companion object {
        const val MAX_IN_FLIGHT = 64
    }
}

/** The draft over [mirror] (the account's `composer.mirror(sessionId)`), written through [onWrite]. */
@Composable
fun rememberComposerDraft(mirror: Flow<ComposerMirror>?, onWrite: suspend (String) -> Unit): ComposerDraft {
    val write by rememberUpdatedState(onWrite)
    val draft = remember(mirror) { ComposerDraft() }
    LaunchedEffect(draft) {
        launch { for (text in draft.writes) write(text) }
        mirror?.collect { draft.onMirror(it.draft.orEmpty()) }
    }
    return draft
}
