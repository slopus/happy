package com.slopus.happy.call

import kotlin.math.roundToInt

/**
 * What the app tells the agent so it speaks up on its own
 * ([CallConnection.cue], iOS `CallCue`): only the facts, as JSON; the words
 * are the model's ([CallPrompt]).
 */
sealed interface CallCue {
    /** Nobody has spoken for a while: the call ends in [endsInMillis] unless the person speaks. */
    data class Silence(val endsInMillis: Long) : CallCue

    /** The call ends in [inMillis]: at the one-call limit a fresh call can carry it over ([restart]); with the voice time used up, nothing can. */
    data class Ending(val reason: Reason, val inMillis: Long, val restart: Boolean) : CallCue

    /** A conversation read while it wasn't current turned out to have more: what is new since that read, as [CallContext] made it (`conversation_update`). */
    data class ConversationUpdate(val update: String) : CallCue

    enum class Reason(val wire: String) { CallLimit("call_limit"), TimeUsed("time_used") }

    /** The JSON the agent gets, after the [MARK]. */
    val text: String
        get() = when (this) {
            is Silence -> """{"event":"silence","endsIn":"${spoken(endsInMillis)}"}"""
            is Ending -> """{"event":"call_ending","reason":"${reason.wire}","in":"${spoken(inMillis)}","restart":$restart}"""
            is ConversationUpdate -> update
        }

    companion object {
        /** What a cue starts with, sent as a user message: the prompt says it is the app's. */
        const val MARK = "[app] "

        /** "less than a minute", "about a minute", "about 5 minutes". */
        fun spoken(millis: Long): String = when {
            millis < 45_000 -> "less than a minute"
            millis < 90_000 -> "about a minute"
            else -> "about ${(millis / 60_000.0).roundToInt()} minutes"
        }
    }
}

/**
 * When a call's agent is cued to speak and when the call ends on its own
 * (iOS `CallCues`), from what the call has heard: silence, the hosted
 * agent's one-call limit and the device's voice time. Pure, so its clock is
 * the caller's; [CallSession] asks it every second.
 *
 * Silence is the app's to end, before ElevenLabs' own
 * `silence_end_call_timeout` (300 s on the hosted agent) could: that clock
 * restarts when the agent finishes speaking or the person is heard, and so
 * does this one, so the warning always comes first, the end 10 s before
 * theirs. The person's voice restarts it as it is heard, not only their
 * finished words: one long turn has no transcript until it ends. The
 * agent's answer to a cue doesn't put off the end it warned of; the person
 * speaking after it does, and the agent is told ([SILENCE_OVER]). Muted
 * time counts: the provider hears silence then too.
 *
 * What a read found later ([CallCue.ConversationUpdate]) waits its turn: not
 * while either side speaks, nor until the agent has answered what came before
 * it (the read it answered from, the person's words since, the update before
 * it) and been quiet [Timing.answerSettle], or said nothing for
 * [Timing.answerWait]. Updates go one at a time, oldest first, and each is told
 * before the next goes: told is an answer of the agent's, begun after the cue,
 * of at least [Timing.toldWords] words as the person heard them, with the
 * person not speaking first. One the person talked over (they spoke before the
 * agent answered, or cut it off short), or the agent didn't answer within
 * [Timing.tellWait] of quiet, goes again once the moment is right,
 * [Timing.retells] times at most.
 */
class CallCues(val timing: Timing = Timing(), val since: Long) {
    data class Timing(
        /** Quiet this long, the agent warns the call will end. */
        val silenceWarning: Long = 180_000,
        /** Quiet this long, the call ends. */
        val silenceEnd: Long = 290_000,
        /** The hosted agent's `max_duration_seconds`. */
        val callLimit: Long = 3_600_000,
        /** Ended this long before the provider would, so it ends as ours. */
        val callLimitMargin: Long = 10_000,
        /** How long before the one-call limit the agent offers a fresh call. */
        val callLimitLead: Long = 300_000,
        /** How long before the voice time is used the agent says so: a tenth of the free 20 minutes, five minutes of the paid hours. */
        val shortAllowanceLead: Long = 120_000,
        val longAllowanceLead: Long = 300_000,
        /** A fresh call is offered only with this much time left past the limit. */
        val restartMinimum: Long = 60_000,
        /** After the agent agreed to restart: the longest its last words may take. */
        val restartDeadline: Long = 12_000,
        /** A read waits this long for the agent to answer what came before it; past that, its silence is its answer. */
        val answerWait: Long = 4_000,
        /** And this long after the agent stops speaking, so it isn't cut off between a filler and what it says after its tool. */
        val answerSettle: Long = 1_500,
        /** The fewest words, as heard, of an answer that told an update. */
        val toldWords: Int = 8,
        /** An update unanswered this long, both sides quiet, goes again. */
        val tellWait: Long = 8_000,
        /** How many times an update goes again before it is let go. */
        val retells: Int = 2,
    ) {
        fun allowanceLead(total: Long): Long = if (total <= 30 * 60_000L) shortAllowanceLead else longAllowanceLead
    }

    sealed interface Action {
        data class Cue(val cue: CallCue) : Action
        data class End(val ending: CallEnding) : Action
        data object Restart : Action

        /** The person spoke after a silence warning: the agent is told, as a contextual update, never a cue ([SILENCE_OVER]). */
        data object SilenceOver : Action
    }

    /** Who is speaking now, the person's voice restarting the silence clock; voice time left and in all, null without an allowance. */
    data class Moment(
        val now: Long,
        val agentSpeaking: Boolean = false,
        val personSpeaking: Boolean = false,
        val allowanceLeft: Long? = null,
        val allowanceTotal: Long? = null,
    ) {
        val quiet: Boolean get() = !agentSpeaking && !personSpeaking
    }

    private var lastHeard = since
    private var warned: Long? = null
    /** A warning the person spoke after, not yet said to be over. */
    private var silenceEnded = false
    private var limitCued = false
    private var allowanceCued = false
    private var restartAsked: Long? = null
    private var spokeSinceRestart = false
    /** Updates waiting to be told, oldest first, with how often each went. */
    private val reads = ArrayDeque<Pair<CallCue, Int>>()
    /** A read of this call went out not current: only then is an update told. */
    private var asked = false
    /** Since when the agent owes an answer: to a read, the person's words or an update told; null once it has spoken. */
    private var owed: Long? = null

    /**
     * The update sent and not yet known told: when it went, the words of each of the agent's answers since, as heard,
     * and whether the person spoke before the agent answered.
     */
    private class Telling(val cue: CallCue, val at: Long, val tries: Int) {
        val words = HashMap<Int, Int>()
        var talkedOver = false
    }
    private var telling: Telling? = null
    private var agentDone = Long.MIN_VALUE / 2

    /** The person's finished words, or their voice. */
    fun heard(at: Long) {
        lastHeard = maxOf(lastHeard, at)
        if (warned != null) silenceEnded = true
        warned = null
        owed = at
        telling?.takeIf { at >= it.at }?.let { if (told(it)) telling = null else it.talkedOver = true }
    }

    /** The agent's answer [event], of [words] words, begun. */
    fun agentSaid(words: Int, event: Int, at: Long) {
        telling?.takeIf { at >= it.at }?.words?.set(event, words)
    }

    /** The person cut the agent's answer [event] off: [words] of it were heard. */
    fun agentCorrected(words: Int, event: Int) {
        telling?.takeIf { event in it.words }?.words?.set(event, words)
    }

    private fun told(telling: Telling): Boolean = !telling.talkedOver && (telling.words.values.maxOrNull() ?: 0) >= timing.toldWords

    /** The agent finished speaking. */
    fun agentSpoke(at: Long) {
        lastHeard = maxOf(lastHeard, at)
        if (restartAsked != null) spokeSinceRestart = true
        owed = null
        agentDone = at
    }

    /** A read went out not current, and what it finds may come later: the agent answers from the read first. */
    fun refreshing(at: Long) {
        owed = at
        asked = true
    }

    /** An update to tell once the moment is right; one for a read of another call (it came after a restart) goes nowhere. */
    fun later(cue: CallCue) {
        if (asked) reads.addLast(cue to 0)
    }

    /** Updates still waiting to be told, the one sent and not yet told among them. */
    val waiting: Int get() = reads.size + (if (telling == null) 0 else 1)

    /** Whether the call can be carried over to a fresh one now: not with under a minute of voice time left. */
    fun canRestart(allowanceLeft: Long?): Boolean = allowanceLeft?.let { it >= timing.restartMinimum } ?: true

    /** The agent asked for a fresh call: it comes once the agent's words on it are said. */
    fun restartAsked(at: Long) {
        if (restartAsked == null) restartAsked = at
    }

    /** What to do at [moment], if anything; each cue once. */
    fun next(moment: Moment): Action? {
        val now = moment.now
        val end = since + timing.callLimit - timing.callLimitMargin
        if (now >= end) return Action.End(CallEnding.CallLimit)
        restartAsked?.let { asked ->
            val said = spokeSinceRestart && !moment.agentSpeaking
            val unanswered = !spokeSinceRestart && !moment.agentSpeaking && now - asked >= 4_000
            return if (said || unanswered || now - asked >= timing.restartDeadline) Action.Restart else null
        }
        if (moment.personSpeaking) heard(now)
        if (silenceEnded) {
            silenceEnded = false
            return Action.SilenceOver
        }
        val warnedAt = warned
        if (warnedAt != null) {
            if (now - warnedAt >= timing.silenceEnd - timing.silenceWarning && moment.quiet) return Action.End(CallEnding.Silence)
        } else if (now - lastHeard >= timing.silenceWarning && moment.quiet) {
            warned = now
            owed = now
            return Action.Cue(CallCue.Silence(timing.silenceEnd - timing.silenceWarning))
        }
        telling?.let { sent ->
            val settled = !moment.agentSpeaking && agentDone > sent.at && now - agentDone >= timing.answerSettle
            if (told(sent) && settled) {
                telling = null
            } else if (sent.talkedOver || (settled && sent.words.isNotEmpty()) ||
                (sent.words.isEmpty() && moment.quiet && now - maxOf(sent.at, agentDone) >= timing.tellWait)) {
                // Not told: again, once the person has had their answer.
                telling = null
                if (sent.tries < timing.retells) reads.addFirst(sent.cue to sent.tries + 1)
            }
        }
        if (!moment.quiet) return null
        val limitLeft = end - now
        val left = moment.allowanceLeft
        val total = moment.allowanceTotal
        if (left != null && total != null && !allowanceCued && left <= timing.allowanceLead(total) && left <= limitLeft + timing.restartMinimum) {
            allowanceCued = true
            limitCued = true
            owed = now
            return Action.Cue(CallCue.Ending(CallCue.Reason.TimeUsed, left, restart = false))
        }
        if (!limitCued && limitLeft <= timing.callLimitLead) {
            limitCued = true
            owed = now
            val restart = left?.let { it > limitLeft + timing.restartMinimum } ?: true
            return Action.Cue(CallCue.Ending(CallCue.Reason.CallLimit, limitLeft, restart))
        }
        if (telling == null && reads.isNotEmpty() && now - agentDone >= timing.answerSettle && (owed?.let { now - it >= timing.answerWait } ?: true)) {
            owed = now
            val (cue, tries) = reads.removeFirst()
            telling = Telling(cue, now, tries)
            return Action.Cue(cue)
        }
        return null
    }

    companion object {
        /** The update that says a silence warning no longer holds. */
        const val SILENCE_OVER = """{"event":"silence_over"}"""
    }
}
