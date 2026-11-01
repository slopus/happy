import Foundation

/// A signed-out account's push token, still to be removed from its server
/// (AuthContext.tsx `logout`), with what the request needs once the
/// account's own credentials are gone.
public struct PendingPushUnregister: Codable, Equatable, Sendable {
    public var serverURL: URL
    /// The account's bearer token, kept only until the server answers.
    public var token: String
    public var pushToken: String
    public var queuedAt: Date

    public init(serverURL: URL, token: String, pushToken: String, queuedAt: Date = Date()) {
        self.serverURL = serverURL
        self.token = token
        self.pushToken = pushToken
        self.queuedAt = queuedAt
    }
}

/// Where pending removals wait across launches. It holds a bearer token, so
/// on a phone it is a Keychain item of its own, never the RN item.
public protocol PushUnregisterStore: Sendable {
    func all() throws -> [String: PendingPushUnregister]
    func save(_ value: PendingPushUnregister, id: String) throws
    func remove(id: String) throws
}

/// Service `happy-ios:push-unregister`, account = the account id.
public struct KeychainPushUnregisterStore: PushUnregisterStore {
    public static let service = "happy-ios:push-unregister"
    private let backend: any AccountKeychainBackend
    public init(backend: any AccountKeychainBackend) { self.backend = backend }
    private func query(_ id: String) -> KeychainItemQuery {
        let data = Data(id.utf8)
        return KeychainItemQuery(service: Self.service, account: data, generic: data)
    }
    public func all() throws -> [String: PendingPushUnregister] {
        var result: [String: PendingPushUnregister] = [:]
        for id in try backend.accounts(service: Self.service) {
            guard let data = try backend.copyData(query(id)),
                  let value = try? JSONDecoder().decode(PendingPushUnregister.self, from: data) else { continue }
            result[id] = value
        }
        return result
    }
    public func save(_ value: PendingPushUnregister, id: String) throws {
        let data = try JSONEncoder().encode(value)
        if try backend.add(query(id), data: data, accessibility: .whenUnlocked) == .duplicate { try backend.update(query(id), data: data) }
    }
    public func remove(id: String) throws { try backend.removeAccount(query(id)) }
}

public final class InMemoryPushUnregisterStore: PushUnregisterStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: PendingPushUnregister] = [:]
    public init() {}
    public func all() throws -> [String: PendingPushUnregister] { lock.withLock { values } }
    public func save(_ value: PendingPushUnregister, id: String) throws { lock.withLock { values[id] = value } }
    public func remove(id: String) throws { _ = lock.withLock { values.removeValue(forKey: id) } }
}

/// Removes signed-out accounts' push tokens from their servers, after the
/// account has already gone from this phone. Kept until the server
/// answers: a 2xx, or a refusal other than 408 or 429 (a 401 means the
/// token no longer works there, so there is nothing left to remove).
/// Anything else (offline, a timeout, a 5xx) is tried again at 1, 2, 4 …
/// 30 seconds while the app runs, and again at the next launch. One left
/// for 30 days is dropped.
actor PushUnregisterQueue {
    private let store: any PushUnregisterStore
    private let transport: any HTTPTransport
    private let clientID: String
    private var running: Task<Void, Never>?
    private var loaded = false
    private var pending: [String: PendingPushUnregister] = [:]
    var attemptTimeout: Duration = .seconds(5)
    var backoff = Backoff.standard
    static let expiry: TimeInterval = 30 * 24 * 60 * 60

    init(store: any PushUnregisterStore, transport: any HTTPTransport, clientID: String) {
        self.store = store
        self.transport = transport
        self.clientID = clientID
    }

    /// Keeps the removal, then sends it. Returns once it is kept, not sent.
    func enqueue(_ value: PendingPushUnregister, id: String) throws {
        load()
        try store.save(value, id: id)
        pending[id] = value
        deliver()
    }

    /// Sends what an earlier launch left.
    func resume() {
        load()
        deliver()
    }

    /// Returns once nothing is waiting, or `limit` has passed. For tests.
    func waitUntilEmpty(limit: Duration = .seconds(10)) async {
        let deadline = ContinuousClock.now + limit
        while !pending.isEmpty, ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(10)) }
    }

    var waiting: [String: PendingPushUnregister] { pending }

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
                var done = Date().timeIntervalSince(value.queuedAt) > Self.expiry
                if !done { done = await send(value) }
                if done {
                    // Only the exact one sent: a newer sign-out of the same
                    // account meanwhile stays.
                    guard pending[id] == value else { continue }
                    pending.removeValue(forKey: id)
                    try? store.remove(id: id)
                }
            }
            guard !pending.isEmpty else { break }
            attempt += 1
            try? await Task.sleep(for: backoff.delay(attempt: attempt))
        }
        running = nil
        // One queued while the last pass slept on its way out.
        deliver()
    }

    /// True once the server has answered for good. A request that doesn't
    /// answer within `attemptTimeout` is cancelled and left behind, even
    /// one deaf to the cancellation.
    private func send(_ value: PendingPushUnregister) async -> Bool {
        let api = HappyAPI(serverURL: value.serverURL, clientID: clientID, transport: transport, token: value.token)
        let answer = Answer()
        let request = Task {
            do {
                try await api.unregisterPushToken(value.pushToken)
                answer.set(true)
            } catch APIError.unauthorized {
                answer.set(true)
            } catch APIError.http(let status, _) {
                answer.set((400..<500).contains(status) && status != 408 && status != 429)
            } catch is SessionActionError {
                // Answered, without the confirmation it asks for.
                answer.set(true)
            } catch {
                answer.set(false)
            }
        }
        await waitAtMost(attemptTimeout) { await request.value }
        request.cancel()
        return answer.value ?? false
    }
}

private final class Answer: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Bool? // under `lock`
    var value: Bool? { lock.withLock { stored } }
    func set(_ value: Bool) { lock.withLock { stored = value } }
}
