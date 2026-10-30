#if canImport(UIKit)
import Foundation
import HappyCore
import HappyStore
@testable import HappyUI
import HappyWire
import UIKit
import XCTest

private struct NoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        throw URLError(.notConnectedToInternet)
    }
}

private struct NoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection {
        throw URLError(.notConnectedToInternet)
    }
}

/// Both scans Steve used, Link New Device (`.connect`) and Add Account
/// (`.addAccount`), with every kind of code: each one does something the
/// person can see. Link New Device used to drop a computer's code and Pair
/// computer another device's, without a word.
@MainActor
final class HappyScanTests: XCTestCase {
    private let key = Data(repeating: 9, count: 32)

    private func signedIn() async throws -> AccountController {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(),
            storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(),
            connector: NoSockets()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 1, count: 32)))
        return controller
    }

    private func screens() -> (UIWindow, UINavigationController) {
        let navigation = UINavigationController(rootViewController: UIViewController())
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.rootViewController = navigation
        window.isHidden = false
        navigation.view.layoutIfNeeded()
        return (window, navigation)
    }

    private func until(_ condition: () -> Bool) async throws -> Bool {
        for _ in 0..<500 where !condition() {
            try await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }

    private func direct() throws -> String {
        let bundle: [String: Any] = ["v": 1, "a": "tcAddress", "p": 24781, "t": CanonicalBase64URL.encode(Data(repeating: 3, count: 32)), "n": "Mac", "e": 2_000_000_000_000.0]
        return PairingLink.prefix + CanonicalBase64URL.encode(try JSONSerialization.data(withJSONObject: bundle))
    }

    /// What the screen shows after `text` was opened: an alert's title and
    /// message, or the screen pushed.
    private func shown(_ text: String, _ intent: ScanIntent, context: AppContext) async throws -> String {
        let (window, navigation) = screens()
        defer { window.isHidden = true }
        let host = try XCTUnwrap(navigation.topViewController)
        let task = Task { await HappyScan.open(text, intent: intent, context: context, on: host, start: .scan) }
        let visible = try await until { navigation.presentedViewController is UIAlertController || navigation.viewControllers.count > 1 }
        task.cancel()
        guard visible else { return "nothing" }
        if let alert = navigation.presentedViewController as? UIAlertController {
            return "\(alert.title ?? "") | \(alert.message ?? "")"
        }
        return String(describing: type(of: navigation.topViewController!))
    }

    func testEveryCodeFromEitherScanShowsSomething() async throws {
        let controller = try await signedIn()
        let context = AppContext(account: controller, variant: .development, version: "test")
        let keyText = CanonicalBase64URL.encode(key)
        let terminal = "happy://terminal?" + keyText
        let account = "happy:///account?" + keyText
        let agentPairingCode = try direct()

        for intent in [ScanIntent.connect, .addAccount] {
            for text in [terminal, account, agentPairingCode, "happy://terminal?xx", "happy:///account?xx", "happy://direct?bad", "garbage", "https://example.com"] {
                let result = try await shown(text, intent, context: context)
                XCTAssertNotEqual(result, "nothing", "\(intent) \(text.prefix(20)) showed nothing")
            }
        }

        // What each one says.
        let connectTerminal = try await shown(terminal, .connect, context: context)
        XCTAssertEqual(connectTerminal, "\(Strings.Common.error) | \(Strings.Modals.failedToConnectTerminal)")
        let linkDevice = try await shown(account, .connect, context: context)
        XCTAssertEqual(linkDevice, "\(Strings.Common.error) | \(Strings.Modals.failedToLinkDevice)")
        let addAccount = try await shown(terminal, .addAccount, context: context)
        XCTAssertEqual(addAccount, "\(Strings.Modals.authenticateTerminal) | \(Strings.Scan.newAccountForComputer)")
        let garbage = try await shown("garbage", .connect, context: context)
        XCTAssertEqual(garbage, "\(Strings.Scan.notHappyTitle) | \(Strings.Scan.notHappy)")
        let broken = try await shown("happy://terminal?xx", .addAccount, context: context)
        XCTAssertEqual(broken, "\(Strings.Common.error) | \(Strings.Modals.invalidAuthUrl)")
        await controller.signOut()
    }
}
#endif
