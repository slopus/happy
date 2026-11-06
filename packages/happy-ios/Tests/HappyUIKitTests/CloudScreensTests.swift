#if canImport(UIKit)
import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// The accounts service as Happy Cloud's screens call it: each request
/// kept, each answer given by path.
private actor CloudHTTP: HTTPTransport {
    var requests: [HTTPRequest] = []
    var answers: [String: (Int, String)] = [:]

    func answer(_ path: String, _ status: Int, _ body: String) { answers[path] = (status, body) }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        let (status, body) = answers["\(request.method) \(request.url.path)"] ?? (404, #"{"code":"not_found","error":"Not found."}"#)
        return HTTPResponse(status: status, body: Data(body.utf8))
    }
}

/// Happy Cloud's Create and Join buttons do what they say, and say why
/// when they can't: a tap once returned at once, without a request or a
/// word, because the screen checked the loading state `RoundButton` had
/// just set for it. A tap here is the button's own `tapped`, as a touch
/// runs it.
@MainActor
final class CloudScreensTests: XCTestCase {
    private func context() -> AppContext {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) })
        return AppContext(account: account, variant: .preview, version: "test")
    }

    /// On screen, as a tap needs it.
    private var window: UIWindow?
    private func show(_ screen: UIViewController) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = screen
        window.makeKeyAndVisible()
        self.window = window
        screen.view.layoutIfNeeded()
    }

    override func tearDown() {
        window?.isHidden = true
        window = nil
        super.tearDown()
    }

    private func settle(until done: () async -> Bool) async {
        for _ in 0..<200 {
            if await done() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    func testTappingCreateCreatesTheServerAndATakenNameSaysSo() async throws {
        let http = CloudHTTP()
        await http.answer("POST /v1/servers", 201, #"{"server":{"id":"s1","name":"happy","url":"https://happy.happy-clusters.com/","role":"owner","createdAt":"2026-11-06T10:00:00Z"}}"#)
        let screen = CloudCreateViewController(context: context(), account: CloudAccount.preview(token: "account", http: http))
        show(screen)
        screen.field.text.text = "happy"
        screen.primary.tapped()
        await settle { await http.requests.contains { $0.method == "POST" } }
        let created = await http.requests.first { $0.method == "POST" }
        XCTAssertEqual(created?.url.absoluteString, HappyCloud.accounts + "/v1/servers")
        XCTAssertEqual(created?.headers["Authorization"], "Bearer account")
        XCTAssertEqual(try created.flatMap { try JSONSerialization.jsonObject(with: $0.body ?? Data()) as? [String: String] }, ["name": "happy"])
        await settle { !screen.primary.isLoading }
        XCTAssertEqual(screen.status.string, "", "a created server shows no problem")

        await http.answer("POST /v1/servers", 409, #"{"code":"taken","error":"That name is taken."}"#)
        screen.primary.tapped()
        await settle { screen.status.string != "" }
        XCTAssertEqual(screen.status.string, "That name is taken.")
        await settle { !screen.primary.isLoading }

        // The keyboard's return goes through the same button.
        await http.answer("POST /v1/servers", 500, #"{"code":"internal","error":"Something broke."}"#)
        _ = screen.textFieldShouldReturn(screen.field.text)
        await settle { screen.status.string == "Something broke." }
        XCTAssertEqual(screen.status.string, "Something broke.")
    }

    func testTappingJoinJoinsAndAMissingCodeSaysSo() async throws {
        let http = CloudHTTP()
        await http.answer("POST /v1/servers/join", 404, #"{"code":"not_found","error":"No such server."}"#)
        let screen = CloudJoinViewController(context: context(), account: CloudAccount.preview(token: "account", http: http))
        show(screen)
        screen.nameField.text.text = "@acme"
        screen.primary.tapped()
        await settle { !screen.status.string.isEmpty }
        XCTAssertEqual(screen.status.string, Strings.HappyCloud.joinMissing)
        await settle { !screen.primary.isLoading }
        let none = await http.requests.count
        XCTAssertEqual(none, 0)

        screen.codeField.text.text = "pcmurcvd"
        screen.primary.tapped()
        await settle { screen.status.string == "No server has that name and invite code." }
        XCTAssertEqual(screen.status.string, "No server has that name and invite code.")
        let joined = await http.requests.first
        XCTAssertEqual(try joined.flatMap { try JSONSerialization.jsonObject(with: $0.body ?? Data()) as? [String: String] }, ["name": "acme", "code": "pcmurcvd"])
    }
}
#endif
