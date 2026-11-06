import Foundation

/// A server the Happy Cloud account belongs to (`GET /v1/servers`).
public struct CloudServer: Codable, Equatable, Sendable {
    public enum Role: String, Codable, Sendable { case owner, member }
    public var id: String
    public var name: String
    public var url: String
    public var role: Role?

    public init(id: String, name: String, url: String, role: Role?) {
        self.id = id; self.name = name; self.url = url; self.role = role
    }

    /// The origin the app signs in to: built from the name and the app's
    /// own base, never taken from `url`, so the accounts service can't
    /// send a sign-in anywhere else.
    public var origin: String? { HappyCloud.isValidName(name) ? HappyCloud.server(named: name) : nil }
}

public enum CloudAccountError: Error, Equatable, Sendable {
    /// The account's sign-in ended; sign in to the account again.
    case signInRequired
    /// `{ code, error }` from the accounts API.
    case refused(status: Int, code: String?, message: String?)
    case invalidResponse
}

/// The Happy Cloud account: its sign-in (authorization code + PKCE against
/// the accounts origin, `resource` the accounts origin) and the accounts
/// API under its token. The access token is held in memory only; the grant
/// (refresh token) is in the Keychain as a team server's is
/// (`CloudAccountKeychain`), so the picker opens again without the browser.
/// The account token goes only to the accounts service, never to a server.
public actor CloudAccount {
    /// How the account signs in; fixed, not discovered.
    public static let method = OAuthMethod(
        id: "accounts", name: HappyCloud.name, authorizationUrl: HappyCloud.accounts + "/authorize", tokenUrl: HappyCloud.accounts + "/token",
        refreshUrl: HappyCloud.accounts + "/token", clientId: "happy", resource: HappyCloud.accounts + "/")

    /// The authorization request to open in the browser.
    public static func request(redirectUri: String = OAuthRedirect.uri) throws -> OAuthSignInRequest {
        try OAuthSignInRequest(method: method, audience: OAuthAudience(HappyCloud.accounts + "/")!, redirectUri: redirectUri)
    }

    private let authorization: ServerAuthorization
    private let http: any HTTPTransport
    private let keychain: CloudAccountKeychain

    init(grant: OAuthGrant, access: OAuthAccess?, keychain: CloudAccountKeychain, http: any HTTPTransport, tokens: OAuthTokenClient) {
        self.keychain = keychain
        self.http = http
        authorization = ServerAuthorization(grant: grant, access: access, tokens: tokens) { try keychain.save($0) }
    }

    /// Exchanges the browser's redirect for the account's tokens and keeps
    /// the grant.
    public static func signIn(_ request: OAuthSignInRequest, callback: URL, keychain: CloudAccountKeychain,
                              http: any HTTPTransport = NoRedirectURLSessionTransport()) async throws -> CloudAccount {
        let tokens = OAuthTokenClient(http: http)
        let (access, grant) = try await tokens.complete(request, callback: callback)
        try keychain.save(grant)
        return CloudAccount(grant: grant, access: access, keychain: keychain, http: http, tokens: tokens)
    }

    /// The account signed in before, from its kept grant.
    public static func restore(keychain: CloudAccountKeychain, http: any HTTPTransport = NoRedirectURLSessionTransport()) -> CloudAccount? {
        guard let grant = try? keychain.load(), grant.canRefresh else { return nil }
        return CloudAccount(grant: grant, access: nil, keychain: keychain, http: http, tokens: OAuthTokenClient(http: http))
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

    /// Forgets the account on this phone.
    public func signOut() async {
        await authorization.signInRequired()
        keychain.remove()
    }

    private func call<T: Decodable>(_ method: String, _ path: String, body: [String: String]? = nil, as: T.Type) async throws -> T {
        var token: String
        do { token = try await authorization.bearer() } catch { throw CloudAccountError.signInRequired }
        for attempt in 0..<2 {
            var headers = ["Accept": "application/json", "Authorization": "Bearer \(token)"]
            var data: Data?
            if let body { headers["Content-Type"] = "application/json"; data = try JSONEncoder().encode(body) }
            let response = try await http.send(HTTPRequest(method: method, url: URL(string: HappyCloud.accounts + path)!, headers: headers, body: data))
            if response.status == 401, attempt == 0 {
                switch await authorization.renew(after: token) {
                case .token(let next): token = next; continue
                case .signIn: throw CloudAccountError.signInRequired
                case .failed(let error): throw error
                }
            }
            guard (200..<300).contains(response.status) else {
                if response.status == 401 { throw CloudAccountError.signInRequired }
                let failure = try? JSONDecoder().decode(Failure.self, from: response.body)
                throw CloudAccountError.refused(status: response.status, code: failure?.code, message: failure?.error)
            }
            guard let value = try? JSONDecoder().decode(T.self, from: response.body) else { throw CloudAccountError.invalidResponse }
            return value
        }
        throw CloudAccountError.signInRequired
    }

    private struct Failure: Decodable { let code: String?; let error: String? }
}

/// The account's grant in its own Keychain item, protected as a team
/// server's (`KeychainAgentConnectionCredentialStore`): after first unlock,
/// this device only, never synced.
public struct CloudAccountKeychain: Sendable {
    public static let service = "happy-ios:cloud-account"
    private let backend: any KeychainBackend
    private let query = KeychainItemQuery(service: CloudAccountKeychain.service, account: Data("account".utf8), generic: Data("account".utf8))

    public init(backend: any KeychainBackend) { self.backend = backend }

    func save(_ grant: OAuthGrant) throws {
        let data = try JSONEncoder().encode(grant)
        if try backend.add(query, data: data, accessibility: .afterFirstUnlockThisDeviceOnly) == .duplicate {
            try backend.update(query, data: data, accessibility: .afterFirstUnlockThisDeviceOnly)
        }
    }

    func load() throws -> OAuthGrant? {
        try backend.copyData(query).flatMap { try? JSONDecoder().decode(OAuthGrant.self, from: $0) }
    }

    func remove() { backend.delete(query) }
}
