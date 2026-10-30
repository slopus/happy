#if canImport(UIKit)
@testable import HappyUI
import UIKit
import XCTest

/// The swipe back with the navigation bar hidden, as the chat hides it on
/// a phone held sideways with the keyboard up: UIKit's own stops there,
/// and the stack's `PopGestureDelegate` keeps it.
@MainActor
final class PopGestureBarTests: XCTestCase {
    func testTheSwipeBackMayBeginWithTheBarHidden() throws {
        let navigation = UINavigationController(rootViewController: UIViewController())
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 874, height: 402))
        window.rootViewController = navigation
        window.makeKeyAndVisible()
        let delegate = PopGestureDelegate(navigation: navigation)
        navigation.pushViewController(UIViewController(), animated: false)
        navigation.setNavigationBarHidden(true, animated: false)
        let gesture = try XCTUnwrap(navigation.interactivePopGestureRecognizer)
        XCTAssertTrue(gesture.isEnabled)
        XCTAssertTrue(gesture.delegate === delegate)
        XCTAssertTrue(delegate.gestureRecognizerShouldBegin(gesture))
        if #available(iOS 26.0, *) {
            XCTAssertTrue(navigation.interactiveContentPopGestureRecognizer?.isEnabled ?? false)
        }
        // At the root there is nothing to go back to.
        navigation.popViewController(animated: false)
        XCTAssertFalse(delegate.gestureRecognizerShouldBegin(gesture))
        withExtendedLifetime(window) {}
    }
}
#endif
