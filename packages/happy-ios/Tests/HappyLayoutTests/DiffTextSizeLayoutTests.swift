import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The diff and the file viewer at the person's text size: the mono font,
/// its line and its advance grow by React Native's multiplier; the gutter's
/// padding, the code's inset and the rows' paddings keep their size.
/// Multipliers are RN's `Float`s (XS 0.823, XL 1.118, AX-L 2.143, AX-XXXL
/// 3.571), so the expected values are worked out at that precision.
final class DiffMetricsTextSizeTests: XCTestCase {
    func testLineGrowsAndRowsRoundUpToThePixel() {
        let cases: [(TextSizeCategory, text: CGFloat, row: CGFloat)] = [
            (.extraSmall, 14.814000248908997, 15),
            (.large, 18, 18),
            (.extraLarge, 20.124000549316406, 61.0 / 3),
            (.accessibilityLarge, 38.57399797439575, 116.0 / 3),
            (.accessibilityExtraExtraExtraLarge, 64.27800178527832, 193.0 / 3),
        ]
        for (category, text, row) in cases {
            let metrics = DiffMetrics(scale: TextScale(category), displayScale: 3)
            XCTAssertEqual(metrics.fontSize, 12, "\(category)")
            XCTAssertEqual(metrics.textLineHeight, text, accuracy: 1e-9, "\(category)")
            XCTAssertEqual(metrics.lineHeight, row, accuracy: 1e-9, "\(category)")
        }
        // Without a screen the row is the text's line, unrounded.
        XCTAssertEqual(DiffMetrics(scale: TextScale(.extraLarge)).lineHeight, 20.124000549316406, accuracy: 1e-9)
        // The designed size is as before, on any screen.
        XCTAssertEqual(DiffMetrics(displayScale: 2), DiffMetrics(displayScale: 3))
        XCTAssertEqual(DiffMetrics(fontSize: 12.5, scale: .standard, displayScale: 3).lineHeight, 19)
    }

    func testTheEstimateIsSixTenthsOfTheSizeDrawn() {
        let cases: [(TextSizeCategory, advance: CGFloat, drawn: CGFloat)] = [
            (.extraSmall, 5.9256000995635985, 9.876000165939331),
            (.large, 7.2, 12),
            (.extraLarge, 8.049600219726562, 13.416000366210938),
            (.accessibilityLarge, 15.4295991897583, 25.715998649597168),
            (.accessibilityExtraExtraExtraLarge, 25.711200714111328, 42.85200119018555),
        ]
        for (category, advance, drawn) in cases {
            let metrics = DiffMetrics(scale: TextScale(category))
            XCTAssertEqual(metrics.charWidth, advance, accuracy: 1e-9, "\(category)")
            XCTAssertEqual(metrics.drawnFontSize, drawn, accuracy: 1e-9, "\(category)")
        }
    }

    /// layout.ts `gutterWidthFor` with the advance at the size drawn: the
    /// columns grow, the 12 (or 4) of padding doesn't.
    func testGutterAndMarkerAtEachSize() {
        let cases: [(TextSizeCategory, two: CGFloat, three: CGFloat, bare: CGFloat, marker: CGFloat)] = [
            (.extraSmall, 36, 42, 16, 12),
            (.large, 41, 48, 19, 15),
            (.extraLarge, 45, 53, 21, 17),
            (.accessibilityLarge, 74, 90, 35, 31),
            (.accessibilityExtraExtraExtraLarge, 115, 141, 56, 52),
        ]
        for (category, two, three, bare, marker) in cases {
            let metrics = DiffMetrics(scale: TextScale(category))
            XCTAssertEqual(metrics.gutterWidth(maxLineNo: 99, showLineNumbers: true), two, "\(category)")
            XCTAssertEqual(metrics.gutterWidth(maxLineNo: 120, showLineNumbers: true), three, "\(category)")
            XCTAssertEqual(metrics.gutterWidth(maxLineNo: 120, showLineNumbers: false), bare, "\(category)")
            XCTAssertEqual(metrics.markerWidth, marker, "\(category)")
        }
    }

    /// A measured advance is used as given, whatever the size.
    func testAFixedMeasuredAdvance() {
        let metrics = DiffMetrics(scale: TextScale(.extraLarge), displayScale: 3, charWidth: 8.4)
        XCTAssertEqual(metrics.charWidth, 8.4)
        XCTAssertEqual(metrics.gutterWidth(maxLineNo: 120, showLineNumbers: true), 54)
        XCTAssertEqual(metrics.gutterWidth(maxLineNo: 9999, showLineNumbers: true), 63)
        XCTAssertEqual(metrics.markerWidth, 17)
        let layout = DiffFileLayout(.init(width: 393, metrics: metrics, rowCount: 3, maxColumns: 40, maxLineNo: 120, showMoreTextHeight: 17))
        XCTAssertEqual(layout.gutterWidth, 54)
        // ceil(42 × 8.4) + 8.
        XCTAssertEqual(layout.codeWidth, 361)
        XCTAssertEqual(layout.contentWidth, 361)
        XCTAssertTrue(layout.scrollable)
    }

    /// MonoProbe's 0.35 to 1.2 em, of the size drawn here; RN's own check
    /// is against the designed 12, which refuses a real AX-L advance.
    func testTheProbeAcceptsAnAdvanceAtTheSizeDrawn() {
        let drawn = DiffMetrics(scale: TextScale(.accessibilityLarge)).drawnFontSize
        XCTAssertTrue(DiffMetrics.acceptsAdvance(15.43, drawnFontSize: drawn))
        XCTAssertFalse(DiffMetrics.acceptsAdvance(15.43, drawnFontSize: 12))
        XCTAssertFalse(DiffMetrics.acceptsAdvance(drawn * 0.34, drawnFontSize: drawn))
        XCTAssertFalse(DiffMetrics.acceptsAdvance(drawn * 1.21, drawnFontSize: drawn))
        XCTAssertTrue(DiffMetrics.acceptsAdvance(7.2, drawnFontSize: 12))
    }
}

final class DiffFileLayoutTextSizeTests: XCTestCase {
    private func layout(_ category: TextSizeCategory, hidden: Int = 0, showMore: CGFloat = 17) -> DiffFileLayout {
        DiffFileLayout(.init(
            width: 393,
            metrics: DiffMetrics(scale: TextScale(category), displayScale: 3),
            rowCount: 10,
            hiddenCount: hidden,
            maxColumns: 40,
            maxLineNo: 120,
            showMoreTextHeight: showMore
        ))
    }

    func testSmallestFitsWithoutScrolling() {
        let layout = layout(.extraSmall)
        XCTAssertEqual(layout.gutterWidth, 42)
        XCTAssertEqual(layout.codeWidth, 257)
        XCTAssertEqual(layout.contentWidth, 351)
        XCTAssertFalse(layout.scrollable)
        assertFrame(layout.scroll, rect(0, 0, 393, 150))
        assertFrame(layout.canvas, rect(42, 0, 351, 150))
        assertFrame(layout.row(3), rect(0, 45, 351, 15))
        assertFrame(layout.lineNumber, rect(0, 0, 30, 15))
        assertFrame(layout.marker, rect(30, 0, 12, 15))
        XCTAssertEqual(layout.height, 150)
    }

    func testExtraLargeScrolls() {
        let layout = layout(.extraLarge)
        XCTAssertEqual(layout.gutterWidth, 53)
        XCTAssertEqual(layout.codeWidth, 347)
        XCTAssertEqual(layout.contentWidth, 347)
        XCTAssertTrue(layout.scrollable)
        assertSize(layout.scrollContentSize, CGSize(width: 400, height: 610.0 / 3))
        assertFrame(layout.gutter, rect(0, 0, 53, 610.0 / 3))
        assertFrame(layout.row(3), rect(0, 61, 347, 61.0 / 3))
        assertFrame(layout.gutterRow(9), rect(0, 183, 53, 61.0 / 3))
        assertFrame(layout.codeText(width: 100), rect(6, 0, 100, 61.0 / 3))
        assertFrame(layout.hunkDots, rect(6, 0, 47, 61.0 / 3))
        XCTAssertEqual(layout.rowIndex(at: 61), 3)
        XCTAssertEqual(layout.rowIndex(at: 60.9), 2)
        XCTAssertEqual(layout.rows(from: 30, to: 70), 1..<4)
    }

    func testAccessibilityLargeWithTheBar() {
        // The bar's 1 + 10 + 10 stay; its text is its line at the size.
        let layout = layout(.accessibilityLarge, hidden: 5, showMore: 36)
        XCTAssertEqual(layout.gutterWidth, 90)
        XCTAssertEqual(layout.codeWidth, 657)
        XCTAssertTrue(layout.scrollable)
        assertFrame(layout.scroll, rect(0, 0, 393, 1160.0 / 3))
        assertFrame(layout.row(3), rect(0, 116, 657, 116.0 / 3))
        assertFrame(layout.lineNumber, rect(0, 0, 59, 116.0 / 3))
        assertFrame(layout.marker, rect(59, 0, 31, 116.0 / 3))
        assertFrame(layout.showMore, rect(0, 1160.0 / 3, 393, 57))
        XCTAssertEqual(layout.height, 1160.0 / 3 + 57, accuracy: 1e-9)
        assertFrame(layout.showMoreText(width: 200), rect(96.5, 11, 200, 36))
        let busy = layout.showMoreContent(textWidth: 200, busy: true)
        assertFrame(busy?.text, rect(110.5, 11, 200, 36))
        assertFrame(busy?.spinner, rect(82.5, 19, 20, 20))
    }

    func testChunkStacksAtTheSize() {
        let metrics = DiffMetrics(scale: TextScale(.accessibilityExtraExtraExtraLarge), displayScale: 3)
        let chunk = DiffChunkLayout([
            .init(width: 393, metrics: metrics, rowCount: 3, maxColumns: 10, maxLineNo: 9, showMoreTextHeight: 60),
            .init(width: 393, metrics: metrics, rowCount: 2, hiddenCount: 4, maxColumns: 10, maxLineNo: 9, showMoreTextHeight: 60),
        ])
        assertFrame(chunk.frames[0], rect(0, 0, 393, 193))
        assertFrame(chunk.frames[1], rect(0, 193, 393, 386.0 / 3 + 81))
        XCTAssertEqual(chunk.size.height, 193 + 386.0 / 3 + 81, accuracy: 1e-9)
    }
}

/// The changes list keeps the line at the top of the screen when a new
/// text size moves every height.
final class DiffReadingPlaceTests: XCTestCase {
    private struct List {
        var layout: DiffFilesListLayout
        var sections: [DiffReadingPlace.Section]
    }

    /// Notices, a section with two built files, then a collapsed one with
    /// a hint, at a text size.
    private func list(_ category: TextSizeCategory, notices: CGFloat, header: CGFloat, hint: CGFloat) -> List {
        let metrics = DiffMetrics(scale: TextScale(category), displayScale: 3)
        let files = [
            DiffFileLayout(.init(width: 393, metrics: metrics, rowCount: 10, maxColumns: 40, maxLineNo: 99, showMoreTextHeight: 17)),
            DiffFileLayout(.init(width: 393, metrics: metrics, rowCount: 4, maxColumns: 40, maxLineNo: 99, showMoreTextHeight: 17)),
        ]
        let open = DiffSectionLayout(width: 393, headerHeight: header, body: .files(files.map(\.height)))
        let collapsed = DiffSectionLayout(width: 393, headerHeight: header, body: .hint(CGSize(width: 200, height: hint)))
        let sections = [DiffReadingPlace.Section(layout: open, files: files), DiffReadingPlace.Section(layout: collapsed)]
        return List(layout: DiffFilesListLayout(width: 393, headerHeight: notices, sections: sections.map(\.layout.height), empty: .zero), sections: sections)
    }

    func testARowKeepsItsPlace() {
        let large = list(.large, notices: 50, header: 35, hint: 17)
        // Halfway down the second file's second row: 50 + 35 + 180 + 18 + 9.
        let place = DiffReadingPlace(y: 292, list: large.layout, sections: large.sections)
        XCTAssertEqual(place, DiffReadingPlace(section: 0, part: .row(file: 1, row: 1, fraction: 0.5)))
        let bigger = list(.accessibilityLarge, notices: 90, header: 60, hint: 36)
        // 90 + 60 + 10 rows + 1.5 rows of 116/3.
        XCTAssertEqual(place?.y(list: bigger.layout, sections: bigger.sections) ?? 0, 90 + 60 + 11.5 * 116.0 / 3, accuracy: 1e-9)
        XCTAssertEqual(place?.y(list: large.layout, sections: large.sections) ?? 0, 292, accuracy: 1e-9)
    }

    func testTheHeaderAndTheRestOfASection() {
        let large = list(.large, notices: 50, header: 35, hint: 17)
        // The open section is 35 + 252 + 1 tall, from 50.
        let header = DiffReadingPlace(y: 50 + 7, list: large.layout, sections: large.sections)
        XCTAssertEqual(header, DiffReadingPlace(section: 0, part: .header(0.2)))
        // The collapsed section: 35 header, 41 hint row, 1 border, from 338.
        let hint = DiffReadingPlace(y: 338 + 38.5, list: large.layout, sections: large.sections)
        XCTAssertEqual(hint, DiffReadingPlace(section: 1, part: .section(0.5)))
        let bigger = list(.accessibilityLarge, notices: 90, header: 60, hint: 36)
        // The open section: 60 + 14 rows of 116/3 + 1.
        let start = 90 + 60 + 14 * 116.0 / 3 + 1
        XCTAssertEqual(header?.y(list: bigger.layout, sections: bigger.sections) ?? 0, 90 + 12, accuracy: 1e-9)
        XCTAssertEqual(hint?.y(list: bigger.layout, sections: bigger.sections) ?? 0, start + (60 + 60 + 1) / 2, accuracy: 1e-9)
    }

    func testNoPlaceInTheNoticesOrPastTheEnd() {
        let large = list(.large, notices: 50, header: 35, hint: 17)
        XCTAssertNil(DiffReadingPlace(y: 49, list: large.layout, sections: large.sections))
        XCTAssertNil(DiffReadingPlace(y: large.layout.contentHeight, list: large.layout, sections: large.sections))
        // A row that is gone has no place.
        let gone = DiffReadingPlace(section: 0, part: .row(file: 1, row: 4, fraction: 0))
        XCTAssertNil(gone.y(list: large.layout, sections: large.sections))
        XCTAssertNil(DiffReadingPlace(section: 2, part: .section(0)).y(list: large.layout, sections: large.sections))
    }

    /// One size after another, the offset each lands on is the first
    /// place's nearest pixel. Found again from each size's pixel instead,
    /// the half pixels add up, scaled by the rows they land in.
    func testThePlaceHoldsThroughOneSizeAfterAnother() throws {
        let sizes: [(TextSizeCategory, notices: CGFloat, header: CGFloat, hint: CGFloat)] = [
            (.accessibilityLarge, 90, 60, 36), (.extraSmall, 41, 29, 14), (.accessibilityExtraExtraExtraLarge, 150, 100, 61), (.large, 50, 35, 17),
        ]
        let large = list(.large, notices: 50, header: 35, hint: 17)
        // 5 of the second file's second row's 18 down it.
        let start: CGFloat = 50 + 35 + 180 + 18 + 5
        let first = try XCTUnwrap(DiffReadingPlace(y: start, list: large.layout, sections: large.sections))
        // As in a longer list, with more below: nothing is held at the end.
        func land(_ y: CGFloat, _ list: List) -> CGFloat {
            ScrollPlace.offset(top: y, insetTop: 0, insetBottom: 0, viewport: 852, contentHeight: list.layout.contentHeight + 10_000, scale: 3)
        }
        var kept = KeptPlace<DiffReadingPlace>()
        var keptOffset = start
        var foundOffset = start
        var foundIn = large
        var drift: CGFloat = 0
        for (category, notices, header, hint) in sizes {
            let next = list(category, notices: notices, header: header, hint: hint)
            let place = try XCTUnwrap(kept.place(at: keptOffset) { DiffReadingPlace(y: $0, list: large.layout, sections: large.sections) })
            XCTAssertEqual(place, first, "\(category)")
            keptOffset = land(try XCTUnwrap(place.y(list: next.layout, sections: next.sections)), next)
            kept.put(place, at: keptOffset)
            let y = try XCTUnwrap(first.y(list: next.layout, sections: next.sections))
            XCTAssertEqual(keptOffset, y, accuracy: 0.5 / 3 + 1e-9, "\(category)")
            XCTAssertEqual(keptOffset * 3, (keptOffset * 3).rounded(), accuracy: 1e-9, "\(category)")

            let found = try XCTUnwrap(DiffReadingPlace(y: foundOffset, list: foundIn.layout, sections: foundIn.sections))
            foundOffset = land(try XCTUnwrap(found.y(list: next.layout, sections: next.sections)), next)
            foundIn = next
            drift = max(drift, abs(foundOffset - y))
        }
        // Back at Large, exactly where it started.
        XCTAssertEqual(keptOffset, start, accuracy: 1e-9)
        // Found again each time, it drifts more than a pixel.
        XCTAssertGreaterThan(drift, 1.0 / 3)
        // The reader scrolled: the place is found where they are.
        let scrolled = kept.place(at: keptOffset + 1) { DiffReadingPlace(y: $0, list: large.layout, sections: large.sections) }
        XCTAssertEqual(scrolled, DiffReadingPlace(y: start + 1, list: large.layout, sections: large.sections))
        kept.forget()
        XCTAssertNil(kept.place(at: keptOffset) { _ in nil })
    }

    func testTheOffsetIsOnAPixelInsideTheRange() {
        // Nearest pixel at 3x and 2x, past the top inset.
        XCTAssertEqual(ScrollPlace.offset(top: 100.2, insetTop: 0, insetBottom: 0, viewport: 800, contentHeight: 2000, scale: 3), 100.0 + 1.0 / 3, accuracy: 1e-9)
        XCTAssertEqual(ScrollPlace.offset(top: 100.2, insetTop: 10, insetBottom: 0, viewport: 800, contentHeight: 2000, scale: 2), 90, accuracy: 1e-9)
        XCTAssertEqual(ScrollPlace.offset(top: 100.2, insetTop: 0, insetBottom: 0, viewport: 800, contentHeight: 2000, scale: 0), 100.2, accuracy: 1e-9)
        // No higher than the top inset, no lower than the end.
        XCTAssertEqual(ScrollPlace.offset(top: -10, insetTop: 20, insetBottom: 0, viewport: 800, contentHeight: 2000, scale: 3), -20)
        XCTAssertEqual(ScrollPlace.offset(top: 1900, insetTop: 0, insetBottom: 34, viewport: 800, contentHeight: 2000, scale: 3), 1234)
        XCTAssertEqual(ScrollPlace.offset(top: 300, insetTop: 0, insetBottom: 0, viewport: 800, contentHeight: 500, scale: 3), 0)
    }
}

final class FileLinesTextSizeTests: XCTestCase {
    func testTextBoxesRoundUpToThePixel() {
        // One line of mono 14 on 20 × 1.118.
        let line = 20 * TextScale(.extraLarge).multiplier
        XCTAssertEqual(FileLinesLayout.textHeight(measured: line, line: line, displayScale: 3), 68.0 / 3, accuracy: 1e-9)
        XCTAssertEqual(FileLinesLayout.textHeight(measured: 0, line: line, displayScale: 3), 68.0 / 3, accuracy: 1e-9)
        XCTAssertEqual(FileLinesLayout.textHeight(measured: line * 2, line: line, displayScale: 2), 45, accuracy: 1e-9)
        // Whole points without a screen, as at the designed size.
        XCTAssertEqual(FileLinesLayout.textHeight(measured: 0, line: 20, displayScale: 0), 20)
        XCTAssertEqual(FileLinesLayout.textHeight(measured: 40.2, line: 20, displayScale: 0), 41)
        // TextKit's float noise is not a pixel.
        XCTAssertEqual(FileLinesLayout.textHeight(measured: 60.0000001, line: 20, displayScale: 3), 60)
    }

    func testFitsOneLineAtTheAdvance() {
        XCTAssertTrue(FileLinesLayout.fitsOneLine("abc", advance: 8.4, width: 33.6))
        XCTAssertFalse(FileLinesLayout.fitsOneLine("abc", advance: 8.4, width: 33.5))
        XCTAssertFalse(FileLinesLayout.fitsOneLine("é", advance: 8.4, width: 300))
        XCTAssertFalse(FileLinesLayout.fitsOneLine("a\tb", advance: 8.4, width: 300))
    }

    func testRowsAtTheSize() {
        // A diff line of one and one of two wrapped lines, at XL on 3x.
        let line = FileLinesLayout.textHeight(measured: 0, line: 20 * TextScale(.extraLarge).multiplier, displayScale: 3)
        let layout = FileLinesLayout(width: 393, maxWidth: .greatestFiniteMagnitude, insets: .diff, textHeights: [line, line * 2], bars: [true, false])
        assertFrame(layout.row(0), rect(16, 16, 361, 68.0 / 3 + 2))
        assertFrame(layout.row(1), rect(16, 16 + 68.0 / 3 + 2, 361, 136.0 / 3 + 2))
        assertFrame(layout.text(0), rect(11, 1, 342, 68.0 / 3))
        assertFrame(layout.bar(0), rect(0, 0, 3, 68.0 / 3 + 2))
        XCTAssertEqual(layout.contentSize.height, 16 + 204.0 / 3 + 4 + 16, accuracy: 1e-9)
    }

    func testTheTopLineKeepsItsPlace() {
        let designed = FileLinesLayout(width: 393, maxWidth: .greatestFiniteMagnitude, insets: .diff, textHeights: [20, 40, 20], bars: [false, false, false])
        // Rows start at 16, 38, 80 and end at 102.
        guard let place = designed.place(at: 59) else { return XCTFail("no place") }
        XCTAssertEqual(place.row, 1)
        XCTAssertEqual(place.fraction, 0.5, accuracy: 1e-9)
        let line = 68.0 / 3
        let bigger = FileLinesLayout(width: 393, maxWidth: .greatestFiniteMagnitude, insets: .diff, textHeights: [line, 136.0 / 3, line], bars: [false, false, false])
        // 16 + (68/3 + 2) + half of (136/3 + 2).
        XCTAssertEqual(bigger.y(of: place) ?? 0, 16 + line + 2 + (136.0 / 3 + 2) / 2, accuracy: 1e-9)
        // The top padding keeps its offset; past the end is the last row's end.
        XCTAssertNil(designed.place(at: 10))
        guard let end = designed.place(at: 500) else { return XCTFail("no place") }
        XCTAssertEqual(end.row, 2)
        XCTAssertEqual(end.fraction, 1)
        XCTAssertNil(designed.y(of: (row: 3, fraction: 0)))
        XCTAssertNil(FileLinesLayout(width: 393, maxWidth: 800, insets: .code, textHeights: [], bars: []).place(at: 20))
    }
}
