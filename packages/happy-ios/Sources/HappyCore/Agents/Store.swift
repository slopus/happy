import Foundation
import HappyWire

/// What the V2 sidebar shows, made off the main thread.
public struct Snapshot: Equatable, Sendable {
    public enum Availability: Equatable, Sendable {
        /// Nothing read yet.
        case loading
        /// The daemon's sidebar, or the last one kept on this phone until it answers.
        case available
        /// A daemon from before the sidebar document.
        case unsupported
    }

    public var availability: Availability = .loading
    /// Whether the events stream is open, so what shows is live.
    public var live = false
    /// The rows a fold leaves showing, in order.
    public var rows: [Row] = []
    /// Every row, folded away or not, for search.
    public var allRows: [Row] = []
    /// The document those rows are drawn from, for gestures that edit it.
    public var document: SpaceSidebarDocument?
    /// Happy's own conversation, which Settings' asks are typed into
    /// (`ChatPrefill`); nil until the bots have been read, or where the
    /// account has no Chief of Staff running.
    public var happyAgentId: String?
    /// The bots' own conversations, by agent id.
    public var botAgentIds: Set<String> = []
    /// The person's V2 setting, which runs Prioritizing; nil until read.
    public var prioritizing: Bool?
    /// The last act the daemon refused: its reason, empty when it gave none.
    public var error: String?
    /// What the references in messages read as and open.
    public var references = References()

    public init() {}
}

/// One paired computer's V2 sidebar, a port of desktop's
/// `spacesStore.ts` in its document mode: the document the daemon was last
/// heard to hold, with this phone's unconfirmed edits applied on top by the
/// same function the daemon applies them with, so a confirmation draws
/// exactly what was already drawn and nothing moves.
public actor Store {
    /// The opaque user setting that runs Prioritizing.
    public static let settingKey = "happy-desktop.experiments.stemCells"
    static let attentionRenew: Duration = .seconds(60)
    static let attentionCalm: Duration = .seconds(300)

    private let client: AgentClient
    private let offline: OfflineFile?
    /// The account's pending actions (`SyncEngine.intents`): archives,
    /// leaves and renames are kept and sent through it, and laid over the
    /// rows until the computer answers. Nil standalone: asked directly.
    private let intents: IntentOutbox?
    private var overlay = IntentOverlay()
    private var keeping: Task<Void, Never>?
    private let labels: Rows.Labels
    private let continuation: AsyncStream<Snapshot>.Continuation
    public nonisolated let updates: AsyncStream<Snapshot>

    private var snapshot = Snapshot()
    private var sidebarReadSucceeded = false
    private var following: Task<Void, Never>?
    /// The last Prioritizing write; each waits for the one before, so the
    /// daemon ends on the last choice.
    private var prioritizingWrite: Task<Void, Never>?
    private var prioritizingWrites = 0
    /// What the daemon last said Prioritizing is; a refused write, the
    /// last one asked for, shows this again.
    private var prioritizingDaemon: Bool?
    private var cursor: String?
    private var capabilities = AgentWire.Health.Capabilities()

    // The document.
    private var artifactId: String?
    /// The document the daemon was last heard to hold.
    private var held: (version: Int, html: String)?
    private struct Batch { let mutationId: String; let operations: [SpaceSidebarOperation]; let base: SpaceSidebarDocument }
    /// This phone's edits the daemon has not confirmed yet, oldest first.
    private var batches: [Batch] = []
    /// Rows taken off here, by document node, as desktop's `removals`: off
    /// the sidebar at once, before the computer hears (work archived or
    /// left), and kept off through every read and event
    /// that still lists them. Let go of once the computer no longer has
    /// them: a space at `space.removed` or a full read without it, a
    /// subtask once no bot or task holds it. Back only on a refusal.
    private var removing: [String: Removal] = [:]
    private struct Removal {
        /// A subtask's conversation, which the lists hold rather than the spaces.
        let subtask: Bool
        /// The ask, which a second press shares: true once the computer
        /// took it or had nothing to take, false when it refused.
        let asked: Task<Bool, Never>
    }
    private var writes = 0
    private var dragging = false
    /// An event or read waited for the hand to lift.
    private var stale = false
    private var loading: Task<Void, Never>?
    /// Events that arrived while the authoritative read was in flight.
    private var heldEvents: [JSONValue]?
    private var writeQueue: Task<Void, Never>?

    // What the rows are drawn from.
    private var spaces: [String: AgentWire.Space] = [:]
    private var agentIcons: [String: AgentWire.LibraryIcon] = [:]
    private var bots: [JSONValue] = []
    private var tasks: [JSONValue] = []
    private var surfaces: [AgentWire.Surface] = []
    /// The bots, tasks and Surfaces as the account's bootstrap has them
    /// (`SyncEngine`), which never reads them here: what references name.
    private var bootstrapped: (owners: [JSONValue], surfaces: [AgentWire.Surface])?
    private var agents = Agents()
    /// Artifact titles references asked for, as read; and those being read.
    private var artifactTitles: [String: References.Artifact] = [:]
    private var artifactPages: [String: References.Page] = [:]
    private var artifactApps: [String: Int] = [:]
    private var artifactGenUI: [String: References.GenUI] = [:]
    private var artifactReads: Set<String> = []
    /// People messages mention, as named, and those being read; the person reading.
    private var userNames: [String: String] = [:]
    private var userReads: Set<String> = []
    private var usersMissing: Set<String> = []
    private var me: String?
    private var places = Places()
    private var placesReload: Task<Void, Never>?
    /// Paused since the stream last opened (`externalOpening`).
    private var pausedSinceOpening = false
    /// How many times the client the stream and queries share was let go
    /// (`SyncEngine.resetCarrier`): a read on its way dies with it, and is
    /// asked again without saying it failed.
    public private(set) var carrierResets = 0
    private var placesDirty = false
    /// When the bots and tasks were last read (~0.8 MB on a busy
    /// computer), and what came meanwhile that their read could not follow.
    private var placesRead: ContinuousClock.Instant?
    private var placesHeld: [JSONValue]?
    /// Tasks `task.created` told of that aren't the person's yet: one
    /// takes its place in their list when they join it (`task.joined`).
    private var announcedTasks: [String: JSONValue] = [:]
    /// Whether the bots and tasks were read yet: before then they aren't held.
    private var placesLoaded = false
    /// How soon after a read news may read the bots and tasks again.
    private let placesRereadInterval: Duration
    /// An `agent.updated` the sidebar follows, drawn with the others that
    /// come within 250 ms (`followAgentsSoon`).
    private var followingAgents: Task<Void, Never>?
    /// Names given here whose rename no read has carried yet.
    private var titleIntents: [String: (title: String, base: String?)] = [:]

    // Attention: Prioritizing holds its batches while the person is in the list.
    private var attention: (state: String, at: ContinuousClock.Instant)?
    private var attentionIdle: Task<Void, Never>?
    private var attentionVisible = true

    public init(client: AgentClient, offline: OfflineFile? = nil, intents: IntentOutbox? = nil, labels: Rows.Labels = Rows.Labels(), placesRereadInterval: Duration = .seconds(10)) {
        self.client = client
        self.placesRereadInterval = placesRereadInterval
        self.offline = offline
        self.intents = intents
        self.labels = labels
        (updates, continuation) = AsyncStream.makeStream(of: Snapshot.self, bufferingPolicy: .bufferingNewest(1))
    }

    // MARK: Life

    /// SyncEngine owns the stream for account-backed sessions. The
    /// standalone start() remains available for existing fixtures/consumers.
    public func startExternal() async { await restoreOffline() }

    @discardableResult
    public func externalResync(loadSidebar: Bool) async -> Bool {
        resync(from: nil)
        snapshot.live = true
        if loadSidebar {
            await load()
            return sidebarReadSucceeded
        }
        publish()
        return true
    }

    /// The account's stream opens (`SyncEngine`): the conversations
    /// followed are read at once, beside it. `replays`: it picks up where
    /// it left off, and only those on screen are read.
    public func externalOpening(replays: Bool = false) {
        let stale = pausedSinceOpening
        pausedSinceOpening = false
        for listener in listeners.values { listener.continuation.yield(.resync(from: nil, stale: stale, replays: replays)) }
    }

    public func carrierReset() { carrierResets += 1 }

    /// The account's stream is open. It carries everything after
    /// `missedBefore`; what came before it, those following read again.
    /// Nil: it picked up where it left off and replays what they missed.
    public func externalOpened(missedBefore cursor: String?) {
        if let cursor { resync(from: cursor) }
        snapshot.live = true
        publish()
    }

    private func resync(from cursor: String?) {
        for listener in listeners.values { listener.continuation.yield(.resync(from: cursor)) }
        for listener in typeListeners.values { listener.continuation.yield(.resync(from: cursor)) }
    }

    /// What the server's health says it serves, read with the account's
    /// bootstrap: what Gen UI's actions may run (`References.genUIServed`).
    public func externalCapabilities(_ capabilities: AgentWire.Health.Capabilities?) {
        let capabilities = capabilities ?? AgentWire.Health.Capabilities()
        guard capabilities != self.capabilities else { return }
        self.capabilities = capabilities
        publish()
    }

    /// The bots, tasks and Surfaces from the account's bootstrap, kept
    /// current by its stream, for references to name and open.
    public func externalDirectory(owners: [JSONValue], surfaces: [AgentWire.Surface]) {
        guard bootstrapped?.owners != owners || bootstrapped?.surfaces != surfaces else { return }
        bootstrapped = (owners, surfaces)
        publish()
    }

    public func externalEvent(_ envelope: JSONValue) {
        hand(envelope)
        receive(envelope)
    }

    /// The event to whoever follows its conversation or Surface, and to
    /// whoever follows its type: both found by key, not by asking every
    /// follower, for every word an agent writes.
    private func hand(_ envelope: JSONValue) {
        let payload = envelope["payload"]
        if let key = payload?["agentId"]?.stringValue ?? payload?["surfaceId"]?.stringValue ?? payload?["todo"]?["surfaceId"]?.stringValue {
            for id in keyed[key] ?? [] { listeners[id]?.continuation.yield(.event(envelope)) }
        }
        guard let type = envelope["type"]?.stringValue, !prefixed.isEmpty else { return }
        var heard = Set<UUID>()
        for prefix in Self.prefixes(of: type) {
            for id in prefixed[prefix] ?? [] where heard.insert(id).inserted {
                guard let listener = typeListeners[id], listener.wanted?(envelope) ?? true else { continue }
                listener.continuation.yield(.event(envelope))
            }
        }
    }

    /// What `events(matching:)` may follow `type` by: it whole, and each
    /// part of it up to a dot (`space.`, `space.sidebar.`, …).
    static func prefixes(of type: String) -> [String] {
        var prefixes = [type]
        var index = type.startIndex
        while let dot = type[index...].firstIndex(of: ".") {
            let next = type.index(after: dot)
            if next < type.endIndex { prefixes.append(String(type[..<next])) }
            index = next
        }
        return prefixes
    }

    public func start() {
        guard following == nil else { return }
        following = Task { [weak self] in
            await self?.restoreOffline()
            await self?.follow()
        }
    }

    /// Closes the events stream while the app is in the background; what
    /// shows stays, and `start` resumes from the last cursor.
    public func pause() {
        pausedSinceOpening = true
        following?.cancel(); following = nil
        // Kept now rather than after the app may have been closed.
        if let keeping { keeping.cancel(); self.keeping = nil; saveOffline() }
        if snapshot.live { snapshot.live = false; publish() }
    }

    /// Waits for every edit already made to be written or refused.
    public func flush() async {
        while let queue = writeQueue {
            await queue.value
            if writeQueue == queue { break }
        }
    }

    public func stop() async {
        await flush()
        following?.cancel(); following = nil
        loading?.cancel(); loading = nil
        placesReload?.cancel(); placesReload = nil; placesHeld = nil
        followingAgents?.cancel(); followingAgents = nil
        attentionIdle?.cancel(); attentionIdle = nil
        keeping?.cancel(); keeping = nil
        continuation.finish()
        await client.close()
    }

    private func follow() async {
        var attempt = 0
        while !Task.isCancelled {
            do {
                let frames = try await client.events(after: cursor)
                for try await frame in frames {
                    if frame.event == "hello" {
                        attempt = 0
                        let hello = try? JSONValue.decode(Data(frame.data.utf8))
                        let resumed = hello?["resumed"]?.boolValue == true && hello?["gap"]?.boolValue != true
                        if let next = hello?["cursor"]?.stringValue, !resumed || cursor == nil { cursor = next }
                        snapshot.live = true
                        if !resumed { resync(from: hello?["cursor"]?.stringValue ?? "") }
                        if !resumed || held == nil { await load() } else { publish() }
                        continue
                    }
                    if let id = frame.id { cursor = id }
                    guard let envelope = try? JSONValue.decode(Data(frame.data.utf8)) else { continue }
                    hand(envelope)
                    receive(envelope)
                }
            } catch AgentClientError.revoked {
                snapshot.live = false; publish()
                return
            } catch {}
            if Task.isCancelled { return }
            if snapshot.live { snapshot.live = false; publish() }
            let delay = min(30, 1 << min(attempt, 5))
            attempt += 1
            try? await Task.sleep(for: .seconds(delay))
        }
    }

    // MARK: Conversations

    /// One conversation's events off this store's stream, so an open chat
    /// needs no stream of its own. `resync` means some may have been lost:
    /// read again. `from` is where the stream began, which a read that
    /// began after it covers; nil while it is still opening. `stale`: the
    /// engine was paused since the stream last opened, so a read on its way
    /// may be on a tunnel the suspension left dead. `replays`: the stream
    /// picks up where it left off and brings what was missed; only what is
    /// on screen is read beside it, to show before the replay is through.
    public enum ConversationEvent: Sendable {
        case event(JSONValue)
        case resync(from: String?, stale: Bool = false, replays: Bool = false)
    }

    private var listeners: [UUID: (key: String, continuation: AsyncStream<ConversationEvent>.Continuation)] = [:]
    /// The followers of each key and of each type prefix (`hand`).
    private var keyed: [String: Set<UUID>] = [:]
    private var prefixed: [String: Set<UUID>] = [:]

    /// `key` is a conversation's agent ID, or a Surface's ID for its todos.
    public func conversationEvents(_ key: String) -> AsyncStream<ConversationEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: ConversationEvent.self)
        listeners[id] = (key, continuation)
        keyed[key, default: []].insert(id)
        continuation.onTermination = { [weak self] _ in Task { await self?.unlisten(id) } }
        return stream
    }

    private func unlisten(_ id: UUID) {
        if let key = listeners.removeValue(forKey: id)?.key {
            keyed[key]?.remove(id)
            if keyed[key]?.isEmpty == true { keyed[key] = nil }
        }
        for prefix in typeListeners.removeValue(forKey: id)?.prefixes ?? [] {
            prefixed[prefix]?.remove(id)
            if prefixed[prefix]?.isEmpty == true { prefixed[prefix] = nil }
        }
    }

    private var typeListeners: [UUID: (prefixes: [String], wanted: (@Sendable (JSONValue) -> Bool)?, continuation: AsyncStream<ConversationEvent>.Continuation)] = [:]

    /// Every event whose type starts with one of `prefixes`, for what no
    /// conversation or Surface key names. A prefix ends at a dot
    /// (`"artifact."`) or is a whole type (`"agent.created"`): each is
    /// found by key (`prefixes(of:)`). `wanted`, when given, picks among
    /// them here, so what isn't wanted isn't handed over at all. `resync`
    /// as above.
    public func events(matching prefixes: [String], wanted: (@Sendable (JSONValue) -> Bool)? = nil) -> AsyncStream<ConversationEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: ConversationEvent.self)
        typeListeners[id] = (prefixes, wanted, continuation)
        for prefix in prefixes { prefixed[prefix, default: []].insert(id) }
        continuation.onTermination = { [weak self] _ in Task { await self?.unlisten(id) } }
        return stream
    }

    /// Subscription ownership diagnostics: one listener may name several prefixes.
    func eventListenerCount(matching prefixes: [String]) -> Int {
        Set(prefixes.flatMap { prefixed[$0] ?? [] }).count
    }

    // MARK: Reads

    /// Everything the sidebar is drawn from, read whole. Events that arrive
    /// meanwhile are applied after it, in order.
    private func load() async {
        if let loading { return await loading.value }
        heldEvents = []
        let task = Task { await self.read() }
        loading = task
        await task.value
        loading = nil
    }

    private func read() async {
        sidebarReadSucceeded = false
        do {
            // Spaces were removed from happy-agent (API.md): a daemon
            // without `sidebarOperations` answers 404 there, so nothing of
            // the sidebar document is asked before health says it exists.
            let capabilities = (try? await client.health())?.capabilities ?? AgentWire.Health.Capabilities()
            self.capabilities = capabilities
            guard capabilities.sidebarOperations == true else {
                snapshot.availability = .unsupported
                heldEvents = nil
                publish()
                return
            }
            async let sidebar = client.sidebar(widgets: true)
            async let bots = client.bots()
            async let tasks = client.tasks()
            async let setting = client.userSetting(Self.settingKey)
            async let surfaceList = client.surfaces()
            async let profile = client.profileUser()
            let answer = try await sidebar
            let (botList, taskList) = try await (bots, tasks)
            snapshot.prioritizing = (try? await setting) == .bool(true)
            prioritizingDaemon = snapshot.prioritizing
            let served = (try? await surfaceList) ?? nil
            if let user = (try? await profile) ?? nil {
                me = user.id
                if !user.name.isEmpty { userNames[user.id] = user.name }
            }
            surfaces = served ?? []
            self.bots = botList; self.tasks = taskList
            agents = Agents()
            for owner in botList + taskList { if let agent = owner["agent"] { agents.absorb(agent) } }
            spaces = [:]
            for space in answer.spaces { adopt(space) }
            letGo(listing: answer.spaces)
            agentIcons = answer.agentIcons ?? [:]
            artifactId = answer.artifactId
            if !(writes > 0 || dragging) {
                if held == nil || held!.version <= answer.version { held = (answer.version, answer.html) }
            } else {
                stale = true
            }
            snapshot.availability = .available
            sidebarReadSucceeded = true
            rebuildPlaces()
            let pending = heldEvents ?? []
            heldEvents = nil
            // What changed while away is read again when next asked for.
            artifactTitles = [:]
            artifactPages = [:]
            artifactApps = [:]
            artifactGenUI = [:]
            for event in pending { receive(event) }
            publish()
            keeping?.cancel()
            saveOffline()
        } catch {
            heldEvents = nil
            if snapshot.availability == .loading, case AgentClientError.status(404, _, _) = error { snapshot.availability = .unsupported }
            publish()
        }
    }

    /// Reads the document again, unless a hand or a write holds it.
    private func reloadSidebar() {
        if writes > 0 || dragging { stale = true; return }
        Task {
            guard let answer = try? await client.sidebar(widgets: true) else { return }
            await adoptSidebar(answer)
        }
    }

    private func adoptSidebar(_ answer: AgentWire.SidebarResponse) {
        if writes > 0 || dragging { stale = true; return }
        if let held, held.version > answer.version { return }
        held = (answer.version, answer.html)
        artifactId = answer.artifactId
        agentIcons = answer.agentIcons ?? agentIcons
        for space in answer.spaces { adopt(space) }
        letGo(listing: answer.spaces)
        publish()
    }

    /// The bots and tasks are stale: read once things settle, and once
    /// more for news that came during the read, as home's own loop does
    /// (Proofs/: `Refresh`). Starting the wait again with each piece of
    /// news, as this did, never read while news kept coming. A read is
    /// `placesRereadInterval` after the last at the soonest, and what came
    /// during it is taken in after it, in order: a working agent's updates
    /// follow the copy just read rather than asking for the lists again
    /// with every word.
    private func schedulePlacesReload() {
        placesDirty = true
        guard placesReload == nil else { return }
        placesReload = Task {
            while placesDirty {
                let due = max(.now + .milliseconds(300), placesRead.map { $0 + placesRereadInterval } ?? .now)
                try? await Task.sleep(until: due, clock: .continuous)
                guard !Task.isCancelled else { return }
                placesDirty = false
                placesRead = .now
                placesHeld = []
                guard let (bots, tasks) = try? await (client.bots(), client.tasks()) else { placesHeld = nil; placesDirty = true; break }
                guard !Task.isCancelled else { placesHeld = nil; return }
                adoptPlaces(bots: bots, tasks: tasks)
                let held = placesHeld ?? []
                placesHeld = nil
                for event in held { receive(event) }
            }
            placesReload = nil
        }
    }

    private func adoptPlaces(bots: [JSONValue], tasks: [JSONValue]) {
        self.bots = bots; self.tasks = tasks
        placesLoaded = true
        for owner in bots + tasks { if let agent = owner["agent"] { agents.absorb(agent) } }
        rebuildPlaces()
        publish()
    }

    /// A new task from its own events, as home takes it (`HomeEvent`):
    /// `task.created` carries the whole task, kept until `task.joined`
    /// puts it at its order key in the person's list. False for what needs
    /// the lists read: a join of a task no event told of, or one already
    /// held, which moves it.
    private func joinWithoutRead(_ type: String, _ payload: JSONValue) -> Bool {
        if type == "task.created" {
            guard let task = payload["task"], let id = task["id"]?.stringValue,
                  !tasks.contains(where: { $0["id"]?.stringValue == id }) else { return false }
            announcedTasks[id] = task
            return true
        }
        guard let membership = payload["membership"], let id = membership["taskId"]?.stringValue, let key = membership["orderKey"]?.stringValue,
              !tasks.contains(where: { $0["id"]?.stringValue == id }),
              var task = announcedTasks.removeValue(forKey: id)?.objectValue else { return false }
        task["membership"] = membership
        let index = tasks.firstIndex { ($0["membership"]?["orderKey"]?.stringValue ?? "") > key } ?? tasks.endIndex
        tasks.insert(.object(task), at: index)
        if let agent = task["agent"] { agents.absorb(agent) }
        rebuildPlaces()
        publish()
        return true
    }

    /// The bots and tasks, each with its conversation composed from the newest copies.
    private var composedOwners: [JSONValue] {
        (bots + tasks).map { owner in
            guard var object = owner.objectValue, let id = object["agent"]?["id"]?.stringValue else { return owner }
            if let tree = agents.tree(id) { object["agent"] = tree }
            return .object(object)
        }
    }

    /// Reads the titles of artifacts messages name, once each; what is
    /// read is published with the references.
    public func readArtifacts(_ ids: [String]) {
        read(artifacts: ids.filter { artifactTitles[$0] == nil })
    }

    /// Reads artifacts whether or not they were read before, one read at a time each.
    private func read(artifacts ids: [String]) {
        let wanted = ids.filter { !artifactReads.contains($0) }
        guard !wanted.isEmpty else { return }
        artifactReads.formUnion(wanted)
        let client = client
        Task {
            for id in wanted {
                let read: References.Artifact?
                var page: References.Page?
                var app: Int?
                var genUI: References.GenUI?
                do {
                    let object = try await client.artifact(id)
                    read = References.artifact(object)
                    page = References.page(object)
                    // An app is never run inline, so a page waits for its
                    // start to say it isn't one; unread, it shows as before.
                    if let entry = References.entry(object),
                       (try? await client.artifactPage(id, version: entry.version, path: entry.path))?.mode == .app {
                        app = entry.version
                    }
                    if let version = References.genUIVersion(object) {
                        genUI = await Self.genUI(client, artifactId: id, version: version)
                    }
                } catch AgentClientError.status(404, _, _) {
                    read = .missing
                } catch {
                    read = nil
                }
                await artifactRead(id, read, page: page, app: app, genUI: genUI)
            }
        }
    }

    /// A `gen_ui` version's render document (`GenUIRenderDocument.path`),
    /// read and parsed here, off the main thread, with the agent that made
    /// the version; nil when the document can't be had. A version that
    /// can't be read names no agent, and its actions that need one are
    /// drawn disabled.
    private static func genUI(_ client: AgentClient, artifactId: String, version: Int) async -> References.GenUI? {
        async let read = try? client.artifactVersion(artifactId, version: version)
        guard let data = try? await client.genUIRender(artifactId, version: version), let document = GenUIRenderDocument.parse(data) else { return nil }
        return References.GenUI(version: version, document: document, origin: await read?.origin)
    }

    private func artifactRead(_ id: String, _ read: References.Artifact?, page: References.Page?, app: Int?, genUI: References.GenUI?) {
        artifactReads.remove(id)
        guard let read else { return }
        artifactTitles[id] = read
        artifactPages[id] = page
        artifactApps[id] = app
        artifactGenUI[id] = genUI
        publish()
    }

    /// The person's membership of a task they hold, as it is now: a
    /// loop-in mark set or cleared shows at once.
    private func adoptMembership(_ membership: JSONValue) {
        guard let taskId = membership["taskId"]?.stringValue,
              let index = tasks.firstIndex(where: { $0["id"]?.stringValue == taskId }),
              var object = tasks[index].objectValue else { return }
        object["membership"] = membership
        tasks[index] = .object(object)
        rebuildPlaces()
    }

    /// Reads the names of people messages mention, a batch at a time.
    public func readUsers(_ ids: [String]) {
        let wanted = Array(Set(ids.filter { userNames[$0] == nil && !userReads.contains($0) && !usersMissing.contains($0) }))
        guard !wanted.isEmpty else { return }
        userReads.formUnion(wanted)
        let client = client
        Task {
            var names: [String: String] = [:]
            for start in stride(from: 0, to: wanted.count, by: 100) {
                let batch = Array(wanted[start..<min(start + 100, wanted.count)])
                names.merge((try? await client.userNames(batch)) ?? [:]) { _, new in new }
            }
            await usersRead(wanted, names)
        }
    }

    private func usersRead(_ asked: [String], _ names: [String: String]) {
        userReads.subtract(asked)
        // The reader's own name is the profile's; `/v0/users` may not hold it.
        for (id, name) in names where !name.isEmpty { userNames[id] = name }
        // Omitted: no such person here. A failed read is asked again later.
        if !names.isEmpty || asked.isEmpty { usersMissing.formUnion(asked.filter { userNames[$0] == nil }) }
        publish()
    }

    private func readProfile() {
        let client = client
        Task {
            guard let user = (try? await client.profileUser()) ?? nil else { return }
            await profileRead(user.id, user.name)
        }
    }

    private func profileRead(_ id: String, _ name: String) {
        me = id
        if !name.isEmpty { userNames[id] = name }
        publish()
    }

    /// The bots and tasks with their conversations composed from the newest copies.
    private func rebuildPlaces() {
        func composed(_ owners: [JSONValue]) -> JSONValue {
            .array(owners.map { owner in
                guard var object = owner.objectValue, let id = object["agent"]?["id"]?.stringValue else { return owner }
                if let tree = agents.tree(id) { object["agent"] = tree }
                return .object(object)
            })
        }
        let decoder = JSONDecoder()
        func decode<T: Decodable>(_ value: JSONValue) -> [T] {
            guard let data = try? JSONEncoder().encode(value) else { return [] }
            return (try? decoder.decode([Lossy<T>].self, from: data))?.compactMap(\.value) ?? []
        }
        places = Places(bots: decode(composed(bots)), tasks: decode(composed(tasks)), surfaces: surfaces)
        // A subtask being archived that no bot or task holds any more is gone.
        for (id, removal) in removing where removal.subtask && places.agent(id) == nil { removing[id] = nil }
    }


    /// A working agent's `agent.updated` comes with every word, and each
    /// rebuilt the bots' and tasks' places through JSON and redrew the
    /// sidebar: drawn together 250 ms on, as `SyncEngine` draws home, the
    /// rows still move within a quarter of a second. Any other change
    /// draws them at once with it.
    private func followAgentsSoon() {
        guard followingAgents == nil else { return }
        followingAgents = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            followingAgents = nil
            rebuildPlaces()
            publish()
        }
    }

    // MARK: Events

    private func receive(_ event: JSONValue) {
        if heldEvents != nil { heldEvents?.append(event); return }
        guard let type = event["type"]?.stringValue else { return }
        let payload = event["payload"] ?? .null
        switch type {
        case "space.created", "space.updated":
            if let space = payload["space"].flatMap(Self.decodeSpace) { adopt(space) }
        case "space.removed":
            if let id = payload["spaceId"]?.stringValue {
                spaces.removeValue(forKey: id)
                if removing[id]?.subtask == false { removing[id] = nil }
            }
        case "space.sidebar.changed":
            sidebarChanged(payload)
        case "agent.updated":
            // An agent no bot or task here holds draws nothing here; one
            // that moved only its time within the minute, nothing either.
            guard let id = payload["agentId"]?.stringValue, agents.holds(id) else { return }
            let drawn = agents.drawn(id)
            let followed = agents.update(agentId: id, previousVersion: payload["previousVersion"]?.stringValue, version: payload["version"]?.stringValue, changes: payload["changes"]?.objectValue ?? [:])
            if followed {
                if agents.drawn(id) != drawn { followAgentsSoon() }
                return
            }
            if placesHeld != nil { placesHeld?.append(event); return }
            schedulePlacesReload()
        case "agent.created":
            if let agent = payload["agent"] { agents.created(agent); rebuildPlaces() }
        case "bot.created", "bot.updated", "task.created", "task.updated", "task.joined", "task.left":
            if type == "task.created" || type == "task.joined", placesLoaded, placesHeld == nil, joinWithoutRead(type, payload) { return }
            if let membership = payload["membership"] { adoptMembership(membership) }
            if placesHeld != nil { placesHeld?.append(event); return }
            schedulePlacesReload()
        case "task.membership.updated":
            guard let membership = payload["membership"] else { return }
            adoptMembership(membership)
        case "task.removed":
            // Deleted for good, its memberships with it, as home takes it
            // (`HomeEvent`); a read on its way may still hold it.
            guard let id = payload["taskId"]?.stringValue else { return }
            if placesHeld != nil { placesHeld?.append(event) }
            announcedTasks[id] = nil
            tasks.removeAll { $0["id"]?.stringValue == id }
            rebuildPlaces()
            publish()
        case "profile.updated":
            // Names changed somewhere: the ones held are read again.
            let held = Array(userNames.keys)
            userNames = userNames.filter { $0.key == me }
            usersMissing = []
            readUsers(held)
            if let me, let id = payload["userId"]?.stringValue ?? payload["profile"]?["userId"]?.stringValue, id == me { readProfile() }
        case "surface.created":
            if let surface = payload["surface"].flatMap(Self.decodeSurface) {
                surfaces.removeAll { $0.id == surface.id }
                surfaces.append(surface)
                rebuildPlaces()
            }
        case "surface.updated":
            if let id = payload["surfaceId"]?.stringValue ?? payload["surface"]?["id"]?.stringValue,
               let name = payload["changes"]?["name"]?.stringValue ?? payload["name"]?.stringValue,
               let index = surfaces.firstIndex(where: { $0.id == id }) {
                surfaces[index].name = name
                rebuildPlaces()
            }
        case "artifact.updated", "artifact.deleted":
            // Only the ones a message named are kept.
            guard let id = payload["artifactId"]?.stringValue, let held = artifactTitles[id] else { return }
            let changes = payload["changes"] ?? .null
            if type == "artifact.deleted" || changes["status"]?.stringValue == "deleted" {
                let title: String = if case .active(let title, _, _) = held { title } else if case .deleted(let title) = held { title } else { "" }
                artifactTitles[id] = .deleted(title: title)
            } else if case .active(let title, let kind, let latest) = held {
                artifactTitles[id] = .active(title: changes["title"]?.stringValue ?? title, type: kind, latestVersion: changes["latestVersion"]?.numberValue.map { Int($0) } ?? latest)
            }
            if type == "artifact.deleted" || changes["status"]?.stringValue == "deleted" {
                artifactPages[id] = nil
                artifactApps[id] = nil
                artifactGenUI[id] = nil
            } else if case .active(_, let kind, _) = held, kind == "html" || kind == "gen_ui" {
                // A page or Gen UI shown inline follows its latest version and display.
                read(artifacts: [id])
            }

        case "user_settings.updated":
            if payload["setting"]?["key"]?.stringValue == Self.settingKey {
                snapshot.prioritizing = payload["setting"]?["value"] == .bool(true)
                prioritizingDaemon = snapshot.prioritizing
            }
        default:
            return
        }
        publish()
    }

    private func sidebarChanged(_ payload: JSONValue) {
        guard let artifactId, payload["artifactId"]?.stringValue == artifactId,
              let held, let version = payload["version"]?.numberValue.map(Int.init), version > held.version else { return }
        // Nothing lands under a hand: the read after the release catches up.
        if dragging { stale = true; return }
        guard payload["previousVersion"]?.numberValue.map(Int.init) == held.version,
              let operations = payload["operations"]?.arrayValue?.compactMap(SpaceSidebarOperation.init(json:)),
              let document = try? SpaceSidebar.parse(held.html),
              let applied = try? SpaceSidebar.apply(document, operations) else {
            reloadSidebar()
            return
        }
        self.held = (version, SpaceSidebar.format(applied.document))
        // This phone's own edit, confirmed: it is already on screen.
        if let mutationId = payload["mutationId"]?.stringValue { batches.removeAll { $0.mutationId == mutationId } }
    }

    /// A full read: a space being taken off that it no longer lists is gone.
    private func letGo(listing listed: [AgentWire.Space]) {
        let ids = Set(listed.map(\.id))
        for (id, removal) in removing where !removal.subtask && !ids.contains(id) { removing[id] = nil }
    }

    private func adopt(_ space: AgentWire.Space) {
        if let current = spaces[space.id], current.version > space.version { return }
        var space = space
        if let intent = titleIntents[space.id] {
            if space.title == intent.title { titleIntents.removeValue(forKey: space.id) }
            else { titleIntents[space.id]?.base = space.title; space.title = intent.title }
        }
        spaces[space.id] = space
    }

    static func decodeSurface(_ value: JSONValue) -> AgentWire.Surface? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONDecoder().decode(AgentWire.Surface.self, from: data)
    }

    static func decodeSpace(_ value: JSONValue) -> AgentWire.Space? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONDecoder().decode(AgentWire.Space.self, from: data)
    }

    /// Another sidebar document (a proposal's) as this sidebar's rows, with
    /// the spaces, places and icons held now: every row, folds included.
    public func rows(of html: String) -> [Row]? {
        guard let document = try? SpaceSidebar.parse(html) else { return nil }
        return Rows.all(document, spaces: spaces, places: places, agentIcons: agentIcons, labels: labels)
    }

    // MARK: The document on screen

    /// The held document with every unconfirmed edit on top.
    private func confirmedShown() -> SpaceSidebarDocument? {
        guard let held, var document = try? SpaceSidebar.parse(held.html) else { return nil }
        for batch in batches {
            // Already in the held document, or no longer possible: the
            // daemon's answer for it decides, and it draws nothing now.
            if let applied = try? SpaceSidebar.apply(document, batch.operations, base: batch.base) { document = applied.document }
        }
        return document
    }

    /// What is on screen: the confirmed document, less the rows being taken off.
    private func shown() -> SpaceSidebarDocument? {
        guard var document = confirmedShown() else { return nil }
        for id in removing.keys {
            if let applied = try? SpaceSidebar.apply(document, [.remove(id)]) { document = applied.document }
        }
        return document
    }

    private func publish() {
        if let document = shown() {
            let all = overlay.apply(Rows.all(document, spaces: spaces, places: places, agentIcons: agentIcons, labels: labels))
            snapshot.rows = Rows.visible(all)
            snapshot.allRows = all
            snapshot.document = document
        }
        snapshot.happyAgentId = places.chiefOfStaffAgentId
        snapshot.botAgentIds = Set(places.bots.compactMap { $0.agent?.id })
        var references = References.entities(owners: bootstrapped?.owners ?? composedOwners)
        references.artifacts = artifactTitles
        references.pages = artifactPages
        references.apps = artifactApps
        references.genUI = artifactGenUI
        references.genUIServed = GenUIServed(capabilities)
        references.users = userNames
        references.me = me
        references.missingUsers = usersMissing
        references.surfaces = Dictionary((bootstrapped?.surfaces ?? surfaces).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        snapshot.references = references
        continuation.yield(snapshot)
        // What the events changed is kept too, once they settle.
        if snapshot.live, held != nil { keepSoon() }
    }

    private func keepSoon() {
        keeping?.cancel()
        keeping = Task {
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            saveOffline()
        }
    }

    // MARK: Edits

    /// One edit of the document, sent as the operations that make it. It is
    /// on screen at once and stays exactly there when the daemon confirms
    /// it; a refusal takes only this edit back off.
    private func edit(expanding claims: [String] = [], _ change: (SpaceSidebarDocument) -> SpaceSidebarDocument?) {
        guard held != nil, let base = confirmedShown(), let proposed = change(base),
              var operations = try? SpaceSidebar.diff(base, proposed), !operations.isEmpty else { return }
        for id in claims where !operations.contains(where: { if case .set(let fields) = $0 { fields.id == id && fields.expanded != nil } else { false } }) {
            operations.append(.set(SpaceSidebarSet(id: id, expanded: true)))
        }
        let batch = Batch(mutationId: ClientID.make(), operations: operations, base: base)
        batches.append(batch)
        snapshot.error = nil
        publish()
        writes += 1
        let previous = writeQueue
        writeQueue = Task {
            await previous?.value
            await self.write(batch)
        }
    }

    private func write(_ batch: Batch) async {
        defer { writes -= 1; released() }
        var answer: AgentWire.OperationsResponse?
        for attempt in 0..<3 {
            do {
                // Made against what was on screen, sent against what the
                // daemon last said; it rebases anything in between.
                answer = try await client.applySidebarOperations(mutationId: batch.mutationId, baseVersion: held?.version ?? 0, operations: batch.operations)
                break
            } catch let error as AgentClientError where (error.status ?? 500) < 500 {
                batches.removeAll { $0.mutationId == batch.mutationId }
                snapshot.error = Self.describe(error)
                stale = true
                publish()
                return
            } catch {
                // Only a request that was not heard is sent again, under the same mutation ID.
                if attempt == 2 || Task.isCancelled {
                    batches.removeAll { $0.mutationId == batch.mutationId }
                    snapshot.error = Self.describe(error)
                    stale = true
                    publish()
                    return
                }
                try? await Task.sleep(for: .milliseconds(400 * (attempt + 1)))
            }
        }
        guard let answer else { return }
        batches.removeAll { $0.mutationId == batch.mutationId }
        if held == nil || answer.version > held!.version { held = (answer.version, answer.html) }
        publish()
    }

    private func released() {
        guard !dragging, writes == 0 else { return }
        attentionRestart()
        if stale { stale = false; reloadSidebar() }
    }

    /// The daemon's own words for a refusal, or empty where it gave none
    /// (the screens say it in theirs).
    public static func describe(_ error: Error) -> String {
        if case AgentClientError.status(_, _, let message?) = error { return message }
        return ""
    }

    public func move(_ nodeId: String, after afterId: String?) {
        edit { SidebarDocumentEdits.move($0, nodeId, after: afterId) }
    }

    /// Sets a space down under a row, or back at the top level for nil.
    public func place(_ nodeId: String, parent: String?, after afterId: String?) {
        edit { SidebarDocumentEdits.place($0, nodeId, parent: parent, after: afterId) }
    }

    public func fold(_ nodeId: String) {
        edit { SidebarDocumentEdits.fold($0, nodeId) }
    }

    public func removeSection(_ sectionId: String) {
        edit { SidebarDocumentEdits.removeSection($0, sectionId) }
    }

    public func relabel(_ sectionId: String, label: String) {
        edit { SidebarDocumentEdits.relabel($0, sectionId, label: label) }
    }

    /// Shows a row's subtasks under it, opening the row as the person's own choice.
    public func revealSessions(_ nodeId: String, sessions: [SidebarDocumentEdits.SessionTree]) {
        edit(expanding: [nodeId]) { SidebarDocumentEdits.revealSessions($0, nodeId, sessions: sessions) }
    }

    public func hideSessions(_ nodeId: String) {
        let spaces = spaces
        edit { SidebarDocumentEdits.hideSessions($0, nodeId, attached: { spaces[$0] != nil }) }
    }

    /// Holds the document and the daemon's edits through a drag and its drop.
    public func setDragging(_ active: Bool) {
        dragging = active
        if active { attentionSend("interacting") } else { released() }
    }

    // MARK: New work

    /// The task compose opens, until its first message makes it: compose
    /// again before that opens the same one, with what was typed in it.
    private var unsent: NewTask?

    /// What compose opens: a task nothing exists of yet anywhere but here,
    /// made on the computer by its first message (`NewTask`). Opening it
    /// makes nothing, so leaving it leaves nothing behind.
    public func newTask() async -> NewTask {
        if let unsent, !(await unsent.isMade) { return unsent }
        let task = NewTask(client: client)
        unsent = task
        return task
    }

    /// Leaves a task: its row goes at once, and comes back if the computer refuses.
    @discardableResult
    public func leave(taskId: String, nodeId: String) async -> Bool {
        let client = client
        return await removeAtOnce(nodeId, intent: (.leave, taskId, "task"), asking: { try await client.leaveTask(taskId) })
    }

    /// Leaves a Surface: its row goes at once, and comes back if the computer refuses.
    @discardableResult
    public func leave(surfaceId: String, nodeId: String) async -> Bool {
        let client = client
        return await removeAtOnce(nodeId, intent: (.leave, surfaceId, "surface"), asking: { try await client.leaveSurface(surfaceId) })
    }

    /// Archives a task or bot: its row goes at once, and comes back if the computer refuses.
    @discardableResult
    public func archive(kind: String, id: String, nodeId: String) async -> Bool {
        let client = client
        return await removeAtOnce(nodeId, intent: (.archive, id, kind == "bot" ? "bot" : "task"), asking: { try await kind == "bot" ? client.archiveBot(id) : client.archiveTask(id) })
    }

    /// Archives a subtask, and with its row everything under it: it goes
    /// at once, and comes back if the computer refuses.
    @discardableResult
    public func archiveSubtask(_ agentId: String, nodeId: String) async -> Bool {
        let client = client
        return await removeAtOnce(nodeId, subtask: true, intent: (.archive, agentId, "agent"), asking: { try await client.archiveAgent(agentId) })
    }

    /// Takes `nodeId`'s row off at once and asks the computer with `work`.
    /// A second press while one is on its way sends nothing and shares its
    /// answer; a row already gone answers true. Gone already on the
    /// computer (404) counts as taken; anything else it answers is a
    /// refusal, with its reason.
    ///
    /// With the account's outbox it is kept and sent through it instead
    /// (`intent`), so it outlives the app, and answers once the computer
    /// has: true when it took it, false when it refused.
    private func removeAtOnce(_ nodeId: String, subtask: Bool = false, intent: (kind: Intent.Kind, target: String, of: String)? = nil, asking work: @escaping @Sendable () async throws -> Void) async -> Bool {
        if let pending = removing[nodeId] { return await pending.asked.value }
        guard subtask ? places.agent(nodeId) != nil : spaces[nodeId] != nil else { return true }
        let intents = intents
        let asked = Task {
            if let intents, let intent {
                guard let kept = try? await intents.enqueue(intent.kind, target: intent.target, value: .object(["kind": .string(intent.of)])) else {
                    await self.removalRefused(nodeId, CancellationError())
                    return false
                }
                if await intents.outcome(kept.id) { return true }
                await self.removalRefused(nodeId, nil)
                return false
            }
            do { try await work() }
            catch AgentClientError.status(404, _, _) {}
            catch {
                await self.removalRefused(nodeId, error)
                return false
            }
            return true
        }
        removing[nodeId] = Removal(subtask: subtask, asked: asked)
        snapshot.error = nil
        publish()
        return await asked.value
    }

    /// Its row comes back; nil: the account's notice says why.
    private func removalRefused(_ nodeId: String, _ error: Error?) {
        removing[nodeId] = nil
        if let error { failed(error) } else { publish() }
    }

    private func failed(_ error: Error) {
        snapshot.error = Self.describe(error)
        publish()
    }

    // MARK: Names

    /// Shows the name just given to a row's task or bot at once, and keeps it
    /// through any read that does not carry it yet, until one does.
    public func rename(_ spaceId: String, title: String) {
        guard let space = spaces[spaceId] else { return }
        let base = titleIntents[spaceId]?.base ?? space.title
        if base == title { titleIntents.removeValue(forKey: spaceId) } else { titleIntents[spaceId] = (title, base) }
        spaces[spaceId]?.title = title
        publish()
        let client = client
        if let intents, space.target.kind == "task" || space.target.kind == "bot" {
            // Kept and sent as one; refused, the old name comes back.
            Task {
                guard let kept = try? await intents.enqueue(.rename, target: space.target.id, value: .object(["title": .string(title), "kind": .string(space.target.kind)])) else {
                    await self.withdraw(spaceId, title: title)
                    return
                }
                if await !intents.outcome(kept.id) { await self.withdraw(spaceId, title: title) }
            }
            return
        }
        Task {
            do {
                switch space.target.kind {
                case "task": try await client.renameTask(space.target.id, name: title)
                case "bot": try await client.renameBot(space.target.id, name: title)
                default: return
                }
            } catch {
                await self.withdraw(spaceId, title: title)
            }
        }
    }

    private func withdraw(_ spaceId: String, title: String) {
        guard let intent = titleIntents[spaceId], intent.title == title else { return }
        titleIntents.removeValue(forKey: spaceId)
        spaces[spaceId]?.title = intent.base
        publish()
    }

    /// The account's pending actions changed (`SyncEngine`): the rows wear them.
    public func setOverlay(_ overlay: IntentOverlay) {
        guard overlay != self.overlay else { return }
        self.overlay = overlay
        publish()
    }

    // MARK: Prioritizing

    /// Turns Prioritizing on or off, from Settings' switch; only ever the
    /// person's choice.
    public func setPrioritizing(_ on: Bool) {
        snapshot.prioritizing = on
        publish()
        prioritizingWrites &+= 1
        let write = prioritizingWrites
        let client = client
        let previous = prioritizingWrite
        prioritizingWrite = Task {
            await previous?.value
            do {
                try await client.setUserSetting(Self.settingKey, .bool(on))
                await self.prioritizingAccepted(on)
            } catch {
                await self.prioritizingRefused(error, write: write)
            }
        }
    }

    private func prioritizingAccepted(_ on: Bool) {
        prioritizingDaemon = on
    }

    /// A later choice still on its way decides what shows; otherwise the
    /// daemon's own value comes back.
    private func prioritizingRefused(_ error: Error, write: Int) {
        if write == prioritizingWrites { snapshot.prioritizing = prioritizingDaemon }
        snapshot.error = Self.describe(error)
        publish()
    }

    public func tidy() {
        let client = client
        Task { try? await client.tidy(mutationId: ClientID.make()) }
    }

    // MARK: Attention

    /// The person touched the list. Prioritizing's queued changes wait for
    /// five minutes without any of this.
    public func attentionInput() {
        guard attentionVisible else { return }
        attentionSend("interacting")
        attentionRestart()
    }

    /// The list went out of sight, or came back: hidden lets queued changes land at once.
    public func attentionVisibleUpdate(_ visible: Bool) {
        guard attentionVisible != visible else { return }
        attentionVisible = visible
        if visible { attentionInput(); return }
        attentionIdle?.cancel(); attentionIdle = nil
        attentionSend("calm")
    }

    private func attentionRestart() {
        attentionIdle?.cancel(); attentionIdle = nil
        guard attentionVisible else { return }
        attentionIdle = Task {
            try? await Task.sleep(for: Self.attentionCalm)
            guard !Task.isCancelled else { return }
            await self.attentionSend("calm")
        }
    }

    private func attentionSend(_ state: String) {
        guard snapshot.availability == .available else { return }
        if state == "calm" && (dragging || writes > 0) { return }
        let now = ContinuousClock.now
        if let attention, attention.state == state, state == "calm" || now - attention.at < Self.attentionRenew { return }
        attention = (state, now)
        let client = client
        Task { try? await client.reportAttention(state) }
    }

    // MARK: Offline

    /// The sidebar as last read, drawn at once while the daemon is asked.
    /// The live read that follows replaces it row for row, so a row that
    /// has not changed does not move.
    private func restoreOffline() async {
        guard let offline, held == nil, let kept = await offline.read()?.sidebar, held == nil else { return }
        artifactId = kept.artifactId
        held = (kept.version, kept.html)
        for space in kept.spaces { adopt(space) }
        agentIcons = kept.agentIcons
        bots = kept.bots; tasks = kept.tasks
        surfaces = kept.surfaces ?? []
        if let capabilities = kept.capabilities { self.capabilities = capabilities }
        if snapshot.prioritizing == nil { snapshot.prioritizing = kept.prioritizing }
        for owner in bots + tasks { if let agent = owner["agent"] { agents.absorb(agent) } }
        rebuildPlaces()
        snapshot.availability = .available
        publish()
    }

    /// Kept only as the daemon has it: never while a hand or a write holds
    /// the document (the rows may be ahead of it, or a rename not yet
    /// taken); the publish that ends those keeps it then.
    private func saveOffline() {
        guard let offline, let artifactId, let held, writes == 0, !dragging, !stale, titleIntents.isEmpty else { return }
        let sidebar = OfflineSnapshot.Sidebar(
            artifactId: artifactId, version: held.version, html: held.html,
            spaces: spaces.values.filter { $0.version > 0 }.sorted { $0.id < $1.id },
            agentIcons: agentIcons, bots: bots, tasks: tasks, surfaces: surfaces,
            capabilities: capabilities, prioritizing: prioritizingDaemon
        )
        Task { await offline.update { $0.sidebar = sidebar } }
    }
}

/// A list element that may fail to decode alone, leaving the rest.
struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}
