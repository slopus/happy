import Foundation
import HappyWire

/// One pipeline, live, for its page and its versions' and nodes' pages
/// (desktop's `pipelineStore`): the pipeline with its head version whole
/// and its history, read when a page starts following it and again on
/// every `pipeline.updated` that names it; its runs' newest page, read
/// again on every `pipeline.run.updated` that names it, older pages kept
/// as they were read. An older version's definition is read once, when a
/// page asks for it; versions never change. An archived pipeline is gone
/// (`404`) but its runs still read. Off the main thread.
public actor PipelineFeed {
    public enum Definition: Equatable, Sendable {
        case loading
        case loaded(PipelineDefinition)
        /// It couldn't be read, or isn't in a form this app reads.
        case failed
    }

    public struct State: Equatable, Sendable {
        /// Until the first answer.
        public var loading = true
        /// The server has no such pipeline: archived, or never there.
        public var missing = false
        public var pipeline: PipelineDetail?
        /// Its name: the pipeline's once read, else the one it was opened
        /// with or its runs carry, for an archived pipeline that can't be read.
        public var name: String?
        /// Its runs say it is archived.
        public var archived = false
        /// Newest first, without definitions; empty until read.
        public var versions: [PipelineVersion] = []
        /// Each version's definition as far as it has been read, the head's with the pipeline.
        public var definitions: [Int: Definition] = [:]
        public var runs = PipelinesFeed.Runs()
        /// Pipelines' names by ID, for the pipelines its nodes run.
        public var names: [String: String] = [:]
        /// The last read failed; what shows is the last one read.
        public var failed = false

        public init() {}
    }

    public struct Source: Sendable {
        public var pipeline: @Sendable (_ id: String) async throws -> PipelineDetail?
        public var versions: @Sendable (_ id: String) async throws -> [PipelineVersion]
        public var version: @Sendable (_ id: String, _ number: Int) async throws -> PipelineVersion?
        public var runs: @Sendable (_ id: String, _ name: String, _ cursor: String?) async throws -> PipelineRunPage
        public var names: @Sendable () async throws -> [String: String]
        public var events: @Sendable (_ types: [String]) async -> AsyncStream<Store.ConversationEvent>

        public init(pipeline: @escaping @Sendable (_ id: String) async throws -> PipelineDetail?,
                    versions: @escaping @Sendable (_ id: String) async throws -> [PipelineVersion],
                    version: @escaping @Sendable (_ id: String, _ number: Int) async throws -> PipelineVersion?,
                    runs: @escaping @Sendable (_ id: String, _ name: String, _ cursor: String?) async throws -> PipelineRunPage,
                    names: @escaping @Sendable () async throws -> [String: String],
                    events: @escaping @Sendable (_ types: [String]) async -> AsyncStream<Store.ConversationEvent>) {
            self.pipeline = pipeline
            self.versions = versions
            self.version = version
            self.runs = runs
            self.names = names
            self.events = events
        }
    }

    static let events = ["pipeline.updated", "pipeline.run.updated"]

    public nonisolated let pipelineId: String
    private let source: Source
    private var state = State()
    private var listeners: [UUID: AsyncStream<State>.Continuation] = [:]
    private var following: Task<Void, Never>?
    /// The pages following it: it follows while any does.
    private var followers = 0
    private var pipelineRead = Coalesced()
    private var runsRead = Coalesced()
    private var pagedPastFirst = false
    private var namesRead = false

    /// One read at a time; asked again meanwhile, it reads once more after.
    private struct Coalesced {
        var reading = false
        var again = false
    }

    public init(pipelineId: String, name: String? = nil, source: Source) {
        self.pipelineId = pipelineId
        self.source = source
        state.name = name
    }

    /// The account's own: its client, and its stream's events.
    public init(pipelineId: String, name: String? = nil, engine: SyncEngine) {
        let client = engine.client
        let store = engine.spaces
        self.init(pipelineId: pipelineId, name: name, source: Source(
            pipeline: { try await client.pipeline($0) },
            versions: { try await client.pipelineVersions($0) },
            version: { try await client.pipelineVersion($0, number: $1) },
            runs: { try await client.pipelineRuns(of: $0, name: $1, cursor: $2) },
            names: { Dictionary(try await client.pipelines().map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first }) },
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

    /// A page starts following the pipeline: the first reads it and listens.
    public func start() async {
        followers += 1
        guard following == nil else { return }
        let events = await source.events(Self.events)
        let pipelineId = pipelineId
        following = Task { [weak self] in
            for await event in events {
                guard !Task.isCancelled else { return }
                switch event {
                case .event(let envelope):
                    guard envelope["payload"]?["pipelineId"]?.stringValue == pipelineId else { continue }
                    if envelope["type"]?.stringValue == "pipeline.run.updated" { await self?.loadRuns() } else { await self?.loadPipeline() }
                case .resync:
                    await self?.loadPipeline()
                    await self?.loadRuns()
                }
            }
        }
        loadPipeline()
        loadRuns()
        if !namesRead { readNames() }
    }

    /// A page stops following; the last one stops the listening.
    public func stop() {
        followers = max(0, followers - 1)
        guard followers == 0 else { return }
        following?.cancel()
        following = nil
    }

    public func finish() {
        followers = 0
        following?.cancel()
        following = nil
        for listener in listeners.values { listener.finish() }
        listeners = [:]
    }

    private var active: Bool { following != nil }

    func loadPipeline() {
        guard active else { return }
        guard !pipelineRead.reading else { pipelineRead.again = true; return }
        pipelineRead = Coalesced(reading: true)
        let (read, history, id) = (source.pipeline, source.versions, pipelineId)
        Task {
            let detail = await Self.attempt { try await read(id) }
            // The history is read beside it; a pipeline that is gone has none to read.
            var versions: Result<[PipelineVersion], Error>?
            if case .success(.some) = detail { versions = await Self.attempt { try await history(id) } }
            self.landPipeline(detail, versions: versions)
        }
    }

    private func landPipeline(_ detail: Result<PipelineDetail?, Error>, versions: Result<[PipelineVersion], Error>?) {
        // Uninstalled for the account: the screen leaves, with nothing said.
        var refused = false
        if case .failure(let error) = detail { refused = AccountFeatures.refused(error) }
        if case .failure(let error)? = versions { refused = refused || AccountFeatures.refused(error) }
        if refused { pipelineRead = Coalesced(); return }
        switch detail {
        case .success(let pipeline?):
            state.pipeline = pipeline
            state.name = pipeline.name
            state.missing = false
            state.failed = false
            if let definition = pipeline.head.definition { state.definitions[pipeline.head.number] = .loaded(definition) }
            else if state.definitions[pipeline.head.number] == nil { state.definitions[pipeline.head.number] = .failed }
        case .success(nil):
            state.failed = true
        case .failure(AgentClientError.status(404, _, _)):
            state.missing = true
            state.pipeline = nil
            state.failed = false
        case .failure:
            state.failed = true
        }
        switch versions {
        case .success(let versions)?: state.versions = versions
        case .failure?: state.failed = true
        case nil: break
        }
        state.loading = false
        publish()
        let again = pipelineRead.again
        pipelineRead = Coalesced()
        if again { loadPipeline() }
    }

    func loadRuns() {
        guard active else { return }
        guard !runsRead.reading else { runsRead.again = true; return }
        runsRead = Coalesced(reading: true)
        let (read, id, name) = (source.runs, pipelineId, state.name ?? pipelineId)
        Task {
            let result = await Self.attempt { try await read(id, name, nil) }
            self.landRuns(result)
        }
    }

    private func landRuns(_ result: Result<PipelineRunPage, Error>) {
        if case .failure(let error) = result, AccountFeatures.refused(error) { runsRead = Coalesced(); return }
        switch result {
        case .success(let page):
            state.runs.entries = PipelineRunPage.merge(state.runs.entries, page: page.runs, complete: !pagedPastFirst)
            heard(page.runs)
            if !pagedPastFirst { state.runs.nextCursor = page.nextCursor }
            state.runs.failed = false
        case .failure:
            state.runs.failed = true
        }
        state.runs.loading = false
        publish()
        let again = runsRead.again
        runsRead = Coalesced()
        if again { loadRuns() }
    }

    /// What its runs say of it, where the pipeline itself can't be read.
    private func heard(_ runs: [PipelineRunListEntry]) {
        if runs.contains(where: \.pipelineArchived) { state.archived = true }
        if state.name == nil, let named = runs.first(where: { $0.pipelineName != pipelineId }) { state.name = named.pipelineName }
    }

    /// Reads the next older page of its runs.
    public func more() {
        guard !state.runs.loadingMore, let cursor = state.runs.nextCursor else { return }
        state.runs.loadingMore = true
        publish()
        let (read, id, name) = (source.runs, pipelineId, state.name ?? pipelineId)
        Task {
            let result = await Self.attempt { try await read(id, name, cursor) }
            self.landMore(result)
        }
    }

    private func landMore(_ result: Result<PipelineRunPage, Error>) {
        state.runs.loadingMore = false
        if case .failure(let error) = result, AccountFeatures.refused(error) { return }
        switch result {
        case .success(let page):
            let known = Set(state.runs.entries.map(\.id))
            pagedPastFirst = true
            state.runs.entries += page.runs.filter { !known.contains($0.id) }
            heard(page.runs)
            state.runs.nextCursor = page.nextCursor
            state.runs.failed = false
        case .failure:
            state.runs.failed = true
        }
        publish()
    }

    /// Reads one version's definition, once; a failed read is tried again when asked again.
    public func version(_ number: Int) {
        switch state.definitions[number] {
        case .loaded?, .loading?: return
        case .failed?, nil: break
        }
        state.definitions[number] = .loading
        publish()
        let (read, id) = (source.version, pipelineId)
        Task {
            let result = await Self.attempt { try await read(id, number) }
            if case .success(let version?) = result, let definition = version.definition {
                self.landVersion(number, .loaded(definition))
            } else if case .failure(let error) = result, AccountFeatures.refused(error) {
                self.landVersion(number, nil)
            } else {
                self.landVersion(number, .failed)
            }
        }
    }

    private func landVersion(_ number: Int, _ definition: Definition?) {
        state.definitions[number] = definition
        publish()
    }

    private func readNames() {
        namesRead = true
        let names = source.names
        Task {
            guard let read = try? await names() else { namesRead = false; return }
            state.names.merge(read) { _, new in new }
            publish()
        }
    }

    private static func attempt<T: Sendable>(_ body: @Sendable () async throws -> T) async -> Result<T, Error> {
        do { return .success(try await body()) } catch { return .failure(error) }
    }
}
