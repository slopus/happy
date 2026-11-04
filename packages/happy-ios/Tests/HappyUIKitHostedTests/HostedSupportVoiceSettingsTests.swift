#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct VoiceOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct VoiceNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A computer that answers only the profile, as happy-agent does.
private actor VoiceDaemon: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        guard method == "GET", path == "/v0/profile" else {
            return HTTP1Response(status: 404, body: Data(#"{"error":"Not here.","code":"not_found"}"#.utf8))
        }
        return HTTP1Response(status: 200, body: Data(#"{"profile":{"email":null,"name":"Alex Rivera","photo":null,"userId":null,"updatedAt":1,"version":"0199a000-0000-7000-8000-000000000001"}}"#.utf8))
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.cannotConnectToHost) }
    func reset() async {}
    func close() async {}
}

/// An agent connection's Support Happy row under Profile, its Voice row
/// and page. Pictures go to the repository's `.context/evidence/support-voice`.
@MainActor
final class HostedSupportVoiceSettingsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("evidence/support-voice")
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

    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<100 where !condition() { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertTrue(condition(), "never came")
    }

    private struct Rig {
        let controller: AccountController
        let context: AppContext
        let computerID: String
    }

    private func rig() async throws -> Rig {
        let daemon = VoiceDaemon()
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in daemon },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: VoiceOffline(), connector: VoiceNoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let computer = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"voice-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Studio Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await controller.agentConnections.remove(computer.id)
        }
        return Rig(controller: controller, context: AppContext(account: controller, variant: .preview, version: "test"), computerID: computer.id)
    }

    /// `width` narrows the window, as a small phone or Display Zoom does.
    private func host(_ root: UIViewController, style: UIUserInterfaceStyle = .light, width: CGFloat? = nil, size: UIContentSizeCategory? = nil) async throws -> (UINavigationController, UIWindow) {
        let navigation = UINavigationController(rootViewController: root)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: navigation)
        window.overrideUserInterfaceStyle = style
        if let size { window.traitOverrides.preferredContentSizeCategory = size }
        if let width { window.frame = CGRect(x: 0, y: 0, width: width, height: window.frame.height) }
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
        }
        window.layoutIfNeeded()
        return (navigation, window)
    }

    private static func status(_ remaining: Double, offer: CallOffer = .unavailable) -> AgentVoiceStatus {
        AgentVoiceStatus(remaining: remaining, freeAgain: remaining > 0 ? nil : Date().addingTimeInterval(5 * 86_400), offer: offer)
    }

    private func subview<T: UIView>(_ type: T.Type, in view: UIView, where match: (T) -> Bool = { _ in true }) -> T? {
        if let view = view as? T, match(view) { return view }
        for child in view.subviews { if let found = subview(type, in: child, where: match) { return found } }
        return nil
    }

    private func settings(_ rig: Rig, remaining: Double = 12 * 60 + 20) -> SettingsViewController {
        let settings = SettingsViewController(context: rig.context, computer: rig.computerID)
        settings.voiceStatus = { Self.status(remaining) }
        return settings
    }

    /// The row the boba leads, as drawn: two rows tall at least, the boba
    /// its one size, and every word inside the row.
    private func checkSupportRow(_ settings: SettingsViewController, file: StaticString = #filePath, line: UInt = #line) throws {
        let row = try XCTUnwrap(subview(SettingsCardView.RowView.self, in: settings.view) { $0.accessibilityIdentifier == "settings:support-boba" }, file: file, line: line)
        let art = try XCTUnwrap(subview(SupportBobaArt.self, in: row), file: file, line: line)
        XCTAssertEqual(art.frame.size, CGSize(width: 72, height: 72), file: file, line: line)
        XCTAssertGreaterThanOrEqual(row.bounds.height, 2 * SettingsLayout.Metrics.row, file: file, line: line)
        XCTAssertEqual(art.frame.minX, 16, file: file, line: line)
        for label in row.subviews.compactMap({ $0 as? UILabel }) where !label.isHidden && !(label.text ?? "").isEmpty {
            let needed = label.sizeThatFits(CGSize(width: label.bounds.width, height: .greatestFiniteMagnitude)).height
            XCTAssertLessThanOrEqual(needed, label.bounds.height + 1, "\(label.text ?? "") is clipped", file: file, line: line)
            XCTAssertLessThanOrEqual(label.frame.maxY, row.bounds.height, file: file, line: line)
        }
        XCTAssertEqual(row.accessibilityLabel, Strings.AgentVoice.supportSpoken, file: file, line: line)
        XCTAssertTrue(row.accessibilityTraits.contains(.button), file: file, line: line)
    }

    func testSupportHappySitsUnderProfileAndVoiceSaysTheTimeLeft() async throws {
        let rig = try await rig()
        for style in [UIUserInterfaceStyle.light, .dark] {
            let settings = settings(rig)
            let (navigation, window) = try await host(settings, style: style)
            try await until { settings.shownRow("profile")?.value == "Alex Rivera" }
            let cards = settings.shownRowIDs
            XCTAssertEqual(cards.firstIndex(of: ["profile"]), 1)
            XCTAssertEqual(cards.firstIndex(of: ["support-boba"]), 2, "Support Happy is not right under Profile: \(cards)")
            XCTAssertEqual(settings.shownRow("agent-voice")?.value, "12 min left")
            XCTAssertEqual(settings.shownRow("support-boba")?.title, "Support by sending us boba every month")
            XCTAssertEqual(settings.shownRow("support-boba")?.subtitle, "and get 5 hrs of voice")
            window.layoutIfNeeded()
            try checkSupportRow(settings)
            // Let the boba play out and hold.
            try await Task.sleep(for: .seconds(3.2))
            capture(window, "settings")

            settings.tapRow("support-boba")
            try await until { navigation.topViewController is AgentVoiceViewController && navigation.transitionCoordinator == nil }
            try await Task.sleep(for: .milliseconds(400))
            capture(window, "voice-page")
            withExtendedLifetime(navigation) {}
            window.isHidden = true
        }
    }

    /// A 320-wide phone and the largest text sizes: the words wrap, the row
    /// grows, the boba stays 72 and nothing is cut.
    func testNarrowAndLargeTextWrapWithoutClipping() async throws {
        let rig = try await rig()
        for (name, width, size) in [
            ("narrow", CGFloat(320), UIContentSizeCategory.large),
            ("large-text", nil, UIContentSizeCategory.accessibilityExtraLarge),
            ("narrow-large-text", CGFloat(320), UIContentSizeCategory.accessibilityExtraExtraExtraLarge),
        ] as [(String, CGFloat?, UIContentSizeCategory)] {
            let settings = settings(rig)
            let (navigation, window) = try await host(settings, width: width, size: size)
            try await until { settings.shownRow("profile")?.value == "Alex Rivera" }
            window.layoutIfNeeded()
            try checkSupportRow(settings)
            // The card under Profile in view.
            settings.view.layoutIfNeeded()
            if let row = subview(SettingsCardView.RowView.self, in: settings.view, where: { $0.accessibilityIdentifier == "settings:profile" }),
               let scroll = subview(UIScrollView.self, in: settings.view) {
                let y = row.convert(row.bounds, to: scroll).minY - scroll.adjustedContentInset.top - 24
                scroll.setContentOffset(CGPoint(x: 0, y: max(-scroll.adjustedContentInset.top, y)), animated: false)
            }
            try await Task.sleep(for: .seconds(3.2))
            capture(window, "settings-\(name)")
            withExtendedLifetime(navigation) {}
            window.isHidden = true
        }
    }

    /// The Voice page with the free time used, and with the debug preview
    /// of the subscription: never a paid status, a price only in preview.
    func testVoicePageStates() async throws {
        for (name, status) in [
            ("fresh", Self.status(20 * 60)),
            ("used", Self.status(0)),
            ("preview", Self.status(12 * 60 + 20, offer: .preview(price: CallOffer.price))),
        ] {
            let page = AgentVoiceViewController(status: { status })
            let (navigation, window) = try await host(page)
            XCTAssertEqual(page.shownRow("voice-plan")?.value, "Free")
            XCTAssertEqual(page.shownRow("voice-restore")?.dimmed, true)
            switch name {
            case "used":
                XCTAssertEqual(page.shownRow("voice-left")?.value, "Used up")
                XCTAssertNotNil(page.shownRow("voice-back"))
                XCTAssertEqual(page.shownRow("voice-subscribe")?.value, "Not on sale yet")
            case "preview":
                XCTAssertEqual(page.shownRow("voice-subscribe")?.value, "$20/month")
                XCTAssertNotNil(page.shownRow("voice-subscribe")?.action)
            default:
                XCTAssertEqual(page.shownRow("voice-left")?.value, "20 min")
                XCTAssertNil(page.shownRow("voice-subscribe")?.action, "something is on sale")
            }
            try await Task.sleep(for: .milliseconds(300))
            capture(window, "voice-page-\(name)")
            if name == "preview" {
                // While free time is left the sheet is the welcome, never the used warning.
                page.tapRow("voice-subscribe")
                try await until { page.presentedViewController is CallSheetViewController }
                let sheet = try XCTUnwrap(page.presentedViewController as? CallSheetViewController)
                XCTAssertEqual(sheet.screen, .welcome(offer: .preview(price: CallOffer.price)))
                try await Task.sleep(for: .seconds(1))
                capture(window, "voice-offer-sheet")
                sheet.dismiss(animated: false)
            }
            withExtendedLifetime(navigation) {}
            window.isHidden = true
        }
    }

    /// The boba playing, frame by frame (about 12 a second) from its first
    /// appearance to its held last frame, for the motion capture; and its
    /// drawing never leaves its own square.
    func testBobaFrames() async throws {
        let rig = try await rig()
        for style in [UIUserInterfaceStyle.light, .dark] {
            let settings = settings(rig)
            let (navigation, window) = try await host(settings, style: style)
            try await until { settings.shownRow("profile")?.value == "Alex Rivera" }
            let row = try XCTUnwrap(subview(SettingsCardView.RowView.self, in: settings.view) { $0.accessibilityIdentifier == "settings:support-boba" })
            let art = try XCTUnwrap(subview(SupportBobaArt.self, in: row))
            let card = try XCTUnwrap(row.superview)
            let box = card.convert(card.bounds, to: window).insetBy(dx: -16, dy: -16)
            let started = Date()
            var index = 0
            while Date().timeIntervalSince(started) < 3.6 {
                let image = UIGraphicsImageRenderer(bounds: box).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                if let folder = Self.evidence, let data = image.pngData() {
                    let frames = folder.appendingPathComponent("frames-\(style == .dark ? "dark" : "light")")
                    try? FileManager.default.createDirectory(at: frames, withIntermediateDirectories: true)
                    try? data.write(to: frames.appendingPathComponent(String(format: "%03d.png", index)))
                }
                index += 1
                try await Task.sleep(for: .milliseconds(80))
            }
            XCTAssertEqual(art.frame.size, CGSize(width: 72, height: 72))
            withExtendedLifetime(navigation) {}
            window.isHidden = true
        }
    }
}
#endif
