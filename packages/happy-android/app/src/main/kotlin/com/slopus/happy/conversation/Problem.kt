package com.slopus.happy.conversation

import androidx.compose.runtime.Immutable
import com.slopus.happy.connection.AgentConnectionException

/**
 * Why something asked of a paired agent failed ([Conversation.describe]).
 * The agent's own words stay as it wrote them; everything the phone says
 * itself is a case, put into words in the person's language by the UI
 * (`ui/conversation/ProblemText.kt`).
 */
@Immutable
sealed interface Problem {
    /** The agent's or the transport's own words, shown as they are. */
    data class Said(val text: String) : Problem

    /** The link to the agent failed: pairing's reasons. */
    data class Link(val reason: AgentConnectionException.Reason) : Problem

    /** The agent answered [status] and gave no words of its own. */
    data class Refused(val status: Int) : Problem

    /** The agent connection isn't on this phone (any more). */
    data object Unavailable : Problem

    /** The pictures picked to send couldn't be read on the phone. */
    data object PicturesUnreadable : Problem

    /** Slash command [name] is no longer offered (404): unknown, or just removed. */
    data class CommandGone(val name: String) : Problem

    /** Slash command [name] can't run in the agent's current state (409). */
    data class CommandBusy(val name: String) : Problem

    /** The person's role on the team doesn't allow it (a team server's `403 forbidden`). */
    data object Forbidden : Problem

    /** Nothing says why. */
    data object Unknown : Problem
}

/**
 * A failed turn as desktop's failure card words it
 * (`conversationFailureMessage`, without clock times): one case per failure
 * kind the daemon reports, with the names it gives, or the daemon's own
 * words where it wrote them.
 */
@Immutable
sealed interface FailureReason {
    /** "[product] isn't signed in. Run `[command]`, then retry." */
    data class SignInMissing(val product: String, val command: String) : FailureReason
    /** "[provider] couldn't authenticate. Check its sign-in settings, then retry." */
    data class CannotAuthenticate(val provider: String) : FailureReason
    data class UsageLimit(val vendor: String) : FailureReason
    data class NoAccountAvailable(val pool: String) : FailureReason
    data class RateLimited(val vendor: String) : FailureReason
    data class ProviderUnavailable(val vendor: String) : FailureReason
    data class Network(val vendor: String) : FailureReason
    data class ContextTooLong(val model: String) : FailureReason
    data class ProviderDisabled(val provider: String) : FailureReason
    /** "Something went wrong: [detail]", the detail the daemon's. */
    data class Internal(val detail: String) : FailureReason
    /** The daemon's own words. */
    data class Said(val text: String) : FailureReason
    data object Unknown : FailureReason
}
