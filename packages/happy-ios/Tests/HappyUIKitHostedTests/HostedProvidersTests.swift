#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyWire
import UIKit
import XCTest
@testable import HappyUI

private struct Offline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct NoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A Happy Cloud server as ONBOARDING-API v1 has it: one connection of
/// each kind, ChatGPT's device sign-in that ends once polled twice.
private actor CloudProvidersServer: AgentTransport {
    let grants: [String]
    let startFailure: Int?
    let succeeds: Bool
    private var polls = 0
    private(set) var started: [String] = []
    private(set) var keys: [String: JSONValue] = [:]
    private(set) var cancellations = 0

    init(grants: [String] = ["providers.own", "providers.manage", "content.write", "bots.manage", "config.manage"], startFailure: Int? = nil, succeeds: Bool = true) {
        self.grants = grants; self.startFailure = startFailure; self.succeeds = succeeds
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        func ok(_ text: String) -> HTTP1Response { .init(status: 200, headers: ["content-type": "application/json"], body: Data(text.utf8)) }
        switch (method, path) {
        case ("GET", "/v0/permissions"):
            return .init(status: 200, body: try JSONEncoder().encode(["granted": grants]))
        case ("GET", "/v0/cloud/providers"):
            return ok(#"""
            {"providers":[
              {"id":"operator:openai","name":"Happy (free)","scope":"team","source":"operator","vendors":["openai"],"models":["openai/gpt-6.1-terra"],"credentialCount":0},
              {"id":"anthropic","name":"Anthropic","scope":"team","source":"tenant","vendors":["anthropic"],"models":[],"credentialCount":1,
               "credentials":[{"id":"k1","vendor":"anthropic","kind":"api_key","label":"Team key","enabled":true,"state":"invalid"}]}
            ],"capabilities":{"apiKeys":true,"claudeSetupToken":true,"codexSignIn":true,"claudeSignIn":false}}
            """#)
        case ("GET", "/v0/provider-clis"):
            return ok(#"{"providerClis":[{"id":"codex"},{"id":"claude"}]}"#)
        case ("POST", "/v0/provider-clis/codex/sign-in"):
            started.append(String(decoding: body ?? Data(), as: UTF8.self))
            if let startFailure {
                return .init(status: startFailure, body: Data(#"{"error":"Not available.","code":"unsupported"}"#.utf8))
            }
            // As production answers: the code comes from the CLI a moment later.
            return ok(Self.cli("running", code: false))
        case ("GET", "/v0/provider-clis/codex"):
            polls += 1
            return ok(Self.cli(succeeds && polls >= 2 ? "succeeded" : "waiting"))
        case ("POST", "/v0/provider-clis/codex/cancel"):
            cancellations += 1
            return ok("{}")
        case ("POST", "/v0/cloud/providers/private/credentials"), ("POST", "/v0/cloud/providers/grok/credentials"):
            keys[path] = try JSONValue.decode(body ?? Data())
            return ok("{}")
        default:
            return .init(status: 404, headers: ["content-type": "application/json"], body: Data(#"{"error":"Not found.","code":"not_found"}"#.utf8))
        }
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.cannotConnectToHost) }
    func reset() async {}
    func close() async {}

    static func cli(_ status: String, code: Bool = true) -> String {
        let authorization = code ? #"{"method":"device","url":"https://auth.openai.com/codex/device","userCode":"ABCD-1234","acceptsCode":false,"expiresAt":1755400600000}"# : "null"
        return #"{"providerCli":{"id":"codex","operation":{"id":"q7","kind":"sign_in","status":"\#(status)","authorization":\#(authorization),"target":{"providerId":"private"},"error":null}}}"#
    }
}

private struct ProvidersTimedOut: Error {}

@MainActor
final class HostedProvidersTests: XCTestCase {
    func testTheListChatGPTsDeviceSignInAndGrokKeys() async throws {
        let server = CloudProvidersServer()
        let (list, navigation, window, session) = try await host(server)

        XCTAssertEqual(list.shownRowIDs, [["providers-add"], ["provider-operator:openai"], ["provider-anthropic", "credential-k1"], ["providers-mine-empty"]])
        XCTAssertEqual(list.shownRow("credential-k1")?.value, "Needs attention")
        XCTAssertEqual(list.shownFooters.last, "Only you can use these.")
        capture(window, "providers-list")

        try openLink("happy://settings/providers/add/openai", session: session, from: list)
        let device = try await until { navigation.topViewController as? DeviceSignInViewController }
        let code = try XCTUnwrap(Self.find(UILabel.self, in: device.view) { $0.accessibilityIdentifier == "provider-device-code" })
        _ = try await until(seconds: 8) { code.text == "ABCD-1234" ? true : nil }
        _ = try await until { navigation.transitionCoordinator == nil ? true : nil }
        capture(window, "providers-device")
        let body = await server.started.first ?? ""
        XCTAssertTrue(body.contains(#""target":{"scope":"private"}"#) || body.contains(#""scope":"private""#), body)
        XCTAssertTrue(body.contains(#""method":"device""#), body)
        _ = try await until(seconds: 12) { navigation.topViewController === list ? true : nil }
        _ = try await until { (list.presentedViewController as? UIAlertController)?.title == "ChatGPT connected" ? true : nil }
        _ = try await until { list.presentedViewController?.transitionCoordinator == nil ? true : nil }
        capture(window, "providers-connected")
        await withCheckedContinuation { done in list.dismiss(animated: false) { done.resume() } }

        list.choose()
        let chooser = try XCTUnwrap(list.presentedViewController as? UIAlertController)
        _ = try await until { chooser.transitionCoordinator == nil ? true : nil }
        XCTAssertTrue(chooser.actions.contains { $0.title == "Add API key · Grok" })
        await withCheckedContinuation { done in list.dismiss(animated: false) { done.resume() } }
        for (destination, container) in [(CloudProvider.Destination.mine, "private"), (.team, "grok")] {
            if destination == .mine {
                try openLink("happy://settings/providers/add/api-key?vendor=grok", session: session, from: list)
            } else {
                list.open(.providersAddAPIKey, vendor: "grok", destination: destination)
            }
            let form = try await until { list.presentedViewController as? UIAlertController }
            _ = try await until { form.transitionCoordinator == nil ? true : nil }
            XCTAssertEqual(form.message, "Grok")
            let field = try XCTUnwrap(form.textFields?.first)
            XCTAssertTrue(field.isSecureTextEntry)
            field.text = "xai-test"
            capture(window, "providers-grok-\(container)")
            let connect = try XCTUnwrap(form.actions.first { $0.title == "Connect" })
            // UIAlertAction exposes no public invocation API to hosted tests.
            typealias Handler = @convention(block) (UIAlertAction) -> Void
            let handler = unsafeBitCast(try XCTUnwrap(connect.value(forKey: "handler") as AnyObject?), to: Handler.self)
            await withCheckedContinuation { done in list.dismiss(animated: false) { done.resume() } }
            handler(connect)
            _ = try await until { (list.presentedViewController as? UIAlertController)?.title == "API key added" ? true : nil }
            _ = try await until { list.presentedViewController?.transitionCoordinator == nil ? true : nil }
            let sent = await server.keys["/v0/cloud/providers/\(container)/credentials"]
            XCTAssertEqual(sent, .object(["vendor": .string("grok"), "kind": .string("api_key"), "secret": .string("xai-test")]))
            await withCheckedContinuation { done in list.dismiss(animated: false) { done.resume() } }
        }
    }

    func testPrivateLinksNeverFallBackToTheTeam() async throws {
        let server = CloudProvidersServer(grants: ["providers.manage"])
        let (list, navigation, _, session) = try await host(server)
        for suffix in ["api-key?vendor=grok&to=private", "openai?to=private"] {
            try openLink("happy://settings/providers/add/\(suffix)", session: session, from: list)
            let refusal = try await until { list.presentedViewController as? UIAlertController }
            XCTAssertEqual(refusal.title, "Can’t add to this connection")
            XCTAssertTrue(refusal.textFields?.isEmpty ?? true)
            XCTAssertTrue(navigation.topViewController === list)
            _ = try await until { refusal.transitionCoordinator == nil ? true : nil }
            await withCheckedContinuation { done in list.dismiss(animated: false) { done.resume() } }
        }
        let keys = await server.keys, starts = await server.started
        XCTAssertTrue(keys.isEmpty)
        XCTAssertTrue(starts.isEmpty)
    }

    func testDefaultPrivateLinksRequireAnExplicitTeamChoiceWithoutPrivateAccess() async throws {
        let server = CloudProvidersServer(grants: ["providers.manage"])
        let (list, navigation, _, session) = try await host(server)
        for suffix in ["", "/api-key?vendor=grok", "/openai"] {
            try openLink("happy://settings/providers/add\(suffix)", session: session, from: list)
            let choice = try await until { list.presentedViewController as? UIAlertController }
            XCTAssertEqual(choice.title, "Save to")
            XCTAssertEqual(choice.actions.map(\.title), [Strings.Providers.team, Strings.Common.cancel])
            XCTAssertTrue(choice.textFields?.isEmpty ?? true)
            XCTAssertTrue(navigation.topViewController === list)
            _ = try await until { choice.transitionCoordinator == nil ? true : nil }
            await withCheckedContinuation { done in list.dismiss(animated: false) { done.resume() } }
        }
        let keys = await server.keys, starts = await server.started
        XCTAssertTrue(keys.isEmpty)
        XCTAssertTrue(starts.isEmpty)
    }

    func testNativeBackCancelsChatGPTOnTheServer() async throws {
        let server = CloudProvidersServer(succeeds: false)
        let (list, navigation, _, _) = try await host(server)
        list.open(.providersAddOpenAI, destination: .mine)
        let device = try await until { navigation.topViewController as? DeviceSignInViewController }
        let code = try XCTUnwrap(Self.find(UILabel.self, in: device.view) { $0.accessibilityIdentifier == "provider-device-code" })
        _ = try await until(seconds: 8) { code.text == "ABCD-1234" ? true : nil }
        navigation.popViewController(animated: false)
        _ = try await until { await server.cancellations == 1 ? true : nil }
        XCTAssertTrue(navigation.topViewController === list)
    }

    func testClaudesSetupTokenOpensFromItsOwnScreen() async throws {
        let server = CloudProvidersServer()
        let (list, navigation, window, _) = try await host(server)
        let flows = ProviderFlows(client: AgentClient(transport: server, token: "t"), destination: .mine, host: list, added: {})
        let claude = ClaudeSignInViewController(flows: flows)
        navigation.pushViewController(claude, animated: false)
        window.layoutIfNeeded()
        let token = try XCTUnwrap(Self.find(UIButton.self, in: claude.view) { $0.accessibilityIdentifier == "provider-claude-token" })
        // A setup token only: no Claude page to open, no code to paste.
        XCTAssertEqual(claude.title, "Use a Claude setup token")
        XCTAssertEqual(token.configuration?.title, "Add setup token")
        XCTAssertNil(Self.find(UIButton.self, in: claude.view) { $0.accessibilityIdentifier == "provider-claude-open" })
        XCTAssertNil(Self.find(UITextField.self, in: claude.view) { $0.accessibilityIdentifier == "provider-claude-code" })
        let shot = XCTAttachment(image: UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) })
        shot.name = "claude-setup-token"; shot.lifetime = .keepAlways; add(shot)
        token.sendActions(for: .touchUpInside)
        let form = try await until { claude.presentedViewController as? UIAlertController }
        XCTAssertEqual(form.title, "Setup token")
        XCTAssertTrue(try XCTUnwrap(form.textFields?.first).isSecureTextEntry)
    }

    func test404HidesTheSignInUntilCapabilitiesRefresh() async throws { try await unavailable(404) }
    func test501HidesTheSignInUntilCapabilitiesRefresh() async throws { try await unavailable(501) }

    private func unavailable(_ status: Int) async throws {
        let (list, navigation, _, _) = try await host(CloudProvidersServer(startFailure: status))
        XCTAssertTrue(list.adding.chooser().actions.contains { $0.title == "Sign in with ChatGPT" })
        list.open(.providersAddOpenAI, destination: .mine)
        let device = try await until { navigation.topViewController as? DeviceSignInViewController }
        _ = try await until { (device.presentedViewController as? UIAlertController)?.title == "Sign-in failed" ? true : nil }
        XCTAssertFalse(list.adding.chooser().actions.contains { $0.title == "Sign in with ChatGPT" })
        XCTAssertTrue(list.adding.chooser().actions.contains { $0.title == "Use a Claude setup token" })
        list.load()
        _ = try await until { list.adding.chooser().actions.contains { $0.title == "Sign in with ChatGPT" } ? true : nil }
    }

    private func openLink(_ url: String, session: Session, from list: ProvidersViewController) throws {
        let link = try XCTUnwrap(HappyLink(url))
        guard case .settings(let page) = link.target else { return XCTFail("not a settings link") }
        ProvidersViewController.open(page, options: link.providerOptions, session: session, from: list)
    }

    private func host(_ server: CloudProvidersServer) async throws -> (ProvidersViewController, UINavigationController, UIWindow, Session) {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in server },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: Offline(), connector: NoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let origin = HappyCloud.server(named: "providers-test")
        let record = ServerSignInRecord(method: HappyCloud.method(server: origin), grant: OAuthGrant(refreshToken: "r1", clientId: "happy"), userId: "u1")
        let added = try await controller.agentConnections.addServer(try AgentOrigin(origin), signIn: record, access: OAuthAccess(token: "a1", expiresAt: nil), name: "providers-test")
        addTeardownBlock { @MainActor in
            Session.forget(added.id)
            try? await controller.agentConnections.remove(added.id)
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: added.id, context: context))
        let list = ProvidersViewController(session: session)
        let navigation = UINavigationController(rootViewController: list)
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
        }
        window.layoutIfNeeded()

        let deadline = Date().addingTimeInterval(5)
        while list.shownRow("provider-anthropic") == nil || list.shownRow("providers-add") == nil, Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        return (list, navigation, window, session)
    }

    private func until<T>(seconds: Double = 5, _ value: () async -> T?) async throws -> T {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if let found = await value() { return found }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw ProvidersTimedOut()
    }

    private static func find<T: UIView>(_ type: T.Type, in view: UIView, where test: (T) -> Bool) -> T? {
        if let match = view as? T, test(match) { return match }
        for child in view.subviews { if let found = find(type, in: child, where: test) { return found } }
        return nil
    }

    private func capture(_ window: UIWindow, _ name: String) {
        window.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
#endif
