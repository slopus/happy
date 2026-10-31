#if canImport(UIKit)
import HappyIcons
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// What home's row plans are laid out from, at every text size on a 3x
/// screen: one line of each style the rows draw, as the plans measure it,
/// and the glyph boxes beside them. `HomeRowPlanTextSizeTests` (HappyLayout)
/// lays the rows out from these same numbers and pins their frames; this
/// pins the numbers to the fonts, so the two together are the rows as drawn.
@MainActor
final class HomeRowLinesTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    /// The styles without a fixed line height: the font's own, in pixels
    /// on a 3x screen, smallest text size first. The same table is
    /// `HomeRowPlanTextSizeTests.fontLines`.
    static let fontLines: [String: [Int]] = [
        "sessionLineChanges": [36, 38, 41, 43, 48, 53, 59, 77, 92, 114, 135, 154],
        "tabletArchivedSubtitle": [42, 45, 48, 51, 57, 63, 69, 91, 109, 135, 160, 182],
        "tabletArchivedTitle": [49, 52, 56, 59, 66, 73, 80, 105, 126, 155, 184, 209],
        "tabletChatTitle": [49, 52, 56, 59, 66, 73, 80, 105, 126, 155, 184, 209],
        "tabletMachineName": [36, 38, 41, 43, 48, 53, 59, 77, 92, 114, 135, 154],
    ]

    /// Where a title as the plans measure it is not one line: the
    /// timestamp's 13pt font at the designed size runs a pixel past its
    /// 22 (`HomeRowPlanTextSizeTests.measured`).
    static let measuredOff: [String: [TextSizeCategory: Int]] = ["sessionTimestamp": [.large: 67]]

    static let styles: [(String, TextStyle)] = [
        ("sessionTitle", TextStyles.sessionTitle),
        ("sessionTimestamp", TextStyles.sessionTimestamp),
        ("sessionProject", TextStyles.sessionProject),
        ("sessionWorkspace", TextStyles.sessionWorkspace),
        ("sessionLineChanges", TextStyles.sessionLineChanges),
        ("sessionDayHeader", TextStyles.sessionDayHeader),
        ("archiveToggle", TextStyles.archiveToggle),
        ("projectName", TextStyles.projectName),
        ("worktreeName", TextStyles.worktreeName),
        ("worktreeToggle", TextStyles.worktreeToggle),
        ("projectMachine", TextStyles.projectMachine),
        ("projectTimestamp", TextStyles.projectTimestamp),
        ("gitApproximate", TextStyles.gitApproximate),
        ("gitLineCount", TextStyles.gitLineCount),
        ("tabletMachineName", TextStyles.tabletMachineName),
        ("tabletWorkspaceTitle", TextStyles.tabletWorkspaceTitle),
        ("tabletWorkspaceBranch", TextStyles.tabletWorkspaceBranch),
        ("tabletChatTitle", TextStyles.tabletChatTitle),
        ("tabletArchivedTitle", TextStyles.tabletArchivedTitle),
        ("tabletArchivedSubtitle", TextStyles.tabletArchivedSubtitle),
        ("tabletArchivedStatus", TextStyles.tabletArchivedStatus),
    ]

    /// Each style's one line, as the plans measure a title (TextKit, up to
    /// the next pixel), is its `oneLine`; a fixed line height is that
    /// height grown with the text, up to the next pixel; the others are
    /// the fonts' lines in `fontLines`.
    func testEveryStylesLineAtEveryTextSize() {
        var found: [String: [Int]] = [:]
        for (name, style) in Self.styles {
            for category in TextSizeCategory.allCases {
                let environment = TextEnvironment(scale: TextScale(category), displayScale: 3)
                let line = style.oneLine(in: environment)
                let measured = HomeRowMeasurer.measure("Fix the build", style: style, in: environment, width: .greatestFiniteMagnitude, maxLines: 1).height
                let expected = Self.measuredOff[name]?[category].map { CGFloat($0) / 3 } ?? line
                XCTAssertEqual(measured, expected, "\(name) at \(category): a title measures \(measured), one line is \(line)")
                if let fixed = style.scaled(TextScale(category)).lineHeight {
                    XCTAssertEqual(line, (fixed * 3).rounded(.up) / 3, "\(name) at \(category)")
                } else {
                    found[name, default: []].append(Int((line * 3).rounded()))
                    XCTAssertEqual(line * 3, (line * 3).rounded(), accuracy: 0.0001, "\(name) at \(category) is off the pixel grid")
                }
            }
        }
        if found != Self.fontLines {
            let listed = found.keys.sorted().map { "        \"\($0)\": \(found[$0]!)," }.joined(separator: "\n")
            XCTFail("the fonts' lines moved; they are now:\n    static let fontLines: [String: [Int]] = [\n\(listed)\n    ]")
        }
    }

    /// The glyph boxes the plans lay out (`Icon.layout`), on a 3x screen,
    /// which no text size changes: `HomeRowPlanTextSizeTests.glyphs`.
    func testTheGlyphBoxes() async {
        func box(_ name: String, _ size: CGFloat) -> CGSize {
            Icon.ionicons(name).layout(size: size, scale: 3)?.size ?? .zero
        }
        let boxes: [(String, CGSize)] = [
            ("branch", box("git-branch-outline", FlatSessionRowLayout.Metrics.branchIconSize)),
            ("draft", box("create-outline", FlatSessionRowLayout.Metrics.draftIconSize)),
            ("machine", box("desktop-outline", 12)),
            ("tabletMachine", box("desktop-outline", 11)),
            ("chevron", box("chevron-down", 13)),
        ]
        let listed = boxes.map { "\($0.0) \($0.1.width * 3)x\($0.1.height * 3)" }.joined(separator: ", ")
        XCTAssertEqual(listed, "branch 39.0x40.0, draft 39.0x40.0, machine 36.0x37.0, tabletMachine 33.0x34.0, chevron 39.0x40.0", "the glyph boxes, in pixels")
        for category in [TextSizeCategory.extraSmall, .accessibilityExtraExtraExtraLarge] {
            let rows = await HomeTextEnvironment.make(TextEnvironment(scale: TextScale(category), displayScale: 3)).rows
            XCTAssertEqual(rows.branchIcon, boxes[0].1)
            XCTAssertEqual(rows.machineIcon, boxes[2].1)
            XCTAssertEqual(rows.hairline, 1.0 / 3)
        }
    }
}
#endif
