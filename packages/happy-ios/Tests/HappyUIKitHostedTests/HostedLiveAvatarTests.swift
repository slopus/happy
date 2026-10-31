#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct LiveNoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct LiveNoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// Animated Avatars: off unless turned on in Settings › Appearance; on, a
/// placeholder on screen draws as its shader over its still picture, and
/// stops when the view shows something else or the setting goes off.
@MainActor
final class HostedLiveAvatarTests: XCTestCase {
    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: LiveAvatars.key)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: LiveAvatars.key)
        super.tearDown()
    }

    private func until(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition(), "timed out", file: file, line: line)
    }

    private func window() async throws -> UIWindow {
        let scene = try await hostedActiveScene()
        let original = scene.keyWindow
        let window = hostedKeyWindow(in: scene)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            original?.makeKey()
        }
        return window
    }

    private static func live(in view: UIView) -> LiveAvatarView? {
        if let live = view as? LiveAvatarView { return live }
        for subview in view.subviews { if let live = live(in: subview) { return live } }
        return nil
    }

    func testOffByDefault() async throws {
        XCTAssertFalse(LiveAvatars.isEnabled)
        let window = try await window()
        let avatar = AvatarView(frame: CGRect(x: 40, y: 120, width: 48, height: 48))
        avatar.content = .init(avatar: SessionAvatar(seed: "session-1"), style: .brutalist, monochrome: false)
        window.rootViewController?.view.addSubview(avatar)
        avatar.layoutIfNeeded()
        try await until { avatar.glyph.image != nil }
        XCTAssertNil(Self.live(in: avatar), "a still picture only")
    }

    /// Turned on, an avatar already on screen starts moving: its shader is
    /// drawn over the still picture and keeps being drawn. Turned off, it
    /// goes and the picture stays.
    func testAnAvatarOnScreenMovesWhileItIsOn() async throws {
        let renderer = try XCTUnwrap(AvatarShaderRenderer.shared, "no Metal")
        let window = try await window()
        let avatar = AvatarView(frame: CGRect(x: 40, y: 120, width: 48, height: 48))
        avatar.content = .init(avatar: SessionAvatar(seed: "session-1"), style: .brutalist, monochrome: false)
        window.rootViewController?.view.addSubview(avatar)
        avatar.layoutIfNeeded()
        try await until { avatar.glyph.image != nil }

        LiveAvatars.isEnabled = true
        let live = try XCTUnwrap(Self.live(in: avatar.glyph), "the shader goes over the still picture")
        XCTAssertEqual(live.index, AvatarPlaceholder.index(seed: "session-1"))
        XCTAssertEqual(live.frame, avatar.glyph.bounds)
        try await until { live.drawn && !live.isHidden }
        XCTAssertEqual(live.metalLayer.drawableSize.width, (48 * window.screen.scale).rounded(.up))
        // It keeps drawing: frames come at about 20 a second.
        let presented = renderer.presented
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertGreaterThan(renderer.presented - presented, 4, "it isn't moving")
        XCTAssertNotNil(avatar.glyph.image, "the still picture stays under it")

        // Another seed in the same view starts from its own picture.
        avatar.content = .init(avatar: SessionAvatar(seed: "session-2"), style: .brutalist, monochrome: true)
        avatar.layoutIfNeeded()
        XCTAssertEqual(live.index, AvatarPlaceholder.index(seed: "session-2"))
        XCTAssertTrue(live.monochrome)
        try await until { live.drawn && !live.isHidden }

        LiveAvatars.isEnabled = false
        XCTAssertNil(Self.live(in: avatar))
        XCTAssertNotNil(avatar.glyph.image)
    }

    /// Off screen, hidden or covered by a real picture, nothing is drawn.
    func testOnlyAPlaceholderInViewIsDrawn() async throws {
        let renderer = try XCTUnwrap(AvatarShaderRenderer.shared, "no Metal")
        LiveAvatars.isEnabled = true
        let window = try await window()
        let host = UIImageView(frame: CGRect(x: 40, y: 120, width: 40, height: 40))
        host.clipsToBounds = true
        window.rootViewController?.view.addSubview(host)
        let slot = AvatarPlaceholderSlot()
        slot.liveHost = host
        slot.show(seed: "person:ada", side: 40) { host.image = $0 }
        let live = try XCTUnwrap(slot.live)
        try await until { live.drawn }

        // Scrolled away: no more frames.
        host.frame.origin.y = -500
        try await Task.sleep(for: .milliseconds(150))
        let away = renderer.presented
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(renderer.presented, away, "drawn off screen")
        host.frame.origin.y = 120

        // A real picture over it: the shader goes.
        slot.liveSuppressed = true
        XCTAssertNil(slot.live)
        XCTAssertNil(Self.live(in: host))
        slot.liveSuppressed = false
        XCTAssertNotNil(slot.live)
        // The view shows something else.
        slot.cancel()
        XCTAssertNil(slot.live)
        XCTAssertNil(Self.live(in: host))
    }

    /// Settings › Appearance › Avatars has the switch, off, under Black &
    /// White Avatars; it turns the setting on and off.
    func testTheSettingIsInAppearance() async throws {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: LiveNoNetwork(), connector: LiveNoSockets()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 5, count: 32)))
        let session = try XCTUnwrap(controller.session)
        let screen = SettingsAppearanceViewController(context: AppContext(account: controller, variant: .preview, version: "test"), session: session)
        let window = try await window()
        window.rootViewController = UINavigationController(rootViewController: screen)
        window.layoutIfNeeded()
        let rows = Self.rows(in: screen.view)
        let titles = rows.map(\.title)
        let index = try XCTUnwrap(titles.firstIndex(of: Strings.LiveAvatars.title))
        XCTAssertEqual(titles[index - 1], Strings.SettingsAppearance.avatarMonochrome)
        let toggle = try XCTUnwrap(rows[index].trailingView as? UISwitch)
        XCTAssertFalse(toggle.isOn)
        toggle.isOn = true
        toggle.sendActions(for: .valueChanged)
        XCTAssertTrue(LiveAvatars.isEnabled)
        toggle.isOn = false
        toggle.sendActions(for: .valueChanged)
        XCTAssertFalse(LiveAvatars.isEnabled)
        await controller.signOut()
    }

    private static func rows(in view: UIView) -> [ItemRowView] {
        if let row = view as? ItemRowView { return [row] }
        return view.subviews.flatMap(rows)
    }
}
#endif
