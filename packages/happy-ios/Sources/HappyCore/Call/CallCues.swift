import Foundation

/// What the app tells the agent so it speaks up on its own (`CallConnection.cue`):
/// only the facts, as JSON; the words are the model's (`CallPrompt`).
public enum CallCue: Equatable, Sendable {
    /// Nobody has spoken for a while: the call ends in `endsIn` seconds unless the person speaks.
    case silence(endsIn: Double)
    /// The call ends in `seconds`: at the one-call limit, a fresh call can carry it over
    /// (`restart`); with the voice time used up, nothing can.
    case callEnding(reason: Reason, in: Double, restart: Bool)
    /// A conversation read while it wasn't current turned out to have
    /// more: what is new since that read, as `CallContext` made it
    /// (`conversation_update`).
    case conversationUpdate(String)

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
        case .conversationUpdate(let update):
            return update
        }
    }

    /// The conversation an update is of (its `ref`), so a newer one of it
    /// takes the place of one still waiting; nil for the other cues.
    var conversation: String? {
        guard case .conversationUpdate(let update) = self,
              let value = try? JSONSerialization.jsonObject(with: Data(update.utf8)) as? [String: Any] else { return nil }
        return value["ref"] as? String
    }

    /// What an update says, to know an answer told it: the words of five
    /// letters or more of its turns' agent words and its waiting message.
    var gist: Set<String> {
        guard case .conversationUpdate(let update) = self,
              let value = try? JSONSerialization.jsonObject(with: Data(update.utf8)) as? [String: Any] else { return [] }
        var texts = ((value["turns"] as? [[String: Any]]) ?? []).compactMap { $0["assistant"] as? String }
        if let pending = (value["pendingUserMessage"] as? [String: Any])?["text"] as? String { texts.append(pending) }
        return Set(texts.flatMap { CallCues.words($0) }.filter { $0.count >= 5 })
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
///
/// What a read found later (`conversationUpdate`) waits its turn: not
/// while either side speaks, nor until the agent has answered what came
/// before it (the read it answered from, the person's words since, the
/// update before it) and been quiet `answerSettle`, or said nothing for
/// `answerWait`. Updates go one at a time, oldest first (a newer one of a
/// conversation in place of one still waiting), and each is told
/// before the next goes: told is an answer of the agent's, begun after
/// the cue, of at least `toldWords` words as the person heard them, with
/// the person not speaking first; or, the person having spoken over it,
/// an answer since that says what the update does (three of its longer
/// words). One talked over and not told so (they spoke before the agent
/// answered, or cut it off short), or the agent didn't answer within
/// `tellWait` of quiet, goes again once the moment is right, `retells`
/// times at most.
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
        /// A read waits this long for the agent to answer what came before
        /// it; past that, its silence is its answer.
        public var answerWait: Double = 4
        /// And this long after the agent stops speaking, so it isn't cut
        /// off between a filler and what it says after its tool.
        public var answerSettle: Double = 1.5
        /// The fewest words, as heard, of an answer that told an update.
        public var toldWords = 8
        /// An update unanswered this long, both sides quiet, goes again.
        public var tellWait: Double = 8
        /// How many times an update goes again before it is let go.
        public var retells = 2

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
    /// Updates waiting to be told, oldest first, with how often each went.
    private var reads: [Queued] = []
    private struct Queued: Equatable, Sendable {
        var cue: CallCue
        var tries: Int
    }
    /// A read of this call went out not current: only then is an update told.
    private var asked = false
    /// Since when the agent owes an answer: to a read, the person's words
    /// or an update told; nil once it has spoken.
    private var owed: Double?
    /// The update sent and not yet known told: when it went, each of the
    /// agent's answers since as heard, and when the person spoke before
    /// the agent told it.
    private struct Telling: Equatable, Sendable {
        var cue: CallCue
        var at: Double
        var tries: Int
        var answers: [Int: String] = [:]
        var talkedOver: Double?
    }
    private var telling: Telling?
    private var agentDone: Double = -.infinity

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
        owed = time
        if let telling, time >= telling.at {
            if told(telling) { self.telling = nil } else { self.telling?.talkedOver = time }
        }
    }

    /// The agent's answer `event`, `text`, begun.
    public mutating func agentSaid(_ text: String, event: Int, at time: Double) {
        guard let telling, time >= telling.at else { return }
        self.telling?.answers[event] = text
    }

    /// The person cut the agent's answer `event` off: `text` of it was heard.
    public mutating func agentCorrected(_ text: String, event: Int) {
        guard telling?.answers[event] != nil else { return }
        telling?.answers[event] = text
    }

    /// Told: an answer of `toldWords` words or more, the person not
    /// speaking first; or, talked over, an answer since that says what the
    /// update does (its words of five letters or more, three of them, or
    /// as many as it has).
    private func told(_ telling: Telling) -> Bool {
        let answers = telling.answers.values.filter { Self.words($0).count >= timing.toldWords }
        if telling.talkedOver == nil, !answers.isEmpty { return true }
        let gist = telling.cue.gist
        guard !gist.isEmpty else { return false }
        return answers.contains { gist.intersection(Self.words($0).filter { $0.count >= 5 }).count >= min(3, gist.count) }
    }

    /// `text`'s words, lowercased, letters and digits only.
    static func words(_ text: String) -> [String] {
        text.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
    }

    /// The agent finished speaking.
    public mutating func agentSpoke(at time: Double) {
        lastHeard = max(lastHeard, time)
        if restartAsked != nil { spokeSinceRestart = true }
        owed = nil
        agentDone = time
    }

    /// A read went out not current, and what it finds may come later:
    /// the agent answers from the read first.
    public mutating func refreshing(at time: Double) {
        owed = time
        asked = true
    }

    /// An update to tell once the moment is right; one for a read of
    /// another call (it came after a restart) goes nowhere.
    public mutating func later(_ cue: CallCue) {
        guard asked else { return }
        // A newer update of a conversation takes the place of one still waiting.
        if let conversation = cue.conversation { reads.removeAll { $0.cue.conversation == conversation } }
        reads.append(Queued(cue: cue, tries: 0))
    }

    /// Updates still waiting to be told, the one sent and not yet told among them.
    public var waiting: Int { reads.count + (telling == nil ? 0 : 1) }

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
            owed = now
            return .cue(.silence(endsIn: timing.silenceEnd - timing.silenceWarning))
        }
        if let sent = telling {
            // Decided once the agent has answered since the cue, or since the person spoke over it.
            let since = sent.talkedOver ?? sent.at
            let settled = !moment.agentSpeaking && agentDone > since && now - agentDone >= timing.answerSettle
            if told(sent), settled {
                telling = nil
            } else if settled || (moment.quiet && now - max(since, agentDone) >= timing.tellWait) {
                // Not told: again, once the person has had their answer.
                telling = nil
                let superseded = sent.cue.conversation.map { conversation in reads.contains { $0.cue.conversation == conversation } } ?? false
                if sent.tries < timing.retells, !superseded { reads.insert(Queued(cue: sent.cue, tries: sent.tries + 1), at: 0) }
            }
        }
        guard moment.quiet else { return nil }
        let limitLeft = end - now
        if let left = moment.allowanceLeft, let total = moment.allowanceTotal, !allowanceCued,
           left <= timing.allowanceLead(total: total), left <= limitLeft + timing.restartMinimum {
            allowanceCued = true
            limitCued = true
            owed = now
            return .cue(.callEnding(reason: .timeUsed, in: left, restart: false))
        }
        if !limitCued, limitLeft <= timing.callLimitLead {
            limitCued = true
            owed = now
            let restart = moment.allowanceLeft.map { $0 > limitLeft + timing.restartMinimum } ?? true
            return .cue(.callEnding(reason: .callLimit, in: limitLeft, restart: restart))
        }
        if telling == nil, !reads.isEmpty, now - agentDone >= timing.answerSettle, owed.map({ now - $0 >= timing.answerWait }) ?? true {
            owed = now
            let read = reads.removeFirst()
            telling = Telling(cue: read.cue, at: now, tries: read.tries)
            return .cue(read.cue)
        }
        return nil
    }
}
