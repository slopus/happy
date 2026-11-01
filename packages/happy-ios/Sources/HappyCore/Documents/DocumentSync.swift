import Foundation
import HappyWire

/// Where the document's own changes stand, as the editor's header says it.
public enum DocumentSaveState: Equatable, Sendable {
    /// The computer has everything made here.
    case saved
    /// On its way now.
    case saving
    /// Kept on this phone until the computer can be reached.
    case waiting
}

/// Another editor in the document: who, and where their cursor is.
public struct DocumentPeer: Equatable, Sendable {
    /// The daemon's name for their stream's presence (`clientKey`).
    public var key: String
    public var clientID: Int
    public var name: String
    /// CSS colour as desktop sends it (`#rrggbb`).
    public var color: String
    public var anchor: YRelativePosition?
    public var head: YRelativePosition?

    public init(key: String, clientID: Int, name: String, color: String, anchor: YRelativePosition? = nil, head: YRelativePosition? = nil) {
        self.key = key
        self.clientID = clientID
        self.name = name
        self.color = color
        self.anchor = anchor
        self.head = head
    }

    /// BlockNote's awareness state: `{ user: { name, color }, cursor: { anchor, head } }`.
    init?(key: String, clientID: Int, state: YAny) {
        guard let user = state["user"] else { return nil }
        self.init(key: key, clientID: clientID, name: user["name"]?.stringValue ?? "", color: user["color"]?.stringValue ?? "#888888",
                  anchor: state["cursor"]?["anchor"].flatMap(YRelativePosition.init(json:)),
                  head: state["cursor"]?["head"].flatMap(YRelativePosition.init(json:)))
    }

    /// This phone's state in the same shape, for desktop to draw.
    public static func state(name: String, color: String, anchor: YRelativePosition?, head: YRelativePosition?) -> YAny {
        var pairs: [(String, YAny)] = [("user", .object([("name", .string(name)), ("color", .string(color))]))]
        if let anchor, let head { pairs.append(("cursor", .object([("anchor", anchor.json), ("head", head.json)]))) }
        return .object(pairs)
    }
}

/// An editor made off the main thread, handed to the one that will own it.
/// Whoever made it lets go of it in the same step.
public struct DocumentHandoff: @unchecked Sendable {
    public let editor: DocumentEditor
}

public enum DocumentOpening: Equatable, Sendable {
    case ready
    /// The computer keeps this document as Markdown only (no
    /// `collaborativeDocuments`): it can be read, not edited.
    case markdownOnly
    /// Nothing kept here, and the computer can't be reached.
    case unavailable(String)
}

public enum DocumentSyncEvent: Sendable {
    /// A change from elsewhere, for the editor's replica.
    case remote([UInt8])
    /// The computer's copy replaces this one (a change it refused twice).
    case reset(DocumentHandoff)
    case save(DocumentSaveState)
    case peers([DocumentPeer])
    /// Something to say for a moment: a change refused.
    case notice(String)
    /// The document is gone from the computer.
    case gone
}

/// One document's sync, off the main thread (docs/DOCUMENT-EDITOR.md).
///
/// It keeps its own replica of the document, beside the editor's: every
/// change the editor makes comes here through `local`, is kept on disk at
/// once (`DocumentKeep`), and goes to the computer in batches, one at a
/// time and at least `spacing` apart, each under a mutation ID that a retry
/// repeats. Changes from elsewhere land here first and go on to the editor
/// only when they changed something. A reconnect subscribes the new
/// stream and catches up by state vector, so nothing a dropped stream
/// carried is missed.
///
/// It lives while an editor holds it, and after that until everything made
/// here is sent (`DocumentLibrary`).
public actor DocumentSync {
    public nonisolated let surfaceId: String
    /// Each local change the editor made, in order (`DocumentEditor.onLocalUpdate`).
    public nonisolated let local: AsyncStream<[UInt8]>.Continuation
    /// This phone's awareness state; nil when it leaves.
    public nonisolated let presence: AsyncStream<YAny?>.Continuation
    public static let spacing: Duration = .milliseconds(200)
    public static let presenceSpacing: Duration = .milliseconds(250)
    public static let presenceRefresh: Duration = .seconds(15)

    /// Whether the replica's last transaction changed anything: set from
    /// inside its own transactions, which run on this actor.
    private final class Changed { var value = false }

    private let client: AgentClient
    private let streams: DocumentStreams
    private let keep: DocumentKeep?
    private let retire: @Sendable (DocumentSync) async -> Void
    private let localStream: AsyncStream<[UInt8]>
    private let presenceStream: AsyncStream<YAny?>
    private var replica = YDoc()
    private let changed = Changed()
    private var meta = DocumentKeep.Meta()
    private var sending: DocumentKeep.Sending?
    /// A local change came after the batch on its way was made.
    private var changedSinceBatch = false
    private var editorClient = 0
    private var holders = 0
    private var opening: DocumentOpening?
    private var streamId: String?
    private var caughtUp = false
    private var refusals = 0
    private var lastPost: ContinuousClock.Instant?
    private var flushing: Task<Void, Never>?
    private var connecting: Task<Void, Never>?
    private var compacting: Task<Void, Never>?
    private var following: [Task<Void, Never>] = []
    private var listeners: [UUID: AsyncStream<DocumentSyncEvent>.Continuation] = [:]
    private var save: DocumentSaveState = .saved
    private var localPresence: YAny?
    private var presenceClock = 0
    private var presenceSending: Task<Void, Never>?
    private var presenceDirty = false
    private var peers: [String: (revision: Int, peer: DocumentPeer?)] = [:]
    private var closed = false
    /// Updates posted, for tests that count them.
    public private(set) var posts = 0
    /// Local changes taken in and kept.
    public private(set) var kept = 0

    /// A sync nothing retires; a stored closure, as AsyncDefaultArgumentTests asks of defaults.
    public static let staysOpen: @Sendable (DocumentSync) async -> Void = { _ in }

    public init(surfaceId: String, client: AgentClient, streams: DocumentStreams, offlineDirectory: URL?,
                retire: @escaping @Sendable (DocumentSync) async -> Void = DocumentSync.staysOpen) {
        self.surfaceId = surfaceId
        self.client = client
        self.streams = streams
        self.retire = retire
        keep = offlineDirectory.map { DocumentKeep(directory: DocumentKeep.directory(offline: $0, surfaceId: surfaceId)) }
        (localStream, local) = AsyncStream.makeStream(of: [UInt8].self)
        (presenceStream, presence) = AsyncStream.makeStream(of: YAny?.self, bufferingPolicy: .bufferingNewest(1))
    }

    public func events() -> AsyncStream<DocumentSyncEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: DocumentSyncEvent.self)
        listeners[id] = continuation
        continuation.yield(.save(save))
        continuation.onTermination = { [weak self] _ in Task { await self?.removeListener(id) } }
        return stream
    }

    private func removeListener(_ id: UUID) { listeners[id] = nil }

    private func emit(_ event: DocumentSyncEvent) {
        for listener in listeners.values { listener.yield(event) }
    }

    // MARK: Opening

    /// The document from disk if it was kept, else from the computer. Once.
    public func start() async -> DocumentOpening {
        dispatchPrecondition(condition: .notOnQueue(.main))
        if let opening { return opening }
        let result = await load()
        if opening == nil { opening = result }
        if result == .ready && following.isEmpty { follow() }
        publishSave()
        return opening ?? result
    }

    private func load() async -> DocumentOpening {
        watchReplica()
        if let keep, keep.exists {
            let kept = keep.read()
            meta = kept.meta
            sending = kept.sending
            if let state = kept.state { try? replica.applyUpdate(state) }
            for update in kept.local { try? replica.applyUpdate(update) }
            if !kept.local.isEmpty { meta.unsent = true }
            return .ready
        }
        do {
            let state = try await client.documentState(surfaceId)
            try replica.applyUpdate(state.update)
            meta.serverVector = state.stateVector
            meta.seq = state.seq
            try? keep?.writeState(replica.encodeStateAsUpdate())
            try? keep?.writeMeta(meta)
            return .ready
        } catch AgentClientError.status(let status, _, _) where status == 404 || status == 501 {
            // A computer without shared documents has no `/state`; one with them doesn't know this one.
            return (try? await client.collaborativeDocuments()) == true ? .unavailable("") : .markdownOnly
        } catch {
            return .unavailable(Store.describe(error))
        }
    }

    private func watchReplica() {
        let changed = changed
        replica.onTransaction = { result in
            if !result.changed.isEmpty || !result.deleteSet.isEmpty { changed.value = true }
        }
    }

    /// An editor over the replica as it stands, for the main thread. Later
    /// remote changes come as `.remote` events in order after it.
    public func editor() -> DocumentHandoff? {
        guard opening == .ready, !closed else { return nil }
        holders += 1
        return makeEditor()
    }

    private func makeEditor() -> DocumentHandoff {
        let vector = replica.stateVector()
        var clientID = YDoc.randomClientID()
        while vector[clientID] != nil || meta.localClients.contains(clientID) { clientID = YDoc.randomClientID() }
        let doc = YDoc(clientID: clientID)
        try? doc.applyUpdate(replica.encodeStateAsUpdate())
        editorClient = clientID
        meta.localClients.insert(clientID)
        try? keep?.writeMeta(meta)
        return DocumentHandoff(editor: DocumentEditor(doc: doc))
    }

    /// The editor is gone. Its presence leaves now; the sync itself once
    /// everything made here has reached the computer.
    public func release() async {
        holders = max(0, holders - 1)
        guard holders == 0 else { return }
        setPresence(nil)
        if save == .saved { await shutDown() }
    }

    private func follow() {
        let local = localStream
        following.append(Task { [weak self] in
            for await update in local { await self?.received(local: update) }
        })
        let presence = presenceStream
        following.append(Task { [weak self] in
            for await state in presence { await self?.setPresence(state) }
        })
        following.append(Task { [weak self, streams, surfaceId] in
            for await event in await streams.events(surfaceId) { await self?.received(stream: event) }
        })
    }

    // MARK: Local changes

    private func received(local update: [UInt8]) {
        dispatchPrecondition(condition: .notOnQueue(.main))
        guard !closed else { return }
        try? replica.applyUpdate(update, origin: "local")
        try? keep?.append(update)
        kept += 1
        changedSinceBatch = true
        if !meta.unsent {
            meta.unsent = true
            try? keep?.writeMeta(meta)
        }
        // A second editor on the same document hears the first one's change.
        if holders > 1 { emit(.remote(update)) }
        if (keep?.logSize ?? 0) > 256 * 1024 { compactNow() }
        publishSave()
        flush()
    }

    private func flush() {
        guard streamId != nil, caughtUp, flushing == nil, sending != nil || meta.unsent else { return }
        flushing = Task { await self.flushLoop() }
    }

    private func flushLoop() async {
        var failures = 0
        while !closed, streamId != nil, caughtUp, !Task.isCancelled {
            if sending == nil {
                guard meta.unsent else { break }
                sending = makeBatch()
                try? keep?.writeSending(sending)
                changedSinceBatch = false
            }
            guard let batch = sending else { break }
            if let lastPost {
                let wait = lastPost + Self.spacing - ContinuousClock.now
                if wait > .zero { do { try await Task.sleep(for: wait) } catch { break } }
            }
            publishSave()
            lastPost = .now
            posts += 1
            do {
                let seq = try await client.sendDocumentUpdate(surfaceId, mutationId: batch.mutationId, update: Array(batch.update))
                guard sending?.mutationId == batch.mutationId else { continue }
                for (client, clock) in batch.vector { meta.serverVector[client] = max(meta.serverVector[client] ?? 0, clock) }
                meta.seq = max(meta.seq, seq)
                sending = nil
                try? keep?.writeSending(nil)
                if !changedSinceBatch { meta.unsent = false }
                try? keep?.writeMeta(meta)
                failures = 0
                refusals = 0
            } catch AgentClientError.status(404, _, _) {
                gone()
                break
            } catch let error as AgentClientError where Self.refusal(error) {
                await refused(Store.describe(error))
                break
            } catch {
                if Task.isCancelled || streamId == nil { break }
                failures += 1
                do { try await Task.sleep(for: .seconds(min(30, 1 << min(failures - 1, 5)))) } catch { break }
            }
        }
        flushing = nil
        publishSave()
        if !closed, sending != nil || meta.unsent { flush() }
    }

    static func refusal(_ error: AgentClientError) -> Bool {
        guard let status = error.status else { return false }
        return (400..<500).contains(status) && status != 408 && status != 429
    }

    /// Everything made here the computer is not known to have: local
    /// clients' structs past what it took, and the delete set.
    private func makeBatch() -> DocumentKeep.Sending {
        var since = replica.stateVector()
        var vector: [Int: Int] = [:]
        for client in meta.localClients {
            if let clock = since[client] { vector[client] = clock }
            since[client] = meta.serverVector[client] ?? 0
        }
        return DocumentKeep.Sending(mutationId: ClientID.make(), update: Data(replica.encodeStateAsUpdate(since: since)), vector: vector)
    }

    /// A refusal: once, read the computer's state and send what it lacks
    /// again; twice, take the computer's copy and drop what it won't have.
    private func refused(_ reason: String) async {
        sending = nil
        try? keep?.writeSending(nil)
        refusals += 1
        if refusals < 2 {
            caughtUp = false
            do { try await catchUp(); caughtUp = streamId != nil } catch {}
            return
        }
        refusals = 0
        do {
            let state = try await client.documentState(surfaceId)
            replica = YDoc()
            watchReplica()
            try replica.applyUpdate(state.update)
            meta = DocumentKeep.Meta()
            meta.serverVector = state.stateVector
            meta.seq = state.seq
            keep?.remove()
            try? keep?.writeState(replica.encodeStateAsUpdate())
            if holders > 0 { emit(.reset(makeEditor())) } else { try? keep?.writeMeta(meta) }
        } catch {}
        emit(.notice(reason))
    }

    private func gone() {
        keep?.remove()
        meta = DocumentKeep.Meta()
        sending = nil
        emit(.gone)
        Task { await shutDown() }
    }

    // MARK: The stream

    private func received(stream event: DocumentStreamEvent) {
        dispatchPrecondition(condition: .notOnQueue(.main))
        guard !closed else { return }
        switch event {
        case .connected(let id):
            streamId = id
            caughtUp = false
            connecting?.cancel()
            connecting = Task { await self.connect(id) }
        case .disconnected:
            streamId = nil
            caughtUp = false
            connecting?.cancel(); connecting = nil
            flushing?.cancel(); flushing = nil
            presenceSending?.cancel(); presenceSending = nil
            if !peers.isEmpty { peers = [:]; publishPeers() }
            publishSave()
        case .update(let frame):
            guard let bytes = Data(base64Encoded: frame.update) else { return }
            applyRemote(Array(bytes))
            meta.seq = max(meta.seq, frame.seq)
        case .presence(let frame):
            receivedPresence(frame)
        }
    }

    private func connect(_ id: String) async {
        var failures = 0
        while streamId == id, !closed, !Task.isCancelled {
            do {
                try await client.subscribeDocument(surfaceId, streamId: id)
                guard streamId == id else { return }
                try await catchUp()
                guard streamId == id else { return }
                caughtUp = true
                presenceDirty = localPresence != nil
                sendPresenceSoon()
                flush()
                publishSave()
                return
            } catch AgentClientError.status(404, _, _) {
                gone()
                return
            } catch {
                failures += 1
                do { try await Task.sleep(for: .seconds(min(30, 1 << min(failures - 1, 5)))) } catch { return }
            }
        }
    }

    /// Only what the replica lacks, and what the computer holds now.
    private func catchUp() async throws {
        let state = try await client.documentState(surfaceId, stateVector: replica.stateVector())
        applyRemote(state.update)
        meta.serverVector = state.stateVector
        meta.seq = max(meta.seq, state.seq)
        let vector = replica.stateVector()
        if meta.localClients.contains(where: { (vector[$0] ?? 0) > (state.stateVector[$0] ?? 0) }) { meta.unsent = true }
        try? keep?.writeMeta(meta)
    }

    private func applyRemote(_ update: [UInt8]) {
        changed.value = false
        try? replica.applyUpdate(update, origin: "remote")
        guard changed.value else { return }
        changed.value = false
        emit(.remote(update))
        compactSoon()
    }

    // MARK: Keeping

    private func compactSoon() {
        guard compacting == nil else { return }
        compacting = Task {
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            self.compactNow()
        }
    }

    private func compactNow() {
        compacting?.cancel()
        compacting = nil
        guard !closed || keep?.exists == true else { return }
        try? keep?.writeState(replica.encodeStateAsUpdate())
    }

    // MARK: Presence

    private func setPresence(_ state: YAny?) {
        guard !closed, state != localPresence else { return }
        localPresence = state
        presenceDirty = true
        sendPresenceSoon()
    }

    private func sendPresenceSoon() {
        guard presenceSending == nil, streamId != nil, caughtUp, editorClient != 0 else { return }
        presenceSending = Task { await self.presenceLoop() }
    }

    /// At most one awareness update per `presenceSpacing`, and the same
    /// again every `presenceRefresh` so the daemon doesn't time it out.
    private func presenceLoop() async {
        var last: ContinuousClock.Instant?
        while !closed, let id = streamId, caughtUp, !Task.isCancelled {
            if !presenceDirty {
                guard localPresence != nil else { break }
                do { try await Task.sleep(for: Self.presenceSpacing) } catch { break }
                if let last, ContinuousClock.now - last >= Self.presenceRefresh { presenceDirty = true }
                continue
            }
            if let last {
                let wait = last + Self.presenceSpacing - ContinuousClock.now
                if wait > .zero { do { try await Task.sleep(for: wait) } catch { break } }
            }
            presenceDirty = false
            presenceClock += 1
            last = .now
            await sendPresence(id)
        }
        presenceSending = nil
    }

    private func sendPresence(_ id: String) async {
        let update = YAwarenessState.encode([YAwarenessState(clientID: editorClient, clock: presenceClock, state: localPresence)])
        try? await client.sendDocumentPresence(surfaceId, streamId: id, awarenessClientId: editorClient, update: update)
    }

    private func receivedPresence(_ frame: DocumentPresenceFrame) {
        if let seen = peers[frame.clientKey], seen.revision >= frame.revision { return }
        var peer: DocumentPeer?
        if frame.active, let text = frame.update, let bytes = Data(base64Encoded: text),
           let states = try? YAwarenessState.decode(Array(bytes)),
           let state = states.first(where: { $0.clientID != editorClient }), let value = state.state {
            peer = DocumentPeer(key: frame.clientKey, clientID: state.clientID, state: value)
        }
        peers[frame.clientKey] = (frame.revision, peer)
        publishPeers()
    }

    private func publishPeers() {
        emit(.peers(peers.values.compactMap(\.peer).sorted { $0.key < $1.key }))
    }

    // MARK: State

    private func publishSave() {
        let next: DocumentSaveState = sending == nil && !meta.unsent ? .saved : (streamId != nil ? .saving : .waiting)
        guard next != save else { return }
        save = next
        emit(.save(next))
        if next == .saved, holders == 0, opening == .ready { Task { await self.shutDownIfIdle() } }
    }

    private func shutDownIfIdle() async {
        if holders == 0, save == .saved { await shutDown() }
    }

    public var saveState: DocumentSaveState { save }
    public var head: Int { meta.seq }
    public var isClosed: Bool { closed }

    /// Lets go of the stream and keeps the replica whole.
    func shutDown() async {
        guard !closed else { return }
        compactNow()
        closed = true
        for task in following { task.cancel() }
        following = []
        presenceSending?.cancel(); presenceSending = nil
        connecting?.cancel(); connecting = nil
        flushing?.cancel(); flushing = nil
        if let id = streamId {
            if localPresence != nil || presenceClock > 0 {
                localPresence = nil
                presenceClock += 1
                await sendPresence(id)
            }
            try? await client.unsubscribeDocument(surfaceId, streamId: id)
        }
        keep?.close()
        for listener in listeners.values { listener.finish() }
        listeners.removeAll()
        await retire(self)
    }
}

/// The documents of one account: one `DocumentSync` per document while an
/// editor holds it or it has changes to send. When the stream comes back,
/// those left with unsent changes (closed offline, or kept across a
/// relaunch) are opened again to send them, editor or not.
public actor DocumentLibrary {
    public nonisolated let streams = DocumentStreams()
    private let client: AgentClient
    private let directory: URL?
    private var syncs: [String: DocumentSync] = [:]

    public init(client: AgentClient, directory: URL?) {
        self.client = client
        self.directory = directory
    }

    public func document(_ surfaceId: String) -> DocumentSync {
        if let sync = syncs[surfaceId] { return sync }
        let sync = DocumentSync(surfaceId: surfaceId, client: client, streams: streams, offlineDirectory: directory,
                                retire: { [weak self] sync in await self?.retire(sync) })
        syncs[surfaceId] = sync
        return sync
    }

    private func retire(_ sync: DocumentSync) {
        if syncs[sync.surfaceId] === sync { syncs[sync.surfaceId] = nil }
    }

    public var open: [String] { syncs.keys.sorted() }

    func opened(_ hello: JSONValue) async {
        await streams.opened(hello)
        guard await streams.current != nil else { return }
        resumeUnsent()
    }

    func closed() async { await streams.closed() }

    func frame(_ event: String, data: String) async { await streams.frame(event, data: data) }

    func stop() async {
        let all = syncs.values
        syncs = [:]
        for sync in all { await sync.shutDown() }
        await streams.stop()
    }

    /// Those kept with something unsent, which no editor holds now.
    private func resumeUnsent() {
        guard let directory else { return }
        let root = directory.appendingPathComponent("documents", isDirectory: true)
        guard let ids = try? FileManager.default.contentsOfDirectory(atPath: root.path) else { return }
        for id in ids where syncs[id] == nil {
            let keep = DocumentKeep(directory: root.appendingPathComponent(id, isDirectory: true))
            let kept = keep.read()
            guard kept.meta.unsent || kept.sending != nil || !kept.local.isEmpty else { continue }
            let sync = document(id)
            Task { _ = await sync.start() }
        }
    }
}
