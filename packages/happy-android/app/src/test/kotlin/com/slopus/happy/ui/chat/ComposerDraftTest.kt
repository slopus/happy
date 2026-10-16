package com.slopus.happy.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Test

/** The composer text against its mirror: own echoes never move the text back, other changes replace it. */
class ComposerDraftTest {
    @Test
    fun ownEchoesAreIgnoredAndRemoteChangesApplied() {
        val draft = ComposerDraft()
        draft.onMirror("from another device")
        assertEquals("from another device", draft.text)
        draft.set("a")
        draft.set("ab")
        draft.set("abc")
        // The mirror catches up one write at a time.
        draft.onMirror("a")
        assertEquals("abc", draft.text)
        draft.onMirror("abc")
        assertEquals("abc", draft.text)
        // A send cleared it elsewhere.
        draft.onMirror("")
        assertEquals("", draft.text)
    }
}
