import Foundation
import HappyWire

/// What the Stem Cells sidebar shows, made off the main thread.
public struct StemCellsSnapshot: Equatable, Sendable {
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
    public var rows: [StemCellsRow] = []
    /// Every row, folded away or not, for search.
    public var allRows: [StemCellsRow] = []
    /// The document those rows are drawn from, for gestures that edit it.
    public var document: SpaceSidebarDocument?
    /// Happy's own row, below which new work goes.
    public var happySpaceId: String?
    /// The person's Stem Cells setting, which runs Prioritizing; nil until read.
    public var prioritizing: Bool?
    /// The last act the daemon refused: its reason, empty when it gave none.
    public var error: String?
    /// Why the last new work could not be made, as `error`.
    public var stemCellError: String?
    /// What the references in messages read as and open.
    public var references = StemCellReferences()

    public init() {}
}

/// New work, named on this phone before the daemon answers.
public struct StemCellCreation: Sendable {
    public let spaceId: String
    public let agentId: String
    public let workspaceId: String
    /// The conversation's ID once the daemon has made it (`agentId` when the
    /// daemon takes the phone's names); a refusal takes the row away again.
    public let created: Task<String, Error>
}

/// One paired computer's Stem Cells sidebar, a port of desktop's
/// `spacesStore.ts` in its document mode: the document the daemon was last
/// heard to hold, with this phone's unconfirmed edits applied on top by the
/// same function the daemon applies them with, so a confirmation draws
/// exactly what was already drawn and nothing moves.
public actor StemCellsStore {
    /// The opaque user setting that runs Prioritizing.
    public static let settingKey = "happy-desktop.experiments.stemCells"
    static let attentionRenew: Duration = .seconds(60)
    static let attentionCalm: Duration = .seconds(300)

    private let client: DirectAgentClient
    private let offline: StemCellsOfflineFile?
    private var keeping: Task<Void, Never>?
    private let labels: StemCellsRows.Labels
    private let continuation: AsyncStream<StemCellsSnapshot>.Continuation
    public nonisolated let updates: AsyncStream<StemCellsSnapshot>

    private var snapshot = StemCellsSnapshot()
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
    /// New work put away here: off the sidebar at once, before the daemon
    /// hears, and back if it refuses.
    private var awayIds: Set<String> = []
    /// Of those, the ones the computer has closed: let go once its
    /// document no longer has them.
    private var closedIds: Set<String> = []
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
    private var agents = StemCellsAgents()
    /// Artifact titles references asked for, as read; and those being read.
    private var artifactTitles: [String: StemCellReferences.Artifact] = [:]
    private var artifactReads: Set<String> = []
    private var places = StemCellsPlaces()
    private var placesReload: Task<Void, Never>?
    /// Names given here whose rename no read has carried yet.
    private var titleIntents: [String: (title: String, base: String?)] = [:]

    // Attention: Prioritizing holds its batches while the person is in the list.
    private var attention: (state: String, at: ContinuousClock.Instant)?
    private var attentionIdle: Task<Void, Never>?
    private var attentionVisible = true

    public init(client: DirectAgentClient, offline: StemCellsOfflineFile? = nil, labels: StemCellsRows.Labels = StemCellsRows.Labels()) {
        self.client = client
        self.offline = offline
        self.labels = labels
        (updates, continuation) = AsyncStream.makeStream(of: StemCellsSnapshot.self, bufferingPolicy: .bufferingNewest(1))
    }

    // MARK: Life

    /// DirectSyncEngine owns the stream for account-backed sessions. The
    /// standalone start() remains available for existing fixtures/consumers.
    public func startExternal() async { await restoreOffline() }

    public func externalResync(loadSidebar: Bool) async {
        for listener in listeners.values { listener.continuation.yield(.resync) }
        for listener in typeListeners.values { listener.continuation.yield(.resync) }
        snapshot.live = true
        if loadSidebar { await load() } else { publish() }
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
        await flush()
        following?.cancel(); following = nil
        loading?.cancel(); loading = nil
        placesReload?.cancel(); placesReload = nil
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
            } catch DirectAgentError.revoked {
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
        do {
            async let health = client.health()
            async let sidebar = client.sidebar(widgets: true)
            async let bots = client.bots()
            async let tasks = client.tasks()
            async let setting = client.userSetting(Self.settingKey)
            async let surfaceList = client.surfaces()
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
            surfaces = served ?? []
            self.bots = botList; self.tasks = taskList
            agents = StemCellsAgents()
            for owner in botList + taskList { if let agent = owner["agent"] { agents.absorb(agent) } }
            spaces = [:]
            for space in answer.spaces { adopt(space) }
            agentIcons = answer.agentIcons ?? [:]
            artifactId = answer.artifactId
            if !(writes > 0 || dragging) {
                if held == nil || held!.version <= answer.version { held = (answer.version, answer.html) }
            } else {
                stale = true
            }
            snapshot.availability = .available
            rebuildPlaces()
            let pending = heldEvents ?? []
            heldEvents = nil
            // What changed while away is read again when next asked for.
            artifactTitles = [:]
            for event in pending { receive(event) }
            publish()
            keeping?.cancel()
            saveOffline()
        } catch {
            heldEvents = nil
            if snapshot.availability == .loading, case DirectAgentError.status(404, _, _) = error { snapshot.availability = .unsupported }
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
        let wanted = ids.filter { artifactTitles[$0] == nil && !artifactReads.contains($0) }
        guard !wanted.isEmpty else { return }
        artifactReads.formUnion(wanted)
        let client = client
        Task {
            for id in wanted {
                let read: StemCellReferences.Artifact?
                do {
                    read = StemCellReferences.artifact(try await client.artifact(id))
                } catch DirectAgentError.status(404, _, _) {
                    read = .missing
                } catch {
                    read = nil
                }
                await artifactRead(id, read)
            }
        }
    }

    private func artifactRead(_ id: String, _ read: StemCellReferences.Artifact?) {
        artifactReads.remove(id)
        guard let read else { return }
        artifactTitles[id] = read
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
        places = StemCellsPlaces(bots: decode(composed(bots)), tasks: decode(composed(tasks)), surfaces: surfaces)
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
            schedulePlacesReload()
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
    public func rows(of html: String) -> [StemCellsRow]? {
        guard let document = try? SpaceSidebar.parse(html) else { return nil }
        return StemCellsRows.all(document, spaces: spaces, places: places, agentIcons: agentIcons, labels: labels)
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
        for id in closedIds where SpaceSidebar.locate(document, id) == nil {
            closedIds.remove(id)
            awayIds.remove(id)
        }
        inserts.removeAll { insert in !creating.contains(insert.spaceId) && SpaceSidebar.locate(document, insert.spaceId) != nil }
        for insert in inserts where SpaceSidebar.locate(document, insert.spaceId) == nil {
            document = SidebarDocumentEdits.insert(document, spaceId: insert.spaceId, sectionId: insert.sectionId, happySpaceId: insert.happySpaceId) ?? document
        }
        for id in awayIds {
            if let applied = try? SpaceSidebar.apply(document, [.remove(id)]) { document = applied.document }
        }
        return document
    }

    private func publish() {
        if let document = shown() {
            let all = StemCellsRows.all(document, spaces: spaces, places: places, agentIcons: agentIcons, labels: labels)
            snapshot.rows = StemCellsRows.visible(all)
            snapshot.allRows = all
            snapshot.document = document
        }
        snapshot.happySpaceId = spaces.values.first { places.isHappy($0) }?.id
        var references = StemCellReferences.entities(owners: composedOwners)
        references.artifacts = artifactTitles
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
            } catch let error as DirectAgentError where (error.status ?? 500) < 500 {
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
        if case DirectAgentError.status(_, _, let message?) = error { return message }
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
    public func createStemCell(sectionId: String? = nil) -> StemCellCreation {
        let spaceId = ClientID.make()
        let mutationId = ClientID.make()
        let identity = StemCellIdentity.make()
        let happySpaceId = snapshot.happySpaceId
        let named = capabilities.stemCellIdentities == true
        creating.insert(spaceId)
        inserts.append((spaceId, sectionId, happySpaceId))
        let now = Date().timeIntervalSince1970 * 1000
        // Version 0 is older than anything the daemon says about it.
        spaces[spaceId] = AgentWire.Space(
            id: spaceId, title: nil, icon: .stemCell,
            target: AgentWire.SpaceTarget(kind: "task", id: identity.taskId, agentId: identity.agentId, workspaceId: identity.workspaceId),
            version: 0, createdAt: now, updatedAt: now
        )
        snapshot.stemCellError = nil
        publish()
        let client = client
        let created = Task<String, Error> {
            do {
                var response: AgentWire.CreateStemCellResponse?
                for attempt in 0..<4 {
                    do {
                        response = try await client.createStemCell(id: spaceId, mutationId: mutationId, sectionId: sectionId, identity: named ? identity : nil)
                        break
                    } catch let error as DirectAgentError where (error.status ?? 500) < 500 {
                        throw error
                    } catch {
                        if attempt == 3 { throw error }
                        try await Task.sleep(for: .milliseconds(500 * (attempt + 1)))
                    }
                }
                guard let response else { throw DirectAgentError.invalidResponse }
                await self.created(spaceId, response)
                return response.agent.id
            } catch {
                await self.refused(spaceId, error)
                throw error
            }
        }
        creations[spaceId] = created
        return StemCellCreation(spaceId: spaceId, agentId: identity.agentId, workspaceId: identity.workspaceId, created: created)
    }

    private func created(_ spaceId: String, _ response: AgentWire.CreateStemCellResponse) {
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
        snapshot.stemCellError = Self.describe(error)
        publish()
        // Whatever the daemon did keep is read back.
        if creating.isEmpty { if dragging { stale = true } else { reloadSidebar() } }
    }

    public func dismissStemCellError() {
        snapshot.stemCellError = nil
        publish()
    }

    /// Takes new work off the sidebar here only, or puts it back: leaving
    /// it, while the leaving may still be undone.
    public func putAway(_ spaceId: String, _ away: Bool) {
        guard awayIds.contains(spaceId) != away else { return }
        if away { awayIds.insert(spaceId) } else { awayIds.remove(spaceId) }
        publish()
    }

    /// Closes new work nobody wrote in: off the sidebar at once, then off
    /// the computer, once it is made there if it is still being made. The
    /// daemon refuses once its chat has a message, which brings it back.
    public func discard(_ spaceId: String) {
        putAway(spaceId, true)
        let mutationId = ClientID.make()
        let client = client
        let creation = creations[spaceId]
        Task {
            // Never made there: nothing to close.
            if let creation, (try? await creation.value) == nil { return }
            for attempt in 0..<3 {
                do {
                    try await client.removeSpace(spaceId, mutationId: mutationId)
                    return await self.closed(spaceId)
                } catch let error as DirectAgentError where error.status == 404 {
                    // An earlier try closed it.
                    return await self.closed(spaceId)
                } catch let error as DirectAgentError where (error.status ?? 500) < 500 {
                    break
                } catch {
                    try? await Task.sleep(for: .milliseconds(500 * (attempt + 1)))
                }
            }
            await self.putAway(spaceId, false)
        }
    }

    private func closed(_ spaceId: String) {
        inserts.removeAll { $0.spaceId == spaceId }
        closedIds.insert(spaceId)
        publish()
    }

    /// Leaves a task, or archives a task or bot; the row goes when the daemon says so.
    public func leave(taskId: String) {
        let client = client
        Task { do { try await client.leaveTask(taskId) } catch { self.failed(error) } }
    }

    public func archive(kind: String, id: String) {
        let client = client
        Task {
            do { try await kind == "bot" ? client.archiveBot(id) : client.archiveTask(id) }
            catch { self.failed(error) }
        }
    }

    /// Archives a subtask; its row goes when the daemon says so.
    public func archiveSubtask(_ agentId: String) {
        let client = client
        Task {
            do { try await client.archiveAgent(agentId) }
            catch { self.failed(error) }
        }
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
        let sidebar = StemCellsOfflineSnapshot.Sidebar(
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
