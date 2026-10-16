#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyIcons
import HappyLayout
import HappyStore
@testable import HappyUI
import UIKit
import XCTest

/// The draft glyph in the cells that draw it, at several text sizes,
/// accessibility sizes included: a flat row's `workspaceMeta` glyph never
/// changes the row's height (it stays the height worked out off the main
/// thread), a compact chat's glyph takes its dot's slot, and an archived
/// card's sits over its avatar's corner.
@MainActor
final class DraftGlyphCellTests: XCTestCase {
    private let categories: [UIContentSizeCategory] = [.extraSmall, .large, .extraExtraExtraLarge, .accessibilityMedium, .accessibilityExtraExtraExtraLarge]
    private let scales: [CGFloat] = [2, 3]

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func laidOut(_ cell: UITableViewCell, width: CGFloat, scale: CGFloat, category: UIContentSizeCategory) -> CGFloat {
        cell.traitOverrides.followsTextSize = true
        cell.traitOverrides.displayScale = scale
        cell.traitOverrides.preferredContentSizeCategory = category
        cell.updateTraitsIfNeeded()
        cell.frame = CGRect(x: 0, y: 0, width: width, height: 100)
        cell.layoutIfNeeded()
        let height = cell.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        cell.frame = CGRect(x: 0, y: 0, width: width, height: height)
        cell.layoutIfNeeded()
        return height
    }

    private func box(_ size: CGFloat, scale: CGFloat) throws -> IconLayout {
        try XCTUnwrap(Icon.ionicons("create-outline").layout(size: size, scale: scale))
    }

    func testAFlatRowsDraftNeverChangesItsHeight() async throws {
        for category in categories {
            for scale in scales {
                let environment = await HomeTextEnvironment.make(TextEnvironment(scale: TextScale(TextSizeCategory(category)), displayScale: scale))
                for workspace in [nil, "fix-login"] {
                    for changes in [nil, HomeRowMeasurerTests.changes] {
                        let at = "@\(scale)x \(category.rawValue) workspace \(workspace != nil) changes \(changes != nil)"
                        var row = HomeRowMeasurerTests.session(workspace: workspace, changes: changes)
                        let plain = SessionRowCell(style: .default, reuseIdentifier: nil)
                        plain.lines = environment.rows.sessionLines
                        plain.configure(row, style: .gradient, monochrome: false)
                        let plainHeight = laidOut(plain, width: 393, scale: scale, category: category)
                        XCTAssertTrue(plain.draftIcon.isHidden, at)

                        row.hasDraft = true
                        let cell = SessionRowCell(style: .default, reuseIdentifier: nil)
                        cell.lines = environment.rows.sessionLines
                        cell.configure(row, style: .gradient, monochrome: false)
                        let height = laidOut(cell, width: 393, scale: scale, category: category)
                        XCTAssertFalse(cell.draftIcon.isHidden, at)
                        XCTAssertEqual(height, plainHeight, at)
                        XCTAssertEqual(height, HomeRowMeasurer.height(.flatSession(workspace: workspace != nil, changes: changes != nil), width: 393, environment: environment), at)

                        // RN's 13 box, unscaled, where the layout puts it.
                        let glyph = try box(13, scale: scale)
                        XCTAssertEqual(cell.draftIcon.sizeThatFits(.zero), glyph.size, at)
                        let layout = cell.layout(width: cell.contentView.bounds.width)
                        let frame = try XCTUnwrap(layout.draftIcon, at)
                        assertSamePixels(cell.draftIcon.frame, PixelGrid.snap(frame, scale: scale), scale: scale, at)
                        if changes != nil {
                            XCTAssertLessThanOrEqual(cell.draftIcon.frame.maxX + FlatSessionRowLayout.Metrics.changesPaddingLeft, cell.changes.frame.minX + 1 / scale, at)
                            assertSamePixels(cell.changes.frame, plain.changes.frame, scale: scale, "the counts stay put, \(at)")
                        }
                        XCTAssertGreaterThanOrEqual(cell.draftIcon.frame.minY, cell.projectLabel.frame.maxY - 1 / scale, at)
                        XCTAssertLessThanOrEqual(cell.draftIcon.frame.maxY, height, at)
                    }
                }
            }
        }
    }

    func testACompactChatsDraftTakesTheDotsSlot() throws {
        for category in categories {
            for scale in scales {
                let at = "@\(scale)x \(category.rawValue)"
                var row = TabletChatRow(
                    id: "c", title: "Fix the build", connected: true, indicator: .dot(.idle, pulsing: false),
                    showsBorder: false, first: true, last: true, projectEnd: false
                )
                let plain = TabletChatCell(style: .default, reuseIdentifier: nil)
                plain.configure(row)
                let plainHeight = laidOut(plain, width: 320, scale: scale, category: category)
                XCTAssertFalse(plain.dot.isHidden, at)
                XCTAssertTrue(plain.draftIcon.isHidden, at)

                row.hasDraft = true
                let cell = TabletChatCell(style: .default, reuseIdentifier: nil)
                cell.configure(row)
                let height = laidOut(cell, width: 320, scale: scale, category: category)
                XCTAssertEqual(height, plainHeight, at)
                XCTAssertTrue(cell.dot.isHidden, at)
                XCTAssertFalse(cell.dot.isPulsing, at)
                XCTAssertFalse(cell.draftIcon.isHidden, at)
                XCTAssertEqual(cell.draftIcon.size, 14)
                let layout = TabletChatRowLayout(.init(
                    width: cell.contentView.bounds.width, hairline: cell.hairline, title: cell.titleLabel.measurable,
                    first: true, last: true, projectEnd: false, showsBorder: false
                ))
                let slot = layout.indicator.offsetBy(dx: -layout.row.minX, dy: -layout.row.minY)
                assertSamePixels(cell.draftIcon.frame, PixelGrid.snap(slot, scale: scale), scale: scale, at)
                XCTAssertTrue(cell.draftIcon.superview?.bounds.contains(cell.draftIcon.frame) ?? false, "inside the row, \(at)")

                // Reused for a row without one, the dot comes back.
                row.hasDraft = false
                cell.configure(row)
                XCTAssertFalse(cell.dot.isHidden, at)
                XCTAssertTrue(cell.draftIcon.isHidden, at)
            }
        }
    }

    func testAnArchivedCardsDraftSitsOverTheAvatar() throws {
        let record = SessionRecord(
            id: "a1", seq: 1, createdAt: 0, updatedAt: 0, active: false, activeAt: 0, projectId: nil,
            metadataVersion: 1, metadataCipher: "cipher",
            metadata: .object(["path": .string("/work/old")]),
            agentStateVersion: 0, agentStateCipher: nil, agentState: nil, dataKeyCipher: "key", decryptable: true
        )
        var session = HomeRowMeasurerTests.session("a1", workspace: nil)
        session.state = .disconnected
        for category in categories {
            for scale in scales {
                let at = "@\(scale)x \(category.rawValue)"
                session.hasDraft = false
                let plain = TabletArchivedCell(style: .default, reuseIdentifier: nil)
                plain.configure(TabletArchivedRow(record, row: session, now: 0, first: true), style: .gradient, monochrome: false)
                let plainHeight = laidOut(plain, width: 320, scale: scale, category: category)
                XCTAssertTrue(plain.draftIcon.isHidden, at)

                session.hasDraft = true
                let cell = TabletArchivedCell(style: .default, reuseIdentifier: nil)
                cell.configure(TabletArchivedRow(record, row: session, now: 0, first: true), style: .gradient, monochrome: false)
                let height = laidOut(cell, width: 320, scale: scale, category: category)
                XCTAssertEqual(height, plainHeight, at)
                XCTAssertFalse(cell.draftIcon.isHidden, at)
                XCTAssertEqual(cell.draftIcon.size, 12)
                XCTAssertTrue(cell.draftIcon.superview === cell.card, at)
                XCTAssertFalse(cell.draftIcon.isUserInteractionEnabled, at)
                // Over the avatar: after it among the card's subviews.
                let views = cell.card.subviews
                XCTAssertGreaterThan(views.firstIndex(of: cell.draftIcon) ?? -1, views.firstIndex(of: cell.avatar) ?? Int.max, at)
                let avatar = cell.avatar.frame
                assertSamePixels(
                    cell.draftIcon.frame,
                    PixelGrid.snap(CGRect(x: avatar.maxX + 2 - 18, y: avatar.maxY + 2 - 18, width: 18, height: 18), scale: scale),
                    scale: scale, at
                )
                XCTAssertTrue(cell.card.bounds.contains(cell.draftIcon.frame), at)
            }
        }
    }
}
#endif
