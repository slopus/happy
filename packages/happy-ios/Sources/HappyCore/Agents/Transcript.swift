import Foundation
import HappyWire

/// A conversation's runs in order, the messages they hold, the messages no
/// run has taken yet, and when each run began and ended: what a
/// `Conversation` draws from.
///
/// Everything an event asks of it is found by key, never by looking
/// through every run or message: which run holds a message, where a run
/// stands, whether a message is waiting. And each change moves a revision
/// of only what it touched (a block of a message, the message, the run that
/// holds it), so a word that arrives makes again only the rows that show
/// it, however long the conversation.
struct Transcript {
    struct Run: Equatable {
        var id: String
        var messageIds: [String]
    }

    private(set) var runs: [Run] = []
    private(set) var messages: [String: AgentWire.Message] = [:]
    /// Messages sent that no run has taken yet, in the order sent.
    private(set) var pending: [String] = []
    private(set) var times: [String: Conversation.RunTime] = [:]

    /// Where each run stands in `runs`: its ordinal less `first`'s, so runs
    /// paged in ahead of the rest take ordinals below it and nothing after
    /// them moves.
    private var ordinals: [String: Int] = [:]
    private var first = 0
    /// The runs each message is in (almost always one).
    private var holders: [String: [String]] = [:]
    private var waiting: Set<String> = []
    /// The message each tool call is in, by call ID.
    private var calls: [String: String] = [:]
    /// The chat UI action blocks held, by the message holding them: what
    /// every offer's state is read from, without looking through the rest.
    private(set) var actions: [String: [UiActionBlock]] = [:]
    /// Text blocks' lengths in UTF-16, by message and block, once counted.
    private var units: [String: [Int: Int]] = [:]

    private var clock: UInt64 = 0
    private var messageRevisions: [String: UInt64] = [:]
    private var blockRevisions: [String: [UInt64]] = [:]
    private var runRevisions: [String: UInt64] = [:]

    // MARK: Reading

    subscript(message id: String) -> AgentWire.Message? { messages[id] }

    /// The run `id`, or nil.
    func run(_ id: String) -> Run? { index(of: id).map { runs[$0] } }

    var lastRunId: String? { runs.last?.id }

    /// A run holds the message, or it waits for one to.
    func isPlaced(_ id: String) -> Bool { waiting.contains(id) || !(holders[id] ?? []).isEmpty }

    /// Where the run holding the tool call stands, or nil.
    func runIndex(holdingCall callId: String) -> Int? {
        guard let messageId = calls[callId], let message = messages[messageId],
              message.content.contains(where: { if case .toolCall(let id, _, _, _, _, _, _, _) = $0 { id == callId } else { false } }),
              let runId = holders[messageId]?.first else { return nil }
        return index(of: runId)
    }

    /// Moves whenever the message does.
    func revision(ofMessage id: String) -> UInt64 { messageRevisions[id] ?? 0 }

    /// Moves whenever the block does: a word appended, or the block replaced
    /// by a different one.
    func revision(ofBlock index: Int, in id: String) -> UInt64 {
        guard let revisions = blockRevisions[id], revisions.indices.contains(index) else { return 0 }
        return revisions[index]
    }

    /// Moves whenever a message it holds, the messages it holds, or its time does.
    func revision(ofRun id: String) -> UInt64 { runRevisions[id] ?? 0 }

    private func index(of runId: String) -> Int? {
        guard let ordinal = ordinals[runId] else { return nil }
        let index = ordinal - first
        return runs.indices.contains(index) ? index : nil
    }

    // MARK: Changing

    /// The message as it now is: only blocks that differ from the ones held
    /// move.
    mutating func set(_ message: AgentWire.Message) {
        let old = messages[message.id]
        messages[message.id] = message
        units[message.id] = nil
        clock += 1
        var revisions = blockRevisions[message.id] ?? []
        revisions.reserveCapacity(message.content.count)
        for (index, block) in message.content.enumerated() {
            if index < revisions.count {
                if let old, index < old.content.count, old.content[index] == block { continue }
                revisions[index] = clock
            } else {
                revisions.append(clock)
            }
        }
        if revisions.count > message.content.count { revisions.removeLast(revisions.count - message.content.count) }
        blockRevisions[message.id] = revisions
        index(calls: message)
        touch(message: message.id)
    }

    /// What a `message.delta` does to text block `index` of message `id`
    /// (`Conversation.growth`); nil where it can't apply. The block's length
    /// in UTF-16 is kept, so a word at its end is told without counting it.
    mutating func growth(ofBlock index: Int, in id: String, offset: Int, append: String) -> Conversation.Growth? {
        guard let message = messages[id], message.content.indices.contains(index) else { return nil }
        let text: String
        switch message.content[index] {
        case .text(let current), .reasoning(let current): text = current
        default: return nil
        }
        let count: Int
        if let known = units[id]?[index] {
            count = known
        } else {
            count = text.utf16.count
            units[id, default: [:]][index] = count
        }
        return Conversation.growth(text, count: count, offset: offset, append: append)
    }

    /// `suffix` appended to text block `index` of message `id`, in place:
    /// that block alone moves, and the words before it aren't copied.
    mutating func append(_ suffix: String, toBlock index: Int, of id: String) {
        guard var message = messages.removeValue(forKey: id) else { return }
        defer { messages[id] = message }
        guard message.content.indices.contains(index) else { return }
        // Taken out of the block first, the text is held once and grows where it is.
        switch message.content[index] {
        case .text(var text):
            message.content[index] = .unknown("")
            text += suffix
            message.content[index] = .text(text)
        case .reasoning(var text):
            message.content[index] = .unknown("")
            text += suffix
            message.content[index] = .reasoning(text)
        default:
            return
        }
        if let known = units[id]?[index] { units[id]?[index] = known + suffix.utf16.count }
        clock += 1
        if blockRevisions[id]?.indices.contains(index) == true { blockRevisions[id]?[index] = clock }
        touch(message: id)
    }

    /// A message's status, without its blocks moving.
    mutating func setStatus(_ status: String?, of id: String) {
        guard var message = messages[id], message.status != status else { return }
        message.status = status
        messages[id] = message
        clock += 1
        touch(message: id)
    }

    mutating func remove(message id: String) {
        guard messages.removeValue(forKey: id) != nil || isPlaced(id) else { return }
        messageRevisions[id] = nil
        blockRevisions[id] = nil
        units[id] = nil
        actions[id] = nil
        unwait(id)
        clock += 1
        for runId in holders.removeValue(forKey: id) ?? [] {
            guard let index = index(of: runId) else { continue }
            runs[index].messageIds.removeAll { $0 == id }
            runRevisions[runId] = clock
        }
    }

    /// The message is in run `runId`, after what it holds, and waits no more.
    mutating func place(_ id: String, in runId: String) {
        unwait(id)
        if holders[id]?.contains(runId) == true { return }
        clock += 1
        if let index = index(of: runId) {
            runs[index].messageIds.append(id)
        } else {
            append(Run(id: runId, messageIds: [id]))
        }
        holders[id, default: []].append(runId)
        runRevisions[runId] = clock
    }

    /// Sent, and no run has it yet: it waits, after the others.
    mutating func wait(_ id: String) {
        guard !isPlaced(id) else { return }
        waiting.insert(id)
        pending.append(id)
    }

    /// The run began with `ids`, which open it in the order taken, and are
    /// accepted.
    mutating func accept(_ ids: [String], into runId: String) {
        if index(of: runId) == nil { append(Run(id: runId, messageIds: [])) }
        guard let index = index(of: runId) else { return }
        var seen = Set<String>()
        let accepted = ids.filter { holders[$0]?.contains(runId) != true && seen.insert($0).inserted }
        clock += 1
        runs[index].messageIds.insert(contentsOf: accepted, at: 0)
        for id in accepted { holders[id, default: []].append(runId) }
        runRevisions[runId] = clock
        for id in ids {
            unwait(id)
            setStatus("accepted", of: id)
        }
    }

    mutating func setTime(_ time: Conversation.RunTime, for runId: String) {
        guard times[runId] != time else { return }
        times[runId] = time
        clock += 1
        runRevisions[runId] = clock
    }

    /// Runs read ahead of the first one held, oldest first.
    mutating func prepend(_ older: [AgentWire.Run]) {
        guard !older.isEmpty else { return }
        clock += 1
        first -= older.count
        runs.insert(contentsOf: older.map { Run(id: $0.id, messageIds: ($0.messages ?? []).map(\.id)) }, at: 0)
        for (offset, run) in older.enumerated() {
            ordinals[run.id] = first + offset
            runRevisions[run.id] = clock
            times[run.id] = Conversation.RunTime(run)
            for message in run.messages ?? [] {
                holders[message.id, default: []].append(run.id)
                set(message)
            }
        }
    }

    /// A newest page read whole, after `runs`.
    mutating func append(read run: AgentWire.Run) {
        append(Run(id: run.id, messageIds: (run.messages ?? []).map(\.id)))
        times[run.id] = Conversation.RunTime(run)
        for message in run.messages ?? [] {
            holders[message.id, default: []].append(run.id)
            set(message)
        }
    }

    /// Everything held, replaced: a read, a trim, what was kept.
    mutating func replace(runs: [Run], messages: [String: AgentWire.Message], pending: [String], times: [String: Conversation.RunTime]) {
        let held = self.messages
        let heldRuns = Dictionary(self.runs.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let heldTimes = self.times
        self.runs = runs
        self.messages = [:]
        self.pending = []
        self.times = times
        waiting = []
        holders = [:]
        ordinals = [:]
        calls = [:]
        actions = [:]
        first = 0
        clock += 1
        var kept: [String: [UInt64]] = [:]
        var keptRevisions: [String: UInt64] = [:]
        for (id, message) in messages {
            // The same message as before keeps its revisions: what showed it is shown again as it was.
            if held[id] == message, let revisions = blockRevisions[id], let revision = messageRevisions[id] {
                self.messages[id] = message
                kept[id] = revisions
                keptRevisions[id] = revision
                index(calls: message)
            }
        }
        blockRevisions = kept
        messageRevisions = keptRevisions
        units = units.filter { kept[$0.key] != nil }
        var runRevisions: [String: UInt64] = [:]
        for (offset, run) in runs.enumerated() {
            ordinals[run.id] = offset
            for id in run.messageIds { holders[id, default: []].append(run.id) }
            // A run that holds what it held, as it was, keeps its revision.
            let same = heldRuns[run.id] == run && heldTimes[run.id] == times[run.id]
                && run.messageIds.allSatisfy { kept[$0] != nil || (messages[$0] == nil && held[$0] == nil) }
            runRevisions[run.id] = same ? self.runRevisions[run.id] ?? clock : clock
        }
        self.runRevisions = runRevisions
        for (id, message) in messages where self.messages[id] == nil { set(message) }
        for id in pending { wait(id) }
    }

    private mutating func append(_ run: Run) {
        ordinals[run.id] = first + runs.count
        runs.append(run)
        clock += 1
        runRevisions[run.id] = clock
    }

    private mutating func unwait(_ id: String) {
        guard waiting.remove(id) != nil else { return }
        pending.removeAll { $0 == id }
    }

    private mutating func touch(message id: String) {
        messageRevisions[id] = clock
        for runId in holders[id] ?? [] { runRevisions[runId] = clock }
    }

    private mutating func index(calls message: AgentWire.Message) {
        var held: [UiActionBlock] = []
        for block in message.content {
            if case .toolCall(let id, _, _, _, _, _, _, _) = block { calls[id] = message.id }
            if case .action(let action) = block { held.append(action) }
        }
        actions[message.id] = held.isEmpty ? nil : held
    }
}
