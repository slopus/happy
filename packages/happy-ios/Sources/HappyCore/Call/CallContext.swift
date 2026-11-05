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
/// the ones it hears from; it runs the four tools one at a time. A visited
/// conversation says only what its agent writes from then on, each piece
/// once it is complete and whole, and an error that stopped it: never its
/// words as they stream, its tools, its state or the person's messages.
///
/// The directory is the sidebar's: every bot, task, subtask and project
/// conversation the person sees, in its order and nesting, as indented
/// lines that give each its reference. What changes in it settles for a
/// second (`Limits.settle`) and goes as the whole directory again. Updates
/// name a conversation by its title and what it sits under, never by its
/// reference, unless that alone leaves it unclear.
public actor CallContext {
    public enum Limits {
        public static let totalBytes = 32 * 1024
        /// Turns a read shows, the person's message still waiting for an answer
        /// counted as one: each the person's message and the agent's last
        /// words, or as much of the pair as there is.
        public static let turns = 5
        public static let messageBytes = 4 * 1024
        public static let errorBytes = 1024
        /// Conversations a directory snapshot shows, and its size.
        public static let directory = 100
        public static let directoryBytes = 12 * 1024
        /// One `directory_entries` event's size: the entries a snapshot
        /// couldn't show go in as many as they take, `pages` per update.
        public static let entriesBytes = 4 * 1024
        public static let pages = 2
        public static let page = 50
        /// Conversations the call hears from: the last ones visited, the one on screen included.
        public static let visited = 4
        /// The agent's messages looked at per change, newest last.
        public static let messages = 20
        public static let textBytes = 8 * 1024
        public static let toolDeadline: Duration = .seconds(8)
        /// From the first change to the directory to the one update that
        /// tells it; later changes never put that off.
        public static let settle: Duration = .seconds(1)
    }

    private let targets: any CallTargets
    private let now: @Sendable () -> Double
    private let toolDeadline: Duration
    private var refs: [String: String] = [:]
    private var agents: [String: String] = [:]
    private var nextRef = 1
    private var focus: String?
    private var focusRevision = 0
    /// The first snapshot has been made: until then the directory it will
    /// hold is news to no one.
    private var begun = false
    /// Newest first.
    private var visited: [String] = []
    /// The sidebar's conversations as last seen, in order and by ID.
    private var entries: [CallTarget] = []
    private var directory: [String: CallTarget] = [:]
    /// The directory the agent last had whole: the first snapshot's, or
    /// the last `directory` event's.
    private var listed: [Listing] = []
    /// What the agent has been told each conversation is: by a directory
    /// snapshot, an entry or `listSessions`.
    private var told: [String: Listing] = [:]
    /// Each conversation as the first snapshot had it: one that differs
    /// since is news the agent must have.
    private var first: [String: Listing] = [:]
    /// News the snapshots couldn't show and no update has carried yet, in
    /// order (`moreDirectory`).
    private(set) var owed: [String] = []
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

    /// A conversation as the directory tells it: never its status.
    private struct Listing: Equatable {
        var agentId: String
        var title: String
        var kind: CallTarget.Kind
        var parents: [CallTarget.Parent]

        init(_ target: CallTarget) {
            agentId = target.agentId
            title = target.title
            kind = target.kind
            parents = target.parents
        }
    }

    public init(targets: any CallTargets, now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 },
                toolDeadline: Duration = Limits.toolDeadline) {
        self.targets = targets
        self.now = now
        self.toolDeadline = toolDeadline
    }

    /// The conversations the call hears from now, the latest visited first.
    public var followed: [String] { visited }

    public func close() {
        closed = true
        for task in results.values { task.cancel() }
    }

    // MARK: The first snapshot

    /// `initialConversationContext`, the hosted prompt's one variable: the
    /// directory, and the conversation on screen with its last five turns.
    public func initial() async -> String {
        begun = true
        see(await targets.directory())
        listed = entries.map(Listing.init)
        first = Dictionary(listed.map { ($0.agentId, $0) }, uniquingKeysWith: { first, _ in first })
        focus = await targets.focused()
        var focused: CallTargetState?
        if let focus {
            visit(focus)
            if let state = await targets.state(of: focus) {
                focused = state
                if heard[focus] == nil { listen(state) }
            }
        }
        var envelope: [String: Any] = [
            "schema": 2,
            "at": Self.timestamp(now()),
            "tools": CallTool.allCases.map(\.rawValue),
            "focusRevision": focusRevision,
        ]
        var turns = focused.map(Self.recent) ?? []
        var budget = Limits.directoryBytes
        func encode(telling: Bool = false) -> Data {
            var value = envelope
            value["focus"] = focused.map { state in body(state, turns: turns, as: address(state.target)) } ?? NSNull()
            value["directory"] = directoryText(bytes: budget, showing: focused?.target, telling: telling)
            return Self.data(value)
        }
        var data = encode()
        // The older turn gives way first, then the directory's tail.
        while data.count > Limits.totalBytes, !turns.isEmpty {
            turns.removeFirst()
            data = encode()
        }
        while data.count > Limits.totalBytes, budget > 512 {
            budget /= 2
            data = encode()
        }
        data = encode(telling: true)
        return String(decoding: data, as: UTF8.self)
    }

    // MARK: What changes

    /// The sidebar changed, a status maybe and nothing more. True when what
    /// the agent last had of the directory is no longer so: something came,
    /// went, moved or was renamed. Then `flushDirectory` is due once
    /// `Limits.settle` has passed since the first such change, and no later.
    public func directoryChanged(_ now: [CallTarget]) -> Bool {
        guard !closed, begun else { return false }
        see(now)
        return entries.map(Listing.init) != listed
    }

    /// The directory, settled: read again as it is now, and if it isn't
    /// what the agent last had, told whole (`directory`). What came and
    /// went before this says nothing; work nobody has named yet goes by
    /// the sidebar's own label. Entries a snapshot can't show that are new
    /// or changed since the last one follow in `directory_entries`, up to
    /// `Limits.pages` here and the rest in `moreDirectory`. A conversation
    /// that went away is no longer heard from, and its reference reaches it
    /// again only if it comes back.
    public func flushDirectory() async -> CallUpdate {
        guard !closed, begun else { return CallUpdate() }
        let now = await targets.directory()
        guard !closed else { return CallUpdate() }
        see(now)
        for id in visited where directory[id] == nil {
            visited.removeAll { $0 == id }
            heard[id] = nil
        }
        told = told.filter { directory[$0.key] != nil }
        let listing = entries.map(Listing.init)
        guard listing != listed else { return CallUpdate() }
        let before = Dictionary(listed.map { ($0.agentId, $0) }, uniquingKeysWith: { first, _ in first })
        listed = listing
        let text = directoryText(bytes: Limits.directoryBytes, telling: true)
        let missed = entries.filter { told[$0.agentId] != Listing($0) && before[$0.agentId] != Listing($0) }
        owe(missed.map(\.agentId))
        return CallUpdate(context: [Self.string(["event": "directory", "text": text])] + pages())
    }

    /// News of the directory no update has carried yet (`owed`).
    public var owesDirectory: Bool { !owed.isEmpty }

    /// The next `Limits.pages` of what the directory owes; empty once all
    /// of it has gone. Each update stays well within what a call keeps
    /// waiting (`CallSession.pendingBytes`): one that is lost anyway is put
    /// right by `resync`, which owes it all again.
    public func moreDirectory() -> CallUpdate {
        guard !closed else { return CallUpdate() }
        return CallUpdate(context: pages())
    }

    /// What the directory owes, sent into `session` one bounded update at
    /// a time, each once the one before has reached the provider, and only
    /// while the call is connected; what is left waits for the next call
    /// of this. Never past the call's end.
    @MainActor
    public static func drain(_ context: CallContext, into session: CallSession) async {
        while case .active = session.state, await context.owesDirectory {
            await session.delivered()
            guard case .active = session.state else { return }
            let update = await context.moreDirectory()
            guard !update.isEmpty else { return }
            session.deliver(update)
        }
    }

    /// Something on screen changed which conversation is in front. A
    /// conversation becomes the latest visited; the fifth one back is no
    /// longer heard from. Settings or home in front keep them all.
    public func focusChanged(to agentId: String?) async -> CallUpdate {
        guard !closed, agentId != focus else { return CallUpdate() }
        // Newer than the directory as last seen: as the sidebar has it now.
        if let agentId, directory[agentId] == nil {
            see(await targets.directory())
            guard !closed, agentId != focus else { return CallUpdate() }
        }
        return moveFocus(to: agentId)
    }

    /// The focus moves, by the person or by `openSession`. A conversation
    /// the agent doesn't know as it is now is told first (`directory_entries`).
    private func moveFocus(to agentId: String?, telling: Bool = true) -> CallUpdate {
        guard !closed, agentId != focus else { return CallUpdate() }
        focus = agentId
        focusRevision += 1
        var context: [String] = []
        var event: [String: Any] = ["event": "focus", "focusRevision": focusRevision, "title": NSNull()]
        if let agentId {
            visit(agentId)
            if let entry = directory[agentId] {
                if telling { context += tell(entry) }
                event.merge(address(entry)) { _, new in new }
            }
        }
        return CallUpdate(context: context + [Self.string(event)])
    }

    /// One visited conversation's newest state. The first one the call
    /// sees is what was there already, and says nothing; after it, each of
    /// its agent's messages once it is complete (`CallMessage.final`), whole
    /// (`assistant_text`), never while it grows; and a turn an error ended
    /// (`session_error`). Nothing is told twice. A conversation the agent
    /// doesn't know as it is now (new, renamed) is told first.
    public func targetChanged(_ state: CallTargetState) -> CallUpdate {
        let id = state.target.agentId
        // Gone from the sidebar, even before the directory settles: never
        // told of again, and nothing about it goes.
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
        guard !context.isEmpty else { return CallUpdate() }
        return CallUpdate(context: tell(state.target) + context)
    }

    /// The context waiting for the call was too much and went unsent
    /// (`CallSession.pendingBytes`): what the agent now has wrong is put
    /// right in one go. The directory as it is (its news beyond the
    /// snapshot owed, for `moreDirectory`), then the focus, marked
    /// `resync`, then the errors this call told of and each message it
    /// told, as it told it, the most recent kept first, within half of
    /// `Limits.totalBytes`. What doesn't fit is counted in `omitted`; a
    /// read (`getSessionContext`) has it.
    public func resync() -> CallUpdate {
        guard !closed else { return CallUpdate() }
        told = [:]
        listed = entries.map(Listing.init)
        let directoryEvent = Self.string(["event": "directory", "text": directoryText(bytes: Limits.directoryBytes, telling: true)])
        // Every piece of news since the first snapshot that this one can't
        // show is owed again, whatever was lost: `moreDirectory` sends it.
        owe(entries.filter { told[$0.agentId] == nil && first[$0.agentId] != Listing($0) }.map(\.agentId))
        var errors: [String] = []
        var streamed: [(at: Int, event: String)] = []
        for id in visited {
            guard let known = heard[id] else { continue }
            streamed += known.said.values.map { ($0.at, $0.event) }
            for turn in known.told.keys.sorted() { errors.append(known.told[turn]!) }
        }
        let items = errors + streamed.sorted { $0.at > $1.at }.map(\.event)
        var focusEvent: [String: Any] = ["event": "focus", "focusRevision": focusRevision, "title": NSNull(), "resync": true]
        var entry: [String] = []
        if let focus, let target = directory[focus] {
            entry = tell(target)
            focusEvent.merge(address(target)) { _, new in new }
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
        return CallUpdate(context: [directoryEvent] + entry + [Self.string(focusEvent)] + kept.prefix(errorCount) + kept.dropFirst(errorCount).reversed())
    }

    // MARK: The directory

    /// The sidebar's conversations, as just read.
    private func see(_ now: [CallTarget]) {
        entries = now
        directory = Dictionary(now.map { ($0.agentId, $0) }, uniquingKeysWith: { first, _ in first })
    }

    /// The directory as the agent reads it: a line for each conversation,
    /// indented under what it sits in, with its kind and reference; a
    /// project or a worktree a heading without one. Within `bytes` and
    /// `Limits.directory` conversations, the rest counted at the end;
    /// `showing` goes after them when it was among the rest. `telling`
    /// marks each one shown as told.
    private func directoryText(bytes: Int, showing: CallTarget? = nil, telling: Bool) -> String {
        let marker = 96
        var (text, shown, taken) = lines(entries, header: "Conversation directory:", bytes: bytes - marker, count: Limits.directory)
        let omitted = entries.count - taken
        if let showing, !shown.contains(showing.agentId) {
            let extra = lines([showing], header: "\nOn screen:", bytes: Limits.entriesBytes, count: 1)
            text += extra.text
            shown += extra.shown
        }
        if omitted > 0 { text += "\n… and \(omitted) more; listSessions finds them by title." }
        if telling { for id in shown { if let entry = directory[id] { told[id] = Listing(entry) } } }
        return text
    }

    /// `ids` owed from now, after what is owed already.
    private func owe(_ ids: [String]) {
        for id in ids where !owed.contains(id) { owed.append(id) }
    }

    /// The next `Limits.pages` of what is owed, as it is now: what went
    /// away, or was told since, is owed no longer.
    private func pages() -> [String] {
        let list = owed.compactMap { id in directory[id].flatMap { told[id] == Listing($0) ? nil : $0 } }
        let (events, rest) = entryEvents(list, pages: Limits.pages)
        owed = rest.map(\.agentId)
        return events
    }

    /// Entries the agent doesn't have as they are now, in `directory_entries`
    /// events of up to `Limits.entriesBytes`, each with what it sits under;
    /// `pages` of them at most, and the entries they didn't hold.
    private func entryEvents(_ list: [CallTarget], pages: Int = .max) -> (events: [String], rest: [CallTarget]) {
        var rest = list[...]
        var events: [String] = []
        while !rest.isEmpty, events.count < pages {
            let (text, shown, taken) = lines(Array(rest), header: "More of the conversation directory:", bytes: Limits.entriesBytes, count: rest.count)
            guard taken > 0 else { break }
            rest = rest.dropFirst(taken)
            for id in shown { if let entry = list.first(where: { $0.agentId == id }) ?? directory[id] { told[id] = Listing(entry) } }
            events.append(Self.string(["event": "directory_entries", "text": text]))
        }
        return (events, Array(rest))
    }

    /// `entry` told as it is now, if the agent doesn't have it so.
    private func tell(_ entry: CallTarget) -> [String] {
        told[entry.agentId] == Listing(entry) ? [] : entryEvents([entry]).events
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
                    chunk += "\n\(indent)\(parent.title) [\(parent.kind); ref=\(ref(agentId))]"
                    under.append(agentId)
                } else {
                    chunk += "\n\(indent)\(parent.title) [\(parent.kind)]"
                }
            }
            let line = "\(entry.title) [\(entry.kind.rawValue); ref=\(ref(entry.agentId))]"
            chunk += "\n\(String(repeating: "  ", count: entry.parents.count))\(line)"
            // Sizes as the JSON that carries them: quotes, backslashes,
            // slashes and control characters take more there.
            if taken == 0, Self.encoded(text) + Self.encoded(chunk) > bytes {
                flat = true
                // What it sits under too deep for the lines: on one of its
                // own, cut to fit, the entry under it unindented.
                let room = max(0, bytes - Self.encoded(text) - Self.encoded(line) - 16)
                let trail = Self.truncated(entry.parents.map(\.title).joined(separator: " > "), bytes: room, size: Self.encoded)
                chunk = "\n(under \(trail))\n\(line)"
                under = []
            }
            guard Self.encoded(text) + Self.encoded(chunk) <= bytes else { break }
            text += chunk
            // Lines after a flat one show what they sit under again.
            path = flat ? [] : keys + [entry.agentId]
            shown += under + [entry.agentId]
            taken += 1
        }
        return (text, shown, taken)
    }

    /// How updates name a conversation: its title and the titles of what
    /// it sits under, outermost first. Its reference too, only when those
    /// leave it unclear: another one is named the same under the same, or
    /// it has no name of its own yet ("New Task").
    private func address(_ target: CallTarget) -> [String: Any] {
        let parents = target.parents.map(\.title)
        var value: [String: Any] = ["title": target.title, "parents": parents]
        let twins = entries.filter { $0.title == target.title && $0.parents.map(\.title) == parents }.count
        if twins > 1 || CallTarget.placeholders.contains(target.title) { value["ref"] = ref(target.agentId) }
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
            for entry in page { told[entry.agentId] = Listing(entry) }
            var value: [String: Any] = ["sessions": page.map { row($0) }]
            if start + page.count < matching.count { value["nextCursor"] = String(start + page.count) }
            return .json(value)

        case .getSessionContext:
            guard let id = await resolve(arguments["targetRef"]) else { return .refused("No such conversation.") }
            guard let state = await targets.state(of: id) else { return .refused("That conversation can't be read now.") }
            // Within the snapshot's budget too: the oldest turns give way.
            // Asked for by its reference, it is named by its title alone.
            let name: [String: Any] = ["title": state.target.title, "parents": state.target.parents.map(\.title)]
            var turns = Self.recent(state)
            var value = body(state, turns: turns, as: name)
            while Self.data(value).count > Limits.totalBytes, !turns.isEmpty {
                turns.removeFirst()
                value = body(state, turns: turns, as: name)
            }
            return .json(value)

        case .openSession:
            guard let id = await resolve(arguments["targetRef"]) else { return .refused("No such conversation.") }
            let asOf = Self.revision(arguments["focusRevision"])
            guard asOf == focusRevision else { return Self.stale }
            // Past its deadline the answer is gone: nothing moves on screen after it.
            guard !Task.isCancelled, !closed else { return .refused("No answer in time.") }
            guard await targets.open(id) else { return .refused("It didn't open.") }
            // In front now as far as the call goes, with the revision the
            // next step takes. The screen says so too; whichever of the two
            // comes second says nothing.
            // The agent named it by its reference, so it needs no telling.
            _ = moveFocus(to: id, telling: false)
            return .json(["opened": true, "targetRef": ref(id), "focusRevision": focusRevision])

        case .sendMessage:
            guard let id = await resolve(arguments["targetRef"]) else { return .refused("No such conversation.") }
            guard let text = arguments["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return .refused("There's nothing to send.")
            }
            guard text.utf8.count <= Limits.textBytes else { return .refused("That message is too long to send by voice.") }
            let asOf = Self.revision(arguments["focusRevision"])
            guard asOf == focusRevision else { return Self.stale }
            guard let state = await targets.state(of: id) else { return .refused("That conversation can't be read now.") }
            guard state.writable else { return .refused("That conversation can't take a message now.") }
            guard !state.needsInput else { return .refused("It's waiting for the person in the app; answer there first.") }
            // Reading it was a wait: the screen, or the call, may have moved
            // on, or the answer's time run out. Nothing goes after that.
            guard !closed else { return .refused("The call has ended.") }
            guard !Task.isCancelled else { return .refused("No answer in time.") }
            guard asOf == focusRevision else { return Self.stale }
            let key = "\(id)\u{0}\(text)"
            let messageId = unsettled[key] ?? ClientID.make()
            unsettled[key] = messageId
            settling[call] = key
            switch await targets.send(id, text: text, id: messageId) {
            case .queued:
                return .json(["status": "queued", "targetRef": ref(id), "delivery": Self.queued])
            case .refused(let reason):
                return .refused(reason)
            }
        }
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
        return directory[id] == nil ? nil : id
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
    private func body(_ state: CallTargetState, turns: [CallTurn], as name: [String: Any]) -> [String: Any] {
        var value = name
        value["working"] = state.working
        value["needsInput"] = state.needsInput
        value["turns"] = turns.map(Self.turn)
        value["olderTurns"] = state.hasMore || Self.answering(state).count > turns.count
        if let pending = state.unanswered {
            let text = Self.truncated(pending.text, bytes: Limits.messageBytes)
            var message: [String: Any] = ["text": text]
            if text.utf8.count < pending.text.utf8.count { message["truncated"] = true }
            if let delivery = pending.delivery { message["delivery"] = delivery.rawValue }
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

    /// `text`'s size inside a JSON string as `data` writes it: a quote, a
    /// backslash, a slash and \n, \r, \t, \b, \f two bytes each, any
    /// other control character six, the rest its UTF-8.
    static func encoded(_ text: String) -> Int {
        text.unicodeScalars.reduce(0) { sum, scalar in
            switch scalar.value {
            case 0x22, 0x5C, 0x2F, 0x0A, 0x0D, 0x09, 0x08, 0x0C: sum + 2
            case 0..<0x20: sum + 6
            default: sum + String(scalar).utf8.count
            }
        }
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

    static func timestamp(_ seconds: Double) -> String {
        let formatter = ISO8601DateFormatter()
        return formatter.string(from: Date(timeIntervalSince1970: seconds))
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

/// A call's one directory update on its way (`CallContext.flushDirectory`):
/// due `delay` after the first change it tells, whatever comes after; a
/// change after it has gone starts the next. Cancelled with its call.
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

/// A call's one sender of what its directory owes (`CallContext.drain`):
/// asked again while it runs, it goes round once more instead of starting
/// a second, so no more than one update of it waits on the connection at
/// a time. Cancelled with its call.
@MainActor
public final class DirectoryDrain {
    private let context: CallContext
    private weak var session: CallSession?
    private var running: Task<Void, Never>?
    private var again = false

    public init(context: CallContext, session: CallSession) {
        self.context = context
        self.session = session
    }

    public func start() {
        guard running == nil else {
            again = true
            return
        }
        running = Task { [weak self] in
            while let self, !Task.isCancelled, let session = self.session {
                self.again = false
                await CallContext.drain(self.context, into: session)
                guard self.again else {
                    self.running = nil
                    return
                }
            }
        }
    }

    public func cancel() {
        running?.cancel()
        running = nil
    }
}
