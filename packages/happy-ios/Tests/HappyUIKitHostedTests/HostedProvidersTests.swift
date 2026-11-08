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
    private var polls = 0
    private(set) var started: [String] = []
    private(set) var keys: [String: JSONValue] = [:]

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        func ok(_ text: String) -> HTTP1Response { .init(status: 200, headers: ["content-type": "application/json"], body: Data(text.utf8)) }
        switch (method, path) {
        case ("GET", "/v0/permissions"):
            return ok(#"{"role":"owner","granted":["providers.own","providers.manage","content.write","bots.manage","config.manage"]}"#)
        case ("GET", "/v0/cloud/providers"):
            return ok(#"""
            {"providers":[
              {"id":"operator:openai","name":"Happy (free)","scope":"team","source":"operator","vendors":["openai"],"models":["openai/gpt-6.1-terra"],"credentialCount":0},
              {"id":"anthropic","name":"Anthropic","scope":"team","source":"tenant","vendors":["anthropic"],"models":[],"credentialCount":1,
               "credentials":[{"id":"k1","vendor":"anthropic","kind":"api_key","label":"Team key","enabled":true,"state":"invalid"}]}
            ]}
            """#)
        case ("GET", "/v0/provider-clis"):
            return ok(#"{"providerClis":[{"id":"codex"},{"id":"claude"}]}"#)
        case ("POST", "/v0/provider-clis/codex/sign-in"):
            started.append(String(decoding: body ?? Data(), as: UTF8.self))
            // As production answers: the code comes from the CLI a moment later.
            return ok(Self.cli("running", code: false))
        case ("GET", "/v0/provider-clis/codex"):
            polls += 1
            return ok(Self.cli(polls < 2 ? "waiting" : "succeeded"))
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
        XCTAssertEqual(list.shownRowIDs, [["providers-add"], ["provider-operator:openai"], ["provider-anthropic", "credential-k1"], ["providers-mine-empty"]])
        XCTAssertEqual(list.shownRow("credential-k1")?.value, "Needs attention")
        XCTAssertEqual(list.shownFooters.last, "Only you can use these.")
        capture(window, "providers-list")

        list.open(.providersAddOpenAI, destination: .mine)
        let device = try await until { navigation.topViewController as? DeviceSignInViewController }
        let code = try XCTUnwrap(Self.find(UILabel.self, in: device.view) { $0.accessibilityIdentifier == "provider-device-code" })
        _ = try await until(seconds: 8) { code.text == "ABCD-1234" ? true : nil }
        _ = try await until { navigation.transitionCoordinator == nil ? true : nil }
        capture(window, "providers-device")
        let body = await server.started.first ?? ""
        XCTAssertTrue(body.contains(#""target":{"scope":"private"}"#) || body.contains(#""scope":"private""#), body)
        XCTAssertTrue(body.contains(#""method":"device""#), body)
        // Polled to `succeeded`: back on the list, which says so.
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
            list.open(.providersAddAPIKey, vendor: "grok", destination: destination)
            let form = try XCTUnwrap(list.presentedViewController as? UIAlertController)
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

    private func until<T>(seconds: Double = 5, _ value: () -> T?) async throws -> T {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if let found = value() { return found }
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
