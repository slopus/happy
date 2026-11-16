import Foundation
import HappyWire

/// The team's pipelines on a Happy Cloud server and every run of them, for
/// the Pipelines list, read while its screen is on (desktop's
/// `pipelinesStore`). The pipelines are read when it starts, then again on
/// every `pipeline.updated` and `pipeline.run.updated`, which is how a new
/// version or a run's new state reaches a row; the runs' newest page is
/// read again on every `pipeline.run.updated`, so older pages already read
/// stay as they were. A resync (a gap in the stream) reads both. Events
/// that arrive during a read fold into one more read after it. A failed
/// read keeps what was read. Off the main thread.
public actor PipelinesFeed {
    public struct Runs: Equatable, Sendable {
        /// Until the first page answers.
        public var loading = true
        /// False on a server that doesn't list runs across pipelines (`404`).
        public var listed = true
        public var entries: [PipelineRunListEntry] = []
        /// Where the next older page starts; nil once every run is in.
        public var nextCursor: String?
        public var loadingMore = false
        /// The last read of them failed; what shows is the last one read.
        public var failed = false

        public init() {}
    }

    public struct State: Equatable, Sendable {
        /// Until the first answer, so "no pipelines" is never said early.
        public var loading = true
        /// By name.
        public var pipelines: [PipelineSummary] = []
        public var failed = false
        public var runs = Runs()

        public init() {}
    }

    public struct Source: Sendable {
        public var pipelines: @Sendable () async throws -> [PipelineSummary]
        public var runs: @Sendable (_ cursor: String?) async throws -> PipelineRunPage
        public var events: @Sendable (_ types: [String]) async -> AsyncStream<Store.ConversationEvent>

        public init(pipelines: @escaping @Sendable () async throws -> [PipelineSummary],
                    runs: @escaping @Sendable (_ cursor: String?) async throws -> PipelineRunPage,
                    events: @escaping @Sendable (_ types: [String]) async -> AsyncStream<Store.ConversationEvent>) {
            self.pipelines = pipelines
            self.runs = runs
            self.events = events
        }
    }

    static let events = ["pipeline.updated", "pipeline.run.updated"]

    private let source: Source
    private var state = State()
    private var listeners: [UUID: AsyncStream<State>.Continuation] = [:]
    private var following: Task<Void, Never>?
    private var pipelinesRead = Coalesced()
    private var runsRead = Coalesced()
    /// The reader paged past the first page: a fresh first page goes over
    /// what is kept instead of replacing it.
    private var pagedPastFirst = false

    /// One read at a time; asked again meanwhile, it reads once more after.
    private struct Coalesced {
        var reading = false
        var again = false
    }

    public init(source: Source) {
        self.source = source
    }

    /// The account's own: its client, and its stream's events.
    public init(engine: SyncEngine) {
        let client = engine.client
        let store = engine.spaces
        self.init(source: Source(
            pipelines: { try await client.pipelines() },
            runs: { try await client.pipelineRuns(cursor: $0) },
            events: { await store.events(matching: $0) }
        ))
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

    /// Follows the events and reads both lists; a server found not to list
    /// runs is asked again.
    public func start() async {
        guard following == nil else { return }
        if !state.runs.listed {
            state.runs.listed = true
            state.runs.loading = true
            publish()
        }
        let events = await source.events(Self.events)
        following = Task { [weak self] in
            for await event in events {
                guard !Task.isCancelled else { return }
                switch event {
                case .event(let envelope):
                    await self?.loadPipelines()
                    if envelope["type"]?.stringValue == "pipeline.run.updated" { await self?.loadRuns() }
                case .resync:
                    await self?.loadPipelines()
                    await self?.loadRuns()
                }
            }
        }
        loadPipelines()
        loadRuns()
    }

    /// Stops following; reads already sent land, no new one starts.
    public func stop() {
        following?.cancel()
        following = nil
    }

    public func finish() {
        stop()
        for listener in listeners.values { listener.finish() }
        listeners = [:]
    }

    private var active: Bool { following != nil }

    func loadPipelines() {
        guard active else { return }
        guard !pipelinesRead.reading else { pipelinesRead.again = true; return }
        pipelinesRead = Coalesced(reading: true)
        let read = source.pipelines
        Task {
            let result = await Self.attempt { try await read() }
            self.landPipelines(result)
        }
    }

    private func landPipelines(_ result: Result<[PipelineSummary], Error>) {
        switch result {
        case .success(let pipelines):
            state.pipelines = pipelines
            state.failed = false
        case .failure:
            state.failed = true
        }
        state.loading = false
        publish()
        let again = pipelinesRead.again
        pipelinesRead = Coalesced()
        if again { loadPipelines() }
    }

    func loadRuns() {
        guard active, state.runs.listed else { return }
        guard !runsRead.reading else { runsRead.again = true; return }
        runsRead = Coalesced(reading: true)
        let read = source.runs
        Task {
            let result = await Self.attempt { try await read(nil) }
            self.landRuns(result)
        }
    }

    private func landRuns(_ result: Result<PipelineRunPage, Error>) {
        switch result {
        case .success(let page):
            state.runs.entries = PipelineRunPage.merge(state.runs.entries, page: page.runs, complete: !pagedPastFirst)
            // Paged past the first page, the cursor already points past what is kept.
            if !pagedPastFirst { state.runs.nextCursor = page.nextCursor }
            state.runs.failed = false
        case .failure(AgentClientError.status(404, _, _)):
            // A server without the list says so once; asked again on the next start.
            state.runs.listed = false
            state.runs.entries = []
            state.runs.nextCursor = nil
        case .failure:
            state.runs.failed = true
        }
        state.runs.loading = false
        publish()
        let again = runsRead.again
        runsRead = Coalesced()
        if again { loadRuns() }
    }

    /// Reads the next older page of runs.
    public func more() {
        guard state.runs.listed, !state.runs.loadingMore, let cursor = state.runs.nextCursor else { return }
        state.runs.loadingMore = true
        publish()
        let read = source.runs
        Task {
            let result = await Self.attempt { try await read(cursor) }
            self.landMore(result)
        }
    }

    private func landMore(_ result: Result<PipelineRunPage, Error>) {
        state.runs.loadingMore = false
        switch result {
        case .success(let page):
            let known = Set(state.runs.entries.map(\.id))
            pagedPastFirst = true
            state.runs.entries += page.runs.filter { !known.contains($0.id) }
            state.runs.nextCursor = page.nextCursor
            state.runs.failed = false
        case .failure:
            state.runs.failed = true
        }
        publish()
    }

    private static func attempt<T: Sendable>(_ body: @Sendable () async throws -> T) async -> Result<T, Error> {
        do { return .success(try await body()) } catch { return .failure(error) }
    }
}
