package com.slopus.happy.conversation.ui

import com.slopus.happy.conversation.Problem

/**
 * How one conversation's chat UI presses stand, by offer. Read and written
 * on the conversation's lane alone.
 *
 * - One press of an offer is on its way at a time; another meanwhile is
 *   not taken. Only its redacted action is kept ([UiActions.redacted]).
 * - A press that ended without the server's answer keeps its attempt ID:
 *   the same action again on the same offer is the same attempt, which the
 *   server answers as it answered the first. Any other press is a new one.
 *   An action with a field left out can't be told from another, so its ID
 *   is never kept.
 * - A refusal learned while the chat is open, as a press's answer or in
 *   an attempt record that came in, shows on its component until its offer
 *   is pressed again, a later attempt is not refused, or the component's
 *   live state is read again ([read]): what was asked for after a refusal
 *   was learned is newer than it, and a refusal never stands over newer
 *   state. A read already under way when the refusal came says nothing of
 *   it ([mark]). One that history holds from before is not news and is
 *   never shown.
 */
internal class UiPresses(private val newId: () -> String) {
    private class Attempt(val id: String, val action: UiAction)
    private class Refusal(val component: String, val problem: Problem, val learned: Int)

    private val sending = HashMap<UiOffer, UiAction>()
    private val unanswered = HashMap<UiOffer, Attempt>()
    private val refusals = HashMap<UiOffer, Refusal>()

    /** How many refusals have been learned of: the order they came in. */
    private var learned = 0

    private fun refuse(offer: UiOffer, component: String, problem: Problem) {
        refusals[offer] = Refusal(component, problem, ++learned)
    }

    /**
     * Takes a press of [action] on [offer]: its attempt ID, or null while
     * one of the offer is on its way. [recorded] says whether an attempt
     * ID is a message here already: one the server answered after all,
     * which is no longer this press.
     */
    fun begin(offer: UiOffer, action: UiAction, recorded: (id: String) -> Boolean): String? {
        if (offer in sending) return null
        sending[offer] = UiActions.redacted(action)
        refusals.remove(offer)
        val last = unanswered.remove(offer)
        return last?.takeIf { it.action == action && !recorded(it.id) }?.id ?: newId()
    }

    /** The server answered the press of [offer] with its record. */
    fun answered(offer: UiOffer) {
        sending.remove(offer)
    }

    /** The server turned the press of [offer] down, recording nothing: [problem] says why. */
    fun refused(offer: UiOffer, action: UiAction, problem: Problem) {
        sending.remove(offer)
        refuse(offer, action.component, problem)
    }

    /** The press of [offer] under [id] ended without the server's answer. */
    fun lost(offer: UiOffer, id: String, action: UiAction, problem: Problem) {
        val kept = sending.remove(offer)
        if (kept == action) unanswered[offer] = Attempt(id, action)
        refuse(offer, action.component, problem)
    }

    /** An attempt record that came in while the chat is open, from this phone's press or anyone's. */
    fun heard(record: UiActionRecord) {
        val outcome = record.outcome
        if (outcome.refused) {
            refuse(record.offer, record.action.component, outcome.reason?.takeIf { it.isNotBlank() }?.let(Problem::Said) ?: Problem.Unknown)
        } else {
            refusals.remove(record.offer)
        }
    }

    /** Where the refusals stand now, taken as a read of live state begins ([read]). */
    fun mark(): Int = learned

    /**
     * The live state [component]'s actions change was read, in a read
     * begun at [mark]: the refusals learned by then are older than it and
     * go. True when one did.
     */
    fun read(component: String, mark: Int): Boolean = refusals.values.removeAll { it.component == component && it.learned <= mark }

    /** The action of [offer] on its way from here, its secrets left out. */
    fun sending(offer: UiOffer): UiAction? = sending[offer]

    /** Why the last attempt on [offer] was refused, while that is still news. */
    fun problem(offer: UiOffer): Problem? = refusals[offer]?.problem
}
