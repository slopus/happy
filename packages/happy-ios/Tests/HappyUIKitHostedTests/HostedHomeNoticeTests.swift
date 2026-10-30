#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyStore
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

/// A relay account's home with nothing to list shows a notice in place of
/// the list, under home's own bar, and changes it in place as the
/// computers become known: connecting, no computer, every computer
/// offline. Never Welcome or a screen of its own. A fixture account in a
/// test window, no network. Pictures, light and dark, go to the
/// repository's `.context/evidence/home-notice` when that folder's parent
/// exists.
@MainActor
final class HostedHomeNoticeTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("evidence/home-notice")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

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

    private func subview<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        for child in view.subviews {
            if let match = child as? T { return match }
            if let match = subview(type, in: child) { return match }
        }
        return nil
    }

    private func until(seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }

    /// In the simulator's own appearance (`xcrun simctl ui <id> appearance
    /// dark`): an overridden window style leaves the bar's glass behind.
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

    private func machine(online: Bool) -> MachineRecord {
        MachineRecord(
            id: "m", seq: 1, createdAt: 1, updatedAt: 1, active: online, activeAt: 1,
            metadataVersion: 1, metadataCipher: "", metadata: .object(["host": .string("Steves-MacBook-Pro.local")]),
            daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil,
            dataKeyCipher: nil, decryptable: true
        )
    }

    func testANoticeInHomeWhileItHasNothingToList() async throws {
        let controller = try await signedIn()
        let account = try XCTUnwrap(controller.session)
        let context = AppContext(account: controller, variant: .production, version: "test")
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let home = LegacyHomeViewController(context: context, session: account)
        let navigation = UINavigationController(rootViewController: home)
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
        }
        window.layoutIfNeeded()

        func notice() -> HomeNoticeViewController? { home.children.compactMap { $0 as? HomeNoticeViewController }.first }

        // Before the computers are known: the notice, with nothing in it.
        let shown = try await until { notice() != nil }
        XCTAssertTrue(shown, "no notice before the computers are known")
        XCTAssertEqual(notice()?.kind, .connecting)
        XCTAssertFalse(navigation.isNavigationBarHidden, "home keeps its bar")
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual((subview(NoSessionsView.self, in: home.view)?.artwork as? StateSceneView)?.scene, .snail, "connecting is not the snail")
        capture(window, "1-connecting")
        let first = try XCTUnwrap(notice())

        // Known, and none: scan one's code.
        try await Task.detached { try account.store.setCursor(.machinesLastSync, 1) }.value
        let none = try await until { notice()?.kind == .noComputer }
        XCTAssertTrue(none, "no computer, no notice to scan one")
        let view = try XCTUnwrap(subview(NoSessionsView.self, in: home.view))
        XCTAssertLessThanOrEqual(view.scrollView.contentSize.height, view.bounds.height + 0.5, "the notice scrolls before any picture")
        XCTAssertEqual(view.titleLabel.string, Strings.Home.noComputerTitle)
        XCTAssertEqual(view.startNewSession.title, Strings.scanQRCode)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual((view.artwork as? StateSceneView)?.scene, .wand, "no computer is not the wand")
        capture(window, "2-no-computer")

        // One computer, offline: its name, and Troubleshoot.
        let offline = machine(online: false)
        try await Task.detached { try account.store.upsertMachine(offline) }.value
        let offlineShown = try await until {
            if case .offline? = notice()?.kind { return true }
            return false
        }
        XCTAssertTrue(offlineShown, "an offline computer, no offline notice")
        XCTAssertEqual(view.descriptionLabel.string, Strings.Home.offlineDescription)
        XCTAssertEqual(view.startNewSession.title, Strings.Troubleshoot.title)
        XCTAssertTrue(notice() === first, "the notice changes in place")
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertNil(view.artwork, "offline keeps its plain glyph, as desktop does")
        // The picture sits in the glyph's own box, so the notice must not
        // have started to scroll.
        XCTAssertLessThanOrEqual(view.scrollView.contentSize.height, view.bounds.height + 0.5, "the notice began to scroll")
        capture(window, "3-offline")
        withExtendedLifetime(controller) {}
    }
}
#endif
