import Foundation
import HappyWire

public enum ServerSignInError: Error, Equatable, Sendable {
    /// Not an `https://` origin.
    case invalidURL
    /// The server couldn't be reached.
    case unreachable
    /// `/v0/authentication` answered 404: no sign-in discovery here.
    case discoveryUnavailable
    /// Something in front of the daemon answered discovery itself: the load
    /// balancer must let `/v0/authentication` through unauthenticated.
    case discoveryBlocked
    /// Discovery listed no sign-in this app supports.
    case noSupportedMethod
    /// The new token didn't sign in to the server.
    case rejected
}

public enum ServerURL {
    /// The origin a person typed, as `https://host[:port]`. A missing scheme
    /// means https; a trailing slash is dropped; anything else in the path,
    /// a query, credentials or plain `http` is refused.
    public static func normalize(_ input: String) throws -> AgentOrigin {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.contains("://") { text = "https://" + text }
        guard var parts = URLComponents(string: text), parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/" else { throw ServerSignInError.invalidURL }
        parts.scheme = "https"
        parts.host = host.lowercased()
        parts.path = ""
        if parts.port == 443 { parts.port = nil }
        guard let value = parts.string, let origin = try? AgentOrigin(value) else { throw ServerSignInError.invalidURL }
        return origin
    }
}

/// `GET /v0/authentication`, the one route a server answers without a token.
public struct ServerDiscovery: Sendable {
    let http: any HTTPTransport

    public init(http: any HTTPTransport = NoRedirectURLSessionTransport()) { self.http = http }

    /// How to sign in to `origin`; with `token`, whether it signs in.
    public func discover(_ origin: AgentOrigin, token: String? = nil) async throws -> AuthenticationDiscovery {
        guard let url = URL(string: origin.value + "/v0/authentication") else { throw ServerSignInError.invalidURL }
        var headers = ["Accept": "application/json"]
        if let token { headers["Authorization"] = "Bearer \(token)" }
        let response: HTTPResponse
        do { response = try await http.send(HTTPRequest(method: "GET", url: url, headers: headers)) }
        catch is CancellationError { throw CancellationError() }
        catch { throw ServerSignInError.unreachable }
        let contentType = response.headers.first { $0.key.lowercased() == "content-type" }?.value
        if response.status == 404, SignInRequired.isHappyError(contentType: contentType, body: response.body) { throw ServerSignInError.discoveryUnavailable }
        if SignInRequired.check(status: response.status, contentType: contentType, body: response.body) {
            throw token == nil ? ServerSignInError.discoveryBlocked : ServerSignInError.rejected
        }
        guard response.status == 200 else { throw response.status == 404 ? ServerSignInError.discoveryBlocked : ServerSignInError.unreachable }
        guard let discovery = try? JSONDecoder().decode(AuthenticationDiscovery.self, from: response.body) else { throw ServerSignInError.discoveryBlocked }
        return discovery
    }
}
