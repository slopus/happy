package com.slopus.happy.conversation

/**
 * Lays out the rows' text before the screen sees them, as Telegram builds a
 * MessageObject's text layout on its storage queue before posting it to the
 * UI thread: the conversation calls it on its lane with every set of rows it
 * publishes, and with a streaming block's words before its row reads them,
 * so a row only draws what was measured here.
 */
interface RowTypesetter {
    /** Lays out [rows] (newest first) that aren't laid out yet: the newest at once, the rest soon. */
    fun prepare(rows: List<ConversationRow>)

    /** Lays out row [key]'s streaming words, before they are published. [markdown] false for a thinking block's plain text. */
    fun live(key: String, content: LiveText.Content, markdown: Boolean)
}
