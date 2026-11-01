import Foundation
import HappyWire
#if canImport(Network)
import Network
import Security

/// Raw HTTP/1.1 over verified TLS also carries SSE, upgrades and CONNECT.
/// It never follows redirects or installs a custom trust evaluator.
final class HTTPSBrowserStream: BrowserStream, @unchecked Sendable {
    let authority: String
    private let connection: NWConnection
    private let onClose: @Sendable () -> Void
    private let lock = NSLock()
    private var failure: (any Error)?
    private var ready = false
    private var readiness: [CheckedContinuation<Void, any Error>] = []
    private var pending: [UUID: @Sendable (any Error) -> Void] = [:]
    private var readinessDeadline: DispatchWorkItem?

    init(connection: NWConnection, authority: String, handshakeTimeout: TimeInterval = 35, onClose: @escaping @Sendable () -> Void) {
        self.connection = connection
        self.authority = authority; self.onClose = onClose
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready: self?.becameReady()
            case .failed(let error), .waiting(let error): self?.finish(error)
            case .cancelled: self?.finish(CancellationError())
            default: break
            }
        }
        let deadline = DispatchWorkItem { [weak self] in self?.finish(PairingError.unavailable, beforeReadyOnly: true) }
        readinessDeadline = deadline
        DispatchQueue.global().asyncAfter(deadline: .now() + handshakeTimeout, execute: deadline)
    }

    static func open(_ origin: AgentOrigin, handshakeTimeout: TimeInterval = 35, onClose: @escaping @Sendable () -> Void) throws -> any BrowserStream {
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_add_tls_application_protocol(tls.securityProtocolOptions, "http/1.1")
        let tcp = NWProtocolTCP.Options()
        tcp.connectionTimeout = 20
        let connection = NWConnection(host: NWEndpoint.Host(origin.host), port: NWEndpoint.Port(rawValue: origin.port)!, using: NWParameters(tls: tls, tcp: tcp))
        let stream = HTTPSBrowserStream(connection: connection, authority: origin.authority, handshakeTimeout: handshakeTimeout, onClose: onClose)
        connection.start(queue: DispatchQueue(label: "happy.agent.https"))
        return stream
    }

    func read(maximumBytes: Int) async throws -> Data {
        try await perform { [connection] complete in
            connection.receive(minimumIncompleteLength: 1, maximumLength: maximumBytes) { data, _, _, error in
                if let error { complete(.failure(error)) }
                else { complete(.success(data ?? Data())) }
            }
        }
    }

    func write(_ data: Data) async throws {
        let _: Void = try await perform { [connection] complete in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error { complete(.failure(error)) }
                else { complete(.success(())) }
            })
        }
    }

    func close() async { finish(CancellationError()) }

    private func becameReady() {
        let waiters = lock.withLock {
            guard failure == nil else { return [CheckedContinuation<Void, any Error>]() }
            ready = true
            readinessDeadline?.cancel(); readinessDeadline = nil
            defer { readiness.removeAll() }
            return readiness
        }
        waiters.forEach { $0.resume() }
    }

    /// Network.framework can enter `waiting` without completing a queued
    /// send/receive. Resolve our own waiters on every terminal state, including
    /// failure before TLS is ready; cancellation and late callbacks race safely.
    private func finish(_ error: any Error, beforeReadyOnly: Bool = false) {
        let callbacks = lock.withLock { () -> ([CheckedContinuation<Void, any Error>], [@Sendable (any Error) -> Void])? in
            guard failure == nil, !beforeReadyOnly || !ready else { return nil }
            failure = error
            readinessDeadline?.cancel(); readinessDeadline = nil
            defer { readiness.removeAll(); pending.removeAll() }
            return (readiness, Array(pending.values))
        }
        guard let callbacks else { return }
        connection.cancel()
        callbacks.0.forEach { $0.resume(throwing: error) }
        callbacks.1.forEach { $0(error) }
        onClose()
    }

    private func awaitReady() async throws {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                lock.withLock {
                    if let failure { continuation.resume(throwing: failure) }
                    else if ready { continuation.resume() }
                    else { readiness.append(continuation) }
                }
            }
        } onCancel: { self.finish(CancellationError()) }
    }

    private func perform<T: Sendable>(_ start: @Sendable (@escaping @Sendable (Result<T, any Error>) -> Void) -> Void) async throws -> T {
        try await awaitReady()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                let id = UUID()
                let error = lock.withLock { () -> (any Error)? in
                    if let failure { return failure }
                    pending[id] = { continuation.resume(throwing: $0) }
                    return nil
                }
                if let error { continuation.resume(throwing: error); return }
                start { [self] result in
                    let owned = lock.withLock { pending.removeValue(forKey: id) != nil }
                    if owned { continuation.resume(with: result) }
                    if case .failure(let error) = result { finish(error) }
                }
            }
        } onCancel: { self.finish(CancellationError()) }
    }
}
#else
enum HTTPSBrowserStream {
    static func open(_ origin: AgentOrigin, onClose: @escaping @Sendable () -> Void) throws -> any BrowserStream {
        throw PairingError.unavailable
    }
}
#endif