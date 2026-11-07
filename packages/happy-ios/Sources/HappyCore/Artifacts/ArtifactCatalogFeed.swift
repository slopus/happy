import Foundation
import HappyWire

/// The artifact catalog of one paired computer, tombstones included, kept
/// on the phone: read from disk first, then whole from the computer, then
/// kept current by its `artifact.*` events (docs/offline-first.md). Every
/// change is written back, so the list opens on what it last showed with
/// no network. One per account, the engine's (`SyncEngine.artifacts`).
public actor ArtifactCatalogFeed {
    public struct State: Equatable, Sendable {
        /// Newest change first.
        public var items: [ArtifactSummary] = []
        /// Something was read, from disk or the computer: the list can
        /// say it is empty rather than loading.
        public var loaded = false
        /// This computer keeps no artifacts (`404` on the catalog).
        public var unsupported = false
        /// The last read failed, and why.
        public var error: String?

        public init() {}
    }

    /// The checkpoint the list is kept under, in the account's `direct.sqlite`.
    public static let resource = "artifact-catalog"
    /// The most pages one read follows: 2000 artifacts.
    static let pageLimit = 20

    public typealias Fetch = @Sendable (_ cursor: String?) async throws -> JSONValue
    public typealias Fetch1 = @Sendable (_ id: String) async throws -> JSONValue
    public typealias Keep = @Sendable (JSONValue) async throws -> Void
    public typealias Kept = @Sendable () async throws -> JSONValue?

    private let fetch: Fetch
    private let fetchOne: Fetch1
    private let keep: Keep
    private let kept: Kept
    private let events: @Sendable () async -> AsyncStream<Store.ConversationEvent>
    private var state = State()
    private var listeners: [UUID: AsyncStream<State>.Continuation] = [:]
    private var following: Task<Void, Never>?
    private var reading: Task<Void, Never>?
    private var again = false
    private var started = false

    public init(fetch: @escaping Fetch, fetchOne: @escaping Fetch1, keep: @escaping Keep, kept: @escaping Kept, events: @escaping @Sendable () async -> AsyncStream<Store.ConversationEvent>) {
        self.fetch = fetch
        self.fetchOne = fetchOne
        self.keep = keep
        self.kept = kept
        self.events = events
    }

    /// The state now and after every change.
    public func states() -> AsyncStream<State> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: State.self, bufferingPolicy: .bufferingNewest(1))
        listeners[id] = continuation
        continuation.yield(state)
        continuation.onTermination = { [weak self] _ in Task { await self?.unlisten(id) } }
        return stream
    }

    private func unlisten(_ id: UUID) { listeners[id] = nil }

    private func publish() {
        for listener in listeners.values { listener.yield(state) }
    }

    /// Disk, then the computer, then its events, until `stop`.
    public func start() async {
        guard !started else { return }
        started = true
        if let value = try? await kept(), let items = value.arrayValue {
            state.items = ArtifactCatalog.sorted(items.compactMap(ArtifactSummary.init(json:)))
            state.loaded = true
            publish()
        }
        let events = events
        following = Task { [weak self] in
            let stream = await events()
            await self?.refresh()
            for await event in stream {
                guard !Task.isCancelled else { return }
                switch event {
                case .resync: await self?.refresh()
                case .event(let envelope): await self?.receive(envelope)
                }
            }
        }
    }

    public func stop() {
        following?.cancel()
        following = nil
        reading?.cancel()
        reading = nil
        for listener in listeners.values { listener.finish() }
        listeners = [:]
    }

    /// Reads the whole catalog again; one already under way is followed
    /// by one more, so the last read begins after the last ask.
    public func refresh() async {
        if let reading {
            again = true
            await reading.value
            return
        }
        let task = Task { await self.read() }
        reading = task
        await task.value
        reading = nil
        if again {
            again = false
            await refresh()
        }
    }

    private func read() async {
        defer { publish() }
        var items: [ArtifactSummary] = []
        var cursor: String?
        do {
            for _ in 0..<Self.pageLimit {
                let page = ArtifactCatalog.page(try await fetch(cursor))
                items += page.items
                cursor = page.next
                if cursor == nil { break }
                try Task.checkCancellation()
            }
        } catch AgentClientError.status(404, _, _) {
            state.unsupported = true
            state.loaded = true
            state.items = []
            state.error = nil
            return
        } catch is CancellationError {
            return
        } catch {
            state.error = Store.describe(error)
            return
        }
        var seen = Set<String>()
        items = items.filter { seen.insert($0.id).inserted }
        state.unsupported = false
        state.error = nil
        state.loaded = true
        await set(ArtifactCatalog.sorted(items))
    }

    private func receive(_ event: JSONValue) async {
        switch ArtifactCatalog.apply(event, to: state.items) {
        case .none: return
        case .changed(let items): await set(items)
        case .read(let id):
            guard let json = try? await fetchOne(id), let artifact = ArtifactSummary(json: json) else { return }
            await set(ArtifactCatalog.sorted(state.items.filter { $0.id != id } + [artifact]))
        }
    }

    /// Shows `items` and writes them down, one write after another.
    private func set(_ items: [ArtifactSummary]) async {
        guard items != state.items else { return }
        state.items = items
        publish()
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(items)) else { return }
        try? await keep(value)
    }
}
