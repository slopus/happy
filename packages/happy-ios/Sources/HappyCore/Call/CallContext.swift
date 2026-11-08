import Foundation
#if !canImport(Darwin)
import CoreFoundation
#endif

/// What a call adds to the hosted agent's context as things change: JSON
/// lines it reads without answering. Nothing here asks it to speak.
public struct CallUpdate: Equatable, Sendable {
    public var context: [String]

    public init(context: [String] = []) {
        self.context = context
    }

    public var isEmpty: Bool { context.isEmpty }
}

/// How a `readConversation` that answered `checking` goes on
/// (`CallContext.onReading`): the agent was told it is checking, then the
/// read is in, as a cue to tell once the moment is right.
public enum CallReading: Equatable, Sendable {
    case checking
    case read(CallCue)
}

/// Lives only during one call, bound to one account. It owns the opaque
/// references the hosted agent knows conversations by, the focus, and the
/// last four conversations visited or messaged during the call, which are
/// the ones it hears from; it runs the tools one at a time. A followed
/// conversation says only what its agent writes from then on, each piece
/// once it is complete and whole, and an error that stopped it: never its
/// words as they stream, its tools, its state or the person's messages.
///
/// The call starts with the directory: the sidebar's bots, tasks, subtasks
/// and project conversations, in its order and nesting, as plain lines
/// that give each its reference, in the first context. It never goes whole
/// again: what came, went, was renamed or moved since follows as a
/// `directory` update of just that (`directoryUpdate`). A reference is an
/// order key (`OrderKey`): sorted as text, references give the sidebar's
/// order, and a conversation that comes later gets one between its
/// neighbours', so none ever changes. Updates name a conversation by its
/// title and what it sits under, and by its reference too when that alone
/// leaves it unclear or the agent hasn't had it yet.
public actor CallContext {
    public enum Limits {
        /// The first context, and half of it a resync. The prompt's override
        /// goes beside it in the call's first message, which the data channel
        /// takes up to 64,000 bytes (LiveKit).
        public static let totalBytes = 32 * 1024
        /// A read (`readConversation`), as it goes on the wire
        /// (`escapedSize`): one escaped string in a data channel message,
        /// which LiveKit takes up to 64,000 bytes, its envelope beside it.
        /// A read pages and cuts its messages by words (`CallRead`) within it.
        public static let readBytes = 56 * 1024
        /// Turns the first context shows, the person's message still waiting
        /// for an answer counted as one: each the person's message and the
        /// agent's last words, or as much of the pair as there is.
        public static let turns = 5
        /// One of the agent's messages in the first context and in updates: a
        /// thousand words of technical prose, Markdown and all (6.3 to 7.3
        /// bytes a word in this repository's docs).
        public static let replyBytes = 8 * 1024
        /// One of the person's own, a third of that.
        public static let userBytes = 2 * 1024
        public static let errorBytes = 1024
        /// Conversations the first context lists, and its directory's size.
        public static let directory = 100
        public static let directoryBytes = 12 * 1024
        /// What one `directory` update tells at most, and its size.
        public static let directoryChanges = 20
        public static let directoryUpdateBytes = 4 * 1024
        /// How long the sidebar's changes settle before they go, from the
        /// first: "New Task" and the name it gets a moment later go as one.
        public static let settle: Duration = .seconds(1)
        public static let page = 50
        /// Conversations the call hears from: the last ones visited or
        /// messaged, the one on screen included.
        public static let visited = 4
        /// The agent's messages looked at per change, newest last.
        public static let messages = 20
        public static let textBytes = 8 * 1024
        public static let toolDeadline: Duration = .seconds(8)
        /// How long a read waits to make a conversation current before it
        /// answers `checking`, and how long it goes on after that before
        /// what it has is told as stale.
        public static let readGrace: Duration = .seconds(1)
        public static let refresh: Duration = .seconds(8)
        /// Models a read or a refusal lists.
        public static let models = 30
        /// What earlier calls said, in the first context (`CallHistory`),
        /// and each of its lines' words.
        public static let recapBytes = 8 * 1024
        public static let slotBytes = 1024
    }

    /// The references `message` starts new work with, as the first
    /// context lists them; a name after a colon names it.
    public static let newTaskRef = "new-task"
    public static let newBotRef = "new-bot"

    /// Where `navigate` goes, as the first context lists them.
    public static let homeURL = "happy://home"
    public static let backURL = "happy://back"
    public static let conversationURL = "happy://conversation/"
    /// Not a screen: the call, ended and started again at once, carried
    /// over (`CallSession.requestRestart`). Listed in the first context
    /// only; the dashboard's navigate description names the screens.
    public static let restartURL = "happy://call/restart"
    static let destinations = [homeURL, backURL, conversationURL + "<ref>"]

    private let targets: any CallTargets
    private let now: @Sendable () -> Double
    private let timeZone: TimeZone
    private let toolDeadline: Duration
    private var refs: [String: String] = [:]
    private var agents: [String: String] = [:]
    /// Every order key handed out this call, sorted: none is handed out twice.
    private var keys: [String] = []
    private var focus: String?
    private var focusRevision = 0
    /// Newest first.
    private var visited: [String] = []
    /// The sidebar's conversations as last seen, in order and by ID.
    private var entries: [CallTarget] = []
    private var directory: [String: CallTarget] = [:]
    /// The directory as the agent has it: from the first context, then as
    /// each `directory` update left it.
    private var listed: [Listing] = []
    /// The first context's, which nothing can lose.
    private var first: [Listing] = []
    private var begun = false
    /// Work the sidebar doesn't list until its first message makes it:
    /// what `message` started, or compose's in front.
    private var drafts: [String: CallTarget] = [:]
    /// The conversations whose reference the agent has: from the first
    /// context, `listConversations`, a tool's answer or an update.
    private var told: Set<String> = []
    /// New work `message` started, by the ID its first message went
    /// under: the same words again reach it, never a second one.
    private var startedBy: [String: String] = [:]
    private var heard: [String: Heard] = [:]
    private var spoken = 0
    /// Sends whose answer the agent may not have had, by target and text:
    /// the same words to the same conversation again go under the same ID,
    /// which the conversation takes once.
    private var unsettled: [String: String] = [:]
    private var settling: [String: String] = [:]
    private var results: [String: Task<CallToolResult, Never>] = [:]
    private var tail: Task<Void, Never>?
    private var closed = false
    private var restart: (@Sendable () async -> CallToolResult)?
    private let readGrace: Duration
    private let refreshLimit: Duration
    /// Reads that answered `checking`, by conversation, still on their way,
    /// with what each asked for: another read of one joins its refresh, and
    /// one cue answers each different ask.
    private var reading: [String: (refresh: Task<CallTargetState?, Never>, requests: [CallRead.Request])] = [:]
    private var onReading: (@Sendable (CallReading) -> Void)?

    /// What the agent has of one visited conversation: its agent's complete
    /// messages, those there when it was first seen counted as had, and the
    /// errors it knows of.
    private struct Heard {
        var had: Set<String> = []
        /// The messages this call told of, with the event that told it, in
        /// the order told.
        var said: [String: (at: Int, event: String)] = [:]
        var errors: Set<String> = []
        /// The errors this call told of, by turn, with the event that told it.
        var told: [String: String] = [:]
    }

    /// A conversation as the agent's directory has it: what a rename or a
    /// move changes.
    private struct Listing: Equatable {
        var agentId: String
        var title: String
        var kind: CallTarget.Kind
        /// What it sits under, by the sidebar's IDs.
        var under: [String]

        init(_ target: CallTarget) {
            agentId = target.agentId
            title = target.title
            kind = target.kind
            under = target.parents.map { $0.agentId ?? $0.id }
        }
    }

    public init(targets: any CallTargets, now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 },
                timeZone: TimeZone = .current, toolDeadline: Duration = Limits.toolDeadline,
                readGrace: Duration = Limits.readGrace, refresh: Duration = Limits.refresh) {
        self.targets = targets
        self.now = now
        self.timeZone = timeZone
        self.toolDeadline = toolDeadline
        self.readGrace = readGrace
        self.refreshLimit = refresh
    }

    /// The conversations the call hears from now, the latest visited or messaged first.
    public var followed: [String] { visited }

    public func close() {
        closed = true
        for task in results.values { task.cancel() }
        for read in reading.values { read.refresh.cancel() }
        reading.removeAll()
    }

    /// Where a read that answered `checking` goes on: that the agent was
    /// told so, then the read itself as a cue (`conversation_read`). Nothing
    /// once the call has ended.
    public func onReading(_ handler: @escaping @Sendable (CallReading) -> Void) {
        onReading = handler
    }

    /// What `navigate` to `restartURL` does: the call's to say.
    public func onRestart(_ handler: @escaping @Sendable () async -> CallToolResult) {
        restart = handler
    }

    // MARK: The first context

    /// `initialConversationContext`, the hosted prompt's one variable, as
    /// plain text: the time and focusRevision, what earlier calls said
    /// (`previous`, `CallHistory`), the conversation on screen with its
    /// last five turns and the models it can switch to, the directory, how
    /// new work starts and where `navigate` goes. Within
    /// `Limits.totalBytes`: the older turns give way first, then the
    /// directory's tail, then the recap's older lines (nothing else has
    /// them), and the newest turn only after that. A new conversation's:
    /// the agent has no reference yet. In a team, `person` names who it
    /// talks to (`personText`).
    public func initial(previous: [CallSlot] = [], person: String? = nil) async -> String {
        told.removeAll()
        see(await targets.directory())
        listed = entries.map(Listing.init)
        first = listed
        begun = true
        focus = await targets.focused()
        var focused: CallTargetState?
        if let focus {
            visit(focus)
            if directory[focus] == nil, let draft = await targets.unlisted(focus) { drafts[focus] = draft }
            if let state = await targets.state(of: focus) {
                focused = state
                if heard[focus] == nil { listen(state) }
            }
        }
        let header = "Now: \(Self.local(now(), in: timeZone)) (the person's local time)\nfocusRevision: \(focusRevision)"
            + (person.map { "\n" + Self.personText($0) } ?? "")
        var turns = focused.map(Self.recent) ?? []
        var budget = Limits.directoryBytes
        var recapBudget = Limits.recapBytes
        let at = now()
        func text(telling: Bool = false) -> String {
            [header, Self.recap(previous, now: at, bytes: recapBudget), screen(focused, turns: turns), directoryText(bytes: budget, telling: telling),
             Self.newWorkText, Self.destinationsText].compactMap { $0 }.joined(separator: "\n\n")
        }
        while text().utf8.count > Limits.totalBytes, turns.count > 1 { turns.removeFirst() }
        while text().utf8.count > Limits.totalBytes, budget > 512 { budget /= 2 }
        while text().utf8.count > Limits.totalBytes, recapBudget > 512 { recapBudget /= 2 }
        while text().utf8.count > Limits.totalBytes, !turns.isEmpty { turns.removeFirst() }
        if let focus { told.insert(focus) }
        return text(telling: true)
    }

    /// Who the call talks to, in a team.
    static func personText(_ name: String) -> String {
        "The person: \(name), a member of this team. They mostly ask about their own work; look across the team only when they ask about the team or others' work."
    }

    /// How the first context starts new work, as `message` takes it.
    static let newWorkText = """
    New work (message's to; listed nowhere until its first message makes it):
    - \(newTaskRef) — a new task, the message its first
    - \(newBotRef) — a new bot, the message its first
    A name after a colon names it: \(newBotRef):Release helper.
    """

    /// Where the first context says `navigate` goes.
    static let destinationsText = """
    Destinations (navigate's to):
    - \(homeURL) — the home list
    - \(backURL) — one screen back; refused at home
    - \(conversationURL)<ref> — that conversation on screen, such as \(conversationURL)s1
    - \(restartURL) — end this call and start a new one at once, this conversation carried over; only when the person agrees
    """

    /// What earlier calls said, oldest first, each line with how long ago:
    /// the newest within `bytes`, each line's words within
    /// `Limits.slotBytes`. Nil when nothing was said.
    static func recap(_ slots: [CallSlot], now: Double, bytes: Int) -> String? {
        guard !slots.isEmpty else { return nil }
        let header = "Previous voice conversation (earlier calls, oldest first):"
        let cut = "Older lines aren't shown."
        var lines: [String] = []
        var size = header.utf8.count + cut.utf8.count + 2
        for slot in slots.reversed() {
            let when = Self.ago(now - slot.at)
            let line: String = switch slot.kind {
            case .person: "- \(when), the person: " + indented(clipped(slot.text ?? "", bytes: Limits.slotBytes))
            case .assistant: "- \(when), you: " + indented(clipped(slot.text ?? "", bytes: Limits.slotBytes))
            case .ended: "- \(when): " + (slot.ending ?? .dropped).said
            }
            guard size + line.utf8.count + 1 <= bytes else { break }
            size += line.utf8.count + 1
            lines.append(line)
        }
        guard !lines.isEmpty else { return header + "\n" + cut }
        return ([header] + (lines.count < slots.count ? [cut] : []) + lines.reversed()).joined(separator: "\n")
    }

    /// The conversation on screen as the first context tells it: what
    /// `readConversation` reads of it, as lines.
    private func screen(_ state: CallTargetState?, turns: [CallTurn]) -> String {
        guard let state, let focus else { return "On screen: no conversation (home, Settings or another screen)." }
        let target = state.target
        var lines = ["On screen: \(target.title) — \(target.kind.rawValue), ref \(ref(focus))"
            + (target.parents.isEmpty ? "" : ", under \(target.parents.map(\.title).joined(separator: " > "))")]
        lines.append("Working: \(state.working ? "yes" : "no"). Needs the person: \(state.needsInput ? "yes" : "no").")
        if let last = state.messages.last(where: { $0.role == .user && ($0.time ?? 0) > 0 }), let at = last.time {
            lines.append("Last message from \(last.by ?? "the person"): \(said(at))")
        }
        if let at = state.turns.filter({ $0.reply?.isEmpty == false }).compactMap(\.endedAt).filter({ $0 > 0 }).max() {
            lines.append("Last reply: \(said(at))")
        }
        if !target.workspace.isEmpty { lines.append("Workspace: \(target.workspace.joined(separator: " / "))") }
        if let mode = state.mode { lines.append("Model: \(mode.model)" + (mode.effort.isEmpty ? "" : ", effort \(mode.effort)")) }
        if !state.models.isEmpty {
            lines.append("Models it can switch to:")
            for model in state.models.prefix(Limits.models) {
                lines.append("- \(model.name) — id \(model.id)" + (model.efforts.isEmpty ? "" : ", efforts \(model.efforts.joined(separator: ", "))"))
            }
        }
        if turns.isEmpty {
            lines.append("No turns yet.")
        } else {
            lines.append("Last turns, oldest first:")
            for (index, turn) in turns.enumerated() { lines.append(Self.turnText(turn, number: index + 1)) }
        }
        if state.hasMore || Self.answering(state).count > turns.count { lines.append("Older turns aren't shown.") }
        if let pending = state.unanswered {
            let text = Self.clipped(pending.text, bytes: Limits.userBytes)
            let delivery: String = switch pending.delivery {
            case .queued?: ", still on this phone"
            case .failed?: ", which failed to send"
            default: ""
            }
            lines.append("Waiting for an answer, from \(pending.by ?? "the person")\(delivery):\n   " + Self.indented(text))
        }
        return lines.joined(separator: "\n")
    }

    /// "5 minutes ago (2026-11-06T09:15:00+01:00)".
    private func said(_ ms: Double) -> String {
        "\(Self.ago(now() - ms / 1000)) (\(Self.local(ms / 1000, in: timeZone)))"
    }

    /// One turn of the first context: who asked, the agent's last words,
    /// and how it ended when that wasn't plain.
    static func turnText(_ turn: CallTurn, number: Int) -> String {
        var lines: [String] = []
        func text(_ words: String?, as who: String, bytes: Int) {
            guard let words, !words.isEmpty else { return }
            lines.append("\(who): " + indented(clipped(words, bytes: bytes)))
        }
        text(turn.user, as: turn.userBy.map { $0 == "the person" ? "The person" : $0 } ?? "The person", bytes: Limits.userBytes)
        text(turn.reply, as: "Agent", bytes: Limits.replyBytes)
        if turn.ended == "error" {
            lines.append("Ended in an error" + (turn.error.flatMap { $0.isEmpty ? nil : ": " + indented(truncated($0, bytes: Limits.errorBytes)) } ?? "."))
        } else if turn.ended != "completed" {
            lines.append("Ended: \(turn.ended)")
        }
        return "\(number). " + lines.joined(separator: "\n   ")
    }

    /// `text` with its later lines indented under the first.
    private static func indented(_ text: String) -> String {
        text.replacingOccurrences(of: "\n", with: "\n   ")
    }

    // MARK: What changes

    /// Something on screen changed which conversation is in front. A
    /// conversation becomes the latest visited; the fifth one back is no
    /// longer heard from. Settings or home in front keep them all.
    public func focusChanged(to agentId: String?) async -> CallUpdate {
        guard !closed, agentId != focus else { return CallUpdate() }
        // Newer than the directory as last seen: as the sidebar has it now.
        if let agentId, directory[agentId] == nil {
            see(await targets.directory())
            if directory[agentId] == nil, drafts[agentId] == nil, let draft = await targets.unlisted(agentId) { drafts[agentId] = draft }
            guard !closed, agentId != focus else { return CallUpdate() }
        }
        return moveFocus(to: agentId)
    }

    /// The focus moves, by the person or by a tool. One the agent has no
    /// reference for yet comes with it.
    private func moveFocus(to agentId: String?) -> CallUpdate {
        guard !closed, agentId != focus else { return CallUpdate() }
        focus = agentId
        focusRevision += 1
        var event: [String: Any] = ["event": "focus", "focusRevision": focusRevision, "title": NSNull()]
        if let agentId {
            visit(agentId)
            if let entry = directory[agentId] ?? drafts[agentId] { event.merge(address(entry)) { _, new in new } }
        }
        return CallUpdate(context: [Self.string(event)])
    }

    /// One visited conversation's newest state. The first one the call
    /// sees is what was there already, and says nothing; after it, each of
    /// its agent's messages once it is complete (`CallMessage.final`), whole
    /// (`assistant_text`), never while it grows; and a turn an error ended
    /// (`session_error`). Nothing is told twice.
    public func targetChanged(_ state: CallTargetState) -> CallUpdate {
        let id = state.target.agentId
        // Gone from the sidebar: never told of again, and nothing about it goes.
        guard !closed, visited.contains(id), directory[id] != nil else { return CallUpdate() }
        guard var known = heard[id] else {
            listen(state)
            return CallUpdate()
        }
        let address = address(state.target)
        var context: [String] = []
        let ended = Set(state.turns.map(\.id))
        var last: [String: String] = [:]
        for message in state.messages where message.role == .assistant { if let turn = message.turn { last[turn] = message.id } }
        for message in state.messages.suffix(Limits.messages) where message.role == .assistant && message.final {
            guard !known.had.contains(message.id), !message.text.isEmpty else { continue }
            known.had.insert(message.id)
            let text = Self.clipped(message.text, bytes: Limits.replyBytes)
            var event = address
            event["event"] = "assistant_text"
            event["text"] = text
            if text != message.text { event["truncated"] = true }
            // Its run is over and these were its last words.
            if let turn = message.turn, ended.contains(turn), last[turn] == message.id { event["finishedTurn"] = true }
            let line = Self.string(event)
            spoken += 1
            known.said[message.id] = (spoken, line)
            context.append(line)
        }
        for turn in state.turns where turn.ended == "error" && !known.errors.contains(turn.id) {
            var event = address
            event["event"] = "session_error"
            if let reason = turn.error, !reason.isEmpty { event["reason"] = Self.truncated(reason, bytes: Limits.errorBytes) }
            let line = Self.string(event)
            known.told[turn.id] = line
            context.append(line)
        }
        known.errors = Set(state.turns.filter { $0.ended == "error" }.map(\.id))
        known.told = known.told.filter { known.errors.contains($0.key) }
        heard[id] = known
        return CallUpdate(context: context)
    }

    /// The context waiting for the call was too much and went unsent
    /// (`CallSession.pendingBytes`): what the agent now has wrong is put
    /// right in one go. What the sidebar changed since the first context
    /// (`directory`), then the focus, marked `resync`, with its reference,
    /// then the errors this call told of and each message it told, as it
    /// told it, the most recent kept first, within half of
    /// `Limits.totalBytes`. What doesn't fit is counted in `omitted`; a
    /// read (`readConversation`) has it. The first context is the
    /// prompt's, never lost.
    public func resync() -> CallUpdate {
        guard !closed else { return CallUpdate() }
        let news = begun ? news(since: first) : nil
        var errors: [String] = []
        var streamed: [(at: Int, event: String)] = []
        for id in visited {
            guard let known = heard[id] else { continue }
            streamed += known.said.values.map { ($0.at, $0.event) }
            for turn in known.told.keys.sorted() { errors.append(known.told[turn]!) }
        }
        let items = errors + streamed.sorted { $0.at > $1.at }.map(\.event)
        var focusEvent: [String: Any] = ["event": "focus", "focusRevision": focusRevision, "title": NSNull(), "resync": true]
        if let focus, let target = directory[focus] ?? drafts[focus] {
            focusEvent.merge(address(target)) { _, new in new }
            focusEvent["ref"] = ref(focus)
        }
        var kept: [String] = []
        var bytes = Self.string(focusEvent).utf8.count + 32 + (news?.utf8.count ?? 0)
        for item in items where bytes + item.utf8.count + 1 <= Limits.totalBytes / 2 {
            kept.append(item)
            bytes += item.utf8.count + 1
        }
        if kept.count < items.count { focusEvent["omitted"] = items.count - kept.count }
        // Oldest first, as they would have come.
        let errorCount = kept.prefix { errors.contains($0) }.count
        return CallUpdate(context: (news.map { [$0] } ?? []) + [Self.string(focusEvent)] + kept.prefix(errorCount) + kept.dropFirst(errorCount).reversed())
    }

    // MARK: The directory

    /// The sidebar's conversations, as just read, once each (the first
    /// wins), each with its reference.
    private func see(_ now: [CallTarget]) {
        var seen = Set<String>()
        entries = now.filter { seen.insert($0.agentId).inserted }
        directory = Dictionary(entries.map { ($0.agentId, $0) }, uniquingKeysWith: { first, _ in first })
        // Made by its first message: the sidebar's from now on.
        for id in drafts.keys where directory[id] != nil { drafts[id] = nil }
        place(entries)
    }

    /// The sidebar changed, maybe only a status. True when the agent's
    /// directory is no longer what it lists: a conversation came, went, was
    /// renamed or moved. `directoryUpdate` is due then, once `Limits.settle`
    /// has passed since the first such change (`DirectorySettle`).
    public func directoryChanged(_ now: [CallTarget]) -> Bool {
        guard !closed, begun else { return false }
        see(now)
        return entries.map(Listing.init) != listed
    }

    /// The sidebar read again, and what changed since the agent's
    /// directory was last put right: one `directory` event, or nothing.
    /// Never the whole directory again.
    public func directoryUpdate() async -> CallUpdate {
        guard !closed, begun else { return CallUpdate() }
        let now = await targets.directory()
        guard !closed else { return CallUpdate() }
        see(now)
        return CallUpdate(context: news(since: listed).map { [$0] } ?? [])
    }

    /// The `directory` event that brings the agent's directory, as it was
    /// at `before`, to the sidebar as last seen; nil when nothing came and
    /// nothing the agent was told of changed. `added`: what came, each with
    /// its reference, title, kind and the titles it sits under, and
    /// `after` (the reference of what it follows in the sidebar, null for
    /// the first) only when its reference doesn't sort between its
    /// neighbours'. `removed`: the references of what went. `renamed`: a
    /// new title. `moved`: where one sits now, `after` and its `parents`,
    /// its reference unchanged; what kept its order among the rest (the
    /// longest run, `kept`) didn't move. Each in the sidebar's order, at
    /// most `Limits.directoryChanges` in all within
    /// `Limits.directoryUpdateBytes`, the rest counted in `more`.
    private func news(since before: [Listing]) -> String? {
        let now = entries
        listed = now.map(Listing.init)
        var was: [String: (at: Int, listing: Listing)] = [:]
        for (at, listing) in before.enumerated() where was[listing.agentId] == nil { was[listing.agentId] = (at, listing) }
        func key(_ index: Int) -> String? { now.indices.contains(index) ? String(ref(now[index].agentId).dropFirst()) : nil }
        func after(_ index: Int) -> Any { index > 0 ? ref(now[index - 1].agentId) : NSNull() }
        var added: [(agentId: String, value: [String: Any])] = []
        var common: [(index: Int, at: Int)] = []
        for (index, entry) in now.enumerated() {
            if let old = was[entry.agentId] {
                common.append((index, old.at))
                continue
            }
            var value: [String: Any] = ["ref": ref(entry.agentId), "title": entry.title, "kind": entry.kind.rawValue]
            if !entry.parents.isEmpty { value["parents"] = entry.parents.map(\.title) }
            // Sorted by its reference it would sit elsewhere: new work the call
            // started before the sidebar had it, or one placed by a moved neighbour.
            let own = key(index)!
            if key(index - 1).map({ $0 >= own }) == true || key(index + 1).map({ $0 <= own }) == true { value["after"] = after(index) }
            added.append((entry.agentId, value))
        }
        let steady = Self.kept(common.map(\.at))
        var renamed: [[String: Any]] = []
        var moved: [[String: Any]] = []
        for (position, pair) in common.enumerated() {
            let entry = now[pair.index]
            guard told.contains(entry.agentId), let old = was[entry.agentId]?.listing else { continue }
            let listing = Listing(entry)
            if listing.title != old.title { renamed.append(["ref": ref(entry.agentId), "title": entry.title]) }
            if !steady.contains(position) || listing.under != old.under || listing.kind != old.kind {
                var value: [String: Any] = ["ref": ref(entry.agentId), "after": after(pair.index), "parents": entry.parents.map(\.title)]
                if listing.kind != old.kind { value["kind"] = entry.kind.rawValue }
                moved.append(value)
            }
        }
        let ids = Set(now.map(\.agentId))
        let removed = before.filter { !ids.contains($0.agentId) && told.contains($0.agentId) }.map(\.agentId)
        let total = added.count + removed.count + renamed.count + moved.count
        guard total > 0 else { return nil }
        var event: [String: Any] = ["event": "directory"]
        var taken = 0
        // Room for `more` is kept.
        func fits(_ item: Any, in list: String) -> Bool {
            guard taken < Limits.directoryChanges else { return false }
            var next = event
            next[list] = ((next[list] as? [Any]) ?? []) + [item]
            guard Self.string(next).utf8.count + 16 <= Limits.directoryUpdateBytes else { return false }
            event = next
            taken += 1
            return true
        }
        for item in added where fits(item.value, in: "added") { told.insert(item.agentId) }
        // Still told: a resync tells it again, and back, it is added.
        for agentId in removed { _ = fits(ref(agentId), in: "removed") }
        for item in renamed { _ = fits(item, in: "renamed") }
        for item in moved { _ = fits(item, in: "moved") }
        if taken < total { event["more"] = total - taken }
        return Self.string(event)
    }

    /// The positions of a longest increasing run in `values`, its members
    /// not necessarily next to each other: what kept its order. The rest
    /// moved.
    static func kept(_ values: [Int]) -> Set<Int> {
        // The position ending the smallest-tailed run of each length.
        var tails: [Int] = []
        var previous = Array(repeating: -1, count: values.count)
        for (position, value) in values.enumerated() {
            var low = 0
            var high = tails.count
            while low < high {
                let middle = (low + high) / 2
                if values[tails[middle]] < value { low = middle + 1 } else { high = middle }
            }
            if low > 0 { previous[position] = tails[low - 1] }
            if low == tails.count { tails.append(position) } else { tails[low] = position }
        }
        var result = Set<Int>()
        var position = tails.last ?? -1
        while position >= 0 {
            result.insert(position)
            position = previous[position]
        }
        return result
    }

    /// The directory as the first context has it: a line for each
    /// conversation, indented under what it sits in, with its kind and
    /// reference; a project or a worktree a line without one. Within
    /// `bytes` and `Limits.directory` conversations, the rest counted at
    /// the end. `telling` marks each one shown as told.
    private func directoryText(bytes: Int, telling: Bool) -> String {
        let marker = 96
        var (text, shown, taken) = lines(entries, header: "Conversations in the app, in the sidebar's order:", bytes: bytes - marker, count: Limits.directory)
        let omitted = entries.count - taken
        if entries.isEmpty { text += "\nNone yet." }
        if omitted > 0 { text += "\n… and \(omitted) more; listConversations finds them by title." }
        if telling { told.formUnion(shown) }
        return text
    }

    /// `list` as indented lines under `header`, as many as fit, each with
    /// whatever it sits under that the lines before didn't show. The
    /// conversations shown, the ones they sit under included, by ID; the
    /// first `count` of `list` at most.
    private func lines(_ list: [CallTarget], header: String, bytes: Int, count: Int) -> (text: String, shown: [String], taken: Int) {
        var text = header
        var path: [String] = []
        var shown: [String] = []
        var taken = 0
        for entry in list where taken < count {
            let keys = entry.parents.map { $0.agentId ?? $0.id }
            let common = zip(path, keys).prefix { $0 == $1 }.count
            var chunk = ""
            var under: [String] = []
            var flat = false
            for (depth, parent) in entry.parents.enumerated().dropFirst(common) {
                let indent = String(repeating: "  ", count: depth)
                if let agentId = parent.agentId {
                    chunk += "\n\(indent)- \(parent.title) — \(parent.kind), ref \(ref(agentId))"
                    under.append(agentId)
                } else {
                    chunk += "\n\(indent)- \(parent.title) — \(parent.kind)"
                }
            }
            let line = "- \(entry.title) — \(entry.kind.rawValue), ref \(ref(entry.agentId))"
            chunk += "\n\(String(repeating: "  ", count: entry.parents.count))\(line)"
            if taken == 0, text.utf8.count + chunk.utf8.count > bytes {
                flat = true
                // What it sits under too deep for the lines: on one of its
                // own, cut to fit, the entry under it unindented.
                let room = max(0, bytes - text.utf8.count - line.utf8.count - 16)
                let trail = Self.truncated(entry.parents.map(\.title).joined(separator: " > "), bytes: room)
                chunk = "\n(under \(trail))\n\(line)"
                under = []
            }
            guard text.utf8.count + chunk.utf8.count <= bytes else { break }
            text += chunk
            // Lines after a flat one show what they sit under again.
            path = flat ? [] : keys + [entry.agentId]
            shown += under + [entry.agentId]
            taken += 1
        }
        return (text, shown, taken)
    }

    /// How updates name a conversation: its title and the titles of what
    /// it sits under, outermost first. Its reference too when those leave
    /// it unclear (another one is named the same under the same, or it has
    /// no name of its own yet, "New Task"), or the agent has none for it.
    private func address(_ target: CallTarget) -> [String: Any] {
        let parents = target.parents.map(\.title)
        var value: [String: Any] = ["title": target.title, "parents": parents]
        let twins = entries.filter { $0.title == target.title && $0.parents.map(\.title) == parents }.count
        if twins > 1 || CallTarget.placeholders.contains(target.title) || !told.contains(target.agentId) {
            value["ref"] = ref(target.agentId)
            told.insert(target.agentId)
        }
        return value
    }

    // MARK: Tools

    /// Runs one tool call after the ones before it. The same call ID again
    /// (the provider retrying) gets the first answer, never a second run.
    public func handle(_ call: CallToolCall) async -> CallToolResult {
        if let existing = results[call.id] { return await existing.value }
        guard !closed else { return .refused("The call has ended.") }
        let previous = tail
        let task = Task { [weak self] () -> CallToolResult in
            await previous?.value
            guard let self else { return .refused("The call has ended.") }
            return await self.run(call)
        }
        results[call.id] = task
        tail = Task { _ = await task.value }
        return await task.value
    }

    private func run(_ call: CallToolCall) async -> CallToolResult {
        guard !closed else { return .refused("The call has ended.") }
        guard let tool = CallTool(rawValue: call.name) else { return .refused("Unknown tool.") }
        let parameters = call.parameters
        let timeout: CallToolResult = tool == .message
            ? .json(["status": "uncertain", "reason": "No answer in time. Don't send it again; say it may not have gone."], isError: true)
            : .refused("No answer in time.")
        let (result, answered) = await Self.timed(toolDeadline, otherwise: timeout) {
            await self.execute(tool, parameters, call: call.id)
        }
        // A send the agent heard the answer to is settled; one it didn't
        // keeps its ID for the same words again.
        if let key = settling.removeValue(forKey: call.id), answered { unsettled[key] = nil }
        return result
    }

    private func execute(_ tool: CallTool, _ parameters: Data, call: String) async -> CallToolResult {
        guard let arguments = (try? JSONSerialization.jsonObject(with: parameters.isEmpty ? Data("{}".utf8) : parameters)) as? [String: Any] else {
            return .refused("The arguments aren't a JSON object.")
        }
        switch tool {
        case .listConversations:
            guard let query = Self.optionalString(arguments["query"]) else { return .refused("query must be a string.") }
            guard let cursor = Self.optionalString(arguments["cursor"]) else { return .refused("cursor must be a string.") }
            let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard let start = cursor.isEmpty ? 0 : Int(cursor), start >= 0 else { return .refused("That isn't a cursor listConversations gave.") }
            see(await targets.directory())
            let matching = needle.isEmpty ? entries : entries.filter { $0.title.lowercased().contains(needle) }
            let page = matching.dropFirst(start).prefix(Limits.page)
            // A directory query: what it gives, the agent has.
            told.formUnion(page.map(\.agentId))
            var value: [String: Any] = ["conversations": page.map { row($0) }, "now": Self.local(now(), in: timeZone)]
            if start + page.count < matching.count { value["nextCursor"] = String(start + page.count) }
            return .json(value)

        case .readConversation:
            if let unmade = Self.unmade(arguments["ref"]) { return unmade }
            guard let id = await resolve(arguments["ref"]) else { return .refused("No such conversation.") }
            let asked = CallRead.request(arguments)
            guard let request = asked.request else { return .refused(asked.refusal ?? "") }
            // One on its way already: its cue answers this read too.
            if var pending = reading[id] {
                if !pending.requests.contains(request) { pending.requests.append(request) }
                reading[id] = pending
                return checking(id)
            }
            // Made current first, as opening it would; what doesn't come in
            // time is told when it does, and the voice goes on meanwhile.
            let targets = targets, limit = refreshLimit
            let refresh = Task { await targets.refreshed(id, within: limit) }
            if let state = await Self.within(readGrace, refresh) {
                guard let state else { return .refused("That conversation can't be read now.") }
                let value = read(state, request)
                return .json(value, isError: value["ok"] as? Bool == false)
            }
            guard !closed else { refresh.cancel(); return .refused("The call has ended.") }
            reading[id] = (refresh, [request])
            Task { [weak self] in
                let state = await refresh.value
                await self?.tell(id, state)
            }
            onReading?(.checking)
            return checking(id)

        case .message:
            return await message(arguments, call: call)

        case .navigate:
            guard let url = arguments["to"] as? String, let destination = Self.destination(url) else {
                let named = (arguments["to"] as? String).map { "\"\($0)\"" } ?? "That"
                let reason = "\(named) isn't a destination. to is one of: \(Self.destinations.joined(separator: ", "))."
                return .json(["ok": false, "reason": reason, "destinations": Self.destinations], isError: true)
            }
            // Home is home from wherever the screen is; the others are moves
            // from the screen the agent last saw, refused once it changed.
            switch destination {
            case .restart:
                guard let restart, !closed else { return .refused("The call can't restart now.") }
                return await restart()
            case .conversation(let wanted):
                if let unmade = Self.unmade(wanted) { return unmade }
                guard let id = await resolve(wanted) else { return .refused("No such conversation.") }
                guard Self.revision(arguments["focusRevision"]) == focusRevision else { return Self.stale }
                // Past its deadline the answer is gone: nothing moves on screen after it.
                guard !Task.isCancelled, !closed else { return .refused("No answer in time.") }
                guard await targets.open(id) else { return .refused("It didn't open.") }
                // In front now as far as the call goes, with the revision the
                // next step takes. The screen says so too; whichever of the two
                // comes second says nothing.
                _ = moveFocus(to: id)
                return .json(["opened": true, "ref": ref(id), "focusRevision": focusRevision])
            case .back, .home:
                if destination == .back, Self.revision(arguments["focusRevision"]) != focusRevision { return Self.stale }
                guard !Task.isCancelled, !closed else { return .refused("No answer in time.") }
                switch destination == .back ? await targets.back() : await targets.home() {
                case .refused(let reason):
                    return .refused(reason)
                case .moved(let atHome):
                    // Where it landed is the focus now; the screen says so too, and
                    // whichever of the two comes second says nothing.
                    let landed = await shown()
                    _ = moveFocus(to: landed)
                    var value: [String: Any] = ["home": atHome, "focusRevision": focusRevision, "title": NSNull()]
                    if let landed, let entry = directory[landed] ?? drafts[landed] {
                        value.merge(address(entry)) { _, new in new }
                        value["ref"] = ref(landed)
                        told.insert(landed)
                    }
                    return .json(value)
                }
            }
        }
    }

    /// A read as `readConversation` gives it, `adding` what goes with it
    /// (a cue's event and ref): its name, state and the turns `request`
    /// asks for (`CallRead`), each message cut in the middle past its
    /// words, within `Limits.readBytes` on the wire: the older turns give
    /// way first, then the newest's words. One that isn't current says so
    /// (`stale`), with when this phone last read it from the computer
    /// (`checked`). A reference that fits no turn, or several, is refused
    /// (`ok` false).
    private func read(_ state: CallTargetState, _ request: CallRead.Request = .init(), adding extra: [String: Any] = [:]) -> [String: Any] {
        // Asked for by its reference, it is named by its title alone.
        var name: [String: Any] = ["title": state.target.title, "parents": state.target.parents.map(\.title)]
        name.merge(extra) { _, new in new }
        let items = CallRead.items(state)
        let references = CallRead.references(items.map(\.id))
        let range: ClosedRange<Int>?
        switch CallRead.range(request, in: items, references: references, older: state.hasMore) {
        case .success(let found): range = found
        case .failure(let refusal): return extra.merging(["ok": false, "reason": refusal.reason]) { _, new in new }
        }
        if !state.fresh {
            name["stale"] = true
            if let at = state.checkedAt, at > 0 { name["checked"] = when(at) }
        }
        var shown: Range<Int> = range.map { $0.lowerBound..<($0.upperBound + 1) } ?? 0..<0
        var words = request.words
        var value = body(state, items: items, references: references, shown: shown, words: words, as: name)
        while Self.escapedSize(Self.data(value)) > Limits.readBytes {
            if shown.count > 1 { shown = shown.dropFirst() }
            else if words > CallRead.minWords { words = max(CallRead.minWords, words / 2) }
            else { break }
            value = body(state, items: items, references: references, shown: shown, words: words, as: name)
        }
        return value
    }

    /// `readConversation`'s answer while the read goes on.
    private func checking(_ id: String) -> CallToolResult {
        var value: [String: Any] = ["status": "checking", "ref": ref(id), "note": Self.checkingNote]
        if let title = directory[id]?.title ?? drafts[id]?.title { value["title"] = title }
        return .json(value)
    }

    static let checkingNote = "Fetching the latest from the computer. Say you're checking; the read comes as an [app] conversation_read."

    /// A read that answered `checking`, in: told as a cue, stale if it
    /// didn't come current in time; nothing once the call has ended.
    private func tell(_ id: String, _ state: CallTargetState?) {
        let requests = reading.removeValue(forKey: id)?.requests ?? []
        guard !closed else { return }
        let event: [String: Any] = ["event": "conversation_read", "ref": ref(id)]
        for request in requests {
            let value: [String: Any]
            if let state {
                value = read(state, request, adding: event)
            } else {
                value = event.merging(["ok": false, "reason": "That conversation can't be read now."]) { _, new in new }
            }
            onReading?(.read(.conversationRead(Self.string(value))))
        }
    }

    /// `task`'s value if it comes within `limit`, else nil, leaving it to go on.
    static func within<T: Sendable>(_ limit: Duration, _ task: Task<T, Never>) async -> T? {
        let first = First<T?>()
        return await withCheckedContinuation { continuation in
            Task { first.resume(continuation, with: await task.value) }
            Task {
                try? await Task.sleep(for: limit)
                first.resume(continuation, with: nil)
            }
        }
    }

    private final class First<T: Sendable>: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false

        func resume(_ continuation: CheckedContinuation<T, Never>, with value: T) {
            lock.lock()
            let first = !done
            done = true
            lock.unlock()
            if first { continuation.resume(returning: value) }
        }
    }

    /// The conversation on screen as the app has it now, known to the
    /// call: a draft compose made since is one of its drafts.
    private func shown() async -> String? {
        let shown = await targets.focused()
        if let shown, directory[shown] == nil, drafts[shown] == nil {
            see(await targets.directory())
            if directory[shown] == nil, let draft = await targets.unlisted(shown) { drafts[shown] = draft }
        }
        return shown
    }

    /// `message`: `text` to the conversation `to` names, to new work for
    /// `new-task` or `new-bot`, or, with no `to`, to the conversation on
    /// screen as it runs; refused when none is.
    private func message(_ arguments: [String: Any], call: String) async -> CallToolResult {
        guard let to = Self.optionalString(arguments["to"]) else { return .refused("to must be a string.") }
        let target = to.trimmingCharacters(in: .whitespacesAndNewlines)
        let fresh = Self.newWork(target)
        var resolved: String?
        if fresh == nil {
            if target.isEmpty {
                guard let id = await shown(), directory[id] != nil || drafts[id] != nil else {
                    return .refused("No conversation is on screen. Ask which one, then send with its ref as to.")
                }
                resolved = id
            } else {
                guard let id = await resolve(target) else { return .refused("No such conversation.") }
                resolved = id
            }
        }
        guard let text = arguments["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .refused("There's nothing to send.")
        }
        guard text.utf8.count <= Limits.textBytes else { return .refused("That message is too long to send by voice.") }
        guard let model = Self.optionalString(arguments["model"]) else { return .refused("model must be a string.") }
        guard let effort = Self.optionalString(arguments["effort"]) else { return .refused("effort must be a string.") }
        if let fresh { return await start(fresh.kind, name: fresh.name, text: text, model: model, effort: effort, call: call) }
        guard let id = resolved else { return .refused("No such conversation.") }
        guard let state = await targets.state(of: id) else { return .refused("That conversation can't be read now.") }
        guard state.writable else { return .refused("That conversation can't take a message now.") }
        // A working agent takes it as the composer's send would (it steers or
        // waits its turn); only a question waiting for the person stops it.
        guard !state.needsInput else { return .refused("It's waiting for the person in the app; answer there first.") }
        let asked = Self.change(model: model, effort: effort, state: state)
        if let refusal = asked.refusal { return refusal }
        // Reading it was a wait: the call may have ended, or the answer's
        // time run out. Nothing goes after that.
        guard !closed else { return .refused("The call has ended.") }
        guard !Task.isCancelled else { return .refused("No answer in time.") }
        let key = "\(id)\u{0}\(text)"
        let messageId = unsettled[key] ?? ClientID.make()
        unsettled[key] = messageId
        settling[call] = key
        switch await targets.send(id, text: text, id: messageId, change: asked.change) {
        case .queued:
            // Heard from from now on, as a visited one is: its reply comes as it is written.
            visit(id)
            var value: [String: Any] = ["status": "queued", "ref": ref(id), "delivery": Self.queued]
            // Sent to what was on screen: named, so the agent can say where it went.
            if target.isEmpty { value["title"] = state.target.title }
            told.insert(id)
            if let switched = asked.switched {
                value["model"] = switched.model
                if !switched.effort.isEmpty { value["effort"] = switched.effort }
            }
            return .json(value)
        case .refused(let reason):
            return .refused(reason)
        }
    }

    /// `message` to `new-task` or `new-bot`: new work made as compose's
    /// send makes it, `text` its first message, on the model and effort
    /// asked for, else compose's own default. Nothing exists of it until
    /// then, and nothing stays of it when it is refused. The same words
    /// again, their answer unheard, reach the same new work under the same
    /// message ID, never a second one.
    private func start(_ kind: CallTarget.Kind, name: String, text: String, model: String, effort: String, call: String) async -> CallToolResult {
        let key = "\(kind.rawValue):\(name)\u{0}\(text)"
        let messageId = unsettled[key] ?? ClientID.make()
        let earlier = startedBy[messageId].flatMap { drafts[$0] ?? directory[$0] }
        var made = earlier
        if made == nil { made = await targets.draft(kind, name: name) }
        guard let work = made else { return .refused("New work couldn't be started.") }
        func refused(_ result: CallToolResult) async -> CallToolResult {
            if earlier == nil { await targets.discard(work.agentId) }
            return result
        }
        guard let state = await targets.state(of: work.agentId), state.writable else { return await refused(.refused("New work can't be started now.")) }
        let asked = Self.change(model: model, effort: effort, state: state)
        if let refusal = asked.refusal { return await refused(refusal) }
        guard !closed else { return await refused(.refused("The call has ended.")) }
        guard !Task.isCancelled else { return await refused(.refused("No answer in time.")) }
        unsettled[key] = messageId
        settling[call] = key
        if directory[work.agentId] == nil { drafts[work.agentId] = work }
        // Its first message is on its way under this ID: the same words again reach it, answered or not.
        startedBy[messageId] = work.agentId
        switch await targets.send(work.agentId, text: text, id: messageId, change: asked.change) {
        case .queued:
            told.insert(work.agentId)
            var value: [String: Any] = [
                "status": "queued", "ref": ref(work.agentId), "started": kind.rawValue, "title": work.title, "delivery": Self.queued,
            ]
            if let named = asked.switched ?? state.mode.map({ ($0.model, $0.effort) }) {
                value["model"] = named.0
                if !named.1.isEmpty { value["effort"] = named.1 }
            }
            return .json(value)
        case .refused(let reason):
            if earlier == nil {
                drafts[work.agentId] = nil
                startedBy[messageId] = nil
            }
            return await refused(.refused(reason))
        }
    }

    /// Where `navigate` goes.
    enum Destination: Equatable {
        case home, back, restart
        case conversation(String)
    }

    /// One of the first context's destinations, any case in the scheme and
    /// the place, a trailing slash allowed; nil for anything else.
    static func destination(_ url: String) -> Destination? {
        var text = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasSuffix("/") { text.removeLast() }
        let lower = text.lowercased()
        if lower == homeURL { return .home }
        if lower == backURL { return .back }
        if lower == restartURL { return .restart }
        guard lower.hasPrefix(conversationURL) else { return nil }
        let ref = String(text.dropFirst(conversationURL.count))
        return ref.isEmpty || ref.contains("/") ? nil : .conversation(ref)
    }

    /// `new-task` or `new-bot`, any case, with the name after a colon if
    /// one is given; nil for any other reference.
    static func newWork(_ ref: String) -> (kind: CallTarget.Kind, name: String)? {
        let lower = ref.lowercased()
        for (prefix, kind) in [(newTaskRef, CallTarget.Kind.task), (newBotRef, .bot)] {
            if lower == prefix { return (kind, "") }
            if lower.hasPrefix(prefix + ":") { return (kind, CallTarget.clean(String(ref.dropFirst(prefix.count + 1)))) }
        }
        return nil
    }

    /// A refusal for new work named where only `message` takes it.
    private static func unmade(_ value: Any?) -> CallToolResult? {
        guard let ref = value as? String, newWork(ref) != nil else { return nil }
        return .refused("Nothing exists of new work until its first message: start it with message to \(newTaskRef) or \(newBotRef).")
    }

    /// The model and effort a send asks for, as the conversation's
    /// computer offers them (`CallTargetState.models`): what to switch to,
    /// and how it is named, or a refusal that lists what it takes.
    /// Blank asks for no change.
    static func change(model: String, effort: String, state: CallTargetState) -> AskedMode {
        let model = model.trimmingCharacters(in: .whitespacesAndNewlines)
        let effort = effort.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !model.isEmpty || !effort.isEmpty else { return AskedMode() }
        func refused(_ reason: String, _ listed: [CallModel]) -> AskedMode {
            var value: [String: Any] = ["ok": false, "reason": reason + " Nothing was sent."]
            if !listed.isEmpty { value["models"] = Self.models(listed) }
            return AskedMode(refusal: .json(value, isError: true))
        }
        guard !state.models.isEmpty else {
            return refused("This computer's models can't be read now, so the model and effort can't change.", [])
        }
        let current = state.mode.flatMap { mode in state.models.first { $0.id == mode.modelId } }
        var chosen = current
        if !model.isEmpty {
            let key = Self.spoken(model)
            let exact = state.models.filter { Self.spoken($0.id) == key || Self.spoken($0.name) == key }
            let matching = exact.isEmpty ? state.models.filter { Self.spoken($0.id).contains(key) || Self.spoken($0.name).contains(key) } : exact
            guard matching.count == 1 else {
                let reason = matching.isEmpty
                    ? "There is no model called \"\(model)\". It takes one of: \(state.models.map(\.name).joined(separator: ", "))."
                    : "\"\(model)\" could be \(matching.map(\.name).joined(separator: " or ")); ask which."
                return refused(reason, matching.isEmpty ? state.models : matching)
            }
            chosen = matching[0]
        }
        guard let chosen else {
            return refused("It runs on a model this computer doesn't list now; name the model as well.", state.models)
        }
        var level: String?
        if !effort.isEmpty {
            guard !chosen.efforts.isEmpty else { return refused("\(chosen.name) takes no effort level.", [chosen]) }
            guard let match = chosen.efforts.first(where: { Self.spoken($0) == Self.spoken(effort) }) else {
                return refused("\(chosen.name) takes effort \(chosen.efforts.joined(separator: ", ")), not \"\(effort)\".", [chosen])
            }
            level = match
        }
        let changesModel = chosen.id != state.mode?.modelId
        // As the picker does: a model's own default effort unless one was asked for.
        let named = level ?? (changesModel ? chosen.defaultEffort : state.mode?.effort ?? chosen.defaultEffort)
        return AskedMode(change: CallModeChange(modelId: model.isEmpty ? nil : chosen.id, effort: level), switched: (chosen.name, named))
    }

    /// What `change` made of a send's model and effort.
    struct AskedMode {
        var change: CallModeChange?
        /// The model and effort it goes with, as named to the agent.
        var switched: (model: String, effort: String)?
        var refusal: CallToolResult?
    }

    /// A name as said aloud: letters and digits only, any case.
    private static func spoken(_ text: String) -> String {
        String(text.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.map(Character.init))
    }

    static func models(_ list: [CallModel]) -> [[String: Any]] {
        list.prefix(Limits.models).map { ["id": $0.id, "name": $0.name, "efforts": $0.efforts] }
    }

    // MARK: References and bodies

    /// The conversation's reference: `s` and its order key. One the sidebar
    /// doesn't list (new work on its way) gets the key after every other.
    private func ref(_ agentId: String) -> String {
        if let existing = refs[agentId] { return existing }
        return assign(OrderKey.between(keys.last, nil) ?? "5", to: agentId)
    }

    @discardableResult
    private func assign(_ key: String, to agentId: String) -> String {
        let made = "s" + key
        refs[agentId] = made
        agents[made] = agentId
        keys.insert(key, at: keys.firstIndex { $0 > key } ?? keys.endIndex)
        return made
    }

    /// References for what `list` holds that has none yet. The first time,
    /// as few digits as the list allows, in its order (`spread`); after,
    /// each new one gets a key above the one before it in the list and just
    /// below the next key handed out (`OrderKey.justBefore`, as happy-agent
    /// places new work after a fixed row), so arrivals in one place stay
    /// short (`49`, `48`, …), no key changes, none is handed out twice, one
    /// that went away keeps its own for when it comes back, and sorted as
    /// text they give the list's order.
    private func place(_ list: [CallTarget]) {
        if keys.isEmpty {
            for (entry, key) in zip(list, Self.spread(list.count)) { assign(key, to: entry.agentId) }
            return
        }
        var previous: String?
        for entry in list {
            if let existing = refs[entry.agentId] {
                previous = String(existing.dropFirst())
                continue
            }
            let next = keys.first { key in previous.map { key > $0 } ?? true }
            guard let key = next.map({ OrderKey.justBefore(previous, $0) }) ?? OrderKey.between(previous, nil) else { continue }
            assign(key, to: entry.agentId)
            previous = key
        }
    }

    /// `count` order keys in order, as short as `count` allows: `1` to `9`
    /// for up to nine; else the fewest digits that hold them, counted up
    /// from `11` (or `101`, …), skipping any that ends in 0, as no key does.
    /// A conversation that comes between two of them later adds a digit:
    /// `49` between `4` and `5`.
    static func spread(_ count: Int) -> [String] {
        // 9 of one digit, 81 of two, 810 of three, …
        var capacity = 9
        var number = 1
        while capacity < count {
            capacity = number == 1 ? 81 : capacity * 10
            number *= 10
        }
        if number > 1 { number += 1 }
        var keys: [String] = []
        while keys.count < count {
            if number % 10 != 0 { keys.append(String(number)) }
            number += 1
        }
        return keys
    }

    /// The conversation a reference names, while the sidebar lists it:
    /// one that went away isn't reached, and is again if it comes back,
    /// under the same reference.
    private func resolve(_ value: Any?) async -> String? {
        guard let ref = value as? String, let id = agents[ref] else { return nil }
        see(await targets.directory())
        return directory[id] == nil && drafts[id] == nil ? nil : id
    }

    /// `agentId` becomes the latest visited or messaged; the oldest past
    /// the limit is forgotten, so following it again starts from what is
    /// there then. The one on screen never drops out while it is in front.
    private func visit(_ agentId: String) {
        visited.removeAll { $0 == agentId }
        visited.insert(agentId, at: 0)
        while visited.count > Limits.visited, let oldest = visited.lastIndex(where: { $0 != focus }) {
            heard[visited.remove(at: oldest)] = nil
        }
    }

    /// What is there when the call first sees a conversation is had: the
    /// agent's complete messages and the errors so far. One still being
    /// written is new, and goes once it is complete.
    private func listen(_ state: CallTargetState) {
        var known = Heard()
        for message in state.messages where message.role == .assistant && message.final {
            known.had.insert(message.id)
        }
        known.errors = Set(state.turns.filter { $0.ended == "error" }.map(\.id))
        heard[state.target.agentId] = known
    }

    /// One of `listConversations`' answers.
    private func row(_ target: CallTarget) -> [String: Any] {
        var value: [String: Any] = ["ref": ref(target.agentId), "title": target.title, "kind": target.kind.rawValue, "status": target.status.rawValue]
        if !target.parents.isEmpty { value["parents"] = target.parents.map(\.title) }
        if !target.workspace.isEmpty { value["workspace"] = target.workspace.joined(separator: " / ") }
        if let at = target.activityAt, at > 0 { value["lastActivity"] = when(at) }
        return value
    }

    /// The last finished turns the first context shows: five with the
    /// person's message still waiting for an answer, which is the fifth.
    static func recent(_ state: CallTargetState) -> [CallTurn] {
        Array(answering(state).suffix(state.unanswered == nil ? Limits.turns : Limits.turns - 1))
    }

    /// Finished turns with something to say: the person's message, the
    /// agent's last words, an error, or as much of that as there is. Never
    /// the agent's words between its steps.
    private static func answering(_ state: CallTargetState) -> [CallTurn] {
        state.turns.filter { $0.user?.isEmpty == false || $0.reply?.isEmpty == false || $0.ended == "error" }
    }

    /// A conversation as read: `name`, then whether it works or waits for
    /// the person, and the turns `shown` of `items`, each with its
    /// reference, oldest first, the one waiting for an answer apart; where
    /// to read on back from (`continueFrom`) when older ones are here.
    /// Never its kind, status or reference beyond what `name` holds: the
    /// directory has those.
    private func body(_ state: CallTargetState, items: [CallRead.Item], references: [String], shown: Range<Int>, words: Int,
                      as name: [String: Any]) -> [String: Any] {
        var value = name
        value["working"] = state.working
        value["needsInput"] = state.needsInput
        if let last = state.messages.last(where: { $0.role == .user && ($0.time ?? 0) > 0 }), let at = last.time {
            var said = when(at)
            if let by = last.by { said["by"] = by }
            value["lastUserMessage"] = said
        }
        if let at = state.turns.filter({ $0.reply?.isEmpty == false }).compactMap(\.endedAt).filter({ $0 > 0 }).max() { value["lastAgentReply"] = when(at) }
        if !state.target.workspace.isEmpty { value["workspace"] = state.target.workspace.joined(separator: " / ") }
        if let mode = state.mode { value["model"] = ["id": mode.modelId, "name": mode.model, "effort": mode.effort] }
        if !state.models.isEmpty { value["models"] = Self.models(state.models) }
        var turns: [[String: Any]] = []
        for index in shown {
            if let turn = items[index].turn { turns.append(Self.turn(turn, ref: references[index], words: words)) }
            if let pending = items[index].pending {
                var message: [String: Any] = ["ref": references[index]]
                var cuts: [String: Any] = [:]
                message["text"] = Self.cut(pending.text, words: words, as: "text", into: &cuts)
                if let cut = cuts["text"] { message["cut"] = cut }
                if let delivery = pending.delivery { message["delivery"] = delivery.rawValue }
                if let by = pending.by { message["by"] = by }
                value["pendingUserMessage"] = message
            }
        }
        value["turns"] = turns
        value["olderTurns"] = shown.lowerBound > 0 || state.hasMore
        if shown.lowerBound > 0 { value["continueFrom"] = references[shown.lowerBound - 1] }
        return value
    }

    /// One turn as a read gives it: its reference, the person's message and
    /// the agent's last words, each cut in the middle past `words` with
    /// its whole size in `cut`, and how it ended.
    static func turn(_ turn: CallTurn, ref: String, words: Int) -> [String: Any] {
        var value: [String: Any] = ["ref": ref, "ended": turn.ended]
        var cuts: [String: Any] = [:]
        if let user = turn.user, !user.isEmpty {
            value["user"] = cut(user, words: words, as: "user", into: &cuts)
            if let by = turn.userBy { value["userBy"] = by }
        }
        if let reply = turn.reply, !reply.isEmpty { value["assistant"] = cut(reply, words: words, as: "assistant", into: &cuts) }
        if turn.ended == "error", let reason = turn.error, !reason.isEmpty { value["error"] = truncated(reason, bytes: Limits.errorBytes) }
        if !cuts.isEmpty { value["cut"] = cuts }
        return value
    }

    /// `text` within `words` (`CallRead.cut`), its whole size and what was
    /// left out put in `cuts` under `key` when it was cut.
    private static func cut(_ text: String, words: Int, as key: String, into cuts: inout [String: Any]) -> String {
        guard let cut = CallRead.cut(text, words: words) else { return text }
        cuts[key] = ["words": cut.words, "leftOut": cut.leftOut]
        return cut.text
    }

    /// `text` within `bytes` of UTF-8, cut after a whole word and saying
    /// how many were left out: "… (cut, 120 more words)". A text with no
    /// space to cut at is cut between characters.
    static func clipped(_ text: String, bytes: Int) -> String {
        guard text.utf8.count > bytes else { return text }
        // Room for the note, whatever its count.
        var kept = truncated(text, bytes: max(0, bytes - 32))
        let next = text.dropFirst(kept.count).first
        if let next, !isSpace(next), let space = kept.lastIndex(where: isSpace) { kept = String(kept[..<space]) }
        while let last = kept.last, isSpace(last) { kept.removeLast() }
        let left = text.dropFirst(kept.count).split(whereSeparator: isSpace).count
        return kept + " … (cut, \(left) more \(left == 1 ? "word" : "words"))"
    }

    /// What `json` weighs sent on as a string inside a call SDK's own JSON,
    /// at most: a quote, backslash or slash escaped in two bytes, a control
    /// character or one Gson escapes as HTML (`<`, `>`, `&`, `=`, `'`) in
    /// six (`\u003c`). Android's `escapedSize` counts the same.
    static func escapedSize(_ json: Data) -> Int {
        json.reduce(0) { size, byte in
            switch byte {
            case 0x22, 0x5C, 0x2F: size + 2
            case 0x3C, 0x3E, 0x26, 0x3D, 0x27, 0..<0x20: size + 6
            default: size + 1
            }
        }
    }

    /// A space, tab or line break: where `clipped` cuts and counts words.
    private static func isSpace(_ character: Character) -> Bool {
        character.unicodeScalars.allSatisfy { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\r" }
    }

    /// The longest prefix of whole characters within `bytes` of UTF-8,
    /// or of what `size` counts.
    static func truncated(_ text: String, bytes: Int, size: (String) -> Int = { $0.utf8.count }) -> String {
        guard size(text) > bytes else { return text }
        var count = 0
        var end = text.startIndex
        for index in text.indices {
            let next = size(String(text[index]))
            if count + next > bytes { break }
            count += next
            end = text.index(after: index)
        }
        return String(text[..<end])
    }

    private static let stale = CallToolResult.refused("The screen changed since; check the focus again.")
    /// What "queued" is, in the result as well as the tool's description:
    /// told only the status, the agent says "sent".
    static let queued = "on the person's device, not confirmed delivered or read"

    /// A JSON integer, as the schema says: never a string, a fraction or a boolean.
    private static func revision(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, !isBoolean(number) else { return nil }
        let double = number.doubleValue
        guard double.rounded() == double, abs(double) < 1e15 else { return nil }
        return number.intValue
    }

    /// An optional string argument: absent or null is empty, anything but a string is nil.
    private static func optionalString(_ value: Any?) -> String? {
        switch value {
        case nil, is NSNull: ""
        case let text as String: text
        default: nil
        }
    }

    private static func isBoolean(_ number: NSNumber) -> Bool {
        CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    /// A moment as the agent says it: how long ago, and when on the
    /// person's clock, to the minute.
    private func when(_ ms: Double) -> [String: Any] {
        ["ago": Self.ago(now() - ms / 1000), "at": Self.local(ms / 1000, in: timeZone)]
    }

    /// "just now", "5 minutes ago", "2 hours ago", "yesterday", "3 days ago".
    static func ago(_ seconds: Double) -> String {
        let minutes = Int((seconds / 60).rounded(.down))
        switch minutes {
        case ..<1: return "just now"
        case 1: return "a minute ago"
        case ..<60: return "\(minutes) minutes ago"
        case ..<120: return "an hour ago"
        case ..<(24 * 60): return "\(minutes / 60) hours ago"
        case ..<(48 * 60): return "yesterday"
        default: return "\(minutes / (24 * 60)) days ago"
        }
    }

    /// ISO 8601 in `zone`, with its offset, to the minute: 2026-11-06T09:15:00+01:00.
    static func local(_ seconds: Double, in zone: TimeZone) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = zone
        formatter.formatOptions = [.withFullDate, .withTime, .withColonSeparatorInTime, .withDashSeparatorInDate, .withTimeZone, .withColonSeparatorInTimeZone]
        return formatter.string(from: Date(timeIntervalSince1970: (seconds / 60).rounded(.down) * 60))
    }

    static func data(_ value: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
    }

    static func string(_ value: [String: Any]) -> String {
        String(decoding: data(value), as: UTF8.self)
    }

    /// `body`'s answer, or `otherwise` once `limit` has passed; `body` is
    /// cancelled then, and whatever it still does is not waited for.
    static func deadline(_ limit: Duration, otherwise: CallToolResult,
                         _ body: @escaping @Sendable () async -> CallToolResult) async -> CallToolResult {
        await timed(limit, otherwise: otherwise, body).0
    }

    /// `deadline`, and whether the answer was `body`'s own.
    static func timed(_ limit: Duration, otherwise: CallToolResult,
                      _ body: @escaping @Sendable () async -> CallToolResult) async -> (CallToolResult, Bool) {
        let once = Once()
        return await withCheckedContinuation { continuation in
            let work = Task {
                let result = await body()
                once.resume(continuation, with: (result, true))
            }
            Task {
                try? await Task.sleep(for: limit)
                if once.resume(continuation, with: (otherwise, false)) { work.cancel() }
            }
        }
    }

    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false

        /// True if this was the first answer.
        @discardableResult
        func resume(_ continuation: CheckedContinuation<(CallToolResult, Bool), Never>, with result: (CallToolResult, Bool)) -> Bool {
            lock.lock()
            let first = !done
            done = true
            lock.unlock()
            if first { continuation.resume(returning: result) }
            return first
        }
    }
}

/// A call's one directory update on its way (`CallContext.directoryUpdate`):
/// due `delay` after the first change it tells, whatever comes after, so a
/// burst goes as one; a change after it has gone starts the next.
/// Cancelled with its call.
@MainActor
public final class DirectorySettle {
    private let delay: Duration
    private let flush: @MainActor () async -> Void
    private var waiting: Task<Void, Never>?

    public init(delay: Duration = CallContext.Limits.settle, flush: @escaping @MainActor () async -> Void) {
        self.delay = delay
        self.flush = flush
    }

    /// The directory changed: the flush in `delay`, or the one already due.
    public func changed() {
        guard waiting == nil else { return }
        let delay = delay
        waiting = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self else { return }
            self.waiting = nil
            await self.flush()
        }
    }

    public func cancel() {
        waiting?.cancel()
        waiting = nil
    }
}
