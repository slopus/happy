import Foundation
import HappyWire

/// A System Monitor Surface read while its screen is on: one snapshot
/// every `intervalMs` (a second), each read given ten seconds, five
/// seconds between tries while the computer can't be reached, as the
/// desktop polls. Off the main thread; paused whenever the screen is
/// hidden, so nothing is asked of the computer for a screen no one sees.
/// The last snapshot is kept on the phone, so the screen opens on it.
public actor SystemMonitorFeed {
    public enum Status: String, Equatable, Sendable {
        /// Waiting for the first snapshot.
        case loading
        case ready
        /// Showing the last snapshot while the computer can't be reached.
        case reconnecting
        /// The Surface is gone, or isn't a System Monitor (`404`, `410`).
        case missing
        /// The Happy Agent has no System Monitor (`405`, `501`).
        case unsupported
    }

    public struct State: Equatable, Sendable {
        public var sample: SystemMonitorSample?
        public var status = Status.loading
        /// Why the last read failed, while it does.
        public var failed = false
        public var processes = ProcessTable()

        public init() {}
    }

    public typealias Fetch = @Sendable () async throws -> SystemMonitorSample
    public typealias Sleep = @Sendable (Duration) async throws -> Void

    static let timeout: Duration = .seconds(10)
    static let retry: Duration = .seconds(5)
    /// How often the snapshot is written down while it is read.
    static let keepEvery: Double = 30

    private let fetch: Fetch
    private let sleep: Sleep
    private let keep: @Sendable (JSONValue) async -> Void
    private let kept: @Sendable () async -> JSONValue?
    private var state = State()
    private var listeners: [UUID: AsyncStream<State>.Continuation] = [:]
    private var polling: Task<Void, Never>?
    private var restored = false
    private var keptAt: Double = -.infinity
    /// Poked: the wait before the next read ends early.
    private var wake: CheckedContinuation<Void, Never>?

    public init(fetch: @escaping Fetch, sleep: @escaping Sleep = { try await Task.sleep(for: $0) }, keep: @escaping @Sendable (JSONValue) async -> Void = { _ in }, kept: @escaping @Sendable () async -> JSONValue? = { nil }) {
        self.fetch = fetch
        self.sleep = sleep
        self.keep = keep
        self.kept = kept
    }

    /// The account's own: its client, and its database for the last snapshot.
    public init(engine: SyncEngine, surfaceId: String) {
        let client = engine.client
        let key = "system-monitor:\(surfaceId)"
        self.init(
            fetch: { try await client.systemMonitor(surfaceId) },
            keep: { try? await engine.keepResource(key, value: $0) },
            kept: { try? await engine.cachedResource(key) }
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

    /// Reads until `pause`; a Surface found missing or unsupported stops it.
    public func resume() async {
        guard polling == nil else { return }
        if !restored {
            restored = true
            if state.sample == nil, let value = await kept(), let sample = try? JSONDecoder().decode(SystemMonitorSample.self, from: JSONEncoder().encode(value)) {
                state.sample = sample
                state.status = .reconnecting
                state.processes.record(sample)
                publish()
            }
        }
        guard state.status != .missing, state.status != .unsupported else { return }
        polling = Task { [weak self] in await self?.poll() }
    }

    /// Stops reading, and writes the last snapshot down.
    public func pause() async {
        polling?.cancel()
        polling = nil
        wake?.resume()
        wake = nil
        await write(force: true)
    }

    /// Reads now rather than at the next tick: the link just came back.
    public func poke() {
        wake?.resume()
        wake = nil
    }

    public func stop() async {
        await pause()
        for listener in listeners.values { listener.finish() }
        listeners = [:]
    }

    private func poll() async {
        while !Task.isCancelled {
            let wait: Duration
            do {
                let sample = try await withTimeout(Self.timeout) { [fetch] in try await fetch() }
                try Task.checkCancellation()
                state.sample = sample
                state.status = .ready
                state.failed = false
                state.processes.record(sample)
                publish()
                await write(force: false)
                wait = .milliseconds(Int(max(1000, sample.intervalMs)))
            } catch is CancellationError {
                return
            } catch AgentClientError.status(let code, _, _) where code == 404 || code == 410 {
                state.status = .missing
                state.failed = false
                publish()
                return
            } catch AgentClientError.status(let code, _, _) where code == 405 || code == 501 {
                state.status = .unsupported
                state.failed = false
                publish()
                return
            } catch {
                if Task.isCancelled { return }
                state.status = state.sample == nil ? .loading : .reconnecting
                state.failed = true
                publish()
                wait = Self.retry
            }
            await pause(for: wait)
        }
    }

    /// Sleeps `duration`, or until poked or cancelled.
    private func pause(for duration: Duration) async {
        let sleep = sleep
        await withTaskGroup(of: Void.self) { group in
            group.addTask { try? await sleep(duration) }
            group.addTask { [weak self] in await self?.waitForPoke() }
            await group.next()
            group.cancelAll()
            await self.poke()
        }
    }

    private func waitForPoke() async {
        guard !Task.isCancelled else { return }
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                if Task.isCancelled { continuation.resume() } else { wake?.resume(); wake = continuation }
            }
        } onCancel: { Task { await self.poke() } }
    }

    private func write(force: Bool) async {
        guard let sample = state.sample else { return }
        let now = sample.sampledAt / 1000
        guard force || now - keptAt >= Self.keepEvery else { return }
        keptAt = now
        // The history is the computer's to send again; the screen opens
        // on the readings alone.
        var kept = sample
        kept.history = Array(kept.history.suffix(60))
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(kept)) else { return }
        await keep(value)
    }
}

/// `operation`, or a `URLError(.timedOut)` once `limit` has passed.
func withTimeout<T: Sendable>(_ limit: Duration, _ operation: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(for: limit)
            throw URLError(.timedOut)
        }
        defer { group.cancelAll() }
        guard let first = try await group.next() else { throw CancellationError() }
        return first
    }
}
