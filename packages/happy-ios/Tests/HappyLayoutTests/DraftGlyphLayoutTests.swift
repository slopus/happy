import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// Where the draft glyph (`create-outline`, `textSecondary`) goes in each
/// row that draws it, and that it never changes a height:
/// FlatSessionRow.tsx's `workspaceMeta` (13), ActiveSessionsGroupCompact's
/// trailing slot (14) and SessionsList.tsx's avatar overlay (12).
final class DraftGlyphLayoutTests: XCTestCase {
    /// Ionicons' metrics (512 per em, ascender 454, descender -71), the
    /// glyph a full em wide, as `scripts/generate-icons.py` writes them.
    private static let ionicons = IconMetrics(unitsPerEm: 512, advance: 512, ascender: 454, descender: -71)

    private func box(_ size: CGFloat, scale: CGFloat) -> IconLayout {
        IconLayout(metrics: Self.ionicons, size: size, scale: scale)
    }

    private func flat(
        width: CGFloat = 393,
        workspace: Measurable? = fixed(72, 18),
        changes: CGSize? = nil,
        draft: CGSize?,
        lines: FlatSessionRowLayout.Lines = .designed
    ) -> FlatSessionRowLayout {
        FlatSessionRowLayout(.init(
            width: width,
            title: fixed(200, lines.title),
            timestamp: fixed(40, 22),
            project: fixed(100, lines.project),
            workspace: workspace,
            branchIcon: CGSize(width: 13, height: 40.0 / 3),
            changes: changes,
            draftIcon: draft,
            showsDivider: true,
            lines: lines
        ))
    }

    // MARK: Flat rows

    func testTheGlyphsBoxIsOneLineOfTheIconFont() {
        // 13 × 525/512 = 13.33, up to the pixel.
        XCTAssertEqual(box(13, scale: 3).size, CGSize(width: 13, height: 40.0 / 3))
        XCTAssertEqual(box(13, scale: 2).size, CGSize(width: 13, height: 13.5))
        XCTAssertEqual(box(14, scale: 3).size, CGSize(width: 14, height: 44.0 / 3))
        XCTAssertEqual(box(14, scale: 2).size, CGSize(width: 14, height: 14.5))
        XCTAssertEqual(box(12, scale: 3).size, CGSize(width: 12, height: 37.0 / 3))
        XCTAssertEqual(box(12, scale: 2).size, CGSize(width: 12, height: 12.5))
    }

    func testTheGlyphEndsTheWorkspacesRowAlone() {
        let draft = box(13, scale: 3).size
        let layout = flat(draft: draft)
        XCTAssertEqual(layout.size.height, 81)
        // At the right edge, centred on the 18 row at 53.
        assertFrame(layout.draftIcon, rect(364, 53 + (18 - 40.0 / 3) / 2, 13, 40.0 / 3))
        assertFrame(layout.workspace, rect(88, 53, 72, 18))
        XCTAssertNil(layout.changes)
        XCTAssertNil(flat(draft: nil).draftIcon)
    }

    func testTheGlyphLeadsTheCountsWithNoGap() {
        let line: CGFloat = 43.0 / 3
        let layout = flat(changes: CGSize(width: 40, height: line), draft: box(13, scale: 3).size)
        XCTAssertEqual(layout.size.height, 81)
        // The meta is 13 + 8 + 40: the glyph, RigGitLineChanges' padding,
        // the counts. The counts keep the place they have without a draft.
        assertFrame(layout.draftIcon, rect(316, 53 + (18 - 40.0 / 3) / 2, 13, 40.0 / 3))
        assertFrame(layout.changes, rect(337, 53 + (18 - line) / 2, 40, line))
        XCTAssertEqual(flat(changes: CGSize(width: 40, height: line), draft: nil).changes, layout.changes)
    }

    func testTheWorkspaceYieldsTheGlyphItsWidth() {
        let long = text("a-workspace-name-far-too-long-for-the-row", lineHeight: 18, maxLines: 1)
        // The column's 289 less the glyph's 13, the 4 and the branch's 13.
        let alone = flat(workspace: long, draft: box(13, scale: 3).size)
        XCTAssertEqual(alone.workspace?.width, 259)
        XCTAssertEqual(alone.branchIcon?.maxX, 364)
        XCTAssertEqual(alone.draftIcon?.minX, 364)
        // With 40 of counts, 8 + 40 less again.
        let both = flat(workspace: long, changes: CGSize(width: 40, height: 14.5), draft: box(13, scale: 2).size)
        XCTAssertEqual(both.workspace?.width, 211)
        XCTAssertEqual(both.draftIcon?.minX, 316)
        XCTAssertEqual(both.changes?.minX, 337)
    }

    func testAMetaWiderThanTheRowStartsWhereTheColumnDoes() {
        // The column runs from 88 to 104: the glyph at 88, the counts after
        // its 13 and their 8, past the column's end.
        let layout = flat(width: 120, workspace: text("fix-login", lineHeight: 18, maxLines: 1), changes: CGSize(width: 40, height: 14.5), draft: CGSize(width: 13, height: 13.5))
        XCTAssertEqual(layout.draftIcon?.minX, 88)
        XCTAssertEqual(layout.changes?.minX, 109)
        XCTAssertEqual(layout.workspace?.width, 0)
    }

    /// The glyph keeps its 13 at every text size; RN's lines grow by its
    /// multiplier, each up to the screen's pixel. A draft never moves the
    /// row's height, with or without a workspace or counts, and sits
    /// centred on the workspace's row, as the branch glyph and the counts
    /// do.
    func testTheGlyphNeverChangesARowsHeightAtAnyTextSize() {
        for scale in [CGFloat(2), 3] {
            func line(_ value: CGFloat) -> CGFloat { (value * scale).rounded(.up) / scale }
            let draft = box(13, scale: scale).size
            for category in TextSizeCategory.allCases {
                let m = TextScale(category).multiplier
                let lines = FlatSessionRowLayout.Lines(
                    title: line(22 * m), project: line(20 * m), workspace: line(18 * m), changes: line(11 * 1.3 * m)
                )
                for hasWorkspace in [false, true] {
                    for hasChanges in [false, true] {
                        let label = "\(category) @\(scale)x workspace \(hasWorkspace) changes \(hasChanges)"
                        let changes = hasChanges ? CGSize(width: 40, height: lines.changes) : nil
                        let workspace = hasWorkspace ? fixed(72, lines.workspace) : nil
                        let without = flat(workspace: workspace, changes: changes, draft: nil, lines: lines)
                        let with = flat(workspace: workspace, changes: changes, draft: draft, lines: lines)
                        XCTAssertEqual(with.size, without.size, label)
                        XCTAssertEqual(with.size.height, FlatSessionRowLayout.height(lines: lines, workspace: hasWorkspace, changes: hasChanges, branchIcon: 40.0 / 3), label)
                        XCTAssertEqual(with.title, without.title, label)
                        XCTAssertEqual(with.project, without.project, label)
                        XCTAssertEqual(with.changes, without.changes, label)
                        let glyph = try! XCTUnwrap(with.draftIcon)
                        XCTAssertEqual(glyph.size, draft, label)
                        XCTAssertEqual(glyph.maxX, hasChanges ? 377 - 48 : 377, label)
                        if let changes = with.changes { XCTAssertEqual(glyph.midY, changes.midY, accuracy: 0.0001, label) }
                        if let branch = with.branchIcon { XCTAssertEqual(glyph.midY, branch.midY, accuracy: 0.0001, label) }
                        // Inside the workspace's row, above the divider.
                        XCTAssertGreaterThanOrEqual(glyph.minY, with.project.maxY, label)
                        XCTAssertLessThanOrEqual(glyph.maxY, with.size.height - FlatSessionRowLayout.Metrics.paddingVertical, label)
                    }
                }
            }
        }
    }

    // MARK: The iPad sidebar's chats and archived cards

    /// The 14 glyph takes the dot's 18 slot, centred as Yoga centres a text
    /// node (its offset floored to the pixel), and the 56 row and its
    /// slot stay put whatever the title's size.
    func testAChatsDraftIsCentredInTheTrailingSlotAtEveryTextSize() {
        for (scale, hairline) in [(CGFloat(2), CGFloat(0.5)), (3, 1.0 / 3)] {
            var slots: [CGRect] = []
            for category in TextSizeCategory.allCases {
                let m = TextScale(category).multiplier
                let titleLine = (20 * m * scale).rounded(.up) / scale
                let layout = TabletChatRowLayout(.init(
                    width: 300, hairline: hairline, title: text("Fix the build", lineHeight: titleLine, maxLines: 2),
                    first: true, last: true, projectEnd: false, showsBorder: false
                ))
                XCTAssertEqual(layout.row.height, 56)
                slots.append(layout.indicator)
            }
            let slot = slots[0]
            XCTAssertTrue(slots.allSatisfy { $0 == slot }, "@\(scale)x")
            let glyph = box(14, scale: scale).frame(centeredIn: slot, scale: scale)
            XCTAssertTrue(slot.contains(glyph), "@\(scale)x")
        }
        let slot = TabletChatRowLayout(.init(
            width: 300, hairline: 0.5, title: text("Fix the build", lineHeight: 20),
            first: true, last: true, projectEnd: true, showsBorder: false
        )).indicator
        assertFrame(slot, rect(249.5, 19.5, 18, 18))
        // (18 - 14) / 2 = 2; (18 - 14.5) / 2 = 1.75, floored to 1.5.
        assertFrame(box(14, scale: 2).frame(centeredIn: slot, scale: 2), rect(251.5, 21, 14, 14.5))
    }

    func testAnArchivedCardsDraftSitsOverTheAvatarsCorner() {
        let layout = TabletArchivedRowLayout(.init(
            width: 300, hairline: 0.5,
            title: text("Old chat", lineHeight: 20),
            subtitle: text("project", lineHeight: 18),
            subtitleRow: true,
            status: text("online", lineHeight: 16),
            last: false
        ))
        assertFrame(layout.avatar, rect(32.5, 20.5, 48, 48))
        // `bottom: -2, right: -2`, 18 square.
        assertFrame(layout.draftOverlay, rect(64.5, 52.5, 18, 18))
        // The 12 glyph: (18 - 12) / 2 = 3; (18 - 12.5) / 2 = 2.75, floored
        // to 2.5.
        assertFrame(box(12, scale: 2).frame(centeredIn: layout.draftOverlay, scale: 2), rect(67.5, 55, 12, 12.5))
        XCTAssertTrue(layout.row.contains(layout.draftOverlay))
    }

    /// The card is 88 at every text size, so the overlay never moves; the
    /// lines beside it are centred and cut at the card.
    func testTheArchivedOverlayKeepsItsPlaceAtEveryTextSize() {
        for category in TextSizeCategory.allCases {
            let m = TextScale(category).multiplier
            func line(_ value: CGFloat) -> CGFloat { (value * m * 3).rounded(.up) / 3 }
            let layout = TabletArchivedRowLayout(.init(
                width: 300, hairline: 1.0 / 3,
                title: text("Old chat", lineHeight: line(16), maxLines: 1),
                subtitle: text("project", lineHeight: line(13), maxLines: 1),
                subtitleRow: true,
                status: text("online", lineHeight: line(12)),
                last: true
            ))
            assertFrame(layout.draftOverlay, rect(layout.avatar.maxX - 16, layout.avatar.maxY - 16, 18, 18))
            assertFrame(layout.avatar, rect(16 + 1.0 / 3 + 16, 1.0 / 3 + 20, 48, 48))
            XCTAssertEqual(layout.size.height, TabletGroupedRowHeights.archived(width: 300, hairline: 1.0 / 3, last: true), "\(category)")
        }
    }
}
