import Foundation
import HappyWire

/// Adding a team server by its HTTPS address, in the order the screen
/// walks it: discover how it signs people in, open that in the system
/// browser, exchange the code, then make sure the token gets in, saving
/// the person's name first when the server hasn't met them yet. Nothing is
/// stored until `AccountController.addServer` keeps the result.
public struct ServerSignInFlow: Sendable {
    public let origin: AgentOrigin
    public let method: OAuthMethod
    let tokens: OAuthTokenClient
    let discovery: ServerDiscovery
    let makeTransport: @Sendable (AgentOrigin) -> any AgentTransport

    /// The person signed in; `needsProfile` until the server has their name.
    public struct SignedIn: Sendable {
        public let origin: AgentOrigin
        public var record: ServerSignInRecord
        public let access: OAuthAccess
        public var needsProfile: Bool { record.userId == nil }
    }

    init(origin: AgentOrigin, method: OAuthMethod, tokens: OAuthTokenClient, discovery: ServerDiscovery, makeTransport: @escaping @Sendable (AgentOrigin) -> any AgentTransport) {
        self.origin = origin; self.method = method; self.tokens = tokens; self.discovery = discovery; self.makeTransport = makeTransport
    }

    /// Discovers how `address` signs in. The organization's managed
    /// settings decide which servers may be added.
    public static func start(_ address: String, managed: ManagedSettings = .current, http: any HTTPTransport = NoRedirectURLSessionTransport(),
                             makeTransport: @escaping @Sendable (AgentOrigin) -> any AgentTransport = ServerSignInFlow.transport) async throws -> ServerSignInFlow {
        let origin = try ServerURL.normalize(address)
        guard managed.allowsServer(origin) else { throw ServerSignInError.notAllowed }
        let discovery = ServerDiscovery(http: http)
        guard let method = try await discovery.discover(origin).methods.first else { throw ServerSignInError.noSupportedMethod }
        return ServerSignInFlow(origin: origin, method: method, tokens: OAuthTokenClient(http: http), discovery: discovery, makeTransport: makeTransport)
    }

    /// The daemon over HTTPS only: a signed-in server never uses Tailcat.
    public static let transport: @Sendable (AgentOrigin) -> any AgentTransport = { AgentHTTPTransport(address: "", port: 0, publicUrl: $0.value, tailcatAvailable: false) }

    /// The authorization request to open in the browser.
    public func request(redirectUri: String) throws -> OAuthSignInRequest {
        try OAuthSignInRequest(method: method, redirectUri: redirectUri)
    }

    /// Exchanges the redirect's code, then asks the server who signed in.
    public func complete(_ request: OAuthSignInRequest, callback: URL) async throws -> SignedIn {
        let (access, grant) = try await tokens.complete(request, callback: callback)
        let who = try await discovery.discover(origin, token: access.token)
        guard who.authenticated else { throw ServerSignInError.rejected }
        return SignedIn(origin: origin, record: ServerSignInRecord(method: method, grant: grant, userId: who.userId), access: access)
    }

    /// Saves `name` as the person's profile, which makes them a member the
    /// rest of the API lets in (API.md, Profile).
    public func saveProfile(_ name: String, for signedIn: SignedIn) async throws -> SignedIn {
        let transport = makeTransport(origin)
        defer { Task { await transport.close() } }
        let token = signedIn.access.token
        let current = try await transport.request("/v0/profile", credential: token)
        guard current.status == 200 else { throw SignInRequired.check(current) ? ServerSignInError.rejected : AgentClientError.status(current.status, code: nil, message: nil) }
        struct Profile: Decodable { struct Body: Decodable { let version: String? }; let profile: Body }
        let version = (try? JSONDecoder().decode(Profile.self, from: current.body))?.profile.version
        let body = try JSONSerialization.data(withJSONObject: ["name": name, "mutationId": ClientID.make()])
        let saved = try await transport.request("/v0/profile", credential: token, method: "PATCH", body: body, headers: version.map { ["If-Match": $0] } ?? [:])
        guard (200..<300).contains(saved.status) else {
            if SignInRequired.check(saved) { throw ServerSignInError.rejected }
            struct Failure: Decodable { let error: String?; let code: String? }
            let failure = try? JSONDecoder().decode(Failure.self, from: saved.body)
            throw AgentClientError.status(saved.status, code: failure?.code, message: failure?.error)
        }
        let who = try await discovery.discover(origin, token: token)
        guard who.authenticated, who.userId != nil else { throw ServerSignInError.rejected }
        var next = signedIn
        next.record.userId = who.userId
        return next
    }
}
