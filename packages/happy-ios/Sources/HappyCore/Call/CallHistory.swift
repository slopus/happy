import Foundation

/// How a call ended, as the next call's recap says it. Only a call that
/// went live has one.
public enum CallEnding: String, Codable, Equatable, Sendable, CaseIterable {
    /// The person tapped End, or the call went with its connection.
    case hungUp
    /// The agent hung up (its `end_call`).
    case agentHungUp
    /// The person agreed to a fresh call, this one carried over (`happy://call/restart`).
    case restarted
    /// It dropped, or the provider ended it unasked.
    case dropped
    /// One call can run an hour (`CallCues.Timing.callLimit`).
    case callLimit
    /// The device's voice time ran out (`CallAllowance`).
    case timeUsed
    /// Nobody spoke for a while (`CallCues.Timing.silenceEnd`).
    case silence
    /// The phone took the audio: another call, or the audio route went.
    case interrupted
    /// The app left the screen. Earlier builds ended a call there; a call
    /// goes on in the background now, and this only reads kept history.
    case background

    /// An end the person didn't ask for and may not have heard coming:
    /// the drop sound plays for these.
    public var isUnexpected: Bool {
        switch self {
        case .dropped, .callLimit, .timeUsed, .silence: true
        case .hungUp, .agentHungUp, .restarted, .interrupted, .background: false
        }
    }

    /// The person or the agent ended it as asked: worth a line only after words.
    var isPlain: Bool { self == .hungUp || self == .agentHungUp || self == .background }

    /// As the recap says it.
    var said: String {
        switch self {
        case .hungUp: "the person ended the call"
        case .agentHungUp: "you ended the call"
        case .restarted: "the call restarted, carried over"
        case .dropped: "the call dropped (connection lost)"
        case .callLimit: "the call reached its one-hour limit and ended"
        case .timeUsed: "the call ended: the person's voice time ran out"
        case .silence: "the call ended after a long silence"
        case .interrupted: "the call was cut off: the phone took the audio (another call, or the audio route went)"
        case .background: "the call ended when the app left the screen"
        }
    }
}

/// One slot of what calls said: the person's words, the agent's, or how a
/// call ended. Times are seconds since 1970.
public struct CallSlot: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case person, assistant, ended
    }

    public var kind: Kind
    public var text: String?
    public var ending: CallEnding?
    public var at: Double

    public init(kind: Kind, text: String? = nil, ending: CallEnding? = nil, at: Double) {
        self.kind = kind
        self.text = text
        self.ending = ending
        self.at = at
    }

    public static func person(_ text: String, at: Double) -> CallSlot { CallSlot(kind: .person, text: text, at: at) }
    public static func assistant(_ text: String, at: Double) -> CallSlot { CallSlot(kind: .assistant, text: text, at: at) }
    public static func ended(_ ending: CallEnding, at: Double) -> CallSlot { CallSlot(kind: .ended, ending: ending, at: at) }
}

/// Where a connection's call history is kept: one file, read once and
/// written whole after every change, in order.
public protocol CallHistoryStore: Sendable {
    func read() -> Data?
    func write(_ data: Data)
}

/// What the person and the agent said aloud on this connection's calls,
/// and where calls were cut off: the last `slots` of them, kept on this
/// phone only, for the next call's first context (`CallContext.initial`).
/// The person's final transcripts and the agent's words as spoken (its
/// correction when the person cut in), never context, tools or their
/// results, and never the app's cues. Nothing here is logged or sent
/// anywhere but into the next call.
@MainActor
public final class CallHistory {
    public static let slots = 30
    private static let format = 1

    private let store: (any CallHistoryStore)?
    public private(set) var slots: [CallSlot]
    /// Slots added in all, for finding one again by its number.
    private var added = 0
    /// This call's agent responses by their provider event, as numbered.
    private var responses: [Int: Int] = [:]

    private struct File: Codable {
        var format: Int
        var slots: [CallSlot]
    }

    public init(store: (any CallHistoryStore)?) {
        self.store = store
        let file = store?.read().flatMap { try? JSONDecoder().decode(File.self, from: $0) }
        slots = file?.format == Self.format ? Array(file!.slots.suffix(Self.slots)) : []
    }

    /// A new call: its responses are numbered afresh.
    public func began() {
        responses.removeAll()
    }

    public func heard(_ text: String, at: Double) {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return }
        add(.person(words, at: at))
    }

    public func said(_ text: String, event: Int, at: Double) {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return }
        add(.assistant(words, at: at))
        responses[event] = added
    }

    /// The agent's words for `event` as they were heard: the person cut in.
    public func corrected(_ text: String, event: Int) {
        guard let number = responses[event] else { return }
        let index = slots.count - (added - number) - 1
        guard slots.indices.contains(index), slots[index].kind == .assistant else { return }
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if words.isEmpty {
            slots[index].text = "…"
        } else {
            guard slots[index].text != words else { return }
            slots[index].text = words
        }
        save()
    }

    public func ended(_ ending: CallEnding, at: Double) {
        add(.ended(ending, at: at))
    }

    private func add(_ slot: CallSlot) {
        slots.append(slot)
        added += 1
        if slots.count > Self.slots { slots.removeFirst(slots.count - Self.slots) }
        save()
    }

    private func save() {
        guard let store, let data = try? JSONEncoder().encode(File(format: Self.format, slots: slots)) else { return }
        store.write(data)
    }
}

/// A connection's history in its folder (`OfflineFile.writePrivate`):
/// readable only while the phone is unlocked, never backed up, and gone
/// with the connection.
public struct OfflineCallHistoryStore: CallHistoryStore {
    static let name = "call-history.json"
    private let offline: OfflineFile

    public init(offline: OfflineFile) {
        self.offline = offline
    }

    /// After the writes already asked for, whichever store asked.
    public func read() -> Data? { Self.queue.sync { offline.readPrivate(Self.name) } }

    public func write(_ data: Data) {
        Self.queue.async { [offline] in offline.writePrivate(Self.name, data: data) }
    }

    /// Every history's writes, one after another, off the caller's thread.
    private static let queue = DispatchQueue(label: "call-history", qos: .utility)
}
