#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import UltraView
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

/// The chat's keyboard on each renderer: UltraList under the floating dock
/// takes it from UltraView's keyboard integration (`ChatUltraKeyboard`);
/// UICollectionView, and UltraList docked, keep following the layout
/// guide.
///
/// A finger driving the keyboard needs the system's keyboard host, which a
/// test can't supply; `ChatScrollUITests` drives it on a phone. Here the
/// keyboard's frame notifications are posted by hand, outside any list
/// pass, so they apply at once.
@MainActor
final class HostedChatUltraKeyboardTests: XCTestCase {
    private let keyboardHeight: CGFloat = 320

    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private struct Chat {
        var controller: AccountController
        var navigation: UINavigationController
        var chat: LegacyChatViewController
        var list: ChatListView
        var dock: ChatDockView
    }

    /// The long fixture chat on `renderer`, pushed over a root screen, with
    /// its rows in.
    private func chat(_ renderer: ChatListRenderer) async throws -> Chat {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(),
            storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(),
            connector: NoSockets()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 5, count: 32)))
        let account = try XCTUnwrap(controller.session)
        controller.localSettings.chatListRenderer = renderer
        let context = AppContext(account: controller, variant: .development, version: "test")
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let chat = LegacyChatViewController(context: context, session: account, sessionId: FixtureScenarios.prefix + FixtureScenario.long.rawValue)
        let navigation = UINavigationController(rootViewController: UIViewController())
        navigation.pushViewController(chat, animated: false)
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
        }
        window.layoutIfNeeded()
        let constructed = try await until { chat.contentInstalled }
        XCTAssertTrue(constructed)
        let list = try XCTUnwrap(subview(ChatListView.self, in: chat.view))
        let dock = try XCTUnwrap(subview(ChatDockView.self, in: chat.view))
        let drawn = try await until { list.plans.count > 20 && list.isDisplayReady }
        XCTAssertTrue(drawn, "the fixture's rows never landed")
        chat.view.layoutIfNeeded()
        return Chat(controller: controller, navigation: navigation, chat: chat, list: list, dock: dock)
    }

    private func until(seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        return condition()
    }

    private func subview<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        for child in view.subviews {
            if let match = child as? T { return match }
            if let match = subview(type, in: child) { return match }
        }
        return nil
    }

    /// A docked keyboard `keyboardHeight` tall, coming up or going down.
    private func post(_ name: Notification.Name, up: Bool, in window: UIWindow) {
        let bounds = window.screen.bounds
        let shown = CGRect(x: 0, y: bounds.maxY - keyboardHeight, width: bounds.width, height: keyboardHeight)
        let hidden = shown.offsetBy(dx: 0, dy: keyboardHeight)
        NotificationCenter.default.post(name: name, object: nil, userInfo: [
            UIResponder.keyboardFrameBeginUserInfoKey: NSValue(cgRect: up ? hidden : shown),
            UIResponder.keyboardFrameEndUserInfoKey: NSValue(cgRect: up ? shown : hidden),
            UIResponder.keyboardAnimationDurationUserInfoKey: 0.25,
            UIResponder.keyboardAnimationCurveUserInfoKey: 7,
        ])
    }

    private func resting(_ chat: LegacyChatViewController) -> CGFloat {
        chat.view.bounds.height - chat.view.safeAreaInsets.bottom
    }

    /// Only UltraList has UltraView's keyboard, bound to the list it
    /// renders with. Leaving UltraList drops it; coming back makes a new
    /// one for the new list.
    func testOnlyTheUltraListRendererHasUltraViewsKeyboard() async throws {
        let test = try await chat(.ultraList)
        let keyboard = try XCTUnwrap(test.chat.ultraKeyboard, "UltraList has UltraView's keyboard")
        let firstList = try XCTUnwrap(test.list.ultra?.list)
        XCTAssertTrue(keyboard.list === firstList)
        XCTAssertTrue(keyboard.isActive, "the shown chat's keyboard works")
        XCTAssertFalse(keyboard.isDriving)

        // The setting changes while another screen covers the chat.
        test.navigation.pushViewController(UIViewController(), animated: false)
        test.controller.localSettings.chatListRenderer = .collectionView
        _ = try await until { !keyboard.isActive }
        test.navigation.popViewController(animated: false)
        _ = try await until { test.chat.ultraKeyboard == nil }
        XCTAssertNil(test.list.ultra)
        XCTAssertNil(test.chat.ultraKeyboard, "UICollectionView has no UltraView keyboard")

        let cover = UIViewController()
        test.navigation.pushViewController(cover, animated: false)
        test.controller.localSettings.chatListRenderer = .ultraList
        _ = try await until { test.navigation.topViewController === cover && test.chat.view.window == nil }
        test.navigation.popViewController(animated: false)
        _ = try await until { test.chat.ultraKeyboard?.isActive == true }
        let again = try XCTUnwrap(test.chat.ultraKeyboard)
        XCTAssertFalse(again === keyboard)
        XCTAssertTrue(again.list === test.list.ultra?.list)
        XCTAssertTrue(again.isActive)
        XCTAssertFalse(keyboard.isActive, "the dropped keyboard stays stopped")
    }

    /// A covered chat's keyboard is stopped: layouts and keyboard frames
    /// while it is covered change nothing, and only its appearance starts
    /// it again, reading the keyboard afresh.
    func testACoveredChatIgnoresTheKeyboardUntilItAppearsAgain() async throws {
        let test = try await chat(.ultraList)
        let window = try XCTUnwrap(test.chat.view.window)
        let keyboard = try XCTUnwrap(test.chat.ultraKeyboard)
        let dock = test.dock.frame
        let height = keyboard.height

        test.navigation.pushViewController(UIViewController(), animated: false)
        let stopped = try await until { !keyboard.isActive }
        XCTAssertTrue(stopped, "the covered chat's keyboard stopped")
        post(UIResponder.keyboardWillChangeFrameNotification, up: true, in: window)
        test.chat.view.setNeedsLayout()
        test.chat.view.layoutIfNeeded()
        XCTAssertFalse(keyboard.isActive, "a layout doesn't start it")
        XCTAssertEqual(keyboard.height, height, "a covered chat doesn't follow the keyboard")
        XCTAssertEqual(test.dock.frame, dock)

        test.navigation.popViewController(animated: false)
        let started = try await until { keyboard.isActive }
        XCTAssertTrue(test.chat.ultraKeyboard === keyboard)
        XCTAssertTrue(started, "appearing starts it again")
        test.chat.view.layoutIfNeeded()
        // No software keyboard came up in the test: the guide says down.
        XCTAssertEqual(test.dock.frame.maxY, resting(test.chat), accuracy: 0.5)
        post(UIResponder.keyboardWillChangeFrameNotification, up: true, in: window)
        XCTAssertEqual(test.dock.frame.maxY, test.chat.view.bounds.height - keyboardHeight, accuracy: 0.5, "the shown chat follows the keyboard again")
        post(UIResponder.keyboardWillChangeFrameNotification, up: false, in: window)
    }

    /// What rides the dock and moves on the list's keyboard motion.
    private func riders(_ test: Chat) throws -> [UIView] {
        [test.dock, try XCTUnwrap(subview(ChatScrollButton.self, in: test.chat.view)),
         try XCTUnwrap(subview(ChatScrimView.self, in: test.chat.view)), try XCTUnwrap(subview(ChatPlaceholderView.self, in: test.chat.view))]
    }

    private func animating(_ views: [UIView]) -> [String] {
        views.flatMap { view in (view.layer.animationKeys() ?? []).map { "\(type(of: view)).\($0)" } }
    }

    /// A keyboard on its way carries the dock on the list's motion. Covered
    /// halfway, the chat lands it, and the renderer can then change under
    /// it with nothing left moving.
    func testACoveredChatLandsTheDockMidKeyboardAndCanSwitchRenderer() async throws {
        let test = try await chat(.ultraList)
        let window = try XCTUnwrap(test.chat.view.window)
        post(UIResponder.keyboardWillChangeFrameNotification, up: true, in: window)
        XCTAssertFalse(test.dock.layer.animationKeys()?.isEmpty ?? true, "the dock moves on the list's motion")

        test.navigation.pushViewController(UIViewController(), animated: false)
        let stopped = try await until { test.chat.ultraKeyboard?.isActive == false }
        XCTAssertTrue(stopped)
        XCTAssertEqual(animating(try riders(test)), [], "the covered chat landed what rode the dock")

        test.controller.localSettings.chatListRenderer = .collectionView
        test.navigation.popViewController(animated: false)
        let switched = try await until { test.list.ultra == nil && test.chat.ultraKeyboard == nil }
        XCTAssertTrue(switched)
        XCTAssertEqual(animating(try riders(test)), [])
        XCTAssertEqual(test.dock.frame.maxY, resting(test.chat), accuracy: 0.5, "the guide's dock, on the safe area")
    }

    /// The chat leaving the navigation mid-keyboard lands what rode the
    /// dock.
    func testAChatPoppedMidKeyboardLandsTheDock() async throws {
        let test = try await chat(.ultraList)
        let window = try XCTUnwrap(test.chat.view.window)
        let riders = try riders(test)
        post(UIResponder.keyboardWillChangeFrameNotification, up: true, in: window)
        XCTAssertFalse(test.dock.layer.animationKeys()?.isEmpty ?? true)
        test.navigation.popViewController(animated: false)
        let gone = try await until { test.chat.parent == nil && test.chat.ultraKeyboard == nil }
        XCTAssertTrue(gone)
        XCTAssertEqual(animating(riders), [])
    }

    /// Docked, the list's frame follows the keyboard, which UltraView
    /// can't carry yet: UltraList keeps the layout guide there, and gets
    /// UltraView's keyboard back once the dock floats again.
    func testTheDockedLayoutKeepsTheLayoutGuideOnUltraList() async throws {
        let test = try await chat(.ultraList)
        let window = try XCTUnwrap(test.chat.view.window)
        let floating = try XCTUnwrap(test.chat.ultraKeyboard)

        test.navigation.traitOverrides.isTabletLayout = true
        let docked = try await until {
            test.chat.view.layoutIfNeeded()
            return test.chat.ultraKeyboard == nil
        }
        XCTAssertTrue(docked, "no UltraView keyboard under a docked layout")
        XCTAssertNotNil(test.list.ultra, "still UltraList")
        XCTAssertFalse(floating.isActive)
        let dock = test.dock.frame
        post(UIResponder.keyboardWillChangeFrameNotification, up: true, in: window)
        test.chat.view.setNeedsLayout()
        test.chat.view.layoutIfNeeded()
        XCTAssertEqual(test.dock.frame, dock, "a posted frame doesn't move the guide's dock")
        post(UIResponder.keyboardWillChangeFrameNotification, up: false, in: window)

        test.navigation.traitOverrides.isTabletLayout = false
        let back = try await until {
            test.chat.view.layoutIfNeeded()
            return test.chat.ultraKeyboard?.isActive == true
        }
        XCTAssertTrue(back, "the floating dock has UltraView's keyboard again")
        XCTAssertFalse(test.chat.ultraKeyboard === floating)
    }

    func testTheCollectionViewRendererHasNoUltraViewKeyboard() async throws {
        let test = try await chat(.collectionView)
        XCTAssertNil(test.list.ultra)
        XCTAssertNil(test.chat.ultraKeyboard)
    }

    /// A keyboard frame puts UltraList's dock on the keyboard, and the
    /// list's newest inset follows on the keyboard's transition; the hide
    /// puts both back on the safe area.
    func testAKeyboardFrameMovesTheUltraListDockAndInset() async throws {
        let test = try await chat(.ultraList)
        let window = try XCTUnwrap(test.chat.view.window)
        let ultra = try XCTUnwrap(test.list.ultra?.list)
        let height = test.chat.view.bounds.height
        XCTAssertEqual(test.dock.frame.maxY, resting(test.chat), accuracy: 0.5)
        let passes = ultra.appliedPassCount

        post(UIResponder.keyboardWillChangeFrameNotification, up: true, in: window)
        XCTAssertEqual(test.dock.frame.maxY, height - keyboardHeight, accuracy: 0.5, "the dock sits on the keyboard")
        // The library's inset-only pass, which keeps a viewport curve, not
        // a full pass.
        XCTAssertEqual(ultra.appliedPassCount, passes, "the keyboard moved the inset without a full list pass")
        XCTAssertEqual(test.list.contentInsets.top, height - test.dock.frame.minY + LegacyChatScreenLayout.Metrics.newerEdgeExtra, accuracy: 0.5)
        XCTAssertEqual(ultra.viewportInsets.top, Double(test.list.contentInsets.top), accuracy: 0.5)
        // The rows are still on their way to the new inset.
        let index = try XCTUnwrap(ultra.loadedIndexRange.first)
        let settled = try XCTUnwrap(ultra.settledFrame(at: index))
        let presented = try XCTUnwrap(ultra.presentedFrame(at: index))
        XCTAssertGreaterThan(abs(presented.minY - settled.minY), 1, "the inset moves on the keyboard's transition")

        // A later layout keeps the dock where the keyboard put it.
        test.chat.view.setNeedsLayout()
        test.chat.view.layoutIfNeeded()
        XCTAssertEqual(test.dock.frame.maxY, height - keyboardHeight, accuracy: 0.5)

        post(UIResponder.keyboardWillChangeFrameNotification, up: false, in: window)
        post(UIResponder.keyboardDidHideNotification, up: false, in: window)
        let down = try await until { abs(self.resting(test.chat) - test.dock.frame.maxY) < 0.5 }
        XCTAssertTrue(down, "the dock is back on the safe area, at \(test.dock.frame.maxY)")
        XCTAssertEqual(test.list.contentInsets.top, height - test.dock.frame.minY + LegacyChatScreenLayout.Metrics.newerEdgeExtra, accuracy: 0.5)
    }

    /// The same notification on UICollectionView changes nothing: that
    /// renderer reads the layout guide, which a posted frame doesn't move.
    func testAKeyboardFrameAloneLeavesTheCollectionViewDockAlone() async throws {
        let test = try await chat(.collectionView)
        let window = try XCTUnwrap(test.chat.view.window)
        let dock = test.dock.frame
        let inset = test.list.contentInsets
        post(UIResponder.keyboardWillChangeFrameNotification, up: true, in: window)
        test.chat.view.setNeedsLayout()
        test.chat.view.layoutIfNeeded()
        XCTAssertEqual(test.dock.frame, dock)
        XCTAssertEqual(test.list.contentInsets, inset)
        post(UIResponder.keyboardWillChangeFrameNotification, up: false, in: window)
    }
}
#endif
