package com.slopus.happy.ui.conversation

import androidx.compose.runtime.Stable
import com.slopus.happy.conversation.ConversationRow

/**
 * What chat UI's rows and suggested replies ask of the screen, as one
 * object ([ConversationRowActions.ui]). What may change while the screen
 * stands is read through a function, as each row composes, so the rows keep
 * one object for the screen's life.
 */
@Stable
class UiRowActions(
    /** Sends a suggested reply's option ([com.slopus.happy.conversation.Conversation.sendReply]). */
    val reply: (ConversationRow.Replies, index: Int) -> Unit,
    /** Whether the person may send here now, as the composer may: where not, no stack takes a tap. */
    val replies: () -> Boolean,
)
