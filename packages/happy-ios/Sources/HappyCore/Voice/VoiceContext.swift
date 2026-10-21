import Foundation
import HappyStore
import HappyWire

public struct VoiceContextUpdate: Equatable, Sendable {
    public var context: String
    public var prompts: [String]
    public init(context: String = "", prompts: [String] = []) { self.context = context; self.prompts = prompts }
}

/// Incremental context uses only rendered records. Streaming text is sent
/// when its text changes; tokens do not rebuild history for other sessions.
public struct VoiceContextReducer: Sendable {
    private var messages: [String: ChatMessage] = [:]
    private var permissions = Set<String>()
    private var loaded = false
    public init() {}

    public mutating func apply(_ snapshot: ChatSnapshot) -> VoiceContextUpdate {
        let changed = snapshot.messages.suffix(50).filter { messages[$0.id] != $0 }
        let lines = changed.compactMap(Self.format)
        var prompts: [String] = []
        for message in snapshot.messages {
            if case .toolCall(let call) = message, let permission = call.tool.permission,
               permission.status == .pending, permissions.insert(permission.id).inserted {
                prompts.append("Coding agent requests permission in session \(snapshot.sessionId): requestId=\(permission.id), tool=\(call.tool.name), input=\(Self.json(call.tool.input)). Ask the user before calling processPermissionRequest.")
            }
            if loaded, messages[message.id] == nil, case .agentEvent(let event) = message, event.event == .ready {
                prompts.append("Coding agent done working in session: \(snapshot.sessionId). Report the preceding summary to the human.")
            }
        }
        messages = Dictionary(snapshot.messages.suffix(50).map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
        loaded = true
        return VoiceContextUpdate(context: lines.isEmpty ? "" : "Messages in session \(snapshot.sessionId):\n" + lines.joined(separator: "\n\n"), prompts: prompts)
    }

    public static func format(_ message: ChatMessage) -> String? {
        switch message {
        case .userText(let text): "User: \(text.text.prefix(8000))"
        case .agentText(let text): text.isThinking ? nil : "Coding agent: \(text.text.prefix(8000))"
        case .toolCall(let call): call.tool.description.map { "Coding agent uses \(call.tool.name): \($0.prefix(2000))" }
        default: nil
        }
    }

    private static func json(_ value: JSONValue) -> String {
        (try? String(decoding: value.encoded(), as: UTF8.self)) ?? "{}"
    }
}

/// Lives only during a voice call. Disk reads, context derivation and tool
/// execution stay on this actor, never on UIKit's queue.
public actor VoiceContext {
    private let account: AccountSession
    private let sending: any ChatSending
    private let actions: SessionActions
    private var homeTask: Task<Void, Never>?
    private var chatTasks: [String: Task<Void, Never>] = [:]
    private var reducers: [String: VoiceContextReducer] = [:]
    private var records: [String: SessionRecord] = [:]
    private var directory = ""
    private var focused: String
    private var closed = false
    private var sink: (@Sendable (VoiceContextUpdate) async -> Void)?

    public init(account: AccountSession, sessionId: String) {
        self.account = account; focused = sessionId
        sending = account.sender; actions = account.actions
    }

    init(account: AccountSession, sessionId: String, sending: any ChatSending, actions: SessionActions) {
        self.account = account; focused = sessionId
        self.sending = sending; self.actions = actions
    }

    public func initial() async throws -> VoiceStart {
        let home = try account.store.homeSnapshot()
        let settings = AccountSettings(home.settings)
        records = Dictionary(home.sessions.map { ($0.id, $0) }, uniquingKeysWith: { _, value in value })
        directory = Self.directory(home.sessions)
        var iterator = account.chatFeed.snapshots(sessionId: focused).makeAsyncIterator()
        let snapshot = await iterator.next() ?? ChatSnapshot(sessionId: focused)
        let metadata = records[focused]?.metadata
        let history = snapshot.messages.suffix(50).compactMap(VoiceContextReducer.format).joined(separator: "\n\n")
        let context = "\(directory)\n\nCURRENT SESSION: \(focused)\nProject: \(metadata?["path"]?.stringValue ?? "")\nSummary: \(metadata?["summary"]?["text"]?.stringValue ?? "")\n\n\(history)"
        let custom = settings.bool("voiceBypassToken") ? settings.string("voiceCustomAgentId") : nil
        return VoiceStart(sessionId: focused, context: context,
                          language: VoiceLanguage.selection(settings.string("voiceAssistantLanguage")).providerCode,
                          customAgentId: custom.flatMap { $0.isEmpty ? nil : $0 })
    }

    public func start(sink: @escaping @Sendable (VoiceContextUpdate) async -> Void) {
        guard !closed, homeTask == nil else { return }
        self.sink = sink
        homeTask = Task { [weak self, account] in
            for await snapshot in account.homeFeed.snapshots() {
                guard !Task.isCancelled else { break }
                await self?.home(snapshot)
            }
        }
    }

    public func focus(_ sessionId: String) async {
        guard sessionId != focused else { return }
        focused = sessionId
        watch(sessionId)
        await sink?(VoiceContextUpdate(context: "Session became focused: \(sessionId). Send the user's next instructions here unless asked otherwise."))
    }

    public func stop() {
        closed = true
        homeTask?.cancel(); homeTask = nil
        for task in chatTasks.values { task.cancel() }
        chatTasks.removeAll(); reducers.removeAll(); records.removeAll(); sink = nil
    }

    private func home(_ snapshot: HomeSnapshot) async {
        let next = Self.directory(snapshot.sessions)
        if next != directory {
            directory = next
            await sink?(VoiceContextUpdate(context: next))
        }
        let oldRecords = records
        records = Dictionary(snapshot.sessions.map { ($0.id, $0) }, uniquingKeysWith: { _, value in value })
        for record in snapshot.sessions where record.active || record.id == focused {
            watch(record.id)
            // ready events may be deliberately hidden by the chat reducer;
            // presence's thinking flip is the same completion signal.
            if oldRecords[record.id]?.thinking == true, !record.thinking, record.active,
               !record.hasPendingPermissionRequests {
                await sink?(VoiceContextUpdate(prompts: ["Coding agent done working in session: \(record.id). Report its summary to the human."]))
            }
        }
        let remaining = Set(snapshot.sessions.filter { $0.active || $0.id == focused }.map(\.id))
        for id in Array(chatTasks.keys) where !remaining.contains(id) { chatTasks.removeValue(forKey: id)?.cancel() }
    }

    private func watch(_ sessionId: String) {
        guard chatTasks[sessionId] == nil else { return }
        chatTasks[sessionId] = Task { [weak self, account] in
            for await snapshot in account.chatFeed.snapshots(sessionId: sessionId) {
                guard !Task.isCancelled else { break }
                await self?.chat(snapshot)
            }
        }
    }

    private func chat(_ snapshot: ChatSnapshot) async {
        var reducer = reducers[snapshot.sessionId] ?? VoiceContextReducer()
        let update = reducer.apply(snapshot)
        reducers[snapshot.sessionId] = reducer
        if !update.context.isEmpty || !update.prompts.isEmpty { await sink?(update) }
    }

    private static func directory(_ records: [SessionRecord]) -> String {
        "Available sessions:\n" + records.filter(\.active).sorted { $0.id < $1.id }.map {
            "- \($0.id): \($0.metadata?["summary"]?["text"]?.stringValue ?? "No summary")"
        }.joined(separator: "\n")
    }
}

public struct VoiceToolResult: Sendable, Equatable {
    public let text: String
    public let isError: Bool
    public init(_ text: String, isError: Bool = false) { self.text = text; self.isError = isError }
}

extension VoiceContext {
    /// Parameters are decoded at the boundary and permissions are looked up
    /// again immediately before execution, so stale requests cannot be approved.
    public func tool(name: String, parameters: Data) async -> VoiceToolResult {
        do {
            try Task.checkCancellation()
            guard !closed else { return VoiceToolResult("error (voice session ended)", isError: true) }
            switch name {
            case "sendMessageToSession":
                struct Parameters: Decodable { let sessionId: String; let message: String }
                let value = try JSONDecoder().decode(Parameters.self, from: parameters)
                guard !value.sessionId.isEmpty, !value.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      try account.store.session(id: value.sessionId) != nil else { return VoiceToolResult("error (invalid session or message)", isError: true) }
                _ = try await sending.send(OutgoingMessage(text: value.message, source: .voice), sessionId: value.sessionId)
                return VoiceToolResult("sent [DO NOT say anything else, simply say 'sent']")
            case "processPermissionRequest":
                struct Parameters: Decodable {
                    enum Decision: String, Decodable { case allow, deny }
                    let requestId: String; let decision: Decision
                }
                let value = try JSONDecoder().decode(Parameters.self, from: parameters)
                let matching = try account.store.sessions().filter { $0.agentState?["requests"]?[value.requestId]?.objectValue != nil }
                guard !value.requestId.isEmpty, matching.count == 1, let session = matching.first else {
                    return VoiceToolResult("error (permission request not found)", isError: true)
                }
                if value.decision == .allow { try await actions.allow(sessionId: session.id, permissionId: value.requestId) }
                else { try await actions.deny(sessionId: session.id, permissionId: value.requestId) }
                return VoiceToolResult("done [DO NOT say anything else, simply say 'done']")
            default: return VoiceToolResult("error (unknown client tool)", isError: true)
            }
        } catch { return VoiceToolResult("error (client tool failed)", isError: true) }
    }
}
