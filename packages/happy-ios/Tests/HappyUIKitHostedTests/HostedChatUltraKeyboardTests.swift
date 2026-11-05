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

/// The chat's keyboard: the list takes it from UltraView's
/// keyboard integration (`ChatUltraKeyboard`), under the floating dock and
/// docked alike.
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
        /// The split shell the chat is in, when it is the iPad's.
        var shell: ShellViewController?
    }

    /// The long fixture chat, pushed over a root screen, with its rows in:
    /// on a bare stack, or `inShell` as the app opens it, in the split
    /// shell's main panel beside the sidebar.
    private func chat(inShell: Bool = false) async throws -> Chat {
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
        let context = AppContext(account: controller, variant: .development, version: "test")
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let chat = LegacyChatViewController(context: context, session: account, sessionId: FixtureScenarios.prefix + FixtureScenario.long.rawValue)
        let root = UIViewController()
        var navigation = UINavigationController(rootViewController: root)
        navigation.pushViewController(chat, animated: false)
        var shell: ShellViewController?
        let window: UIWindow
        if inShell {
            let phone = UINavigationController()
            let split = ShellViewController(context: context, phone: phone)
            window = hostedKeyWindow(in: scene, root: split)
            split.view.layoutIfNeeded()
            // The split splits only under home, as the app's does.
            split.setStack([LegacyHomeViewController(context: context, session: account), chat], animated: false)
            navigation = split.main
            shell = split
        } else {
            // A phone's stack, as the shell's is below 768: on an iPad the
            // regular width would dock the list.
            navigation.traitOverrides.horizontalSizeClass = .compact
            window = hostedKeyWindow(in: scene, root: navigation)
        }
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
        return Chat(controller: controller, navigation: navigation, chat: chat, list: list, dock: dock, shell: shell)
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

    /// The shown chat has UltraView's keyboard, bound to the list it
    /// renders with.
    func testTheShownChatHasUltraViewsKeyboard() async throws {
        let test = try await chat()
        let keyboard = try XCTUnwrap(test.chat.ultraKeyboard)
        XCTAssertTrue(keyboard.list === test.list.ultra.list)
        XCTAssertTrue(keyboard.isActive, "the shown chat's keyboard works")
        XCTAssertFalse(keyboard.isDriving)
    }

    /// A covered chat's keyboard is stopped: layouts and keyboard frames
    /// while it is covered change nothing, and only its appearance starts
    /// it again, reading the keyboard afresh.
    func testACoveredChatIgnoresTheKeyboardUntilItAppearsAgain() async throws {
        let test = try await chat()
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

    /// The keyboard read off the guide at rest covers nothing. The guide
    /// rests on the safe area, which a turn or a resized window changes,
    /// and the dock rests on the new one.
    func testAKeyboardReadAtRestFollowsANewSafeArea() async throws {
        let test = try await chat()
        let keyboard = try XCTUnwrap(test.chat.ultraKeyboard)
        test.chat.additionalSafeAreaInsets.bottom = 40
        test.navigation.pushViewController(UIViewController(), animated: false)
        let stopped = try await until { !keyboard.isActive }
        XCTAssertTrue(stopped)
        test.navigation.popViewController(animated: false)
        let started = try await until { keyboard.isActive }
        XCTAssertTrue(started, "appearing reads the guide afresh")
        test.chat.view.layoutIfNeeded()
        XCTAssertEqual(test.dock.frame.maxY, resting(test.chat), accuracy: 0.5)
        XCTAssertEqual(keyboard.height, 0, "the guide at rest covers nothing")

        test.chat.additionalSafeAreaInsets.bottom = 0
        test.chat.view.layoutIfNeeded()
        XCTAssertEqual(test.dock.frame.maxY, resting(test.chat), accuracy: 0.5, "the dock rests on the new safe area")
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
    /// halfway, the chat lands it, and comes back with nothing left moving.
    func testACoveredChatLandsTheDockMidKeyboard() async throws {
        let test = try await chat()
        let window = try XCTUnwrap(test.chat.view.window)
        post(UIResponder.keyboardWillChangeFrameNotification, up: true, in: window)
        XCTAssertFalse(test.dock.layer.animationKeys()?.isEmpty ?? true, "the dock moves on the list's motion")

        test.navigation.pushViewController(UIViewController(), animated: false)
        let stopped = try await until { test.chat.ultraKeyboard?.isActive == false }
        XCTAssertTrue(stopped)
        XCTAssertEqual(animating(try riders(test)), [], "the covered chat landed what rode the dock")

        post(UIResponder.keyboardWillChangeFrameNotification, up: false, in: window)
        test.navigation.popViewController(animated: false)
        let back = try await until { test.chat.ultraKeyboard?.isActive == true }
        XCTAssertTrue(back)
        test.chat.view.layoutIfNeeded()
        XCTAssertEqual(animating(try riders(test)), [])
        XCTAssertEqual(test.dock.frame.maxY, resting(test.chat), accuracy: 0.5, "the dock, on the safe area")
    }

    /// The chat leaving the navigation mid-keyboard lands what rode the
    /// dock.
    func testAChatPoppedMidKeyboardLandsTheDock() async throws {
        let test = try await chat()
        let window = try XCTUnwrap(test.chat.view.window)
        let riders = try riders(test)
        post(UIResponder.keyboardWillChangeFrameNotification, up: true, in: window)
        XCTAssertFalse(test.dock.layer.animationKeys()?.isEmpty ?? true)
        test.navigation.popViewController(animated: false)
        let gone = try await until { test.chat.parent == nil && test.chat.ultraKeyboard == nil }
        XCTAssertTrue(gone)
        XCTAssertEqual(animating(riders), [])
    }

    /// In the iPad's main panel, keyboard frames move the dock and newest
    /// inset while the list keeps its frame. Narrowing the shell keeps the
    /// same keyboard integration under the floating dock.
    func testTheDockedLayoutMovesTheListsInsetWithUltraViewsKeyboard() async throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "an iPad's split view")
        let test = try await chat(inShell: true)
        let shell = try XCTUnwrap(test.shell)
        let window = try XCTUnwrap(test.chat.view.window)
        let wide = window.bounds.width
        try XCTSkipUnless(wide >= 768, "the split shell needs at least 768 points")
        func resize(_ width: CGFloat) {
            window.frame = CGRect(x: 0, y: 0, width: width, height: window.bounds.height)
            window.layoutIfNeeded()
        }

        // Narrow: one stack, the chat on top, the dock floating.
        resize(700)
        let narrow = try await until {
            window.layoutIfNeeded()
            return !shell.isExpanded && shell.phone.topViewController === test.chat && test.chat.ultraKeyboard?.isActive == true
        }
        XCTAssertTrue(narrow, "a narrow window floats the dock on UltraView's keyboard")
        let backdrop = try XCTUnwrap(subview(ChatScrimView.self, in: test.chat.view))

        // Wide: the chat in the main panel, docked under the bar.
        resize(wide)
        let docked = try await until {
            window.layoutIfNeeded()
            return shell.isExpanded && shell.main.viewControllers.contains(test.chat) && test.chat.ultraKeyboard?.isActive == true
        }
        XCTAssertTrue(docked, "the docked main panel keeps UltraView's keyboard")
        XCTAssertFalse(test.chat.navigationItem.hidesBackButton, "the main panel keeps the phone's back button")
        XCTAssertTrue(test.chat.navigationItem.titleView is ChatHeaderView, "and its glass title")
        XCTAssertNotNil(test.chat.ultraKeyboard)
        let height = test.chat.view.bounds.height
        let list = test.list.frame
        XCTAssertEqual(list.maxY, test.dock.frame.minY, accuracy: 0.5, "at rest the list stops at the dock")

        post(UIResponder.keyboardWillChangeFrameNotification, up: true, in: window)
        XCTAssertEqual(test.dock.frame.maxY, height - keyboardHeight, accuracy: 0.5, "the dock sits on the keyboard")
        XCTAssertEqual(test.list.frame, list, "the list's frame stays where the dock rests")
        XCTAssertEqual(test.list.contentInsets.bottom, list.maxY - test.dock.frame.minY + LegacyChatScreenLayout.Metrics.newerEdgeExtra, accuracy: 0.5)
        XCTAssertFalse(backdrop.isHidden)
        XCTAssertEqual(backdrop.frame.minY, test.dock.frame.minY, accuracy: 0.5, "the backdrop starts at the dock")
        XCTAssertEqual(backdrop.frame.maxY, height, accuracy: 0.5)
        XCTAssertFalse(test.dock.layer.animationKeys()?.isEmpty ?? true, "the dock moves on the list's motion")

        post(UIResponder.keyboardWillChangeFrameNotification, up: false, in: window)
        post(UIResponder.keyboardDidHideNotification, up: false, in: window)
        let down = try await until { abs(self.resting(test.chat) - test.dock.frame.maxY) < 0.5 }
        XCTAssertTrue(down, "the dock is back on the safe area, at \(test.dock.frame.maxY)")
        XCTAssertEqual(test.list.frame, list)
        XCTAssertEqual(test.list.contentInsets.bottom, LegacyChatScreenLayout.Metrics.newerEdgeExtra, accuracy: 0.5)

        resize(700)
        let back = try await until {
            window.layoutIfNeeded()
            return !shell.isExpanded && test.chat.ultraKeyboard?.isActive == true
        }
        XCTAssertTrue(back, "the floating dock keeps UltraView's keyboard")
        XCTAssertEqual(test.list.frame.minY, 0, accuracy: 0.5, "the list runs under the bar again")
    }

    /// A keyboard frame puts UltraList's dock on the keyboard, and the
    /// list's newest inset follows on the keyboard's transition; the hide
    /// puts both back on the safe area.
    func testAKeyboardFrameMovesTheUltraListDockAndInset() async throws {
        let test = try await chat()
        let window = try XCTUnwrap(test.chat.view.window)
        let ultra = test.list.ultra.list
        let height = test.chat.view.bounds.height
        XCTAssertEqual(test.dock.frame.maxY, resting(test.chat), accuracy: 0.5)
        let passes = ultra.appliedPassCount

        post(UIResponder.keyboardWillChangeFrameNotification, up: true, in: window)
        XCTAssertEqual(test.dock.frame.maxY, height - keyboardHeight, accuracy: 0.5, "the dock sits on the keyboard")
        // The library's inset-only pass, which keeps a viewport curve, not
        // a full pass.
        XCTAssertEqual(ultra.appliedPassCount, passes, "the keyboard moved the inset without a full list pass")
        XCTAssertEqual(test.list.contentInsets.bottom, height - test.dock.frame.minY + LegacyChatScreenLayout.Metrics.newerEdgeExtra, accuracy: 0.5)
        XCTAssertEqual(ultra.viewportInsets.bottom, Double(test.list.contentInsets.bottom), accuracy: 0.5)
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
        XCTAssertEqual(test.list.contentInsets.bottom, height - test.dock.frame.minY + LegacyChatScreenLayout.Metrics.newerEdgeExtra, accuracy: 0.5)
    }
}
#endif
