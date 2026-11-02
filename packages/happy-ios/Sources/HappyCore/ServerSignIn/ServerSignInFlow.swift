import Foundation
import HappyWire

/// Adding the team server a scanned code named, or signing in to one
/// again, in the order the screen walks it: discover how it signs people
/// in, open that in the system browser, exchange the code, check the
/// installation, then make sure the token gets in, saving the person's
/// name first when the server hasn't met them yet. Nothing is stored until
/// `AccountController.addServer` keeps the result.
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

    /// Discovers how `address` signs in.
    public static func start(_ address: String, http: any HTTPTransport = NoRedirectURLSessionTransport(),
                             makeTransport: @escaping @Sendable (AgentOrigin) -> any AgentTransport = ServerSignInFlow.transport) async throws -> ServerSignInFlow {
        let origin = try ServerURL.normalize(address)
        let discovery = ServerDiscovery(http: http)
        let methods = try await discovery.discover(origin).methods
        guard !methods.isEmpty else { throw ServerSignInError.noSupportedMethod }
        guard let method = methods.first(where: \.isBoundToItsAuthorizationServer) else { throw OAuthError.crossOrigin }
        return ServerSignInFlow(origin: origin, method: method, tokens: OAuthTokenClient(http: http), discovery: discovery, makeTransport: makeTransport)
    }

    /// The daemon over HTTPS only: a signed-in server never uses Tailcat.
    public static let transport: @Sendable (AgentOrigin) -> any AgentTransport = { AgentHTTPTransport(address: "", port: 0, publicUrl: $0.value, tailcatAvailable: false) }

    /// The authorization request to open in the browser.
    public func request(redirectUri: String) throws -> OAuthSignInRequest {
        try OAuthSignInRequest(method: method, audience: OAuthAudience(origin: origin), redirectUri: redirectUri)
    }

    /// Exchanges the redirect's code, then asks the server who signed in.
    /// With `instanceId` (the installation a scanned code named), the
    /// server's health must report exactly it before anything is kept: a
    /// code can't send the person's sign-in to another server.
    public func complete(_ request: OAuthSignInRequest, callback: URL, instanceId: String? = nil) async throws -> SignedIn {
        let (access, grant) = try await tokens.complete(request, callback: callback)
        let who = try await discovery.discover(origin, token: access.token)
        guard who.authenticated else { throw ServerSignInError.rejected }
        if let instanceId { try await verify(instanceId, token: access.token) }
        return SignedIn(origin: origin, record: ServerSignInRecord(method: method, grant: grant, userId: who.userId), access: access)
    }

    /// Health (open to a member still being onboarded, API.md) must name
    /// `instanceId`.
    private func verify(_ instanceId: String, token: String) async throws {
        let transport = makeTransport(origin)
        defer { Task { await transport.close() } }
        let health = try await transport.request("/v0/health", credential: token)
        guard health.status == 200 else { throw SignInRequired.check(health) ? ServerSignInError.rejected : ServerSignInError.unreachable }
        struct Health: Decodable { let instanceId: String? }
        guard (try? JSONDecoder().decode(Health.self, from: health.body))?.instanceId == instanceId else { throw ServerSignInError.wrongServer }
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
