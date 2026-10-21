#if canImport(UIKit)
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The text that followed no text size before: the sidebar's bots, against
/// the heights worked out for them off the main thread; and session info's
/// and the duplicate sheet's text made outside `TextStyle`, scaled by the
/// multiplier as RN scales any Text, and at the designed size where the
/// screen doesn't follow the text size.
@MainActor
final class SecondaryTextSizeTests: XCTestCase {
    private let categories: [UIContentSizeCategory] = [.extraSmall, .large, .extraExtraExtraLarge, .accessibilityMedium, .accessibilityExtraExtraExtraLarge]
    private let scales: [CGFloat] = [2, 3]

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func multiplier(_ category: UIContentSizeCategory) -> CGFloat {
        TextScale(TextSizeCategory(category)).multiplier
    }

    private func follow(_ view: UIView, scale: CGFloat, category: UIContentSizeCategory) {
        view.traitOverrides.followsTextSize = true
        view.traitOverrides.displayScale = scale
        view.traitOverrides.preferredContentSizeCategory = category
        view.updateTraitsIfNeeded()
    }

    private func fitting(_ view: UIView, width: CGFloat = .greatestFiniteMagnitude) -> CGSize {
        view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    }

    // MARK: The sidebar's bots

    func testTheSidebarsBotsMatchTheirCellsAtEveryTextSize() async {
        for category in categories {
            for scale in scales {
                let text = TextEnvironment(scale: TextScale(TextSizeCategory(category)), displayScale: scale)
                let metrics = TabletGroupedHeights.metrics(text)
                // The lines home's flat rows take at this size.
                let home = await HomeTextEnvironment.make(text)
                XCTAssertEqual(metrics.sessionLines, home.rows.sessionLines, category.rawValue)
                XCTAssertEqual(metrics.branchIcon, home.rows.branchIcon.height, category.rawValue)
                for width in [280, 320] as [CGFloat] {
                    let at = "\(width) @\(scale)x, \(category.rawValue)"
                    for workspace in [nil, "fix-login"] {
                        for changes in [nil, HomeRowMeasurerTests.changes] {
                            let session = HomeRowMeasurerTests.session(workspace: workspace, changes: changes)
                            let cell = SessionRowCell(style: .default, reuseIdentifier: nil)
                            // As the grouped list configures it.
                            cell.lines = metrics.sessionLines
                            cell.configure(session, style: .gradient, monochrome: false)
                            follow(cell, scale: scale, category: category)
                            cell.frame = CGRect(x: 0, y: 0, width: width, height: 100)
                            cell.layoutIfNeeded()
                            let heading = TabletGroupedHeights.heading(.bot(session))
                            XCTAssertEqual(heading, .bot(workspace: workspace != nil, changes: changes != nil), at)
                            XCTAssertEqual(
                                heading.map { TabletGroupedRowHeights.heading($0, width: width, metrics: metrics) },
                                fitting(cell, width: width).height,
                                "\(workspace ?? "-") \(changes != nil) at \(at)"
                            )
                            XCTAssertEqual(cell.projectLabel.renderedStyle.size, 15 * multiplier(category), at)
                        }
                    }
                }
            }
        }
    }

    // MARK: Session info

    func testATrailingDetailIsFourteenTimesTheMultiplier() {
        let plain = DetailTrailingText("3 files", color: Palette.textSecondary)
        XCTAssertEqual(plain.font.pointSize, 14)
        for category in categories {
            let label = DetailTrailingText("3 files", color: Palette.textSecondary)
            follow(label, scale: 3, category: category)
            XCTAssertEqual(label.font.pointSize, 14 * multiplier(category), accuracy: 1e-9, category.rawValue)
            XCTAssertEqual(fitting(label).height, label.font.lineHeight, accuracy: 1, category.rawValue)
        }
    }

    /// Laid out off the main thread: the block asks at a width, and is
    /// measured once its layout is in.
    private func measured(_ view: CodeBlockView, width: CGFloat) async -> CodeBlockLayout {
        _ = view.layout(width: width)
        await view.measured()
        return view.layout(width: width)
    }

    func testARawJSONBlockScalesItsMenloAndItsLine() async {
        let code = "{\n  \"a\": 1\n}"
        let width: CGFloat = 393
        typealias M = CodeBlockLayout.Metrics
        let designed = CodeBlockView(code: code)
        // Three 18pt lines between 12 above and below, 12 under the box.
        let designedLayout = await measured(designed, width: width)
        XCTAssertEqual(designedLayout.text.height, 3 * 18, accuracy: 0.5)
        for category in categories {
            for scale in scales {
                let view = CodeBlockView(code: code)
                follow(view, scale: scale, category: category)
                let layout = await measured(view, width: width)
                let line = M.lineHeight * multiplier(category)
                XCTAssertEqual(layout.text.height, 3 * line, accuracy: 1 / scale + 0.01, "\(category.rawValue) @\(scale)x")
                XCTAssertEqual(layout.size.height, layout.text.height + M.padding * 2 + M.marginBottom, accuracy: 1e-9)
                XCTAssertEqual(view.sizeThatFits(CGSize(width: width, height: 0)).height, layout.size.height)
            }
        }
    }

    func testARawJSONBlockRedrawsAtANewTextSize() async {
        let view = CodeBlockView(code: "{}")
        follow(view, scale: 3, category: .large)
        let large = await measured(view, width: 393).size.height
        view.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        view.updateTraitsIfNeeded()
        await view.measured()
        XCTAssertGreaterThan(view.layout(width: 393).size.height, large)
    }

    // MARK: The duplicate sheet

    func testTheSheetsTextIsTheSystemFontTimesTheMultiplier() {
        let styles: [(SheetText.Style, CGFloat, UIFont.Weight)] = [
            (SheetText.title, 17, .semibold),
            (SheetText.subtitle, 13, .regular),
            (SheetText.empty, 14, .regular),
            (SheetText.row, 14, .regular),
            (SheetText.meta, 12, .regular),
            (SheetText.primaryButton, 15, .semibold),
            (SheetText.secondaryButton, 15, .medium),
        ]
        for (style, size, weight) in styles {
            XCTAssertEqual(style.font(nil), .systemFont(ofSize: size, weight: weight))
            for category in categories {
                let m = multiplier(category)
                XCTAssertEqual(style.font(TextScale(TextSizeCategory(category))).pointSize, size * m, accuracy: 1e-9)
            }
        }
        XCTAssertEqual(SheetText.row.line(nil), 19)
        XCTAssertEqual(SheetText.row.line(TextScale(.accessibilityExtraExtraExtraLarge)) ?? 0, 19 * multiplier(.accessibilityExtraExtraExtraLarge), accuracy: 1e-9)
        XCTAssertNil(SheetText.title.line(TextScale(.accessibilityExtraExtraExtraLarge)))
    }

    func testARewindPointsPreviewIsThreeScaledLines() {
        let preview = String(repeating: "Refactor the session list so that rows measure off main. ", count: 6)
        let width: CGFloat = 300
        let designed = SheetLabel(SheetText.row, color: Palette.text, lines: 3)
        designed.text(preview)
        XCTAssertNil(designed.textScale)
        XCTAssertEqual(fitting(designed, width: width).height, 3 * 19, accuracy: 0.5)
        for category in categories {
            for scale in scales {
                let label = SheetLabel(SheetText.row, color: Palette.text, lines: 3)
                label.text(preview)
                follow(label, scale: scale, category: category)
                let line = 19 * multiplier(category)
                XCTAssertEqual(fitting(label, width: width).height, 3 * line, accuracy: 1 / scale + 0.01, "\(category.rawValue) @\(scale)x")
            }
        }
    }

    func testASheetLabelMeasuredBeforeItsTraitsUpdateMeasuresWhatItDraws() {
        let label = SheetLabel(SheetText.title, color: Palette.text, lines: 1)
        label.text("Duplicate from…")
        label.traitOverrides.followsTextSize = true
        label.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        // No updateTraitsIfNeeded: the layout asks first.
        let height = fitting(label).height
        XCTAssertEqual(label.textScale, TextScale(.accessibilityExtraExtraExtraLarge))
        XCTAssertEqual(height, UIFont.systemFont(ofSize: 17 * multiplier(.accessibilityExtraExtraExtraLarge), weight: .semibold).lineHeight, accuracy: 1)
    }
}
#endif
