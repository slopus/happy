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

    enum class Reason(val wire: String) { CallLimit("call_limit"), TimeUsed("time_used") }

    /** The JSON the agent gets, after the [MARK]. */
    val text: String
        get() = when (this) {
            is Silence -> """{"event":"silence","endsIn":"${spoken(endsInMillis)}"}"""
            is Ending -> """{"event":"call_ending","reason":"${reason.wire}","in":"${spoken(inMillis)}","restart":$restart}"""
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

    /** The person's finished words, or their voice. */
    fun heard(at: Long) {
        lastHeard = maxOf(lastHeard, at)
        if (warned != null) silenceEnded = true
        warned = null
    }

    /** The agent finished speaking. */
    fun agentSpoke(at: Long) {
        lastHeard = maxOf(lastHeard, at)
        if (restartAsked != null) spokeSinceRestart = true
    }

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
            return Action.Cue(CallCue.Silence(timing.silenceEnd - timing.silenceWarning))
        }
        if (!moment.quiet) return null
        val limitLeft = end - now
        val left = moment.allowanceLeft
        val total = moment.allowanceTotal
        if (left != null && total != null && !allowanceCued && left <= timing.allowanceLead(total) && left <= limitLeft + timing.restartMinimum) {
            allowanceCued = true
            limitCued = true
            return Action.Cue(CallCue.Ending(CallCue.Reason.TimeUsed, left, restart = false))
        }
        if (!limitCued && limitLeft <= timing.callLimitLead) {
            limitCued = true
            val restart = left?.let { it > limitLeft + timing.restartMinimum } ?: true
            return Action.Cue(CallCue.Ending(CallCue.Reason.CallLimit, limitLeft, restart))
        }
        return null
    }

    companion object {
        /** The update that says a silence warning no longer holds. */
        const val SILENCE_OVER = """{"event":"silence_over"}"""
    }
}
