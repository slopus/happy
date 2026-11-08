import Foundation

/// What the app tells the agent so it speaks up on its own (`CallConnection.cue`):
/// only the facts, as JSON; the words are the model's (`CallPrompt`).
public enum CallCue: Equatable, Sendable {
    /// Nobody has spoken for a while: the call ends in `endsIn` seconds unless the person speaks.
    case silence(endsIn: Double)
    /// The call ends in `seconds`: at the one-call limit, a fresh call can carry it over
    /// (`restart`); with the voice time used up, nothing can.
    case callEnding(reason: Reason, in: Double, restart: Bool)

    /// What a cue starts with, sent as a user message: the prompt says it is the app's.
    public static let mark = "[app] "

    public enum Reason: String, Sendable {
        case callLimit = "call_limit"
        case timeUsed = "time_used"
    }

    /// The JSON the agent gets, after the `[app]` mark.
    public var text: String {
        switch self {
        case .silence(let endsIn):
            return #"{"event":"silence","endsIn":"\#(Self.spoken(endsIn))"}"#
        case .callEnding(let reason, let seconds, let restart):
            return #"{"event":"call_ending","reason":"\#(reason.rawValue)","in":"\#(Self.spoken(seconds))","restart":\#(restart)}"#
        }
    }

    /// "less than a minute", "about a minute", "about 5 minutes".
    static func spoken(_ seconds: Double) -> String {
        switch seconds {
        case ..<45: "less than a minute"
        case ..<90: "about a minute"
        default: "about \(Int((seconds / 60).rounded())) minutes"
        }
    }
}

/// When a call's agent is cued to speak and when the call ends on its own,
/// from what the call has heard: silence, the hosted agent's one-call
/// limit and the device's voice time. Pure, so its clock is the caller's;
/// `CallSession` asks it every second.
///
/// Silence is the app's to end, before ElevenLabs' own
/// `silence_end_call_timeout` (300 s on the hosted agent) could: that
/// clock restarts when the agent finishes speaking or the person is
/// heard, and so does this one, so the warning always comes first, the
/// end 10 s before theirs. The person's voice restarts it as it is heard,
/// not only their finished words: one long turn has no transcript until it
/// ends. The agent's answer to a cue doesn't put off the end it warned of;
/// the person speaking after it does, and the agent is told
/// (`silenceOver`). Muted time counts: the provider hears silence then too.
public struct CallCues: Equatable, Sendable {
    public struct Timing: Equatable, Sendable {
        /// Quiet this long, the agent warns the call will end.
        public var silenceWarning: Double = 180
        /// Quiet this long, the call ends.
        public var silenceEnd: Double = 290
        /// The hosted agent's `max_duration_seconds`.
        public var callLimit: Double = 3600
        /// Ended this long before the provider would, so it ends as ours.
        public var callLimitMargin: Double = 10
        /// How long before the one-call limit the agent offers a fresh call.
        public var callLimitLead: Double = 300
        /// How long before the voice time is used the agent says so: a
        /// tenth of the free 20 minutes, five minutes of the paid hours.
        public var shortAllowanceLead: Double = 120
        public var longAllowanceLead: Double = 300
        /// A fresh call is offered only with this much time left past the limit.
        public var restartMinimum: Double = 60
        /// After the agent agreed to restart: the longest its last words may take.
        public var restartDeadline: Double = 12

        public init() {}

        func allowanceLead(total: Double) -> Double {
            total <= 30 * 60 ? shortAllowanceLead : longAllowanceLead
        }
    }

    public enum Action: Equatable, Sendable {
        case cue(CallCue)
        case end(CallEnding)
        case restart
        /// The person spoke after a silence warning: the agent is told, as a
        /// contextual update, never a cue (`CallCues.silenceOver`).
        case silenceOver
    }

    /// The update that says a silence warning no longer holds.
    public static let silenceOver = #"{"event":"silence_over"}"#

    /// Who is speaking now.
    public struct Moment: Equatable, Sendable {
        public var now: Double
        public var agentSpeaking: Bool
        /// The person's voice is heard: it restarts the silence clock.
        public var personSpeaking: Bool
        /// Seconds of voice time left and in all; nil without an allowance.
        public var allowanceLeft: Double?
        public var allowanceTotal: Double?

        public init(now: Double, agentSpeaking: Bool = false, personSpeaking: Bool = false, allowanceLeft: Double? = nil, allowanceTotal: Double? = nil) {
            self.now = now
            self.agentSpeaking = agentSpeaking
            self.personSpeaking = personSpeaking
            self.allowanceLeft = allowanceLeft
            self.allowanceTotal = allowanceTotal
        }

        var quiet: Bool { !agentSpeaking && !personSpeaking }
    }

    public let timing: Timing
    public let since: Double
    private var lastHeard: Double
    private var warned: Double?
    /// A warning the person spoke after, not yet said to be over.
    private var silenceEnded = false
    private var limitCued = false
    private var allowanceCued = false
    private var restartAsked: Double?
    private var spokeSinceRestart = false

    public init(timing: Timing = Timing(), since: Double) {
        self.timing = timing
        self.since = since
        lastHeard = since
    }

    /// The person's finished words, or their voice.
    public mutating func heard(at time: Double) {
        lastHeard = max(lastHeard, time)
        if warned != nil { silenceEnded = true }
        warned = nil
    }

    /// The agent finished speaking.
    public mutating func agentSpoke(at time: Double) {
        lastHeard = max(lastHeard, time)
        if restartAsked != nil { spokeSinceRestart = true }
    }

    /// Whether the call can be carried over to a fresh one now: not with
    /// under a minute of voice time left.
    public func canRestart(allowanceLeft: Double?) -> Bool {
        allowanceLeft.map { $0 >= timing.restartMinimum } ?? true
    }

    /// The agent asked for a fresh call: it comes once the agent's words on it are said.
    public mutating func restartAsked(at time: Double) {
        if restartAsked == nil { restartAsked = time }
    }

    /// What to do at `moment`, if anything; each cue once.
    public mutating func next(_ moment: Moment) -> Action? {
        let now = moment.now
        let end = since + timing.callLimit - timing.callLimitMargin
        if now >= end { return .end(.callLimit) }
        if let asked = restartAsked {
            let said = spokeSinceRestart && !moment.agentSpeaking
            let unanswered = !spokeSinceRestart && !moment.agentSpeaking && now - asked >= 4
            if said || unanswered || now - asked >= timing.restartDeadline { return .restart }
            return nil
        }
        if moment.personSpeaking { heard(at: now) }
        if silenceEnded {
            silenceEnded = false
            return .silenceOver
        }
        if let warned {
            if now - warned >= timing.silenceEnd - timing.silenceWarning, moment.quiet { return .end(.silence) }
        } else if now - lastHeard >= timing.silenceWarning, moment.quiet {
            warned = now
            return .cue(.silence(endsIn: timing.silenceEnd - timing.silenceWarning))
        }
        guard moment.quiet else { return nil }
        let limitLeft = end - now
        if let left = moment.allowanceLeft, let total = moment.allowanceTotal, !allowanceCued,
           left <= timing.allowanceLead(total: total), left <= limitLeft + timing.restartMinimum {
            allowanceCued = true
            limitCued = true
            return .cue(.callEnding(reason: .timeUsed, in: left, restart: false))
        }
        if !limitCued, limitLeft <= timing.callLimitLead {
            limitCued = true
            let restart = moment.allowanceLeft.map { $0 > limitLeft + timing.restartMinimum } ?? true
            return .cue(.callEnding(reason: .callLimit, in: limitLeft, restart: restart))
        }
        return nil
    }
}
