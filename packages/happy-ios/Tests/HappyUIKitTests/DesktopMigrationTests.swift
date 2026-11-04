#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The Happy CLI home's migration card and the section its screen opens.
@MainActor
final class DesktopMigrationTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    /// The card leads the notices and stands in for What's new, one
    /// announcement at a time; the store update still shows.
    func testTheCardLeadsAndTakesWhatsNewsPlace() {
        let header = HomeListHeaderView()
        header.content = HomeBanners(offlineTitle: "MacBook is offline", whatsNew: true, migration: .desktop)
        XCTAssertEqual(header.content.notices.map(\.title), [Strings.DesktopMigration.desktopTitle, "MacBook is offline"])
        let cards = header.subviews.compactMap { $0 as? ItemGroupView }.flatMap { $0.card.subviews.compactMap { $0 as? DesktopCardView } }
        XCTAssertEqual(cards.count, 1)
        header.content = HomeBanners(nativeUpdate: true, migration: .agentConnection)
        XCTAssertEqual(header.content.notices.map(\.title), [Strings.DesktopMigration.agentConnectionTitle, "App Update Available"])
    }

    /// VoiceOver reads the card as one button that opens the screen, with
    /// Close among its actions.
    func testVoiceOverOpensAndClosesTheCard() throws {
        let card = DesktopCardView(icon: .monitor, title: "Happy now on desktop", body: "Please migrate!")
        var opened = 0, closed = 0
        card.onOpen = { opened += 1 }
        card.onClose = { closed += 1 }
        XCTAssertTrue(card.isAccessibilityElement)
        XCTAssertEqual(card.accessibilityLabel, "Happy now on desktop")
        XCTAssertEqual(card.accessibilityValue, "Please migrate!")
        XCTAssertTrue(card.accessibilityTraits.contains(.button))
        XCTAssertTrue(card.accessibilityActivate())
        XCTAssertEqual(opened, 1)
        let close = try XCTUnwrap(card.accessibilityCustomActions?.first)
        XCTAssertEqual(close.name, Strings.DesktopMigration.close)
        XCTAssertTrue(close.actionHandler?(close) ?? false)
        XCTAssertEqual(closed, 1)
    }

    /// Closed until its title is tapped; open, it measures its paragraphs
    /// too, and each tap tells the host.
    func testTheSectionOpensWhenTapped() throws {
        let section = DisclosureSectionView(
            title: "Running Happy on a server?",
            paragraphs: ["In Happy Desktop, select the remote server.", "Ask Chief of Staff."],
            titleStyle: TextStyles.checklistTitle,
            style: TextStyles.startSlideBody,
            titleColor: Palette.startText,
            color: Palette.startTextSecondary,
            identifier: "section"
        )
        var toggles = 0
        section.onToggle = { toggles += 1 }
        let closed = section.sizeThatFits(CGSize(width: 354, height: CGFloat.greatestFiniteMagnitude))
        XCTAssertEqual(closed.height, 40)
        let header = try XCTUnwrap(section.subviews.compactMap { $0 as? UIControl }.first)
        XCTAssertEqual(header.accessibilityIdentifier, "section")
        header.sendActions(for: .touchUpInside)
        XCTAssertTrue(section.isExpanded)
        XCTAssertEqual(toggles, 1)
        XCTAssertGreaterThan(section.sizeThatFits(CGSize(width: 354, height: CGFloat.greatestFiniteMagnitude)).height, closed.height)
        header.sendActions(for: .touchUpInside)
        XCTAssertFalse(section.isExpanded)
        XCTAssertEqual(toggles, 2)
    }
}
#endif
