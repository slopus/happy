import Foundation

public struct GuestPendingMessage: Codable, Sendable {
    public let localId: String
    public let text: String
    public init(localId: String, text: String) { self.localId = localId; self.text = text }
}

public struct StoredGuestSession: Codable, Sendable {
    public let origin: URL
    public let invitationID: String
    public let session: GuestSession
    public let displayName: String?
    public var pending: GuestPendingMessage?
    public var readOnlyOverride: Bool?

    public init(origin: URL, invitationID: String, session: GuestSession, pending: GuestPendingMessage? = nil, displayName: String? = nil) {
        self.origin = origin
        self.invitationID = invitationID
        self.session = session
        self.displayName = displayName
        self.pending = pending
        self.readOnlyOverride = nil
    }
}

public struct PendingGuestRedemption: Codable, Sendable {
    public let invitationURL: URL
    public let origin: URL
    public let redeemNonce: String
    public let displayName: String?
    public var nameRejected: Bool? = nil
}

public protocol GuestSecretStorage: Sendable {
    func read() throws -> Data?
    func write(_ data: Data) throws
    func delete() throws
}

/// A separate guest registry; never accesses the owner's Keychain service.
public actor GuestSessionVault {
    private struct Registry: Codable {
        var activeID: String?
        var sessions: [String: StoredGuestSession] = [:]
        var redemptions: [String: PendingGuestRedemption] = [:]
    }
    private let storage: any GuestSecretStorage
    private let makeClient: @Sendable (URL) -> GuestClient
    private var inFlight: [String: Task<StoredGuestSession, any Error>] = [:]
    private var invalidatedIDs: Set<String> = []

    public init(storage: any GuestSecretStorage, makeClient: @escaping @Sendable (URL) -> GuestClient = { GuestClient(origin: $0) }) {
        self.storage = storage
        self.makeClient = makeClient
    }

    public func restore(invitationID: String? = nil) throws -> StoredGuestSession? {
        let registry = try read()
        guard let id = invitationID ?? registry.activeID else { return nil }
        return registry.sessions[id]
    }

    public func pendingRedemption(invitationID: String? = nil) throws -> PendingGuestRedemption? {
        let registry = try read()
        guard let id = invitationID ?? registry.activeID else { return nil }
        return registry.redemptions[id]
    }

    public func save(_ session: StoredGuestSession, select: Bool = true) throws {
        guard !invalidatedIDs.contains(session.invitationID) else { throw GuestError.revoked }
        var registry = try read()
        registry.sessions[session.invitationID] = session
        registry.redemptions.removeValue(forKey: session.invitationID)
        if select || registry.activeID == nil { registry.activeID = session.invitationID }
        try storage.write(JSONEncoder().encode(registry))
    }

    /// An unstructured task completes the durable handshake even if a view is
    /// dismissed or backgrounded. All callers for one invite await that task.
    public func redeem(_ invitation: GuestInvitation, origin: URL, displayName: String) async throws -> StoredGuestSession {
        let id = invitation.identifier
        if let stored = try restore(invitationID: id), stored.origin == origin { return stored }
        if let existing = inFlight[id] { return try await existing.value }
        guard let name = GuestDisplayName.normalized(displayName) else { throw GuestError.invalidName }
        var registry = try read()
        let pending: PendingGuestRedemption
        if let saved = registry.redemptions[id] {
            guard saved.origin == origin else { throw GuestError.invalidResponse }
            pending = PendingGuestRedemption(invitationURL: saved.invitationURL, origin: saved.origin,
                                              redeemNonce: saved.redeemNonce, displayName: saved.nameRejected == true ? name : saved.displayName ?? name)
        } else {
            var random = SystemRandomNumberGenerator()
            let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &random) }
            let nonce = Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            pending = PendingGuestRedemption(invitationURL: invitation.url, origin: origin, redeemNonce: nonce, displayName: name)
            registry.redemptions[id] = pending
            registry.activeID = id
        }
        registry.redemptions[id] = pending
        // The name and nonce are durable BEFORE any redeem can reach the server.
        try storage.write(JSONEncoder().encode(registry))
        let task = Task {
            let client = makeClient(origin)
            let session = try await client.redeem(invitation, redeemNonce: pending.redeemNonce, displayName: pending.displayName ?? name)
            guard !invalidatedIDs.contains(id) else { throw GuestError.revoked }
            let stored = StoredGuestSession(origin: origin, invitationID: id, session: session, displayName: session.displayName ?? pending.displayName ?? name)
            try self.save(stored, select: false)
            return stored
        }
        inFlight[id] = task
        defer { inFlight[id] = nil }
        do { return try await task.value }
        catch {
            if let failure = error as? GuestError {
                switch failure {
                case .inviteFull, .expired, .revoked: try remove(invitationID: id)
                case .invalidName:
                    // The bridge guarantees invalid_name is returned before a
                    // seat transaction. A corrected name may reuse this nonce.
                    var registry = try read()
                    registry.redemptions[id]?.nameRejected = true
                    try storage.write(JSONEncoder().encode(registry))
                default: break
                }
            }
            throw error
        }
    }

    public func remove(invitationID: String) throws {
        invalidatedIDs.insert(invitationID)
        var registry = try read()
        registry.sessions.removeValue(forKey: invitationID)
        registry.redemptions.removeValue(forKey: invitationID)
        if registry.activeID == invitationID { registry.activeID = registry.sessions.keys.sorted().first }
        if registry.sessions.isEmpty && registry.redemptions.isEmpty { try storage.delete() }
        else { try storage.write(JSONEncoder().encode(registry)) }
    }

    private func read() throws -> Registry {
        guard let data = try storage.read() else { return Registry() }
        var registry = try JSONDecoder().decode(Registry.self, from: data)
        // A full day of grace prevents ordinary clock skew from discarding a
        // resumable session. The server still authorizes every live request.
        let cutoff = (Date().timeIntervalSince1970 - 86_400) * 1_000
        let expired = registry.sessions.filter { $0.value.session.expiresAt < cutoff }.map(\.key)
        if !expired.isEmpty {
            for id in expired { registry.sessions.removeValue(forKey: id) }
            if let id = registry.activeID, expired.contains(id) { registry.activeID = registry.sessions.keys.sorted().first }
            if registry.sessions.isEmpty && registry.redemptions.isEmpty { try storage.delete() }
            else { try storage.write(JSONEncoder().encode(registry)) }
        }
        return registry
    }
}