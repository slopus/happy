import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// Home's rows in the modern home's inset cards.
final class HomeCardLayoutTests: XCTestCase {
    func testTheCardIsTheModernHomesInset() {
        XCTAssertEqual(HomeCardLayout.Metrics.side, GroupedSidebarMetrics.side)
        XCTAssertEqual(HomeCardLayout.Metrics.radius, GroupedSidebarMetrics.radius)
        XCTAssertEqual(HomeCardLayout.Metrics.gap, GroupedSidebarMetrics.cardGap)
        XCTAssertEqual(HomeCardLayout.contentWidth(393), 361)
        XCTAssertEqual(HomeCardLayout.contentWidth(20), 0)
    }

    func testARowInTheMiddleOfItsCardDrawsItsHairlineFromItsText() {
        let layout = HomeCardLayout(width: 393, height: 81, roundsTop: false, roundsBottom: false, separatorX: 68, hairline: 1.0 / 3)
        assertFrame(layout.card, rect(16, 0, 361, 81))
        XCTAssertFalse(layout.roundsTop)
        XCTAssertFalse(layout.roundsBottom)
        assertFrame(layout.separator, rect(68, 81 - 1.0 / 3, 293, 1.0 / 3))
    }

    func testTheLastRowRoundsTheCardAndDrawsNoHairline() {
        let layout = HomeCardLayout(width: 393, height: 48, roundsTop: false, roundsBottom: true, separatorX: nil, hairline: 1.0 / 3)
        assertFrame(layout.card, rect(16, 0, 361, 48))
        XCTAssertTrue(layout.roundsBottom)
        XCTAssertNil(layout.separator)
    }

    /// A flat session in its card: the card's 40 avatar, the text beside it
    /// 16 + 40 + 12 in, the same 81 tall at the designed size.
    func testAFlatSessionInACard() {
        let layout = FlatSessionRowLayout(.init(
            width: HomeCardLayout.contentWidth(393),
            title: text("Fix the build", lineHeight: 22, maxLines: 1),
            timestamp: text("12:55", lineHeight: 22, maxLines: 1),
            project: text("happy", lineHeight: 20, maxLines: 1),
            workspace: text("fix-login", lineHeight: 18, maxLines: 1),
            showsDivider: false,
            avatarSize: HomeCardLayout.Metrics.sessionAvatar
        ))
        assertSize(layout.size, CGSize(width: 361, height: 81))
        assertFrame(layout.avatar, rect(16, 20.5, 40, 40))
        assertFrame(layout.timestamp, rect(305, 10, 40, 22))
        assertFrame(layout.title, rect(68, 10, 213, 22))
        assertFrame(layout.project, rect(68, 32, 277, 20))
        assertFrame(layout.workspace, rect(68, 53, 72, 18))
        XCTAssertNil(layout.divider)
        XCTAssertEqual(FlatSessionRowLayout.Metrics.contentX(avatar: HomeCardLayout.Metrics.sessionAvatar), 68)
    }

    /// The text is taller than the card's avatar, so smaller text makes a
    /// shorter row: the plain list's 60 avatar held it at 80.
    func testTheCardsAvatarNoLongerHoldsTheRowUp() {
        let small = FlatSessionRowLayout.Lines(title: 17, project: 15, workspace: 14)
        XCTAssertEqual(FlatSessionRowLayout.height(lines: small, workspace: true), 80)
        XCTAssertEqual(FlatSessionRowLayout.height(lines: small, workspace: true, avatarSize: HomeCardLayout.Metrics.sessionAvatar), 76)
        XCTAssertEqual(HomeRowHeights.flatSession(width: 393), 81)
        XCTAssertEqual(HomeRowHeights.gap, 24)
    }

    /// A computer's heading stands over its card in line with the avatars,
    /// with no rule.
    func testAComputersHeading() {
        let layout = MachineHeaderLayout(width: 393, icon: CGSize(width: 12, height: 12.33), name: text("Studio Mac", lineHeight: 15, maxLines: 1))
        assertFrame(layout.icon, rect(32, 21.335, 12, 12.33))
        assertFrame(layout.name, rect(50, 20, 80, 15))
        assertSize(layout.size, CGSize(width: 393, height: 43))
    }
}
