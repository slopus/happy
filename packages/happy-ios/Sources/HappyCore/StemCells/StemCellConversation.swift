import Foundation
import HappyWire

/// One entry in a Stem Cells conversation as the phone shows it: what a
/// person wrote, or what the agent said. Reasoning, tool calls and the
/// daemon's housekeeping are never shown; a tool call is kept only for the
/// pictures and videos it presented.
public struct StemCellChatItem: Equatable, Sendable, Identifiable {
    public enum Role: Equatable, Sendable { case user, agent }

    public enum Delivery: Equatable, Sendable {
        case sent
        /// Not yet accepted by the daemon.
        case sending
        /// Accepted, waiting for the agent to take it up.
        case pending
        case failed(String)
    }

    public enum Piece: Equatable, Sendable {
        case text(String)
        /// A picture sent with a message, inline.
        case picture(id: String, mimeType: String, data: Data)
        /// A picture or video an agent's tool presented; read on demand.
        case media(toolCallId: String, index: Int, item: AgentWire.MediaItem)
    }

    public var id: String
    public var role: Role
    public var pieces: [Piece]
    public var delivery: Delivery

    public var text: String {
        pieces.compactMap { if case .text(let text) = $0 { text } else { nil } }.joined(separator: "\n\n")
    }
}

public struct StemCellChatSnapshot: Equatable, Sendable {
    /// History has been read, or there is none to read yet.
    public var loaded = false
    public var items: [StemCellChatItem] = []
    /// The agent is at work on a run.
    public var working = false
    /// Older runs exist before the first one shown.
    public var hasMore = false
    /// Why the conversation could not be read.
    public var error: String?

    public init() {}
}

/// One conversation over the paired computer's API: its history, read by
/// run, and the store's events applied on top (`message.*`, `run.*`,
/// `agent.updated`), all off the main thread. Sends are drawn at once and
/// confirmed by their own `message.created` echo, by ID.
public actor StemCellConversation {
    private let client: DirectAgentClient
    private let store: StemCellsStore
    private var agentId: String
    private let continuation: AsyncStream<StemCellChatSnapshot>.Continuation
    public nonisolated let updates: AsyncStream<StemCellChatSnapshot>

    private var snapshot = StemCellChatSnapshot()
    private var following: Task<Void, Never>?
    private var reading: Task<Void, Never>?
    private var reloadSoon: Task<Void, Never>?
    /// Events that came while history was being read, applied after it.
    private var heldEvents: [JSONValue]?

    private var runs: [(id: String, messageIds: [String])] = []
    private var messages: [String: AgentWire.Message] = [:]
    /// User messages the daemon holds that no run has taken yet, oldest first.
    private var pending: [String] = []
    /// Sends the daemon has not echoed yet, oldest first. One it accepted
    /// stays here until history or an event carries it, so no read that
    /// began before the send can take it off the screen.
    private var outgoing: [(id: String, text: String, pictures: [(mimeType: String, data: Data)], accepted: Bool, failure: String?)] = []
    /// Pictures already decoded, by message and block.
    private var pictures: [String: Data] = [:]
    private var mode: AgentWire.Mode?
    private var defaultMode: Task<AgentWire.Mode, Error>?
    /// New work the daemon may not have made yet; sends wait for it.
    private var creation: Task<String, Error>?
    private var visible = false

    public init(client: DirectAgentClient, store: StemCellsStore, agentId: String, creation: Task<String, Error>? = nil) {
        self.client = client
        self.store = store
        self.agentId = agentId
        self.creation = creation
        (updates, continuation) = AsyncStream.makeStream(of: StemCellChatSnapshot.self, bufferingPolicy: .bufferingNewest(1))
    }

    // MARK: Life

    public func start() {
        guard following == nil else { return }
        if let creation {
            // New work has nothing to read yet: it is shown at once, empty.
            snapshot.loaded = true
            publish()
            defaultMode = Task { [client] in try await client.defaultMode() }
            following = Task {
                guard let id = try? await creation.value else { return }
                await self.created(id)
            }
            return
        }
        following = Task { await self.follow() }
    }

    public func stop() {
        following?.cancel(); following = nil
        reading?.cancel(); reading = nil
        reloadSoon?.cancel(); reloadSoon = nil
        continuation.finish()
    }

    /// The conversation is on screen: what arrives is read.
    public func setVisible(_ visible: Bool) {
        self.visible = visible
        if visible, !runs.isEmpty { markRead() }
    }

    private func created(_ id: String) async {
        creation = nil
        agentId = id
        await follow()
    }

    private func follow() async {
        let events = await store.conversationEvents(agentId)
        heldEvents = []
        reload()
        for await event in events {
            if Task.isCancelled { return }
            switch event {
            case .resync: reload()
            case .event(let envelope):
                if heldEvents != nil { heldEvents?.append(envelope) } else { receive(envelope) }
            }
        }
    }

    // MARK: Reads

    /// The newest runs and what is pending, read whole; events that arrive
    /// meanwhile are applied after.
    private func reload() {
        reading?.cancel()
        if heldEvents == nil { heldEvents = [] }
        let client = client
        let agentId = agentId
        reading = Task {
            do {
                async let bootstrap = client.bootstrap(agentId)
                async let page = client.messages(agentId)
                let (start, history) = try await (bootstrap, page)
                if Task.isCancelled { return }
                adopt(start, history)
            } catch {
                if Task.isCancelled { return }
                snapshot.error = StemCellsStore.describe(error)
                snapshot.loaded = true
                let held = heldEvents ?? []
                heldEvents = nil
                for event in held { receive(event, publishes: false) }
                publish()
            }
        }
    }

    private func adopt(_ start: AgentWire.Bootstrap, _ history: AgentWire.MessagesResponse) {
        mode = start.mode ?? mode
        if mode == nil, defaultMode == nil { defaultMode = Task { [client] in try await client.defaultMode() } }
        runs = []
        messages = [:]
        pending = []
        for run in history.runs {
            runs.append((run.id, (run.messages ?? []).map(\.id)))
            for message in run.messages ?? [] { messages[message.id] = message }
        }
        for message in start.pending ?? [] {
            messages[message.id] = message
            pending.append(message.id)
        }
        let echoed = Set(messages.keys)
        outgoing.removeAll { echoed.contains($0.id) }
        snapshot.working = start.agent.isWorking
        snapshot.hasMore = history.hasMore
        snapshot.loaded = true
        snapshot.error = nil
        let held = heldEvents ?? []
        heldEvents = nil
        for event in held { receive(event, publishes: false) }
        publish()
        if visible { markRead() }
    }

    /// Runs older than the first one shown.
    public func loadOlder() async {
        guard snapshot.hasMore, heldEvents == nil, let first = runs.first?.id else { return }
        do {
            let page = try await client.messages(agentId, before: first)
            guard runs.first?.id == first else { return }
            let known = Set(runs.map(\.id))
            let older = page.runs.filter { !known.contains($0.id) }
            runs.insert(contentsOf: older.map { ($0.id, ($0.messages ?? []).map(\.id)) }, at: 0)
            for run in older { for message in run.messages ?? [] { messages[message.id] = message } }
            snapshot.hasMore = page.hasMore
            publish()
        } catch {}
    }

    /// History disagreed with an event: read it again, once things settle.
    private func reconcile() {
        reloadSoon?.cancel()
        reloadSoon = Task {
            try? await Task.sleep(for: .milliseconds(300))
            if Task.isCancelled { return }
            reload()
        }
    }

    // MARK: Events

    private func receive(_ event: JSONValue, publishes: Bool = true) {
        guard let type = event["type"]?.stringValue else { return }
        let payload = event["payload"] ?? .null
        switch type {
        case "message.created", "message.updated":
            guard let message = payload["message"].flatMap(Self.decodeMessage) else { return }
            messages[message.id] = message
            outgoing.removeAll { $0.id == message.id }
            if let runId = payload["runId"]?.stringValue {
                place(message.id, in: runId)
            } else if !pending.contains(message.id), !runs.contains(where: { $0.messageIds.contains(message.id) }) {
                pending.append(message.id)
            }
        case "message.delta":
            guard let id = payload["messageId"]?.stringValue, let index = payload["blockIndex"]?.numberValue,
                  let offset = payload["offset"]?.numberValue, let append = payload["append"]?.stringValue else { return }
            guard let message = messages[id], let grown = Self.grow(message, block: Int(index), offset: Int(offset), append: append) else {
                reconcile()
                return
            }
            messages[id] = grown
            if let runId = payload["runId"]?.stringValue { place(id, in: runId) }
        case "message.deleted":
            guard let id = payload["messageId"]?.stringValue else { return }
            messages.removeValue(forKey: id)
            pending.removeAll { $0 == id }
            for index in runs.indices { runs[index].messageIds.removeAll { $0 == id } }
        case "run.started":
            guard let runId = payload["run"]?["id"]?.stringValue else { return }
            accept(payload["acceptedMessageIds"]?.arrayValue?.compactMap(\.stringValue) ?? [], into: runId)
            snapshot.working = true
        case "run.boundary":
            guard let runId = payload["startedRun"]?["id"]?.stringValue else { return }
            accept(payload["acceptedMessageIds"]?.arrayValue?.compactMap(\.stringValue) ?? [], into: runId)
            snapshot.working = true
        case "run.finished":
            snapshot.working = false
            if visible { markRead() }
        case "agent.updated":
            if let status = payload["changes"]?["status"]?.stringValue { snapshot.working = status != "idle" }
        default:
            return
        }
        if publishes { publish() }
    }

    private func place(_ messageId: String, in runId: String) {
        pending.removeAll { $0 == messageId }
        if let index = runs.firstIndex(where: { $0.id == runId }) {
            if !runs[index].messageIds.contains(messageId) { runs[index].messageIds.append(messageId) }
        } else {
            runs.append((runId, [messageId]))
        }
    }

    private func accept(_ ids: [String], into runId: String) {
        if !runs.contains(where: { $0.id == runId }) { runs.append((runId, [])) }
        guard let index = runs.firstIndex(where: { $0.id == runId }) else { return }
        // The accepted messages open their run, in the order they were taken.
        let accepted = ids.filter { !runs[index].messageIds.contains($0) }
        runs[index].messageIds.insert(contentsOf: accepted, at: 0)
        pending.removeAll { ids.contains($0) }
        for id in ids { if var message = messages[id] { message.status = "accepted"; messages[id] = message } }
    }

    static func decodeMessage(_ value: JSONValue) -> AgentWire.Message? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONDecoder().decode(AgentWire.Message.self, from: data)
    }

    /// `message.delta` applied exactly as the API says, or nil where the
    /// message must be read again.
    static func grow(_ message: AgentWire.Message, block index: Int, offset: Int, append: String) -> AgentWire.Message? {
        var message = message
        guard message.content.indices.contains(index) else { return nil }
        let current: String
        switch message.content[index] {
        case .text(let text), .reasoning(let text): current = text
        default: return nil
        }
        let units = Array(current.utf16)
        let added = Array(append.utf16)
        guard units.count >= offset else { return nil }
        let after = Array(units[offset...])
        let grown: [UInt16]
        if after.isEmpty {
            grown = units + added
        } else if after.count >= added.count {
            guard Array(after.prefix(added.count)) == added else { return nil }
            return message
        } else {
            guard Array(added.prefix(after.count)) == after else { return nil }
            grown = units + added[after.count...]
        }
        let text = String(decoding: grown, as: UTF16.self)
        if case .reasoning = message.content[index] { message.content[index] = .reasoning(text) } else { message.content[index] = .text(text) }
        return message
    }

    // MARK: Sending

    /// Draws the message at once and sends it, after the new work it is in
    /// has been made.
    public func send(id: String = ClientID.make(), text: String, pictures: [(mimeType: String, data: Data)] = []) {
        outgoing.append((id, text, pictures, false, nil))
        publish()
        deliver(id)
    }

    public func retry(_ id: String) {
        guard let index = outgoing.firstIndex(where: { $0.id == id }), outgoing[index].failure != nil else { return }
        outgoing[index].failure = nil
        publish()
        deliver(id)
    }

    private func deliver(_ id: String) {
        let client = client
        Task {
            do {
                // New work: its conversation exists once the daemon has made it,
                // under the ID the daemon gave it.
                if let creation { agentId = try await creation.value }
                guard let outgoingIndex = outgoing.firstIndex(where: { $0.id == id }) else { return }
                let send = outgoing[outgoingIndex]
                let mode = try await sendingMode()
                // The same ID again is the same message: a retry never doubles it.
                var attempt = 0
                while true {
                    do {
                        try await client.sendMessage(agentId, id: id, text: send.text, images: send.pictures, mode: mode)
                        break
                    } catch let error as DirectAgentError where (error.status ?? 500) < 500 {
                        throw error
                    } catch {
                        attempt += 1
                        if attempt == 3 { throw error }
                        try await Task.sleep(for: .milliseconds(600 * attempt))
                    }
                }
                sent(id)
            } catch {
                failed(id, StemCellsStore.describe(error))
            }
        }
    }

    private func sendingMode() async throws -> AgentWire.Mode {
        if let mode { return mode }
        let task = defaultMode ?? Task { [client] in try await client.defaultMode() }
        defaultMode = task
        do {
            let mode = try await task.value
            self.mode = mode
            return mode
        } catch {
            defaultMode = nil
            throw error
        }
    }

    /// Accepted: it shows as waiting until its echo or its run arrives.
    private func sent(_ id: String) {
        guard let index = outgoing.firstIndex(where: { $0.id == id }) else { return }
        outgoing[index].accepted = true
        snapshot.working = true
        publish()
    }

    private func failed(_ id: String, _ reason: String) {
        guard let index = outgoing.firstIndex(where: { $0.id == id }) else { return }
        outgoing[index].failure = reason
        publish()
    }

    public func abort() async {
        try? await client.abort(agentId)
    }

    private func markRead() {
        let client = client
        let agentId = agentId
        Task { try? await client.markRead(agentId) }
    }

    // MARK: Snapshot

    private func publish() {
        var items: [StemCellChatItem] = []
        for run in runs {
            for id in run.messageIds {
                if let message = messages[id], let item = item(message) { items.append(item) }
            }
        }
        for id in pending {
            if let message = messages[id], let item = item(message) { items.append(item) }
        }
        for send in outgoing {
            var pieces: [StemCellChatItem.Piece] = send.text.isEmpty ? [] : [.text(send.text)]
            for (offset, picture) in send.pictures.enumerated() {
                pieces.append(.picture(id: "\(send.id):\(offset + 1)", mimeType: picture.mimeType, data: picture.data))
            }
            items.append(StemCellChatItem(id: send.id, role: .user, pieces: pieces, delivery: send.failure.map { .failed($0) } ?? (send.accepted ? .pending : .sending)))
        }
        snapshot.items = items
        continuation.yield(snapshot)
    }

    private func item(_ message: AgentWire.Message) -> StemCellChatItem? {
        let role: StemCellChatItem.Role
        switch message.role {
        case "user": role = .user
        case "agent": role = .agent
        default: return nil
        }
        var pieces: [StemCellChatItem.Piece] = []
        for (index, block) in message.content.enumerated() {
            switch block {
            case .text(let text):
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { pieces.append(.text(trimmed)) }
            case .image(let mimeType, let data):
                let key = "\(message.id):\(index)"
                if pictures[key] == nil { pictures[key] = Data(base64Encoded: data) }
                if let bytes = pictures[key] { pieces.append(.picture(id: key, mimeType: mimeType, data: bytes)) }
            case .toolCall(let id, _, _, let presentation):
                guard presentation?.type == "media" else { continue }
                for (offset, media) in (presentation?.items ?? []).enumerated() where media.kind == "image" || media.kind == "video" {
                    pieces.append(.media(toolCallId: id, index: offset, item: media))
                }
            case .reasoning, .unknown:
                continue
            }
        }
        guard !pieces.isEmpty else { return nil }
        return StemCellChatItem(id: message.id, role: role, pieces: pieces, delivery: role == .user && message.status == "pending" ? .pending : .sent)
    }
}
