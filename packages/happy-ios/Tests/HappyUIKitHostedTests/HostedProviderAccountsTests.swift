#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyWire
import UIKit
import XCTest
@testable import HappyUI

/// A paired computer serving provider sign-in (happy-agent API.md): Codex
/// on the machine's login, Claude signed in to Happy. Codex's sign-in
/// waits with a device code; Claude's takes a pasted code and succeeds;
/// with `owner`, every change is the owner's.
private actor SignInDaemon: AgentTransport {
    let owner: Bool
    private var operations: [String: String] = [:]
    private var version = 1
    private(set) var routes: [String] = []

    init(owner: Bool = false) { self.owner = owner }

    private static func credential(_ type: String, _ source: String) -> String {
        #"{"source":"\#(source)","methods":\#(type == "claude" ? #"["browser"]"# : #"["device","browser"]"#),"acceptsToken":\#(type == "claude")}"#
    }

    private func object(_ id: String, _ type: String, _ source: String) -> String {
        version += 1
        let account = source == "internal" ? #"{"email":"ada@example.com","plan":"Max"}"# : "null"
        return #"{"providerSignIn":{"providerId":"\#(id)","cliId":"\#(type)","installed":true,"credential":\#(Self.credential(type, source)),"account":\#(account),"operation":\#(operations[id] ?? "null"),"version":"\#(String(format: "01991f3a-5c1e-7000-8000-%012d", version))","updatedAt":1}}"#
    }

    private static func operation(_ status: String, _ type: String) -> String {
        let authorization = type == "claude"
            ? #"{"method":"browser","url":"https://claude.ai/oauth/authorize","userCode":null,"openedByProgram":false,"acceptsCode":true,"expiresAt":1}"#
            : #"{"method":"device","url":"https://auth.openai.com/codex/device","userCode":"FQ7K-2MXD","openedByProgram":false,"acceptsCode":false,"expiresAt":1}"#
        return #"{"id":"op-\#(type)","kind":"sign_in","status":"\#(status)","message":"Signing in","authorization":\#(authorization),"output":[],"error":null,"startedAt":1,"finishedAt":null}"#
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        routes.append("\(method) \(path)")
        func ok(_ text: String) -> HTTP1Response { HTTP1Response(status: 200, body: Data(text.utf8)) }
        let health = #"{"ready":true,"capabilities":{"providerSignIn":true}}"#
        switch (method, path) {
        case ("GET", "/v0/health"): return ok(health)
        case ("GET", "/v0/bootstrap/desktop"):
            return ok(#"{"cursor":"c1","health":\#(health),"profile":{"userId":null},"userSettings":[],"projects":[],"workspaces":[],"bots":[],"tasks":[],"taskMemberships":[],"surfaces":[]}"#)
        case ("GET", "/v0/config"):
            return ok(#"{"config":{"defaults":{"providerId":"codex","modelId":"m"},"models":{},"providers":{"codex":{"type":"codex","name":"Work ChatGPT","enabled":true,"credential":\#(Self.credential("codex", "system"))},"claude":{"type":"claude","enabled":true,"credential":\#(Self.credential("claude", "internal"))},"bedrock":{"type":"bedrock","enabled":true}}}}"#)
        case ("GET", "/v0/usage"):
            let now = Int(Date().timeIntervalSince1970 * 1000)
            return ok(#"{"providers":[{"providerId":"codex","signIn":"signed_out","lastUsedAt":null,"login":{"refreshedAt":null,"expiresAt":null,"refreshError":{"status":400,"code":"invalid_grant","permanent":true,"since":1763596800000,"at":\#(now)}}},{"providerId":"claude","signIn":"signed_in","lastUsedAt":\#(now - 240_000),"login":{"refreshedAt":\#(now - 3_600_000),"expiresAt":null,"refreshError":null}}]}"#)
        default: break
        }
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count >= 4, parts[1] == "providers", ["codex", "claude"].contains(parts[2]) else {
            return HTTP1Response(status: 404, body: Data(#"{"error":"Not here.","code":"not_found"}"#.utf8))
        }
        let id = parts[2], rest = parts.dropFirst(3).joined(separator: "/")
        if method != "GET", owner { return HTTP1Response(status: 403, body: Data(#"{"error":"Only the owner.","code":"forbidden"}"#.utf8)) }
        switch (method, rest) {
        case ("POST", "sign-in"): operations[id] = Self.operation("waiting", id)
        case ("POST", "sign-in/code"): operations[id] = Self.operation("succeeded", id)
        case ("POST", "sign-in/cancel"): operations[id] = Self.operation("cancelled", id)
        default: break
        }
        return ok(object(id, id, id == "claude" ? "internal" : "system"))
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.cannotConnectToHost) }
    func reset() async {}
    func close() async {}
}

private struct SignInOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct SignInNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

private struct SignInTimedOut: Error {}

@MainActor
final class HostedProviderAccountsTests: XCTestCase {
    func testAMinimalListThenEachAccountsOwnPage() async throws {
        let (list, navigation, _, _) = try await host(SignInDaemon())
        XCTAssertEqual(list.shownRowIDs, [["provider-account-codex", "provider-account-claude"]], "bedrock has nothing to sign in to")
        XCTAssertEqual(list.shownRow("provider-account-codex")?.title, "Work ChatGPT")
        XCTAssertEqual(list.shownRow("provider-account-codex")?.subtitle, "Needs sign-in since \(Strings.ProviderAccounts.shortDate(Date(timeIntervalSince1970: 1_763_596_800)))")
        XCTAssertEqual(list.shownDot("codex"), .red)
        XCTAssertEqual(Strings.ProviderAccounts.status(.needsSignIn(since: nil), source: .internal, account: nil, now: Date()), "Needs sign-in", "no date when the computer doesn't know one")
        let now = Date()
        XCTAssertEqual(Strings.ProviderAccounts.status(.refreshFailed(reason: "HTTP 503", at: now), source: .internal, account: nil, expires: now.addingTimeInterval(7_300), now: now),
                       "Couldn’t refresh · HTTP 503 · expires in 2h", "the warning takes the place of when it was tried")
        XCTAssertEqual(list.shownRow("provider-account-codex")?.subtitleLines, 1, "one line in every state")
        XCTAssertEqual(list.shownRow("provider-account-codex")?.subtitleCutsTail, true)
        XCTAssertEqual(list.shownRow("provider-account-claude")?.title, "Claude · Max")
        XCTAssertEqual(list.shownRow("provider-account-claude")?.subtitle, "Used 4m ago · refreshed 1h ago")
        XCTAssertEqual(list.shownDot("claude"), .green)
        XCTAssertEqual(list.shownRow("provider-account-claude")?.accessory, .chevron)
        XCTAssertEqual(list.shownHeaders, ["ACCOUNTS"])

        let detail = try await page("claude", list, navigation)
        let rows = [["provider-detail-name", "provider-detail-enabled"],
                    ["provider-detail-source", "provider-detail-used", "provider-detail-refreshed", "provider-detail-expires", "provider-detail-error"],
                    ["provider-sign-in-claude", "provider-token-claude"]]
        XCTAssertEqual(detail.shownRowIDs, rows)
        XCTAssertEqual(detail.shownRow("provider-detail-used")?.value, "4m ago")
        XCTAssertEqual(detail.shownRow("provider-detail-expires")?.value, "—")
        XCTAssertEqual(detail.shownRow("provider-detail-error")?.subtitle, "—")
        XCTAssertEqual(detail.shownRow("provider-detail-source")?.value, "Signed in to Happy")
        XCTAssertNil(detail.shownRow("provider-detail-source")?.subtitle)
        XCTAssertEqual(detail.shownRow("provider-detail-name")?.subtitle, "Claude · Max · ada@example.com")
        XCTAssertEqual(detail.shownFooters.last, "Signing in here gives this account a login only Happy uses, so it stops using the system login.")
        navigation.popViewController(animated: false)
        let codex = try await page("codex", list, navigation)
        XCTAssertEqual(codex.shownRowIDs.dropLast(), rows.dropLast(), "the same rows whatever the state")
        XCTAssertEqual(codex.shownRow("provider-detail-name")?.subtitle, "Codex", "the vendor at least: the line is always there")
        XCTAssertEqual(codex.shownRow("provider-detail-used")?.value, "Not used yet")
        XCTAssertEqual(codex.shownRow("provider-detail-refreshed")?.value, "—", "an unknown refresh, not none")
        XCTAssertEqual(codex.shownRow("provider-detail-error")?.subtitle, "invalid_grant · since \(Strings.ProviderAccounts.shortDate(Date(timeIntervalSince1970: 1_763_596_800)))")
        XCTAssertEqual(codex.shownRow("provider-detail-error")?.destructive, true)
    }

    /// The account's page, as a tap on its row opens it, once it shows.
    private func page(_ id: String, _ list: ProviderAccountsViewController, _ navigation: UINavigationController) async throws -> ProviderAccountViewController {
        list.tapRow("provider-account-\(id)")
        let page = try await until { navigation.topViewController as? ProviderAccountViewController }
        _ = try await until { page.shownRow("provider-sign-in-\(id)") }
        return page
    }

    func testCodexShowsItsDeviceCodeAndLeavingCancelsIt() async throws {
        let daemon = SignInDaemon()
        let (list, navigation, _, _) = try await host(daemon)
        let detail = try await page("codex", list, navigation)
        detail.tapRow("provider-sign-in-codex")
        let page = try await until { navigation.topViewController as? AccountSignInViewController }
        _ = try await until { page.shownPhase == .device(code: "FQ7K-2MXD", url: URL(string: "https://auth.openai.com/codex/device")) ? true : nil }
        let code = try XCTUnwrap(Self.find(UILabel.self, in: page.view) { $0.accessibilityIdentifier == "account-sign-in-code" })
        XCTAssertEqual(code.text, "FQ7K-2MXD")
        let started = await daemon.routes
        XCTAssertTrue(started.contains("POST /v0/providers/codex/sign-in"))
        _ = try await until { detail.shownRow("provider-sign-in-codex")?.value == "In progress" ? true : nil }
        navigation.popViewController(animated: false)
        _ = try await until { await daemon.routes.contains("POST /v0/providers/codex/sign-in/cancel") ? true : nil }
    }

    func testClaudesPastedCodeSignsItIn() async throws {
        let daemon = SignInDaemon()
        let (list, navigation, _, _) = try await host(daemon)
        try await page("claude", list, navigation).tapRow("provider-sign-in-claude")
        let page = try await until { navigation.topViewController as? AccountSignInViewController }
        _ = try await until { page.shownPhase == .pasteCode(url: URL(string: "https://claude.ai/oauth/authorize")) ? true : nil }
        let slots = page.shownSlots
        page.enterCode("  pasted-code ")
        _ = try await until { page.shownPhase == .succeeded(ProviderSignIn.Account(email: "ada@example.com", plan: "Max")) ? true : nil }
        XCTAssertEqual(page.shownSlots, slots, "nothing moves from one state to the next")
        let routes = await daemon.routes
        XCTAssertTrue(routes.contains("POST /v0/providers/claude/sign-in/code"))
        XCTAssertFalse(routes.contains("POST /v0/providers/claude/sign-in/cancel"), "a finished sign-in isn't cancelled")
    }

    func testAMemberWhoIsNotTheOwnerIsToldOnceAndTheActionsGoOff() async throws {
        let (list, navigation, _, session) = try await host(SignInDaemon(owner: true))
        addTeardownBlock { @MainActor in ProviderSignInAccess.forget(session.accountID) }
        let detail = try await page("codex", list, navigation)
        detail.tapRow("provider-sign-in-codex")
        let signIn = try await until { navigation.topViewController as? AccountSignInViewController }
        let failure = try await until { Self.find(UILabel.self, in: signIn.view) { $0.accessibilityIdentifier == "account-sign-in-failure" } }
        XCTAssertEqual(failure.text, "Sign-in failed")
        XCTAssertNil(Self.find(UIButton.self, in: signIn.view) { $0.accessibilityIdentifier == "account-sign-in-retry" }, "trying again can't help")
        navigation.popViewController(animated: false)
        _ = try await until { detail.shownRow("provider-sign-in-codex")?.dimmed == true ? true : nil }
        XCTAssertEqual(detail.shownRow("provider-sign-in-codex")?.value, "Owner only")
        XCTAssertEqual(detail.shownRow("provider-sign-in-codex")?.hint, "Only the team owner can change how accounts sign in.")
        XCTAssertNil(detail.shownRow("provider-detail-enabled")?.toggled, "the switch is the owner's too")
        XCTAssertEqual(detail.shownFooters.last, "Signing in here gives this account a login only Happy uses, so it stops using the system login.", "the footer never changes")
        navigation.popViewController(animated: false)
        let claude = try await page("claude", list, navigation)
        XCTAssertEqual(claude.shownRow("provider-token-claude")?.dimmed, true)
        XCTAssertEqual(claude.shownRow("provider-token-claude")?.value, "Owner only")
    }

    private func host(_ daemon: SignInDaemon) async throws -> (ProviderAccountsViewController, UINavigationController, UIWindow, Session) {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in daemon },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: SignInOffline(), connector: SignInNoSocket()
        )
        let added = try await controller.agentConnections.add(
            AgentConnectionCredentials(address: "studio.local", port: 7777, deviceID: "provider-accounts-test", deviceToken: "t"), name: "Studio")
        addTeardownBlock { @MainActor in
            Session.forget(added.id)
            try? await controller.agentConnections.remove(added.id)
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: added.id, context: context))
        let list = ProviderAccountsViewController(session: session)
        let navigation = UINavigationController(rootViewController: list)
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
        }
        window.layoutIfNeeded()
        _ = try await until { list.shownRow("provider-account-claude") }
        return (list, navigation, window, session)
    }

    private func until<T>(seconds: Double = 8, _ value: () async -> T?) async throws -> T {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if let found = await value() { return found }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw SignInTimedOut()
    }

    private static func find<T: UIView>(_ type: T.Type, in view: UIView, where test: (T) -> Bool) -> T? {
        if let match = view as? T, test(match) { return match }
        for child in view.subviews { if let found = find(type, in: child, where: test) { return found } }
        return nil
    }
}
#endif
