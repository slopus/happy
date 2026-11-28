import Foundation
import HappyWire

/// One run, live, for its page and its nodes' pages (desktop's
/// `pipelineRunStore`): read when a page starts following it, then again on
/// every `pipeline.run.updated` and `pipeline.node.updated` that names it or
/// a run beside it, and after a gap, so node states, status lines and
/// progress move as the server records them. The graph of the version it
/// pinned is read once; its parent and children are read beside it on the
/// same hints until each ends. Abort shows aborted only once the server's
/// own record says so. Off the main thread.
public actor PipelineRunFeed {
    public enum Abort: Equatable, Sendable {
        case idle
        case sending
        /// Refused, or the server couldn't be reached; the message to show.
        case failed(String?)
    }

    public enum Graph: Equatable, Sendable {
        case loading
        case loaded(PipelineGraph)
        /// The version couldn't be read, or isn't in a form this app reads.
        case failed
    }

    public struct State: Equatable, Sendable {
        /// Until the first answer.
        public var loading = true
        /// The server has no such run (`404`).
        public var missing = false
        public var run: PipelineRun?
        /// Nil until the run is read.
        public var graph: Graph?
        /// Its parent and children by ID, as far as they have been read.
        public var relatives: [String: PipelineRunRelative] = [:]
        /// Pipelines' names by ID, for the run's own and those its relatives and nodes run.
        public var names: [String: String] = [:]
        public var abort = Abort.idle
        /// The last read failed; what shows is the last one read.
        public var failed = false

        public init() {}

        /// The run's nodes in its graph's order, those the graph doesn't
        /// name after them; by ID until the graph is read. A node of the
        /// graph the run hasn't reached shows waiting while the run is
        /// live, and skipped once it ended without it.
        public var orderedNodes: [PipelineNodeRun] {
            guard let run else { return [] }
            guard case .loaded(let graph) = graph else { return run.nodes.sorted { $0.nodeId < $1.nodeId } }
            var runs = Dictionary(run.nodes.map { ($0.nodeId, $0) }, uniquingKeysWith: { first, _ in first })
            let order = graph.order
            var nodes = order.map { id in
                runs.removeValue(forKey: id) ?? PipelineNodeRun(nodeId: id, kind: graph.nodes[id]?.kind ?? "code",
                                                               state: run.state.abortable ? .pending : .skipped, statuses: [])
            }
            nodes += runs.values.sorted { $0.nodeId < $1.nodeId }
            return nodes
        }

        public var graphNodes: [String: PipelineGraph.Node] {
            if case .loaded(let graph) = graph { return graph.nodes }
            return [:]
        }
    }

    public struct Source: Sendable {
        public var run: @Sendable (_ runId: String) async throws -> PipelineRun?
        public var graph: @Sendable (_ pipelineId: String, _ version: Int) async throws -> PipelineGraph?
        public var names: @Sendable () async throws -> [String: String]
        public var abort: @Sendable (_ runId: String) async throws -> PipelineRun?
        public var events: @Sendable (_ types: [String]) async -> AsyncStream<Store.ConversationEvent>

        public init(run: @escaping @Sendable (_ runId: String) async throws -> PipelineRun?,
                    graph: @escaping @Sendable (_ pipelineId: String, _ version: Int) async throws -> PipelineGraph?,
                    names: @escaping @Sendable () async throws -> [String: String],
                    abort: @escaping @Sendable (_ runId: String) async throws -> PipelineRun?,
                    events: @escaping @Sendable (_ types: [String]) async -> AsyncStream<Store.ConversationEvent>) {
            self.run = run
            self.graph = graph
            self.names = names
            self.abort = abort
            self.events = events
        }
    }

    static let events = ["pipeline.run.updated", "pipeline.node.updated"]

    public nonisolated let runId: String
    private let source: Source
    private var state = State()
    private var listeners: [UUID: AsyncStream<State>.Continuation] = [:]
    private var following: Task<Void, Never>?
    /// The pages following it: it follows while any does.
    private var followers = 0
    private var reading = false
    private var readAgain = false
    /// Versions never change, so each one's graph is read once.
    private var graphs: [String: PipelineGraph] = [:]
    private var namesRead = false

    public init(runId: String, source: Source) {
        self.runId = runId
        self.source = source
    }

    /// The account's own: its client, and its stream's events.
    public init(runId: String, engine: SyncEngine) {
        let client = engine.client
        let store = engine.spaces
        self.init(runId: runId, source: Source(
            run: { try await client.pipelineRun($0) },
            graph: { try await client.pipelineGraph($0, version: $1) },
            names: { Dictionary(try await client.pipelines().map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first }) },
            abort: { try await client.abortPipelineRun($0) },
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

    /// A page starts following the run: the first reads it and listens.
    public func start() async {
        followers += 1
        guard following == nil else { return }
        let events = await source.events(Self.events)
        following = Task { [weak self] in
            for await event in events {
                guard !Task.isCancelled else { return }
                switch event {
                case .event(let envelope):
                    guard let runId = envelope["payload"]?["runId"]?.stringValue, await self?.concerns(runId) == true else { continue }
                    await self?.load()
                case .resync:
                    await self?.load()
                }
            }
        }
        load()
        if !namesRead { readNames() }
    }

    /// A page stops following; the last one stops the listening.
    public func stop() {
        followers = max(0, followers - 1)
        guard followers == 0 else { return }
        following?.cancel()
        following = nil
    }

    private func concerns(_ id: String) -> Bool { id == runId || state.run?.relativeIds.contains(id) == true }

    /// Reads now, or once more after the read in flight.
    public func load() {
        guard following != nil else { return }
        guard !reading else { readAgain = true; return }
        reading = true
        readAgain = false
        Task { await read() }
    }

    private func read() async {
        do {
            if let run = try await source.run(runId) {
                adopt(run)
                await readGraph(run)
                await readRelatives(run)
            } else {
                state.failed = true
                state.loading = false
                publish()
            }
        } catch AgentClientError.status(404, _, _) {
            state.missing = true
            state.run = nil
            state.loading = false
            publish()
        } catch where AccountFeatures.refused(error) {
            // Uninstalled for the account: the screen leaves, with nothing said.
        } catch {
            state.failed = true
            state.loading = false
            publish()
        }
        reading = false
        if readAgain { load() }
    }

    private func adopt(_ run: PipelineRun) {
        state.run = run
        state.loading = false
        state.missing = false
        state.failed = false
        publish()
    }

    private func graph(_ pipelineId: String, _ version: Int) async throws -> PipelineGraph? {
        let key = "\(pipelineId)/\(version)"
        if let known = graphs[key] { return known }
        let read = try await source.graph(pipelineId, version)
        if let read { graphs[key] = read }
        return read
    }

    private func readGraph(_ run: PipelineRun) async {
        switch state.graph {
        case .loaded?, .loading?: return
        case .failed?, nil: break
        }
        state.graph = .loading
        publish()
        let read: PipelineGraph?
        do { read = try await graph(run.pipelineId, run.version) } catch where AccountFeatures.refused(error) {
            state.graph = nil
            publish()
            return
        } catch { read = nil }
        state.graph = read.map(Graph.loaded) ?? .failed
        publish()
    }

    private func readRelatives(_ run: PipelineRun) async {
        var relatives: [String: PipelineRunRelative] = [:]
        for id in run.relativeIds {
            let kept = state.relatives[id]
            // An ended run never changes again.
            if let kept, !kept.state.abortable, kept.nodesTotal != nil { relatives[id] = kept; continue }
            guard let read = try? await source.run(id) else {
                // Beside the run, not the run: one that can't be read now keeps what was shown.
                if let kept { relatives[id] = kept }
                continue
            }
            let total = (try? await graph(read.pipelineId, read.version))?.nodes.count
            relatives[id] = PipelineRunRelative(read, nodesTotal: total)
        }
        guard relatives != state.relatives else { return }
        state.relatives = relatives
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

    /// Asks the server to abort the run while it is queued or running. The
    /// run shows aborted only once the server's answer, or a read after it,
    /// says so.
    public func abort() {
        guard let run = state.run, run.state.abortable, state.abort != .sending else { return }
        state.abort = .sending
        publish()
        let (abort, runId) = (source.abort, runId)
        Task {
            do {
                let answered = try await abort(runId)
                state.abort = .idle
                if let answered { adopt(answered) } else { publish() }
                load()
            } catch where AccountFeatures.refused(error) {
                state.abort = .idle
                publish()
            } catch AgentClientError.status(_, _, let message) {
                state.abort = .failed(message)
                publish()
            } catch {
                state.abort = .failed(nil)
                publish()
            }
        }
    }

    public func finish() {
        followers = 0
        following?.cancel()
        following = nil
        for listener in listeners.values { listener.finish() }
        listeners = [:]
    }
}
