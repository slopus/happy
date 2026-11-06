import Foundation

/// A server the Happy Cloud account belongs to (`GET /v1/servers`).
public struct CloudServer: Codable, Equatable, Sendable {
    public enum Role: String, Codable, Sendable { case owner, member }
    /// The server's picture (its node avatar), served by the accounts
    /// service under the account's token.
    public struct Image: Codable, Equatable, Sendable {
        public var thumbhash: String?
        public var width: Int?
        public var height: Int?
        public var url: String
        public init(thumbhash: String?, width: Int?, height: Int?, url: String) {
            self.thumbhash = thumbhash; self.width = width; self.height = height; self.url = url
        }
    }
    public var id: String
    public var name: String
    public var url: String
    public var role: Role?
    /// The server's own name for itself (its node name), when it has one.
    public var displayName: String?
    public var image: Image?

    public init(id: String, name: String, url: String, role: Role?, displayName: String? = nil, image: Image? = nil) {
        self.id = id; self.name = name; self.url = url; self.role = role; self.displayName = displayName; self.image = image
    }

    public var title: String { displayName.flatMap { $0.isEmpty ? nil : $0 } ?? name }

    /// The origin the app signs in to: built from the name and the app's
    /// own base, never taken from `url`, so the accounts service can't
    /// send a sign-in anywhere else.
    public var origin: String? { HappyCloud.isValidName(name) ? HappyCloud.server(named: name) : nil }
}

public enum CloudAccountError: Error, Equatable, Sendable {
    /// The account's pass expired or was refused; sign in to the account
    /// again.
    case signInRequired
    /// `{ code, error }` from the accounts API.
    case refused(status: Int, code: String?, message: String?)
    case invalidResponse
}

/// The Happy Cloud account: a one-hour pass from the accounts service
/// (Sign in with Apple, or the authorization code flow in the browser),
/// good for the picker's calls and for minting a token per server. It has
/// no refresh token and is never stored: held in memory with its expiry,
/// and once it ends, or any accounts call answers 401, the person signs in
/// again. Each server's own token, from `serverToken`, is the lasting
/// session. The account token goes only to the accounts service, never to
/// a server.
public actor CloudAccount {
    /// How the account signs in in the browser; fixed, not discovered.
    public static let method = OAuthMethod(
        id: "accounts", name: HappyCloud.name, authorizationUrl: HappyCloud.accounts + "/authorize", tokenUrl: HappyCloud.accounts + "/token",
        clientId: "happy", resource: HappyCloud.accounts + "/")
    /// Every account token must be for the accounts service.
    static let grant = OAuthGrant(clientId: "happy", audience: HappyCloud.accounts + "/")
    /// The pass lasts an hour (ACCOUNTS.md, "Token lifetimes (v4)") when
    /// the answer doesn't say.
    static let lifetime: TimeInterval = 3600

    /// The authorization request to open in the browser.
    public static func request(redirectUri: String = OAuthRedirect.uri) throws -> OAuthSignInRequest {
        try OAuthSignInRequest(method: method, audience: OAuthAudience(HappyCloud.accounts + "/")!, redirectUri: redirectUri)
    }

    private let token: String
    /// When the pass ends.
    public nonisolated let expiresAt: Date
    private let http: any HTTPTransport
    private let tokens: OAuthTokenClient
    private let now: @Sendable () -> Date

    init(access: OAuthAccess, http: any HTTPTransport, now: @escaping @Sendable () -> Date) {
        token = access.token
        expiresAt = access.expiresAt ?? now().addingTimeInterval(Self.lifetime)
        self.http = http
        tokens = OAuthTokenClient(http: http, now: now)
        self.now = now
    }

    /// Whether the pass is still good, with a minute to spare for the call
    /// about to use it.
    public nonisolated func isLive(at date: Date = Date()) -> Bool { expiresAt.timeIntervalSince(date) > 60 }

    /// Exchanges the browser's redirect for the account's pass. A refresh
    /// token, if one came, is dropped.
    public static func signIn(_ request: OAuthSignInRequest, callback: URL, http: any HTTPTransport = NoRedirectURLSessionTransport(),
                              now: @escaping @Sendable () -> Date = Date.init) async throws -> CloudAccount {
        let (access, _) = try await OAuthTokenClient(http: http, now: now).complete(request, callback: callback)
        return CloudAccount(access: access, http: http, now: now)
    }

    /// Signs in with an identity token the phone got natively
    /// (`POST /v1/auth/native`): Apple's, with the raw nonce its hash was
    /// asked with, and the person's name, which Apple gives only the first
    /// time.
    public static func signIn(provider: String, idToken: String, nonce: String, authorizationCode: String?, name: String?,
                              http: any HTTPTransport = NoRedirectURLSessionTransport(), now: @escaping @Sendable () -> Date = Date.init) async throws -> CloudAccount {
        var body = ["provider": provider, "idToken": idToken, "nonce": nonce]
        body["authorizationCode"] = authorizationCode
        if let name, !name.isEmpty { body["name"] = name }
        let response = try await http.send(HTTPRequest(method: "POST", url: URL(string: HappyCloud.accounts + "/v1/auth/native")!,
                                                       headers: ["Accept": "application/json", "Content-Type": "application/json"], body: try JSONEncoder().encode(body)))
        // A 401 here is the identity token refused, not a pass ending.
        guard (200..<300).contains(response.status) else { throw refusal(response, endsPass: false) }
        let (access, _) = try OAuthTokenClient(http: http, now: now).accept(response.body, previous: grant, typed: false)
        return CloudAccount(access: access, http: http, now: now)
    }

    #if DEBUG
    /// An account from an access token alone, for the harness's screenshots.
    public static func preview(token: String, expiresAt: Date? = nil) -> CloudAccount {
        CloudAccount(access: OAuthAccess(token: token, expiresAt: expiresAt), http: NoRedirectURLSessionTransport(), now: Date.init)
    }
    #endif

    /// Forgets the account grant earlier builds kept in the Keychain: the
    /// account has no refresh token now.
    public static func forgetKeptGrant(backend: any KeychainBackend) {
        backend.delete(KeychainItemQuery(service: "happy-ios:cloud-account", account: Data("account".utf8), generic: Data("account".utf8)))
    }

    public func servers() async throws -> [CloudServer] {
        struct Response: Decodable { let servers: [CloudServer] }
        return try await call("GET", "/v1/servers", as: Response.self).servers
    }

    public enum Availability: Equatable, Sendable { case available, taken, reserved, invalid }

    public func availability(_ name: String) async throws -> Availability {
        struct Response: Decodable { let available: Bool; let reason: String? }
        let query = name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? name
        let answer = try await call("GET", "/v1/servers/availability?name=\(query)", as: Response.self)
        if answer.available { return .available }
        switch answer.reason { case "taken": return .taken; case "reserved": return .reserved; default: return .invalid }
    }

    public func create(_ name: String) async throws -> CloudServer {
        struct Response: Decodable { let server: CloudServer }
        return try await call("POST", "/v1/servers", body: ["name": name], as: Response.self).server
    }

    public func join(_ name: String, code: String) async throws -> CloudServer {
        struct Response: Decodable { let server: CloudServer }
        return try await call("POST", "/v1/servers/join", body: ["name": name, "code": code], as: Response.self).server
    }

    /// A server image's bytes. Only from the accounts origin: the account
    /// token goes nowhere else.
    public func image(_ image: CloudServer.Image) async throws -> Data {
        guard let url = URL(string: image.url), OAuthOrigin(image.url) == OAuthOrigin(HappyCloud.accounts) else { throw CloudAccountError.invalidResponse }
        let response = try await send("GET", url: url, accept: "image/*")
        return response.body
    }

    /// A token for `server`, the person's lasting session there: its
    /// access and refresh tokens, which refresh at the accounts service's
    /// token endpoint without the account (`POST /v1/servers/:id/token`).
    public func serverToken(for server: CloudServer) async throws -> (OAuthAccess, OAuthGrant) {
        guard let origin = server.origin else { throw CloudAccountError.invalidResponse }
        let method = HappyCloud.method(server: origin)
        let id = server.id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_"))) ?? server.id
        let response = try await send("POST", url: URL(string: HappyCloud.accounts + "/v1/servers/\(id)/token")!, body: Data("{}".utf8))
        let grant = OAuthGrant(refreshUrl: method.refreshUrl, clientId: method.clientId, resource: method.resource, audience: origin + "/")
        return try tokens.accept(response.body, previous: grant, typed: false)
    }

    private func call<T: Decodable>(_ method: String, _ path: String, body: [String: String]? = nil, as: T.Type) async throws -> T {
        let response = try await send(method, url: URL(string: HappyCloud.accounts + path)!, body: try body.map { try JSONEncoder().encode($0) })
        guard let value = try? JSONDecoder().decode(T.self, from: response.body) else { throw CloudAccountError.invalidResponse }
        return value
    }

    /// One request under the account's pass. An expired pass or a 401
    /// ends the account: there is nothing to refresh it with.
    private func send(_ method: String, url: URL, body: Data? = nil, accept: String = "application/json") async throws -> HTTPResponse {
        guard isLive(at: now()) else { throw CloudAccountError.signInRequired }
        var headers = ["Accept": accept, "Authorization": "Bearer \(token)"]
        if body != nil { headers["Content-Type"] = "application/json" }
        let response = try await http.send(HTTPRequest(method: method, url: url, headers: headers, body: body))
        guard (200..<300).contains(response.status) else { throw Self.refusal(response) }
        return response
    }

    private static func refusal(_ response: HTTPResponse, endsPass: Bool = true) -> CloudAccountError {
        if response.status == 401, endsPass { return .signInRequired }
        struct Failure: Decodable { let code: String?; let error: String? }
        let failure = try? JSONDecoder().decode(Failure.self, from: response.body)
        return .refused(status: response.status, code: failure?.code, message: failure?.error)
    }
}
