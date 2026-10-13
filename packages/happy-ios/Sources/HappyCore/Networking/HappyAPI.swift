import Foundation
import HappyWire

public enum APIError: Error, Equatable, Sendable {
    /// No token: the call needs a signed-in account.
    case unauthenticated
    /// The server rejected the token; the account must sign in again.
    case unauthorized
    case http(status: Int, body: String)
    case decoding(String)
}

/// Typed access to the Happy server's HTTP API. Stateless apart from the
/// token, so a signed-in copy is made with `authenticated(token:)`.
public struct HappyAPI: Sendable {
    public let serverURL: URL
    public let clientID: String
    private let transport: HTTPTransport
    private let token: String?

    public init(serverURL: URL, clientID: String, transport: HTTPTransport, token: String? = nil) {
        self.serverURL = serverURL
        self.clientID = clientID
        self.transport = transport
        self.token = token
    }

    public func authenticated(token: String) -> HappyAPI {
        HappyAPI(serverURL: serverURL, clientID: clientID, transport: transport, token: token)
    }

    // MARK: Auth (no token)

    public func authenticate(_ body: AuthRequest) async throws -> AuthResponse {
        try await send("POST", "/v1/auth", body: body, authenticated: false)
    }

    /// Starts or polls a QR login. The same call does both.
    public func requestAccountAuth(publicKey: Data) async throws -> AccountAuthState {
        try await send("POST", "/v1/auth/account/request", body: AccountAuthRequest(publicKey: publicKey.base64EncodedString()), authenticated: false)
    }

    public func terminalAuthStatus(publicKey: Data) async throws -> TerminalAuthStatus {
        try await send("GET", "/v1/auth/request/status", query: [URLQueryItem(name: "publicKey", value: publicKey.base64EncodedString())], authenticated: false)
    }

    // MARK: Auth (signed in)

    public func approveTerminal(publicKey: Data, response: Data) async throws {
        let _: SuccessResponse = try await send("POST", "/v1/auth/response", body: AuthApproval(publicKey: publicKey.base64EncodedString(), response: response.base64EncodedString()))
    }

    public func approveAccountLink(publicKey: Data, response: Data) async throws {
        let _: SuccessResponse = try await send("POST", "/v1/auth/account/response", body: AuthApproval(publicKey: publicKey.base64EncodedString(), response: response.base64EncodedString()))
    }

    // MARK: Sync

    /// `changedSince` is exclusive (`updatedAt > changedSince`).
    public func sessions(changedSince: Int64?, cursor: String?, limit: Int = 100) async throws -> SessionsPage {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let changedSince, changedSince > 0 {
            query.append(URLQueryItem(name: "changedSince", value: String(changedSince)))
        }
        if let cursor {
            query.append(URLQueryItem(name: "cursor", value: cursor))
        }
        return try await send("GET", "/v2/sessions", query: query)
    }

    public func messages(sessionId: String, afterSeq: Int, limit: Int = 100) async throws -> MessagesPage {
        try await send("GET", "/v3/sessions/\(Self.escape(sessionId))/messages", query: [
            URLQueryItem(name: "after_seq", value: String(afterSeq)),
            URLQueryItem(name: "limit", value: String(limit)),
        ])
    }

    public func sendMessages(sessionId: String, _ body: SendMessagesRequest) async throws -> SendMessagesResponse {
        try await send("POST", "/v3/sessions/\(Self.escape(sessionId))/messages", body: body)
    }

    public func machines() async throws -> [APIMachine] {
        try await send("GET", "/v1/machines")
    }

    public func accountSettings() async throws -> AccountSettingsResponse {
        try await send("GET", "/v1/account/settings")
    }

    public func updateAccountSettings(_ body: UpdateAccountSettingsRequest) async throws -> UpdateAccountSettingsResponse {
        try await send("POST", "/v1/account/settings", body: body)
    }

    // MARK: Plumbing

    func makeRequest(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil, authenticated: Bool = true) throws -> HTTPRequest {
        guard var components = URLComponents(url: serverURL.appendingPathComponent(""), resolvingAgainstBaseURL: false) else {
            throw APIError.http(status: 0, body: "bad server URL")
        }
        let basePath = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        components.percentEncodedPath = basePath + path
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw APIError.http(status: 0, body: "bad URL for \(path)") }

        var headers = ["X-Happy-Client": clientID]
        if body != nil {
            headers["Content-Type"] = "application/json"
        }
        if authenticated {
            guard let token else { throw APIError.unauthenticated }
            headers["Authorization"] = "Bearer \(token)"
        }
        return HTTPRequest(method: method, url: url, headers: headers, body: body)
    }

    private func send<Response: Decodable>(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        authenticated: Bool = true
    ) async throws -> Response {
        try await perform(makeRequest(method, path, query: query, authenticated: authenticated))
    }

    private func send<Body: Encodable, Response: Decodable>(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        body: Body,
        authenticated: Bool = true
    ) async throws -> Response {
        let data = try JSONEncoder().encode(body)
        return try await perform(makeRequest(method, path, query: query, body: data, authenticated: authenticated))
    }

    private func perform<Response: Decodable>(_ request: HTTPRequest) async throws -> Response {
        let response = try await transport.send(request)
        switch response.status {
        case 200..<300:
            do {
                return try JSONDecoder().decode(Response.self, from: response.body)
            } catch {
                throw APIError.decoding("\(request.method) \(request.url.path): \(error)")
            }
        case 401:
            throw APIError.unauthorized
        default:
            throw APIError.http(status: response.status, body: String(decoding: response.body.prefix(512), as: UTF8.self))
        }
    }

    private static func escape(_ segment: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return segment.addingPercentEncoding(withAllowedCharacters: allowed) ?? segment
    }
}
