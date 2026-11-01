import Foundation
import HappyWire

/// The computer's Surface catalog, kept on the phone: read from disk
/// first, then whole from the computer, and again after each
/// `surface.*` event (docs/offline-first.md). A Surface made here shows
/// at once.
public actor SurfaceCatalogFeed {
    public struct State: Equatable, Sendable {
        public var surfaces: [AgentWire.Surface] = []
        /// Something was read, from disk or the computer.
        public var loaded = false
        /// This computer keeps no Surfaces.
        public var unsupported = false

        public init() {}

        /// The Surfaces of `type`, by name.
        public func of(_ type: String) -> [AgentWire.Surface] {
            surfaces.filter { $0.type == type }.sorted {
                let order = $0.name.localizedStandardCompare($1.name)
                return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
            }
        }
    }

    public static let resource = "surface-catalog"

    public typealias Fetch = @Sendable () async throws -> [AgentWire.Surface]?
    public typealias Keep = @Sendable (JSONValue) async throws -> Void
    public typealias Kept = @Sendable () async throws -> JSONValue?

    private let fetch: Fetch
    private let keep: Keep
    private let kept: Kept
    private let events: @Sendable () async -> AsyncStream<Store.ConversationEvent>
    private var state = State()
    private var listeners: [UUID: AsyncStream<State>.Continuation] = [:]
    private var following: Task<Void, Never>?
    private var reading: Task<Void, Never>?
    private var again = false
    private var started = false

    public init(fetch: @escaping Fetch, keep: @escaping Keep, kept: @escaping Kept, events: @escaping @Sendable () async -> AsyncStream<Store.ConversationEvent>) {
        self.fetch = fetch
        self.keep = keep
        self.kept = kept
        self.events = events
    }

    public init(engine: SyncEngine) {
        let client = engine.client
        let store = engine.spaces
        self.init(
            fetch: { try await client.surfaces() },
            keep: { try await engine.keepResource(Self.resource, value: $0) },
            kept: { try await engine.cachedResource(Self.resource) },
            events: { await store.events(matching: ["surface."]) }
        )
    }

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

    public func start() async {
        guard !started else { return }
        started = true
        if let value = try? await kept(), let list = value.arrayValue,
           let surfaces = try? JSONDecoder().decode([AgentWire.Surface].self, from: JSONEncoder().encode(JSONValue.array(list))) {
            state.surfaces = surfaces
            state.loaded = true
            publish()
        }
        let events = events
        following = Task { [weak self] in
            let stream = await events()
            await self?.refresh()
            for await _ in stream {
                guard !Task.isCancelled else { return }
                await self?.refresh()
            }
        }
    }

    public func stop() {
        following?.cancel()
        following = nil
        reading?.cancel()
        for listener in listeners.values { listener.finish() }
        listeners = [:]
    }

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
        let surfaces: [AgentWire.Surface]?
        do { surfaces = try await fetch() } catch { return }
        await set(surfaces ?? [], unsupported: surfaces == nil)
    }

    /// Shows a Surface made here before the catalog is read again.
    public func add(_ surface: AgentWire.Surface) async {
        await set(state.surfaces.filter { $0.id != surface.id } + [surface], unsupported: false)
    }

    private func set(_ surfaces: [AgentWire.Surface], unsupported: Bool) async {
        let changed = surfaces != state.surfaces || !state.loaded || unsupported != state.unsupported
        state.surfaces = surfaces
        state.loaded = true
        state.unsupported = unsupported
        guard changed else { return }
        publish()
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(surfaces)) else { return }
        try? await keep(value)
    }
}
