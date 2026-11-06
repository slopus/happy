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

/// Lives only during one call, bound to one account. It owns the opaque
/// references the hosted agent knows conversations by, the focus, and the
/// last four conversations the person visited during the call, which are
/// the ones it hears from; it runs the tools one at a time. A visited
/// conversation says only what its agent writes from then on, each piece
/// once it is complete and whole, and an error that stopped it: never its
/// words as they stream, its tools, its state or the person's messages.
///
/// The call starts with the directory: the sidebar's bots, tasks, subtasks
/// and project conversations, in its order and nesting, as plain lines
/// that give each its reference, in the first context only. It never goes
/// again: `listSessions` finds what came or changed since. Updates name a
/// conversation by its title and what it sits under, and by its reference
/// too when that alone leaves it unclear or the agent hasn't had it yet.
public actor CallContext {
    public enum Limits {
        public static let totalBytes = 32 * 1024
        /// Turns a read shows, the person's message still waiting for an answer
        /// counted as one: each the person's message and the agent's last
        /// words, or as much of the pair as there is.
        public static let turns = 5
        public static let messageBytes = 4 * 1024
        public static let errorBytes = 1024
        /// Conversations the first context lists, and its directory's size.
        public static let directory = 100
        public static let directoryBytes = 12 * 1024
        public static let page = 50
        /// Conversations the call hears from: the last ones visited, the one on screen included.
        public static let visited = 4
        /// The agent's messages looked at per change, newest last.
        public static let messages = 20
        public static let textBytes = 8 * 1024
        public static let toolDeadline: Duration = .seconds(8)
        /// Models a read or a refusal lists.
        public static let models = 30
    }

    /// The references `sendMessage` starts new work with, as the first
    /// context lists them; a name after a colon names it.
    public static let newTaskRef = "new-task"
    public static let newBotRef = "new-bot"

    private let targets: any CallTargets
    private let now: @Sendable () -> Double
    private let timeZone: TimeZone
    private let toolDeadline: Duration
    private var refs: [String: String] = [:]
    private var agents: [String: String] = [:]
    private var nextRef = 1
    private var focus: String?
    private var focusRevision = 0
    /// Newest first.
    private var visited: [String] = []
    /// The sidebar's conversations as last seen, in order and by ID.
    private var entries: [CallTarget] = []
    private var directory: [String: CallTarget] = [:]
    /// Work the sidebar doesn't list until its first message makes it:
    /// what `sendMessage` started, or compose's in front.
    private var drafts: [String: CallTarget] = [:]
    /// The conversations whose reference the agent has: from the first
    /// context, `listSessions`, a tool's answer or an update.
    private var told: Set<String> = []
    /// New work `sendMessage` started, by the ID its first message went
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

    public init(targets: any CallTargets, now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 },
                timeZone: TimeZone = .current, toolDeadline: Duration = Limits.toolDeadline) {
        self.targets = targets
        self.now = now
        self.timeZone = timeZone
        self.toolDeadline = toolDeadline
    }

    /// The conversations the call hears from now, the latest visited first.
    public var followed: [String] { visited }

    public func close() {
        closed = true
        for task in results.values { task.cancel() }
    }

    // MARK: The first context

    /// `initialConversationContext`, the hosted prompt's one variable, as
    /// plain text: the time and focusRevision, the conversation on screen
    /// with its last five turns, the directory, and how new work starts.
    /// Within `Limits.totalBytes`: the older turns give way first, then the
    /// directory's tail.
    public func initial() async -> String {
        see(await targets.directory())
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
        var turns = focused.map(Self.recent) ?? []
        var budget = Limits.directoryBytes
        func text(telling: Bool = false) -> String {
            [header, screen(focused, turns: turns), directoryText(bytes: budget, telling: telling), Self.newWorkText].joined(separator: "\n\n")
        }
        while text().utf8.count > Limits.totalBytes, !turns.isEmpty { turns.removeFirst() }
        while text().utf8.count > Limits.totalBytes, budget > 512 { budget /= 2 }
        if let focus { told.insert(focus) }
        return text(telling: true)
    }

    /// How the first context starts new work, as `sendMessage` takes it.
    static let newWorkText = """
    New work (only through sendMessage; listed nowhere until its first message makes it):
    - \(newTaskRef) — a new task, the message its first
    - \(newBotRef) — a new bot, the message its first
    A name after a colon names it: \(newBotRef):Release helper.
    """

    /// The conversation on screen as the first context tells it: what
    /// `getSessionContext` reads of it, as lines.
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
        if turns.isEmpty {
            lines.append("No turns yet.")
        } else {
            lines.append("Last turns, oldest first:")
            for (index, turn) in turns.enumerated() { lines.append(Self.turnText(turn, number: index + 1)) }
        }
        if state.hasMore || Self.answering(state).count > turns.count { lines.append("Older turns aren't shown.") }
        if let pending = state.unanswered {
            let text = Self.truncated(pending.text, bytes: Limits.messageBytes)
            let delivery: String = switch pending.delivery {
            case .queued?: ", still on this phone"
            case .failed?: ", which failed to send"
            default: ""
            }
            lines.append("Waiting for an answer, from \(pending.by ?? "the person")\(delivery):\n   " + Self.indented(text)
                + (text.utf8.count < pending.text.utf8.count ? " [cut short]" : ""))
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
        func text(_ words: String?, as who: String) {
            guard let words, !words.isEmpty else { return }
            let kept = truncated(words, bytes: Limits.messageBytes)
            lines.append("\(who): " + indented(kept) + (kept.utf8.count < words.utf8.count ? " [cut short]" : ""))
        }
        text(turn.user, as: turn.userBy.map { $0 == "the person" ? "The person" : $0 } ?? "The person")
        text(turn.reply, as: "Agent")
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
            let text = Self.truncated(message.text, bytes: Limits.messageBytes)
            var event = address
            event["event"] = "assistant_text"
            event["text"] = text
            if text.utf8.count < message.text.utf8.count { event["truncated"] = true }
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
    /// right in one go. The focus, marked `resync`, with its reference,
    /// then the errors this call told of and each message it told, as it
    /// told it, the most recent kept first, within half of
    /// `Limits.totalBytes`. What doesn't fit is counted in `omitted`; a
    /// read (`getSessionContext`) has it. The first context is the
    /// prompt's, never lost.
    public func resync() -> CallUpdate {
        guard !closed else { return CallUpdate() }
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
        var bytes = Self.string(focusEvent).utf8.count + 32
        for item in items where bytes + item.utf8.count + 1 <= Limits.totalBytes / 2 {
            kept.append(item)
            bytes += item.utf8.count + 1
        }
        if kept.count < items.count { focusEvent["omitted"] = items.count - kept.count }
        // Oldest first, as they would have come.
        let errorCount = kept.prefix { errors.contains($0) }.count
        return CallUpdate(context: [Self.string(focusEvent)] + kept.prefix(errorCount) + kept.dropFirst(errorCount).reversed())
    }

    // MARK: The directory

    /// The sidebar's conversations, as just read.
    private func see(_ now: [CallTarget]) {
        entries = now
        directory = Dictionary(now.map { ($0.agentId, $0) }, uniquingKeysWith: { first, _ in first })
        // Made by its first message: the sidebar's from now on.
        for id in drafts.keys where directory[id] != nil { drafts[id] = nil }
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
        if omitted > 0 { text += "\n… and \(omitted) more; listSessions finds them by title." }
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
        let timeout: CallToolResult = tool == .sendMessage
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
        case .listSessions:
            guard let query = Self.optionalString(arguments["query"]) else { return .refused("query must be a string.") }
            guard let cursor = Self.optionalString(arguments["cursor"]) else { return .refused("cursor must be a string.") }
            let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard let start = cursor.isEmpty ? 0 : Int(cursor), start >= 0 else { return .refused("That isn't a cursor listSessions gave.") }
            see(await targets.directory())
            let matching = needle.isEmpty ? entries : entries.filter { $0.title.lowercased().contains(needle) }
            let page = matching.dropFirst(start).prefix(Limits.page)
            // A directory query: what it gives, the agent has.
            told.formUnion(page.map(\.agentId))
            var value: [String: Any] = ["sessions": page.map { row($0) }, "now": Self.local(now(), in: timeZone)]
            if start + page.count < matching.count { value["nextCursor"] = String(start + page.count) }
            return .json(value)

        case .getSessionContext:
            if let unmade = Self.unmade(arguments["targetRef"]) { return unmade }
            guard let id = await resolve(arguments["targetRef"]) else { return .refused("No such conversation.") }
            guard let state = await targets.state(of: id) else { return .refused("That conversation can't be read now.") }
            // Within the snapshot's budget too: the oldest turns give way.
            // Asked for by its reference, it is named by its title alone.
            let name: [String: Any] = ["title": state.target.title, "parents": state.target.parents.map(\.title)]
            var turns = Self.recent(state)
            var value = body(state, turns: turns, as: name, options: true)
            while Self.data(value).count > Limits.totalBytes, !turns.isEmpty {
                turns.removeFirst()
                value = body(state, turns: turns, as: name, options: true)
            }
            return .json(value)

        case .openSession:
            if let unmade = Self.unmade(arguments["targetRef"]) { return unmade }
            guard let id = await resolve(arguments["targetRef"]) else { return .refused("No such conversation.") }
            let asOf = Self.revision(arguments["focusRevision"])
            guard asOf == focusRevision else { return Self.stale }
            // Past its deadline the answer is gone: nothing moves on screen after it.
            guard !Task.isCancelled, !closed else { return .refused("No answer in time.") }
            guard await targets.open(id) else { return .refused("It didn't open.") }
            // In front now as far as the call goes, with the revision the
            // next step takes. The screen says so too; whichever of the two
            // comes second says nothing.
            _ = moveFocus(to: id)
            return .json(["opened": true, "targetRef": ref(id), "focusRevision": focusRevision])

        case .sendMessage:
            let fresh = (arguments["targetRef"] as? String).flatMap(Self.newWork)
            var resolved: String?
            if fresh == nil {
                guard let id = await resolve(arguments["targetRef"]) else { return .refused("No such conversation.") }
                resolved = id
            }
            guard let text = arguments["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return .refused("There's nothing to send.")
            }
            guard text.utf8.count <= Limits.textBytes else { return .refused("That message is too long to send by voice.") }
            guard let model = Self.optionalString(arguments["model"]) else { return .refused("model must be a string.") }
            guard let effort = Self.optionalString(arguments["effort"]) else { return .refused("effort must be a string.") }
            let asOf = Self.revision(arguments["focusRevision"])
            guard asOf == focusRevision else { return Self.stale }
            if let fresh { return await start(fresh.kind, name: fresh.name, text: text, model: model, effort: effort, asOf: asOf, call: call) }
            guard let id = resolved else { return .refused("No such conversation.") }
            guard let state = await targets.state(of: id) else { return .refused("That conversation can't be read now.") }
            guard state.writable else { return .refused("That conversation can't take a message now.") }
            // A working agent takes it as the composer's send would (it steers or
            // waits its turn); only a question waiting for the person stops it.
            guard !state.needsInput else { return .refused("It's waiting for the person in the app; answer there first.") }
            let asked = Self.change(model: model, effort: effort, state: state)
            if let refusal = asked.refusal { return refusal }
            // Reading it was a wait: the screen, or the call, may have moved
            // on, or the answer's time run out. Nothing goes after that.
            guard !closed else { return .refused("The call has ended.") }
            guard !Task.isCancelled else { return .refused("No answer in time.") }
            guard asOf == focusRevision else { return Self.stale }
            let key = "\(id)\u{0}\(text)"
            let messageId = unsettled[key] ?? ClientID.make()
            unsettled[key] = messageId
            settling[call] = key
            switch await targets.send(id, text: text, id: messageId, change: asked.change) {
            case .queued:
                var value: [String: Any] = ["status": "queued", "targetRef": ref(id), "delivery": Self.queued]
                if let switched = asked.switched {
                    value["model"] = switched.model
                    if !switched.effort.isEmpty { value["effort"] = switched.effort }
                }
                return .json(value)
            case .refused(let reason):
                return .refused(reason)
            }

        case .newWork:
            // Retired: still on the hosted agent until it is detached there.
            return .refused("newWork is retired. Use sendMessage with targetRef new-task or new-bot.")

        case .goBack, .goHome:
            if tool == .goBack, Self.revision(arguments["focusRevision"]) != focusRevision { return Self.stale }
            guard !Task.isCancelled, !closed else { return .refused("No answer in time.") }
            switch tool == .goBack ? await targets.back() : await targets.home() {
            case .refused(let reason):
                return .refused(reason)
            case .moved(let atHome):
                // Where it landed is the focus now; the screen says so too, and
                // whichever of the two comes second says nothing.
                let shown = await targets.focused()
                if let shown, directory[shown] == nil, drafts[shown] == nil {
                    see(await targets.directory())
                    if directory[shown] == nil, let draft = await targets.unlisted(shown) { drafts[shown] = draft }
                }
                _ = moveFocus(to: shown)
                var value: [String: Any] = ["home": atHome, "focusRevision": focusRevision, "title": NSNull()]
                if let shown, let entry = directory[shown] ?? drafts[shown] {
                    value.merge(address(entry)) { _, new in new }
                    value["targetRef"] = ref(shown)
                    told.insert(shown)
                }
                return .json(value)
            }
        }
    }

    /// `sendMessage` to `new-task` or `new-bot`: new work made as compose's
    /// send makes it, `text` its first message, on the model and effort
    /// asked for, else compose's own default. Nothing exists of it until
    /// then, and nothing stays of it when it is refused. The same words
    /// again, their answer unheard, reach the same new work under the same
    /// message ID, never a second one.
    private func start(_ kind: CallTarget.Kind, name: String, text: String, model: String, effort: String, asOf: Int?, call: String) async -> CallToolResult {
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
        guard asOf == focusRevision else { return await refused(Self.stale) }
        unsettled[key] = messageId
        settling[call] = key
        if directory[work.agentId] == nil { drafts[work.agentId] = work }
        // Its first message is on its way under this ID: the same words again reach it, answered or not.
        startedBy[messageId] = work.agentId
        switch await targets.send(work.agentId, text: text, id: messageId, change: asked.change) {
        case .queued:
            told.insert(work.agentId)
            var value: [String: Any] = [
                "status": "queued", "targetRef": ref(work.agentId), "started": kind.rawValue, "title": work.title, "delivery": Self.queued,
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

    /// A refusal for new work named where only `sendMessage` takes it.
    private static func unmade(_ value: Any?) -> CallToolResult? {
        guard let ref = value as? String, newWork(ref) != nil else { return nil }
        return .refused("Nothing exists of new work until its first message: start it with sendMessage to \(newTaskRef) or \(newBotRef).")
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

    private func ref(_ agentId: String) -> String {
        if let existing = refs[agentId] { return existing }
        let made = "s\(nextRef)"
        nextRef += 1
        refs[agentId] = made
        agents[made] = agentId
        return made
    }

    /// The conversation a reference names, while the sidebar lists it:
    /// one that went away isn't reached, and is again if it comes back,
    /// under the same reference.
    private func resolve(_ value: Any?) async -> String? {
        guard let ref = value as? String, let id = agents[ref] else { return nil }
        see(await targets.directory())
        return directory[id] == nil && drafts[id] == nil ? nil : id
    }

    /// `agentId` becomes the latest visited; the oldest past the limit is
    /// forgotten, so visiting it again starts from what is there then.
    private func visit(_ agentId: String) {
        visited.removeAll { $0 == agentId }
        visited.insert(agentId, at: 0)
        for dropped in visited.dropFirst(Limits.visited) { heard[dropped] = nil }
        visited = Array(visited.prefix(Limits.visited))
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

    /// One of `listSessions`' answers.
    private func row(_ target: CallTarget) -> [String: Any] {
        var value: [String: Any] = ["targetRef": ref(target.agentId), "title": target.title, "kind": target.kind.rawValue, "status": target.status.rawValue]
        if !target.parents.isEmpty { value["parents"] = target.parents.map(\.title) }
        if !target.workspace.isEmpty { value["workspace"] = target.workspace.joined(separator: " / ") }
        if let at = target.activityAt, at > 0 { value["lastActivity"] = when(at) }
        return value
    }

    /// The last finished turns a read shows: five with the person's message
    /// still waiting for an answer, which is the fifth.
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
    /// the person, and its turns. Never its kind, status or reference
    /// beyond what `name` holds: the directory has those.
    private func body(_ state: CallTargetState, turns: [CallTurn], as name: [String: Any], options: Bool) -> [String: Any] {
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
        if options, !state.models.isEmpty { value["models"] = Self.models(state.models) }
        value["turns"] = turns.map(Self.turn)
        value["olderTurns"] = state.hasMore || Self.answering(state).count > turns.count
        if let pending = state.unanswered {
            let text = Self.truncated(pending.text, bytes: Limits.messageBytes)
            var message: [String: Any] = ["text": text]
            if text.utf8.count < pending.text.utf8.count { message["truncated"] = true }
            if let delivery = pending.delivery { message["delivery"] = delivery.rawValue }
            if let by = pending.by { message["by"] = by }
            value["pendingUserMessage"] = message
        }
        return value
    }

    static func turn(_ turn: CallTurn) -> [String: Any] {
        var value: [String: Any] = ["ended": turn.ended]
        var cut = false
        func text(_ words: String?, as key: String) {
            guard let words, !words.isEmpty else { return }
            let kept = truncated(words, bytes: Limits.messageBytes)
            value[key] = kept
            if kept.utf8.count < words.utf8.count { cut = true }
        }
        text(turn.user, as: "user")
        if turn.user?.isEmpty == false, let by = turn.userBy { value["userBy"] = by }
        text(turn.reply, as: "assistant")
        if turn.ended == "error", let reason = turn.error, !reason.isEmpty { value["error"] = truncated(reason, bytes: Limits.errorBytes) }
        if cut { value["truncated"] = true }
        return value
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
