#if (DEBUG || HAPPY_FIXTURES) && canImport(UIKit)
// The fixtures: in Debug, and in builds that ask for them (HAPPY_FIXTURES,
// the hosted tests in Preview). Never in the shipped app.
import Foundation
import HappyCore
import HappyStore
import HappyWire
import UIKit

// Debug-only stand-ins for the chat feed, the outbox and the session RPCs,
// so the chat can be exercised without a computer: push
// `.session(id: "fixture:<scenario>")` (FixtureScenarios.swift).
//
// Sending behaves like the outbox: the message appears at once as pending
// and queued, then sending, then accepted, then read by the agent, which
// streams a reply. A message containing "fail" fails to send, so retry and
// discard can be tried.

/// Holds every fixture chat and pushes snapshots to whoever watches one.
public actor FixtureChatWorld {
    public static let shared = FixtureChatWorld()

    struct Chat {
        var messages: [ChatMessage]
        var delivery: [String: OutboxDelivery] = [:]
        var subscribers: [UUID: AsyncStream<ChatSnapshot>.Continuation] = [:]
        var outgoing: [String: OutgoingMessage] = [:]
    }

    private var chats: [String: Chat] = [:]
    private var clock: Int64 = FixtureScenarios.now
    private var streams: [String: Task<Void, Never>] = [:]

    func subscribe(_ sessionId: String, id: UUID, continuation: AsyncStream<ChatSnapshot>.Continuation) {
        if chats[sessionId] == nil {
            let scenario = FixtureScenarios.scenario(for: sessionId)
            chats[sessionId] = Chat(messages: FixtureScenarios.messages(scenario, sessionId: sessionId))
            if scenario == .live { startLiveStream(sessionId) }
        }
        chats[sessionId]?.subscribers[id] = continuation
        continuation.yield(snapshot(sessionId))
    }

    func unsubscribe(_ sessionId: String, id: UUID) {
        chats[sessionId]?.subscribers[id] = nil
    }

    private func snapshot(_ sessionId: String) -> ChatSnapshot {
        let chat = chats[sessionId]
        return ChatSnapshot(sessionId: sessionId, messages: chat?.messages ?? [], delivery: chat?.delivery ?? [:], isLoaded: true)
    }

    private func publish(_ sessionId: String) {
        guard let chat = chats[sessionId] else { return }
        let snapshot = snapshot(sessionId)
        for continuation in chat.subscribers.values { continuation.yield(snapshot) }
    }

    private func tick() -> Int64 {
        clock += 1000
        return clock
    }

    private func update(_ sessionId: String, id: String, _ change: (inout ChatMessage) -> Void) {
        guard let index = chats[sessionId]?.messages.lastIndex(where: { $0.id == id }) else { return }
        change(&chats[sessionId]!.messages[index])
    }

    // MARK: Sending

    func send(_ message: OutgoingMessage, sessionId: String) -> String {
        let localId = "local-\(UUID().uuidString.prefix(8))"
        let createdAt = tick()
        var chat = chats[sessionId] ?? Chat(messages: [])
        chat.messages.append(.userText(UserTextMessage(
            id: localId, localId: localId, createdAt: createdAt, text: message.text, displayText: message.displayText,
            pending: true, sortAt: createdAt + ChatMessage.pendingSortOffset
        )))
        chat.delivery[localId] = .queued
        chat.outgoing[localId] = message
        chats[sessionId] = chat
        publish(sessionId)
        deliver(localId, sessionId: sessionId)
        return localId
    }

    func retry(localId: String) {
        guard let sessionId = chats.first(where: { $0.value.delivery[localId] != nil })?.key else { return }
        chats[sessionId]?.delivery[localId] = .queued
        publish(sessionId)
        deliver(localId, sessionId: sessionId, retrying: true)
    }

    func discard(localId: String) {
        guard let sessionId = chats.first(where: { $0.value.delivery[localId] != nil })?.key else { return }
        chats[sessionId]?.delivery[localId] = nil
        chats[sessionId]?.outgoing[localId] = nil
        chats[sessionId]?.messages.removeAll { $0.id == localId }
        publish(sessionId)
    }

    private func deliver(_ localId: String, sessionId: String, retrying: Bool = false) {
        Task {
            try? await Task.sleep(for: .milliseconds(400))
            self.setDelivery(localId, sessionId: sessionId, .sending)
            try? await Task.sleep(for: .milliseconds(700))
            let text = self.chats[sessionId]?.outgoing[localId]?.text ?? ""
            if text.localizedCaseInsensitiveContains("fail") && !retrying {
                self.setDelivery(localId, sessionId: sessionId, .failed("Network unavailable"))
                return
            }
            self.setDelivery(localId, sessionId: sessionId, nil)
            // On the server; the agent takes it into its context a moment later.
            try? await Task.sleep(for: .milliseconds(900))
            self.settle(localId, sessionId: sessionId)
            self.reply(to: text, sessionId: sessionId)
        }
    }

    private func setDelivery(_ localId: String, sessionId: String, _ delivery: OutboxDelivery?) {
        chats[sessionId]?.delivery[localId] = delivery
        publish(sessionId)
    }

    private func settle(_ localId: String, sessionId: String) {
        let at = tick()
        update(sessionId, id: localId) { message in
            guard case .userText(var user) = message else { return }
            user.pending = false
            user.sortAt = at
            message = .userText(user)
        }
        chats[sessionId]?.outgoing[localId] = nil
        // Settled messages sort by their new position.
        chats[sessionId]?.messages.sort { $0.sortKey < $1.sortKey }
        publish(sessionId)
    }

    // MARK: Streaming replies

    private func reply(to text: String, sessionId: String) {
        let turn = "turn-\(UUID().uuidString.prefix(6))"
        let answer = FixtureScenarios.reply(to: text)
        streams[sessionId]?.cancel()
        streams[sessionId] = Task {
            let toolId = "tool-\(UUID().uuidString.prefix(8))"
            let started = self.tick()
            self.append(.toolCall(ToolCallMessage(id: toolId, createdAt: started, turn: turn, tool: ToolCall(
                name: "Bash", state: .running,
                input: .object(["command": .string("rg -n \"ChatList\" packages"), "description": .string("Find the chat list")]),
                createdAt: started, startedAt: started
            ))), sessionId: sessionId)
            try? await Task.sleep(for: .milliseconds(1200))
            self.update(sessionId, id: toolId) { message in
                guard case .toolCall(var call) = message else { return }
                call.tool.state = .completed
                call.tool.completedAt = started + 1200
                call.tool.result = .string("packages/happy-app/sources/components/ChatList.tsx:42: export const ChatList")
                message = .toolCall(call)
            }
            self.publish(sessionId)
            await self.stream(answer, sessionId: sessionId, turn: turn)
        }
    }

    private func startLiveStream(_ sessionId: String) {
        streams[sessionId] = Task {
            try? await Task.sleep(for: .milliseconds(800))
            await self.stream(FixtureScenarios.liveAnswer, sessionId: sessionId, turn: "turn-live")
        }
    }

    /// Grows one agent message a few words at a time, the way a reply
    /// streams in.
    private func stream(_ text: String, sessionId: String, turn: String) async {
        let id = "agent-\(UUID().uuidString.prefix(8))"
        append(.agentText(AgentTextMessage(id: id, createdAt: tick(), turn: turn, text: "")), sessionId: sessionId)
        var shown = text.startIndex
        while shown < text.endIndex {
            if Task.isCancelled { return }
            try? await Task.sleep(for: .milliseconds(45))
            var next = shown
            for _ in 0..<Int.random(in: 6...18) where next < text.endIndex {
                next = text.index(after: next)
            }
            shown = next
            let prefix = String(text[..<shown])
            update(sessionId, id: id) { message in
                guard case .agentText(var agent) = message else { return }
                agent.text = prefix
                message = .agentText(agent)
            }
            publish(sessionId)
        }
    }

    private func append(_ message: ChatMessage, sessionId: String) {
        guard chats[sessionId] != nil else { return }
        // Before any pending message: those stay parked at the bottom.
        let index = chats[sessionId]!.messages.firstIndex { $0.sortKey >= ChatMessage.pendingSortOffset } ?? chats[sessionId]!.messages.endIndex
        chats[sessionId]!.messages.insert(message, at: index)
        publish(sessionId)
    }

    // MARK: Controls

    func resolvePermission(sessionId: String, permissionId: String, approved: Bool, mode: String? = nil, allowedTools: [String]? = nil, decision: ToolPermission.Decision?) {
        guard let index = chats[sessionId]?.messages.firstIndex(where: {
            if case .toolCall(let call) = $0 { return call.tool.permission?.id == permissionId }
            return false
        }), case .toolCall(var call) = chats[sessionId]!.messages[index] else { return }
        call.tool.permission?.status = approved ? .approved : .denied
        call.tool.permission?.decision = decision ?? (approved ? .approved : .denied)
        call.tool.permission?.mode = mode
        call.tool.permission?.allowedTools = allowedTools
        call.tool.state = approved ? .completed : .error
        call.tool.completedAt = tick()
        call.tool.result = .string(approved ? "Done." : "The user doesn't want to proceed with this tool use.")
        chats[sessionId]!.messages[index] = .toolCall(call)
        publish(sessionId)
    }

    func answer(sessionId: String, questionId: String, cancelled: Bool) {
        guard let index = chats[sessionId]?.messages.firstIndex(where: {
            if case .toolCall(let call) = $0 { return call.tool.callId == questionId || $0.id == questionId }
            return false
        }), case .toolCall(var call) = chats[sessionId]!.messages[index] else { return }
        call.tool.state = cancelled ? .error : .completed
        call.tool.completedAt = tick()
        chats[sessionId]!.messages[index] = .toolCall(call)
        publish(sessionId)
    }

    func abort(sessionId: String) {
        streams[sessionId]?.cancel()
        streams[sessionId] = nil
    }
}

public struct FixtureChatFeed: ChatFeed {
    let world: FixtureChatWorld

    public init(world: FixtureChatWorld) {
        self.world = world
    }

    public func snapshots(sessionId: String) -> AsyncStream<ChatSnapshot> {
        let world = self.world
        let id = UUID()
        return AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            continuation.onTermination = { _ in
                Task { await world.unsubscribe(sessionId, id: id) }
            }
            Task { await world.subscribe(sessionId, id: id, continuation: continuation) }
        }
    }
}

public struct FixtureChatSender: ChatSending {
    let world: FixtureChatWorld

    public init(world: FixtureChatWorld) {
        self.world = world
    }

    public func send(_ message: OutgoingMessage, sessionId: String) async throws -> String {
        await world.send(message, sessionId: sessionId)
    }

    public func retry(localId: String) async throws {
        await world.retry(localId: localId)
    }

    public func discard(localId: String) async throws {
        await world.discard(localId: localId)
    }
}

public struct FixtureChatControls: ChatControls {
    let world: FixtureChatWorld

    public init(world: FixtureChatWorld) {
        self.world = world
    }

    public func allow(sessionId: String, permissionId: String, mode: String?, allowedTools: [String]?, decision: ToolPermission.Decision?, updatedInput: JSONValue?) async throws {
        try await Task.sleep(for: .milliseconds(300))
        await world.resolvePermission(sessionId: sessionId, permissionId: permissionId, approved: true, mode: mode, allowedTools: allowedTools, decision: decision)
    }

    public func deny(sessionId: String, permissionId: String, mode: String?, allowedTools: [String]?, decision: ToolPermission.Decision?) async throws {
        try await Task.sleep(for: .milliseconds(300))
        await world.resolvePermission(sessionId: sessionId, permissionId: permissionId, approved: false, decision: decision)
    }

    public func answerQuestion(sessionId: String, id: String, answers: JSONValue, kind: String) async throws {
        try await Task.sleep(for: .milliseconds(300))
        await world.answer(sessionId: sessionId, questionId: id, cancelled: false)
    }

    public func cancelQuestion(sessionId: String, id: String, kind: String) async throws {
        await world.answer(sessionId: sessionId, questionId: id, cancelled: true)
    }

    public func abort(sessionId: String) async throws {
        await world.abort(sessionId: sessionId)
    }
}

/// The fixture chats' pictures, drawn on demand after a short wait so the
/// thumbhash shows first. `fixture-missing` never arrives.
enum FixtureAttachments {
    @Sendable static func data(_ ref: String) async throws -> Data {
        try await Task.sleep(for: .milliseconds(600))
        guard ref != "fixture-missing" else { throw URLError(.fileDoesNotExist) }
        let portrait = ref == "fixture-portrait"
        let size = portrait ? CGSize(width: 600, height: 1010) : CGSize(width: 1200, height: 675)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
            let colors = [UIColor(red: 0.05, green: 0, blue: 0.55, alpha: 1).cgColor, UIColor(red: 0.9, green: 0.78, blue: 0.29, alpha: 1).cgColor]
            guard let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 1]) else { return }
            context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
        }
        guard let data = image.pngData() else { throw URLError(.cannotDecodeContentData) }
        return data
    }
}

#endif
