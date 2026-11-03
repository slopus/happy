import Foundation

/// What a call tells the hosted agent besides the person's voice: context
/// updates, which it reads silently, and prompts, which ask it to speak
/// (sent only while nobody is).
public struct CallUpdate: Equatable, Sendable {
    public var context: [String]
    public var prompts: [String]

    public init(context: [String] = [], prompts: [String] = []) {
        self.context = context
        self.prompts = prompts
    }

    public var isEmpty: Bool { context.isEmpty && prompts.isEmpty }
}

/// Lives only during one call, bound to one account. It owns the opaque
/// references the hosted agent knows conversations by, what it was last
/// told of each, the focus and the watches, and runs the five tools one at
/// a time. Rich updates (words, runs, needs-input) go only for the focused
/// conversation, the watched ones and those this call sent work to; every
/// other conversation contributes its directory row alone.
public actor CallContext {
    public enum Limits {
        public static let totalBytes = 32 * 1024
        public static let messages = 20
        public static let messageBytes = 4 * 1024
        public static let directory = 100
        public static let page = 50
        public static let watches = 7
        public static let textBytes = 8 * 1024
        /// A conversation's words while the agent writes them, at most
        /// this often.
        public static let partialInterval: Double = 0.5
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
    private var revision = 0
    private var watches: [String] = []
    private var dispatched: Set<String> = []
    private var directory: [String: CallTarget] = [:]
    private var removed: Set<String> = []
    private var told: [String: Told] = [:]
    private var sent: [String: String] = [:]
    /// Sends whose answer the agent may not have had, by target and text:
    /// the same words to the same conversation again go under the same ID,
    /// which the conversation takes once.
    private var unsettled: [String: String] = [:]
    private var settling: [String: String] = [:]
    private var results: [String: Task<CallToolResult, Never>] = [:]
    private var tail: Task<Void, Never>?
    private var closed = false

    /// What the agent last heard of one conversation.
    private struct Told {
        var working: Bool
        var needsInput: Bool
        var messages: [String: Heard]
        var partialAt: Double = -.infinity
        var lastFinished: String?
    }

    private struct Heard: Equatable {
        var text: String
        var final: Bool
        var delivery: CallMessage.Delivery?
    }

    public init(targets: any CallTargets, now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 },
                toolDeadline: Duration = Limits.toolDeadline) {
        self.targets = targets
        self.now = now
        self.toolDeadline = toolDeadline
    }

    /// The conversations that get rich updates now.
    public var followed: [String] {
        var ids: [String] = []
        if let focus { ids.append(focus) }
        for id in watches + dispatched.sorted() where !ids.contains(id) { ids.append(id) }
        return ids
    }

    public func close() {
        closed = true
        for task in results.values { task.cancel() }
    }

    // MARK: The first snapshot

    /// `initialConversationContext`, the hosted prompt's one variable: the
    /// account's directory, and the focused conversation's recent words.
    public func initial() async -> String {
        let entries = await targets.directory()
        for entry in entries { directory[entry.agentId] = entry }
        focus = await targets.focused()
        var focused: CallTargetState?
        if let focus, let state = await targets.state(of: focus) {
            focused = state
            remember(state)
        }
        revision += 1
        var envelope: [String: Any] = [
            "schema": 1,
            "revision": revision,
            "at": Self.timestamp(now()),
            "tools": CallTool.allCases.map(\.rawValue),
            "focusRevision": focusRevision,
            "watches": watches.map(ref),
        ]
        var rows = entries.prefix(Limits.directory).map { row($0) }
        envelope["directoryTruncated"] = entries.count > Limits.directory
        var history = focused.map { Array($0.messages.suffix(Limits.messages)) } ?? []
        var historyTruncated = (focused?.messages.count ?? 0) > Limits.messages || focused?.hasMore == true
        func encode() -> Data {
            var value = envelope
            value["focus"] = focused.map { body($0, messages: history) } ?? NSNull()
            value["historyTruncated"] = historyTruncated
            value["directory"] = rows
            return Self.data(value)
        }
        var data = encode()
        // History gives way first, then the directory's tail.
        while data.count > Limits.totalBytes, !history.isEmpty {
            history.removeFirst()
            historyTruncated = true
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

    /// The sidebar's conversations changed: names and states, silently. A
    /// conversation that went away can't be named again this call.
    public func directoryChanged(_ entries: [CallTarget]) -> CallUpdate {
        guard !closed else { return CallUpdate() }
        var changed: [[String: Any]] = []
        let ids = Set(entries.map(\.agentId))
        for entry in entries.prefix(Limits.directory) where directory[entry.agentId] != entry {
            directory[entry.agentId] = entry
            changed.append(row(entry))
        }
        var gone: [String] = []
        for id in directory.keys where !ids.contains(id) {
            directory[id] = nil
            removed.insert(id)
            watches.removeAll { $0 == id }
            if refs[id] != nil { gone.append(ref(id)) }
        }
        guard !changed.isEmpty || !gone.isEmpty else { return CallUpdate() }
        var event: [String: Any] = ["event": "directory"]
        if !changed.isEmpty { event["changed"] = changed }
        if !gone.isEmpty { event["removed"] = gone.sorted() }
        return CallUpdate(context: [Self.string(event)])
    }

    /// Something on screen changed which conversation is in front.
    public func focusChanged(to agentId: String?) async -> CallUpdate {
        guard !closed, agentId != focus else { return CallUpdate() }
        focus = agentId
        focusRevision += 1
        var event: [String: Any] = ["event": "focus", "focusRevision": focusRevision]
        if let agentId, let state = await targets.state(of: agentId) {
            remember(state)
            event["focus"] = body(state, messages: Array(state.messages.suffix(Limits.messages)))
        } else {
            event["focus"] = NSNull()
        }
        return CallUpdate(context: [Self.string(event)])
    }

    /// One followed conversation's newest state. What changed since the
    /// agent last heard goes as context; a run this call sent work to that
    /// finishes, a conversation that comes to need the person, and a
    /// message of this call's that failed ask it to speak.
    public func targetChanged(_ state: CallTargetState) -> CallUpdate {
        let id = state.target.agentId
        guard !closed, followed.contains(id) else { return CallUpdate() }
        guard var known = told[id] else {
            remember(state)
            return CallUpdate(context: [Self.string(["event": "resync", "target": body(state, messages: Array(state.messages.suffix(Limits.messages)))])])
        }
        let at = now()
        let title = state.target.title
        var context: [String] = []
        var prompts: [String] = []
        let tracked = dispatched.contains(id)
        let partialDue = at - known.partialAt >= Limits.partialInterval
        var sentPartial = false

        let present = Set(state.messages.map(\.id))
        for messageId in known.messages.keys.sorted() where !present.contains(messageId) {
            known.messages[messageId] = nil
            context.append(Self.string(["event": "message_removed", "target": ref(id), "messageId": messageId]))
        }
        for message in state.messages.suffix(Limits.messages) {
            let previous = known.messages[message.id]
            switch message.role {
            case .user:
                guard previous?.text != message.text || previous?.delivery != message.delivery else { continue }
                known.messages[message.id] = Heard(text: message.text, final: true, delivery: message.delivery)
                var event: [String: Any] = ["event": "user_message", "target": ref(id), "message": Self.message(message)]
                if sent[message.id] != nil {
                    event["fromThisCall"] = true
                    if message.delivery == .failed, previous?.delivery != .failed {
                        prompts.append("Your message to \(title) could not be sent. Tell the person briefly.")
                    }
                }
                context.append(Self.string(event))
            case .assistant:
                guard previous?.text != message.text || previous?.final != message.final else { continue }
                if !message.final, !partialDue { continue }
                if !message.final { sentPartial = true }
                known.messages[message.id] = Heard(text: message.text, final: message.final)
                context.append(Self.string(["event": "assistant_text", "target": ref(id), "message": Self.message(message)]))
            }
        }
        if sentPartial { known.partialAt = at }

        if state.working != known.working {
            known.working = state.working
            context.append(Self.string(["event": state.working ? "run_started" : "run_finished", "target": ref(id)]))
        }
        // Finished is the agent's reply after this call's last message, with
        // the run over: a status that only flickers to idle before the
        // message is taken, or between runs, says nothing.
        if tracked, !state.working, let reply = state.messages.lastIndex(where: { $0.role == .assistant }),
           let asked = state.messages.lastIndex(where: { sent[$0.id] == id }), reply > asked,
           state.messages[reply].id != known.lastFinished {
            known.lastFinished = state.messages[reply].id
            prompts.append("\(title) finished. Tell the person its latest reply in a sentence or two.")
        }
        if state.needsInput != known.needsInput {
            known.needsInput = state.needsInput
            context.append(Self.string(["event": "needs_input", "target": ref(id), "needsInput": state.needsInput]))
            if state.needsInput {
                prompts.append("\(title) needs the person in the app. Say so briefly; don't try to answer it.")
            }
        }
        told[id] = known
        return CallUpdate(context: context, prompts: prompts)
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
            let query = (arguments["query"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
            let start = (arguments["cursor"] as? String).flatMap(Int.init) ?? 0
            let entries = await targets.directory()
            for entry in entries { directory[entry.agentId] = entry }
            let matching = query.isEmpty ? entries : entries.filter { $0.title.lowercased().contains(query) }
            let page = matching.dropFirst(max(0, start)).prefix(Limits.page)
            var value: [String: Any] = ["sessions": page.map { row($0) }]
            if start + page.count < matching.count { value["nextCursor"] = String(start + page.count) }
            return .json(value)

        case .getSessionContext:
            guard let id = resolve(arguments["targetRef"]) else { return .refused("No such conversation.") }
            guard let state = await targets.state(of: id) else { return .refused("That conversation can't be read now.") }
            return .json(body(state, messages: Array(state.messages.suffix(Limits.messages))))

        case .openSession:
            guard let id = resolve(arguments["targetRef"]) else { return .refused("No such conversation.") }
            let asOf = Self.revision(arguments["focusRevision"])
            guard asOf == focusRevision else { return Self.stale }
            guard await targets.open(id) else { return .refused("It didn't open.") }
            return .json(["opened": true, "targetRef": ref(id)])

        case .setSessionWatch:
            guard let id = resolve(arguments["targetRef"]) else { return .refused("No such conversation.") }
            guard let enabled = Self.boolean(arguments["enabled"]) else { return .refused("enabled must be true or false.") }
            if enabled, !watches.contains(id) {
                guard watches.count < Limits.watches else { return .refused("Already following \(Limits.watches); stop one first.") }
                watches.append(id)
                await targets.follow(id, true)
            } else if !enabled, watches.contains(id) {
                watches.removeAll { $0 == id }
                if focus != id, !dispatched.contains(id) { await targets.follow(id, false) }
            }
            return .json(["watching": watches.map(ref)])

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
                sent[messageId] = id
                if dispatched.insert(id).inserted, told[id] == nil { remember(state) }
                await targets.follow(id, true)
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

    private func remember(_ state: CallTargetState) {
        var messages: [String: Heard] = [:]
        for message in state.messages.suffix(Limits.messages) {
            messages[message.id] = Heard(text: message.text, final: message.final, delivery: message.delivery)
        }
        told[state.target.agentId] = Told(working: state.working, needsInput: state.needsInput, messages: messages,
                                          lastFinished: state.working ? nil : state.messages.last { $0.role == .assistant }?.id)
    }

    private func row(_ target: CallTarget) -> [String: Any] {
        var value: [String: Any] = ["targetRef": ref(target.agentId), "title": target.title, "kind": target.kind.rawValue, "status": target.status.rawValue]
        if let project = target.project { value["project"] = project }
        return value
    }

    private func body(_ state: CallTargetState, messages: [CallMessage]) -> [String: Any] {
        var value = row(state.target)
        value["working"] = state.working
        value["needsInput"] = state.needsInput
        value["writable"] = state.writable
        value["hasDraft"] = state.hasDraft
        value["olderMessages"] = state.hasMore || state.messages.count > messages.count
        value["messages"] = messages.map(Self.message)
        return value
    }

    static func message(_ message: CallMessage) -> [String: Any] {
        let text = truncated(message.text, bytes: Limits.messageBytes)
        var value: [String: Any] = ["id": message.id, "role": message.role.rawValue, "text": text, "final": message.final]
        if text.utf8.count < message.text.utf8.count { value["truncated"] = true }
        if let time = message.time { value["at"] = timestamp(time / 1000) }
        if let delivery = message.delivery { value["delivery"] = delivery.rawValue }
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

    /// A JSON boolean: never 0, 1, "true" or null.
    private static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, isBoolean(number) else { return nil }
        return number.boolValue
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
