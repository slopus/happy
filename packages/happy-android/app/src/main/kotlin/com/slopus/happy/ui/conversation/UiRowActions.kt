package com.slopus.happy.ui.conversation

import androidx.compose.runtime.Stable
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.ui.UiAction
import com.slopus.happy.conversation.ui.UiOffer

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
    /** Sends a component's action on its offer ([com.slopus.happy.conversation.Conversation.press]). */
    val press: (UiOffer, UiAction) -> Unit,
    /** Whether the chat takes presses now: not one that is archived. */
    val presses: () -> Boolean,
    /** Whether the person's role holds a permission; the server decides every press all the same. */
    val allowed: (permission: String) -> Boolean,
    /** The computer's models and the default among them, as last read; null until they are. */
    val catalog: () -> ModeCatalog?,
)
