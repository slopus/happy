import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The iPad sidebar's list grouped by project: SessionsList.tsx's headings
/// and MachineHeader, ProjectGroup.tsx's checkout heading,
/// CompactSessionRow in its card, and SessionItem, at a 300pt sidebar on a
/// 2x screen.
final class TabletGroupedListLayoutTests: XCTestCase {
    func testSectionHeading() {
        // 24 in, 20 above, 8 below.
        let layout = TabletSectionHeaderLayout(width: 300, label: text("Bots", lineHeight: 18))
        assertFrame(layout.label, rect(24, 20, 252, 18))
        assertSize(layout.size, CGSize(width: 300, height: 46))
    }

    func testMachineRuleSharesTheRestBetweenItsTwoLines() {
        let layout = TabletMachineRuleLayout(width: 300, hairline: 0.5, icon: CGSize(width: 11, height: 11.5), name: text("Studio", lineHeight: 14))
        // 236 inside the 32s; 6 + 11 + 6 + 48 + 4 fixed leaves 80.5 a line.
        assertFrame(layout.leadingLine, rect(32, 14.75, 80.5, 0.5))
        assertFrame(layout.icon, rect(118.5, 9.25, 11, 11.5))
        assertFrame(layout.name, rect(135.5, 8, 48, 14))
        assertFrame(layout.trailingLine, rect(187.5, 14.75, 80.5, 0.5))
        assertSize(layout.size, CGSize(width: 300, height: 22))
    }

    func testMachineNameStopsAt60Percent() {
        let name = text(String(repeating: "x", count: 40), lineHeight: 14, maxLines: 1)
        let layout = TabletMachineRuleLayout(width: 300, hairline: 0.5, icon: CGSize(width: 11, height: 11.5), name: name)
        assertFrame(layout.name, rect(88.7, 8, 141.6, 14))
        assertFrame(layout.leadingLine, rect(32, 14.75, 33.7, 0.5))
        assertFrame(layout.trailingLine, rect(234.3, 14.75, 33.7, 0.5))
    }

    func testWorkspaceHeading() {
        let layout = TabletWorkspaceHeaderLayout(.init(
            width: 300,
            title: text("happy", lineHeight: 18),
            branch: text("main", lineHeight: 16),
            changes: CGSize(width: 40, height: 15)
        ))
        // The name over the branch line (34) sets the row; the face and the
        // `+` centre on it. 12 above, 6 below.
        assertFrame(layout.avatar, rect(20, 14, 30, 30))
        assertFrame(layout.title, rect(58, 12, 178, 18))
        assertFrame(layout.branch, rect(58, 30, 32, 16))
        assertFrame(layout.changes, rect(96, 30.5, 40, 15))
        assertFrame(layout.addButton, rect(244, 14, 30, 30))
        assertFrame(layout.addIcon, rect(250, 20, 18, 18))
        assertSize(layout.size, CGSize(width: 300, height: 52))
    }

    func testLongBranchKeepsItsLineChangesInView() {
        let layout = TabletWorkspaceHeaderLayout(.init(
            width: 300,
            title: text("happy", lineHeight: 18),
            branch: text(String(repeating: "b", count: 30), lineHeight: 16, maxLines: 1),
            changes: CGSize(width: 40, height: 15)
        ))
        assertFrame(layout.branch, rect(58, 30, 132, 16))
        assertFrame(layout.changes, rect(196, 30.5, 40, 15))
    }

    func testWorkspaceHeadingWithoutChanges() {
        let layout = TabletWorkspaceHeaderLayout(.init(
            width: 300, title: text("happy", lineHeight: 18), branch: text("main", lineHeight: 16), changes: nil
        ))
        XCTAssertNil(layout.changes)
        assertFrame(layout.branch, rect(58, 30, 32, 16))
    }

    func testAChatAloneInItsCardClosesTheProject() {
        let layout = TabletChatRowLayout(.init(
            width: 300, hairline: 0.5, title: text("Fix the build", lineHeight: 20),
            first: true, last: true, projectEnd: true, showsBorder: false
        ))
        // The card's border above and below, its 8, the project's 4.
        assertFrame(layout.card, rect(16, 0, 268, 57))
        assertFrame(layout.row, rect(16.5, 0.5, 267, 56))
        assertFrame(layout.indicator, rect(249.5, 19.5, 18, 18))
        assertFrame(layout.dot, rect(255.5, 25.5, 6, 6))
        assertFrame(layout.title, rect(32.5, 18.5, 209, 20))
        XCTAssertNil(layout.divider)
        assertSize(layout.size, CGSize(width: 300, height: 69))
    }

    func testAMiddleChatDrawsTheCardPastBothEdges() {
        let layout = TabletChatRowLayout(.init(
            width: 300, hairline: 0.5, title: fixed(209, 40),
            first: false, last: false, projectEnd: false, showsBorder: true
        ))
        // The card runs a corner and a border past each edge, so the cell
        // shows straight sides only.
        assertFrame(layout.card, rect(16, -18.5, 268, 93))
        assertFrame(layout.row, rect(16.5, 0, 267, 56))
        assertFrame(layout.title, rect(32.5, 8, 209, 40))
        assertFrame(layout.divider, rect(16.5, 55.5, 267, 0.5))
        assertSize(layout.size, CGSize(width: 300, height: 56))
    }

    func testTheCardsLastChatShowsItsBottomCorners() {
        let layout = TabletChatRowLayout(.init(
            width: 300, hairline: 0.5, title: text("Ship", lineHeight: 20),
            first: false, last: true, projectEnd: false, showsBorder: false
        ))
        assertFrame(layout.card, rect(16, -18.5, 268, 75))
        assertSize(layout.size, CGSize(width: 300, height: 64.5))
    }

    func testArchivedCardCentresItsThreeLines() {
        let layout = TabletArchivedRowLayout(.init(
            width: 300, hairline: 0.5,
            title: text("Old chat", lineHeight: 20),
            subtitle: text("project", lineHeight: 18),
            subtitleRow: true,
            status: text("online", lineHeight: 16),
            last: false
        ))
        assertFrame(layout.card, rect(16, 0, 268, 89))
        assertFrame(layout.row, rect(16.5, 0.5, 267, 88))
        assertFrame(layout.avatar, rect(32.5, 20.5, 48, 48))
        // 20 + 2 + 18 + 4 + 18 = 62, centred on the card's 88.
        assertFrame(layout.title, rect(96.5, 13.5, 171, 20))
        assertFrame(layout.subtitle, rect(96.5, 35.5, 56, 18))
        assertFrame(layout.dot, rect(96.5, 64.5, 6, 6))
        assertFrame(layout.status, rect(106.5, 58.5, 161, 16))
        // One between cards.
        assertSize(layout.size, CGSize(width: 300, height: 90))
    }

    func testTheProviderGlyphLeadsTheIdentity() {
        let layout = TabletArchivedRowLayout(.init(
            width: 300, hairline: 0.5,
            title: text("Old chat", lineHeight: 20),
            subtitle: text("Rig · Anthropic", lineHeight: 18),
            subtitleRow: true,
            subtitleIcon: CGSize(width: 13, height: 13.5),
            status: text("online", lineHeight: 16),
            last: false
        ))
        // The glyph and the text share the 18 line, 4 apart.
        assertFrame(layout.subtitleIcon, rect(96.5, 37.75, 13, 13.5))
        assertFrame(layout.subtitle, rect(113.5, 35.5, 120, 18))
        assertFrame(layout.title, rect(96.5, 13.5, 171, 20))
        assertFrame(layout.status, rect(106.5, 58.5, 161, 16))
    }

    func testALongIdentityStopsAtTheCardsPadding() {
        let layout = TabletArchivedRowLayout(.init(
            width: 300, hairline: 0.5,
            title: text("Old chat", lineHeight: 20),
            subtitle: text(String(repeating: "i", count: 40), lineHeight: 18, maxLines: 1),
            subtitleRow: true,
            subtitleIcon: CGSize(width: 13, height: 13),
            status: text("online", lineHeight: 16),
            last: false
        ))
        assertFrame(layout.subtitle, rect(113.5, 35.5, 154, 18))
        XCTAssertNil(TabletArchivedRowLayout(.init(
            width: 300, hairline: 0.5, title: text("a", lineHeight: 20), subtitle: text("b", lineHeight: 18),
            subtitleRow: false, status: text("c", lineHeight: 16), last: false
        )).subtitleIcon)
    }

    func testABareSubtitleAndADaysLastCard() {
        let layout = TabletArchivedRowLayout(.init(
            width: 300, hairline: 0.5,
            title: text("Old chat", lineHeight: 20),
            subtitle: text("@helper", lineHeight: 18),
            subtitleRow: false,
            status: text("online", lineHeight: 16),
            last: true
        ))
        assertFrame(layout.title, rect(96.5, 15.5, 171, 20))
        assertFrame(layout.subtitle, rect(96.5, 37.5, 56, 18))
        assertFrame(layout.dot, rect(96.5, 62.5, 6, 6))
        assertFrame(layout.status, rect(106.5, 56.5, 161, 16))
        // Twelve after a day's last card.
        assertSize(layout.size, CGSize(width: 300, height: 101))
    }

    func testFixedHeightsMatchRealContent() {
        let chat = TabletChatRowLayout(.init(
            width: 300, hairline: 0.5, title: text("A title long enough to wrap onto a second line", lineHeight: 20, maxLines: 2),
            first: true, last: true, projectEnd: true, showsBorder: false
        ))
        XCTAssertEqual(TabletGroupedRowHeights.chat(width: 300, hairline: 0.5, first: true, last: true, projectEnd: true), chat.size.height)
        XCTAssertEqual(TabletGroupedRowHeights.chat(width: 300, hairline: 0.5, first: false, last: false, projectEnd: false), 56)
        let archived = TabletArchivedRowLayout(.init(
            width: 300, hairline: 0.5, title: text("Old chat", lineHeight: 20), subtitle: text("project", lineHeight: 18),
            subtitleRow: true, status: text("online", lineHeight: 16), last: false
        ))
        XCTAssertEqual(TabletGroupedRowHeights.archived(width: 300, hairline: 0.5, last: false), archived.size.height)
        XCTAssertEqual(TabletGroupedRowHeights.archived(width: 300, hairline: 0.5, last: true), 101)
    }
}
