#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct NoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct NoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// Low Power Mode: the braille loader keeps moving, the shimmer holds
/// still unless Settings › Appearance › Shimmer in Low Power Mode is on.
@MainActor
final class HostedLowPowerShimmerTests: XCTestCase {
    private var kept = false

    override func setUp() async throws {
        kept = ShimmerClock.shared.shimmersInLowPower
        ShimmerClock.shared.shimmersInLowPower = false
        ShimmerClock.shared.lowPowerOverride = true
    }

    override func tearDown() async throws {
        ShimmerClock.shared.lowPowerOverride = nil
        ShimmerClock.shared.shimmersInLowPower = kept
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

    private static func all<T: UIView>(_ type: T.Type, in view: UIView) -> [T] {
        view.subviews.flatMap { child in ((child as? T).map { [$0] } ?? []) + all(type, in: child) }
    }

    func testTheWorkingLineKeepsItsLoaderAndShimmersOnlyWhenAsked() async throws {
        let window = try await window()
        let line = WorkingView(frame: CGRect(x: 16, y: 100, width: 360, height: 24))
        window.addSubview(line)
        line.show(Activity(phase: .thinking, startedAt: Date().timeIntervalSince1970 * 1000))
        line.layoutIfNeeded()
        let loader = try XCTUnwrap(Self.all(BrailleView.self, in: line).first)
        let phase = try XCTUnwrap(Self.all(ShimmerLabel.self, in: line).first)
        XCTAssertTrue(loader.animating, "the loader holds still in Low Power Mode")
        XCTAssertFalse(phase.band.sweeps)
        ShimmerClock.shared.shimmersInLowPower = true
        XCTAssertTrue(phase.band.sweeps, "the setting doesn't reach a band on screen")
        XCTAssertTrue(loader.animating)
        ShimmerClock.shared.shimmersInLowPower = false
        XCTAssertFalse(phase.band.sweeps)
        // Reduce Motion stills the shimmer whatever the setting.
        ShimmerClock.shared.shimmersInLowPower = true
        ShimmerClock.shared.reduceMotionOverride = true
        defer { ShimmerClock.shared.reduceMotionOverride = nil }
        XCTAssertFalse(phase.band.sweeps)
    }

    /// The chat header's "Thinking" holds still in Low Power Mode and
    /// sweeps again the moment the setting goes on.
    func testTheChatHeaderStatusShimmersOnlyWhenAsked() async throws {
        let window = try await window()
        let header = ChatHeaderView()
        header.frame = CGRect(x: 0, y: 60, width: 393, height: ChatHeaderLayout.Metrics.height)
        window.addSubview(header)
        header.titleView.text = "Fix the login"
        header.status = Strings.HeaderStatus.all[4]
        header.statusShimmers = true
        header.layoutIfNeeded()
        XCTAssertFalse(header.statusSweeps)
        ShimmerClock.shared.shimmersInLowPower = true
        XCTAssertTrue(header.statusSweeps)
        ShimmerClock.shared.lowPowerOverride = false
        ShimmerClock.shared.shimmersInLowPower = false
        XCTAssertTrue(header.statusSweeps, "out of Low Power Mode the setting doesn't matter")
    }

    /// Kept on this phone in its own suite, off unless turned on.
    func testTheSettingIsTheDevicesOwn() {
        let store = LowPowerShimmer(storage: UserDefaultsStore(suiteName: LowPowerShimmer.suiteName))
        ShimmerClock.shared.shimmersInLowPower = true
        XCTAssertTrue(store.isEnabled)
        ShimmerClock.shared.shimmersInLowPower = false
        XCTAssertFalse(store.isEnabled)
    }

    /// A computer's Appearance page has it under Hide projects, and home's
    /// search knows it.
    func testAComputersAppearanceIndexesIt() throws {
        let ids = SettingsIndex.computer.map(\.id)
        let index = try XCTUnwrap(ids.firstIndex(of: SettingsIndex.shimmerInLowPower.id))
        XCTAssertEqual(ids[index - 1], SettingsIndex.hideProjects.id)
        XCTAssertEqual(HappyCore.Search.ranked(SettingsIndex.computer, query: "low power") { $0.title }.first?.id, SettingsIndex.shimmerInLowPower.id)
    }

    /// A Happy account's Appearance ends Display with the switch, off; it
    /// turns the setting on and off.
    func testAHappyAccountsAppearanceHasTheSwitch() async throws {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(), connector: NoSockets()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 6, count: 32)))
        let session = try XCTUnwrap(controller.session)
        let screen = SettingsAppearanceViewController(context: AppContext(account: controller, variant: .preview, version: "test"), session: session)
        let window = try await window()
        window.rootViewController = UINavigationController(rootViewController: screen)
        window.layoutIfNeeded()
        let rows = Self.all(ItemRowView.self, in: screen.view)
        XCTAssertEqual(rows.last?.title, Strings.LowPowerShimmer.title)
        let toggle = try XCTUnwrap(rows.last?.trailingView as? UISwitch)
        XCTAssertFalse(toggle.isOn)
        toggle.isOn = true
        toggle.sendActions(for: .valueChanged)
        XCTAssertTrue(ShimmerClock.shared.shimmersInLowPower)
        toggle.isOn = false
        toggle.sendActions(for: .valueChanged)
        XCTAssertFalse(ShimmerClock.shared.shimmersInLowPower)
        await controller.signOut()
    }
}
#endif
