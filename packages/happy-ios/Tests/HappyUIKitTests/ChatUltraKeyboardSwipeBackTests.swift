#if canImport(UIKit)
@testable import HappyUI
import UIKit
import UltraView
import XCTest

/// A swipe back with the keyboard up, let go of: UIKit starts a hide as
/// the swipe begins and brings the keyboard back as it is let go of. A
/// did-hide for that hide coming after the keyboard is back put the
/// composer down under it.
///
/// No software keyboard comes up here: the notifications are posted by
/// hand, outside any list pass, so they apply at once.
@MainActor
final class ChatUltraKeyboardSwipeBackTests: XCTestCase {
    private let keyboardHeight: CGFloat = 320

    private func shown(_ composerHasKeyboard: Bool = true) -> (ChatUltraKeyboard, UIView) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
        let screen = UIViewController()
        window.rootViewController = screen
        window.makeKeyAndVisible()
        let list = UltraListView(engineMode: .keyframe)
        list.frame = screen.view.bounds
        screen.view.addSubview(list)
        let keyboard = ChatUltraKeyboard(list: list, view: screen.view, accessoryHeight: { 0 },
                                         hasInput: { composerHasKeyboard }, changed: { _ in })
        keyboard.activate()
        addTeardownBlock { @MainActor in
            keyboard.invalidate()
            window.isHidden = true
        }
        return (keyboard, screen.view)
    }

    /// A docked keyboard `keyboardHeight` tall, coming up or going down,
    /// over a window with no scene: its frames are the window's.
    private func post(_ name: Notification.Name, up: Bool, duration: Double, over view: UIView) {
        let bounds = view.window?.bounds ?? view.bounds
        let shown = CGRect(x: 0, y: bounds.maxY - keyboardHeight, width: bounds.width, height: keyboardHeight)
        let hidden = shown.offsetBy(dx: 0, dy: keyboardHeight)
        NotificationCenter.default.post(name: name, object: nil, userInfo: [
            UIResponder.keyboardFrameBeginUserInfoKey: NSValue(cgRect: up ? hidden : shown),
            UIResponder.keyboardFrameEndUserInfoKey: NSValue(cgRect: up ? shown : hidden),
            UIResponder.keyboardAnimationDurationUserInfoKey: duration,
            UIResponder.keyboardAnimationCurveUserInfoKey: 7,
        ])
    }

    func testADidHideAfterTheKeyboardCameBackLeavesItUp() {
        let (keyboard, view) = shown()
        post(UIResponder.keyboardWillChangeFrameNotification, up: true, duration: 0.25, over: view)
        XCTAssertEqual(keyboard.height, keyboardHeight, accuracy: 0.5)
        // The swipe starts: the keyboard is to go with the screen.
        post(UIResponder.keyboardWillChangeFrameNotification, up: false, duration: 0.35, over: view)
        XCTAssertEqual(keyboard.height, 0, accuracy: 0.5)
        // Let go of: the keyboard is back, and then the hide ends.
        post(UIResponder.keyboardWillChangeFrameNotification, up: true, duration: 0, over: view)
        post(UIResponder.keyboardDidHideNotification, up: false, duration: 0, over: view)
        XCTAssertEqual(keyboard.height, keyboardHeight, accuracy: 0.5, "the composer went down under the keyboard")
    }

    /// The keyboard went with its input: the did-hide lands it, as before.
    func testADidHideAfterTheInputLetGoLandsTheKeyboard() {
        let (keyboard, view) = shown(false)
        post(UIResponder.keyboardWillChangeFrameNotification, up: true, duration: 0, over: view)
        XCTAssertEqual(keyboard.height, keyboardHeight, accuracy: 0.5)
        post(UIResponder.keyboardDidHideNotification, up: false, duration: 0, over: view)
        XCTAssertEqual(keyboard.height, 0, accuracy: 0.5)
    }

    /// Let go of with nothing heard since the hide: the next layout reads
    /// the keyboard off the guide, once.
    func testALetGoSwipeReadsTheKeyboardOffTheGuide() {
        let (keyboard, view) = shown()
        post(UIResponder.keyboardWillChangeFrameNotification, up: true, duration: 0.25, over: view)
        post(UIResponder.keyboardWillChangeFrameNotification, up: false, duration: 0.35, over: view)
        XCTAssertEqual(keyboard.height, 0, accuracy: 0.5)
        keyboard.resyncWithGuide()
        keyboard.prepareLayout(guideTop: view.bounds.maxY - keyboardHeight)
        XCTAssertEqual(keyboard.height, keyboardHeight, accuracy: 0.5, "the guide's keyboard wasn't read")
        keyboard.prepareLayout(guideTop: view.bounds.maxY - view.safeAreaInsets.bottom)
        XCTAssertEqual(keyboard.height, keyboardHeight, accuracy: 0.5, "the guide is read once")
    }
}
#endif
