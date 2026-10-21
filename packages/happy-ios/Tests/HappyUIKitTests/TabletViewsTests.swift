#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The tablet shell's views: what shows before anything changes them, the
/// header letting touches through, and the traits the shell sets.
@MainActor
final class TabletViewsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    func testTheHeaderStartsWithBackDimmedAndZenOff() {
        let header = TabletPersistentHeaderView()
        XCTAssertFalse(header.backButton.isEnabled)
        // A view's alpha is kept as its layer's Float opacity, so it reads
        // back as 0.3 in Float, exactly.
        XCTAssertEqual(header.backButton.layer.opacity, Float(TabletShellLayout.Metrics.disabledOpacity))
        header.canGoBack = true
        XCTAssertTrue(header.backButton.isEnabled)
        XCTAssertEqual(header.backButton.alpha, 1)
        XCTAssertEqual(header.zenButton.accessibilityLabel, Strings.Tablet.zenToggle)
    }

    func testTheHeaderOnlyTakesTouchesOnItsControls() {
        let header = TabletPersistentHeaderView(frame: CGRect(x: 0, y: 0, width: 1024, height: 74))
        header.apply(
            zenButton: CGRect(x: 16, y: 35, width: 28, height: 28),
            zenIcon: CGRect(x: 21, y: 40, width: 18, height: 18),
            backButton: CGRect(x: 48, y: 35, width: 28, height: 28)
        )
        XCTAssertNil(header.hitTest(CGPoint(x: 500, y: 40), with: nil), "the row passes touches through")
        XCTAssertTrue(header.hitTest(CGPoint(x: 30, y: 49), with: nil) === header.zenButton)
        // hitSlop 10 past the zen control's edge.
        XCTAssertTrue(header.hitTest(CGPoint(x: 8, y: 49), with: nil) === header.zenButton)
    }

    func testTheArchiveButtonFollowsTheSetting() {
        let button = SidebarArchiveButton()
        XCTAssertEqual(button.icon.icon, .ionicons("archive-outline"))
        XCTAssertEqual(button.accessibilityLabel, Strings.Sidebar.showArchived)
        button.hidesArchived = false
        XCTAssertEqual(button.icon.icon, .ionicons("archive"))
        XCTAssertEqual(button.accessibilityLabel, Strings.Sidebar.hideArchived)
    }

    func testEmptySessionsShowsEachFace() {
        let view = TabletEmptySessionsView()
        XCTAssertEqual(view.titleLabel.string, Strings.Tablet.noSessionsTitle)
        XCTAssertEqual(view.descriptionLabel.string, Strings.Tablet.noMachinesDescription)
        XCTAssertTrue(view.button.isHidden, "no computer, no button")
        view.state = .online
        XCTAssertEqual(view.buttonLabel.string, Strings.Tablet.startNewSession)
        XCTAssertFalse(view.button.isHidden)
    }

    func testSidebarLabels() {
        XCTAssertEqual(SidebarNewSessionButton().label.string, "New session")
        XCTAssertEqual(SidebarSettingsRow().label.string, "Settings")
    }

    func testTheTraitsDefaultOff() {
        let traits = UITraitCollection()
        XCTAssertFalse(traits.isTabletLayout)
        XCTAssertFalse(traits.isZenMode)
        let tablet = traits.modifyingTraits { $0.isTabletLayout = true }
        XCTAssertTrue(tablet.isTabletLayout)
    }
}
#endif
