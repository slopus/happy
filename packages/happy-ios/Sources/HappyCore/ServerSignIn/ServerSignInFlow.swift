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
        /// The installation health reported at sign-in, when it was read.
        public var instanceId: String? = nil
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

    /// A Happy Cloud server, whose tokens come from the accounts API
    /// (`CloudAccount.serverToken`) rather than a browser: nothing to
    /// discover first, the method is the cloud's own.
    public static func cloud(_ server: String, http: any HTTPTransport = NoRedirectURLSessionTransport(),
                             makeTransport: @escaping @Sendable (AgentOrigin) -> any AgentTransport = ServerSignInFlow.transport) throws -> ServerSignInFlow {
        let origin = try ServerURL.normalize(server)
        return ServerSignInFlow(origin: origin, method: HappyCloud.method(server: origin.value), tokens: OAuthTokenClient(http: http),
                                discovery: ServerDiscovery(http: http), makeTransport: makeTransport)
    }

    /// The daemon over HTTPS only: a signed-in server never uses Tailcat.
    public static let transport: @Sendable (AgentOrigin) -> any AgentTransport = { AgentHTTPTransport(address: "", port: 0, publicUrl: $0.value, tailcatAvailable: false) }

    /// The authorization request to open in the browser.
    public func request(redirectUri: String) throws -> OAuthSignInRequest {
        try OAuthSignInRequest(method: method, audience: OAuthAudience(origin: origin), redirectUri: redirectUri)
    }

    /// What the server's installation must be after sign-in.
    public enum Installation: Sendable {
        /// Anything: the one already known, or none, is kept.
        case unchecked
        /// Exactly this one (a scanned code's): a code can't send the
        /// person's sign-in to another server.
        case expected(String)
        /// Whatever health reports, kept without a comparison: Happy
        /// Cloud, whose address is the app's own.
        case recorded
    }

    /// Exchanges the redirect's code, then asks the server who signed in
    /// and, as `installation` says, which installation it is.
    public func complete(_ request: OAuthSignInRequest, callback: URL, installation: Installation = .unchecked) async throws -> SignedIn {
        let (access, grant) = try await tokens.complete(request, callback: callback)
        return try await signedIn(access: access, grant: grant, installation: installation)
    }

    /// Tokens for this server however they were issued: asks the server
    /// who signed in and, as `installation` says, which installation it is.
    public func signedIn(access: OAuthAccess, grant: OAuthGrant, installation: Installation) async throws -> SignedIn {
        guard let audience = grant.audience.flatMap(OAuthAudience.init), audience == OAuthAudience(origin: origin), audience.accepts(access.token) else { throw OAuthError.wrongAudience }
        let who = try await discovery.discover(origin, token: access.token)
        guard who.authenticated else { throw ServerSignInError.rejected }
        var signedIn = SignedIn(origin: origin, record: ServerSignInRecord(method: method, grant: grant, userId: who.userId), access: access)
        switch installation {
        case .unchecked: break
        case .expected(let instanceId):
            guard try await health(token: access.token) == instanceId else { throw ServerSignInError.wrongServer }
            signedIn.instanceId = instanceId
        case .recorded:
            signedIn.instanceId = try await health(token: access.token).flatMap { HappyLink.isInstanceID($0) ? $0 : nil }
        }
        return signedIn
    }

    /// The `instanceId` health reports (open to a member still being
    /// onboarded, API.md).
    private func health(token: String) async throws -> String? {
        let transport = makeTransport(origin)
        defer { Task { await transport.close() } }
        let health = try await transport.request("/v0/health", credential: token)
        guard health.status == 200 else { throw SignInRequired.check(health) ? ServerSignInError.rejected : ServerSignInError.unreachable }
        struct Health: Decodable { let instanceId: String? }
        return (try? JSONDecoder().decode(Health.self, from: health.body))?.instanceId
    }

    /// Saves `name` as the person's profile, which makes them a member the
    /// rest of the API lets in (API.md, Profile).
    /// The name the server suggests for a member who hasn't saved a
    /// profile: `GET /v0/profile`'s `name` while it's unsaved (on Happy
    /// Cloud, the account's). Nil when there's none or the read fails.
    public func suggestedName(for signedIn: SignedIn) async -> String? {
        let transport = makeTransport(origin)
        defer { Task { await transport.close() } }
        guard let current = try? await transport.request("/v0/profile", credential: signedIn.access.token), current.status == 200 else { return nil }
        struct Profile: Decodable { struct Body: Decodable { let name: String? }; let profile: Body }
        let name = (try? JSONDecoder().decode(Profile.self, from: current.body))?.profile.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        return name?.isEmpty == false ? name : nil
    }

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
