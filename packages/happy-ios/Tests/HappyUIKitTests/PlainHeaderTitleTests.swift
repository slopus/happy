#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Header.tsx's `createPlainHeader` title on session info, machine and
/// changes: it follows the text size, the screen's rows don't.
@MainActor
final class PlainHeaderTitleTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func titleView(_ controller: UIViewController) throws -> NavigationTitleView {
        try XCTUnwrap(controller.navigationItem.titleView as? NavigationTitleView)
    }

    func testTheTitleFollowsAndTheBackTitleStays() throws {
        let controller = UIViewController()
        controller.setPlainHeaderTitle("Primary")
        XCTAssertEqual(controller.title, "Primary")
        let view = try titleView(controller)
        XCTAssertEqual(view.title, "Primary")
        XCTAssertTrue(view.traitOverrides.followsTextSize)
        XCTAssertEqual(view.frame.size, view.layout(maxWidth: NavigationTitleView.defaultMaxWidth).size)
        // The screen itself doesn't follow: neither it nor its view sets the
        // trait (reading an override that was never set raises), and its
        // view's traits say no.
        XCTAssertFalse(controller.traitOverrides.contains(FollowsTextSize.self))
        XCTAssertFalse(controller.view.traitOverrides.contains(FollowsTextSize.self))
        XCTAssertFalse(controller.view.traitCollection[FollowsTextSize.self])
    }

    func testARenameIsFittedToTheWholeSlot() throws {
        let controller = UIViewController()
        controller.setPlainHeaderTitle("Hi")
        let view = try titleView(controller)
        let short = view.frame.width
        controller.setPlainHeaderTitle("A much longer name for this session")
        XCTAssertIdentical(try titleView(controller), view)
        XCTAssertGreaterThan(view.frame.width, short)
        XCTAssertEqual(view.frame.size, view.layout(maxWidth: NavigationTitleView.defaultMaxWidth).size)
    }

    func testEmptyShowsNothing() throws {
        let controller = UIViewController()
        controller.setPlainHeaderTitle("")
        XCTAssertEqual(controller.title, "")
        XCTAssertNil(try titleView(controller).title)
    }

    func testItDrawsAtTheTextSize() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.traitOverrides.preferredContentSizeCategory = .accessibilityMedium
        // The title takes the screen's size, so the screen is on the window.
        let controller = UIViewController()
        window.rootViewController = controller
        window.isHidden = false
        controller.updateTraitsIfNeeded()
        controller.setPlainHeaderTitle("Changes")
        let view = try titleView(controller)
        controller.view.addSubview(view)
        controller.view.updateTraitsIfNeeded()
        view.updateTraitsIfNeeded()
        for subview in view.subviews { subview.updateTraitsIfNeeded() }
        let font = view.titleLabel.attributedText?.attribute(.font, at: 0, effectiveRange: nil) as? UIFont
        XCTAssertEqual(try XCTUnwrap(font).pointSize, 16 * TextScale(.accessibilityMedium).multiplier, accuracy: 0.0001)
        XCTAssertEqual(view.frame.size, view.layout(maxWidth: NavigationTitleView.defaultMaxWidth).size)
        window.isHidden = true
    }
}
#endif
