#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

@MainActor
final class DiffRowReuseTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private func file(_ count: Int) -> DiffFile {
        DiffFile(path: "values.txt", kind: .added, language: nil, additions: count, deletions: 0,
                 rows: (0..<count).map { index in
                     .line(DiffLine(key: "line\(index)", type: .add, newNo: index + 1,
                                    text: "value \(index)", spans: [DiffSpan("value \(index)")]))
                 }, maxColumns: 100, maxLineNo: 999)
    }

    private func rows(_ view: UIView, named name: String) -> [UIView] {
        view.subviews.flatMap { child in
            (String(describing: type(of: child)) == name ? [child] : []) + rows(child, named: name)
        }
    }

    private func place(_ plan: DiffFilePlan, in view: DiffFileView, window: UIWindow) {
        view.apply(plan)
        view.frame = CGRect(x: 0, y: window.bounds.height - plan.height, width: plan.layout.input.width, height: plan.height)
        window.layoutIfNeeded()
        view.layoutIfNeeded()
        view.updateRows()
    }

    func testExpansionKeepsUnchangedLinesAndThePoolStaysInItsParents() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 600))
        window.isHidden = false
        defer { window.isHidden = true }
        let view = DiffFileView()
        window.addSubview(view)
        let syntax = DiffSyntaxService()
        let source = file(301)
        let options = DiffViewOptions(collapseAfter: 80)
        place(DiffFilePlan(file: source, width: 393, syntax: syntax, options: options, syntaxDeadline: nil), in: view, window: window)
        let before = rows(view, named: "DiffCodeRowView")
        let codeByY = Dictionary(uniqueKeysWithValues: before.filter { !$0.isHidden }.map { ($0.frame.minY, $0) })
        let gutterByY = Dictionary(uniqueKeysWithValues: rows(view, named: "DiffGutterRowView").filter { !$0.isHidden }.map { ($0.frame.minY, $0) })
        let parents = before.map { ($0, $0.superview) }

        place(DiffFilePlan(file: source, width: 393, syntax: syntax, options: options, expanded: true, syntaxDeadline: nil), in: view, window: window)
        let expanded = rows(view, named: "DiffCodeRowView")
        let overlap = expanded.filter { !$0.isHidden && codeByY[$0.frame.minY] != nil }
        XCTAssertFalse(overlap.isEmpty)
        for row in overlap { XCTAssertTrue(row === codeByY[row.frame.minY], "an unchanged visible line keeps its view") }
        for row in rows(view, named: "DiffGutterRowView") where !row.isHidden && gutterByY[row.frame.minY] != nil {
            XCTAssertTrue(row === gutterByY[row.frame.minY])
        }

        // A shorter file leaves most pairs spare. They stay attached and
        // hidden, rather than leaving/reentering the window on every reuse.
        place(DiffFilePlan(file: file(3), width: 393, syntax: syntax, syntaxDeadline: nil), in: view, window: window)
        let shortened = rows(view, named: "DiffCodeRowView")
        XCTAssertEqual(shortened.count, expanded.count, "the pool grows only to its largest mounted range")
        XCTAssertEqual(shortened.filter { !$0.isHidden }.count, 3)
        XCTAssertTrue(shortened.contains { $0.isHidden })
        for (row, parent) in parents {
            XCTAssertTrue(row.superview === parent)
            XCTAssertTrue(row.window === window)
        }
    }

    func testChangedLineRefreshesTextWhileItsUnchangedNeighborStays() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 600))
        window.isHidden = false
        defer { window.isHidden = true }
        let view = DiffFileView()
        window.addSubview(view)
        let syntax = DiffSyntaxService()
        var source = file(3)
        let first = DiffFilePlan(file: source, width: 393, syntax: syntax, syntaxDeadline: nil)
        place(first, in: view, window: window)
        let neighbor = try XCTUnwrap(rows(view, named: "DiffCodeRowView").first { $0.frame.minY == first.layout.row(1).minY })
        let replacement = "新しい🙂 value with a different width"
        source.rows[0] = .line(DiffLine(key: "line0", type: .add, newNo: 1, text: replacement, spans: [DiffSpan(replacement, .keyword)]))
        let updated = DiffFilePlan(file: source, width: 393, syntax: syntax, syntaxDeadline: nil)
        place(updated, in: view, window: window)
        let changed = try XCTUnwrap(rows(view, named: "DiffCodeRowView").first { !$0.isHidden && $0.frame.minY == 0 })
        let text = try XCTUnwrap(rows(changed, named: "DiffTextDrawingView").first)
        XCTAssertEqual(text.frame.width, DiffStyle.size(DiffStyle.lineText([DiffSpan(replacement, .keyword)], metrics: updated.metrics)).width)
        XCTAssertTrue(neighbor === rows(view, named: "DiffCodeRowView").first { !$0.isHidden && $0.frame.minY == updated.layout.row(1).minY })
    }

    func testNewMetricsAndGutterOptionsRefreshTheReusedViews() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 600))
        window.isHidden = false
        defer { window.isHidden = true }
        let view = DiffFileView()
        window.addSubview(view)
        let syntax = DiffSyntaxService()
        let source = file(3)
        place(DiffFilePlan(file: source, width: 393, syntax: syntax, syntaxDeadline: nil), in: view, window: window)
        let text = TextEnvironment(scale: TextScale(.accessibilityLarge), displayScale: 3)
        let updated = DiffFilePlan(file: source, width: 393, syntax: syntax, options: DiffViewOptions(showLineNumbers: false), syntaxDeadline: nil, text: text)
        place(updated, in: view, window: window)
        for row in rows(view, named: "DiffCodeRowView") where !row.isHidden {
            XCTAssertEqual(row.frame.height, updated.metrics.lineHeight)
            let drawing = try XCTUnwrap(rows(row, named: "DiffTextDrawingView").first)
            let index = Int((row.frame.minY / updated.metrics.lineHeight).rounded())
            let line = try XCTUnwrap(updated.rows[index].line)
            XCTAssertEqual(drawing.frame.width, DiffStyle.size(DiffStyle.lineText(line.spans, metrics: updated.metrics)).width)
        }
        for row in rows(view, named: "DiffGutterRowView") where !row.isHidden {
            XCTAssertEqual(row.frame.width, updated.layout.gutterWidth)
        }
    }

    func testSyntaxOnlyChangesRedrawTheLine() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 600))
        window.traitOverrides.userInterfaceStyle = .light
        window.isHidden = false
        defer { window.isHidden = true }
        let view = DiffFileView()
        window.addSubview(view)
        let syntax = DiffSyntaxService()
        var source = file(1)
        func pixels() throws -> Data {
            let row = try XCTUnwrap(rows(view, named: "DiffCodeRowView").first { !$0.isHidden })
            func display(_ view: UIView) {
                view.layer.displayIfNeeded()
                for child in view.subviews { display(child) }
            }
            display(row)
            return UIGraphicsImageRenderer(bounds: row.bounds).pngData { row.layer.render(in: $0.cgContext) }
        }
        place(DiffFilePlan(file: source, width: 393, syntax: syntax, syntaxDeadline: nil), in: view, window: window)
        let before = try pixels()
        XCTAssertEqual(try pixels(), before)
        let line = try XCTUnwrap(source.rows.first?.line)
        source.rows[0] = .line(DiffLine(key: line.key, type: line.type, newNo: line.newNo,
                                      text: line.text, spans: [DiffSpan(line.text, .keyword)]))
        place(DiffFilePlan(file: source, width: 393, syntax: syntax, syntaxDeadline: nil), in: view, window: window)
        XCTAssertNotEqual(try pixels(), before, "a syntax-only change must replace the old text colours")
    }

    func testWidthAndFileChangesInvalidateTheMountedLines() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 600))
        window.isHidden = false
        defer { window.isHidden = true }
        let view = DiffFileView()
        window.addSubview(view)
        let syntax = DiffSyntaxService()
        var source = file(3)
        place(DiffFilePlan(file: source, width: 393, syntax: syntax, syntaxDeadline: nil), in: view, window: window)
        let initial = rows(view, named: "DiffCodeRowView").filter { !$0.isHidden }
        let narrower = DiffFilePlan(file: source, width: 300, syntax: syntax, syntaxDeadline: nil)
        view.apply(narrower)
        XCTAssertTrue(initial.allSatisfy(\.isHidden))
        place(narrower, in: view, window: window)
        let narrowRows = rows(view, named: "DiffCodeRowView").filter { !$0.isHidden }
        XCTAssertEqual(narrowRows.count, 3)
        source.path = "another-file.txt"
        view.apply(DiffFilePlan(file: source, width: 300, syntax: syntax, syntaxDeadline: nil))
        XCTAssertTrue(narrowRows.allSatisfy(\.isHidden))
    }
}
#endif