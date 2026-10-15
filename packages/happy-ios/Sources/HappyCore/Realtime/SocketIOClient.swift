import Foundation
import HappyWire

public enum RealtimeStatus: Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case error
}

public enum RealtimeEvent: Equatable, Sendable {
    case status(RealtimeStatus)
    /// The namespace handshake completed. Socket.IO connection-state
    /// recovery is off on the server, so every connect is a fresh session
    /// and anything sent while disconnected was missed: run a delta sync.
    case connected
    case event(name: String, payload: JSONValue?)
}

public enum SocketIOError: Error, Equatable, Sendable {
    case notConnected
    case protocolViolation(String)
    case connectRejected(String?)
    case ackTimeout
    case closed
}

/// A minimal Socket.IO client for the default namespace over WebSocket:
/// handshake with an auth payload, heartbeat replies, events in, events and
/// acknowledged calls out, and reconnects with backoff
/// (1 s to 5 s, as happy-app's socket.io-client is configured).
public actor SocketIOClient {
    public nonisolated let events: AsyncStream<RealtimeEvent>
    public private(set) var status: RealtimeStatus = .disconnected

    private let url: URL
    private let connector: WebSocketConnector
    private let auth: @Sendable () async -> JSONValue
    private let backoff: Backoff
    private let sleep: InvalidateSync.Sleep
    private let continuation: AsyncStream<RealtimeEvent>.Continuation

    private var wantsConnection = false
    private var loop: Task<Void, Never>?
    private var connection: WebSocketConnection?
    private var lastPacketAt = ContinuousClock.now
    private var nextAckId = 0
    private var pendingAcks: [Int: CheckedContinuation<[JSONValue], Error>] = [:]

    public init(
        url: URL,
        connector: WebSocketConnector = URLSessionWebSocketConnector(),
        backoff: Backoff = Backoff(initial: .seconds(1), maximum: .seconds(5)),
        sleep: @escaping InvalidateSync.Sleep = InvalidateSync.taskSleep,
        auth: @escaping @Sendable () async -> JSONValue
    ) {
        self.url = url
        self.connector = connector
        self.backoff = backoff
        self.sleep = sleep
        self.auth = auth
        (events, continuation) = AsyncStream.makeStream(of: RealtimeEvent.self, bufferingPolicy: .bufferingNewest(1_000))
    }

    deinit {
        continuation.finish()
    }

    // MARK: Control

    public func connect() {
        wantsConnection = true
        guard loop == nil else { return }
        loop = Task { await self.runLoop() }
    }

    public func disconnect() async {
        wantsConnection = false
        loop?.cancel()
        loop = nil
        if let connection {
            try? await connection.send(EngineIOPacket.message(SocketIOPacket.disconnect.text).text)
            await connection.close()
        }
        connection = nil
        failPendingAcks(SocketIOError.closed)
        setStatus(.disconnected)
    }

    /// Drops the current socket and connects again, e.g. after a token change.
    public func reconnect() async {
        await disconnect()
        connect()
    }

    // MARK: Sending

    public func emit(_ name: String, _ payload: JSONValue) async throws {
        guard status == .connected, let connection else { throw SocketIOError.notConnected }
        try await connection.send(EngineIOPacket.message(SocketIOPacket.event(name: name, arguments: [payload], ackId: nil).text).text)
    }

    /// Emits and waits for the server's acknowledgement. Fails instead of
    /// waiting forever if the socket drops or the server never answers.
    public func emitWithAck(_ name: String, _ payload: JSONValue, timeout: Duration = .seconds(50)) async throws -> [JSONValue] {
        guard status == .connected, let connection else { throw SocketIOError.notConnected }
        let id = nextAckId
        nextAckId += 1
        let text = EngineIOPacket.message(SocketIOPacket.event(name: name, arguments: [payload], ackId: id).text).text
        let sleep = self.sleep
        return try await withCheckedThrowingContinuation { continuation in
            pendingAcks[id] = continuation
            Task {
                do {
                    try await connection.send(text)
                } catch {
                    self.failAck(id, error)
                }
            }
            Task {
                try? await sleep(timeout)
                self.failAck(id, SocketIOError.ackTimeout)
            }
        }
    }

    // MARK: Connection loop

    private func runLoop() async {
        var attempt = 0
        while wantsConnection && !Task.isCancelled {
            setStatus(.connecting)
            var failed = false
            do {
                try await runConnection { attempt = 0 }
            } catch {
                failed = true
            }
            connection = nil
            failPendingAcks(SocketIOError.closed)
            guard wantsConnection && !Task.isCancelled else { break }
            setStatus(failed ? .error : .disconnected)
            attempt += 1
            try? await sleep(backoff.delay(attempt: attempt))
        }
    }

    private func runConnection(onConnected: () -> Void) async throws {
        let connection = try await connector.connect(to: url)
        self.connection = connection
        defer { Task { await connection.close() } }

        guard case .open(let handshake)? = EngineIOPacket(text: try await connection.receive()) else {
            throw SocketIOError.protocolViolation("expected Engine.IO open")
        }
        lastPacketAt = .now
        let watchdog = startWatchdog(handshake: handshake, connection: connection)
        defer { watchdog.cancel() }

        try await connection.send(EngineIOPacket.message(SocketIOPacket.connect(await auth()).text).text)

        while !Task.isCancelled {
            let text = try await connection.receive()
            lastPacketAt = .now
            guard let packet = EngineIOPacket(text: text) else { continue }
            switch packet {
            case .ping:
                try await connection.send(EngineIOPacket.pong.text)
            case .close:
                throw SocketIOError.closed
            case .message(let payload):
                guard let message = SocketIOPacket(text: payload) else { continue }
                switch message {
                case .connect:
                    setStatus(.connected)
                    onConnected()
                    continuation.yield(.connected)
                case .connectError(let reason):
                    throw SocketIOError.connectRejected(reason?["message"]?.stringValue)
                case .disconnect:
                    throw SocketIOError.closed
                case .event(let name, let arguments, _):
                    continuation.yield(.event(name: name, payload: arguments.first))
                case .ack(let id, let arguments):
                    pendingAcks.removeValue(forKey: id)?.resume(returning: arguments)
                }
            case .open, .pong, .noop:
                break
            }
        }
    }

    /// The server pings every `pingInterval`; if nothing arrives for
    /// interval + timeout the link is dead even if TCP has not noticed.
    private func startWatchdog(handshake: EngineIOHandshake, connection: WebSocketConnection) -> Task<Void, Never> {
        let limit = Duration.milliseconds(handshake.pingInterval + handshake.pingTimeout)
        return Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                if ContinuousClock.now - self.lastPacketAt > limit {
                    await connection.close()
                    return
                }
            }
        }
    }

    // MARK: Helpers

    private func setStatus(_ newStatus: RealtimeStatus) {
        guard status != newStatus else { return }
        status = newStatus
        continuation.yield(.status(newStatus))
    }

    private func failAck(_ id: Int, _ error: Error) {
        pendingAcks.removeValue(forKey: id)?.resume(throwing: error)
    }

    private func failPendingAcks(_ error: Error) {
        let pending = pendingAcks
        pendingAcks = [:]
        for continuation in pending.values {
            continuation.resume(throwing: error)
        }
    }
}
