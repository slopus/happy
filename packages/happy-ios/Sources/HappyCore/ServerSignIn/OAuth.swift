import Foundation
import HappyCrypto
import HappyWire

/// Signing in to a team server with the OAuth authorization code flow and
/// PKCE for native apps (RFC 6749, 7636, 8252), as happy-agent's API.md
/// ("Signing in with the authorization code flow") and the edge SSO
/// contract describe it. The app talks to the authorization server itself:
/// the daemon that advertised the method never sees the code, the verifier
/// or a refresh token, and a refresh token goes only to the refresh URL
/// recorded when it was issued.

/// One `oauth` sign-in method from `GET /v0/authentication`.
public struct OAuthMethod: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var authorizationUrl: String
    public var tokenUrl: String
    public var refreshUrl: String?
    public var clientId: String
    public var scope: String?
    /// RFC 8707 resource indicator, sent on authorize, code exchange and refresh.
    public var resource: String?

    public init(id: String, name: String, authorizationUrl: String, tokenUrl: String, refreshUrl: String? = nil, clientId: String, scope: String? = nil, resource: String? = nil) {
        self.id = id; self.name = name; self.authorizationUrl = authorizationUrl; self.tokenUrl = tokenUrl
        self.refreshUrl = refreshUrl; self.clientId = clientId; self.scope = scope; self.resource = resource
    }

    /// Every URL credentials travel to is `https` (or `http` to this
    /// device), and the names fit the schema's bounds.
    func validated() throws -> OAuthMethod {
        guard !id.isEmpty, !name.isEmpty, name.count <= 64, !clientId.isEmpty, clientId.count <= 256,
              scope.map({ !$0.isEmpty && $0.count <= 1024 }) ?? true else { throw OAuthError.invalidResponse }
        _ = try OAuthURL.secure(authorizationUrl)
        _ = try OAuthURL.secure(tokenUrl)
        if let refreshUrl { _ = try OAuthURL.secure(refreshUrl) }
        if let resource {
            guard resource.count <= 2048, let url = URLComponents(string: resource), url.scheme != nil, url.fragment == nil else { throw OAuthError.invalidResponse }
        }
        return self
    }
}

/// `GET /v0/authentication`. Methods whose `type` this app doesn't know, or
/// that don't validate, are left out rather than failing the whole answer.
public struct AuthenticationDiscovery: Decodable, Equatable, Sendable {
    public var authenticated: Bool
    public var userId: String?
    public var methods: [OAuthMethod]

    public init(authenticated: Bool, userId: String?, methods: [OAuthMethod]) {
        self.authenticated = authenticated; self.userId = userId; self.methods = methods
    }

    private enum Keys: String, CodingKey { case authenticated, userId, methods }
    private struct Typed: Decodable { let type: String }
    private struct Skip: Decodable {}

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        authenticated = try container.decode(Bool.self, forKey: .authenticated)
        userId = try container.decodeIfPresent(String.self, forKey: .userId)
        methods = try Self.methods(container, key: .methods)
    }

    /// Also reads the `authentication` field of a daemon's `401` body.
    static func methods<K: CodingKey>(_ container: KeyedDecodingContainer<K>, key: K) throws -> [OAuthMethod] {
        var list = try container.nestedUnkeyedContainer(forKey: key)
        var methods: [OAuthMethod] = []
        while !list.isAtEnd {
            let decoder = try list.superDecoder()
            guard (try? Typed(from: decoder))?.type == "oauth",
                  let method = try? OAuthMethod(from: decoder).validated() else { continue }
            methods.append(method)
        }
        return methods
    }
}

public enum OAuthError: Error, Equatable, Sendable {
    /// A URL that isn't `https` (or loopback `http`), or carries credentials or a fragment.
    case insecureURL
    /// The redirect's `state` isn't this attempt's.
    case stateMismatch
    /// The server answered with something that isn't OAuth.
    case invalidResponse
    /// An RFC 6749 error, from the redirect or the token endpoint.
    case server(code: String, description: String?)
    /// The token endpoint couldn't be reached.
    case network
    /// No refresh URL or token was recorded: sign in again.
    case refreshUnavailable
    /// The person closed the browser.
    case cancelled
}

enum OAuthURL {
    /// Credentials only travel over `https`, or `http` to this device.
    static func secure(_ value: String) throws -> URL {
        guard let parts = URLComponents(string: value), let scheme = parts.scheme?.lowercased(), let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.fragment == nil, let url = parts.url else { throw OAuthError.insecureURL }
        let loopback = host == "localhost" || host == "::1" || host == "[::1]" || Self.isLoopbackIPv4(host)
        guard scheme == "https" || (scheme == "http" && loopback) else { throw OAuthError.insecureURL }
        return url
    }

    private static func isLoopbackIPv4(_ host: String) -> Bool {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 4 && parts[0] == "127" && parts.allSatisfy { UInt8($0) != nil }
    }
}

/// The one redirect URI customers allow-list, the same for every Happy app
/// and flavor (edge SSO contract v2), documented in docs/SERVER-SIGN-IN.md.
/// Every variant already registers `happy`. Where several flavors share a
/// phone the wrong one may get the redirect; its state check refuses it.
public enum OAuthRedirect {
    public static let scheme = "happy"
    public static let uri = "happy://oauth/callback"

    /// The sign-in's redirect, which no Happy link handling may take.
    public static func isCallback(_ url: URL) -> Bool {
        url.scheme?.lowercased() == scheme && url.host?.lowercased() == "oauth" && url.path == "/callback"
    }
}

/// What a sign-in in progress keeps in memory until its redirect arrives.
public struct OAuthSignInRequest: Sendable {
    public let method: OAuthMethod
    public let redirectUri: String
    public let state: String
    public let codeVerifier: String
    /// Opened in the system browser.
    public let url: URL

    /// `random` gives `count` random bytes; tests pass fixed ones.
    public init(method: OAuthMethod, redirectUri: String, random: (Int) -> Data = OAuthSignInRequest.randomBytes) throws {
        let method = try method.validated()
        guard var parts = URLComponents(url: try OAuthURL.secure(method.authorizationUrl), resolvingAgainstBaseURL: false) else { throw OAuthError.insecureURL }
        guard let redirect = URLComponents(string: redirectUri), redirect.scheme != nil, redirect.fragment == nil, redirect.query == nil else { throw OAuthError.insecureURL }
        self.method = method
        self.redirectUri = redirectUri
        state = CanonicalBase64URL.encode(random(16))
        codeVerifier = CanonicalBase64URL.encode(random(32))
        let challenge = CanonicalBase64URL.encode(Hashing.sha256(Data(codeVerifier.utf8)))
        var parameters: [(String, String)] = [
            ("response_type", "code"), ("client_id", method.clientId), ("redirect_uri", redirectUri), ("state", state),
            ("code_challenge", challenge), ("code_challenge_method", "S256"),
        ]
        if let scope = method.scope { parameters.append(("scope", scope)) }
        if let resource = method.resource { parameters.append(("resource", resource)) }
        // The authorization URL may carry its own parameters; ours replace
        // any of the same name.
        let names = Set(parameters.map(\.0))
        var items = (parts.queryItems ?? []).filter { !names.contains($0.name) }
        items += parameters.map { URLQueryItem(name: $0.0, value: $0.1) }
        parts.percentEncodedQuery = items.map { "\(OAuthForm.escape($0.name))=\(OAuthForm.escape($0.value ?? ""))" }.joined(separator: "&")
        guard let url = parts.url else { throw OAuthError.insecureURL }
        self.url = url
    }

    public static func randomBytes(_ count: Int) -> Data {
        var generator = SystemRandomNumberGenerator()
        return Data((0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
    }

    /// The authorization code from the redirect, once its state matches.
    public func code(from callback: URL) throws -> String {
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard value("state") == state else { throw OAuthError.stateMismatch }
        if let error = value("error") { throw OAuthError.server(code: error, description: value("error_description")) }
        guard let code = value("code"), !code.isEmpty else { throw OAuthError.invalidResponse }
        return code
    }

    /// The token request's form: `grant_type=authorization_code`.
    func exchangeForm(code: String) -> [(String, String)] {
        var form = [("grant_type", "authorization_code"), ("code", code), ("redirect_uri", redirectUri), ("client_id", method.clientId), ("code_verifier", codeVerifier)]
        if let resource = method.resource { form.append(("resource", resource)) }
        return form
    }
}

/// The refresh half of a sign-in, recorded when its tokens were issued and
/// kept in the Keychain. Its refresh token goes only to `refreshUrl`.
public struct OAuthGrant: Codable, Equatable, Sendable {
    public var refreshToken: String?
    public var refreshUrl: String?
    public var clientId: String
    public var resource: String?

    public init(refreshToken: String? = nil, refreshUrl: String? = nil, clientId: String, resource: String? = nil) {
        self.refreshToken = refreshToken; self.refreshUrl = refreshUrl; self.clientId = clientId; self.resource = resource
    }

    public var canRefresh: Bool { refreshToken != nil && refreshUrl != nil }

    func refreshForm() throws -> (URL, [(String, String)]) {
        guard let refreshToken, let refreshUrl else { throw OAuthError.refreshUnavailable }
        var form = [("grant_type", "refresh_token"), ("refresh_token", refreshToken), ("client_id", clientId)]
        if let resource { form.append(("resource", resource)) }
        return (try OAuthURL.secure(refreshUrl), form)
    }
}

/// An access token, held only in memory.
public struct OAuthAccess: Equatable, Sendable {
    public let token: String
    /// When the server said it expires.
    public let expiresAt: Date?

    public init(token: String, expiresAt: Date?) { self.token = token; self.expiresAt = expiresAt }
}

enum OAuthForm {
    static let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))

    static func escape(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    static func encode(_ form: [(String, String)]) -> Data {
        Data(form.map { "\(escape($0.0))=\(escape($0.1))" }.joined(separator: "&").utf8)
    }
}

/// The token endpoint, over a transport that never follows redirects.
public struct OAuthTokenClient: Sendable {
    let http: any HTTPTransport
    let now: @Sendable () -> Date

    public init(http: any HTTPTransport = NoRedirectURLSessionTransport(), now: @escaping @Sendable () -> Date = Date.init) {
        self.http = http; self.now = now
    }

    /// Exchanges the code from `callback`: the tokens, and the grant to keep.
    public func complete(_ request: OAuthSignInRequest, callback: URL) async throws -> (OAuthAccess, OAuthGrant) {
        let code = try request.code(from: callback)
        let grant = OAuthGrant(refreshToken: nil, refreshUrl: request.method.refreshUrl, clientId: request.method.clientId, resource: request.method.resource)
        return try await post(try OAuthURL.secure(request.method.tokenUrl), form: request.exchangeForm(code: code), previous: grant)
    }

    /// A new access token for `grant`; a rotated refresh token replaces the
    /// old one, and its absence keeps it.
    public func refresh(_ grant: OAuthGrant) async throws -> (OAuthAccess, OAuthGrant) {
        let (url, form) = try grant.refreshForm()
        return try await post(url, form: form, previous: grant)
    }

    private func post(_ url: URL, form: [(String, String)], previous: OAuthGrant) async throws -> (OAuthAccess, OAuthGrant) {
        let request = HTTPRequest(method: "POST", url: url, headers: ["Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"], body: OAuthForm.encode(form))
        let response: HTTPResponse
        do { response = try await http.send(request) }
        catch is CancellationError { throw CancellationError() }
        catch { throw OAuthError.network }
        struct Tokens: Decodable { let access_token: String; let token_type: String; let expires_in: Double?; let refresh_token: String? }
        struct Failure: Decodable { let error: String; let error_description: String? }
        guard (200..<300).contains(response.status) else {
            if let failure = try? JSONDecoder().decode(Failure.self, from: response.body), !failure.error.isEmpty {
                throw OAuthError.server(code: failure.error, description: failure.error_description)
            }
            throw OAuthError.invalidResponse
        }
        guard let tokens = try? JSONDecoder().decode(Tokens.self, from: response.body),
              !tokens.access_token.isEmpty, tokens.access_token.count <= 16384, tokens.token_type.lowercased() == "bearer",
              tokens.refresh_token.map({ !$0.isEmpty && $0.count <= 16384 }) ?? true,
              tokens.expires_in.map({ $0 >= 0 }) ?? true else { throw OAuthError.invalidResponse }
        var grant = previous
        if let refresh = tokens.refresh_token { grant.refreshToken = refresh }
        return (OAuthAccess(token: tokens.access_token, expiresAt: tokens.expires_in.map { now().addingTimeInterval($0) }), grant)
    }
}
