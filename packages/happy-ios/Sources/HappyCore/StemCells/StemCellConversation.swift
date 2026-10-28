import Foundation
import HappyWire

/// One entry in a Stem Cells conversation as the phone shows it: what a
/// person wrote, or what the agent said. Reasoning, tool calls and the
/// daemon's housekeeping are never shown; a tool call is kept only for the
/// pictures and videos it presented.
public struct StemCellChatItem: Equatable, Sendable, Identifiable {
    public enum Role: Equatable, Sendable {
        case user, agent
        /// Another agent reporting to this one (a collaborator, a subtask),
        /// not the one that manages it: one compact row naming the sender,
        /// opened to read what it said (happy-desktop's `agentMessage` activity).
        case collaborator(agentId: String, explanation: String?)
    }

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
        /// Pictures and videos an agent's tool presented, in `columns` (0:
        /// justified rows); read on demand.
        case gallery([StemCellMedia], columns: Int)
        /// A layout the agent wrote for media it showed: a presentation's
        /// `tree`, or a block in its text. The tree's item indexes are
        /// positions in `media`.
        case tree([StemCellMedia], StemCellMediaTree)
        /// A document or other file a tool presented, as a card that opens it.
        case file(StemCellMedia)
        /// An artifact a tool made or changed, as a card that opens it.
        case artifact(StemCellArtifact)
        /// A story a tool drafted (`draft_story`), by its ID: drawn as the
        /// story itself, following it live.
        case story(String)
        /// A sidebar Prioritizing proposed (a `sidebar_proposal` artifact),
        /// drawn by the sidebar's own rows and answered where it stands.
        case sidebarProposal(artifactId: String)
    }

    public var id: String
    public var role: Role
    public var pieces: [Piece]
    public var delivery: Delivery

    public init(id: String, role: Role, pieces: [Piece], delivery: Delivery) {
        self.id = id
        self.role = role
        self.pieces = pieces
        self.delivery = delivery
    }

    public var text: String {
        pieces.compactMap { if case .text(let text) = $0 { text } else { nil } }.joined(separator: "\n\n")
    }

    /// The sidebar proposals it shows, by artifact ID.
    public var proposalIds: [String] {
        pieces.compactMap { if case .sidebarProposal(let artifactId) = $0 { artifactId } else { nil } }
    }
}

/// One picture or video a tool call presented: its bytes are
/// `GET /v0/agents/:agentId/tool-calls/:toolCallId/media/:index`.
public struct StemCellMedia: Equatable, Sendable {
    public var toolCallId: String
    public var index: Int
    public var item: AgentWire.MediaItem

    public init(toolCallId: String, index: Int, item: AgentWire.MediaItem) {
        self.toolCallId = toolCallId
        self.index = index
        self.item = item
    }

    public var isVideo: Bool { item.kind == "video" }
    /// A picture or recording; anything else is a document or file, and an
    /// unknown kind is a file.
    public var isVisual: Bool { item.kind == "image" || item.kind == "video" }

    /// What a screen knows it by.
    public var key: String { "tool/\(toolCallId)/\(index)" }

    /// The shape a thumbhash's header carries, width over height
    /// (`thumbHashToApproximateAspectRatio`); nil when there is none.
    public static func hashedRatio(_ thumbhash: String?) -> Double? {
        guard var base64 = thumbhash, !base64.isEmpty else { return nil }
        base64 = base64.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let hash = Data(base64Encoded: base64).map(Array.init), hash.count >= 5 else { return nil }
        let header = Int(hash[3])
        let hasAlpha = hash[2] & 0x80 != 0
        let isLandscape = hash[4] & 0x80 != 0
        let lx = isLandscape ? (hasAlpha ? 5 : 7) : header & 7
        let ly = isLandscape ? header & 7 : (hasAlpha ? 5 : 7)
        guard lx > 0, ly > 0 else { return nil }
        return Double(lx) / Double(ly)
    }
}

/// An artifact a call created, changed or took up (`artifact`
/// presentation): `shows` `latest` follows it, else it is exactly `version`.
public struct StemCellArtifact: Equatable, Sendable {
    public var id: String
    public var version: Int
    public var type: String
    public var title: String
    public var followsLatest: Bool
    /// A reference named this version: it opens that one, never the latest.
    public var pinned = false

    public init(id: String, version: Int, type: String, title: String, followsLatest: Bool) {
        self.id = id
        self.version = version
        self.type = type
        self.title = title
        self.followsLatest = followsLatest
    }

    /// Desktop's card follows the artifact from the call that created it,
    /// whose files are written after it.
    public var opensLatest: Bool { followsLatest || (version == 1 && !pinned) }
}

/// What desktop's working line reports (`AgentWorkingStatus`), projected
/// as its chat store projects it (`workingPhaseProject`,
/// `workingLabelProject`, `activityOf`): a question waiting on the person
/// first, then delegated work, a scheduled wait, a retry, a model that has
/// not answered yet, and otherwise the agent's own status.
public struct StemCellActivity: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case waitingForModel
        case thinking
        case preparingTools
        case runningTools
        case working
        case retrying(AgentWire.AgentRetrying)
        case waiting(AgentWire.AgentWait)
        case awaitingAnswer
        case delegating
    }

    public var phase: Phase
    /// Unix milliseconds the turn began; nil where no clock is shown.
    public var startedAt: Double?

    public init(phase: Phase, startedAt: Double?) {
        self.phase = phase
        self.startedAt = startedAt
    }

    /// The projection itself, from the agent's state and the turn's.
    /// `produced` is whether the running turn has shown anything yet.
    public static func project(working: Bool, status: String, wait: AgentWire.AgentWait?, retrying: AgentWire.AgentRetrying?, question: Bool, subagentsRunning: Int, produced: Bool, startedAt: Double?) -> StemCellActivity? {
        if question { return StemCellActivity(phase: .awaitingAnswer, startedAt: nil) }
        guard working else {
            return subagentsRunning > 0 ? StemCellActivity(phase: .delegating, startedAt: nil) : nil
        }
        let phase: Phase
        if let wait { phase = .waiting(wait) }
        else if let retrying { phase = .retrying(retrying) }
        else if !produced, ["idle", "queued", "thinking"].contains(status) { phase = .waitingForModel }
        else {
            phase = switch status {
            case "thinking": .thinking
            case "generating_tools": .preparingTools
            case "running_tools": .runningTools
            default: .working
            }
        }
        return StemCellActivity(phase: phase, startedAt: startedAt)
    }
}

public struct StemCellChatSnapshot: Equatable, Sendable {
    /// History has been read, or there is none to read yet.
    public var loaded = false
    public var items: [StemCellChatItem] = []
    /// The agent is at work on a run.
    public var working = false
    /// The working line; nil when there is nothing to report.
    public var activity: StemCellActivity?
    /// Older runs exist before the first one shown.
    public var hasMore = false
    /// The agents this one spawned, by ID, as titled (a sender a
    /// collaborator row names when the sidebar doesn't hold it).
    public var subagentTitles: [String: String] = [:]
    /// Why the conversation could not be read.
    public var error: String?
    /// The model, account and effort the next message goes with: the last
    /// one sent, a pick, or the computer's default.
    public var mode: AgentWire.Mode?
    /// The composer's draft, and a count that moves only when it came from
    /// elsewhere (the computer, the person's other device, or this phone's
    /// kept copy): the screen sets the composer then, and never has its
    /// own typing echoed back.
    public var draft = ""
    public var draftArrivals = 0
    /// When `draft` was written (ms since 1970): a draft from elsewhere
    /// older than what is being typed here isn't shown over it.
    public var draftUpdatedAt: Double = 0
    /// The person's steering at the end of `items` that the running turn
    /// hasn't taken yet: desktop draws it under the working line, as next
    /// in the queue, until the agent takes it up.
    public var queued = 0

    public init() {}
}

/// One conversation over the paired computer's API: its history, read by
/// run, and the store's events applied on top (`message.*`, `run.*`,
/// `agent.updated`), all off the main thread. Sends are drawn at once and
/// confirmed by their own `message.created` echo, by ID.
public actor StemCellConversation {
    private let client: DirectAgentClient
    private let store: StemCellsStore
    private let persistence: DirectSyncEngine?
    private var keeping: Task<Void, Never>?
    private var delivering: [String: Task<Void, Never>] = [:]
    private var conversationDirty = false
    private var deliveryWatch: Task<Void, Never>?
    private var outgoingModes: [String: AgentWire.Mode] = [:]
    private var lastKept: KeptConversation?
    private struct KeptConversation: Codable, Equatable, Sendable {
        struct Run: Codable, Equatable, Sendable { var id: String; var messageIds: [String] }
        struct Picture: Codable, Equatable, Sendable { var mimeType: String; var data: Data }
        struct Send: Codable, Equatable, Sendable {
            var id: String; var text: String; var pictures: [Picture]; var accepted: Bool; var failure: String?; var mode: AgentWire.Mode?
        }
        var runs: [Run]
        var messages: [String: AgentWire.Message]
        var pending: [String]
        var outgoing: [Send]
        var mode: AgentWire.Mode?
        var hasMore: Bool
    }
    private var agentId: String
    private let continuation: AsyncStream<StemCellChatSnapshot>.Continuation
    public nonisolated let updates: AsyncStream<StemCellChatSnapshot>

    private var snapshot = StemCellChatSnapshot()
    private var following: Task<Void, Never>?
    /// The agents this one spawns or retitles while it is open.
    private var children: Task<Void, Never>?
    private var reading: Task<Void, Never>?
    private var reloadSoon: Task<Void, Never>?
    /// Events that came while history was being read, applied after it.
    private var heldEvents: [JSONValue]?
    /// Subagents made or retitled while history was being read, applied over
    /// the bootstrap's list.
    private var heldChildren: [JSONValue] = []

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
    /// A mode the person chose here; what the daemon last ran with never
    /// replaces it.
    private var picked: AgentWire.Mode?
    private var defaultMode: Task<AgentWire.Mode, Error>?
    /// The agent's own state, for the working line.
    private var status = "idle"
    private var wait: AgentWire.AgentWait?
    private var retrying: AgentWire.AgentRetrying?
    private var question = false
    private var subagentsRunning = 0
    /// The agent that manages this one: its messages are dialogue, never a collaborator's row.
    private var parentAgentId: String?
    /// The running turn and when it began (or when a send was taken, before
    /// its run is known).
    private var activeRun: (id: String?, startedAt: Double?)?
    /// New work the daemon may not have made yet; sends wait for it.
    private var creation: Task<String, Error>?
    private var visible = false

    /// The draft as desktop keeps it (`connectHappyAgent` `setDraft`): this
    /// phone's copy first, saved to the computer 300 ms after the last
    /// keystroke (a clear at once), last write wins by `updatedAt` across
    /// the person's devices, and `agent.draft.updated` brings theirs.
    private var drafts: StemCellDrafts?
    private var draft = StemCellDraft(text: "", updatedAt: 0, synced: true)
    /// Moves with every draft taken or typed: a save answered after it is stale.
    private var draftRevision = 0
    private var draftSave: Task<Void, Never>?
    /// The newest keystroke's stamp, so one arriving out of order is dropped.
    private var lastDraftEdit: Double = 0
    static let draftDebounce: Duration = .milliseconds(300)

    public init(client: DirectAgentClient, store: StemCellsStore, agentId: String, creation: Task<String, Error>? = nil, mode: AgentWire.Mode? = nil, persistence: DirectSyncEngine? = nil) {
        self.client = client
        self.store = store
        self.persistence = persistence
        self.agentId = agentId
        self.creation = creation
        (updates, continuation) = AsyncStream.makeStream(of: StemCellChatSnapshot.self, bufferingPolicy: .bufferingNewest(1))
        picked = mode
        self.mode = mode
        snapshot.mode = mode
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
                guard let id = try? await creation.value, !Task.isCancelled else { return }
                await self.created(id)
            }
            return
        }
        following = Task {
            await restoreConversation()
            guard !Task.isCancelled else { return }
            await self.follow()
        }
    }

    public func stop() async {
        following?.cancel(); following = nil
        children?.cancel(); children = nil
        reading?.cancel(); reading = nil
        reloadSoon?.cancel(); reloadSoon = nil
        deliveryWatch?.cancel(); deliveryWatch = nil
        let sends = Array(delivering.values)
        sends.forEach { $0.cancel() }
        for send in sends { await send.value }
        _ = await saveConversationNow()
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
        // Typed while the daemon made it: newer than the draft it was made
        // with, which would otherwise take its place on the first read.
        if !draft.synced {
            draft.updatedAt = Self.stamp(after: draft.updatedAt)
            snapshot.draftUpdatedAt = draft.updatedAt
            draftRevision += 1
            saveDraftSoon(after: .zero)
        }
        await follow()
    }

    private func follow() async {
        if let persistence {
            let deliveryEvents = await persistence.deliveryEvents(for: agentId)
            deliveryWatch?.cancel()
            deliveryWatch = Task {
                for await event in deliveryEvents {
                    guard !Task.isCancelled else { return }
                    switch event {
                    case .accepted(let id): sent(id)
                    case .failed(let id, let reason): failed(id, reason)
                    }
                }
            }
            for queued in (try? await persistence.queuedMessages(for: agentId)) ?? [] {
                let copy = (queued.id, queued.text, queued.pictures.map { (mimeType: $0.mimeType, data: $0.data) }, false, queued.failure)
                if let index = outgoing.firstIndex(where: { $0.id == queued.id }) { outgoing[index] = copy }
                else { outgoing.append(copy) }
                outgoingModes[queued.id] = queued.mode
            }
        }
        let events = await store.conversationEvents(agentId)
        let spawned = await store.events(matching: ["agent.created", "agent.updated"])
        // Stopped while those were asked for: nothing is followed.
        if Task.isCancelled { return }
        children?.cancel()
        children = Task { [weak self] in
            for await event in spawned {
                guard let self, !Task.isCancelled else { return }
                guard case .event(let envelope) = event else { continue }
                await child(envelope)
            }
        }
        heldEvents = []
        reload()
        for send in outgoing where !send.accepted && send.failure == nil { deliver(send.id) }
        for await event in events {
            if Task.isCancelled { return }
            switch event {
            case .resync:
                reload()
                for send in outgoing where !send.accepted && send.failure == nil { deliver(send.id) }
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
        mode = picked ?? start.mode ?? mode
        snapshot.mode = mode
        if let draft = start.draft { adoptDraft(draft, publishes: false) }
        if mode == nil, defaultMode == nil { defaultMode = Task { [client] in try await client.defaultMode() } }
        // A newest-page refresh is not a deletion of older pages already
        // downloaded. Retain them until a complete history says otherwise.
        let refreshed = Set(history.runs.map(\.id))
        if persistence != nil && history.hasMore {
            runs.removeAll { refreshed.contains($0.id) }
            let retained = Set(runs.flatMap(\.messageIds))
            messages = messages.filter { retained.contains($0.key) }
        } else {
            runs = []
            messages = [:]
        }
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
        // A send taken before the daemon started its run keeps the line
        // and the send's clock until the run's own events come.
        let awaiting = activeRun != nil && activeRun?.id == nil && (outgoing.contains { $0.accepted } || !pending.isEmpty)
        snapshot.working = start.agent.isWorking || awaiting
        adoptAgent(start.agent)
        if start.agent.isWorking, let run = history.runs.last, run.status == "running" {
            activeRun = (run.id, run.startedAt)
        } else if !awaiting {
            activeRun = nil
        }
        snapshot.hasMore = history.hasMore
        if let subagents = start.subagents {
            // desktop's `projectSubagents`: an untitled child is "Subagent".
            snapshot.subagentTitles = Dictionary(subagents.map { ($0.id, $0.title ?? "") }, uniquingKeysWith: { first, _ in first })
        }
        snapshot.loaded = true
        snapshot.error = nil
        let held = heldEvents ?? []
        heldEvents = nil
        for event in held { receive(event, publishes: false) }
        let early = heldChildren
        heldChildren = []
        for event in early { child(event, publishes: false) }
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
            activeRun = (runId, payload["run"]?["startedAt"]?.numberValue)
        case "run.boundary":
            guard let runId = payload["startedRun"]?["id"]?.stringValue else { return }
            accept(payload["acceptedMessageIds"]?.arrayValue?.compactMap(\.stringValue) ?? [], into: runId)
            snapshot.working = true
            activeRun = (runId, payload["startedRun"]?["startedAt"]?.numberValue)
        case "run.finished":
            snapshot.working = false
            settle()
            if visible { markRead() }
        case "agent.updated":
            guard let changes = payload["changes"] else { return }
            if let status = changes["status"]?.stringValue {
                self.status = status
                snapshot.working = status != "idle"
                if status == "idle" { settle() }
            }
            // Present and null clears; absent leaves it.
            if let value = changes["wait"] { wait = value == .null ? nil : Self.decode(AgentWire.AgentWait.self, value) }
            if let value = changes["retrying"] { retrying = value == .null ? nil : Self.decode(AgentWire.AgentRetrying.self, value) }
            if let value = changes["pendingQuestionId"] { question = value.stringValue != nil }
            if let running = changes["subagents"]?["running"]?.numberValue { subagentsRunning = Int(running) }
        case "agent.draft.updated":
            guard let draft = payload["draft"].flatMap({ Self.decode(AgentWire.Draft.self, $0) }) else { return }
            adoptDraft(draft, publishes: false)
        default:
            return
        }
        if publishes { publish() }
    }

    /// A subagent of this one made or retitled: what its references and
    /// its messages are called by, without reading the conversation again.
    private func child(_ event: JSONValue, publishes: Bool = true) {
        // Mid-read, the bootstrap's list would replace it: it waits for it.
        if heldEvents != nil { return heldChildren.append(event) }
        let payload = event["payload"] ?? .null
        switch event["type"]?.stringValue {
        case "agent.created":
            guard let agent = payload["agent"], agent["parentAgentId"]?.stringValue == agentId, let id = agent["id"]?.stringValue else { return }
            snapshot.subagentTitles[id] = agent["title"]?.stringValue ?? ""
        case "agent.updated":
            guard let id = payload["agentId"]?.stringValue, snapshot.subagentTitles[id] != nil,
                  let title = payload["changes"]?["title"] else { return }
            snapshot.subagentTitles[id] = title.stringValue ?? ""
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
    public func send(id: String = ClientID.make(), text: String, pictures: [(mimeType: String, data: Data)] = []) async {
        guard !outgoing.contains(where: { $0.id == id }), messages[id] == nil else { return }
        outgoing.append((id, text, pictures, false, nil))
        outgoingModes[id] = mode
        guard await saveConversationNow() else {
            failed(id, "Could not save this message on this device. Retry when storage is available.")
            return
        }
        if let persistence, creation == nil {
            do { try await persistence.enqueueMessage(queuedMessage(id: id, text: text, pictures: pictures)) }
            catch { failed(id, "Could not save this message on this device."); return }
            publish()
            return
        }
        publish()
        deliver(id)
    }

    public func retry(_ id: String) {
        guard let index = outgoing.firstIndex(where: { $0.id == id }), outgoing[index].failure != nil else { return }
        outgoing[index].failure = nil
        publish()
        if let persistence {
            let send = outgoing[index]
            let payload = queuedMessage(id: id, text: send.text, pictures: send.pictures)
            Task {
                guard await saveConversationNow() else { failed(id, "Could not save this message on this device."); return }
                do {
                    try await persistence.enqueueMessage(payload)
                    try await persistence.retryMessage(id)
                } catch { failed(id, "Could not save this message on this device.") }
            }
            return
        }
        deliver(id)
    }

    private func deliver(_ id: String) {
        guard delivering[id] == nil else { return }
        let client = client
        delivering[id] = Task {
            defer { delivering.removeValue(forKey: id) }
            do {
                if let persistence, !(await persistence.deliveryAllowed) { return }
                guard await saveConversationNow() else { failed(id, "Could not save this message on this device."); return }
                // New work: its conversation exists once the daemon has made it,
                // under the ID the daemon gave it.
                if let creation { agentId = try await creation.value }
                if let persistence, !(await persistence.deliveryAllowed) { return }
                guard let outgoingIndex = outgoing.firstIndex(where: { $0.id == id }) else { return }
                let send = outgoing[outgoingIndex]
                if let persistence {
                    try await persistence.enqueueMessage(queuedMessage(id: id, text: send.text, pictures: send.pictures))
                    return
                }
                let mode: AgentWire.Mode
                if let selected = outgoingModes[id] { mode = selected }
                else {
                    mode = try await sendingMode(); outgoingModes[id] = mode
                    guard await saveConversationNow() else { failed(id, "Could not save this message on this device."); return }
                }
                // The same ID again is the same message: a retry never doubles it.
                var attempt = 0
                while true {
                    try Task.checkCancellation()
                    if let persistence, !(await persistence.deliveryAllowed) { return }
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
                if persistence != nil, !(error is DirectAgentError) || (error as? DirectAgentError)?.status.map({ $0 >= 500 }) == true {
                    // Offline sends stay queued and resume on the account's
                    // next resync, with the same daemon message ID.
                    publish()
                } else { failed(id, StemCellsStore.describe(error)) }
            }
        }
    }

    private func queuedMessage(id: String, text: String, pictures: [(mimeType: String, data: Data)]) -> DirectQueuedMessage {
        DirectQueuedMessage(id: id, agentID: agentId, text: text, pictures: pictures.map { .init(mimeType: $0.mimeType, data: $0.data) }, mode: outgoingModes[id])
    }

    private func restoreConversation() async {
        guard let persistence, let value = try? await persistence.cachedResource("conversation:\(agentId)"),
              let kept = try? JSONDecoder().decode(KeptConversation.self, from: JSONEncoder().encode(value)) else { return }
        runs = kept.runs.map { ($0.id, $0.messageIds) }
        messages = kept.messages
        pending = kept.pending
        outgoing = kept.outgoing.map { ($0.id, $0.text, $0.pictures.map { ($0.mimeType, $0.data) }, $0.accepted, $0.failure) }
        outgoingModes = Dictionary(kept.outgoing.compactMap { send in send.mode.map { (send.id, $0) } }, uniquingKeysWith: { first, _ in first })
        mode = picked ?? kept.mode
        snapshot.mode = mode
        snapshot.hasMore = kept.hasMore
        snapshot.loaded = true
        lastKept = kept
        publish()
    }

    private func keepConversation() {
        conversationDirty = true
        guard persistence != nil, keeping == nil else { return }
        keeping = Task {
            while conversationDirty {
                do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
                conversationDirty = false
                _ = await persistConversation()
            }
            keeping = nil
        }
    }

    private func saveConversationNow() async -> Bool {
        keeping?.cancel()
        await keeping?.value
        keeping = nil
        conversationDirty = false
        let saved = await persistConversation()
        if conversationDirty { keepConversation() }
        return saved
    }

    private func persistConversation() async -> Bool {
        guard let persistence, snapshot.loaded || !outgoing.isEmpty else { return true }
        let kept = KeptConversation(runs: runs.map { .init(id: $0.id, messageIds: $0.messageIds) }, messages: messages, pending: pending,
            outgoing: outgoing.map { .init(id: $0.id, text: $0.text, pictures: $0.pictures.map { .init(mimeType: $0.mimeType, data: $0.data) }, accepted: $0.accepted, failure: $0.failure, mode: outgoingModes[$0.id]) }, mode: mode, hasMore: snapshot.hasMore)
        guard kept != lastKept else { return true }
        let key = "conversation:\(agentId)"
        do {
            let value = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(kept))
            try await persistence.keepResource(key, value: value)
            lastKept = kept
            return true
        } catch { snapshot.error = "Could not save this conversation on this device."; return false }
    }

    /// The next message goes with this model, account and effort.
    public func setMode(_ mode: AgentWire.Mode) {
        picked = mode
        self.mode = mode
        snapshot.mode = mode
        publish()
        // A draft is its text with the mode it goes with, empty or not
        // (desktop's `saveMode`): saved at once with this one.
        draft = StemCellDraft(text: draft.text, updatedAt: Self.stamp(after: draft.updatedAt), synced: false)
        snapshot.draftUpdatedAt = draft.updatedAt
        draftRevision += 1
        saveDraftSoon(after: .zero)
    }

    private func sendingMode() async throws -> AgentWire.Mode {
        if let mode { return mode }
        let task = defaultMode ?? Task { [client] in try await client.defaultMode() }
        defaultMode = task
        do {
            let mode = try await task.value
            // A pick made while the default was read wins.
            if let picked = self.mode { return picked }
            self.mode = mode
            if snapshot.mode == nil {
                snapshot.mode = mode
                publish()
            }
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
        // Until the run says when it began, the clock counts from the send.
        if activeRun == nil { activeRun = (nil, Date().timeIntervalSince1970 * 1000) }
        snapshot.working = true
        publish()
    }

    private func failed(_ id: String, _ reason: String) {
        guard let index = outgoing.firstIndex(where: { $0.id == id }) else { return }
        outgoing[index].failure = reason
        publish()
    }

    // MARK: Draft

    /// This phone's kept drafts: the one kept for this conversation shows
    /// at once, and goes to the computer if it never did.
    public func useDrafts(_ drafts: StemCellDrafts) async {
        self.drafts = drafts
        guard creation == nil, let kept = await drafts.draft(agentId), kept.updatedAt > draft.updatedAt else { return }
        draft = kept
        snapshot.draft = kept.text
        snapshot.draftUpdatedAt = kept.updatedAt
        snapshot.draftArrivals += 1
        publish()
        if !kept.synced { saveDraftSoon(after: .zero) }
    }

    /// Typed here, at `at` (ms since 1970, never going back): kept and
    /// saved after the keystrokes pause, a clear at once.
    public func setDraft(_ text: String, at: Double) {
        guard at > lastDraftEdit else { return }
        lastDraftEdit = at
        guard text != draft.text else { return }
        draft = StemCellDraft(text: text, updatedAt: max(at, draft.updatedAt + 1), synced: false)
        snapshot.draft = text
        snapshot.draftUpdatedAt = draft.updatedAt
        draftRevision += 1
        saveDraftSoon(after: text.isEmpty ? .zero : Self.draftDebounce)
    }

    /// The screen goes: what waits for the pause is saved now.
    public func flushDraft() {
        if !draft.synced { saveDraftSoon(after: .zero) }
    }

    private static func stamp(after previous: Double) -> Double {
        max((Date().timeIntervalSince1970 * 1000).rounded(), previous + 1)
    }

    private func saveDraftSoon(after delay: Duration) {
        draftSave?.cancel()
        let revision = draftRevision
        draftSave = Task {
            if delay > .zero {
                try? await Task.sleep(for: delay)
                if Task.isCancelled { return }
            }
            await saveDraft(revision)
        }
    }

    private func saveDraft(_ revision: Int) async {
        let local = draft
        do {
            // New work's draft is under the ID the daemon gives it.
            if let creation { agentId = try await creation.value }
            await drafts?.keep(agentId, local)
            // Cleared, it is still the mode the next message goes with.
            let value = AgentWire.DraftValue(text: local.text, mode: try await sendingMode())
            let saved = try await client.saveDraft(agentId, value: value, updatedAt: local.updatedAt, mutationId: ClientID.make())
            // Typed or taken meanwhile: that one is saved next.
            guard revision == draftRevision else { return }
            if (saved.updatedAt ?? 0) > local.updatedAt {
                // Written later on another device: it stands.
                adoptDraft(saved, publishes: true)
            } else {
                draft.synced = true
                await drafts?.keep(agentId, draft)
            }
        } catch {
            // Kept unsynced here: it goes on the next keystroke, opening or read.
        }
    }

    /// The computer's draft, from a read, an event or a save's answer: it
    /// replaces this phone's unless this phone's is newer, which goes up.
    private func adoptDraft(_ remote: AgentWire.Draft, publishes: Bool) {
        let stamp = remote.updatedAt ?? 0
        let text = remote.value?.text ?? ""
        // Older, or this phone's own coming back: this phone's stands, and
        // goes up with its own save.
        if stamp < draft.updatedAt || (stamp == draft.updatedAt && text == draft.text) {
            if stamp == draft.updatedAt { draft.synced = true }
            return
        }
        draftSave?.cancel()
        draftRevision += 1
        draft = StemCellDraft(text: text, updatedAt: stamp, synced: true)
        // Newer than anything picked here: its mode is the one now.
        if let mode = remote.value?.mode {
            if picked != nil { picked = mode }
            self.mode = mode
            snapshot.mode = mode
        }
        snapshot.draftUpdatedAt = stamp
        // Only new words are set in the composer; a mode alone isn't.
        if snapshot.draft != text {
            snapshot.draft = text
            snapshot.draftArrivals += 1
        }
        if creation == nil, let drafts {
            let agentId = agentId
            let kept = draft
            Task { await drafts.keep(agentId, kept) }
        }
        if publishes { publish() }
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

    /// `columns` as the presentation asks, or 0 for desktop's justified
    /// rows when it asks for none or for a layout the phone doesn't know.
    static func columns(_ layout: JSONValue?, count: Int) -> Int {
        if layout?["type"]?.stringValue == "columns", let columns = layout?["columns"]?.numberValue, columns == 1 || columns == 2 { return Int(columns) }
        return 0
    }

    /// An agent's text with its layout blocks as the trees they make of
    /// media shown earlier. A block that places nothing shown, or lost
    /// content to a limit, is the Markdown it is; one still arriving is held
    /// back until it closes.
    static func pieces(_ text: String, shown: [String: StemCellMedia], streaming: Bool) -> [StemCellChatItem.Piece] {
        var pieces: [StemCellChatItem.Piece] = []
        func markdown(_ text: String) {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            if case .text(let previous)? = pieces.last { pieces[pieces.count - 1] = .text(previous + "\n\n" + trimmed) } else { pieces.append(.text(trimmed)) }
        }
        // A reference tag still arriving is held back, not flashed as raw text.
        let text = streaming ? HappyReferences.droppingPartialTag(text) : text
        for segment in StemCellMediaBlocks.split(text) {
            switch segment {
            case .markdown(let text):
                markdown(text)
            case .layout(let layout):
                if !layout.complete {
                    if !streaming { markdown(layout.raw) }
                    continue
                }
                // Each `src` names one item; the same item twice is the same index.
                var media: [StemCellMedia] = []
                let parsed = StemCellMediaTree.parse(html: layout.raw) { source in
                    guard let found = shown[source] else { return nil }
                    if let index = media.firstIndex(where: { $0.key == found.key }) { return index }
                    media.append(found)
                    return media.count - 1
                }
                guard !parsed.placed.isEmpty, !parsed.truncated else { markdown(layout.raw); continue }
                pieces.append(.tree(media, parsed.tree))
            }
        }
        return pieces
    }

    private func publish() {
        keepConversation()
        var items: [StemCellChatItem] = []
        // What a layout block's `<img src>` can name: media shown earlier.
        var shown: [String: StemCellMedia] = [:]
        for run in runs {
            // The newest run while the agent works may end mid-block.
            let streaming = snapshot.working && run.id == runs.last?.id
            for id in run.messageIds {
                if let message = messages[id], let item = item(message, shown: &shown, streaming: streaming) { items.append(item) }
            }
        }
        for id in pending {
            if let message = messages[id], let item = item(message, shown: &shown, streaming: false) { items.append(item) }
        }
        for send in outgoing {
            var pieces: [StemCellChatItem.Piece] = send.text.isEmpty ? [] : [.text(send.text)]
            for (offset, picture) in send.pictures.enumerated() {
                pieces.append(.picture(id: "\(send.id):\(offset + 1)", mimeType: picture.mimeType, data: picture.data))
            }
            items.append(StemCellChatItem(id: send.id, role: .user, pieces: pieces, delivery: send.failure.map { .failed($0) } ?? (send.accepted ? .pending : .sending)))
        }
        snapshot.items = items
        // Only steering for a run already going: a send that starts one is
        // its first message, not next in line.
        var queued = 0
        if snapshot.working {
            for item in items.reversed() {
                guard item.role == .user, item.delivery == .pending || item.delivery == .sending else { break }
                queued += 1
            }
            // Before the run says it began, the first of them is what starts it.
            if activeRun?.id == nil { queued = max(0, queued - 1) }
        }
        snapshot.queued = queued
        snapshot.activity = StemCellActivity.project(
            working: snapshot.working, status: status, wait: wait, retrying: retrying, question: question,
            subagentsRunning: subagentsRunning, produced: produced, startedAt: activeRun?.startedAt
        )
        continuation.yield(snapshot)
    }

    /// The running turn has shown something of the agent's: a thought, a
    /// line, a tool call. What another agent sent it is work coming in, not
    /// its own.
    private var produced: Bool {
        guard let id = activeRun?.id, let run = runs.first(where: { $0.id == id }) else { return false }
        return run.messageIds.contains { id in
            messages[id].map { $0.role != "user" && !$0.content.isEmpty && ($0.metadata?.senderAgentId ?? agentId) == agentId } ?? false
        }
    }

    /// The turn is over: nothing of it carries into the next one.
    private func settle() {
        activeRun = nil
        status = "idle"
        wait = nil
        retrying = nil
    }

    private func adoptAgent(_ agent: AgentWire.Agent) {
        // A read says only working or idle; which kind of work is in the
        // events, so a read mid-turn keeps what they last said.
        if !(agent.status == "working" && status != "idle") { status = agent.status }
        wait = agent.wait
        retrying = agent.retrying
        question = agent.pendingQuestionId != nil
        subagentsRunning = agent.subagents?.running ?? 0
        if agent.id == agentId { parentAgentId = agent.parentAgentId }
    }

    /// The agent that sent `message`, when it is neither this one nor the
    /// one that manages it (desktop's `senderAgentOf`, relation "other"),
    /// and its one line on what it sent.
    static func collaborator(_ message: AgentWire.Message, agentId: String, parentAgentId: String?) -> (agentId: String, explanation: String?)? {
        guard let sender = message.metadata?.senderAgentId, sender != agentId, sender != parentAgentId else { return nil }
        let explanation = message.metadata?.senderAgentExplanation
        return (sender, explanation?.isEmpty == true ? nil : explanation)
    }

    /// What another agent said, without the line the daemon puts ahead of
    /// it for the receiving model (`inboundAgentText`): the row names the
    /// sender already.
    static func inboundText(_ text: String, agentId: String) -> String {
        let lead = "Message from agent \(agentId):"
        guard text.hasPrefix(lead) else { return text }
        return String(text.dropFirst(lead.count).drop(while: \.isWhitespace))
    }

    private static func decode<T: Decodable>(_ type: T.Type, _ value: JSONValue) -> T? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private func item(_ message: AgentWire.Message, shown: inout [String: StemCellMedia], streaming: Bool) -> StemCellChatItem? {
        if message.role == "user" || message.role == "agent", let sender = Self.collaborator(message, agentId: agentId, parentAgentId: parentAgentId) {
            // Its words as they came, read only when opened; desktop trims the
            // daemon's addressing line from an agent-role message alone.
            let text = message.content.compactMap { block -> String? in if case .text(let text) = block { text } else { nil } }.joined(separator: "\n")
            let body = message.role == "agent" ? Self.inboundText(text, agentId: sender.agentId) : text
            let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
            return StemCellChatItem(id: message.id, role: .collaborator(agentId: sender.agentId, explanation: sender.explanation), pieces: trimmed.isEmpty ? [] : [.text(trimmed)], delivery: .sent)
        }
        // The agent that manages this one gives it its work: desktop reads
        // that as dialogue, in the lane the person's own words take.
        let manager = message.role == "agent" ? message.metadata?.senderAgentId.flatMap { $0 == agentId ? nil : $0 } : nil
        let role: StemCellChatItem.Role
        switch message.role {
        case "user": role = .user
        case "agent": role = manager == nil ? .agent : .user
        default: return nil
        }
        var pieces: [StemCellChatItem.Piece] = []
        for (index, block) in message.content.enumerated() {
            switch block {
            case .text(let text):
                let trimmed = (manager.map { Self.inboundText(text, agentId: $0) } ?? text).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { continue }
                pieces += role == .agent ? Self.pieces(trimmed, shown: shown, streaming: streaming || message.status == "streaming") : [.text(trimmed)]
            case .image(let mimeType, let data):
                let key = "\(message.id):\(index)"
                if pictures[key] == nil { pictures[key] = Data(base64Encoded: data) }
                if let bytes = pictures[key] { pieces.append(.picture(id: key, mimeType: mimeType, data: bytes)) }
            case .toolCall(let id, _, _, let presentation):
                guard let presentation else { continue }
                if presentation.type == "artifact", let artifactId = presentation.artifactId, presentation.artifactType == "sidebar_proposal" {
                    // One card across every version: a revision redraws its rows.
                    if !pieces.contains(.sidebarProposal(artifactId: artifactId)) { pieces.append(.sidebarProposal(artifactId: artifactId)) }
                    continue
                }
                if presentation.type == "artifact", let artifactId = presentation.artifactId {
                    // Stories: a `story` artifact is the story, by its ID.
                    if presentation.artifactType == "story" {
                        pieces.append(.story(artifactId))
                        continue
                    }
                    pieces.append(.artifact(StemCellArtifact(
                        id: artifactId, version: presentation.version ?? 1, type: presentation.artifactType ?? "unknown",
                        title: presentation.title ?? "", followsLatest: presentation.shows == "latest"
                    )))
                    continue
                }
                guard presentation.type == "media" else { continue }
                let media = (presentation.items ?? []).enumerated().map { StemCellMedia(toolCallId: id, index: $0.offset, item: $0.element) }
                for one in media {
                    // Named by a later layout block, by either path; the latest wins.
                    if let source = one.item.source {
                        shown[source.path] = one
                        shown[source.absolutePath] = one
                    }
                }
                if let tree = StemCellMediaTree.decode(presentation.layout, itemCount: media.count) {
                    pieces.append(.tree(media, tree))
                    continue
                }
                let visual = media.filter(\.isVisual)
                if !visual.isEmpty { pieces.append(.gallery(visual, columns: Self.columns(presentation.layout, count: visual.count))) }
                for one in media where !one.isVisual { pieces.append(.file(one)) }
            case .reasoning, .unknown:
                continue
            }
        }
        guard !pieces.isEmpty else { return nil }
        return StemCellChatItem(id: message.id, role: role, pieces: pieces, delivery: role == .user && message.status == "pending" ? .pending : .sent)
    }
}
