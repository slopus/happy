#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
@testable import HappyUI
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

private struct Unreachable: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.cannotConnectToHost)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }
    func reset() async {}
    func close() async {}
}

/// Settings lists every account and agent connection in one card, the
/// active one ticked, with Connect Agent under them: a row to tap, not a
/// row of circles to swipe through, and one way to add rather than two.
/// Pictures go to the repository's `.context/evidence/settings`.
@MainActor
final class HostedSettingsAccountsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("evidence/settings")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    private func capture(_ window: UIWindow, _ name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let file = "\(name)-\(window.traitCollection.userInterfaceStyle == .dark ? "dark" : "light")"
        let attachment = XCTAttachment(image: image)
        attachment.name = file
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = Self.evidence, let data = image.pngData() {
            try? data.write(to: folder.appendingPathComponent("\(file).png"))
        }
    }

    /// A signed-in Happy account, with `connections` agent connections.
    private func settings(connections: Int) async throws -> (AccountController, SettingsViewController, UIWindow) {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(),
            storeDirectory: nil,
            agentTransport: { _ in Unreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(),
            connector: NoSockets()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 1, count: 32)))
        await controller.agentConnections.setForeground(false)
        for index in 0..<connections {
            let computer = try await controller.agentConnections.add(
                JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"settings-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
                name: "Mac \(index + 1)"
            )
            addTeardownBlock { @MainActor in
                Session.forget(computer.id)
                try? await controller.agentConnections.remove(computer.id)
            }
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let settings = SettingsViewController(context: context, computer: nil)
        let navigation = UINavigationController(rootViewController: settings)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
        }
        window.layoutIfNeeded()
        return (controller, settings, window)
    }

    /// Every row id on the page, card by card.
    private func rowIDs(_ settings: SettingsViewController) -> [[String]] {
        settings.shownRowIDs
    }

    func testOneCardListsEveryAccountAndConnectAgentUnderThem() async throws {
        let (controller, settings, window) = try await settings(connections: 2)
        try await Task.sleep(for: .milliseconds(300))
        settings.view.layoutIfNeeded()
        let cards = rowIDs(settings)
        let accounts = try XCTUnwrap(cards.first, "settings has no cards")

        // The accounts, then the one way to add: no second Add anywhere.
        XCTAssertEqual(accounts.filter { $0.hasPrefix("account:") }.count, 3, "two connections and the Happy account: \(accounts)")
        XCTAssertEqual(accounts.last, SettingsIndex.connectAgent.id, "Connect Agent sits under them")
        XCTAssertFalse(cards.joined().contains(SettingsIndex.addAccount.id), "a second Add is still on the page")
        XCTAssertEqual(cards.joined().filter { $0 == SettingsIndex.connectAgent.id }.count, 1, "Connect Agent appears twice")
        XCTAssertEqual(SettingsIndex.connectAgent.title, "Add Agent")
        XCTAssertEqual(SettingsIndex.connectAgent.glyph, "add-outline")
        XCTAssertFalse(cards.joined().contains("about"), "About must not require opening another page")
        for row in SettingsIndex.aboutRows {
            XCTAssertTrue(cards.joined().contains(row.id), "About row \(row.id) is missing from Settings")
        }

        // Exactly one tick, on the account actually being shown. A
        // signed-in Happy account and an open agent connection both call
        // themselves active, so this is the case that used to tick two.
        XCTAssertEqual(settings.tickedRowIDs.count, 1, "more than one account is ticked: \(settings.tickedRowIDs)")
        XCTAssertEqual(settings.tickedRowIDs.first, "account:\(try XCTUnwrap(settings.shownProfileID))", "the tick is not on the account the page shows")

        // The strip the circles used to live in has no room left.
        XCTAssertEqual(settings.stripFrame, .zero, "the carousel's strip is still laid out")
        try await Task.sleep(for: .milliseconds(200))
        capture(window, "settings-accounts")
        withExtendedLifetime(controller) {}
    }

    /// One account and no connection: the card is the account and Connect
    /// Agent, and nothing is odd about a list of one.
    func testOneAccountOnTheirOwn() async throws {
        let (controller, settings, window) = try await settings(connections: 0)
        try await Task.sleep(for: .milliseconds(300))
        settings.view.layoutIfNeeded()
        let accounts = try XCTUnwrap(rowIDs(settings).first)
        XCTAssertEqual(accounts.filter { $0.hasPrefix("account:") }.count, 1, "\(accounts)")
        XCTAssertEqual(settings.tickedRowIDs.count, 1, "\(settings.tickedRowIDs)")
        XCTAssertEqual(settings.tickedRowIDs.first, "account:\(try XCTUnwrap(settings.shownProfileID))")
        capture(window, "settings-accounts-one")
        withExtendedLifetime(controller) {}
    }

    // Connect Agent opening the scanner is NOT covered here: the test
    // host has no NSCameraUsageDescription, so presenting the camera kills
    // it. The scanner and the ways under its menu are covered in the real
    // app by StartUITests, which runs with the app's own Info.plist.
}
#endif
