import Foundation

/// A disconnected pairing whose device is still to be removed from its
/// agent (`DELETE /v0/mobile-connector/device`), with the credentials the
/// request needs once the connection itself is gone.
public struct PendingDeviceRevoke: Codable, Equatable, Sendable {
    /// The pairing's own: its address and its device token, kept only until
    /// the agent answers.
    public var credentials: AgentConnectionCredentials
    public var queuedAt: Date

    public init(credentials: AgentConnectionCredentials, queuedAt: Date = Date()) {
        self.credentials = credentials
        self.queuedAt = queuedAt
    }
}

/// Where pending revocations wait across launches. They hold device
/// tokens, so on a phone they are a Keychain item of their own.
public protocol DeviceRevokeStore: Sendable {
    func all() throws -> [String: PendingDeviceRevoke]
    func save(_ value: PendingDeviceRevoke, id: String) throws
    func remove(id: String) throws
}

/// Service `happy-ios:device-revoke`, account = the connection id.
public struct KeychainDeviceRevokeStore: DeviceRevokeStore {
    public static let service = "happy-ios:device-revoke"
    private let backend: any AccountKeychainBackend
    public init(backend: any AccountKeychainBackend) { self.backend = backend }
    private func query(_ id: String) -> KeychainItemQuery {
        let data = Data(id.utf8)
        return KeychainItemQuery(service: Self.service, account: data, generic: data)
    }
    public func all() throws -> [String: PendingDeviceRevoke] {
        var result: [String: PendingDeviceRevoke] = [:]
        for id in try backend.accounts(service: Self.service) {
            guard let data = try backend.copyData(query(id)),
                  let value = try? JSONDecoder().decode(PendingDeviceRevoke.self, from: data) else { continue }
            result[id] = value
        }
        return result
    }
    public func save(_ value: PendingDeviceRevoke, id: String) throws {
        let data = try JSONEncoder().encode(value)
        if try backend.add(query(id), data: data, accessibility: .whenUnlocked) == .duplicate { try backend.update(query(id), data: data) }
    }
    public func remove(id: String) throws { try backend.removeAccount(query(id)) }
}

public final class InMemoryDeviceRevokeStore: DeviceRevokeStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: PendingDeviceRevoke] = [:]
    public init() {}
    public func all() throws -> [String: PendingDeviceRevoke] { lock.withLock { values } }
    public func save(_ value: PendingDeviceRevoke, id: String) throws { lock.withLock { values[id] = value } }
    public func remove(id: String) throws { _ = lock.withLock { values.removeValue(forKey: id) } }
}

/// Removes disconnected pairings' devices from their agents, after the
/// connection has already gone from this phone, so the agent's device list
/// doesn't keep a phone that will never come back (a new pairing is a new
/// device). Kept until the agent answers: a 2xx; a 401 (the device is
/// already gone); a 403 (a daemon from before the route, which refuses
/// phones everything under the connector: nothing can be done); any other
/// refusal but 408 and 429. Anything else (no network, Tailcat not through,
/// a 5xx) is tried again at 1, 2, 4 … 30 seconds while the app runs, at the
/// next launch, and whenever the phone pairs again. One left for 30 days is
/// dropped.
///
/// Only the old pairing's token is ever sent. A token a connection on this
/// phone holds now is never revoked: it is dropped unsent.
actor DeviceRevokeQueue {
    static let path = "/v0/mobile-connector/device"
    static let expiry: TimeInterval = 30 * 24 * 60 * 60

    private let store: any DeviceRevokeStore
    private let makeTransport: @Sendable (AgentConnectionCredentials) -> any AgentTransport
    private let inUse: @Sendable (String) async -> Bool
    private var running: Task<Void, Never>?
    private var loaded = false
    private var pending: [String: PendingDeviceRevoke] = [:]
    var attemptTimeout: Duration = .seconds(30)
    var backoff = Backoff.standard

    init(store: any DeviceRevokeStore,
         makeTransport: @escaping @Sendable (AgentConnectionCredentials) -> any AgentTransport,
         inUse: @escaping @Sendable (String) async -> Bool) {
        self.store = store
        self.makeTransport = makeTransport
        self.inUse = inUse
    }

    /// Keeps the revocation, then sends it. Returns once it is kept, not
    /// sent. A signed-in server's connection has no device to revoke.
    func enqueue(_ credentials: AgentConnectionCredentials, id: String, at time: Date = Date()) throws {
        guard credentials.signIn == nil, !credentials.deviceToken.isEmpty else { return }
        load()
        let value = PendingDeviceRevoke(credentials: credentials, queuedAt: time)
        try store.save(value, id: id)
        pending[id] = value
        deliver()
    }

    /// Sends what is waiting now, without waiting for the backoff: at
    /// launch, and when the phone has reached an agent again.
    func resume() {
        load()
        if let running, !pending.isEmpty {
            running.cancel()
            self.running = nil
        }
        deliver()
    }

    /// Returns once nothing is waiting, or `limit` has passed. For tests.
    func waitUntilEmpty(limit: Duration = .seconds(10)) async {
        let deadline = ContinuousClock.now + limit
        while !pending.isEmpty, ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(10)) }
    }

    var waiting: [String: PendingDeviceRevoke] { pending }

    /// For tests: retries sooner.
    func setBackoff(_ backoff: Backoff) { self.backoff = backoff }

    private func load() {
        #if DEBUG
        dispatchPrecondition(condition: .notOnQueue(.main))
        #endif
        guard !loaded else { return }
        // A locked Keychain leaves them for the next launch.
        guard let saved = try? store.all() else { return }
        loaded = true
        pending.merge(saved) { current, _ in current }
    }

    private func deliver() {
        guard running == nil, !pending.isEmpty else { return }
        running = Task { await self.run() }
    }

    private func run() async {
        var attempt = 0
        while !pending.isEmpty, !Task.isCancelled {
            for (id, value) in pending.sorted(by: { $0.value.queuedAt < $1.value.queuedAt }) {
                guard !Task.isCancelled else { break }
                var done = Date().timeIntervalSince(value.queuedAt) > Self.expiry
                // Paired again with this very token (never from a new
                // handshake): it is the phone's again, not to be revoked.
                if !done { done = await inUse(value.credentials.deviceToken) }
                if !done { done = await send(value) }
                if done, pending[id] == value {
                    pending.removeValue(forKey: id)
                    try? store.remove(id: id)
                }
            }
            guard !pending.isEmpty, !Task.isCancelled else { break }
            attempt += 1
            try? await Task.sleep(for: backoff.delay(attempt: attempt))
        }
        guard !Task.isCancelled else { return }
        running = nil
        // One queued while the last pass slept on its way out.
        deliver()
    }

    /// True once the agent has answered for good. A request that doesn't
    /// answer within `attemptTimeout` is cancelled and left for later.
    private func send(_ value: PendingDeviceRevoke) async -> Bool {
        let transport = makeTransport(value.credentials)
        let answer = RevokeAnswer()
        let request = Task {
            do {
                let response = try await transport.request(method: "DELETE", path: Self.path, credential: value.credentials.deviceToken, body: nil, headers: [:])
                answer.set(Self.final(response.status))
            } catch {
                answer.set(false)
            }
        }
        await waitAtMost(attemptTimeout) { await request.value }
        request.cancel()
        await transport.close()
        return answer.value ?? false
    }

    /// Whether `status` ends the revocation: gone (2xx, 401), refused for
    /// good (403 from an older daemon, any other 4xx but 408 and 429).
    static func final(_ status: Int) -> Bool {
        if (200..<300).contains(status) { return true }
        return (400..<500).contains(status) && status != 408 && status != 429
    }
}

private final class RevokeAnswer: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Bool? // under `lock`
    var value: Bool? { lock.withLock { stored } }
    func set(_ value: Bool) { lock.withLock { stored = value } }
}
