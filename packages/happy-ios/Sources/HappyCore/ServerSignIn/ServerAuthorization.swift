import Foundation

/// One signed-in server's bearer. The access token is held in memory only;
/// the grant (refresh token, refresh URL, client, resource) lives in the
/// Keychain with the account's credentials and is saved again whenever the
/// authorization server rotates the refresh token.
///
/// A token is refreshed about a minute before it expires and after a `401`.
/// Concurrent requests share one refresh. Once a refresh fails, or there is
/// none, the server needs signing in again and nothing is retried until a
/// new sign-in replaces the grant.
public actor ServerAuthorization {
    public enum State: Equatable, Sendable { case signedIn, needsSignIn }

    public private(set) var state: State = .signedIn
    private var access: OAuthAccess?
    private var grant: OAuthGrant
    private var refreshing: Task<OAuthAccess, any Error>?
    private let tokens: OAuthTokenClient
    private let save: @Sendable (OAuthGrant) async throws -> Void
    private let now: @Sendable () -> Date
    private var observers: [UUID: @Sendable (State) -> Void] = [:]
    /// How long before expiry a token is replaced.
    static let margin: TimeInterval = 60

    public init(grant: OAuthGrant, access: OAuthAccess? = nil, tokens: OAuthTokenClient = OAuthTokenClient(), now: @escaping @Sendable () -> Date = Date.init,
                save: @escaping @Sendable (OAuthGrant) async throws -> Void) {
        self.grant = grant; self.access = access; self.tokens = tokens; self.now = now; self.save = save
    }

    public func observe(_ callback: @escaping @Sendable (State) -> Void) -> UUID {
        let id = UUID()
        observers[id] = callback
        return id
    }

    public func removeObserver(_ id: UUID) { observers[id] = nil }

    /// A token to send now, refreshed first when it is about to expire.
    public func bearer() async throws -> String {
        guard state == .signedIn else { throw ServerSignInError.rejected }
        if let access, access.expiresAt.map({ $0.timeIntervalSince(now()) > Self.margin }) ?? true { return access.token }
        return try await refresh().token
    }

    public enum Renewal: Sendable {
        case token(String)
        /// The server needs signing in again.
        case signIn
        /// The refresh couldn't be made (no network); the grant stands.
        case failed(any Error)
    }

    /// After `token` was refused with a `401`: a new token, or the one
    /// another request already replaced it with.
    public func renew(after token: String) async -> Renewal {
        guard state == .signedIn else { return .signIn }
        if let access, access.token != token { return .token(access.token) }
        // The refused token is no use to anyone else either.
        access = nil
        do { return .token(try await refresh().token) }
        catch { return state == .signedIn ? .failed(error) : .signIn }
    }

    /// The server refused this sign-in in a way a refresh can't fix (a
    /// redirect to the identity provider, a `403` that isn't Happy's).
    public func signInRequired() {
        guard state == .signedIn else { return }
        refreshing?.cancel(); refreshing = nil
        access = nil
        set(.needsSignIn)
    }

    /// A completed sign-in to the same server: the old grant is replaced.
    public func replace(access: OAuthAccess, grant: OAuthGrant) {
        refreshing?.cancel(); refreshing = nil
        self.access = access; self.grant = grant
        set(.signedIn)
    }

    private func refresh() async throws -> OAuthAccess {
        if let refreshing { return try await refreshing.value }
        guard grant.canRefresh else { signInRequired(); throw ServerSignInError.rejected }
        let task = Task { [tokens, grant] in
            let (access, next) = try await tokens.refresh(grant)
            try await self.adopt(access, next, from: grant)
            return access
        }
        refreshing = task
        defer { if refreshing == task { refreshing = nil } }
        do {
            return try await task.value
        } catch {
            // A network failure keeps the grant for the next try; the
            // authorization server refusing it means signing in again.
            if refreshing == task {
                switch error {
                case OAuthError.server, OAuthError.invalidResponse, OAuthError.refreshUnavailable: signInRequired()
                default: break
                }
            }
            throw error
        }
    }

    /// A refresh's result, unless a sign-in replaced the grant meanwhile.
    private func adopt(_ value: OAuthAccess, _ next: OAuthGrant, from previous: OAuthGrant) async throws {
        guard grant == previous else { throw CancellationError() }
        access = value
        guard next != grant else { return }
        grant = next
        // A rotated refresh token that isn't saved is lost at the next
        // launch, and the next refresh with the old one may be refused:
        // keep using it in memory either way.
        try? await save(next)
    }

    private func set(_ next: State) {
        guard state != next else { return }
        state = next
        for observer in observers.values { observer(next) }
    }
}
