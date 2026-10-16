#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Diffs and the file viewer at the person's text size: what the plans
/// measure off the main thread against the text as UIKit lays it out and
/// against the rows as drawn, at every size from the smallest to the
/// largest accessibility size, and the caches keyed on the size.
@MainActor
final class DiffTextSizeTests: XCTestCase {
    private let categories: [UIContentSizeCategory] = [
        .extraSmall, .large, .extraExtraExtraLarge, .accessibilityMedium, .accessibilityLarge, .accessibilityExtraExtraExtraLarge,
    ]

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func environment(_ category: UIContentSizeCategory, scale: CGFloat = 3) -> TextEnvironment {
        TextEnvironment(scale: TextScale(TextSizeCategory(category)), displayScale: scale)
    }

    private func pixel(_ value: CGFloat, _ scale: CGFloat) -> CGFloat {
        ((value * scale) - 0.001).rounded(.up) / scale
    }

    /// A UILabel's own size for `text`, as RN's Text measures one.
    private func labelSize(_ text: NSAttributedString, width: CGFloat = .greatestFiniteMagnitude, lines: Int = 1) -> CGSize {
        let label = UILabel()
        label.numberOfLines = lines
        label.attributedText = text
        return label.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    }

    /// Whether `view` is one of the module's private row classes.
    private static func named(_ view: UIView, _ name: String) -> Bool {
        String(describing: type(of: view)) == name
    }

    private static let source = DiffChunkSource(
        oldText: (1...140).map { "let value\($0) = compute(\($0))" }.joined(separator: "\n"),
        newText: (1...140).map { $0 % 7 == 0 ? "let value\($0) = compute(\($0)) + offset" : "let value\($0) = compute(\($0))" }.joined(separator: "\n"),
        fileName: "Values.swift"
    )

    // MARK: Metrics

    /// MonoProbe at the size drawn: the advance is the mono font's at
    /// 12 × the multiplier, and the row its line up to the pixel.
    func testTheAdvanceIsMeasuredAtTheSizeDrawn() {
        for category in categories {
            let text = environment(category)
            let metrics = DiffStyle.metrics(text: text)
            let drawn = 12 * text.scale.multiplier
            let sample = String(repeating: "M", count: 50) as NSString
            let advance = sample.size(withAttributes: [.font: Fonts.font(.mono, size: drawn)]).width / 50
            XCTAssertEqual(metrics.charWidth, advance, accuracy: 1e-9, category.rawValue)
            XCTAssertEqual(metrics.scale, text.scale, category.rawValue)
            XCTAssertEqual(metrics.lineHeight, pixel(18 * text.scale.multiplier, 3), accuracy: 1e-9, category.rawValue)
            XCTAssertEqual(DiffStyle.code(metrics).size, drawn, accuracy: 1e-9, category.rawValue)
            XCTAssertEqual(DiffStyle.small(metrics).size, 11 * text.scale.multiplier, accuracy: 1e-9, category.rawValue)
        }
        // Nil is the designed size, measured as before.
        XCTAssertEqual(DiffStyle.metrics().charWidth, DiffStyle.metrics(text: environment(.large)).charWidth)
        XCTAssertEqual(DiffStyle.metrics().lineHeight, 18)
    }

    /// Each row's text, the gutter's numbers and its marker, measured by a
    /// label, fit the frames the plan gave them, at every size.
    func testRowsFitTheirTextAtEverySize() throws {
        let render = RenderServices.isolated()
        for category in categories {
            let text = environment(category)
            let plan = DiffChunkPlan(source: Self.source, width: 393, render: render, syntaxDeadline: nil, text: text)
            let file = try XCTUnwrap(plan.files.first)
            let metrics = file.metrics
            let layout = file.layout
            for row in file.rows {
                switch row {
                case .line(let line):
                    let size = labelSize(DiffStyle.lineText(line.spans, metrics: metrics))
                    XCTAssertEqual(pixel(size.height, 3), layout.lineHeight, accuracy: 0.001, "row height, \(category.rawValue)")
                    // The code canvas holds the line past its 6pt inset.
                    XCTAssertLessThanOrEqual(DiffFileLayout.Metrics.codePaddingLeft + size.width, layout.contentWidth + 0.5, category.rawValue)
                    if let number = line.newNo ?? line.oldNo, let frame = layout.lineNumber {
                        let digits = labelSize(DiffStyle.small(metrics).attributedString(String(number), color: .black))
                        XCTAssertLessThanOrEqual(digits.width, frame.width + 0.001, "number \(number), \(category.rawValue)")
                    }
                    let marker = labelSize(DiffStyle.code(metrics).attributedString("−", color: .black))
                    XCTAssertLessThanOrEqual(marker.width, layout.marker.width + 0.001, "marker, \(category.rawValue)")
                case .hunk(let hunk):
                    let size = labelSize(DiffStyle.hunkText(hunk, canExpand: false, metrics: metrics))
                    XCTAssertEqual(pixel(size.height, 3), layout.lineHeight, accuracy: 0.001, "hunk, \(category.rawValue)")
                case .message:
                    break
                }
            }
            // "Show N more lines" is one line of semibold 13 at the size.
            XCTAssertGreaterThan(file.hiddenCount, 0)
            let bar = labelSize(DiffTextStyles.showMore.scaled(text.scale).attributedString(Strings.DiffDetail.showMoreLines(file.hiddenCount), color: .black))
            XCTAssertEqual(layout.input.showMoreTextHeight, bar.height.rounded(.up), accuracy: 0.001, category.rawValue)
        }
    }

    /// The rows as a DiffChunkView draws them, in a window that follows the
    /// text size: every code row and gutter row is its plan's height, one
    /// under the other, and the bar draws at the plan's size.
    func testDrawnRowsAreTheMeasuredRows() throws {
        let render = RenderServices.isolated()
        for category in categories {
            let text = environment(category)
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 6000))
            window.traitOverrides.preferredContentSizeCategory = category
            window.traitOverrides.displayScale = 3
            window.traitOverrides.followsTextSize = true
            window.isHidden = false
            let view = DiffChunkView()
            window.addSubview(view)
            let plan = DiffChunkPlan(source: Self.source, width: 393, render: render, syntaxDeadline: nil, text: text)
            view.apply(plan)
            view.frame = CGRect(origin: .zero, size: plan.size)
            window.layoutIfNeeded()
            let fileView = try XCTUnwrap(view.subviews.first as? DiffFileView)
            fileView.updateRows()
            let file = try XCTUnwrap(plan.files.first)
            let scroll = try XCTUnwrap(fileView.subviews.first { $0 is UIScrollView })
            let canvas = try XCTUnwrap(scroll.subviews.first { type(of: $0) == UIView.self })
            let rows = canvas.subviews.filter { Self.named($0, "DiffCodeRowView") }.sorted { $0.frame.minY < $1.frame.minY }
            XCTAssertFalse(rows.isEmpty, category.rawValue)
            for (index, row) in rows.enumerated() {
                assertSameFrame(row.frame, file.layout.row(index), "row \(index), \(category.rawValue)")
            }
            XCTAssertEqual(fileView.frame.height, file.height, accuracy: 0.001, category.rawValue)
            let bar = try XCTUnwrap(fileView.subviews.compactMap { $0 as? DiffShowMoreBar }.first)
            let label = try XCTUnwrap(bar.subviews.compactMap { $0 as? StyledLabel }.first)
            XCTAssertEqual(label.renderedStyle.size, 13 * text.scale.multiplier, accuracy: 1e-9, category.rawValue)
            window.isHidden = true
        }
    }

    /// The bar draws at its plan's size, not its traits': a designed plan
    /// under the largest size draws at 13.
    func testTheBarDrawsAtItsPlansSize() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 3000))
        window.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        window.traitOverrides.followsTextSize = true
        window.isHidden = false
        let view = DiffChunkView()
        window.addSubview(view)
        let plan = DiffChunkPlan(source: Self.source, width: 393, render: .isolated(), syntaxDeadline: nil)
        view.apply(plan)
        view.frame = CGRect(origin: .zero, size: plan.size)
        window.layoutIfNeeded()
        let fileView = try XCTUnwrap(view.subviews.first as? DiffFileView)
        let bar = try XCTUnwrap(fileView.subviews.compactMap { $0 as? DiffShowMoreBar }.first)
        let label = try XCTUnwrap(bar.subviews.compactMap { $0 as? StyledLabel }.first)
        XCTAssertEqual(label.renderedStyle.size, 13)
        window.isHidden = true
    }

    /// The header's path, badge and counts at the size: the row is as tall
    /// as its tallest text, measured by a label; the icon and chevron keep
    /// their 16 and 14.
    func testTheHeaderGrowsWithItsText() {
        var last: CGFloat = 0
        for category in categories {
            let text = environment(category)
            let plan = DiffHeaderPlan(path: "Sources/App/Values.swift", kind: .added, additions: 12, deletions: 3, collapsed: false, width: 393, scale: 3, text: text)
            let tallest = [plan.dir, plan.fileName, plan.badge!, plan.additions!, plan.deletions!].map { labelSize($0).height }.max()!
            // As tall as its tallest text, and the path's two faces on one
            // baseline reach a little further.
            XCTAssertGreaterThanOrEqual(plan.layout.size.height, max(16, tallest) + 18 - 0.001, category.rawValue)
            XCTAssertLessThanOrEqual(plan.layout.size.height, max(16, tallest) + 18 + 2 * text.scale.multiplier, category.rawValue)
            XCTAssertEqual(plan.layout.icon.size, CGSize(width: 16, height: 16))
            XCTAssertGreaterThanOrEqual(plan.layout.size.height, last, category.rawValue)
            last = plan.layout.size.height
        }
        // Nil is the designed size.
        let designed = DiffHeaderPlan(path: "a/b.swift", kind: .modified, additions: 1, deletions: 1, collapsed: true, width: 393, scale: 3)
        let large = DiffHeaderPlan(path: "a/b.swift", kind: .modified, additions: 1, deletions: 1, collapsed: true, width: 393, scale: 3, text: environment(.large))
        XCTAssertEqual(designed.layout, large.layout)
    }

    // MARK: Caches

    private func inputs(_ count: Int) -> [DiffSectionInput] {
        (0..<count).map { index in
            let item = DiffFileItem(path: "f\(index).swift", kind: .modified, additions: 1, deletions: 1, source: .contents(path: "f\(index).swift", oldText: "let a = \(index)", newText: "let a = \(index + 1)"))
            return DiffSectionInput(item: item, collapsed: false, sizeHint: nil, canExpandContext: false, expandedFiles: [], words: DiffSectionWords())
        }
    }

    /// A section plan is kept for its width and text size: a new size plans
    /// every section again, an equal environment none.
    func testTheSectionCacheIsKeyedOnTheTextSize() async {
        let measurer = DiffSectionMeasurer(render: .isolated())
        let inputs = inputs(3)
        let large = environment(.large)
        let first = await measurer.plans(inputs, width: 393, scale: 3, text: large)
        var planned = await measurer.planned
        XCTAssertEqual(planned, 3)
        let again = await measurer.plans(inputs, width: 393, scale: 3, text: TextEnvironment(scale: TextScale(.large), displayScale: 3))
        planned = await measurer.planned
        XCTAssertEqual(planned, 3)
        XCTAssertTrue(zip(first, again).allSatisfy { $0 === $1 })

        let bigger = await measurer.plans(inputs, width: 393, scale: 3, text: environment(.accessibilityLarge))
        planned = await measurer.planned
        XCTAssertEqual(planned, 6)
        XCTAssertTrue(zip(first, bigger).allSatisfy { $0 !== $1 })
        XCTAssertGreaterThan(bigger[0].layout.height, first[0].layout.height)
        // Another screen scale is another environment.
        _ = await measurer.plans(inputs, width: 393, scale: 2, text: environment(.accessibilityLarge, scale: 2))
        planned = await measurer.planned
        XCTAssertEqual(planned, 9)
        // And the designed size (nil) is not the same key as Large.
        _ = await measurer.plans(inputs, width: 393, scale: 3, text: nil)
        planned = await measurer.planned
        XCTAssertEqual(planned, 12)
    }

    /// The chunk keeps its text size through "show more".
    func testExpandingKeepsTheTextSize() {
        let text = environment(.accessibilityMedium)
        let plan = DiffChunkPlan(source: Self.source, width: 393, render: .isolated(), syntaxDeadline: nil, text: text)
        let expanded = plan.expanding(0, width: 393)
        XCTAssertEqual(expanded.text, text)
        XCTAssertEqual(expanded.files.first?.metrics, plan.files.first?.metrics)
        XCTAssertEqual(expanded.files.first?.hiddenCount, 0)
    }

    // MARK: The changes list

    private func waitForPlans(_ list: DiffFilesListView) async {
        await list.measureTask?.value
        list.layoutIfNeeded()
        list.collectionView.layoutIfNeeded()
    }

    /// The Changes screen's list at a new text size: measured again, every
    /// section at the size, and the line at the top of the screen stays
    /// there through one size after another, and back.
    func testTheListKeepsTheReadersPlace() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.traitOverrides.preferredContentSizeCategory = .large
        window.traitOverrides.displayScale = 3
        window.traitOverrides.followsTextSize = true
        window.isHidden = false
        let list = DiffFilesListView(render: .isolated())
        list.frame = window.bounds
        window.addSubview(list)
        let items = (0..<3).map { index in
            DiffFileItem(path: "f\(index).swift", kind: .modified, additions: 20, deletions: 20, source: .contents(
                path: "f\(index).swift",
                oldText: (1...60).map { "old \(index) \($0)" }.joined(separator: "\n"),
                newText: (1...60).map { $0 % 3 == 0 ? "new \(index) \($0)" : "old \(index) \($0)" }.joined(separator: "\n")
            ))
        }
        list.update(items: items, defaultCollapsed: false)
        window.layoutIfNeeded()
        await waitForPlans(list)
        XCTAssertEqual(list.plans.count, 3)
        XCTAssertEqual(list.plans.first?.text, environment(.large))

        func sections() -> [DiffReadingPlace.Section] { list.plans.map(\.readingSection) }
        func model() -> DiffFilesListLayout {
            DiffFilesListLayout(width: 393, headerHeight: nil, sections: list.plans.map(\.layout.height), empty: .zero)
        }
        let collection = list.collectionView
        // Somewhere in the second file.
        let target = model().sections[1].minY + 300
        collection.contentOffset.y = target - collection.adjustedContentInset.top
        collection.layoutIfNeeded()
        let start = collection.contentOffset.y
        let place = try XCTUnwrap(DiffReadingPlace(y: start + collection.adjustedContentInset.top, list: model(), sections: sections()))

        for category in [UIContentSizeCategory.accessibilityLarge, .extraSmall, .accessibilityExtraExtraExtraLarge, .large] {
            window.traitOverrides.preferredContentSizeCategory = category
            window.updateTraitsIfNeeded()
            list.layoutIfNeeded()
            await waitForPlans(list)
            XCTAssertEqual(list.plans.first?.text, environment(category), category.rawValue)
            let y = try XCTUnwrap(place.y(list: model(), sections: sections()))
            // The scroll view holds its offset on the screen's pixels, so
            // the place sits on the nearest one: at most half a pixel (a
            // sixth of a point at 3x) off, which no one can see. It is the
            // first place every time, not one found again from the last
            // size's pixel, so the error doesn't grow from size to size.
            let top = collection.contentOffset.y + collection.adjustedContentInset.top
            XCTAssertEqual(top, y, accuracy: 0.5 / 3 + 1e-6, category.rawValue)
            XCTAssertEqual((collection.contentOffset.y * 3).rounded(), collection.contentOffset.y * 3, accuracy: 1e-6, "on a pixel, \(category.rawValue)")
            XCTAssertEqual(collection.collectionViewLayout.collectionViewContentSize.height, model().contentHeight, accuracy: 0.001, category.rawValue)
            // Each section on screen is as tall as its plan.
            for cell in collection.visibleCells {
                guard let section = cell.contentView.subviews.compactMap({ $0 as? DiffSectionView }).first, let plan = section.plan else { continue }
                XCTAssertEqual(cell.frame.height, plan.layout.height, accuracy: 0.001, category.rawValue)
            }
        }
        // Back at the size it started at, the list is where it started.
        XCTAssertEqual(collection.contentOffset.y, start, accuracy: 1e-6)
        window.isHidden = true
    }

    // MARK: The file viewer

    /// The viewer's lines, measured off main at the size, against a label
    /// laying each out at its row's text width; the drawn rows are the
    /// plan's.
    func testFileLinesMatchALabelAtEverySize() throws {
        let code = [
            "import Foundation",
            "",
            "/// A comment long enough to wrap on a phone at the larger sizes, and at the largest more than twice over.",
            "let greeting = \"Hello, world\" // émoji 🎉 and accents",
        ].joined(separator: "\n")
        let diff = "@@ -1,2 +1,2 @@\n-let a = 1\n+let a = 2 and a line long enough to wrap at a big text size, surely\n context"
        let syntax = CodeSyntaxService()
        for category in categories {
            let text = environment(category)
            for source in [FileLinesPlan.Source.code(code, language: nil), .diff(diff)] {
                let plan = FileLinesPlan(source: source, width: 393, maxWidth: .greatestFiniteMagnitude, syntax: syntax, text: text)
                XCTAssertEqual(plan.text, text)
                let line = 20 * text.scale.multiplier
                for (index, row) in plan.rows.enumerated() {
                    let frame = plan.layout.text(index)
                    let label = labelSize(row.text, width: frame.width, lines: 0)
                    // The text fits its box, and the box is no taller than
                    // its lines up to the pixel.
                    XCTAssertLessThanOrEqual(label.height, frame.height + 0.5, "\(source) row \(index), \(category.rawValue)")
                    let lines = max(1, (label.height / line).rounded())
                    XCTAssertEqual(frame.height, pixel(lines * line, 3), accuracy: 0.001, "\(source) row \(index), \(category.rawValue)")
                }

                let view = FileLinesView(frame: CGRect(x: 0, y: 0, width: 393, height: 4000))
                let window = UIWindow(frame: view.frame)
                window.traitOverrides.preferredContentSizeCategory = category
                window.traitOverrides.followsTextSize = true
                window.addSubview(view)
                window.isHidden = false
                view.show(plan)
                view.layoutIfNeeded()
                let drawn = view.subviews.filter { !$0.isHidden && Self.named($0, "FileLineRowView") }.sorted { $0.frame.minY < $1.frame.minY }
                XCTAssertFalse(drawn.isEmpty, category.rawValue)
                for (index, row) in drawn.prefix(plan.layout.count).enumerated() {
                    assertSameFrame(row.frame, plan.layout.row(index), "\(source) drawn row \(index), \(category.rawValue)")
                }
                window.isHidden = true
            }
        }
    }
}
#endif
