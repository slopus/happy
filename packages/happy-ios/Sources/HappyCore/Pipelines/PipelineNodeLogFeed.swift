import Foundation
import HappyWire

/// One node's log in one run, live (desktop's `pipelineNodeLogStore`):
/// read when its page starts, then only what came after on every
/// `pipeline.node.log` that names it and after a gap. An entry rewritten in
/// place, such as a command that finished, replaces its earlier copy. Off
/// the main thread.
public actor PipelineNodeLogFeed {
    public struct State: Equatable, Sendable {
        /// Until the first answer.
        public var loading = true
        /// Every entry read so far, in `seq` order.
        public var entries: [PipelineLogEntry] = []
        /// How many of the oldest entries the server let go before they were read.
        public var dropped = 0
        /// Commands first read while still running: the reader watched them
        /// work, so they stay open after they end.
        public var watched: Set<Int> = []
        /// The last read failed; what shows is what was read before.
        public var failed = false

        public init() {}

        /// `page` over what is held: changed entries replace theirs, new
        /// ones join the end.
        public mutating func merge(_ page: PipelineLogPage) {
            dropped = page.dropped
            guard !page.entries.isEmpty || !page.changed.isEmpty else { return }
            var index = Dictionary(entries.enumerated().map { ($1.seq, $0) }, uniquingKeysWith: { first, _ in first })
            for entry in page.changed { if let position = index[entry.seq] { entries[position] = entry } }
            for entry in page.entries {
                if let position = index[entry.seq] { entries[position] = entry }
                else if entry.seq > (entries.last?.seq ?? 0) { index[entry.seq] = entries.count; entries.append(entry) }
                if case .command(let command) = entry.kind, command.state == "running" { watched.insert(entry.seq) }
            }
        }
    }

    public typealias Read = @Sendable (_ after: Int, _ limit: Int) async throws -> PipelineLogPage
    public typealias Events = @Sendable (_ types: [String]) async -> AsyncStream<Store.ConversationEvent>

    /// How many entries one request asks for, and how many pages one read
    /// takes back to back before letting the next hint have a turn.
    static let pageLimit = 500
    static let pagesPerRead = 10

    public nonisolated let runId: String
    public nonisolated let nodeId: String
    private let readPage: Read
    private let events: Events
    private var state = State()
    private var after = 0
    private var listeners: [UUID: AsyncStream<State>.Continuation] = [:]
    private var following: Task<Void, Never>?
    private var reading = false
    private var readAgain = false

    public init(runId: String, nodeId: String, read: @escaping Read, events: @escaping Events) {
        self.runId = runId
        self.nodeId = nodeId
        readPage = read
        self.events = events
    }

    public init(runId: String, nodeId: String, engine: SyncEngine) {
        let client = engine.client
        let store = engine.spaces
        self.init(runId: runId, nodeId: nodeId,
                  read: { try await client.pipelineNodeLog(runId: runId, nodeId: nodeId, after: $0, limit: $1) },
                  events: { await store.events(matching: $0) })
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
        guard following == nil else { return }
        let (stream, runId, nodeId) = (await events(["pipeline.node.log"]), runId, nodeId)
        following = Task { [weak self] in
            for await event in stream {
                guard !Task.isCancelled else { return }
                if case .event(let envelope) = event {
                    let payload = envelope["payload"]
                    guard payload?["runId"]?.stringValue == runId, payload?["nodeId"]?.stringValue == nodeId else { continue }
                }
                await self?.load()
            }
        }
        load()
    }

    public func stop() {
        following?.cancel()
        following = nil
    }

    public func finish() {
        stop()
        for listener in listeners.values { listener.finish() }
        listeners = [:]
    }

    public func load() {
        guard following != nil else { return }
        guard !reading else { readAgain = true; return }
        reading = true
        readAgain = false
        Task { await read() }
    }

    private func read() async {
        var more = false
        do {
            for _ in 0..<Self.pagesPerRead {
                let page = try await readPage(after, Self.pageLimit)
                after = page.nextAfter
                state.merge(page)
                state.loading = false
                state.failed = false
                publish()
                more = page.entries.count >= Self.pageLimit
                if !more { break }
            }
        } catch AgentClientError.status(404, _, _) {
            // A node that hasn't started has no log yet.
            state.loading = false
            publish()
        } catch where AccountFeatures.refused(error) {
            // Uninstalled for the account: the screen leaves, with nothing said.
        } catch {
            state.loading = false
            state.failed = true
            publish()
        }
        reading = false
        // A long backlog: the rest is read after other hints get a turn.
        if readAgain || more { load() }
    }
}
