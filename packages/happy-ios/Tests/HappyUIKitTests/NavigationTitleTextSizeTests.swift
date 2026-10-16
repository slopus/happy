#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The title views in a real navigation bar, past the bar's XXL cap:
/// UINavigationBar holds the text size its title view inherits to XXL,
/// where Header.tsx's and OnboardingHeader's RN Text goes on scaling, so
/// `setScaledTitleView` hands the title view the screen's own size.
@MainActor
final class NavigationTitleTextSizeTests: XCTestCase {
    private let categories: [UIContentSizeCategory] = [
        .large, .extraExtraLarge, .extraExtraExtraLarge, .accessibilityMedium, .accessibilityExtraExtraExtraLarge,
    ]

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private struct Shown {
        let window: UIWindow
        let navigation: UINavigationController
    }

    /// `controller` at the root of a navigation stack, in a window at
    /// `category`, laid out.
    private func show(_ controller: UIViewController, category: UIContentSizeCategory) -> Shown {
        let navigation = UINavigationController(rootViewController: controller)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.traitOverrides.preferredContentSizeCategory = category
        window.traitOverrides.displayScale = 3
        window.rootViewController = navigation
        window.isHidden = false
        settle(window, navigation, controller)
        return Shown(window: window, navigation: navigation)
    }

    private func settle(_ window: UIWindow, _ navigation: UINavigationController, _ controller: UIViewController) {
        window.updateTraitsIfNeeded()
        navigation.updateTraitsIfNeeded()
        controller.updateTraitsIfNeeded()
        window.layoutIfNeeded()
        navigation.navigationBar.layoutIfNeeded()
        if let title = controller.navigationItem.titleView {
            title.updateTraitsIfNeeded()
            for subview in title.subviews { subview.updateTraitsIfNeeded() }
        }
    }

    /// The view is fitted to its measured block, the label's box ceiled to
    /// the screen's pixels (RN ceils a Text's box), and the label is laid
    /// out at that box. The bar places the view by centring it in its 44
    /// and rounding that box out to whole pixels, so a title an odd number
    /// of pixels away from the 44 is given one pixel more height than it
    /// measured, never less (Mac run: 25 at XXL in a 25⅓ frame, 71⅔ at
    /// AX-XXXL in 72). That pixel is the bar's placement; the text keeps
    /// its box in it.
    private func assertFitted(_ view: NavigationTitleView, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
        let layout = view.layout(maxWidth: NavigationTitleView.defaultMaxWidth)
        let pixel = 1 / view.layoutScale
        XCTAssertEqual(view.intrinsicContentSize, layout.size, "measured, \(message)", file: file, line: line)
        XCTAssertEqual(view.frame.width, layout.size.width, "width, \(message)", file: file, line: line)
        let extra = view.frame.height - layout.size.height
        XCTAssertTrue(abs(extra) < 0.0001 || abs(extra - pixel) < 0.0001, "height \(view.frame.height) for \(layout.size.height), \(message)", file: file, line: line)
        view.layoutIfNeeded()
        let title = layout.title?.height ?? 0
        XCTAssertGreaterThanOrEqual(view.titleLabel.frame.height, title - 0.0001, "the title's box, \(message)", file: file, line: line)
        XCTAssertLessThanOrEqual(view.titleLabel.frame.height, title + pixel + 0.0001, "the title's box, \(message)", file: file, line: line)
    }

    private func headerTitleSize(_ category: UIContentSizeCategory) -> CGFloat {
        TextStyles.headerTitle.scaled(TextScale(TextSizeCategory(category))).size
    }

    func testThePlainHeaderTitleTakesTheScreensSizePastTheBarsCap() throws {
        for category in categories {
            let controller = UIViewController()
            controller.setPlainHeaderTitle("Changes")
            let shown = show(controller, category: category)
            defer { shown.window.isHidden = true }
            let view = try XCTUnwrap(controller.navigationItem.titleView as? NavigationTitleView)
            XCTAssertTrue(view.isDescendant(of: shown.navigation.navigationBar), category.rawValue)
            XCTAssertEqual(view.traitCollection.preferredContentSizeCategory, category, category.rawValue)
            // 16 × the multiplier: 57.1 at the largest, not the bar's 19.76.
            XCTAssertEqual(view.titleLabel.renderedStyle.size, headerTitleSize(category), accuracy: 0.0001, category.rawValue)
            assertFitted(view, category.rawValue)
        }
    }

    func testANewTextSizeReachesTheTitle() throws {
        let controller = UIViewController()
        controller.setPlainHeaderTitle("Machine")
        let shown = show(controller, category: .large)
        defer { shown.window.isHidden = true }
        let view = try XCTUnwrap(controller.navigationItem.titleView as? NavigationTitleView)
        let large = view.frame.size
        shown.window.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        settle(shown.window, shown.navigation, controller)
        XCTAssertEqual(view.traitCollection.preferredContentSizeCategory, .accessibilityExtraExtraExtraLarge)
        XCTAssertEqual(view.titleLabel.renderedStyle.size, headerTitleSize(.accessibilityExtraExtraExtraLarge), accuracy: 0.0001)
        XCTAssertGreaterThan(view.frame.height, large.height)
        assertFitted(view)
        // And back.
        shown.window.traitOverrides.preferredContentSizeCategory = .large
        settle(shown.window, shown.navigation, controller)
        XCTAssertEqual(view.titleLabel.renderedStyle.size, 16, accuracy: 0.0001)
        XCTAssertEqual(view.frame.size, large)
    }

    func testATitleSetBeforeTheScreenIsShownTakesItsSizeOnceItIs() throws {
        // Home, Welcome and Settings set theirs in viewDidLoad.
        let controller = UIViewController()
        let view = NavigationTitleView(title: "Settings", subtitle: "server.example")
        controller.setScaledTitleView(view)
        let shown = show(controller, category: .accessibilityExtraLarge)
        defer { shown.window.isHidden = true }
        XCTAssertIdentical(controller.navigationItem.titleView, view)
        XCTAssertTrue(view.traitOverrides.followsTextSize)
        XCTAssertEqual(view.traitCollection.preferredContentSizeCategory, .accessibilityExtraLarge)
        XCTAssertEqual(view.titleLabel.renderedStyle.size, headerTitleSize(.accessibilityExtraLarge), accuracy: 0.0001)
        XCTAssertEqual(
            view.subtitleLabel.renderedStyle.size,
            TextStyles.headerSubtitle.scaled(TextScale(.accessibilityExtraLarge)).size,
            accuracy: 0.0001
        )
    }

    func testWhatsNewsTitleTakesTheScreensSize() throws {
        let controller = UIViewController()
        let view = ChangelogTitleView(title: "What's New")
        controller.setScaledTitleView(view)
        let shown = show(controller, category: .accessibilityExtraExtraExtraLarge)
        defer { shown.window.isHidden = true }
        XCTAssertEqual(view.traitCollection.preferredContentSizeCategory, .accessibilityExtraExtraExtraLarge)
        XCTAssertEqual(
            view.label.renderedStyle.size,
            TextStyles.changelogNavigationTitle.scaled(TextScale(.accessibilityExtraExtraExtraLarge)).size,
            accuracy: 0.0001
        )
    }
}
#endif
