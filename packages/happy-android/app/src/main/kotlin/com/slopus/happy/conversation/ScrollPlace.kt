package com.slopus.happy.conversation

/**
 * Where the reader left a conversation, so it opens there again while the
 * app runs, as desktop keeps each conversation's scroll for its session: the
 * row at the list's newest end ([ConversationRow.key]) and the list's scroll
 * offset into it, not a pixel offset, as rows may come or go meanwhile. A
 * conversation left at its newest message keeps none, and opens there
 * following what arrives.
 */
data class ScrollPlace(val key: String, val offset: Int)
