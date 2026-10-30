#if canImport(UIKit)
@testable import HappyUI
import UIKit
import UltraView
import XCTest

/// The swipe back with the navigation bar hidden, as the chat hides it on
/// a phone held sideways with the keyboard up: UIKit's own stops there,
/// and the stack's `PopGestureDelegate` keeps it.
@MainActor
final class PopGestureBarTests: XCTestCase {
    func testContentSwipeHasTheSameStackGuardAndRequiresLeadingHorizontalMotion() throws {
        let navigation = ContentNavigation(rootViewController: UIViewController())
        navigation.loadViewIfNeeded()
        let delegate = PopGestureDelegate(navigation: navigation)
        let pan = navigation.content
        XCTAssertTrue(pan.delegate === delegate)
        pan.motion = CGPoint(x: 300, y: 0)
        XCTAssertFalse(delegate.gestureRecognizerShouldBegin(pan), "root must not pop")
        navigation.pushViewController(UIViewController(), animated: false)
        XCTAssertTrue(delegate.gestureRecognizerShouldBegin(pan))
        pan.motion = CGPoint(x: 10, y: 300)
        XCTAssertFalse(delegate.gestureRecognizerShouldBegin(pan), "vertical scrolling must not pop")
        pan.motion = CGPoint(x: -300, y: 0)
        XCTAssertFalse(delegate.gestureRecognizerShouldBegin(pan), "the opposite direction must not pop")
        navigation.view.semanticContentAttribute = .forceRightToLeft
        XCTAssertTrue(delegate.gestureRecognizerShouldBegin(pan))
        pan.motion = CGPoint(x: 300, y: 0)
        XCTAssertFalse(delegate.gestureRecognizerShouldBegin(pan))
    }

    func testVerticalUltraListWaitsForNativePopsAndHorizontalContentKeepsItsPan() throws {
        let navigation = ContentNavigation(rootViewController: UIViewController())
        navigation.loadViewIfNeeded()
        let delegate = PopGestureDelegate(navigation: navigation)
        let top = UIViewController()
        navigation.pushViewController(top, animated: false)
        let list = UltraListView(engineMode: .keyframe)
        top.view.addSubview(list)
        let pan = try XCTUnwrap(list.contentView.gestureRecognizers?.first { $0 is UIPanGestureRecognizer })
        let edge = try XCTUnwrap(navigation.interactivePopGestureRecognizer)
        XCTAssertTrue(delegate.gestureRecognizer(edge, shouldBeRequiredToFailBy: pan))
        XCTAssertTrue(delegate.gestureRecognizer(navigation.content, shouldBeRequiredToFailBy: pan))

        let horizontal = UIScrollView(frame: CGRect(x: 0, y: 0, width: 200, height: 100))
        horizontal.contentSize = CGSize(width: 800, height: 100)
        top.view.addSubview(horizontal)
        XCTAssertTrue(delegate.gestureRecognizer(edge, shouldBeRequiredToFailBy: horizontal.panGestureRecognizer))
        XCTAssertFalse(delegate.gestureRecognizer(navigation.content, shouldBeRequiredToFailBy: horizontal.panGestureRecognizer))
        XCTAssertTrue(PopGestureDelegate.hasHorizontalContent(above: horizontal))
        // Chat's code/table scroller allows horizontal bounce even when the
        // content fits. Such a row has no horizontal history to protect.
        horizontal.alwaysBounceHorizontal = true
        horizontal.contentSize.width = horizontal.bounds.width
        XCTAssertFalse(PopGestureDelegate.hasHorizontalContent(above: horizontal))
        XCTAssertTrue(delegate.gestureRecognizer(navigation.content, shouldBeRequiredToFailBy: horizontal.panGestureRecognizer))
        XCTAssertFalse(PopGestureDelegate.hasHorizontalContent(above: list.contentView))
        let horizontalList = HorizontalListView(engineMode: .keyframe)
        top.view.addSubview(horizontalList)
        XCTAssertTrue(PopGestureDelegate.hasHorizontalContent(above: horizontalList.list.contentView))
        XCTAssertFalse(delegate.gestureRecognizer(navigation.content, shouldBeRequiredToFailBy: UITapGestureRecognizer()))
        navigation.popViewController(animated: false)
        XCTAssertFalse(delegate.gestureRecognizer(edge, shouldBeRequiredToFailBy: pan))
    }

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

@MainActor
private final class ContentNavigation: UINavigationController {
    let content = DirectionPan()
    override var interactiveContentPopGestureRecognizer: UIGestureRecognizer? { content }
}

@MainActor
private final class DirectionPan: UIPanGestureRecognizer {
    var motion = CGPoint.zero
    override func velocity(in view: UIView?) -> CGPoint { motion }
}
#endif
