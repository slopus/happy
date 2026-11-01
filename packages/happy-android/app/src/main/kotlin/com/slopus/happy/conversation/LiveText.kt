package com.slopus.happy.conversation

import androidx.compose.runtime.Stable
import com.slopus.happy.chat.markdown.MarkdownBlock
import com.slopus.happy.chat.markdown.parseMarkdown
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The words of one block while it streams, Telegram's way (an update goes to
 * the one cell that changed): the conversation's lane writes each delta here
 * instead of publishing a new [ConversationState], and only the block's own
 * row reads it, at most once a frame. Markdown is parsed on the lane, and
 * the blocks a delta left alone are the same objects as before, so the row
 * lays out only its growing tail.
 */
@Stable
class LiveText internal constructor(text: String, blocks: List<MarkdownBlock>, private val now: () -> Long) {
    /** One reading of the block. Compared by identity: each update is a new one. */
    class Content(val text: String, val blocks: List<MarkdownBlock>)

    private val _content = MutableStateFlow(Content(text, blocks))
    val content: StateFlow<Content> = _content.asStateFlow()

    /** When this block started streaming, so a row that meets it late shows what came before at once. */
    val startedAt: Long = now()

    /** Whether the block began streaming within [millis], so its row reveals it from the start. */
    fun isFresh(millis: Long = FRESH_MILLIS): Boolean = now() - startedAt < millis

    /** New words, from the lane; false when they are what it holds already. */
    internal fun update(text: String, markdown: Boolean): Boolean {
        val previous = _content.value
        if (previous.text == text) return false
        _content.value = Content(text, if (markdown) reuse(previous.blocks, parseMarkdown(text)) else emptyList())
        return true
    }

    companion object {
        /** A row composed this soon after its block began reveals it from its first word. */
        const val FRESH_MILLIS = 1_000L

        /** [next] with every block equal to the one at its place in [previous] replaced by that one. */
        fun reuse(previous: List<MarkdownBlock>, next: List<MarkdownBlock>): List<MarkdownBlock> {
            if (previous.isEmpty()) return next
            var same = true
            val out = ArrayList<MarkdownBlock>(next.size)
            for (i in next.indices) {
                val old = previous.getOrNull(i)
                if (old != null && old == next[i]) out += old else { out += next[i]; same = false }
            }
            return if (same && out.size == previous.size) previous else out
        }
    }
}
