import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The home list grouped by project, on a 3x phone (hairline 1/3, so the
/// tree line is 2/3 wide).
final class ProjectListLayoutTests: XCTestCase {
    private let hairline: CGFloat = 1.0 / 3

    func testProjectCardWithEverythingTrailing() {
        let layout = ProjectCardLayout(.init(
            width: 393,
            hairline: hairline,
            name: text("happy", lineHeight: 22, maxLines: 1),
            showsDot: true,
            changes: fixed(60, 18),
            showsAdd: true,
            showsTree: true
        ))
        assertSize(layout.size, CGSize(width: 393, height: 60))
        assertFrame(layout.avatar, rect(16, 20, 28, 28))
        // The stem drops from under the avatar to the cell's foot.
        assertFrame(layout.stem, rect(29.667, 48, 0.667, 12))
        assertFrame(layout.add, rect(349, 18, 28, 32))
        assertFrame(layout.changes, rect(281, 25, 60, 18))
        assertFrame(layout.dot, rect(266, 30.5, 7, 7))
        assertFrame(layout.name, rect(56, 23, 202, 22))
    }

    func testABareProjectCardGivesTheNameTheRow() {
        let layout = ProjectCardLayout(.init(
            width: 393,
            hairline: hairline,
            name: text("happy", lineHeight: 22, maxLines: 1),
            showsDot: false,
            changes: nil,
            showsAdd: false,
            showsTree: false
        ))
        XCTAssertNil(layout.stem)
        XCTAssertNil(layout.dot)
        XCTAssertNil(layout.changes)
        XCTAssertNil(layout.add)
        assertFrame(layout.name, rect(56, 23, 321, 22))
    }

    func testWorktreeBranchesOffTheTrunk() {
        let layout = WorktreeRowLayout(.init(
            width: 393,
            hairline: hairline,
            label: text("fix-login", lineHeight: 21, maxLines: 1),
            showsDot: false,
            changes: fixed(52, 18),
            last: false
        ))
        assertSize(layout.size, CGSize(width: 393, height: 48))
        assertFrame(layout.trunk, rect(29.667, 0, 0.667, 48))
        assertFrame(layout.elbow, rect(30, 23.667, 14, 0.667))
        XCTAssertNil(layout.chevron)
        XCTAssertNil(layout.dot)
        assertFrame(layout.changes, rect(325, 15, 52, 18))
        assertFrame(layout.label, rect(56, 13.5, 261, 21))
    }

    func testTheLastWorktreeStopsTheTrunkAtItsElbow() {
        let layout = WorktreeRowLayout(.init(
            width: 393,
            hairline: hairline,
            label: text("fix-login", lineHeight: 21, maxLines: 1),
            showsDot: false,
            changes: nil,
            last: true
        ))
        assertFrame(layout.trunk, rect(29.667, 0, 0.667, 24))
        // An empty trailing column still keeps its margin.
        assertFrame(layout.label, rect(56, 13.5, 313, 21))
    }

    func testTheToggleLeadsWithItsChevronAndHugsItsLabel() {
        let layout = WorktreeRowLayout(.init(
            width: 393,
            hairline: hairline,
            label: text("Show all 5 workspaces", lineHeight: 20, maxLines: 1),
            chevron: CGSize(width: 12, height: 12),
            showsDot: true,
            changes: nil,
            last: true
        ))
        assertFrame(layout.chevron, rect(56, 18, 12, 12))
        assertFrame(layout.label, rect(73, 14, 168, 20))
        assertFrame(layout.dot, rect(370, 20.5, 7, 7))
    }

    func testALongToggleLabelIsClampedToItsLane() {
        let layout = WorktreeRowLayout(.init(
            width: 200,
            hairline: hairline,
            label: text("Show all 12 workspaces", lineHeight: 20, maxLines: 1),
            chevron: CGSize(width: 12, height: 12),
            showsDot: false,
            changes: nil,
            last: true
        ))
        // 200 - 16 - 8 = 176 is the lane's right edge.
        assertFrame(layout.label, rect(73, 14, 103, 20))
    }

    func testChatRowWithATimestamp() {
        let layout = ProjectChatRowLayout(
            width: 393,
            name: text("Ops bot", lineHeight: 22, maxLines: 1),
            corner: text("12:55", lineHeight: 18, maxLines: 1)
        )
        assertSize(layout.size, CGSize(width: 393, height: 48))
        assertFrame(layout.avatar, rect(16, 10, 28, 28))
        assertFrame(layout.corner, rect(337, 15, 40, 18))
        assertFrame(layout.name, rect(56, 13, 273, 22))
    }

    func testChatRowWithADot() {
        let layout = ProjectChatRowLayout(
            width: 393,
            name: text("Ops bot", lineHeight: 22, maxLines: 1),
            corner: fixed(10, 10)
        )
        assertFrame(layout.corner, rect(367, 19, 10, 10))
        assertFrame(layout.name, rect(56, 13, 303, 22))
    }

    func testSectionLabel() {
        let layout = ProjectSectionLayout(width: 393, label: text("PROJECTS", lineHeight: 14))
        assertFrame(layout.label, rect(16, 18, 365, 14))
        assertSize(layout.size, CGSize(width: 393, height: 38))
    }

    func testMachineHeaderRunsARuleToTheEdge() {
        let layout = MachineHeaderLayout(
            width: 393,
            hairline: hairline,
            icon: CGSize(width: 13, height: 13),
            name: text("MacBook Pro", lineHeight: 14, maxLines: 1)
        )
        assertFrame(layout.icon, rect(16, 14.5, 13, 13))
        assertFrame(layout.name, rect(35, 14, 88, 14))
        assertFrame(layout.rule, rect(129, 20.667, 248, 0.667))
        assertSize(layout.size, CGSize(width: 393, height: 30))
    }

    func testAMachineNameStopsAtSixtyPercent() {
        let layout = MachineHeaderLayout(
            width: 393,
            hairline: hairline,
            icon: CGSize(width: 13, height: 13),
            name: text("A very long machine name for this test", lineHeight: 14, maxLines: 1)
        )
        assertFrame(layout.name, rect(35, 14, 216.6, 14))
        assertFrame(layout.rule, rect(257.6, 20.667, 119.4, 0.667))
    }

    func testGitChangesSitOnOneCentreLine() {
        let all = GitChangesLayout(
            approximate: CGSize(width: 8, height: 14),
            added: CGSize(width: 24, height: 18),
            removed: CGSize(width: 16, height: 18)
        )
        assertFrame(all.approximate, rect(0, 2, 8, 14))
        assertFrame(all.added, rect(12, 0, 24, 18))
        assertFrame(all.removed, rect(40, 0, 16, 18))
        assertSize(all.size, CGSize(width: 56, height: 18))

        let added = GitChangesLayout(approximate: nil, added: CGSize(width: 24, height: 18), removed: nil)
        XCTAssertNil(added.approximate)
        XCTAssertNil(added.removed)
        assertFrame(added.added, rect(0, 0, 24, 18))
        assertSize(added.size, CGSize(width: 24, height: 18))
    }

    func testListHeaderStacksItsBanners() {
        let layout = HomeListHeaderLayout(width: 393, banners: [block(height: 80), block(height: 64)])
        XCTAssertEqual(layout.banners.count, 2)
        assertFrame(layout.banners[0], rect(0, 0, 393, 80))
        assertFrame(layout.banners[1], rect(0, 80, 393, 64))
        assertSize(layout.size, CGSize(width: 393, height: 144))
        assertSize(HomeListHeaderLayout(width: 393, banners: []).size, CGSize(width: 393, height: 0))
    }

    func testTheUnbandedArchiveToggle() {
        let layout = ArchiveToggleLayout(
            width: 393,
            label: text("Show archived", lineHeight: 18),
            paddingTop: ArchiveToggleLayout.unbanded.top,
            paddingBottom: ArchiveToggleLayout.unbanded.bottom
        )
        assertFrame(layout.leadingLine, rect(24, 28.835, 108.5, 0.33))
        assertFrame(layout.label, rect(144.5, 20, 104, 18))
        assertFrame(layout.trailingLine, rect(260.5, 28.835, 108.5, 0.33))
        assertSize(layout.size, CGSize(width: 393, height: 50))
    }
}

/// The glyph boxes come from `Icon.layout`: one line of the icon font
/// tall, so a hair taller than wide on a 3x screen.
final class SessionListIconBoxTests: XCTestCase {
    func testTheBranchIconCentresItsRNBox() {
        let layout = FlatSessionRowLayout(.init(
            width: 393,
            title: text("Fix the build", lineHeight: 22, maxLines: 1),
            timestamp: text("12:55", lineHeight: 22, maxLines: 1),
            project: text("happy", lineHeight: 20, maxLines: 1),
            workspace: text("fix-login", lineHeight: 18, maxLines: 1),
            branchIcon: CGSize(width: 13, height: 13.33),
            showsDivider: true
        ))
        assertFrame(layout.workspace, rect(88, 53, 72, 18))
        assertFrame(layout.branchIcon, rect(164, 55.335, 13, 13.33))
        XCTAssertEqual(layout.size.height, 81)
    }

    func testNoSessionsCentresTheTallerIconBox() {
        let layout = NoSessionsLayout(.init(
            size: phone,
            safeArea: phoneUnderBar,
            icon: CGSize(width: 56, height: 57.67),
            title: text("No sessions yet", lineHeight: 30),
            description: text("Start one on a connected machine.", lineHeight: 22),
            action: nil
        ))
        assertFrame(layout.icon, rect(168.5, 363.665, 56, 57.67))
        assertFrame(layout.title, rect(136.5, 441.335, 120, 30))
        assertFrame(layout.description, rect(64.5, 479.335, 264, 22))
    }
}
