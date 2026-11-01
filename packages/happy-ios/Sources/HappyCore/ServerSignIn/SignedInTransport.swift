import Foundation
import HappyWire

/// A signed-in team server's transport. Every request, stream and tunnel
/// carries the account's current access token in `Authorization` (never a
/// query string), whatever credential its caller passed.
///
/// A refusal is read as the edge SSO contract (v2) says:
/// - a `401` with Happy's JSON asks discovery about the same token: not
///   authenticated refreshes once and repeats; authenticated as a known
///   member was transient and repeats once; authenticated with no user is
///   the profile gate, which only signing in again (and its name prompt)
///   gets past;
/// - a `401` that isn't Happy's (the edge's), a redirect, a `403` that
///   isn't Happy's JSON, or a refresh the authorization server refuses
///   needs signing in at once.
///
/// Once signing in is needed, the server is marked so and every caller
/// sees a plain `401`, which they already take as "this account can't get
/// in any more".
///
/// The transport under it never follows redirects (raw HTTP/1.1), so a load
/// balancer sending the request to its identity provider is seen here as
/// the 3xx it is.
public final class SignedInTransport: SelfMeteringTransport {
    let base: any AgentTransport
    let authorization: ServerAuthorization
    /// `GET /v0/authentication` with a token.
    let discover: @Sendable (String) async throws -> AuthenticationDiscovery

    public init(base: any AgentTransport, authorization: ServerAuthorization, discover: @escaping @Sendable (String) async throws -> AuthenticationDiscovery) {
        self.base = base; self.authorization = authorization; self.discover = discover
    }

    /// The server at `origin`, its discovery asked over HTTPS.
    public convenience init(base: any AgentTransport, authorization: ServerAuthorization, origin: String) {
        let discovery = ServerDiscovery()
        self.init(base: base, authorization: authorization) { token in
            guard let origin = try? AgentOrigin(origin) else { throw ServerSignInError.invalidURL }
            return try await discovery.discover(origin, token: token)
        }
    }

    public func attach(_ metrics: ConnectionMetrics) { (base as? any SelfMeteringTransport)?.attach(metrics) }

    /// What callers see once the server needs signing in.
    static let signInRequired = HTTP1Response(status: 401, headers: ["content-type": "application/json"],
                                              body: Data(#"{"error":"Unauthorized","code":"unauthorized"}"#.utf8))

    private enum Outcome { case token(String), signIn }

    private func token() async throws -> Outcome {
        do { return .token(try await authorization.bearer()) }
        catch ServerSignInError.rejected { return .signIn }
    }

    /// After `response` came back for `token`: the token to repeat with,
    /// nil when `response` stands, or `.signIn`.
    private func retry(_ status: Int, contentType: String?, body: Data, token: String) async throws -> Outcome? {
        guard SignInRequired.check(status: status, contentType: contentType, body: body) else { return nil }
        if status == 401, SignInRequired.isHappyError(contentType: contentType, body: body) {
            let who: AuthenticationDiscovery
            do { who = try await discover(token) }
            catch ServerSignInError.rejected { await authorization.signInRequired(); return .signIn }
            if who.authenticated {
                // The profile gate: the name prompt is part of signing in.
                guard who.userId != nil else { await authorization.signInRequired(); return .signIn }
                return .token(token)
            }
            switch await authorization.renew(after: token) {
            case .token(let next): return .token(next)
            case .failed(let error): throw error
            case .signIn: return .signIn
            }
        }
        await authorization.signInRequired()
        return .signIn
    }

    /// Sends with the current token, and once more after a refresh.
    private func signed(_ call: (String) async throws -> HTTP1Response) async throws -> HTTP1Response {
        guard case .token(let first) = try await token() else { return Self.signInRequired }
        let response = try await call(first)
        switch try await retry(response.status, contentType: response.headers["content-type"], body: response.body, token: first) {
        case nil: return response
        case .signIn?: return Self.signInRequired
        case .token(let next)?:
            let again = try await call(next)
            if SignInRequired.check(again) {
                await authorization.signInRequired()
                return Self.signInRequired
            }
            return again
        }
    }

    public func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        try await signed { try await base.request(method: method, path: path, credential: $0, body: body, headers: headers) }
    }

    public func request(method: String, path: String, credential: String, body: Data?, headers: [String: String], category: RequestCategory) async throws -> HTTP1Response {
        try await signed { try await base.request(method: method, path: path, credential: $0, body: body, headers: headers, category: category) }
    }

    public func upload(path: String, credential: String, body: Data) async throws -> HTTP1Response {
        try await signed { try await base.upload(path: path, credential: $0, body: body) }
    }

    public func send(method: String, path: String, credential: String, body: Data, upload: Bool, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response {
        try await signed { try await base.send(method: method, path: path, credential: $0, body: body, upload: upload, sent: sent) }
    }

    public func send(method: String, path: String, credential: String, body: Data, category: RequestCategory, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response {
        try await signed { try await base.send(method: method, path: path, credential: $0, body: body, category: category, sent: sent) }
    }

    /// The event stream. A refused head is read whole so its body can be
    /// told apart from Happy's JSON.
    public func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        guard case .token(var token) = try await token() else { return Self.closed(Self.signInRequired) }
        for attempt in 0..<2 {
            let stream = try await base.stream(path: path, credential: token, headers: headers)
            guard ((300..<400).contains(stream.status) && stream.status != 304) || stream.status == 401 || stream.status == 403 else { return stream }
            var body = Data()
            for try await bytes in stream.body {
                body.append(bytes)
                if body.count > 65536 { break }
            }
            let contentType = stream.headers["content-type"]
            switch try await retry(stream.status, contentType: contentType, body: body, token: token) {
            case nil: return Self.closed(HTTP1Response(status: stream.status, headers: stream.headers, body: body))
            case .token(let next)? where attempt == 0: token = next
            default:
                await authorization.signInRequired()
                return Self.closed(Self.signInRequired)
            }
        }
        return Self.closed(Self.signInRequired)
    }

    private static func closed(_ response: HTTP1Response) -> HTTP1Stream {
        HTTP1Stream(status: response.status, headers: response.headers, body: AsyncThrowingStream { $0.yield(response.body); $0.finish() })
    }

    public func proxyTunnel(_ path: String, credential: String) async throws -> any BrowserStream {
        guard case .token(var token) = try await token() else { throw AgentClientError.revoked }
        for attempt in 0..<2 {
            do { return try await base.proxyTunnel(path, credential: token) }
            catch let refusal as TunnelRefusal {
                switch try await retry(refusal.status, contentType: refusal.contentType, body: refusal.body, token: token) {
                case .token(let next)? where attempt == 0: token = next
                case nil: throw BrowserError.upstream(refusal.status)
                default:
                    await authorization.signInRequired()
                    throw AgentClientError.revoked
                }
            }
        }
        throw AgentClientError.revoked
    }

    public func bearer(_ credential: String) async throws -> String {
        guard case .token(let token) = try await token() else { throw AgentClientError.revoked }
        return token
    }

    public func browserConnection() async throws -> any BrowserStream { try await base.browserConnection() }
    public func reset() async { await base.reset() }
    public func reset(_ category: RequestCategory) async { await base.reset(category) }
    public func close() async { await base.close() }
}
