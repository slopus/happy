import Foundation

/// One page capability owns this pool. A lease is exclusive, never pipelined,
/// and returned only after a complete, self-delimited upstream response.
actor BrowserConnectionPool {
    struct Lease: Sendable { let id: UUID; let stream: any BrowserStream }
    private struct Idle { let stream: any BrowserStream; let since: ContinuousClock.Instant }
    private let transport: any AgentTransport
    private var idle: [Idle] = []
    private var leased: [UUID: any BrowserStream] = [:]
    private var stopped = false
    private let clock = ContinuousClock()

    init(transport: any AgentTransport) { self.transport = transport }

    func take(reusing: Bool = true) async throws -> Lease {
        guard !stopped else { throw CancellationError() }
        var stream: (any BrowserStream)?
        while reusing, let candidate = idle.popLast() {
            if clock.now - candidate.since < .seconds(5) { stream = candidate.stream; break }
            await candidate.stream.close()
        }
        if stream == nil { stream = try await transport.browserConnection() }
        let connection = stream!
        guard !stopped, !Task.isCancelled else { await connection.close(); throw CancellationError() }
        let lease = Lease(id: UUID(), stream: connection)
        leased[lease.id] = connection
        return lease
    }

    func release(_ lease: Lease, reusable: Bool) async {
        guard leased.removeValue(forKey: lease.id) != nil else { return }
        if reusable, !stopped, !Task.isCancelled, idle.count < 6 {
            idle.append(Idle(stream: lease.stream, since: clock.now))
        } else { await lease.stream.close() }
    }

    func stop() async {
        stopped = true
        let streams = idle.map(\.stream) + Array(leased.values)
        idle.removeAll(); leased.removeAll()
        for stream in streams { await stream.close() }
    }
}