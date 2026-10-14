#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// ChatList's OlderEnd: what each paging status shows in the 32 pt slot past
/// the oldest message, and that a press reaches the screen.
@MainActor
final class ChatOlderEndViewTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func shown(_ status: ChatOlderPaging.Status) -> (UIWindow, ChatOlderEndView) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        let view = ChatOlderEndView(frame: CGRect(x: 0, y: 100, width: 393, height: ChatOlderEndLayout.height))
        view.status = status
        window.addSubview(view)
        window.isHidden = false
        view.layoutIfNeeded()
        return (window, view)
    }

    private func spinner(_ view: ChatOlderEndView) -> UIActivityIndicatorView? {
        view.subviews.compactMap { $0 as? UIActivityIndicatorView }.first
    }

    private func button(_ view: ChatOlderEndView) -> RoundButton? {
        view.subviews.compactMap { $0 as? RoundButton }.first
    }

    func testEachStatusShowsItsOneThingAndTheSlotNeverChangesHeight() throws {
        let (window, view) = shown(.idle)
        defer { window.isHidden = true }
        let spinner = try XCTUnwrap(spinner(view))
        let button = try XCTUnwrap(button(view))
        for status in [ChatOlderPaging.Status.idle, .loading, .error, .loadMore, .idle] {
            view.status = status
            view.layoutIfNeeded()
            XCTAssertEqual(view.sizeThatFits(CGSize(width: 393, height: 1000)).height, 32, "\(status)")
            XCTAssertEqual(spinner.isAnimating, status == .loading, "\(status)")
            XCTAssertEqual(spinner.isHidden, status != .loading, "\(status)")
            XCTAssertEqual(button.isHidden, status != .error && status != .loadMore, "\(status)")
        }
        view.status = .error
        XCTAssertEqual(button.title, Strings.Chat.retry)
        view.status = .loadMore
        XCTAssertEqual(button.title, Strings.Chat.loadMore)
    }

    func testTheSpinnerAndTheButtonAreCentredOnTheSlot() throws {
        let (window, view) = shown(.loading)
        defer { window.isHidden = true }
        let spinner = try XCTUnwrap(spinner(view))
        XCTAssertEqual(spinner.center.x, 393 / 2, accuracy: 0.5)
        XCTAssertEqual(spinner.center.y, 16, accuracy: 0.5)

        view.status = .loadMore
        view.layoutIfNeeded()
        let button = try XCTUnwrap(button(view))
        // RoundButton's small text action stretches to the width and is
        // 17 + 8 + 8 tall, so it hangs half a point past the 32 slot.
        XCTAssertEqual(button.frame.width, 393, accuracy: 0.5)
        XCTAssertEqual(button.frame.height, 33, accuracy: 0.5)
        XCTAssertEqual(button.center.y, 16, accuracy: 0.5)
    }

    func testAPressReachesTheScreen() throws {
        let (window, view) = shown(.error)
        defer { window.isHidden = true }
        var pressed = 0
        view.onAction = { pressed += 1 }
        let button = try XCTUnwrap(button(view))
        // A touch-up-inside runs the button's own tap: its target-action,
        // which UIKit dispatches through the application, and a test bundle
        // without a host app has none, so `sendActions` would reach nothing.
        XCTAssertTrue(button.allTargets.contains(button))
        XCTAssertFalse(button.actions(forTarget: button, forControlEvent: .touchUpInside)?.isEmpty ?? true)
        button.onTap?()
        XCTAssertEqual(pressed, 1)
    }
}
#endif
