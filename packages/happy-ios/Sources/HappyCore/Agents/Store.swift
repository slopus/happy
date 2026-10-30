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
    /// Happy's own row, below which new work goes.
    public var happySpaceId: String?
    /// Happy's own conversation, which Settings' asks are typed into
    /// (`ChatPrefill`); nil until the bots have been read, or where the
    /// account has no Chief of Staff running.
    public var happyAgentId: String?
    /// The person's V2 setting, which runs Prioritizing; nil until read.
    public var prioritizing: Bool?
    /// The last act the daemon refused: its reason, empty when it gave none.
    public var error: String?
    /// Why the last new work could not be made, as `error`.
    public var creationError: String?
    /// What the references in messages read as and open.
    public var references = References()

    public init() {}
}

/// New work, named on this phone before the daemon answers.
public struct Creation: Sendable {
    public let spaceId: String
    public let agentId: String
    public let workspaceId: String
    /// The conversation's ID once the daemon has made it (`agentId` when the
    /// daemon takes the phone's names); a refusal takes the row away again.
    public let created: Task<String, Error>

    public init(spaceId: String, agentId: String, workspaceId: String, created: Task<String, Error>) {
        self.spaceId = spaceId
        self.agentId = agentId
        self.workspaceId = workspaceId
        self.created = created
    }
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
    /// New work drawn where it was made until the held document has it.
    private var inserts: [(spaceId: String, sectionId: String?, happySpaceId: String?)] = []
    private var creating: Set<String> = []
    /// New work being made, by space: what putting it away waits for.
    private var creations: [String: Task<String, Error>] = [:]
    /// Rows taken off here, by document node, as desktop's `removals`: off
    /// the sidebar at once, before the computer hears (new work closed,
    /// work archived or left), and kept off through every read and event
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
    /// Stopped: Close new work stops asking a computer out of reach.
    private var stopped = false
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
    private var agents = Agents()
    /// Artifact titles references asked for, as read; and those being read.
    private var artifactTitles: [String: References.Artifact] = [:]
    private var artifactPages: [String: References.Page] = [:]
    private var artifactReads: Set<String> = []
    /// People messages mention, as named, and those being read; the person reading.
    private var userNames: [String: String] = [:]
    private var userReads: Set<String> = []
    private var usersMissing: Set<String> = []
    private var me: String?
    private var places = Places()
    private var placesReload: Task<Void, Never>?
    /// Names given here whose rename no read has carried yet.
    private var titleIntents: [String: (title: String, base: String?)] = [:]

    // Attention: Prioritizing holds its batches while the person is in the list.
    private var attention: (state: String, at: ContinuousClock.Instant)?
    private var attentionIdle: Task<Void, Never>?
    private var attentionVisible = true

    public init(client: AgentClient, offline: OfflineFile? = nil, labels: Rows.Labels = Rows.Labels()) {
        self.client = client
        self.offline = offline
        self.labels = labels
        (updates, continuation) = AsyncStream.makeStream(of: Snapshot.self, bufferingPolicy: .bufferingNewest(1))
    }

    // MARK: Life

    /// SyncEngine owns the stream for account-backed sessions. The
    /// standalone start() remains available for existing fixtures/consumers.
    public func startExternal() async { await restoreOffline() }

    @discardableResult
    public func externalResync(loadSidebar: Bool) async -> Bool {
        for listener in listeners.values { listener.continuation.yield(.resync) }
        for listener in typeListeners.values { listener.continuation.yield(.resync) }
        snapshot.live = true
        if loadSidebar {
            await load()
            return sidebarReadSucceeded
        }
        publish()
        return true
    }

    public func externalEvent(_ envelope: JSONValue) {
        let payload = envelope["payload"]
        if let key = payload?["agentId"]?.stringValue ?? payload?["surfaceId"]?.stringValue ?? payload?["todo"]?["surfaceId"]?.stringValue {
            for listener in listeners.values where listener.key == key { listener.continuation.yield(.event(envelope)) }
        }
        if let type = envelope["type"]?.stringValue {
            for listener in typeListeners.values where listener.prefixes.contains(where: type.hasPrefix) { listener.continuation.yield(.event(envelope)) }
        }
        receive(envelope)
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
        stopped = true
        await flush()
        following?.cancel(); following = nil
        loading?.cancel(); loading = nil
        placesReload?.cancel(); placesReload = nil
        attentionIdle?.cancel(); attentionIdle = nil
        keeping?.cancel(); keeping = nil
        draftPublish?.cancel(); draftPublish = nil
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
                        let hello = try? JSONDecoder().decode(JSONValue.self, from: Data(frame.data.utf8))
                        let resumed = hello?["resumed"]?.boolValue == true && hello?["gap"]?.boolValue != true
                        if let next = hello?["cursor"]?.stringValue, !resumed || cursor == nil { cursor = next }
                        snapshot.live = true
                        if !resumed {
                            for listener in listeners.values { listener.continuation.yield(.resync) }
                            for listener in typeListeners.values { listener.continuation.yield(.resync) }
                        }
                        if !resumed || held == nil { await load() } else { publish() }
                        continue
                    }
                    if let id = frame.id { cursor = id }
                    guard let envelope = try? JSONDecoder().decode(JSONValue.self, from: Data(frame.data.utf8)) else { continue }
                    let payload = envelope["payload"]
                    if let key = payload?["agentId"]?.stringValue ?? payload?["surfaceId"]?.stringValue ?? payload?["todo"]?["surfaceId"]?.stringValue {
                        for listener in listeners.values where listener.key == key { listener.continuation.yield(.event(envelope)) }
                    }
                    if let type = envelope["type"]?.stringValue {
                        for listener in typeListeners.values where listener.prefixes.contains(where: type.hasPrefix) { listener.continuation.yield(.event(envelope)) }
                    }
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
    /// needs no stream of its own. `resync` means some were lost: read again.
    public enum ConversationEvent: Sendable {
        case event(JSONValue)
        case resync
    }

    private var listeners: [UUID: (key: String, continuation: AsyncStream<ConversationEvent>.Continuation)] = [:]

    /// `key` is a conversation's agent ID, or a Surface's ID for its todos.
    public func conversationEvents(_ key: String) -> AsyncStream<ConversationEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: ConversationEvent.self)
        listeners[id] = (key, continuation)
        continuation.onTermination = { [weak self] _ in Task { await self?.unlisten(id) } }
        return stream
    }

    private func unlisten(_ id: UUID) { listeners.removeValue(forKey: id); typeListeners.removeValue(forKey: id) }

    private var typeListeners: [UUID: (prefixes: [String], continuation: AsyncStream<ConversationEvent>.Continuation)] = [:]

    /// Every event whose type starts with one of `prefixes` (`"story."`),
    /// for what no conversation or Surface key names. `resync` as above.
    public func events(matching prefixes: [String]) -> AsyncStream<ConversationEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: ConversationEvent.self)
        typeListeners[id] = (prefixes, continuation)
        continuation.onTermination = { [weak self] _ in Task { await self?.unlisten(id) } }
        return stream
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
            async let health = client.health()
            async let sidebar = client.sidebar(widgets: true)
            async let bots = client.bots()
            async let tasks = client.tasks()
            async let setting = client.userSetting(Self.settingKey)
            async let surfaceList = client.surfaces()
            async let profile = client.profileUser()
            let capabilities = (try? await health)?.capabilities ?? AgentWire.Health.Capabilities()
            self.capabilities = capabilities
            guard capabilities.sidebarOperations == true else {
                snapshot.availability = .unsupported
                heldEvents = nil
                publish()
                return
            }
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

    private func schedulePlacesReload() {
        placesReload?.cancel()
        placesReload = Task {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            guard let (bots, tasks) = try? await (client.bots(), client.tasks()) else { return }
            await adoptPlaces(bots: bots, tasks: tasks)
        }
    }

    private func adoptPlaces(bots: [JSONValue], tasks: [JSONValue]) {
        self.bots = bots; self.tasks = tasks
        for owner in bots + tasks { if let agent = owner["agent"] { agents.absorb(agent) } }
        rebuildPlaces()
        publish()
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
                do {
                    let object = try await client.artifact(id)
                    read = References.artifact(object)
                    page = References.page(object)
                } catch AgentClientError.status(404, _, _) {
                    read = .missing
                } catch {
                    read = nil
                }
                await artifactRead(id, read, page: page)
            }
        }
    }

    private func artifactRead(_ id: String, _ read: References.Artifact?, page: References.Page?) {
        artifactReads.remove(id)
        guard let read else { return }
        artifactTitles[id] = read
        artifactPages[id] = page
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
        places = Places(bots: decode(composed(bots)), tasks: decode(composed(tasks)), surfaces: surfaces, drafts: draftsShown)
        // A subtask being archived that no bot or task holds any more is gone.
        for (id, removal) in removing where removal.subtask && places.agent(id) == nil { removing[id] = nil }
    }

    // MARK: Drafts

    /// The latest stamp heard for each conversation's draft, the previews
    /// rows show, and the ones waiting for typing to pause.
    private var draftStamps: [String: Double] = [:]
    private var draftsShown: [String: String] = [:]
    private var draftsWaiting: [String: String] = [:]
    private var draftPublish: Task<Void, Never>?
    /// How long typing pauses before a row's draft follows the composer.
    static let draftDelay: Duration = .seconds(1)

    /// A conversation's draft changed, on this phone or another device: its
    /// row follows a second after typing pauses, or at once when the draft
    /// empties, so typing doesn't redraw the list on every keystroke. An
    /// older stamp than one already heard changes nothing.
    public func noteDraft(_ agentId: String, text: String?, updatedAt: Double) {
        if let stamp = draftStamps[agentId], updatedAt < stamp { return }
        draftStamps[agentId] = updatedAt
        guard let preview = Rows.draftPreview(text) else {
            draftsWaiting.removeValue(forKey: agentId)
            guard draftsShown.removeValue(forKey: agentId) != nil else { return }
            places.drafts = draftsShown
            publish()
            return
        }
        guard draftsShown[agentId] != preview else {
            draftsWaiting.removeValue(forKey: agentId)
            return
        }
        draftsWaiting[agentId] = preview
        draftPublish?.cancel()
        draftPublish = Task { [weak self] in
            try? await Task.sleep(for: Self.draftDelay)
            guard !Task.isCancelled else { return }
            await self?.showWaitingDrafts()
        }
    }

    private func showWaitingDrafts() {
        guard !draftsWaiting.isEmpty else { return }
        draftsShown.merge(draftsWaiting) { _, waiting in waiting }
        draftsWaiting = [:]
        places.drafts = draftsShown
        publish()
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
                inserts.removeAll { $0.spaceId == id }
                if removing[id]?.subtask == false { removing[id] = nil }
            }
        case "space.sidebar.changed":
            sidebarChanged(payload)
        case "agent.updated":
            guard let id = payload["agentId"]?.stringValue else { return }
            let followed = agents.update(agentId: id, previousVersion: payload["previousVersion"]?.stringValue, version: payload["version"]?.stringValue, changes: payload["changes"]?.objectValue ?? [:])
            if followed { rebuildPlaces() } else { schedulePlacesReload() }
        case "agent.created":
            if let agent = payload["agent"] { agents.created(agent); rebuildPlaces() }
        case "bot.created", "bot.updated", "task.created", "task.updated", "task.joined", "task.left":
            if let membership = payload["membership"] { adoptMembership(membership) }
            schedulePlacesReload()
        case "task.membership.updated":
            guard let membership = payload["membership"] else { return }
            adoptMembership(membership)
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
            } else if case .active(_, "html", _) = held {
                // A page shown inline follows its latest version, entry and display.
                read(artifacts: [id])
            }
        case "agent.draft.updated":
            guard let id = payload["agentId"]?.stringValue else { return }
            noteDraft(id, text: payload["draft"]?["value"]?["text"]?.stringValue, updatedAt: payload["draft"]?["updatedAt"]?.numberValue ?? 0)
            return
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

    /// A full read: a space being taken off that it no longer lists is
    /// gone, unless it is still being made here.
    private func letGo(listing listed: [AgentWire.Space]) {
        let ids = Set(listed.map(\.id))
        for (id, removal) in removing where !removal.subtask && !ids.contains(id) && !creating.contains(id) { removing[id] = nil }
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

    /// The held document with every unconfirmed edit on top, without new work.
    private func confirmedShown() -> SpaceSidebarDocument? {
        guard let held, var document = try? SpaceSidebar.parse(held.html) else { return nil }
        for batch in batches {
            // Already in the held document, or no longer possible: the
            // daemon's answer for it decides, and it draws nothing now.
            if let applied = try? SpaceSidebar.apply(document, batch.operations, base: batch.base) { document = applied.document }
        }
        return document
    }

    /// What is on screen: the confirmed document and new work where it was made.
    private func shown() -> SpaceSidebarDocument? {
        guard var document = confirmedShown() else { return nil }
        inserts.removeAll { insert in !creating.contains(insert.spaceId) && SpaceSidebar.locate(document, insert.spaceId) != nil }
        for insert in inserts where SpaceSidebar.locate(document, insert.spaceId) == nil {
            document = SidebarDocumentEdits.insert(document, spaceId: insert.spaceId, sectionId: insert.sectionId, happySpaceId: insert.happySpaceId) ?? document
        }
        for id in removing.keys {
            if let applied = try? SpaceSidebar.apply(document, [.remove(id)]) { document = applied.document }
        }
        return document
    }

    private func publish() {
        if let document = shown() {
            let all = Rows.all(document, spaces: spaces, places: places, agentIcons: agentIcons, labels: labels)
            snapshot.rows = Rows.visible(all)
            snapshot.allRows = all
            snapshot.document = document
        }
        snapshot.happySpaceId = spaces.values.first { places.isHappy($0) }?.id
        snapshot.happyAgentId = places.chiefOfStaffAgentId
        var references = References.entities(owners: composedOwners)
        references.artifacts = artifactTitles
        references.pages = artifactPages
        references.users = userNames
        references.me = me
        references.missingUsers = usersMissing
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

    /// Makes new work right below Happy's row. The row and its conversation
    /// exist here at once and the daemon is told after; the first message
    /// waits for `created`.
    /// New work: below Happy, or at the top of the section `sectionId`.
    public func createV2(sectionId: String? = nil) -> Creation {
        let spaceId = ClientID.make()
        let mutationId = ClientID.make()
        let identity = Identity.make()
        let happySpaceId = snapshot.happySpaceId
        let named = capabilities.identities == true
        creating.insert(spaceId)
        inserts.append((spaceId, sectionId, happySpaceId))
        let now = Date().timeIntervalSince1970 * 1000
        // Version 0 is older than anything the daemon says about it.
        spaces[spaceId] = AgentWire.Space(
            id: spaceId, title: nil, icon: .seedling,
            target: AgentWire.SpaceTarget(kind: "task", id: identity.taskId, agentId: identity.agentId, workspaceId: identity.workspaceId),
            version: 0, createdAt: now, updatedAt: now
        )
        snapshot.creationError = nil
        publish()
        let client = client
        let created = Task<String, Error> {
            do {
                var response: AgentWire.CreateV2Response?
                for attempt in 0..<4 {
                    do {
                        response = try await client.createV2(id: spaceId, mutationId: mutationId, sectionId: sectionId, identity: named ? identity : nil)
                        break
                    } catch let error as AgentClientError where (error.status ?? 500) < 500 {
                        throw error
                    } catch {
                        if attempt == 3 { throw error }
                        try await Task.sleep(for: .milliseconds(500 * (attempt + 1)))
                    }
                }
                guard let response else { throw AgentClientError.invalidResponse }
                await self.created(spaceId, response)
                return response.agent.id
            } catch {
                await self.refused(spaceId, error)
                throw error
            }
        }
        creations[spaceId] = created
        return Creation(spaceId: spaceId, agentId: identity.agentId, workspaceId: identity.workspaceId, created: created)
    }

    private func created(_ spaceId: String, _ response: AgentWire.CreateV2Response) {
        creating.remove(spaceId)
        creations.removeValue(forKey: spaceId)
        adopt(response.space)
        agents.absorb((try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(response.agent))) ?? .null)
        schedulePlacesReload()
        publish()
    }

    private func refused(_ spaceId: String, _ error: Error) {
        creating.remove(spaceId)
        creations.removeValue(forKey: spaceId)
        inserts.removeAll { $0.spaceId == spaceId }
        if spaces[spaceId]?.version == 0 { spaces.removeValue(forKey: spaceId) }
        // The reason alone; the screen says what failed.
        snapshot.creationError = Self.describe(error)
        publish()
        // Whatever the daemon did keep is read back.
        if creating.isEmpty { if dragging { stale = true } else { reloadSidebar() } }
    }

    public func dismissV2Error() {
        snapshot.creationError = nil
        publish()
    }

    /// Closes new work nobody wrote in ("Close new work"), as desktop's
    /// `discard`: off the sidebar at once, then off the computer,
    /// once it is made there if it is still being made. A lost answer is
    /// asked again with the same mutation until the computer answers. Gone
    /// already (404), it stays gone; a refusal (409, the chat has a
    /// message) brings it back and reads the sidebar again.
    @discardableResult
    public func discard(_ spaceId: String) async -> Bool {
        let client = client
        let creation = creations[spaceId]
        return await removeAtOnce(spaceId) {
            // Never made there: nothing to close.
            if let creation, (try? await creation.value) == nil { return true }
            let mutationId = ClientID.make()
            var wait = 1.0
            while !(await self.stopped) {
                do {
                    try await client.removeSpace(spaceId, mutationId: mutationId)
                    await self.closed(spaceId)
                    return true
                } catch AgentClientError.status(404, _, _) {
                    await self.closed(spaceId)
                    return true
                } catch let error as AgentClientError where (error.status ?? 500) < 500 {
                    await self.discardRefused(spaceId)
                    return false
                } catch {
                    try? await Task.sleep(for: .seconds(wait))
                    wait = min(wait * 2, 10)
                }
            }
            return false
        }
    }

    private func closed(_ spaceId: String) {
        inserts.removeAll { $0.spaceId == spaceId }
    }

    /// Real work after all, as the computer holds it.
    private func discardRefused(_ spaceId: String) {
        removing[spaceId] = nil
        publish()
        reloadSidebar()
    }

    // MARK: Reuse

    /// Untouched new work the person could be sent back to rather than
    /// given another: its space, its conversation, the section its row is
    /// in, and how it is being made when it still is.
    public struct NewWork: Sendable {
        public let spaceId: String
        public let agentId: String
        public let workspaceId: String
        public let sectionId: String?
        public let creation: Task<String, Error>?
    }

    /// Unnamed new work to try in turn, newest first, as desktop has it:
    /// for a heading's "+" only what stands under that heading, for new
    /// work anywhere. Nothing being taken off counts, nor new work this
    /// phone last left holding something (`leftHolding`).
    public func newWork(under heading: String?) -> [NewWork] {
        let document = shown()
        let all = spaces.values
            .filter { $0.target.kind == "task" && Self.untouched($0) && removing[$0.id] == nil && !heldOnLeaving.contains($0.id) }
            .sorted { $0.createdAt > $1.createdAt }
            .compactMap { space -> NewWork? in
                guard let agentId = space.target.agentId, let workspaceId = space.target.workspaceId else { return nil }
                return NewWork(spaceId: space.id, agentId: agentId, workspaceId: workspaceId, sectionId: document.flatMap { Self.section(of: space.id, in: $0) }, creation: creations[space.id])
            }
        guard let heading else { return all }
        return all.filter { $0.sectionId == heading }
    }

    /// New work left holding something (text, a picture), whose draft may
    /// not have reached the computer and whose pictures never do: not
    /// reused until it is left empty again. Kept for this launch only, as
    /// desktop keeps it for its window.
    private var heldOnLeaving: Set<String> = []

    /// New work being made or looked for, by the heading whose "+" asked
    /// for it, nil for new work from the dock: what another ask meanwhile
    /// gets instead of a second one.
    private var goingToNewWork: [String?: (id: UUID, work: Task<Creation, Never>)] = [:]

    /// New work to go to, as desktop's `create`: from the dock,
    /// new work holding nothing wherever it is, newest first; from a
    /// heading's "+", only such new work under that heading. Made, right
    /// below Happy or that heading, only when none is empty. Asked again
    /// while one is on its way, the dock gets any, a "+" its own
    /// heading's: the same `id`, so it is opened once.
    public func goToNewWork(under heading: String?) -> (id: UUID, work: Task<Creation, Never>) {
        if let waiting = heading == nil ? goingToNewWork.values.first : goingToNewWork[heading] { return waiting }
        let id = UUID()
        let candidates = newWork(under: heading)
        let work = Task<Creation, Never> {
            defer { Task { await self.wentToNewWork(heading, id) } }
            for candidate in candidates where await isEmpty(candidate) {
                // Still new work, and still on the sidebar, once the computer has answered.
                guard let space = spaces[candidate.spaceId], Self.untouched(space), removing[space.id] == nil else { continue }
                let agentId = candidate.agentId
                return Creation(spaceId: candidate.spaceId, agentId: agentId, workspaceId: candidate.workspaceId, created: candidate.creation ?? Task { agentId })
            }
            return createV2(sectionId: heading)
        }
        goingToNewWork[heading] = (id, work)
        return (id, work)
    }

    private func wentToNewWork(_ heading: String?, _ id: UUID) {
        if goingToNewWork[heading]?.id == id { goingToNewWork[heading] = nil }
    }

    public func leftHolding(_ spaceId: String, _ holding: Bool) {
        if holding { heldOnLeaving.insert(spaceId) } else { heldOnLeaving.remove(spaceId) }
    }

    /// `happyAgentSpaceNewWorkIs`: nobody has named it yet.
    static func untouched(_ space: AgentWire.Space) -> Bool { space.title == nil && space.icon == .seedling }

    /// The section (or separator) heading the top-level row `id` sits under.
    static func section(of id: String, in document: SpaceSidebarDocument) -> String? {
        var heading: String?
        for item in document.items {
            if item.kind == .section || item.kind == .separator { heading = item.id }
            if item.kind == .space && item.id == id { return heading }
        }
        return nil
    }

    /// Whether new work still holds nothing on the computer, as desktop
    /// reads it: no run in its history, nothing pending, idle, not
    /// archived, and no draft text. A read that fails is not empty.
    public func isEmpty(_ work: NewWork) async -> Bool {
        // Still being made here: nothing can be in it yet.
        if let creation = work.creation { return (try? await creation.value) != nil }
        let client = client
        async let history = client.messages(work.agentId, limit: 1)
        async let start = client.bootstrap(work.agentId)
        guard let runs = try? await history.runs, let start = try? await start else { return false }
        return runs.isEmpty && (start.pending ?? []).isEmpty && start.agent.status == "idle" && start.agent.archivedAt == nil
            && (start.draft?.value?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Leaves a task: its row goes at once, and comes back if the computer refuses.
    @discardableResult
    public func leave(taskId: String, nodeId: String) async -> Bool {
        let client = client
        return await removeAtOnce(nodeId, asking: { try await client.leaveTask(taskId) })
    }

    /// Leaves a Surface: its row goes at once, and comes back if the computer refuses.
    @discardableResult
    public func leave(surfaceId: String, nodeId: String) async -> Bool {
        let client = client
        return await removeAtOnce(nodeId, asking: { try await client.leaveSurface(surfaceId) })
    }

    /// Archives a task or bot: its row goes at once, and comes back if the computer refuses.
    @discardableResult
    public func archive(kind: String, id: String, nodeId: String) async -> Bool {
        let client = client
        return await removeAtOnce(nodeId, asking: { try await kind == "bot" ? client.archiveBot(id) : client.archiveTask(id) })
    }

    /// Archives a subtask, and with its row everything under it: it goes
    /// at once, and comes back if the computer refuses.
    @discardableResult
    public func archiveSubtask(_ agentId: String, nodeId: String) async -> Bool {
        let client = client
        return await removeAtOnce(nodeId, subtask: true, asking: { try await client.archiveAgent(agentId) })
    }

    /// A leave or archive asked of the computer: gone already (404) counts
    /// as taken; anything else it answers is a refusal, with its reason.
    private func removeAtOnce(_ nodeId: String, subtask: Bool = false, asking work: @escaping @Sendable () async throws -> Void) async -> Bool {
        await removeAtOnce(nodeId, subtask: subtask) {
            do { try await work() }
            catch AgentClientError.status(404, _, _) {}
            catch {
                await self.removalRefused(nodeId, error)
                return false
            }
            return true
        }
    }

    /// Takes `nodeId`'s row off at once and asks the computer with `ask`.
    /// A second press while one is on its way sends nothing and shares its
    /// answer; a row already gone answers true.
    private func removeAtOnce(_ nodeId: String, subtask: Bool = false, _ ask: @escaping @Sendable () async -> Bool) async -> Bool {
        if let pending = removing[nodeId] { return await pending.asked.value }
        guard subtask ? places.agent(nodeId) != nil : spaces[nodeId] != nil else { return true }
        let asked = Task { await ask() }
        removing[nodeId] = Removal(subtask: subtask, asked: asked)
        snapshot.error = nil
        publish()
        return await asked.value
    }

    private func removalRefused(_ nodeId: String, _ error: Error) {
        removing[nodeId] = nil
        failed(error)
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
