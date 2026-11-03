import Foundation

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
/// conversation says only what its agent writes from then on, as it comes,
/// and an error that stopped it: never its tools, its state or the person's
/// messages. Every other conversation contributes its directory row alone.
public actor CallContext {
    public enum Limits {
        public static let totalBytes = 32 * 1024
        /// Finished turns a read shows: the person's message and the agent's final answer each.
        public static let turns = 2
        public static let messageBytes = 4 * 1024
        public static let errorBytes = 1024
        public static let directory = 100
        public static let page = 50
        /// Conversations the call hears from: the last ones visited, the one on screen included.
        public static let visited = 4
        /// The agent's messages looked at per change, newest last.
        public static let messages = 20
        public static let textBytes = 8 * 1024
        /// A conversation's new words while its agent writes them, at most this often.
        public static let streamInterval: Double = 0.5
        public static let toolDeadline: Duration = .seconds(8)
    }

    private let targets: any CallTargets
    private let now: @Sendable () -> Double
    private let toolDeadline: Duration
    private var refs: [String: String] = [:]
    private var agents: [String: String] = [:]
    private var nextRef = 1
    private var focus: String?
    private var focusRevision = 0
    /// Newest first.
    private var visited: [String] = []
    private var directory: [String: CallTarget] = [:]
    private var removed: Set<String> = []
    private var heard: [String: Heard] = [:]
    private var updates = 0
    /// Sends whose answer the agent may not have had, by target and text:
    /// the same words to the same conversation again go under the same ID,
    /// which the conversation takes once.
    private var unsettled: [String: String] = [:]
    private var settling: [String: String] = [:]
    private var results: [String: Task<CallToolResult, Never>] = [:]
    private var tail: Task<Void, Never>?
    private var closed = false

    /// What the agent has of one visited conversation: the words of each of
    /// its agent's messages, those there when it was first seen counted as
    /// had, and the errors it knows of.
    private struct Heard {
        var said: [String: Said] = [:]
        var errors: Set<String> = []
        /// The errors this call told of, by turn, with what it said.
        var told: [String: String?] = [:]
        var at: Double = -.infinity
    }

    private struct Said {
        var text: String
        /// At `Limits.messageBytes`: nothing more of it goes.
        var full: Bool
        /// Its end was told (or it was finished when first seen).
        var final: Bool
        /// Words of it went during the call (not there when first seen),
        /// the last time at this count of the call's updates.
        var streamed: Int?
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
    /// account's directory, and the conversation on screen with its last
    /// two finished turns.
    public func initial() async -> String {
        let entries = await targets.directory()
        for entry in entries { directory[entry.agentId] = entry }
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
            "schema": 1,
            "at": Self.timestamp(now()),
            "tools": CallTool.allCases.map(\.rawValue),
            "focusRevision": focusRevision,
        ]
        var rows = entries.prefix(Limits.directory).map { row($0) }
        envelope["directoryTruncated"] = entries.count > Limits.directory
        var turns = focused.map(Self.recent) ?? []
        func encode() -> Data {
            var value = envelope
            value["focus"] = focused.map { body($0, turns: turns) } ?? NSNull()
            value["directory"] = rows
            return Self.data(value)
        }
        var data = encode()
        // The older turn gives way first, then the directory's tail.
        while data.count > Limits.totalBytes, !turns.isEmpty {
            turns.removeFirst()
            data = encode()
        }
        while data.count > Limits.totalBytes, !rows.isEmpty {
            rows.removeLast()
            envelope["directoryTruncated"] = true
            data = encode()
        }
        return String(decoding: data, as: UTF8.self)
    }

    // MARK: What changes

    /// The sidebar's conversations came, went or were renamed: silently,
    /// and not for a status, which a read gives. A conversation that went
    /// away can't be named again this call, and is no longer heard from.
    public func directoryChanged(_ entries: [CallTarget]) -> CallUpdate {
        guard !closed else { return CallUpdate() }
        var changed: [[String: Any]] = []
        let ids = Set(entries.map(\.agentId))
        for entry in entries.prefix(Limits.directory) {
            let old = directory[entry.agentId]
            directory[entry.agentId] = entry
            if old?.title != entry.title || old?.kind != entry.kind || old?.project != entry.project { changed.append(row(entry)) }
        }
        var gone: [String] = []
        for id in directory.keys where !ids.contains(id) {
            directory[id] = nil
            removed.insert(id)
            visited.removeAll { $0 == id }
            heard[id] = nil
            if refs[id] != nil { gone.append(ref(id)) }
        }
        guard !changed.isEmpty || !gone.isEmpty else { return CallUpdate() }
        var event: [String: Any] = ["event": "directory"]
        if !changed.isEmpty { event["changed"] = changed }
        if !gone.isEmpty { event["removed"] = gone.sorted() }
        return CallUpdate(context: [Self.string(event)])
    }

    /// Something on screen changed which conversation is in front. A
    /// conversation becomes the latest visited; the fifth one back is no
    /// longer heard from. Settings or home in front keep them all.
    public func focusChanged(to agentId: String?) -> CallUpdate {
        guard !closed, agentId != focus else { return CallUpdate() }
        focus = agentId
        focusRevision += 1
        var event: [String: Any] = ["event": "focus", "focusRevision": focusRevision, "targetRef": NSNull()]
        if let agentId {
            visit(agentId)
            event["targetRef"] = ref(agentId)
            if let title = directory[agentId]?.title { event["title"] = title }
        }
        return CallUpdate(context: [Self.string(event)])
    }

    /// One visited conversation's newest state. The first one the call
    /// sees is what was there already, and says nothing; after it, only
    /// the agent's new words, at most every half second while it writes
    /// (`assistant_text`, the words since the last), a message rewritten
    /// rather than added to (`assistant_text_reset`, the whole of it), and
    /// a turn an error ended (`session_error`).
    public func targetChanged(_ state: CallTargetState) -> CallUpdate {
        let id = state.target.agentId
        guard !closed, visited.contains(id) else { return CallUpdate() }
        guard var known = heard[id] else {
            listen(state)
            return CallUpdate()
        }
        let at = now()
        let due = !state.working || at - known.at >= Limits.streamInterval
        var context: [String] = []
        var streamed = false
        for message in state.messages.suffix(Limits.messages) where message.role == .assistant {
            var said = known.said[message.id] ?? Said(text: "", full: false, final: false)
            // Words to send, or the same words now finished: their end goes once.
            guard due, !said.full, message.text != said.text || (message.final && !said.final) else { continue }
            var event: [String: Any] = ["target": ref(id), "messageId": message.id, "final": message.final]
            said.final = message.final
            updates += 1
            said.streamed = updates
            if message.text.utf8.starts(with: said.text.utf8) {
                let room = max(0, Limits.messageBytes - said.text.utf8.count)
                var delta = String(decoding: message.text.utf8.dropFirst(said.text.utf8.count), as: UTF8.self)
                if delta.utf8.count > room {
                    delta = Self.truncated(delta, bytes: room)
                    said.full = true
                    event["truncated"] = true
                }
                said.text += delta
                event["event"] = "assistant_text"
                event["delta"] = delta
            } else {
                let text = Self.truncated(message.text, bytes: Limits.messageBytes)
                said.text = text
                said.full = text.utf8.count < message.text.utf8.count
                event["event"] = "assistant_text_reset"
                event["text"] = text
                if said.full { event["truncated"] = true }
            }
            known.said[message.id] = said
            streamed = true
            context.append(Self.string(event))
        }
        if streamed { known.at = at }
        let present = Set(state.messages.map(\.id))
        known.said = known.said.filter { present.contains($0.key) }
        for turn in state.turns where turn.ended == "error" && !known.errors.contains(turn.id) {
            let reason = turn.error.flatMap { $0.isEmpty ? nil : Self.truncated($0, bytes: Limits.errorBytes) }
            known.told[turn.id] = .some(reason)
            context.append(stopped(id, reason: reason))
        }
        known.errors = Set(state.turns.filter { $0.ended == "error" }.map(\.id))
        known.told = known.told.filter { known.errors.contains($0.key) }
        heard[id] = known
        return CallUpdate(context: context)
    }

    /// The context waiting for the call was too much and went unsent
    /// (`CallSession.pendingBytes`): what the agent now has wrong is put
    /// right in one go, within half of `Limits.totalBytes` so it never
    /// overflows the wait itself. The focus as it is now, marked `resync`,
    /// then the errors this call told of and each message it streamed, whole
    /// as far as it went (`assistant_text_reset`), the most recent kept
    /// first. What doesn't fit is counted in `omitted`; a read
    /// (`getSessionContext`) has it.
    public func resync() -> CallUpdate {
        guard !closed else { return CallUpdate() }
        var errors: [String] = []
        var streamed: [(at: Int, event: String)] = []
        for id in visited {
            guard let known = heard[id] else { continue }
            for (messageId, said) in known.said {
                guard let at = said.streamed else { continue }
                var event: [String: Any] = ["event": "assistant_text_reset", "target": ref(id), "messageId": messageId,
                                            "text": said.text, "final": said.final]
                if said.full { event["truncated"] = true }
                streamed.append((at, Self.string(event)))
            }
            for turn in known.told.keys.sorted() { errors.append(stopped(id, reason: known.told[turn] ?? nil)) }
        }
        let items = errors + streamed.sorted { $0.at > $1.at }.map(\.event)
        var focusEvent: [String: Any] = ["event": "focus", "focusRevision": focusRevision, "targetRef": NSNull(), "resync": true]
        if let focus {
            focusEvent["targetRef"] = ref(focus)
            if let title = directory[focus]?.title { focusEvent["title"] = title }
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

    private func stopped(_ agentId: String, reason: String?) -> String {
        var event: [String: Any] = ["event": "session_error", "target": ref(agentId)]
        if let reason { event["reason"] = reason }
        return Self.string(event)
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
            let entries = await targets.directory()
            for entry in entries { directory[entry.agentId] = entry }
            let matching = needle.isEmpty ? entries : entries.filter { $0.title.lowercased().contains(needle) }
            let page = matching.dropFirst(start).prefix(Limits.page)
            var value: [String: Any] = ["sessions": page.map { row($0) }]
            if start + page.count < matching.count { value["nextCursor"] = String(start + page.count) }
            return .json(value)

        case .getSessionContext:
            guard let id = resolve(arguments["targetRef"]) else { return .refused("No such conversation.") }
            guard let state = await targets.state(of: id) else { return .refused("That conversation can't be read now.") }
            return .json(body(state, turns: Self.recent(state)))

        case .openSession:
            guard let id = resolve(arguments["targetRef"]) else { return .refused("No such conversation.") }
            let asOf = Self.revision(arguments["focusRevision"])
            guard asOf == focusRevision else { return Self.stale }
            guard await targets.open(id) else { return .refused("It didn't open.") }
            return .json(["opened": true, "targetRef": ref(id)])

        case .sendMessage:
            guard let id = resolve(arguments["targetRef"]) else { return .refused("No such conversation.") }
            guard let text = arguments["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return .refused("There's nothing to send.")
            }
            guard text.utf8.count <= Limits.textBytes else { return .refused("That message is too long to send by voice.") }
            let asOf = Self.revision(arguments["focusRevision"])
            guard asOf == focusRevision else { return Self.stale }
            guard let state = await targets.state(of: id) else { return .refused("That conversation can't be read now.") }
            guard state.writable else { return .refused("That conversation can't take a message now.") }
            guard !state.needsInput else { return .refused("It's waiting for the person in the app; answer there first.") }
            // Reading it was a wait: the screen, or the call, may have moved on.
            guard !closed else { return .refused("The call has ended.") }
            guard asOf == focusRevision else { return Self.stale }
            let key = "\(id)\u{0}\(text)"
            let messageId = unsettled[key] ?? ClientID.make()
            unsettled[key] = messageId
            settling[call] = key
            switch await targets.send(id, text: text, id: messageId) {
            case .queued:
                return .json(["status": "queued", "targetRef": ref(id)])
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

    private func resolve(_ value: Any?) -> String? {
        guard let ref = value as? String, let id = agents[ref], !removed.contains(id) else { return nil }
        return id
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
    /// agent's finished messages and the errors so far. A reply still
    /// being written is new, and goes from its start.
    private func listen(_ state: CallTargetState) {
        var known = Heard()
        for message in state.messages where message.role == .assistant && message.final {
            known.said[message.id] = Said(text: message.text, full: message.text.utf8.count >= Limits.messageBytes, final: true)
        }
        known.errors = Set(state.turns.filter { $0.ended == "error" }.map(\.id))
        heard[state.target.agentId] = known
    }

    private func row(_ target: CallTarget) -> [String: Any] {
        var value: [String: Any] = ["targetRef": ref(target.agentId), "title": target.title, "kind": target.kind.rawValue, "status": target.status.rawValue]
        if let project = target.project { value["project"] = project }
        return value
    }

    /// The last finished turns that answered or failed: what a read shows.
    static func recent(_ state: CallTargetState) -> [CallTurn] {
        Array(answering(state).suffix(Limits.turns))
    }

    private static func answering(_ state: CallTargetState) -> [CallTurn] {
        state.turns.filter { $0.reply?.isEmpty == false || $0.ended == "error" }
    }

    private func body(_ state: CallTargetState, turns: [CallTurn]) -> [String: Any] {
        var value = row(state.target)
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

    /// The longest prefix of whole characters within `bytes` of UTF-8.
    static func truncated(_ text: String, bytes: Int) -> String {
        guard text.utf8.count > bytes else { return text }
        var count = 0
        var end = text.startIndex
        for index in text.indices {
            let next = text[index].utf8.count
            if count + next > bytes { break }
            count += next
            end = text.index(after: index)
        }
        return String(text[..<end])
    }

    private static let stale = CallToolResult.refused("The screen changed since; check the focus again.")

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
