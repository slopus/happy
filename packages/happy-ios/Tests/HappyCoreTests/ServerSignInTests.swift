import Foundation
import XCTest
import HappyCrypto
import HappyWire
@testable import HappyCore

/// A token endpoint or discovery route the test plays, with headers.
private final class ScriptedHTTP: HTTPTransport, @unchecked Sendable {
    typealias Handler = @Sendable (HTTPRequest) throws -> HTTPResponse
    private let lock = NSLock()
    private var handlers: [String: Handler] = [:]
    private(set) var requests: [HTTPRequest] = []

    func on(_ url: String, _ handler: @escaping Handler) { lock.withLock { handlers[url] = handler } }
    func json(_ url: String, status: Int = 200, _ body: String) {
        on(url) { _ in HTTPResponse(status: status, body: Data(body.utf8), headers: ["Content-Type": "application/json"]) }
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let handler = lock.withLock { () -> Handler? in
            requests.append(request)
            return handlers[request.url.absoluteString]
        }
        guard let handler else { throw URLError(.cannotConnectToHost) }
        return try handler(request)
    }

    func form(_ index: Int) -> [String: String] { formOf(lock.withLock { requests[index] }) }

    func formOf(_ request: HTTPRequest) -> [String: String] {
        let text = String(decoding: request.body ?? Data(), as: UTF8.self)
        var result: [String: String] = [:]
        for pair in text.split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1).map { String($0).removingPercentEncoding ?? "" }
            result[parts[0]] = parts.count > 1 ? parts[1] : ""
        }
        return result
    }
}

private let acme = OAuthMethod(
    id: "jwt", name: "Acme SSO", authorizationUrl: "https://sso.acme.example/oauth/authorize?tenant=7",
    tokenUrl: "https://sso.acme.example/oauth/token", refreshUrl: "https://sso.acme.example/oauth/refresh",
    clientId: "happy", scope: "happy offline_access", resource: "https://happy.acme.example"
)

private func fixed(_ count: Int) -> Data { Data(repeating: 7, count: count) }

/// The server the tests sign in to.
private let server = OAuthAudience("https://happy.acme.example/")!

/// An access token as an authorization server issues one: a JWT whose
/// `aud` names `audience` (a string or an array), unsigned.
func jwt(_ name: String, aud: Any = "https://happy.acme.example/") -> String {
    func encode(_ object: Any) -> String { CanonicalBase64URL.encode(try! JSONSerialization.data(withJSONObject: object)) }
    return encode(["alg": "RS256", "typ": "JWT"]) + "." + encode(["aud": aud, "sub": "steve", "jti": name]) + ".c2lnbmF0dXJl"
}
private let a1 = jwt("a1"), a2 = jwt("a2")

final class OAuthTests: XCTestCase {
    func testAuthorizationURLCarriesPKCEScopeAndResourceAndKeepsItsOwnParameters() throws {
        let request = try OAuthSignInRequest(method: acme, audience: server, redirectUri: "happy://oauth/callback", random: fixed)
        let items = try XCTUnwrap(URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems)
        let query = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(request.url.host, "sso.acme.example")
        XCTAssertEqual(query["tenant"], "7")
        XCTAssertEqual(query["response_type"], "code")
        XCTAssertEqual(query["client_id"], "happy")
        XCTAssertEqual(query["redirect_uri"], "happy://oauth/callback")
        XCTAssertEqual(query["scope"], "happy offline_access")
        XCTAssertEqual(query["resource"], "https://happy.acme.example")
        XCTAssertEqual(query["code_challenge_method"], "S256")
        XCTAssertEqual(query["state"], CanonicalBase64URL.encode(fixed(16)))
        XCTAssertEqual(request.codeVerifier, CanonicalBase64URL.encode(fixed(32)))
        XCTAssertEqual(query["code_challenge"], CanonicalBase64URL.encode(Hashing.sha256(Data(request.codeVerifier.utf8))))
        // RFC 7636: 43–128 characters.
        XCTAssertEqual(request.codeVerifier.count, 43)
    }

    func testNoResourceOrScopeMeansNoParameter() throws {
        var plain = acme
        plain.resource = nil; plain.scope = nil
        let request = try OAuthSignInRequest(method: plain, audience: server, redirectUri: "happy://oauth/callback", random: fixed)
        let names = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems?.map(\.name) ?? []
        XCTAssertFalse(names.contains("resource"))
        XCTAssertFalse(names.contains("scope"))
        XCTAssertFalse(request.exchangeForm(code: "c").contains { $0.0 == "resource" })
    }

    func testInsecureEndpointsAreRefused() {
        for url in ["http://sso.acme.example/authorize", "https://user:pass@sso.acme.example/a", "https://sso.acme.example/a#frag", "ftp://sso.acme.example"] {
            var bad = acme
            bad.authorizationUrl = url
            XCTAssertThrowsError(try OAuthSignInRequest(method: bad, audience: server, redirectUri: "happy://oauth/callback"), url)
        }
        var loopback = acme
        loopback.authorizationUrl = "http://127.0.0.1:8080/authorize"
        loopback.tokenUrl = "http://127.0.0.1:8080/token"
        loopback.refreshUrl = "http://127.0.0.1:8080/token"
        XCTAssertNoThrow(try OAuthSignInRequest(method: loopback, audience: server, redirectUri: "happy://oauth/callback"))
    }

    func testCallbackMustMatchStateAndCarriesErrors() throws {
        let request = try OAuthSignInRequest(method: acme, audience: server, redirectUri: "happy://oauth/callback", random: fixed)
        let state = request.state
        XCTAssertEqual(try request.code(from: URL(string: "happy://oauth/callback?code=abc&state=\(state)")!), "abc")
        XCTAssertThrowsError(try request.code(from: URL(string: "happy://oauth/callback?code=abc&state=other")!)) {
            XCTAssertEqual($0 as? OAuthError, .stateMismatch)
        }
        XCTAssertThrowsError(try request.code(from: URL(string: "happy://oauth/callback?error=access_denied&error_description=No&state=\(state)")!)) {
            XCTAssertEqual($0 as? OAuthError, .server(code: "access_denied", description: "No"))
        }
    }

    func testCodeExchangeAndRefreshSendTheRecordedFormAndKeepAnUnrotatedRefreshToken() async throws {
        let http = ScriptedHTTP()
        http.json(acme.tokenUrl, #"{"access_token":"\#(a1)","token_type":"Bearer","expires_in":300,"refresh_token":"r1"}"#)
        let now = Date(timeIntervalSince1970: 1000)
        let client = OAuthTokenClient(http: http, now: { now })
        let request = try OAuthSignInRequest(method: acme, audience: server, redirectUri: "happy://oauth/callback", random: fixed)
        let (access, grant) = try await client.complete(request, callback: URL(string: "happy://oauth/callback?code=xyz&state=\(request.state)")!)
        XCTAssertEqual(access, OAuthAccess(token: a1, expiresAt: now.addingTimeInterval(300)))
        XCTAssertEqual(grant, OAuthGrant(refreshToken: "r1", refreshUrl: acme.refreshUrl, clientId: "happy", resource: acme.resource, audience: "https://happy.acme.example/"))
        XCTAssertEqual(http.requests[0].headers["Content-Type"], "application/x-www-form-urlencoded")
        XCTAssertEqual(http.form(0), ["grant_type": "authorization_code", "code": "xyz", "redirect_uri": "happy://oauth/callback",
                                      "client_id": "happy", "code_verifier": request.codeVerifier, "resource": "https://happy.acme.example"])

        // Refresh goes to the recorded refresh URL only; no refresh_token
        // in the answer keeps the old one.
        http.json(acme.refreshUrl!, #"{"access_token":"\#(a2)","token_type":"bearer"}"#)
        let (renewed, kept) = try await client.refresh(grant)
        XCTAssertEqual(renewed.token, a2)
        XCTAssertNil(renewed.expiresAt)
        XCTAssertEqual(kept.refreshToken, "r1")
        XCTAssertEqual(http.requests[1].url.absoluteString, acme.refreshUrl)
        XCTAssertEqual(http.form(1), ["grant_type": "refresh_token", "refresh_token": "r1", "client_id": "happy", "resource": "https://happy.acme.example"])
    }

    func testTokenErrorsAreReadAndNonBearerRefused() async throws {
        let http = ScriptedHTTP()
        let client = OAuthTokenClient(http: http)
        let grant = OAuthGrant(refreshToken: "r", refreshUrl: acme.refreshUrl, clientId: "happy", audience: server.server)
        http.json(acme.refreshUrl!, status: 400, #"{"error":"invalid_grant","error_description":"Expired"}"#)
        await XCTAssertThrowsAsync(try await client.refresh(grant)) { XCTAssertEqual($0 as? OAuthError, .server(code: "invalid_grant", description: "Expired")) }
        http.json(acme.refreshUrl!, #"{"access_token":"a","token_type":"mac"}"#)
        await XCTAssertThrowsAsync(try await client.refresh(grant)) { XCTAssertEqual($0 as? OAuthError, .invalidResponse) }
        http.on(acme.refreshUrl!) { _ in HTTPResponse(status: 302, body: Data(), headers: ["Location": "https://elsewhere.example"]) }
        await XCTAssertThrowsAsync(try await client.refresh(grant)) { XCTAssertEqual($0 as? OAuthError, .invalidResponse) }
        await XCTAssertThrowsAsync(try await client.refresh(OAuthGrant(clientId: "happy"))) { XCTAssertEqual($0 as? OAuthError, .refreshUnavailable) }
    }

    func testDiscoverySkipsMethodsItCannotUse() throws {
        let body = #"""
        {"authenticated":false,"userId":null,"methods":[
          {"type":"passkey","id":"p"},
          {"type":"oauth","id":"bad","name":"Bad","authorizationUrl":"http://evil.example/a","tokenUrl":"https://x.example/t","clientId":"c"},
          {"type":"oauth","id":"jwt","name":"Acme SSO","authorizationUrl":"https://sso.acme.example/a","tokenUrl":"https://sso.acme.example/t","clientId":"happy","resource":"https://happy.acme.example"}
        ]}
        """#
        let discovery = try JSONDecoder().decode(AuthenticationDiscovery.self, from: Data(body.utf8))
        XCTAssertEqual(discovery.methods.map(\.id), ["jwt"])
        XCTAssertEqual(discovery.methods.first?.resource, "https://happy.acme.example")
        XCTAssertNil(discovery.userId)
    }

    /// API.md, "Binding a sign-in": the token and refresh URLs are the
    /// authorization URL's origin, compared parsed.
    func testTheTokenAndRefreshURLsMustBeTheAuthorizationServersOrigin() {
        XCTAssertTrue(acme.isBoundToItsAuthorizationServer)
        var spelled = acme
        spelled.tokenUrl = "HTTPS://SSO.Acme.Example:443/oauth/token"
        XCTAssertTrue(spelled.isBoundToItsAuthorizationServer, "default port and case are the same origin")
        for (token, refresh) in [
            ("https://evil.example/token", acme.refreshUrl), (acme.tokenUrl, "https://evil.example/refresh"),
            ("https://sso.acme.example.evil.example/token", acme.refreshUrl), ("https://sso.acme.example:8443/token", acme.refreshUrl),
            ("http://sso.acme.example/token", acme.refreshUrl), ("https://acme.example/token", acme.refreshUrl),
        ] {
            var bad = acme
            bad.tokenUrl = token; bad.refreshUrl = refresh
            XCTAssertFalse(bad.isBoundToItsAuthorizationServer, "\(token) \(refresh ?? "")")
            // Plain http is refused as insecure before its origin is compared.
            XCTAssertThrowsError(try OAuthSignInRequest(method: bad, audience: server, redirectUri: OAuthRedirect.uri)) {
                XCTAssertEqual($0 as? OAuthError, token.hasPrefix("http:") ? .insecureURL : .crossOrigin)
            }
        }
        var noRefresh = acme
        noRefresh.refreshUrl = nil
        XCTAssertTrue(noRefresh.isBoundToItsAuthorizationServer)
        XCTAssertEqual(acme.authorizationHost, "sso.acme.example")
    }

    /// A server whose only method sends the code elsewhere can't be
    /// signed in to; one bound method among others is the one used.
    func testDiscoveryRefusesAMethodBoundToAnotherSite() async throws {
        let http = ScriptedHTTP()
        let url = "https://happy.acme.example/v0/authentication"
        let split = #"{"type":"oauth","id":"split","name":"Acme SSO","authorizationUrl":"https://sso.acme.example/a","tokenUrl":"https://evil.example/t","clientId":"happy"}"#
        let bound = #"{"type":"oauth","id":"jwt","name":"Acme SSO","authorizationUrl":"https://sso.acme.example/a","tokenUrl":"https://sso.acme.example/t","clientId":"happy"}"#
        http.json(url, #"{"authenticated":false,"methods":[\#(split)]}"#)
        await XCTAssertThrowsAsync(try await ServerSignInFlow.start("https://happy.acme.example", http: http)) { XCTAssertEqual($0 as? OAuthError, .crossOrigin) }
        http.json(url, #"{"authenticated":false,"methods":[\#(split),\#(bound)]}"#)
        let flow = try await ServerSignInFlow.start("https://happy.acme.example", http: http)
        XCTAssertEqual(flow.method.id, "jwt")
        XCTAssertEqual(try flow.request(redirectUri: OAuthRedirect.uri).audience.server, "https://happy.acme.example/")
    }

    /// `aud` names the server: its origin and path, a trailing `/` added.
    func testTheAudienceMustNameTheServer() throws {
        XCTAssertTrue(server.accepts(jwt("t")))
        XCTAssertTrue(server.accepts(jwt("t", aud: "https://happy.acme.example")))
        XCTAssertTrue(server.accepts(jwt("t", aud: "HTTPS://Happy.Acme.Example:443/")))
        XCTAssertTrue(server.accepts(jwt("t", aud: ["https://other.example/", "https://happy.acme.example"])))
        XCTAssertFalse(server.accepts(jwt("t", aud: "https://other.example/")))
        XCTAssertFalse(server.accepts(jwt("t", aud: "https://happy.acme.example/api/")))
        XCTAssertFalse(server.accepts(jwt("t", aud: "https://happy.acme.example:8443/")))
        XCTAssertFalse(server.accepts(jwt("t", aud: "happy.acme.example")))
        XCTAssertFalse(server.accepts(jwt("t", aud: ["happy"])))
        XCTAssertFalse(server.accepts(jwt("t", aud: 7)))
        XCTAssertFalse(server.accepts("opaque-token"))
        XCTAssertFalse(server.accepts("a.b.c"))
        let prefixed = try XCTUnwrap(OAuthAudience("https://acme.example/happy/"))
        XCTAssertTrue(prefixed.accepts(jwt("t", aud: "https://acme.example/happy")))
        XCTAssertFalse(prefixed.accepts(jwt("t", aud: "https://acme.example/")), "the origin alone isn't the server")
        XCTAssertFalse(OAuthAudience("https://acme.example/")!.accepts(jwt("t", aud: "https://acme.example/happy/")))
    }

    /// A token for another server is dropped at the code exchange and at
    /// every refresh, with its refresh token; the sign-in then ends.
    func testATokenForAnotherServerIsDropped() async throws {
        let http = ScriptedHTTP()
        let client = OAuthTokenClient(http: http)
        let other = jwt("x", aud: "https://other.example/")
        http.json(acme.tokenUrl, #"{"access_token":"\#(other)","token_type":"Bearer","refresh_token":"stolen"}"#)
        let request = try OAuthSignInRequest(method: acme, audience: server, redirectUri: OAuthRedirect.uri)
        await XCTAssertThrowsAsync(try await client.complete(request, callback: URL(string: "happy://oauth/callback?code=c&state=\(request.state)")!)) {
            XCTAssertEqual($0 as? OAuthError, .wrongAudience)
        }
        http.json(acme.tokenUrl, #"{"access_token":"opaque","token_type":"Bearer"}"#)
        await XCTAssertThrowsAsync(try await client.complete(request, callback: URL(string: "happy://oauth/callback?code=c&state=\(request.state)")!)) {
            XCTAssertEqual($0 as? OAuthError, .wrongAudience, "not a JWT")
        }

        http.json(acme.refreshUrl!, #"{"access_token":"\#(other)","token_type":"Bearer","refresh_token":"r2"}"#)
        let saved = SavedGrants()
        let authorization = ServerAuthorization(grant: OAuthGrant(refreshToken: "r1", refreshUrl: acme.refreshUrl, clientId: "happy", audience: server.server),
                                                tokens: client) { await saved.add($0) }
        await XCTAssertThrowsAsync(try await authorization.bearer()) { XCTAssertEqual($0 as? OAuthError, .wrongAudience) }
        let state = await authorization.state
        XCTAssertEqual(state, .needsSignIn)
        let grants = await saved.grants
        XCTAssertTrue(grants.isEmpty, "the rotated refresh token wasn't kept")
        // A grant with no server to check against isn't refreshed at all.
        XCTAssertFalse(OAuthGrant(refreshToken: "r", refreshUrl: acme.refreshUrl, clientId: "happy").canRefresh)
    }

    func testOneRedirectURIAndOnlyItIsTheCallback() {
        XCTAssertEqual(OAuthRedirect.uri, "happy://oauth/callback")
        XCTAssertTrue(OAuthRedirect.isCallback(URL(string: "happy://oauth/callback?code=c&state=s")!))
        XCTAssertFalse(OAuthRedirect.isCallback(URL(string: "happy://terminal?abc")!))
        XCTAssertFalse(OAuthRedirect.isCallback(URL(string: "happy://direct?x")!))
        XCTAssertEqual(HappyCode("happy://oauth/callback?code=c&state=s"), .notHappy)
    }
}

final class SignInRequiredTests: XCTestCase {
    private let happy = Data(#"{"error":"Forbidden","code":"forbidden"}"#.utf8)

    func testTheContractsRule() {
        XCTAssertTrue(SignInRequired.check(status: 302, contentType: nil, body: Data()))
        XCTAssertFalse(SignInRequired.check(status: 304, contentType: nil, body: Data()), "304 Not Modified is not a redirect")
        XCTAssertTrue(SignInRequired.check(status: 307, contentType: "application/json", body: happy))
        XCTAssertTrue(SignInRequired.check(status: 401, contentType: "application/json", body: happy))
        XCTAssertTrue(SignInRequired.check(status: 403, contentType: "text/html", body: Data("<html>".utf8)))
        XCTAssertTrue(SignInRequired.check(status: 403, contentType: "application/json", body: Data(#"{"message":"denied"}"#.utf8)))
        XCTAssertFalse(SignInRequired.check(status: 403, contentType: "application/json; charset=utf-8", body: happy))
        XCTAssertFalse(SignInRequired.check(status: 404, contentType: "text/html", body: Data()))
        XCTAssertFalse(SignInRequired.check(status: 200, contentType: nil, body: Data()))
    }

    func testServerURLNormalization() throws {
        XCTAssertEqual(try ServerURL.normalize("happy.acme.example").value, "https://happy.acme.example")
        XCTAssertEqual(try ServerURL.normalize(" https://Happy.Acme.Example/ ").value, "https://happy.acme.example")
        XCTAssertEqual(try ServerURL.normalize("https://happy.acme.example:443").value, "https://happy.acme.example")
        XCTAssertEqual(try ServerURL.normalize("https://happy.acme.example:8443").value, "https://happy.acme.example:8443")
        for bad in ["http://happy.acme.example", "https://happy.acme.example/api", "https://a@happy.acme.example", "https://happy.acme.example?x=1", ""] {
            XCTAssertThrowsError(try ServerURL.normalize(bad), bad)
        }
    }

    func testDiscoveryTellsTheDaemonFromTheEdge() async throws {
        let http = ScriptedHTTP()
        let origin = try ServerURL.normalize("https://happy.acme.example")
        let discovery = ServerDiscovery(http: http)
        let url = "https://happy.acme.example/v0/authentication"
        http.on(url) { _ in HTTPResponse(status: 302, body: Data(), headers: ["Location": "https://idp.example/login"]) }
        await XCTAssertThrowsAsync(try await discovery.discover(origin)) { XCTAssertEqual($0 as? ServerSignInError, .discoveryBlocked) }
        http.json(url, status: 404, #"{"error":"Not found","code":"not_found"}"#)
        await XCTAssertThrowsAsync(try await discovery.discover(origin)) { XCTAssertEqual($0 as? ServerSignInError, .discoveryUnavailable) }
        http.json(url, #"{"authenticated":true,"userId":"u1","methods":[]}"#)
        let who = try await discovery.discover(origin, token: "t")
        XCTAssertEqual(who.userId, "u1")
        XCTAssertEqual(http.requests.last?.headers["Authorization"], "Bearer t")
        XCTAssertFalse(http.requests.contains { $0.url.query?.contains("t") == true })
    }

    /// A scanned code's installation must be the server's, read from
    /// health with the new token (the edge blocks it before): another one,
    /// or none, keeps nothing.
    func testAScannedCodesInstallationIsCheckedAfterSignIn() async throws {
        let http = ScriptedHTTP()
        http.json(acme.tokenUrl, #"{"access_token":"\#(a1)","token_type":"Bearer","refresh_token":"r1"}"#)
        http.json("https://happy.acme.example/v0/authentication", #"{"authenticated":true,"userId":null,"methods":[]}"#)
        let daemon = Daemon()
        let flow = ServerSignInFlow(origin: try ServerURL.normalize("https://happy.acme.example"), method: acme, tokens: OAuthTokenClient(http: http),
                                    discovery: ServerDiscovery(http: http), makeTransport: { _ in daemon })
        let instance = "k3x9q2m7p0a4b8c1d5e6f7g2"
        func signIn(_ instanceId: String?) async throws -> ServerSignInFlow.SignedIn {
            let request = try flow.request(redirectUri: "happy://oauth/callback")
            return try await flow.complete(request, callback: URL(string: "happy://oauth/callback?code=xyz&state=\(request.state)")!, installation: instanceId.map { .expected($0) } ?? .unchecked)
        }
        func health(_ body: String) async { await daemon.answer("/v0/health", HTTP1Response(status: 200, body: Data(body.utf8))) }

        await health(#"{"ready":true,"instanceId":"\#(instance)"}"#)
        let signedIn = try await signIn(instance)
        XCTAssertEqual(signedIn.record.grant.refreshToken, "r1")
        XCTAssertEqual(signedIn.instanceId, instance)
        let checked = await daemon.seen
        XCTAssertEqual(checked.map(\.path), ["/v0/health"])
        XCTAssertEqual(checked.map(\.credential), [a1])

        await XCTAssertThrowsAsync(try await signIn("zzzzzzzzzzzzzzzzzzzzzzzz")) { XCTAssertEqual($0 as? ServerSignInError, .wrongServer) }
        await health(#"{"ready":true}"#)
        await XCTAssertThrowsAsync(try await signIn(instance)) { XCTAssertEqual($0 as? ServerSignInError, .wrongServer) }
        // The edge refusing the new token is a refused sign-in.
        await daemon.answer("/v0/health", HTTP1Response(status: 302, headers: ["location": "https://idp.example/login"]))
        await XCTAssertThrowsAsync(try await signIn(instance)) { XCTAssertEqual($0 as? ServerSignInError, .rejected) }
        // Signing in again to a server that never reported one asks nothing.
        let before = await daemon.seen.count
        _ = try await signIn(nil)
        let after = await daemon.seen.count
        XCTAssertEqual(after, before)
    }

    /// A Happy Cloud server has no code to compare with: whatever installation
    /// health reports is kept, and one that reports none still signs in.
    func testHappyCloudRecordsItsInstallationWithoutComparing() async throws {
        let http = ScriptedHTTP()
        http.json(acme.tokenUrl, #"{"access_token":"\#(a1)","token_type":"Bearer","refresh_token":"r1"}"#)
        http.json("https://happy.acme.example/v0/authentication", #"{"authenticated":true,"userId":"u1","methods":[]}"#)
        let daemon = Daemon()
        let flow = ServerSignInFlow(origin: try ServerURL.normalize("https://happy.acme.example"), method: acme, tokens: OAuthTokenClient(http: http),
                                    discovery: ServerDiscovery(http: http), makeTransport: { _ in daemon })
        func signIn() async throws -> ServerSignInFlow.SignedIn {
            let request = try flow.request(redirectUri: "happy://oauth/callback")
            return try await flow.complete(request, callback: URL(string: "happy://oauth/callback?code=xyz&state=\(request.state)")!, installation: .recorded)
        }
        await daemon.answer("/v0/health", HTTP1Response(status: 200, body: Data(#"{"ready":true,"instanceId":"c0ud9q2m7p0a4b8c1d5e6f7g"}"#.utf8)))
        let first = try await signIn()
        XCTAssertEqual(first.instanceId, "c0ud9q2m7p0a4b8c1d5e6f7g")
        await daemon.answer("/v0/health", HTTP1Response(status: 200, body: Data(#"{"ready":true}"#.utf8)))
        let second = try await signIn()
        XCTAssertNil(second.instanceId)
        XCTAssertEqual(second.record.userId, "u1")
    }

    /// A cloud member with no profile yet (`userId` null) is asked their
    /// name, offered the one the server suggests while it's unsaved, and
    /// is a member once it's saved. Nothing is saved for them.
    func testANamelessCloudMemberIsOfferedTheSuggestionAndSavesTheirName() async throws {
        let server = HappyCloud.server(named: "acme")
        let http = ScriptedHTTP()
        let saved = NSLock()
        nonisolated(unsafe) var asked = 0
        http.on(server + "/v0/authentication") { _ in
            let userId = saved.withLock { asked += 1; return asked > 1 ? #""u1""# : "null" }
            return HTTPResponse(status: 200, body: Data(#"{"authenticated":true,"userId":\#(userId),"methods":[]}"#.utf8), headers: ["Content-Type": "application/json"])
        }
        let daemon = Daemon()
        await daemon.answer("/v0/health", HTTP1Response(status: 200, body: Data(#"{"ready":true}"#.utf8)))
        await daemon.answer("/v0/profile", HTTP1Response(status: 200, body: Data(#"{"profile":{"name":" Steve K ","email":"s@example.com","updatedAt":0,"version":"v0"}}"#.utf8)))
        let flow = try ServerSignInFlow.cloud(server, http: http, makeTransport: { _ in daemon })
        let grant = OAuthGrant(refreshToken: "sr1", refreshUrl: HappyCloud.accounts + "/token", clientId: "happy", resource: server + "/", audience: server + "/")
        let signedIn = try await flow.signedIn(access: OAuthAccess(token: jwt("srv", aud: server + "/"), expiresAt: nil), grant: grant, installation: .recorded)
        XCTAssertTrue(signedIn.needsProfile)
        let suggested = await flow.suggestedName(for: signedIn)
        XCTAssertEqual(suggested, "Steve K")
        let member = try await flow.saveProfile("Steve", for: signedIn)
        XCTAssertFalse(member.needsProfile)
        XCTAssertEqual(member.record.userId, "u1")
        await daemon.answer("/v0/profile", HTTP1Response(status: 200, body: Data(#"{"profile":{"name":null,"updatedAt":0,"version":"v0"}}"#.utf8)))
        let none = await flow.suggestedName(for: signedIn)
        XCTAssertNil(none, "no suggestion, an empty field")
    }

    func testHappyCloudServersAreNamedUnderTheBase() throws {
        let acme = HappyCloud.server(named: "acme")
        XCTAssertEqual(acme, "https://acme.\(HappyCloud.base)")
        XCTAssertEqual(try ServerURL.normalize(acme).value, acme)
        XCTAssertEqual(HappyCloud.serverName(acme), "acme")
        XCTAssertEqual(HappyCloud.handle(server: acme), "@acme")
        XCTAssertNil(HappyCloud.handle(server: "https://happy.acme.example"))
        XCTAssertNil(HappyCloud.serverName("https://happy.acme.example"))
        XCTAssertNil(HappyCloud.serverName(HappyCloud.accounts))
        for bad in ["ab", "-acme", "acme-", "Acme", "ac_me", "api", "accounts", String(repeating: "a", count: 33)] { XCTAssertFalse(HappyCloud.isValidName(bad), bad) }
        for good in ["abc", "acme-2", String(repeating: "a", count: 32)] { XCTAssertTrue(HappyCloud.isValidName(good), good) }
        // The address comes from the name and the app's base, never the listed URL.
        XCTAssertEqual(CloudServer(id: "s1", name: "acme", url: "https://evil.example/", role: .owner).origin, acme)
        XCTAssertNil(CloudServer(id: "s1", name: "evil.example", url: "https://evil.example/", role: .owner).origin)
        var cloud = AgentConnection(id: "server-1", name: "acme")
        cloud.server = acme
        XCTAssertEqual(HappyCloud.connection(to: acme, in: [cloud])?.id, "server-1")
        XCTAssertNil(HappyCloud.connection(to: HappyCloud.server(named: "other"), in: [cloud]))
        XCTAssertEqual(AppVariant.allCases.filter(HappyCloud.isOffered), [.development, .preview])
    }

    /// The account signs in at the accounts origin for itself and gets a
    /// one-hour pass: no refresh token, nothing kept. Its API calls carry
    /// the pass; a 401 or the hour ending means signing in again, never a
    /// refresh. Each server's token comes from the accounts API, for that
    /// server, and refreshes at the token endpoint without the account.
    func testHappyCloudAccountIsAnHourPassThatMintsServerTokens() async throws {
        let accounts = HappyCloud.accounts
        XCTAssertEqual(accounts, "https://auth.happy.engineering")
        let pass = jwt("acc1", aud: accounts + "/")
        let http = ScriptedHTTP()
        let clock = Clock()
        let now: @Sendable () -> Date = { clock.now }
        http.json(accounts + "/token", #"{"access_token":"\#(pass)","token_type":"Bearer","expires_in":3600}"#)
        let request = try CloudAccount.request()
        let query = URLComponents(url: request.url, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(request.url.absoluteString.components(separatedBy: "?").first, accounts + "/authorize")
        XCTAssertEqual(query.first { $0.name == "resource" }?.value, accounts + "/")
        XCTAssertEqual(query.first { $0.name == "client_id" }?.value, "happy")
        XCTAssertEqual(query.first { $0.name == "code_challenge_method" }?.value, "S256")
        XCTAssertNil(query.first { $0.name == "provider" })
        // GitHub straight away: the same request, with the chooser skipped.
        let github = try CloudAccount.request(provider: "github")
        let githubQuery = URLComponents(url: github.url, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(github.url.absoluteString.components(separatedBy: "?").first, accounts + "/authorize")
        XCTAssertEqual(githubQuery.first { $0.name == "provider" }?.value, "github")
        XCTAssertEqual(githubQuery.first { $0.name == "state" }?.value, github.state)
        XCTAssertEqual(Set(githubQuery.map(\.name)), Set(query.map(\.name)).union(["provider"]))
        XCTAssertEqual(github.method.tokenUrl, accounts + "/token")
        let account = try await CloudAccount.signIn(request, callback: URL(string: "happy://oauth/callback?code=c&state=\(request.state)")!, http: http, now: now)
        XCTAssertTrue(account.isLive(at: clock.now))

        http.json(accounts + "/v1/servers", #"{"servers":[{"id":"s1","name":"acme","url":"https://acme.example/","role":"owner","createdAt":1}]}"#)
        let servers = try await account.servers()
        XCTAssertEqual(servers, [CloudServer(id: "s1", name: "acme", url: "https://acme.example/", role: .owner)])

        // A viewer, an admin and a team's own role read as theirs; none loses the server.
        http.json(accounts + "/v1/servers", #"{"servers":[{"id":"s1","name":"acme","url":"","role":"viewer"},{"id":"s2","name":"beta","url":"","role":"admin"},{"id":"s3","name":"gamma","url":"","role":"reviewers"}]}"#)
        let roles = try await account.servers().map(\.role)
        XCTAssertEqual(roles, [.viewer, .admin, .other("reviewers")])
        XCTAssertEqual(http.requests.last?.headers["Authorization"], "Bearer \(pass)")

        http.json(accounts + "/v1/servers/join", status: 404, #"{"code":"not_found","error":"No such server."}"#)
        await XCTAssertThrowsAsync(try await account.join("acme", code: "nope")) {
            XCTAssertEqual($0 as? CloudAccountError, .refused(status: 404, code: "not_found", message: "No such server."))
        }
        http.json(accounts + "/v1/servers/availability?name=acme", #"{"name":"acme","available":false,"reason":"taken"}"#)
        let taken = try await account.availability("acme")
        XCTAssertEqual(taken, .taken)
        // v1.1: the server's own name and picture; its bytes come from the accounts origin only.
        http.json(accounts + "/v1/servers", #"{"servers":[{"id":"s2","name":"acme","url":"https://acme.example/","role":"member","displayName":"Acme Corp","image":{"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI","width":64,"height":64,"url":"\#(accounts)/v1/servers/s2/image?v=abc"}}]}"#)
        let pictured = try await account.servers()
        XCTAssertEqual(pictured.first?.title, "Acme Corp")
        http.json(accounts + "/v1/servers/s2/image?v=abc", "x")
        let bytes = try await account.image(pictured[0].image!)
        XCTAssertEqual(bytes, Data("x".utf8))
        let before = http.requests.count
        await XCTAssertThrowsAsync(try await account.image(.init(thumbhash: nil, width: nil, height: nil, url: "https://evil.example/x.png"))) { _ in }
        XCTAssertEqual(http.requests.count, before)
        XCTAssertEqual(CloudServer(id: "s1", name: "acme", url: "", role: nil, displayName: "").title, "acme")

        // A server's token: for that server, with its refresh token, which
        // goes to the token endpoint for the server, not the account.
        let server = HappyCloud.server(named: "acme")
        let serverToken = jwt("srv1", aud: [server + "/", "https://api.\(HappyCloud.base)/"])
        http.json(accounts + "/v1/servers/s2/token", #"{"access_token":"\#(serverToken)","refresh_token":"sr1","expires_in":900}"#)
        let (access, grant) = try await account.serverToken(for: pictured[0])
        XCTAssertEqual(access.token, serverToken)
        XCTAssertEqual(http.requests.last?.method, "POST")
        XCTAssertEqual(http.requests.last?.headers["Authorization"], "Bearer \(pass)")
        XCTAssertEqual(grant, OAuthGrant(refreshToken: "sr1", refreshUrl: accounts + "/token", clientId: "happy", resource: server + "/", audience: server + "/"))
        let refreshed = jwt("srv2", aud: server + "/")
        http.json(accounts + "/token", #"{"access_token":"\#(refreshed)","token_type":"Bearer","refresh_token":"sr2"}"#)
        let (next, rotated) = try await OAuthTokenClient(http: http).refresh(grant)
        XCTAssertEqual(next.token, refreshed)
        XCTAssertEqual(rotated.refreshToken, "sr2")
        XCTAssertEqual(http.form(http.requests.count - 1), ["grant_type": "refresh_token", "refresh_token": "sr1", "client_id": "happy", "resource": server + "/"])
        XCTAssertNil(http.requests.last?.headers["Authorization"])
        // A token for another server is refused before it's kept.
        http.json(accounts + "/v1/servers/s2/token", #"{"access_token":"\#(jwt("x", aud: "https://other.example/"))","refresh_token":"stolen"}"#)
        await XCTAssertThrowsAsync(try await account.serverToken(for: pictured[0])) { XCTAssertEqual($0 as? OAuthError, .wrongAudience) }

        // A 401 ends the pass: no refresh is tried.
        let calls = http.requests.count
        http.json(accounts + "/v1/servers", status: 401, #"{"code":"unauthorized","error":"A valid account token is required."}"#)
        await XCTAssertThrowsAsync(try await account.servers()) { XCTAssertEqual($0 as? CloudAccountError, .signInRequired) }
        XCTAssertEqual(http.requests.count, calls + 1)
        // So does the hour: nothing is sent.
        http.json(accounts + "/v1/servers", #"{"servers":[]}"#)
        clock.now = clock.now.addingTimeInterval(3600)
        XCTAssertFalse(account.isLive(at: clock.now))
        await XCTAssertThrowsAsync(try await account.servers()) { XCTAssertEqual($0 as? CloudAccountError, .signInRequired) }
        XCTAssertEqual(http.requests.count, calls + 1)
        XCTAssertFalse(http.requests.contains { $0.url.absoluteString == accounts + "/token" && http.formOf($0)["grant_type"] == "refresh_token" && http.formOf($0)["resource"] == accounts + "/" })
    }

    /// Sign in with Apple: the identity token, the raw nonce and the name
    /// go to the accounts service, which answers with a pass for itself; a
    /// refused identity token is a failure, not an ended pass.
    func testHappyCloudSignsInWithApple() async throws {
        let accounts = HappyCloud.accounts
        let http = ScriptedHTTP()
        let pass = jwt("acc1", aud: accounts + "/")
        http.on(accounts + "/v1/auth/native") { request in
            let body = try JSONSerialization.jsonObject(with: request.body ?? Data()) as? [String: String]
            XCTAssertEqual(body, ["provider": "apple", "idToken": "id.token.x", "nonce": "raw", "authorizationCode": "code", "name": "Steve K"])
            return HTTPResponse(status: 200, body: Data(#"{"access_token":"\#(pass)","expires_in":3600}"#.utf8))
        }
        let account = try await CloudAccount.signIn(provider: "apple", idToken: "id.token.x", nonce: "raw", authorizationCode: "code", name: "Steve K", http: http)
        XCTAssertTrue(account.isLive())
        http.json(accounts + "/v1/auth/native", status: 401, #"{"code":"invalid_token","error":"That sign-in could not be verified."}"#)
        await XCTAssertThrowsAsync(try await CloudAccount.signIn(provider: "apple", idToken: "bad", nonce: "raw", authorizationCode: nil, name: nil, http: http)) {
            XCTAssertEqual($0 as? CloudAccountError, .refused(status: 401, code: "invalid_token", message: "That sign-in could not be verified."))
        }
        // A pass for anything else is refused.
        http.json(accounts + "/v1/auth/native", #"{"access_token":"\#(jwt("x", aud: "https://acme.example/"))"}"#)
        await XCTAssertThrowsAsync(try await CloudAccount.signIn(provider: "apple", idToken: "id", nonce: "raw", authorizationCode: nil, name: nil, http: http)) {
            XCTAssertEqual($0 as? OAuthError, .wrongAudience)
        }
        // Earlier builds' kept account grant is forgotten.
        let keychain = FakeKeychain()
        let item = KeychainItemQuery(service: "happy-ios:cloud-account", account: Data("account".utf8), generic: Data("account".utf8))
        _ = try keychain.add(item, data: Data("{}".utf8), accessibility: .afterFirstUnlockThisDeviceOnly)
        CloudAccount.forgetKeptGrant(backend: keychain)
        XCTAssertNil(keychain.stored(item))
    }

    /// A test account signs in with its login and password and gets the
    /// same one-hour pass; a wrong password and a lockout say which.
    func testHappyCloudTestAccountSignsInWithAPassword() async throws {
        let accounts = HappyCloud.accounts
        let http = ScriptedHTTP()
        let pass = jwt("acc-qa", aud: accounts + "/")
        http.on(accounts + "/v1/auth/password") { request in
            XCTAssertEqual(request.method, "POST")
            XCTAssertNil(request.headers["Authorization"])
            let body = try JSONSerialization.jsonObject(with: request.body ?? Data()) as? [String: String]
            XCTAssertEqual(body, ["login": "qa-ios", "password": "pw"])
            return HTTPResponse(status: 200, body: Data(#"{"access_token":"\#(pass)","token_type":"Bearer","expires_in":3600}"#.utf8))
        }
        let account = try await CloudAccount.signIn(login: "qa-ios", password: "pw", http: http)
        XCTAssertTrue(account.isLive())
        XCTAssertEqual(account.expiresAt.timeIntervalSinceNow, 3600, accuracy: 5)

        http.json(accounts + "/v1/auth/password", status: 401, #"{"code":"invalid_credentials"}"#)
        await XCTAssertThrowsAsync(try await CloudAccount.signIn(login: "qa-ios", password: "no", http: http)) {
            XCTAssertEqual($0 as? CloudAccountError, .refused(status: 401, code: "invalid_credentials", message: nil))
        }
        http.json(accounts + "/v1/auth/password", status: 429, #"{"code":"locked","retryAfter":840}"#)
        await XCTAssertThrowsAsync(try await CloudAccount.signIn(login: "qa-ios", password: "no", http: http)) {
            XCTAssertEqual($0 as? CloudAccountError, .locked(retryAfter: 840))
        }
    }

    /// Removing a cloud server revokes its refresh token's family at the
    /// accounts service; a grant without one sends nothing.
    func testHappyCloudRevokesARemovedServersSession() async throws {
        let http = ScriptedHTTP()
        http.json(HappyCloud.accounts + "/revoke", "{}")
        let server = HappyCloud.server(named: "acme") + "/"
        await CloudAccount.revoke(OAuthGrant(refreshToken: "sr9", refreshUrl: HappyCloud.accounts + "/token", clientId: "happy", resource: server, audience: server), http: http)
        XCTAssertEqual(http.requests.count, 1)
        XCTAssertEqual(http.requests[0].method, "POST")
        XCTAssertNil(http.requests[0].headers["Authorization"])
        XCTAssertEqual(http.form(0), ["token": "sr9", "client_id": "happy"])
        await CloudAccount.revoke(OAuthGrant(clientId: "happy", audience: server), http: http)
        XCTAssertEqual(http.requests.count, 1)
    }

    /// A cloud server signs in from tokens the accounts API issued, for it
    /// only, then reads who signed in and its installation.
    func testHappyCloudServerSignsInFromIssuedTokens() async throws {
        let server = HappyCloud.server(named: "acme")
        let http = ScriptedHTTP()
        http.json(server + "/v0/authentication", #"{"authenticated":true,"userId":"u1","methods":[]}"#)
        let daemon = Daemon()
        await daemon.answer("/v0/health", HTTP1Response(status: 200, body: Data(#"{"ready":true,"instanceId":"c0ud9q2m7p0a4b8c1d5e6f7g"}"#.utf8)))
        let flow = try ServerSignInFlow.cloud(server, http: http, makeTransport: { _ in daemon })
        XCTAssertEqual(flow.method.tokenUrl, HappyCloud.accounts + "/token")
        XCTAssertEqual(flow.method.resource, server + "/")
        let token = jwt("srv", aud: server + "/")
        let grant = OAuthGrant(refreshToken: "sr1", refreshUrl: HappyCloud.accounts + "/token", clientId: "happy", resource: server + "/", audience: server + "/")
        let signedIn = try await flow.signedIn(access: OAuthAccess(token: token, expiresAt: nil), grant: grant, installation: .recorded)
        XCTAssertEqual(signedIn.record.userId, "u1")
        XCTAssertEqual(signedIn.record.grant, grant)
        XCTAssertEqual(signedIn.instanceId, "c0ud9q2m7p0a4b8c1d5e6f7g")
        let other = HappyCloud.server(named: "other")
        var foreign = grant
        foreign.audience = other + "/"
        await XCTAssertThrowsAsync(try await flow.signedIn(access: OAuthAccess(token: jwt("srv", aud: other + "/"), expiresAt: nil), grant: foreign, installation: .recorded)) {
            XCTAssertEqual($0 as? OAuthError, .wrongAudience)
        }
    }
}

/// A clock the test moves.
private final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Date(timeIntervalSince1970: 1_800_000_000)
    var now: Date {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}

/// The access token each request carried, and what the daemon answers.
private actor Daemon: AgentTransport {
    var answers: [String: [HTTP1Response]] = [:]
    var seen: [(path: String, credential: String)] = []
    func answer(_ path: String, _ responses: HTTP1Response...) { answers[path] = responses }
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        seen.append((path, credential))
        guard var queue = answers[path], !queue.isEmpty else { return HTTP1Response(status: 200, body: Data("{}".utf8)) }
        let next = queue.removeFirst()
        answers[path] = queue.isEmpty ? [next] : queue
        return next
    }
    func browserConnection() async throws -> any BrowserStream { throw BrowserError.unavailable }
    func close() async {}
    var credentials: [String] { seen.map(\.credential) }
}

private let json = ["content-type": "application/json"]

/// What discovery says about a token, as the profile-gate rule asks it.
private actor Who {
    var answer = AuthenticationDiscovery(authenticated: false, userId: nil, methods: [])
    var asked: [String] = []
    func set(_ value: AuthenticationDiscovery) { answer = value }
    func discover(_ token: String) -> AuthenticationDiscovery { asked.append(token); return answer }
}

final class SignedInTransportTests: XCTestCase {
    private let who = Who()

    private func signed(_ base: any AgentTransport, _ authorization: ServerAuthorization, cloud: Bool = false) -> SignedInTransport {
        SignedInTransport(base: base, authorization: authorization, cloud: cloud) { [who] in await who.discover($0) }
    }

    private func authorization(_ http: ScriptedHTTP, access: OAuthAccess? = OAuthAccess(token: "a1", expiresAt: nil), saved: SavedGrants = SavedGrants()) -> ServerAuthorization {
        ServerAuthorization(grant: OAuthGrant(refreshToken: "r1", refreshUrl: acme.refreshUrl, clientId: "happy", resource: acme.resource, audience: server.server),
                            access: access, tokens: OAuthTokenClient(http: http)) { await saved.add($0) }
    }

    func testCredentialIsTheAccessTokenAndA401RefreshesOnceAndRepeats() async throws {
        let http = ScriptedHTTP()
        http.json(acme.refreshUrl!, #"{"access_token":"\#(a2)","token_type":"Bearer","refresh_token":"r2"}"#)
        let saved = SavedGrants()
        let daemon = Daemon()
        await daemon.answer("/v0/bots", HTTP1Response(status: 401, headers: json, body: Data(#"{"error":"Unauthorized","code":"unauthorized"}"#.utf8)),
                            HTTP1Response(status: 200, body: Data("{}".utf8)))
        let transport = signed(daemon, authorization(http, saved: saved))
        let response = try await transport.request(method: "GET", path: "/v0/bots", credential: "", body: nil, headers: [:])
        XCTAssertEqual(response.status, 200)
        let credentials = await daemon.credentials
        XCTAssertEqual(credentials, ["a1", a2])
        let grants = await saved.grants
        XCTAssertEqual(grants.map(\.refreshToken), ["r2"])
        let state = await transport.authorization.state
        XCTAssertEqual(state, .signedIn)
        let asked = await who.asked
        XCTAssertEqual(asked, ["a1"], "the daemon's 401 was checked with discovery first")
    }

    func testTheProfileGateAndATransient401() async throws {
        let http = ScriptedHTTP()
        let daemon = Daemon()
        let gate = HTTP1Response(status: 401, headers: json, body: Data(#"{"error":"Unauthorized","code":"unauthorized"}"#.utf8))
        await daemon.answer("/v0/bots", gate, HTTP1Response(status: 200, body: Data("{}".utf8)))
        // Signed in as a known member: transient, repeated once with the same token.
        await who.set(AuthenticationDiscovery(authenticated: true, userId: "steve", methods: []))
        let auth = authorization(http)
        let transport = signed(daemon, auth)
        let response = try await transport.request(method: "GET", path: "/v0/bots", credential: "", body: nil, headers: [:])
        XCTAssertEqual(response.status, 200)
        let credentials = await daemon.credentials
        XCTAssertEqual(credentials, ["a1", "a1"])
        XCTAssertTrue(http.requests.isEmpty, "nothing was refreshed")
        // No profile yet (a cluster before `profile_required`): the name
        // step, never a sign-out. Callers see Happy's 403 profile_required.
        await daemon.answer("/v0/config", gate)
        await who.set(AuthenticationDiscovery(authenticated: true, userId: nil, methods: []))
        let gated = try await transport.request(method: "GET", path: "/v0/config", credential: "", body: nil, headers: [:])
        XCTAssertEqual(gated.status, 403)
        XCTAssertTrue(String(decoding: gated.body, as: UTF8.self).contains(#""code":"profile_required""#))
        let state = await auth.state
        XCTAssertEqual(state, .signedIn, "a member with no profile was signed out")
        XCTAssertTrue(http.requests.isEmpty)
    }

    /// The cluster's own answer for a member with no profile passes through.
    func testProfileRequiredIsAnOrdinaryRefusal() async throws {
        let http = ScriptedHTTP()
        let daemon = Daemon()
        await daemon.answer("/v0/bots", HTTP1Response(status: 403, headers: json, body: Data(#"{"error":"Name needed","code":"profile_required"}"#.utf8)))
        let auth = authorization(http)
        for cloud in [false, true] {
            let response = try await signed(daemon, auth, cloud: cloud).request(method: "GET", path: "/v0/bots", credential: "", body: nil, headers: [:])
            XCTAssertEqual(response.status, 403)
        }
        let state = await auth.state
        XCTAssertEqual(state, .signedIn)
    }

    /// Happy Cloud's edge enforces no SSO: its odd answer is a deploy or the
    /// network. Refreshed and repeated once; still odd, unavailable, never
    /// a sign-out.
    func testOnHappyCloudTheEdgeNeverSignsOut() async throws {
        for edge in [HTTP1Response(status: 302, headers: ["location": "https://elsewhere.example"]),
                     HTTP1Response(status: 401, headers: ["content-type": "text/html"], body: Data("<html>".utf8)),
                     HTTP1Response(status: 403, headers: ["content-type": "text/plain"], body: Data("denied".utf8))] {
            let http = ScriptedHTTP()
            http.json(acme.refreshUrl!, #"{"access_token":"\#(a2)","token_type":"Bearer","refresh_token":"r2"}"#)
            let daemon = Daemon()
            await daemon.answer("/v0/bots", edge, HTTP1Response(status: 200, body: Data("{}".utf8)))
            let auth = authorization(http)
            let transport = signed(daemon, auth, cloud: true)
            let recovered = try await transport.request(method: "GET", path: "/v0/bots", credential: "", body: nil, headers: [:])
            XCTAssertEqual(recovered.status, 200, "\(edge.status)")
            XCTAssertEqual(http.requests.count, 1, "refreshed once")
            await daemon.answer("/v0/bots", edge)
            let gaveUp = try await transport.request(method: "GET", path: "/v0/bots", credential: "", body: nil, headers: [:])
            XCTAssertEqual(gaveUp.status, 503, "\(edge.status)")
            let state = await auth.state
            XCTAssertEqual(state, .signedIn, "the edge's \(edge.status) signed out of Happy Cloud")
        }
    }

    /// On Happy Cloud only the accounts service refusing the refresh signs
    /// out; a member the daemon keeps refusing is unavailable for now.
    func testOnHappyCloudOnlyARefusedRefreshSignsOut() async throws {
        let unauthorized = HTTP1Response(status: 401, headers: json, body: Data(#"{"error":"Unauthorized","code":"unauthorized"}"#.utf8))
        let http = ScriptedHTTP()
        let daemon = Daemon()
        await daemon.answer("/v0/bots", unauthorized)
        await who.set(AuthenticationDiscovery(authenticated: true, userId: "steve", methods: []))
        let auth = authorization(http)
        let transport = signed(daemon, auth, cloud: true)
        let response = try await transport.request(method: "GET", path: "/v0/bots", credential: "", body: nil, headers: [:])
        XCTAssertEqual(response.status, 503)
        var state = await auth.state
        XCTAssertEqual(state, .signedIn)
        // Not authenticated, and the accounts service refuses the refresh.
        await who.set(AuthenticationDiscovery(authenticated: false, userId: nil, methods: []))
        http.json(acme.refreshUrl!, status: 400, #"{"error":"invalid_grant"}"#)
        let ended = try await transport.request(method: "GET", path: "/v0/bots", credential: "", body: nil, headers: [:])
        XCTAssertEqual(ended.status, 401)
        state = await auth.state
        XCTAssertEqual(state, .needsSignIn)
    }

    func testTheEdges401NeedsSigningInWithoutAsking() async throws {
        let http = ScriptedHTTP()
        let daemon = Daemon()
        await daemon.answer("/v0/bots", HTTP1Response(status: 401, headers: ["content-type": "text/html"], body: Data("<html>login</html>".utf8)))
        let auth = authorization(http)
        let response = try await signed(daemon, auth).request(method: "GET", path: "/v0/bots", credential: "", body: nil, headers: [:])
        XCTAssertEqual(response.status, 401)
        let state = await auth.state
        XCTAssertEqual(state, .needsSignIn)
        let asked = await who.asked
        XCTAssertTrue(asked.isEmpty)
        XCTAssertTrue(http.requests.isEmpty)
    }

    func testARedirectOrAForeign403NeedsSigningInAndNothingRetries() async throws {
        let http = ScriptedHTTP()
        let daemon = Daemon()
        await daemon.answer("/v0/bots", HTTP1Response(status: 302, headers: ["location": "https://idp.example"]))
        let auth = authorization(http)
        let transport = signed(daemon, auth)
        let response = try await transport.request(method: "GET", path: "/v0/bots", credential: "", body: nil, headers: [:])
        XCTAssertEqual(response.status, 401)
        let state = await auth.state
        XCTAssertEqual(state, .needsSignIn)
        // Nothing more goes to the server, nor to the token endpoint.
        _ = try await transport.request(method: "GET", path: "/v0/bots", credential: "", body: nil, headers: [:])
        let count = await daemon.seen.count
        XCTAssertEqual(count, 1)
        XCTAssertTrue(http.requests.isEmpty)
    }

    func testHappysOwn403IsAPermissionErrorNotASignIn() async throws {
        let http = ScriptedHTTP()
        let daemon = Daemon()
        await daemon.answer("/v0/config", HTTP1Response(status: 403, headers: json, body: Data(#"{"error":"Forbidden","code":"forbidden"}"#.utf8)))
        let auth = authorization(http)
        let transport = signed(daemon, auth)
        let response = try await transport.request(method: "PATCH", path: "/v0/config", credential: "", body: Data(), headers: [:])
        XCTAssertEqual(response.status, 403)
        let state = await auth.state
        XCTAssertEqual(state, .signedIn)
    }

    func testARefusedRefreshNeedsSigningInButAnUnreachableOneDoesNot() async throws {
        let http = ScriptedHTTP()
        let auth = authorization(http, access: OAuthAccess(token: "old", expiresAt: Date().addingTimeInterval(10)))
        // Expiring within the margin: refreshed before use; no answer is a network failure.
        await XCTAssertThrowsAsync(try await auth.bearer()) { XCTAssertEqual($0 as? OAuthError, .network) }
        var state = await auth.state
        XCTAssertEqual(state, .signedIn)
        http.json(acme.refreshUrl!, status: 400, #"{"error":"invalid_grant"}"#)
        await XCTAssertThrowsAsync(try await auth.bearer())
        state = await auth.state
        XCTAssertEqual(state, .needsSignIn)
    }

    func testConcurrentRefusalsShareOneRefresh() async throws {
        let http = ScriptedHTTP()
        http.json(acme.refreshUrl!, #"{"access_token":"\#(a2)","token_type":"Bearer"}"#)
        let auth = authorization(http)
        async let first = auth.renew(after: "a1")
        async let second = auth.renew(after: "a1")
        let results = await [first, second]
        for result in results { guard case .token(a2) = result else { return XCTFail("\(result)") } }
        XCTAssertEqual(http.requests.count, 1)
    }

    func testEventStreamRefusalIsReadAndSignedInAgain() async throws {
        let http = ScriptedHTTP()
        let stream = StreamDaemon(status: 403, headers: ["content-type": "text/html"], body: Data("<html>SSO</html>".utf8))
        let auth = authorization(http)
        let transport = signed(stream, auth)
        let response = try await transport.stream(path: "/v0/events/stream", credential: "", headers: ["Last-Event-ID": "c1"])
        XCTAssertEqual(response.status, 401)
        let state = await auth.state
        XCTAssertEqual(state, .needsSignIn)
        let headers = await stream.headers
        XCTAssertEqual(headers, ["Last-Event-ID": "c1"])
    }
}

private actor SavedGrants {
    var grants: [OAuthGrant] = []
    func add(_ grant: OAuthGrant) { grants.append(grant) }
}

private actor StreamDaemon: AgentTransport {
    let status: Int, responseHeaders: [String: String], body: Data
    var headers: [String: String] = [:]
    init(status: Int, headers: [String: String], body: Data) { self.status = status; responseHeaders = headers; self.body = body }
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response { HTTP1Response(status: 500) }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        self.headers = headers
        let body = body
        return HTTP1Stream(status: status, headers: responseHeaders, body: AsyncThrowingStream { $0.yield(body); $0.finish() })
    }
    func browserConnection() async throws -> any BrowserStream { throw BrowserError.unavailable }
    func close() async {}
}

/// A byte stream whose far side the test scripts.
private final class Pipe: BrowserStream, @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [Data]
    private(set) var written: [Data] = []
    private(set) var closed = false
    let authority = "happy.acme.example"
    init(_ reads: [Data]) { pending = reads }
    func read(maximumBytes: Int) async throws -> Data { lock.withLock { pending.isEmpty ? Data() : pending.removeFirst() } }
    func write(_ data: Data) async throws { lock.withLock { written.append(data) } }
    func close() async { lock.withLock { closed = true } }
    var writes: [Data] { lock.withLock { written } }
}

final class WebSocketTunnelTests: XCTestCase {
    private let key = Data(repeating: 9, count: 16)
    private let mask: @Sendable () -> [UInt8] = { [1, 2, 3, 4] }
    private var accept: String { Hashing.sha1(Data((key.base64EncodedString() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8)).base64EncodedString() }

    private func serverFrame(_ opcode: UInt8, _ payload: Data) -> Data {
        var frame = Data([0x80 | opcode])
        if payload.count <= 125 { frame.append(UInt8(payload.count)) } else { frame.append(contentsOf: [126, UInt8(payload.count >> 8), UInt8(payload.count & 0xFF)]) }
        return frame + payload
    }

    private func unmask(_ frame: Data) -> (opcode: UInt8, payload: Data) {
        let bytes = [UInt8](frame)
        var length = Int(bytes[1] & 0x7F), offset = 2
        if length == 126 { length = Int(bytes[2]) << 8 | Int(bytes[3]); offset = 4 }
        let mask = Array(bytes[offset..<offset + 4])
        let payload = bytes[(offset + 4)...].enumerated().map { $0.element ^ mask[$0.offset & 3] }
        XCTAssertEqual(bytes[1] & 0x80, 0x80, "client frames are masked")
        return (bytes[0] & 0x0F, Data(payload))
    }

    func testUpgradeCarriesTheTokenInItsHeaderAndBytesFlowBothWays() async throws {
        let head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n"
        let pipe = Pipe([Data(head.utf8) + serverFrame(0x2, Data("HTTP/1.1 200 OK\r\n".utf8)), serverFrame(0x9, Data("p".utf8)) + serverFrame(0x2, Data("tail".utf8)), serverFrame(0x2, Data())])
        let tunnel = try await WebSocketTunnel.open(pipe, path: "/v0/workspaces/w1/proxy/websocket", credential: "tok", key: key, mask: mask, keepalive: false)
        let request = String(decoding: pipe.writes[0], as: UTF8.self)
        XCTAssertTrue(request.hasPrefix("GET /v0/workspaces/w1/proxy/websocket HTTP/1.1\r\n"))
        XCTAssertTrue(request.contains("\r\nAuthorization: Bearer tok\r\n"))
        XCTAssertTrue(request.contains("\r\nUpgrade: websocket\r\n"))
        XCTAssertFalse(request.contains("?"))

        try await tunnel.write(Data("CONNECT localhost:3000 HTTP/1.1\r\n\r\n".utf8))
        let sent = unmask(pipe.writes[1])
        XCTAssertEqual(sent.opcode, 0x2)
        XCTAssertEqual(String(decoding: sent.payload, as: UTF8.self), "CONNECT localhost:3000 HTTP/1.1\r\n\r\n")

        let first = try await tunnel.read(maximumBytes: 65536)
        XCTAssertEqual(String(decoding: first, as: UTF8.self), "HTTP/1.1 200 OK\r\n")
        let second = try await tunnel.read(maximumBytes: 65536)
        XCTAssertEqual(String(decoding: second, as: UTF8.self), "tail")
        // The ping was answered with a pong carrying its payload.
        let pong = unmask(pipe.writes[2])
        XCTAssertEqual(pong.opcode, 0xA)
        XCTAssertEqual(pong.payload, Data("p".utf8))
        // An empty binary message ends the server's direction.
        let end = try await tunnel.read(maximumBytes: 65536)
        XCTAssertTrue(end.isEmpty)
    }

    func testLargeWritesAreSplitAndAnEmptyWriteHalfCloses() async throws {
        let head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n"
        let pipe = Pipe([Data(head.utf8)])
        let tunnel = try await WebSocketTunnel.open(pipe, path: "/v0/networks/n/proxy/websocket", credential: "tok", key: key, mask: mask, keepalive: false)
        try await tunnel.write(Data(repeating: 1, count: 600 * 1024))
        try await tunnel.write(Data())
        let frames = pipe.writes.dropFirst().map { [UInt8]($0) }
        XCTAssertEqual(frames.count, 4)
        XCTAssertTrue(frames.dropLast().allSatisfy { $0.count <= 256 * 1024 + 14 })
        XCTAssertEqual(frames.last, [0x82, 0x80, 1, 2, 3, 4])
    }

    func testRefusalsKeepTheirBodyAndATextMessageIsAViolation() async throws {
        let body = #"{"error":"Forbidden","code":"forbidden"}"#
        let refused = Pipe([Data("HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)".utf8)])
        await XCTAssertThrowsAsync(try await WebSocketTunnel.open(refused, path: "/v0/x/websocket", credential: "t", key: key, keepalive: false)) { error in
            let refusal = error as? TunnelRefusal
            XCTAssertEqual(refusal?.status, 403)
            XCTAssertEqual(refusal?.isHappyError, true)
            XCTAssertEqual(refusal?.requiresSignIn, false)
        }
        let edge = Pipe([Data("HTTP/1.1 302 Found\r\nLocation: https://idp.example\r\nContent-Length: 0\r\n\r\n".utf8)])
        await XCTAssertThrowsAsync(try await WebSocketTunnel.open(edge, path: "/v0/x/websocket", credential: "t", key: key, keepalive: false)) {
            XCTAssertEqual(($0 as? TunnelRefusal)?.requiresSignIn, true)
        }
        let wrongAccept = Pipe([Data("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: nope\r\n\r\n".utf8)])
        await XCTAssertThrowsAsync(try await WebSocketTunnel.open(wrongAccept, path: "/v0/x/websocket", credential: "t", key: key, keepalive: false)) {
            XCTAssertEqual($0 as? WebSocketTunnelError, .protocolViolation)
        }
        let head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n"
        let text = Pipe([Data(head.utf8) + serverFrame(0x1, Data("hi".utf8))])
        let tunnel = try await WebSocketTunnel.open(text, path: "/v0/x/websocket", credential: "t", key: key, mask: mask, keepalive: false)
        await XCTAssertThrowsAsync(try await tunnel.read(maximumBytes: 10)) { XCTAssertEqual($0 as? WebSocketTunnelError, .protocolViolation) }
    }

    func testEdgeRefusalsBlockTunnelsButTheDaemonsDoNot() {
        let origin = "https://blocked-\(UUID().uuidString.lowercased()).example"
        let daemon = AgentHTTPTransport.classify(TunnelRefusal(status: 502, contentType: "application/json", body: Data(#"{"error":"x","code":"y"}"#.utf8)), origin: origin)
        XCTAssertEqual(daemon as? BrowserError, .upstream(502))
        XCTAssertNil(TunnelSupport.shared.mode(origin))
        let signIn = AgentHTTPTransport.classify(TunnelRefusal(status: 401, contentType: nil, body: Data()), origin: origin)
        XCTAssertNotNil(signIn as? TunnelRefusal)
        let edge = AgentHTTPTransport.classify(TunnelRefusal(status: 405, contentType: "text/html", body: Data()), origin: origin)
        XCTAssertEqual(edge as? BrowserError, .tunnelsBlocked)
        XCTAssertEqual(TunnelSupport.shared.mode(origin), .blocked)
        TunnelSupport.shared.set(.webSocket, for: origin)
        XCTAssertEqual(TunnelSupport.shared.mode(origin), .blocked)
    }
}
