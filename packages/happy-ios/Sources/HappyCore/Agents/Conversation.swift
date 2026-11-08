import Foundation
import HappyWire

/// One entry in a V2 conversation as the phone shows it: what a
/// person wrote, what the agent said, and the steps of its turns.
/// Reasoning and the daemon's housekeeping are never shown.
public struct ChatItem: Equatable, Sendable, Identifiable {
    public enum Role: Equatable, Sendable {
        case user, agent
        /// Another agent reporting to this one (a collaborator, a subtask),
        /// not the one that manages it: one compact row naming the sender,
        /// opened to read what it said (happy-desktop's `agentMessage` activity).
        case collaborator(agentId: String, explanation: String?)
        /// A turn that failed: desktop's failure card, its reason the item's
        /// text, with Retry or a switch to the composer's model.
        case failure(Failure)
        /// One tool call of the agent's turn (`Turns.swift`); what it showed
        /// the person (pictures, files, an artifact) is its pieces.
        case tool(Tool)
        /// How a finished turn ended: "Completed in 12s".
        case turnEnd(TurnEnd)
        /// A question the agent asked.
        case question(Ask)
        /// A finished turn's fold control, placed by `TurnFold`.
        case trace(Trace)
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
        /// A file sent with a message the computer hasn't taken yet, from
        /// its copy on this phone: a video's tile while it uploads.
        case sentFile(SentFile)
        /// Pictures and videos an agent's tool presented, in `columns` (0:
        /// justified rows); read on demand.
        case gallery([Media], columns: Int)
        /// A layout the agent wrote for media it showed: a presentation's
        /// `tree`, or a block in its text. The tree's item indexes are
        /// positions in `media`.
        case tree([Media], MediaTree)
        /// A document or other file a tool presented, as a card that opens it.
        case file(Media)
        /// An artifact a tool made or changed, as a card that opens it.
        case artifact(Artifact)
        /// A sidebar Prioritizing proposed (a `sidebar_proposal` artifact),
        /// drawn by the sidebar's own rows and answered where it stands.
        case sidebarProposal(artifactId: String)
    }

    /// A file of a message still on its way, by its piece's id
    /// (`UploadProgressBoard.fileKey`).
    public struct SentFile: Equatable, Sendable {
        public var id: String
        public var name: String
        public var mimeType: String
        public var file: URL
        public var width: Int?
        public var height: Int?

        public init(id: String, name: String, mimeType: String, file: URL, width: Int? = nil, height: Int? = nil) {
            self.id = id; self.name = name; self.mimeType = mimeType; self.file = file
            self.width = width; self.height = height
        }

        public var isVideo: Bool { mimeType.hasPrefix("video/") }
        /// A picture or video, drawn as a tile; anything else is named.
        public var isVisual: Bool { isVideo || mimeType.hasPrefix("image/") }
    }

    public var id: String { didSet { revision = 0 } }
    public var role: Role { didSet { revision = 0 } }
    public var pieces: [Piece] { didSet { revision = 0 } }
    public var delivery: Delivery { didSet { revision = 0 } }
    /// The run it belongs to, which `TurnFold` folds as one.
    public var turn: String? { didSet { revision = 0 } }
    /// When a person's message was written, in ms: the computer's time for
    /// one it holds, this phone's for one still on its way.
    public var time: Double? { didSet { revision = 0 } }
    /// Which making of the item this is (`Revision.next()`): two items
    /// stamped the same are the same, which a long conversation's rows are
    /// told by in one step rather than by comparing every word in them on
    /// every word that arrives. Zero for an item not stamped, or changed
    /// since (any change clears it): compared field by field.
    public private(set) var revision: UInt64 = 0
    /// On a team's computer, the member who wrote a person's message, by
    /// their user ID; nil for one still on its way and outside a team.
    public var author: String? { didSet { revision = 0 } }

    public init(id: String, role: Role, pieces: [Piece], delivery: Delivery, turn: String? = nil, time: Double? = nil, author: String? = nil) {
        self.id = id
        self.role = role
        self.pieces = pieces
        self.delivery = delivery
        self.turn = turn
        self.time = time
        self.author = author
    }

    /// This item stamped as a making of its own.
    public func stamped() -> ChatItem {
        var item = self
        item.revision = Revision.next()
        return item
    }

    /// This item changed by `change`, as the `variant`th way of making one
    /// from it: made again from the same making, the same way, it is the
    /// same making, though `change` reads nothing but the item. Such
    /// stamps have the top bit, which `Revision.next()` never reaches.
    public func derived(_ variant: UInt8, _ change: (inout ChatItem) -> Void) -> ChatItem {
        var item = self
        change(&item)
        if revision != 0, revision < 1 << 55 { item.revision = 1 << 63 | revision << 8 | UInt64(variant) }
        return item
    }

    public static func == (lhs: ChatItem, rhs: ChatItem) -> Bool {
        if lhs.revision != 0, lhs.revision == rhs.revision { return true }
        return lhs.id == rhs.id && lhs.role == rhs.role && lhs.pieces == rhs.pieces && lhs.delivery == rhs.delivery && lhs.turn == rhs.turn && lhs.time == rhs.time && lhs.author == rhs.author
    }

    /// Stamps unique across the app, so items of two conversations are never
    /// taken for each other either.
    public enum Revision {
        private static let counter = Counter()

        public static func next() -> UInt64 { counter.next() }

        private final class Counter: @unchecked Sendable {
            private let lock = NSLock()
            private var value: UInt64 = 0
            func next() -> UInt64 { lock.withLock { value += 1; return value } }
        }
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
public struct Media: Equatable, Sendable {
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
public struct Artifact: Equatable, Sendable {
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
public struct Activity: Equatable, Sendable {
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
    public static func project(working: Bool, status: String, wait: AgentWire.AgentWait?, retrying: AgentWire.AgentRetrying?, question: Bool, subagentsRunning: Int, produced: Bool, startedAt: Double?) -> Activity? {
        if question { return Activity(phase: .awaitingAnswer, startedAt: nil) }
        guard working else {
            return subagentsRunning > 0 ? Activity(phase: .delegating, startedAt: nil) : nil
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
        return Activity(phase: phase, startedAt: startedAt)
    }
}

public struct ChatSnapshot: Equatable, Sendable {
    /// History has been read, or there is none to read yet.
    public var loaded = false
    public var items: [ChatItem] = []
    /// The agent is at work on a run.
    public var working = false
    /// The working line; nil when there is nothing to report.
    public var activity: Activity?
    /// Older runs exist before the first one shown.
    public var hasMore = false
    /// The agents this one spawned, by ID, as titled (a sender a
    /// collaborator row names when the sidebar doesn't hold it).
    public var subagentTitles: [String: String] = [:]
    /// Why the conversation could not be read.
    public var error: String?
    /// The conversation's own title, once the daemon has written one: what
    /// the header reads while its row has no name of its own.
    public var title: String?
    /// The model, account and effort the next message goes with: the last
    /// one sent, a pick, or the computer's default.
    public var mode: AgentWire.Mode?
    /// The composer's draft, and a count that moves only when it came from
    /// elsewhere (the computer, the person's other device, or this phone's
    /// kept copy): the screen sets the composer then, and never has its
    /// own typing echoed back.
    public var draft = ""
    public var draftArrivals = 0
    /// The phone's kept draft has been checked, including an empty or
    /// missing copy. A screen's unsent prefill waits for this, since a
    /// conversation read ahead may publish before its draft is attached.
    public var localDraftLoaded = false
    /// When `draft` was written (ms since 1970): a draft from elsewhere
    /// older than what is being typed here isn't shown over it.
    public var draftUpdatedAt: Double = 0
    /// The person's steering at the end of `items` that the running turn
    /// hasn't taken yet: desktop draws it under the working line, as next
    /// in the queue, until the agent takes it up.
    public var queued = 0
    /// The provider's latest measurement of the conversation's context
    /// (the bootstrap's, then each `agent.context.updated`); nil until one.
    public var context: AgentWire.ContextUsage?
    /// The commands the composer offers after a `/`, in the agent's order:
    /// the bootstrap's, replaced whole by `agent.slash_commands.updated`,
    /// and kept with the conversation for when the computer is away.
    public var slashCommands: [AgentWire.SlashCommand] = []

    public init() {}
}

/// How running a slash command went (`Conversation.run`), for the screen
/// to say in its own words.
public enum SlashCommandOutcome: Equatable, Sendable {
    /// Taken: a skill's message is on its way, or the command was accepted
    /// and what it does comes as events.
    case accepted
    /// The computer has no such command now (404); it left the palette.
    case unavailable
    /// It can't run in the agent's current state (409).
    case busy
    /// The computer couldn't be reached, or failed.
    case unreachable
    /// Refused for another reason (another 4xx).
    case refused
    /// A skill's message could not be kept on this phone.
    case notSaved
}

/// A picture still being read when its message was sent, an iCloud photo
/// coming down: its thumbnail stands in, with its ring, until the picture
/// itself is in (`Conversation.prepared`). `id` is the composer's for it.
public struct PreviewAttachment: Equatable, Sendable {
    public var id: String
    public var thumbnail: URL
    /// The picture's own size, so its tile has its shape from the start.
    public var width: Int?
    public var height: Int?

    public init(id: String, thumbnail: URL, width: Int? = nil, height: Int? = nil) {
        self.id = id; self.thumbnail = thumbnail; self.width = width; self.height = height
    }
}

/// One conversation over the paired computer's API: its history, read by
/// run, and the store's events applied on top (`message.*`, `run.*`,
/// `agent.updated`), all off the main thread. Sends are drawn at once and
/// confirmed by their own `message.created` echo, by ID.
public actor Conversation {
    private let client: AgentClient
    private let store: Store
    private let persistence: SyncEngine?
    private var keeping: Task<Void, Never>?
    /// `keeping` waits out a working agent's long pause.
    private var keepingLong = false
    private var delivering: [String: Task<Void, Never>] = [:]
    private var conversationDirty = false
    private var deliveryWatch: Task<Void, Never>?
    private var outgoingModes: [String: AgentWire.Mode] = [:]
    private var lastKept: KeptConversation?
    private var conversationWrite: Task<Bool, Error>?
    private let checkpointOwner = SyncStorage.ConversationOwner()
    private var checkpointClaims: [String: Task<Void, Error>] = [:]
    private var attachmentCleanup: Set<String> = []
    private struct KeptConversation: Codable, Equatable, Sendable {
        struct Run: Codable, Equatable, Sendable { var id: String; var messageIds: [String]; var time: RunTime? }
        struct Picture: Codable, Equatable, Sendable { var mimeType: String; var data: Data }
        struct Send: Codable, Equatable, Sendable {
            var id: String; var text: String; var pictures: [Picture]; var accepted: Bool; var failure: String?; var mode: AgentWire.Mode?
            var files: [QueuedFile]?
            /// When it was sent, in ms; absent in what was kept before it was.
            var at: Double?
            var toolRequest: AgentWire.ToolCallRequest?
        }
        var runs: [Run]
        var messages: [String: AgentWire.Message]
        var pending: [String]
        var outgoing: [Send]
        var mode: AgentWire.Mode?
        var hasMore: Bool
        var slashCommands: [AgentWire.SlashCommand]?
    }
    private var agentId: String { didSet { itemContext += 1 } }
    private let continuation: AsyncStream<ChatSnapshot>.Continuation
    public nonisolated let updates: AsyncStream<ChatSnapshot>

    private var snapshot = ChatSnapshot()
    private var following: Task<Void, Never>?
    /// The agents this one spawns or retitles while it is open.
    private var children: Task<Void, Never>?
    private var reading: Task<Void, Never>?
    private var reloadSoon: Task<Void, Never>?
    /// History reads finished, read or failed.
    private var reads = 0
    /// Messages whose words stopped applying, with `reads` as they did.
    /// Each is read for once. History doesn't hold a message the agent is
    /// still writing, so one still behind after that read waits for its
    /// next whole self (`message.updated`): read again on every word, the
    /// chat read its whole page several times a second while the agent
    /// wrote, at about 40% of a core.
    private var behind: [String: Int] = [:]
    /// Events that came while history was being read, applied after it.
    private var heldEvents: [JSONValue]?
    /// Subagents made or retitled while history was being read, applied over
    /// the bootstrap's list.
    private var heldChildren: [JSONValue] = []

    /// The runs, their messages, the pending ones and the runs' times,
    /// found by key (`Transcript`).
    private var transcript = Transcript()
    /// When each run began and ended, and why it ended (`run.*` metadata).
    struct RunTime: Codable, Equatable, Sendable {
        var startedAt: Double?
        var endedAt: Double?
        var reason: String?

        init(_ run: AgentWire.Run) {
            startedAt = run.startedAt; endedAt = run.endedAt; reason = run.reason
        }

        init(_ run: JSONValue?) {
            startedAt = run?["startedAt"]?.numberValue; endedAt = run?["endedAt"]?.numberValue; reason = run?["reason"]?.stringValue
        }
    }
    /// The question the agent waits on, and how its answer stands.
    private var asking: ChatItem.Ask? { didSet { if asking?.question.id != oldValue?.question.id { itemContext += 1 } } }
    private var askingRead: Task<Void, Never>?
    /// `question.*` events, which name their agent inside the question.
    private var questionEvents: Task<Void, Never>?
    /// Questions answered while this was open, as the computer took them.
    private var answered: [String: AgentWire.Question] = [:] { didSet { itemContext += 1 } }
    /// Sends the daemon has not echoed yet, oldest first. One it accepted
    /// stays here until history or an event carries it, so no read that
    /// began before the send can take it off the screen.
    private var outgoing: [(id: String, text: String, pictures: [(mimeType: String, data: Data)], accepted: Bool, failure: String?)] = []
    private var outgoingFiles: [String: [QueuedFile]] = [:]
    private var outgoingTools: [String: AgentWire.ToolCallRequest] = [:]
    /// When each send was made, in ms, for its bubble's time.
    private var outgoingTimes: [String: Double] = [:]
    private var admitting: Set<String> = []
    /// Standalone consumers and fixtures never persist a conversation. Every
    /// production Session supplies its account's durable engine.
    private let temporaryAttachments = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    /// Pictures already decoded, by message and block.
    private var pictures: [String: Data] = [:]
    private var mode: AgentWire.Mode?
    /// A mode the person chose here; what the daemon last ran with never
    /// replaces it.
    private var picked: AgentWire.Mode?
    /// The agent's own mode, as the computer says it last ran: what the
    /// composer shows unless the person picked one here. A draft always
    /// carries a mode (the daemon requires one), picked or not, so a
    /// draft's never stands over this.
    private var agentMode: AgentWire.Mode?
    private var modeRefresh: Task<Void, Never>?
    private var defaultMode: Task<AgentWire.Mode, Error>?
    /// The agent's own state, for the working line.
    private var status = "idle"
    private var wait: AgentWire.AgentWait?
    private var retrying: AgentWire.AgentRetrying?
    private var question = false
    private var subagentsRunning = 0
    /// The agent that manages this one: its messages are dialogue, never a collaborator's row.
    private var parentAgentId: String? { didSet { if parentAgentId != oldValue { itemContext += 1 } } }
    /// The running turn and when it began (or when a send was taken, before
    /// its run is known).
    private var activeRun: (id: String?, startedAt: Double?)?
    /// A task its first message makes (`NewTask`): until then nothing of it
    /// is on the computer, and everything that goes there waits for it.
    private var creation: NewTask?
    /// The mode its first message made it with went to the person's
    /// preferences, once.
    private var startRecorded = false
    /// Sends waiting for pictures still being read (`previews`), by ID:
    /// drawn from the previews, delivered once `prepared` has them.
    private var held: [String: [PreviewAttachment]] = [:]
    private var visible = false
    /// Off screen, words drawn together (`publishSoon`).
    private var publishing: Task<Void, Never>?
    /// Each run's rows and each message's as last made (`publish`), and
    /// what moves when something every row reads changes: which question
    /// waits, which are answered, who manages this agent.
    private var madeRuns: [String: MadeRun] = [:]
    private var madeMessages: [String: MadeMessage] = [:]
    private var madeSends: [String: (key: SendKey, item: ChatItem)] = [:]
    private var itemContext: UInt64 = 0
    /// On screen, the reader at the newest message and at rest.
    private var readsNewest = false

    /// The draft as desktop keeps it (`connectHappyAgent` `setDraft`): this
    /// phone's copy first, saved to the computer 300 ms after the last
    /// keystroke (a clear at once), last write wins by `updatedAt` across
    /// the person's devices, and `agent.draft.updated` brings theirs.
    private var drafts: Drafts?
    private var draft = Draft(text: "", updatedAt: 0, synced: true)
    /// Moves with every draft taken or typed: a save answered after it is stale.
    private var draftRevision = 0
    private var draftSave: Task<Void, Never>?
    /// The newest keystroke's stamp, so one arriving out of order is dropped.
    private var lastDraftEdit: Double = 0
    static let draftDebounce: Duration = .milliseconds(300)

    /// `newTask` opens the conversation of a task its first message makes,
    /// under the ID named for it here.
    public init(client: AgentClient, store: Store, agentId: String, newTask: NewTask? = nil, mode: AgentWire.Mode? = nil, persistence: SyncEngine? = nil) {
        self.client = client
        self.store = store
        self.persistence = persistence
        self.agentId = newTask?.agentId ?? agentId
        self.creation = newTask
        (updates, continuation) = AsyncStream.makeStream(of: ChatSnapshot.self, bufferingPolicy: .bufferingNewest(1))
        picked = mode
        self.mode = mode
        snapshot.mode = mode
    }

    // MARK: Life

    public func start() async {
        guard following == nil else { return }
        do { try await checkpointClaim(for: "conversation:\(agentId)").value }
        catch {
            checkpointClaims.removeValue(forKey: "conversation:\(agentId)")
            snapshot.error = "Could not open this conversation on this device."; publish(); return
        }
        if let creation {
            // A new task has nothing to read yet: it is shown at once, with
            // what was sent into it while it was being made (left and opened
            // again meanwhile), and followed once it has been made.
            await restoreConversation()
            snapshot.loaded = true
            publish()
            defaultMode = readDefaultMode()
            following = Task {
                guard let id = try? await creation.made(), !Task.isCancelled else { return }
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
        questionEvents?.cancel(); questionEvents = nil
        askingRead?.cancel(); askingRead = nil
        reading?.cancel(); reading = nil
        reloadSoon?.cancel(); reloadSoon = nil
        modeRefresh?.cancel(); modeRefresh = nil
        publishing?.cancel(); publishing = nil
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
        if visible, publishing != nil { publish() }
        if visible, !transcript.runs.isEmpty { markRead() }
        // Left: desktop's `releaseSession`.
        if !visible { trimHistory() }
    }

    /// The reader is at the newest message and the scroll at rest: a run's
    /// end may trim what is above, as nothing read is there.
    public func setReadsNewest(_ readsNewest: Bool) {
        self.readsNewest = readsNewest
    }

    /// desktop's `trimHistory`: a conversation nobody reads keeps only its
    /// newest `keptRuns` runs in memory, as on disk; scrolling back pages
    /// the rest in again. One on screen is trimmed the same way only past
    /// twice that, and only while its reader follows the newest message.
    private func trimHistory() {
        if visible, !readsNewest || transcript.runs.count <= Self.keptRuns * 2 { return }
        let window = Self.kept(runs: transcript.runs.map { ($0.id, $0.messageIds) }, messages: transcript.messages, pending: transcript.pending)
        guard window.trimmed else { return }
        transcript.replace(runs: window.runs.map { .init(id: $0.id, messageIds: $0.messageIds) }, messages: window.messages, pending: transcript.pending, times: transcript.times)
        forgetUnheld()
        snapshot.hasMore = true
        publish()
    }

    private func created(_ id: String) async {
        creation = nil
        agentId = id
        do { try await checkpointClaim(for: "conversation:\(id)").value }
        catch { snapshot.error = "Could not open this conversation on this device."; publish(); return }
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
                    case .failed(let id, let reason):
                        failed(id, reason)
                        Happenings.errorShown(.messageSend, nil)
                    }
                }
            }
            for queued in (try? await persistence.queuedMessages(for: agentId)) ?? [] {
                let copy = (queued.id, queued.text, queued.pictures.map { (mimeType: $0.mimeType, data: $0.data) }, false, queued.failure)
                if let index = outgoing.firstIndex(where: { $0.id == queued.id }) { outgoing[index] = copy }
                else { outgoing.append(copy) }
                outgoingModes[queued.id] = queued.mode
                outgoingFiles[queued.id] = queued.files
                outgoingTools[queued.id] = queued.toolRequest
                if outgoingTimes[queued.id] == nil { outgoingTimes[queued.id] = Date().timeIntervalSince1970 * 1000 }
            }
        }
        let events = await store.conversationEvents(agentId)
        // Only a retitling of an agent's: every warm conversation follows
        // these, and a working agent's update comes with every word.
        let spawned = await store.events(matching: ["agent.created", "agent.updated"]) { event in
            event["type"] != .string("agent.updated") || event["payload"]?["changes"]?["title"] != nil
        }
        let asked = await store.events(matching: ["question."])
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
        questionEvents?.cancel()
        questionEvents = Task { [weak self] in
            for await event in asked {
                guard let self, !Task.isCancelled else { return }
                guard case .event(let envelope) = event else { continue }
                await questionEvent(envelope)
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
                reads += 1
                snapshot.error = Store.describe(error)
                Happenings.errorShown(.conversationLoad, error)
                snapshot.loaded = true
                let held = heldEvents ?? []
                heldEvents = nil
                for event in held { receive(event, publishes: false) }
                publish()
            }
        }
    }

    private func adopt(_ start: AgentWire.Bootstrap, _ history: AgentWire.MessagesResponse) {
        reads += 1
        // The agent's own mode stands over the draft's: a draft carries
        // whatever mode its device had, picked or not, and would otherwise
        // keep one the agent no longer runs with.
        if let current = start.mode { agentMode = current }
        mode = picked ?? agentMode ?? start.draft?.value?.mode ?? mode
        snapshot.mode = mode
        if let draft = start.draft { adoptDraft(draft, publishes: false) }
        if mode == nil, defaultMode == nil { defaultMode = readDefaultMode() }
        // A newest-page refresh is not a deletion of older pages already
        // downloaded. Retain them until a complete history says otherwise.
        let refreshed = Set(history.runs.map(\.id))
        var runs: [Transcript.Run] = []
        var messages: [String: AgentWire.Message] = [:]
        var times = transcript.times
        if persistence != nil && history.hasMore {
            runs = transcript.runs.filter { !refreshed.contains($0.id) }
            for id in runs.lazy.flatMap(\.messageIds) { messages[id] = transcript[message: id] }
        }
        for run in history.runs {
            runs.append(.init(id: run.id, messageIds: (run.messages ?? []).map(\.id)))
            times[run.id] = RunTime(run)
            for message in run.messages ?? [] { messages[message.id] = message }
        }
        for message in start.pending ?? [] { messages[message.id] = message }
        transcript.replace(runs: runs, messages: messages, pending: (start.pending ?? []).map(\.id), times: times)
        forgetUnheld()
        let echoed = Set(messages.keys)
        attachmentCleanup.formUnion(echoed)
        outgoing.removeAll { echoed.contains($0.id) }
        // A send taken before the daemon started its run keeps the line
        // and the send's clock until the run's own events come.
        let awaiting = activeRun != nil && activeRun?.id == nil && (outgoing.contains { $0.accepted } || !transcript.pending.isEmpty)
        snapshot.working = start.agent.isWorking || awaiting
        snapshot.context = start.context
        if let commands = start.slashCommands { snapshot.slashCommands = commands }
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
    /// A tool call's raw `arguments` and `result` as the computer holds
    /// them, unbounded: read with its run, which the transcript's pages
    /// read without tool data. Nil when it isn't in a run here or can't be read.
    public func fullToolCall(_ callId: String) async -> (arguments: JSONValue?, result: JSONValue?)? {
        guard let index = transcript.runIndex(holdingCall: callId) else { return nil }
        let runs = transcript.runs
        let before = index + 1 < runs.count ? runs[index + 1].id : nil
        guard let block = try? await client.toolCall(agentId, id: callId, before: before) else { return nil }
        return (block["arguments"], block["result"])
    }

    public func loadOlder() async {
        guard snapshot.hasMore, heldEvents == nil, let first = transcript.runs.first?.id else { return }
        do {
            let page = try await client.messages(agentId, before: first)
            guard transcript.runs.first?.id == first else { return }
            transcript.prepend(page.runs.filter { transcript.run($0.id) == nil })
            snapshot.hasMore = page.hasMore
            publish()
            // A page that lands after its reader left goes again with the rest.
            if !visible { trimHistory() }
        } catch {}
    }

    /// History disagreed with an event: read it again, 300 ms on. Once a
    /// word is missed every later one disagrees too, so the wait is never
    /// started again: restarted with each, as it was, the chat stayed
    /// where it broke for as long as the agent kept writing. Events that
    /// come during the read are laid on it after (`Delta.replay_is_free`).
    private func reconcile() {
        guard reloadSoon == nil else { return }
        reloadSoon = Task {
            try? await Task.sleep(for: .milliseconds(300))
            if Task.isCancelled { return }
            reloadSoon = nil
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
            transcript.set(message)
            behind[message.id] = nil
            attachmentCleanup.insert(message.id)
            outgoing.removeAll { $0.id == message.id }
            UploadProgressBoard.shared.clear(message: message.id)
            if let runId = payload["runId"]?.stringValue {
                transcript.place(message.id, in: runId)
            } else {
                transcript.wait(message.id)
            }
        case "message.delta":
            guard let id = payload["messageId"]?.stringValue, let index = payload["blockIndex"]?.numberValue,
                  let offset = payload["offset"]?.numberValue, let append = payload["append"]?.stringValue else { return }
            guard let growth = transcript.growth(ofBlock: Int(index), in: id, offset: Int(offset), append: append) else {
                if let since = behind[id] {
                    // Read for since it broke: the next whole message mends it.
                    if reads > since { return }
                } else {
                    behind[id] = reads
                }
                reconcile()
                return
            }
            // A word already applied, replayed: nothing moves.
            if case .append(let suffix) = growth { transcript.append(suffix, toBlock: Int(index), of: id) }
            if let runId = payload["runId"]?.stringValue { transcript.place(id, in: runId) }
        case "message.deleted":
            guard let id = payload["messageId"]?.stringValue else { return }
            transcript.remove(message: id)
            madeMessages[id] = nil
            behind[id] = nil
        case "run.started":
            guard let runId = payload["run"]?["id"]?.stringValue else { return }
            transcript.accept(payload["acceptedMessageIds"]?.arrayValue?.compactMap(\.stringValue) ?? [], into: runId)
            snapshot.working = true
            activeRun = (runId, payload["run"]?["startedAt"]?.numberValue)
            transcript.setTime(RunTime(payload["run"]), for: runId)
            refreshAgentMode()
        case "run.boundary":
            guard let runId = payload["startedRun"]?["id"]?.stringValue else { return }
            transcript.accept(payload["acceptedMessageIds"]?.arrayValue?.compactMap(\.stringValue) ?? [], into: runId)
            snapshot.working = true
            activeRun = (runId, payload["startedRun"]?["startedAt"]?.numberValue)
            if let finished = payload["finishedRun"]?["id"]?.stringValue { transcript.setTime(RunTime(payload["finishedRun"]), for: finished) }
            transcript.setTime(RunTime(payload["startedRun"]), for: runId)
            refreshAgentMode()
        case "run.finished":
            if let finished = payload["run"]?["id"]?.stringValue { transcript.setTime(RunTime(payload["run"]), for: finished) }
            snapshot.working = false
            settle()
            if visible { markRead() }
            trimHistory()
        case "agent.updated":
            guard let changes = payload["changes"] else { return }
            // A working agent's comes with every word, mostly saying
            // nothing new: only a change is drawn.
            let before = agentState
            if let status = changes["status"]?.stringValue {
                self.status = status
                snapshot.working = status != "idle"
                if status == "idle" { settle() }
            }
            // Present and null clears; absent leaves it.
            if let value = changes["wait"] { wait = value == .null ? nil : Self.decode(AgentWire.AgentWait.self, value) }
            if let value = changes["retrying"] { retrying = value == .null ? nil : Self.decode(AgentWire.AgentRetrying.self, value) }
            if let value = changes["pendingQuestionId"] {
                question = value.stringValue != nil
                waitsOn(value.stringValue)
            }
            if let running = changes["subagents"]?["running"]?.numberValue { subagentsRunning = Int(running) }
            if let value = changes["title"] { snapshot.title = value.stringValue }
            if agentState == before { return }
        case "agent.draft.updated":
            guard let draft = payload["draft"].flatMap({ Self.decode(AgentWire.Draft.self, $0) }) else { return }
            adoptDraft(draft, publishes: false)
        case "agent.context.updated":
            // A complete replacement; null clears it (a fresh conversation).
            guard let value = payload["context"] else { return }
            let context = value == .null ? nil : Self.decode(AgentWire.ContextUsage.self, value)
            guard value == .null || context != nil, context != snapshot.context else { return }
            snapshot.context = context
        case "agent.slash_commands.updated":
            guard let commands = AgentWire.SlashCommand.catalog(payload["slashCommands"]), commands != snapshot.slashCommands else { return }
            snapshot.slashCommands = commands
        default:
            return
        }
        guard publishes else { return }
        // Off screen, a word at a time is drawn by nobody: a warm
        // conversation's streaming text arrives once a second.
        if type == "message.delta", !visible { publishSoon() } else { publish() }
    }

    private func publishSoon() {
        guard publishing == nil else { return }
        publishing = Task {
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            publishing = nil
            publish()
        }
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

    static func decodeMessage(_ value: JSONValue) -> AgentWire.Message? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONDecoder().decode(AgentWire.Message.self, from: data)
    }

    /// `message.delta` applied exactly as the API says, or nil where the
    /// message must be read again. Only the block's UTF-16 view is walked,
    /// from the offset: copied out whole on every word, a long answer cost
    /// its length again per word, a third of the iPhone 12's time as a
    /// reconnect replayed the words it missed.
    static func grow(_ message: AgentWire.Message, block index: Int, offset: Int, append: String) -> AgentWire.Message? {
        growing(message, block: index, offset: offset, append: append)?.message
    }

    /// `grow`, and whether the word was new: a word replayed changes nothing.
    static func growing(_ message: AgentWire.Message, block index: Int, offset: Int, append: String) -> (message: AgentWire.Message, changed: Bool)? {
        var message = message
        guard message.content.indices.contains(index) else { return nil }
        let text: String
        switch message.content[index] {
        case .text(let current), .reasoning(let current): text = current
        default: return nil
        }
        switch growth(text, count: text.utf16.count, offset: offset, append: append) {
        case nil: return nil
        case .same: return (message, false)
        case .append(let suffix):
            if case .reasoning = message.content[index] { message.content[index] = .reasoning(text + suffix) } else { message.content[index] = .text(text + suffix) }
            return (message, true)
        }
    }

    /// What a word at UTF-16 `offset` does to a block's `text` of `count`
    /// UTF-16 units: what to append, nothing (replayed), or nil where the
    /// message must be read again. Only a word that overlaps what is there
    /// walks the text, from the offset.
    enum Growth: Equatable { case append(String), same }

    static func growth(_ text: String, count: Int, offset: Int, append: String) -> Growth? {
        guard offset >= 0, count >= offset else { return nil }
        let after = count - offset
        if after == 0 { return .append(append) }
        let units = text.utf16
        let start = units.index(units.startIndex, offsetBy: offset)
        let added = append.utf16
        if after >= added.count {
            guard units[start...].starts(with: added) else { return nil }
            return .same
        }
        guard added.starts(with: units[start...]) else { return nil }
        return .append(String(decoding: added.dropFirst(after), as: UTF16.self))
    }

    // MARK: Sending

    /// Draws the message and sends it. A new task's first message is drawn
    /// at once, before the task is made: it goes once the computer has made
    /// it, and if the computer refuses, it stays, failed, to be retried
    /// under the same names (`NewTask`), which never makes a second task.
    ///
    /// `previews` are pictures still being read, an iCloud photo coming
    /// down: drawn from their thumbnails, each with its ring, and nothing
    /// goes until `prepared` hands over the pictures themselves.
    @discardableResult
    public func send(id: String = ClientID.make(), text: String, pictures: [(mimeType: String, data: Data)] = [], attachments: [OutgoingAttachment] = [],
                     previews: [PreviewAttachment] = [], toolRequest: AgentWire.ToolCallRequest? = nil) async -> Bool {
        guard !outgoing.contains(where: { $0.id == id }), transcript[message: id] == nil else { return false }
        admitting.insert(id)
        defer { admitting.remove(id) }
        var inline = pictures
        var files: [QueuedFile] = []
        do {
            try stage(attachments, id: id, inline: &inline, files: &files)
        } catch {
            snapshot.error = Store.describe(error)
            Happenings.errorShown(.attachmentUpload, error)
            publish()
            return false
        }
        outgoingFiles[id] = files
        outgoingTools[id] = toolRequest
        if !previews.isEmpty { held[id] = previews }
        outgoing.append((id, text, inline, false, nil))
        outgoingModes[id] = mode
        outgoingTimes[id] = Date().timeIntervalSince1970 * 1000
        guard await saveConversationNow() else {
            held[id] = nil
            failed(id, "Could not save this message on this device. Retry when storage is available.")
            return false
        }
        // Drawn now; it goes once the task is made and its pictures are read.
        if creation != nil || held[id] != nil {
            admitting.remove(id)
            publish()
            deliver(id)
            return true
        }
        if let persistence {
            do {
                try await checkpointClaim(for: "conversation:\(agentId)").value
                try await persistence.enqueueMessage(queuedMessage(id: id, text: text, pictures: inline))
            }
            catch { failed(id, "Could not save this message on this device."); return false }
            publish()
            return true
        }
        publish()
        deliver(id)
        return true
    }

    /// The pictures a held send waited for, read in full, in its previews'
    /// order: staged as any send's are, and the message goes. Pictures that
    /// couldn't be read are left out, and a message left with nothing is
    /// taken back.
    /// `attachments` by the previews' ids.
    public func prepared(_ id: String, _ attachments: [String: OutgoingAttachment]) async {
        guard let previews = held.removeValue(forKey: id), let index = outgoing.firstIndex(where: { $0.id == id }) else { return }
        let attachments = previews.compactMap { attachments[$0.id] }
        // The previews' rings; the pictures' own start again under their keys.
        UploadProgressBoard.shared.clear(message: id)
        var inline = outgoing[index].pictures
        var files = outgoingFiles[id] ?? []
        do {
            try stage(attachments, id: id, inline: &inline, files: &files)
        } catch {
            failed(id, Store.describe(error))
            return
        }
        guard let index = outgoing.firstIndex(where: { $0.id == id }) else { return }
        outgoing[index].pictures = inline
        outgoingFiles[id] = files
        if outgoing[index].text.isEmpty, inline.isEmpty, files.isEmpty {
            outgoing.remove(at: index)
            outgoingModes.removeValue(forKey: id)
            outgoingTimes.removeValue(forKey: id)
            outgoingTools.removeValue(forKey: id)
            outgoingFiles.removeValue(forKey: id)
            attachmentCleanup.insert(id)
            publish()
            return
        }
        publish()
        deliver(id)
    }

    /// Copies `attachments` in for message `id`, after any it has: small
    /// pictures inline, the rest as files.
    private func stage(_ attachments: [OutgoingAttachment], id: String, inline: inout [(mimeType: String, data: Data)], files: inout [QueuedFile]) throws {
        let staged = try AttachmentRules.stage(attachments, messageID: id,
            directory: persistence?.attachmentDirectory ?? temporaryAttachments, first: inline.count + files.count)
        var inlineBytes = inline.reduce(0) { $0 + $1.data.count }
        for file in staged {
            let supportedImage = ["image/jpeg", "image/png", "image/gif", "image/webp"].contains(file.mimeType)
            if supportedImage, file.size <= AttachmentRules.maxInlineImageBytes,
               inlineBytes + file.size <= AttachmentRules.maxInlineImageTotalBytes {
                let bytes = try Data(contentsOf: file.fileURL)
                guard bytes.count == file.size else { throw AttachmentRules.invalid("The attachment changed while being read.") }
                inline.append((file.mimeType, bytes)); inlineBytes += bytes.count
            } else { files.append(file) }
        }
    }

    public func retry(_ id: String) {
        guard let index = outgoing.firstIndex(where: { $0.id == id }), outgoing[index].failure != nil else { return }
        outgoing[index].failure = nil
        publish()
        // Not made yet: the task is asked for again, under the same names.
        if creation != nil {
            deliver(id)
            return
        }
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

    /// Takes one picture or file (`key`, its piece's id) out of a message
    /// the computer hasn't taken yet, and sends the rest of it; one left
    /// with nothing is taken back whole.
    public func removeAttachment(_ id: String, key: String) async {
        // A picture still being read: it is left out when the rest come.
        if var previews = held[id], let at = previews.indices.first(where: { UploadProgressBoard.previewKey(id, $0) == key }) {
            previews.remove(at: at)
            held[id] = previews
            UploadProgressBoard.shared.clear(message: id)
            publish()
            return
        }
        guard let piece = UploadProgressBoard.piece(key, message: id),
              let found = outgoing.first(where: { $0.id == id }), !found.accepted else { return }
        // Nothing still sending writes the message as it was.
        if let task = delivering[id] {
            task.cancel()
            await task.value
        }
        var withdrawn = false
        if let persistence {
            guard let result = try? await persistence.removeAttachment(id, piece), result.removed else { return }
            withdrawn = result.message == nil
        }
        guard let index = outgoing.firstIndex(where: { $0.id == id }), !outgoing[index].accepted else { return }
        switch piece {
        case .picture(let at):
            guard outgoing[index].pictures.indices.contains(at) else { return }
            outgoing[index].pictures.remove(at: at)
        case .file(let at):
            guard outgoingFiles[id]?.indices.contains(at) == true else { return }
            outgoingFiles[id]?.remove(at: at)
        }
        // What is left starts again under its new keys.
        UploadProgressBoard.shared.clear(message: id)
        let send = outgoing[index]
        if withdrawn || (send.text.isEmpty && send.pictures.isEmpty && (outgoingFiles[id] ?? []).isEmpty) {
            outgoing.remove(at: index)
            outgoingModes.removeValue(forKey: id)
            outgoingTimes.removeValue(forKey: id)
            outgoingTools.removeValue(forKey: id)
            attachmentCleanup.insert(id)
            publish()
            return
        }
        publish()
        if persistence == nil, send.failure == nil { deliver(id) }
    }

    private func deliver(_ id: String) {
        guard delivering[id] == nil, !admitting.contains(id), held[id] == nil else { return }
        let client = client
        delivering[id] = Task {
            defer { delivering.removeValue(forKey: id) }
            do {
                if let persistence, !(await persistence.deliveryAllowed) { return }
                guard await saveConversationNow() else { failed(id, "Could not save this message on this device."); return }
                // A new task: its conversation exists once the computer has
                // made it, under the ID the computer gave it. Refused (after
                // its own retries), the message shows failed, to retry.
                if let creation {
                    do { agentId = try await creation.make() }
                    catch {
                        failed(id, Store.describe(error))
                        return
                    }
                    // What it started on is what the person's next session
                    // starts on, on every device (`ModelPreferences`).
                    if outgoingModes[id] == nil {
                        outgoingModes[id] = try await sendingMode()
                        guard await saveConversationNow() else { failed(id, "Could not save this message on this device."); return }
                    }
                    if !startRecorded, let started = outgoingModes[id] {
                        startRecorded = true
                        try? await persistence?.sessionStarted(started)
                    }
                }
                if let persistence, !(await persistence.deliveryAllowed) { return }
                guard let outgoingIndex = outgoing.firstIndex(where: { $0.id == id }) else { return }
                let send = outgoing[outgoingIndex]
                if let persistence {
                    try await checkpointClaim(for: "conversation:\(agentId)").value
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
                        var payload = queuedMessage(id: id, text: send.text, pictures: send.pictures)
                        payload.mode = mode
                        try await client.deliverMessage(payload) { _ in }
                        break
                    } catch let error as AgentClientError where (error.status ?? 500) < 500 {
                        throw error
                    } catch {
                        attempt += 1
                        if attempt == 3 { throw error }
                        try await Task.sleep(for: .milliseconds(600 * attempt))
                    }
                }
                sent(id)
            } catch {
                // Stopped to take a picture out (`removeAttachment`), which sends the rest.
                if error is CancellationError { return }
                if persistence != nil, !(error is AgentClientError) || (error as? AgentClientError)?.status.map({ $0 >= 500 }) == true {
                    // Offline sends stay queued and resume on the account's
                    // next resync, with the same daemon message ID.
                    publish()
                } else {
                    failed(id, Store.describe(error))
                    Happenings.errorShown(.messageSend, error)
                }
            }
        }
    }

    private func queuedMessage(id: String, text: String, pictures: [(mimeType: String, data: Data)]) -> QueuedMessage {
        QueuedMessage(id: id, agentID: agentId, text: text, pictures: pictures.map { .init(mimeType: $0.mimeType, data: $0.data) }, mode: outgoingModes[id], files: outgoingFiles[id],
                      toolRequest: outgoingTools[id])
    }

    private func restoreConversation() async {
        guard let persistence, let value = try? await persistence.keptConversation("conversation:\(agentId)"),
              let kept = try? JSONDecoder().decode(KeptConversation.self, from: value) else { return }
        transcript.replace(runs: kept.runs.map { .init(id: $0.id, messageIds: $0.messageIds) }, messages: kept.messages, pending: kept.pending,
                           times: Dictionary(kept.runs.compactMap { run in run.time.map { (run.id, $0) } }, uniquingKeysWith: { _, last in last }))
        forgetUnheld()
        outgoing = kept.outgoing.map { ($0.id, $0.text, $0.pictures.map { ($0.mimeType, $0.data) }, $0.accepted, $0.failure) }
        outgoingModes = Dictionary(kept.outgoing.compactMap { send in send.mode.map { (send.id, $0) } }, uniquingKeysWith: { first, _ in first })
        outgoingFiles = Dictionary(kept.outgoing.compactMap { send in send.files.map { (send.id, $0) } }, uniquingKeysWith: { first, _ in first })
        outgoingTimes = Dictionary(kept.outgoing.compactMap { send in send.at.map { (send.id, $0) } }, uniquingKeysWith: { first, _ in first })
        outgoingTools = Dictionary(kept.outgoing.compactMap { send in send.toolRequest.map { (send.id, $0) } }, uniquingKeysWith: { first, _ in first })
        if let commands = kept.slashCommands { snapshot.slashCommands = commands }
        mode = picked ?? kept.mode
        snapshot.mode = mode
        snapshot.hasMore = kept.hasMore
        snapshot.loaded = true
        lastKept = kept
        publish()
    }

    private func keepConversation() {
        conversationDirty = true
        guard persistence != nil else { return }
        // The run ended during a working wait: what it wrote is kept soon.
        if keeping != nil, keepingLong, !snapshot.working {
            keeping?.cancel()
            keeping = nil
        }
        guard keeping == nil else { return }
        keeping = Task {
            while conversationDirty {
                // While the agent works its words change it many times a
                // second, and each save writes the whole conversation: then
                // it is kept every 20 s (at 5 s, saves of the warm chats were
                // an eighth of the phone's time while agents wrote). A send
                // is saved at once (`saveConversationNow`), the end of a run
                // half a second after it, and what streamed since the last
                // save is read again from the computer.
                keepingLong = snapshot.working
                let pause: Duration = keepingLong ? .seconds(20) : .milliseconds(500)
                do { try await Task.sleep(for: pause) } catch { return }
                keepingLong = false
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

    /// The runs the phone keeps of a conversation: desktop's window on one
    /// nobody reads (connectHappyAgent's `trimHistory`), its newest page.
    /// Older runs stay while the conversation is open, and are read again
    /// once someone scrolls back to them after it was closed.
    static let keptRuns = 100

    /// What of `runs` the phone keeps (`keptRuns`): the newest, their
    /// messages and the pending ones; `trimmed` when older runs were left out.
    static func kept(runs: [(id: String, messageIds: [String])], messages: [String: AgentWire.Message], pending: [String]) -> (runs: [(id: String, messageIds: [String])], messages: [String: AgentWire.Message], trimmed: Bool) {
        guard runs.count > keptRuns else { return (runs, messages, false) }
        let newest = Array(runs.suffix(keptRuns))
        let ids = Set(newest.flatMap(\.messageIds) + pending)
        return (newest, messages.filter { ids.contains($0.key) }, true)
    }

    private func persistConversation() async -> Bool {
        guard let persistence, snapshot.loaded || !outgoing.isEmpty else { return true }
        let window = Self.kept(runs: transcript.runs.map { ($0.id, $0.messageIds) }, messages: transcript.messages, pending: transcript.pending)
        let kept = KeptConversation(runs: window.runs.map { .init(id: $0.id, messageIds: $0.messageIds, time: transcript.times[$0.id]) }, messages: window.messages, pending: transcript.pending,
            outgoing: outgoing.filter({ held[$0.id] == nil }).map { .init(id: $0.id, text: $0.text, pictures: $0.pictures.map { .init(mimeType: $0.mimeType, data: $0.data) }, accepted: $0.accepted, failure: $0.failure, mode: outgoingModes[$0.id], files: outgoingFiles[$0.id], at: outgoingTimes[$0.id],
                toolRequest: outgoingTools[$0.id]) }, mode: mode, hasMore: snapshot.hasMore || window.trimmed, slashCommands: snapshot.slashCommands)
        guard kept != lastKept || conversationWrite != nil else { return true }
        let key = "conversation:\(agentId)"
        let claim = checkpointClaim(for: key)
        let owner = checkpointOwner
        let cleanedIDs = attachmentCleanup.subtracting(kept.outgoing.map(\.id))
        do {
            let value = try JSONEncoder().encode(kept)
            // A forced save can enter while a debounced save is suspended.
            // Chain writes so an older snapshot cannot follow this checkpoint
            // and restore a reference after its files have been removed.
            let preceding = conversationWrite
            let write = Task {
                _ = try? await preceding?.value
                try await claim.value
                return try await persistence.keepConversation(key, value: value, owner: owner)
            }
            conversationWrite = write
            let committed = try await write.value
            if conversationWrite == write {
                conversationWrite = nil
                if committed { lastKept = kept }
            }
            // Another instance now owns this cache. Sends still enter the
            // account outbox before the composer clears, but this old view
            // cannot overwrite the new checkpoint or delete its files.
            guard committed else { return true }
            for id in cleanedIDs {
                guard !id.isEmpty, id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }) else { continue }
                try? FileManager.default.removeItem(at: persistence.attachmentDirectory.appendingPathComponent(id, isDirectory: true))
                outgoingFiles.removeValue(forKey: id)
                attachmentCleanup.remove(id)
            }
            return true
        } catch {
            checkpointClaims.removeValue(forKey: key)
            snapshot.error = "Could not save this conversation on this device."; return false
        }
    }

    private func checkpointClaim(for key: String) -> Task<Void, Error> {
        if let claim = checkpointClaims[key] { return claim }
        let persistence = persistence
        let owner = checkpointOwner
        let claim = Task<Void, Error> {
            if let persistence { try await persistence.claimConversation(key, owner: owner) }
        }
        checkpointClaims[key] = claim
        return claim
    }

    // MARK: Slash commands

    /// Runs one of the agent's commands. A skill goes as a message (desktop
    /// aa8a2529), drawn at once and kept like any other; every other command
    /// is asked of the module that offers it, with the mode a message would
    /// go with, and shows in the transcript through the events it causes.
    public func run(_ command: AgentWire.SlashCommand, arguments: String?) async -> SlashCommandOutcome {
        if command.isSkill {
            let message = SlashCommands.skillMessage(command, arguments: arguments)
            return await send(text: message.text, toolRequest: message.toolRequest) ? .accepted : .notSaved
        }
        do {
            let mode = try await sendingMode()
            let commands = try await client.invokeSlashCommand(agentId, name: command.name, arguments: command.hasArguments ? arguments : nil, mode: mode, mutationId: ClientID.make())
            if let commands, commands != snapshot.slashCommands {
                snapshot.slashCommands = commands
                publish()
            }
            return .accepted
        } catch let error as AgentClientError {
            switch error.status {
            case 404:
                // Gone since the palette was drawn: it isn't offered again.
                snapshot.slashCommands.removeAll { $0.name == command.name }
                publish()
                return .unavailable
            case 409: return .busy
            case let status? where status < 500 && status != 408 && status != 429: return .refused
            default: return .unreachable
            }
        } catch {
            return .unreachable
        }
    }

    /// The next message goes with this model, account and effort.
    public func setMode(_ mode: AgentWire.Mode) {
        picked = mode
        self.mode = mode
        snapshot.mode = mode
        publish()
        // A draft is its text with the mode it goes with, empty or not
        // (desktop's `saveMode`): saved at once with this one.
        draft = Draft(text: draft.text, updatedAt: Self.stamp(after: draft.updatedAt), synced: false)
        snapshot.draftUpdatedAt = draft.updatedAt
        draftRevision += 1
        saveDraftSoon(after: .zero)
    }

    /// A run began, perhaps sent from elsewhere with another mode: the
    /// agent's own is read again (`GET /v0/agents/:id/mode`) and shown
    /// unless the person picked one here.
    private func refreshAgentMode() {
        guard creation == nil, modeRefresh == nil else { return }
        modeRefresh = Task { [client, agentId] in
            let current = try? await client.agentMode(agentId)
            modeRefresh = nil
            guard let current else { return }
            agentMode = current
            guard picked == nil, mode != current else { return }
            mode = current
            snapshot.mode = current
            publish()
        }
    }

    /// What a message goes with when nothing was picked: what the person's
    /// next session starts on (`ModelPreferences`), read from this
    /// computer's settings as this phone last has them.
    private func readDefaultMode() -> Task<AgentWire.Mode, Error> {
        Task { [client, persistence] in
            try await client.defaultMode(ModelPreferences(await persistence?.userSettings() ?? [:]))
        }
    }

    private func sendingMode() async throws -> AgentWire.Mode {
        if let mode { return mode }
        let task = defaultMode ?? readDefaultMode()
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
        UploadProgressBoard.shared.clear(message: id)
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
    public func useDrafts(_ drafts: Drafts) async {
        self.drafts = drafts
        defer {
            snapshot.localDraftLoaded = true
            publish()
        }
        // A new task's is kept under the ID named for it here.
        guard let kept = await drafts.draft(agentId), kept.updatedAt > draft.updatedAt else { return }
        draft = kept
        snapshot.draft = kept.text
        snapshot.draftUpdatedAt = kept.updatedAt
        snapshot.draftArrivals += 1
        if !kept.synced { saveDraftSoon(after: .zero) }
    }

    /// Typed here, at `at` (ms since 1970, never going back): kept and
    /// saved after the keystrokes pause, a clear at once.
    public func setDraft(_ text: String, at: Double) {
        guard at > lastDraftEdit else { return }
        lastDraftEdit = at
        guard text != draft.text else { return }
        draft = Draft(text: text, updatedAt: max(at, draft.updatedAt + 1), synced: false)
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
            // A new task's draft stays on this phone until its first message
            // makes the task, then goes under the ID the computer gave it.
            if let creation {
                guard let made = await creation.madeAgentId else {
                    await drafts?.keep(agentId, local)
                    return
                }
                agentId = made
            }
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
        draft = Draft(text: text, updatedAt: stamp, synced: true)
        // Its mode only fills in for an agent whose own isn't known, and
        // never replaces a pick made here.
        if let mode = remote.value?.mode, picked == nil, agentMode == nil {
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

    /// Desktop's failure card actions: the failed turn run again, or with
    /// `mode` moved to that model and continued there. The card shows what
    /// was done at once; the continued run comes as events.
    public func resolveFailure(_ messageId: String, switchTo mode: AgentWire.Mode? = nil) async throws {
        let message = try await client.resolveFailure(agentId, messageId: messageId, switchTo: mode, mutationId: ClientID.make())
        transcript.set(message)
        // Moved there: the next message goes with it too, here and where
        // the draft is read again.
        if let mode { setMode(mode) } else { publish() }
    }

    // MARK: Questions

    /// The agent waits on question `id`, or on none: one it isn't showing
    /// yet is read; one it stopped waiting on leaves the end of the
    /// transcript and settles where it was asked.
    private func waitsOn(_ id: String?) {
        guard let id else {
            askingRead?.cancel(); askingRead = nil
            if let asking, asking.phase != .submitting { self.asking = nil }
            return
        }
        guard asking?.question.id != id, askingRead == nil else { return }
        let client = client
        let agentId = agentId
        askingRead = Task {
            let question = try? await client.question(agentId)
            guard !Task.isCancelled else { return }
            askingRead = nil
            if let question, question.status == "pending" { ask(question) }
        }
    }

    private func ask(_ question: AgentWire.Question) {
        guard question.agentId == nil || question.agentId == agentId, answered[question.id] == nil else { return }
        if asking?.question.id == question.id { return }
        asking = ChatItem.Ask(question: question, phase: .pending)
        publish()
        // Answered here before a relaunch and not yet taken: still sending.
        guard let persistence else { return }
        Task {
            guard let answers = await persistence.pendingAnswer(question.id),
                  let kept = await persistence.intents.pending().first(where: { $0.kind == .answer && $0.target == question.id }),
                  self.asking?.question.id == question.id, self.asking?.phase == .pending else { return }
            self.asking?.phase = .submitting
            publish()
            await settleAnswer(kept, question: question, answers: answers, persistence: persistence)
        }
    }

    /// Waits for the computer to take or refuse an answer on its way.
    private func settleAnswer(_ kept: Intent, question: AgentWire.Question, answers: [String: [String]], persistence: SyncEngine) async {
        // The person waits on it: tried at once, then kept until it goes.
        Task { await persistence.intents.attempt(kept.id) }
        let taken = await persistence.intents.outcome(kept.id)
        guard self.asking?.question.id == question.id else { return }
        if taken {
            var question = question
            question.status = "answered"
            question.answers = answers
            settle(question: question)
        } else {
            self.asking?.phase = .failed("")
            publish()
        }
    }

    /// Someone answered it, here or elsewhere, or the run stopped needing it.
    private func settle(question: AgentWire.Question) {
        if question.status == "answered" { answered[question.id] = question }
        if asking?.question.id == question.id { asking = nil }
        publish()
    }

    private func questionEvent(_ event: JSONValue) {
        let payload = event["payload"] ?? .null
        switch event["type"]?.stringValue {
        case "question.created":
            guard let question = payload["question"].flatMap({ Self.decode(AgentWire.Question.self, $0) }), question.agentId == agentId,
                  question.status == "pending" else { return }
            ask(question)
        case "question.updated":
            guard let id = payload["questionId"]?.stringValue, var question = asking?.question, question.id == id,
                  let status = payload["changes"]?["status"]?.stringValue, status != "pending" else { return }
            question.status = status
            if let answers = payload["changes"]?["answers"].flatMap({ Self.decode([String: [String]].self, $0) }) { question.answers = answers }
            settle(question: question)
        default:
            return
        }
    }

    /// Answers the question the agent waits on, each prompt by its ID
    /// (desktop's `answerInputRun`): shown as sending at once, settled when
    /// the computer takes it. A refusal says why, and the answer may go
    /// again; one that lost to another answer shows that one.
    public func answer(_ answers: [String: [String]]) async {
        guard var asking, asking.phase != .submitting, asking.phase != .answered else { return }
        asking.phase = .submitting
        self.asking = asking
        publish()
        if let persistence {
            // Kept and sent as one, offline or not; shown as sending until
            // the computer takes it, and through a relaunch.
            guard let kept = await persistence.answer(asking.question.id, agentId: agentId, answers: answers) else {
                if self.asking?.question.id == asking.question.id { self.asking?.phase = .failed(""); publish() }
                return
            }
            await settleAnswer(kept, question: asking.question, answers: answers, persistence: persistence)
            return
        }
        do {
            let returned = try await client.answerQuestion(agentId, questionId: asking.question.id, answers: answers, mutationId: ClientID.make())
            // What was asked stays as it was asked; the reply may carry only its outcome.
            var question = asking.question
            question.status = returned.status
            question.answers = returned.answers ?? answers
            settle(question: question)
        } catch {
            if case .status(409, _, _)? = error as? AgentClientError {
                // Answered or abandoned already: what stands now is read again.
                let current = try? await client.question(agentId)
                if current?.id == asking.question.id { self.asking?.phase = .pending; publish() }
                else { self.asking = nil; publish() }
                return
            }
            guard self.asking?.question.id == asking.question.id else { return }
            self.asking?.phase = .failed(Store.describe(error))
            publish()
        }
    }

    /// Read at once on this phone, and kept until the computer hears
    /// (`SyncEngine.markRead`); standalone, asked directly.
    private func markRead() {
        let client = client
        let agentId = agentId
        if let persistence {
            Task { await persistence.markRead(agentId) }
            return
        }
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
    static func pieces(_ text: String, shown: [String: Media], streaming: Bool) -> [ChatItem.Piece] {
        made(text, shown: shown, streaming: streaming).pieces
    }

    /// `pieces`, and whether a layout block was among them: only then can
    /// what was shown earlier change them.
    private static func made(_ text: String, shown: [String: Media], streaming: Bool) -> (pieces: [ChatItem.Piece], layout: Bool) {
        var layouts = false
        var pieces: [ChatItem.Piece] = []
        func markdown(_ text: String) {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            if case .text(let previous)? = pieces.last { pieces[pieces.count - 1] = .text(previous + "\n\n" + trimmed) } else { pieces.append(.text(trimmed)) }
        }
        // A reference tag still arriving is held back, not flashed as raw text.
        let text = streaming ? HappyReferences.droppingPartialTag(text) : text
        for segment in MediaBlocks.split(text) {
            switch segment {
            case .markdown(let text):
                markdown(text)
            case .layout(let layout):
                layouts = true
                if !layout.complete {
                    if !streaming { markdown(layout.raw) }
                    continue
                }
                // Each `src` names one item; the same item twice is the same index.
                var media: [Media] = []
                let parsed = MediaTree.parse(html: layout.raw) { source in
                    guard let found = shown[source] else { return nil }
                    if let index = media.firstIndex(where: { $0.key == found.key }) { return index }
                    media.append(found)
                    return media.count - 1
                }
                guard !parsed.placed.isEmpty, !parsed.truncated else { markdown(layout.raw); continue }
                pieces.append(.tree(media, parsed.tree))
            }
        }
        return (pieces, layouts)
    }

    // MARK: Rows, made again only where something moved

    /// A run's rows as last made, and what from: its revision
    /// (`Transcript`), whether it was streaming, and `itemContext`. A run
    /// nothing moved in is drawn as it was without looking into it.
    private struct MadeRun {
        var revision: UInt64
        var streaming: Bool
        var context: UInt64
        var items: [ChatItem]
        /// Media its calls showed, by path, for a later layout block.
        var shows: [String: Media]
        /// A layout block in it named media shown before it, which may
        /// have moved: made again on each publish.
        var readsShown: Bool
        /// It has something of this agent's own (`produced`).
        var produces: Bool
    }

    /// A message's rows as last made, as `MadeRun`, with each block's part.
    private struct MadeMessage {
        var revision: UInt64
        var streaming: Bool
        var turn: String?
        var context: UInt64
        var items: [ChatItem] = []
        var shows: [String: Media] = [:]
        var readsShown = false
        var produces = false
        var tools = 0
        /// Each text block's pieces and each call's row, by block index.
        var blocks: [Int: MadeBlock] = [:]
        /// Each run of words' row, by its ID, with what it was made from.
        var segments: [String: (key: SegmentKey, item: ChatItem)] = [:]
    }

    /// A block's part of its message's rows, at the block's revision.
    private struct MadeBlock {
        var revision: UInt64
        var streaming: Bool
        var context: UInt64
        /// Made for an agent's own words, not dialogue.
        var agentRole: Bool
        var callId = ""
        /// A text block's pieces; for a call, what it showed, before any
        /// proposal shown earlier in the message is left out.
        var pieces: [ChatItem.Piece]
        /// What a call showed, by path; nil for a call that showed nothing.
        var shows: [String: Media]?
        /// A call's own row, and the pieces it was made with; nil, once
        /// `decided`, for a call drawn as no row.
        var row: (item: ChatItem, showing: [ChatItem.Piece])?
        var decided = false
        /// A layout block named shown media: never taken again.
        var layout = false
    }

    /// What a run of words' row is made from: its blocks at their
    /// revisions, and what else its pieces read. The same again, the row
    /// is the same.
    private struct SegmentKey: Equatable {
        var blocks: [UInt64]
        var proposed: Set<String>
        var manager: String?
        var streaming: Bool
        var role: ChatItem.Role
        var delivery: ChatItem.Delivery
        var time: Double?
        var author: String?
        var turn: String?
    }

    /// How a send stands, which alone moves its row.
    private struct SendKey: Equatable {
        var delivery: ChatItem.Delivery
        var time: Double?
        var files: [URL]
        var previews: [String]
    }

    /// Rows of messages and runs let go of are forgotten (after a read, a trim).
    private func forgetUnheld() {
        madeRuns = madeRuns.filter { transcript.run($0.key) != nil }
        madeMessages = madeMessages.filter { transcript[message: $0.key] != nil }
    }

    private func madeRun(_ run: Transcript.Run, streaming: Bool, shown: inout [String: Media]) -> MadeRun {
        let revision = transcript.revision(ofRun: run.id)
        if let old = madeRuns[run.id], old.revision == revision, old.streaming == streaming, old.context == itemContext, !old.readsShown {
            shown.merge(old.shows) { _, new in new }
            return old
        }
        var made = MadeRun(revision: revision, streaming: streaming, context: itemContext, items: [], shows: [:], readsShown: false, produces: false)
        var tools = 0
        var lastAgent: ChatItem?
        for id in run.messageIds {
            guard let message = transcript[message: id] else { continue }
            let rows = madeMessage(message, shown: &shown, streaming: streaming, turn: run.id)
            made.items += rows.items
            made.shows.merge(rows.shows) { _, new in new }
            made.readsShown = made.readsShown || rows.readsShown
            made.produces = made.produces || rows.produces
            tools += rows.tools
            if let last = rows.items.last(where: { $0.role == .agent }) { lastAgent = last }
        }
        // Ended: how, after how long, and the answer to copy (desktop's `turnStatus`).
        if let time = transcript.times[run.id], let ended = time.endedAt {
            let answer = lastAgent.map(\.text).flatMap { $0.isEmpty ? nil : $0 }
            let turnEnd = ChatItem.TurnEnd(reason: time.reason ?? "completed", durationMs: time.startedAt.map { max(0, ended - $0) }, tools: tools, copyText: answer, endedAt: ended)
            let item = ChatItem(id: "\(run.id):status", role: .turnEnd(turnEnd), pieces: [], delivery: .sent, turn: run.id)
            if let kept = madeRuns[run.id]?.items.last, kept == item { made.items.append(kept) } else { made.items.append(item.stamped()) }
        }
        madeRuns[run.id] = made
        return made
    }

    private func madeMessage(_ message: AgentWire.Message, shown: inout [String: Media], streaming: Bool, turn: String?) -> MadeMessage {
        let revision = transcript.revision(ofMessage: message.id)
        let old = madeMessages[message.id]
        if let old, old.revision == revision, old.streaming == streaming, old.turn == turn, old.context == itemContext, !old.readsShown {
            shown.merge(old.shows) { _, new in new }
            return old
        }
        var made = MadeMessage(revision: revision, streaming: streaming, turn: turn, context: itemContext)
        made.produces = message.role != "user" && !message.content.isEmpty && (message.metadata?.senderAgentId ?? agentId) == agentId
        if message.role == "agent" { made.tools = message.content.reduce(0) { if case .toolCall = $1 { $0 + 1 } else { $0 } } }
        items(message, old: old, made: &made, shown: &shown)
        madeMessages[message.id] = made
        return made
    }

    /// What an `agent.updated` can change of what is drawn.
    private struct AgentState: Equatable {
        var status: String
        var working: Bool
        var wait: AgentWire.AgentWait?
        var retrying: AgentWire.AgentRetrying?
        var question: Bool
        var asking: String?
        var subagentsRunning: Int
        var title: String?
        var run: String?
        var startedAt: Double?
    }

    private var agentState: AgentState {
        AgentState(status: status, working: snapshot.working, wait: wait, retrying: retrying, question: question, asking: asking?.question.id,
                   subagentsRunning: subagentsRunning, title: snapshot.title, run: activeRun?.id, startedAt: activeRun?.startedAt)
    }

    private func publish() {
        publishing?.cancel(); publishing = nil
        keepConversation()
        var items: [ChatItem] = []
        // What a layout block's `<img src>` can name: media shown earlier.
        var shown: [String: Media] = [:]
        var produced = false
        let last = transcript.lastRunId
        for run in transcript.runs {
            // The newest run while the agent works may end mid-block.
            let made = madeRun(run, streaming: snapshot.working && run.id == last, shown: &shown)
            items += made.items
            if run.id == activeRun?.id { produced = made.produces }
        }
        // A question waiting on the person is pinned to the end, under the work.
        if let asking { items.append(ChatItem(id: asking.question.id, role: .question(asking), pieces: [], delivery: .sent)) }
        for id in transcript.pending {
            if let message = transcript[message: id] { items += madeMessage(message, shown: &shown, streaming: false, turn: nil).items }
        }
        var sends: [String: (key: SendKey, item: ChatItem)] = [:]
        for send in outgoing {
            // A send's words and pictures stay as sent: only how it stands
            // and what of it is on its way move its row.
            let delivery: ChatItem.Delivery = send.failure.map { .failed($0) } ?? (send.accepted ? .pending : .sending)
            let key = SendKey(delivery: delivery, time: outgoingTimes[send.id], files: (outgoingFiles[send.id] ?? []).map(\.fileURL), previews: (held[send.id] ?? []).map(\.id))
            if let kept = madeSends[send.id], kept.key == key {
                sends[send.id] = kept
                items.append(kept.item)
                continue
            }
            var pieces: [ChatItem.Piece] = send.text.isEmpty ? [] : [.text(send.text)]
            for (offset, picture) in send.pictures.enumerated() {
                pieces.append(.picture(id: "\(send.id):\(offset + 1)", mimeType: picture.mimeType, data: picture.data))
            }
            for (offset, file) in (outgoingFiles[send.id] ?? []).enumerated() {
                pieces.append(.sentFile(ChatItem.SentFile(id: UploadProgressBoard.fileKey(send.id, offset), name: AttachmentRules.safeName(file.name),
                    mimeType: file.mimeType, file: file.fileURL, width: file.width, height: file.height)))
            }
            for (offset, preview) in (held[send.id] ?? []).enumerated() {
                pieces.append(.sentFile(ChatItem.SentFile(id: UploadProgressBoard.previewKey(send.id, offset), name: "",
                    mimeType: "image/jpeg", file: preview.thumbnail, width: preview.width, height: preview.height)))
            }
            let item = ChatItem(id: send.id, role: .user, pieces: pieces, delivery: delivery, time: outgoingTimes[send.id]).stamped()
            sends[send.id] = (key, item)
            items.append(item)
        }
        madeSends = sends
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
        snapshot.activity = Activity.project(
            working: snapshot.working, status: status, wait: wait, retrying: retrying, question: question,
            subagentsRunning: subagentsRunning, produced: produced, startedAt: activeRun?.startedAt
        )
        continuation.yield(snapshot)
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
        if agent.id == agentId { waitsOn(agent.pendingQuestionId) }
        subagentsRunning = agent.subagents?.running ?? 0
        if agent.id == agentId {
            parentAgentId = agent.parentAgentId
            snapshot.title = agent.title
        }
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

    /// A message's rows: a person's words, a failure, another agent's
    /// message, or the agent's words split where each tool call it made
    /// stands as its own row (desktop's `agent_text` and `tool_call`
    /// elements), in the order it made them.
    ///
    /// Made into `made`, in its run `made.turn`, from `old`, the rows last
    /// made of it: each block whose revision hasn't moved gives its part
    /// as it did, and each row whose blocks haven't is the same row, so a
    /// word arriving makes again only the row it lands in.
    private func items(_ message: AgentWire.Message, old: MadeMessage?, made: inout MadeMessage, shown: inout [String: Media]) {
        let turn = made.turn
        if message.role == "service" {
            // A compaction is a step of its run, as desktop's projection
            // makes it a `compact` call.
            let compactions = message.content.compactMap { block -> AgentWire.Compaction? in
                guard case .compaction(let compaction) = block else { return nil }
                return compaction
            }.enumerated().map { index, compaction in
                ChatItem(id: index == 0 ? message.id : "\(message.id)/\(index)", role: .tool(Self.compactionTool(compaction)), pieces: [], delivery: .sent, turn: turn).stamped()
            }
            if !compactions.isEmpty { made.items = compactions; return }
            // Only a failure is shown, as desktop's card; other service
            // messages are the daemon's housekeeping.
            guard let failure = Failure.of(message) else { return }
            made.items = [ChatItem(id: message.id, role: .failure(failure), pieces: [.text(failure.reason)], delivery: .sent, turn: turn).stamped()]
            return
        }
        if message.role == "user" || message.role == "agent", let sender = Self.collaborator(message, agentId: agentId, parentAgentId: parentAgentId) {
            // Its words as they came, read only when opened; desktop trims the
            // daemon's addressing line from an agent-role message alone.
            let text = message.content.compactMap { block -> String? in if case .text(let text) = block { text } else { nil } }.joined(separator: "\n")
            let body = message.role == "agent" ? Self.inboundText(text, agentId: sender.agentId) : text
            let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
            made.items = [ChatItem(id: message.id, role: .collaborator(agentId: sender.agentId, explanation: sender.explanation), pieces: trimmed.isEmpty ? [] : [.text(trimmed)], delivery: .sent, turn: turn).stamped()]
            return
        }
        // The agent that manages this one gives it its work: desktop reads
        // that as dialogue, in the lane the person's own words take.
        let manager = message.role == "agent" ? message.metadata?.senderAgentId.flatMap { $0 == agentId ? nil : $0 } : nil
        let role: ChatItem.Role
        switch message.role {
        case "user": role = .user
        case "agent": role = manager == nil ? .agent : .user
        default: return
        }
        let agentRole = role == .agent
        let delivery: ChatItem.Delivery = role == .user && message.status == "pending" ? .pending : .sent
        let time = role == .user ? message.createdAt : nil
        let author = message.role == "user" ? message.metadata?.userId : nil
        let streaming = made.streaming || message.status == "streaming"
        var pieces: [ChatItem.Piece] = []
        // The words before the first call keep the message's ID; each run
        // of words after a call is named by the block it starts at.
        var segment = message.id
        var segmentBlocks: [UInt64] = []
        var segmentLayout = false
        var proposed: Set<String> = []
        var proposedBefore: Set<String> = []
        func flush(next: String) {
            if !pieces.isEmpty {
                let key = SegmentKey(blocks: segmentBlocks, proposed: proposedBefore, manager: manager, streaming: streaming, role: role, delivery: delivery, time: time, author: author, turn: turn)
                let item: ChatItem
                if !segmentLayout, let kept = old?.segments[segment], kept.key == key {
                    item = kept.item
                } else {
                    item = ChatItem(id: segment, role: role, pieces: pieces, delivery: delivery, turn: turn, time: time, author: author).stamped()
                }
                // Made from shown media, which may move: made again each time.
                if !segmentLayout { made.segments[segment] = (key, item) }
                made.items.append(item)
            }
            pieces = []
            segmentBlocks = []
            segmentLayout = false
            proposedBefore = proposed
            segment = next
        }
        /// A call's own row: as it was while its block, its run and what it
        /// showed are; else made again.
        func row(_ block: inout MadeBlock, showing: [ChatItem.Piece], make: () -> ChatItem.Role?) -> ChatItem? {
            if let kept = block.row, kept.showing == showing {
                guard kept.item.turn != turn else { return kept.item }
                var item = kept.item
                item.turn = turn
                block.row = (item.stamped(), showing)
                return block.row?.item
            }
            guard block.decided == false || block.row != nil, let role = make() else {
                block.decided = true
                block.row = nil
                return nil
            }
            block.decided = true
            block.row = (ChatItem(id: block.callId, role: role, pieces: showing, delivery: .sent, turn: turn).stamped(), showing)
            return block.row?.item
        }
        for (index, block) in message.content.enumerated() {
            let revision = transcript.revision(ofBlock: index, in: message.id)
            let kept = old?.blocks[index].flatMap { $0.revision == revision && $0.context == itemContext && $0.agentRole == agentRole ? $0 : nil }
            switch block {
            case .text(let text):
                segmentBlocks.append(revision)
                guard agentRole else {
                    let trimmed = (manager.map { Self.inboundText(text, agentId: $0) } ?? text).trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty else { continue }
                    pieces.append(.text(trimmed))
                    continue
                }
                // Split into pieces once per word that reaches it; a block
                // with a layout block reads shown media, which may move.
                if let kept, kept.streaming == streaming, !kept.layout {
                    made.blocks[index] = kept
                    pieces += kept.pieces
                    continue
                }
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                let split = trimmed.isEmpty ? (pieces: [ChatItem.Piece](), layout: false) : Self.made(trimmed, shown: shown, streaming: streaming)
                made.blocks[index] = MadeBlock(revision: revision, streaming: streaming, context: itemContext, agentRole: agentRole, pieces: split.pieces, layout: split.layout)
                if split.layout { segmentLayout = true; made.readsShown = true }
                pieces += split.pieces
            case .image(let mimeType, let data):
                segmentBlocks.append(revision)
                let key = "\(message.id):\(index)"
                if pictures[key] == nil { pictures[key] = Data(base64Encoded: data) }
                if let bytes = pictures[key] { pieces.append(.picture(id: key, mimeType: mimeType, data: bytes)) }
            case .toolCall(let id, let name, let status, let presentation, let arguments, let output, let result, let review):
                var call = kept ?? MadeBlock(revision: revision, streaming: false, context: itemContext, agentRole: agentRole, callId: id, pieces: [])
                if kept == nil {
                    var added: [String: Media] = [:]
                    if let shows = presentation.flatMap({ Self.shows($0, toolCallId: id, shown: &added) }) {
                        call.pieces = shows
                        call.shows = added
                    }
                }
                func tool() -> ChatItem.Tool {
                    ChatItem.Tool(name: name, status: status, presentation: presentation, callId: id, arguments: arguments, result: result, review: review)
                }
                if let added = call.shows {
                    shown.merge(added) { _, new in new }
                    made.shows.merge(added) { _, new in new }
                    // One proposal card across every version: a revision redraws its rows.
                    let showing = call.pieces.filter { piece in
                        if case .sidebarProposal(let artifactId) = piece { return proposed.insert(artifactId).inserted }
                        return true
                    }
                    guard agentRole else {
                        segmentBlocks.append(revision)
                        pieces += showing
                        made.blocks[index] = call
                        continue
                    }
                    // Desktop's media and artifact rows: the call's line with
                    // what it showed under it, a row of its own, so it stays
                    // when the turn folds.
                    flush(next: "\(message.id)/\(index + 1)")
                    if let item = row(&call, showing: showing, make: { .tool(tool()) }) { made.items.append(item) }
                    made.blocks[index] = call
                    continue
                }
                guard agentRole else { continue }
                let item = row(&call, showing: []) {
                    guard name == AgentWire.Question.toolName else { return .tool(tool()) }
                    // Pending, it waits at the transcript's end; answered,
                    // it settles here, as what was asked and answered.
                    if asking?.question.id == id { return nil }
                    let question = answered[id] ?? AgentWire.Question.asked(id: id, arguments: arguments, output: output)
                    if let question, question.status == "answered" { return .question(ChatItem.Ask(question: question, phase: .answered)) }
                    return status == "running" ? nil : .tool(tool())
                }
                made.blocks[index] = call
                guard let item else { continue }
                flush(next: "\(message.id)/\(index + 1)")
                made.items.append(item)
            case .reasoning, .compaction, .unknown:
                continue
            }
        }
        flush(next: "")
    }

    static func compactionTool(_ compaction: AgentWire.Compaction) -> ChatItem.Tool {
        let status = ["running", "completed", "failed"].contains(compaction.status) ? compaction.status : "completed"
        return ChatItem.Tool(name: "compact", status: status, presentation: AgentWire.Presentation(
            type: "compaction", tokensBefore: compaction.tokensBefore, tokensAfter: compaction.tokensAfter
        ))
    }

    /// What a call showed the person, as pieces of the message: pictures
    /// and files, an artifact's card, a sidebar proposal. Nil for
    /// a call that showed nothing, which is a tool row.
    private static func shows(_ presentation: AgentWire.Presentation, toolCallId id: String, shown: inout [String: Media]) -> [ChatItem.Piece]? {
        if presentation.type == "artifact", let artifactId = presentation.artifactId, presentation.artifactType == "sidebar_proposal" {
            return [.sidebarProposal(artifactId: artifactId)]
        }
        if presentation.type == "artifact", let artifactId = presentation.artifactId {
            // A `story` artifact is Stories', which this app doesn't have:
            // its call is a tool row like any other.
            if presentation.artifactType == "story" { return nil }
            return [.artifact(Artifact(
                id: artifactId, version: presentation.version ?? 1, type: presentation.artifactType ?? "unknown",
                title: presentation.title ?? "", followsLatest: presentation.shows == "latest"
            ))]
        }
        guard presentation.type == "media" else { return nil }
        let media = (presentation.items ?? []).enumerated().map { Media(toolCallId: id, index: $0.offset, item: $0.element) }
        for one in media {
            // Named by a later layout block, by either path; the latest wins.
            if let source = one.item.source {
                shown[source.path] = one
                shown[source.absolutePath] = one
            }
        }
        if let tree = MediaTree.decode(presentation.layout, itemCount: media.count) { return [.tree(media, tree)] }
        var pieces: [ChatItem.Piece] = []
        let visual = media.filter(\.isVisual)
        if !visual.isEmpty { pieces.append(.gallery(visual, columns: columns(presentation.layout, count: visual.count))) }
        for one in media where !one.isVisual { pieces.append(.file(one)) }
        return pieces
    }
}
