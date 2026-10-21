import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// components/diff: layout.spec.ts's gutterWidthFor, DiffFileView's scroll
/// layout, DiffFileHeader, DiffImageView, FileSection and DiffFilesList.
final class DiffMetricsTests: XCTestCase {
    func testLineHeightAndNominalAdvance() {
        let metrics = DiffMetrics()
        XCTAssertEqual(metrics.fontSize, 12)
        XCTAssertEqual(metrics.lineHeight, 18)
        XCTAssertEqual(metrics.charWidth, 7.2, accuracy: 0.0001)
        XCTAssertEqual(metrics.markerWidth, 15)
        XCTAssertEqual(DiffMetrics(fontSize: 12.5).lineHeight, 19)
        XCTAssertEqual(DiffMetrics(fontSize: 11, charWidth: 6.5).charWidth, 6.5)
    }

    func testGutterWidthFor() {
        // layout.spec.ts.
        XCTAssertEqual(DiffMetrics.gutterWidth(charWidth: 7, maxLineNo: 1234, showLineNumbers: false), 18)
        XCTAssertEqual(DiffMetrics.gutterWidth(charWidth: 7.2, maxLineNo: 1, showLineNumbers: true), DiffMetrics.gutterWidth(charWidth: 7.2, maxLineNo: 99, showLineNumbers: true))
        XCTAssertEqual(DiffMetrics.gutterWidth(charWidth: 7.2, maxLineNo: 99, showLineNumbers: true), 41)
        XCTAssertEqual(DiffMetrics.gutterWidth(charWidth: 7.2, maxLineNo: 120, showLineNumbers: true), 48)
        XCTAssertEqual(DiffMetrics.gutterWidth(charWidth: 7.2, maxLineNo: 1234, showLineNumbers: true), 56)
        XCTAssertGreaterThan(DiffMetrics.gutterWidth(charWidth: 7.2, maxLineNo: 100_000, showLineNumbers: true), 56)
        XCTAssertGreaterThan(DiffMetrics.gutterWidth(charWidth: 9, maxLineNo: 99, showLineNumbers: true), 41)
    }
}

final class DiffFileLayoutTests: XCTestCase {
    func testFitsTheViewport() {
        let layout = DiffFileLayout(.init(width: 393, rowCount: 10, maxColumns: 40, maxLineNo: 120, showMoreTextHeight: 17))
        XCTAssertEqual(layout.gutterWidth, 48)
        XCTAssertEqual(layout.codeWidth, 311)
        XCTAssertEqual(layout.contentWidth, 345)
        XCTAssertFalse(layout.scrollable)
        assertFrame(layout.scroll, rect(0, 0, 393, 180))
        assertSize(layout.scrollContentSize, CGSize(width: 393, height: 180))
        assertFrame(layout.canvas, rect(48, 0, 345, 180))
        assertFrame(layout.gutter, rect(0, 0, 48, 180))
        XCTAssertNil(layout.showMore)
        XCTAssertNil(layout.showMoreText(width: 100))
        XCTAssertEqual(layout.height, 180)

        assertFrame(layout.row(3), rect(0, 54, 345, 18))
        assertFrame(layout.gutterRow(3), rect(0, 54, 48, 18))
        assertFrame(layout.codeText(width: 100), rect(6, 0, 100, 18))
        assertFrame(layout.lineNumber, rect(0, 0, 33, 18))
        assertFrame(layout.marker, rect(33, 0, 15, 18))
        assertFrame(layout.hunkDots, rect(6, 0, 42, 18))
    }

    func testScrollsLongLinesAndHoldsRowsBack() {
        let layout = DiffFileLayout(.init(width: 393, rowCount: 10, hiddenCount: 5, maxColumns: 100, maxLineNo: 120, paddingVertical: 4, showMoreTextHeight: 17))
        XCTAssertEqual(layout.codeWidth, 743)
        XCTAssertEqual(layout.contentWidth, 743)
        XCTAssertTrue(layout.scrollable)
        assertFrame(layout.scroll, rect(0, 0, 393, 188))
        assertSize(layout.scrollContentSize, CGSize(width: 791, height: 188))
        assertFrame(layout.canvas, rect(48, 4, 743, 180))
        assertFrame(layout.gutter, rect(0, 4, 48, 180))
        assertFrame(layout.showMore, rect(0, 188, 393, 38))
        assertFrame(layout.showMoreText(width: 120), rect(136.5, 11, 120, 17))
        // Busy: [spinner 20] 8 [text 120], centred in 393.
        let busy = layout.showMoreContent(textWidth: 120, busy: true)
        assertFrame(busy?.spinner, rect(122.5, 9.5, 20, 20))
        assertFrame(busy?.text, rect(150.5, 11, 120, 17))
        XCTAssertEqual(layout.height, 226)
    }

    func testWithoutLineNumbersTheGutterIsTheMarker() {
        let layout = DiffFileLayout(.init(width: 300, rowCount: 1, maxColumns: 10, maxLineNo: 5000, showLineNumbers: false, showMoreTextHeight: 17))
        XCTAssertEqual(layout.gutterWidth, 19)
        XCTAssertNil(layout.lineNumber)
        assertFrame(layout.marker, rect(0, 0, 15, 18))
    }

    func testVisibleRows() {
        let layout = DiffFileLayout(.init(width: 393, rowCount: 10, maxColumns: 40, maxLineNo: 9, showMoreTextHeight: 17))
        XCTAssertEqual(layout.rows(from: 20, to: 60), 1..<4)
        XCTAssertEqual(layout.rows(from: -100, to: 10), 0..<1)
        XCTAssertEqual(layout.rows(from: 170, to: 1000), 9..<10)
        XCTAssertEqual(layout.rows(from: 200, to: 300), 10..<10)
        XCTAssertEqual(layout.rows(from: 50, to: 50), 0..<0)
        XCTAssertEqual(layout.rowIndex(at: 35.9), 1)
        XCTAssertEqual(layout.rowIndex(at: 36), 2)
        XCTAssertNil(layout.rowIndex(at: 180))
        XCTAssertNil(layout.rowIndex(at: -1))
    }

    func testEmptyFile() {
        let layout = DiffFileLayout(.init(width: 393, rowCount: 0, maxColumns: 0, maxLineNo: 0, showMoreTextHeight: 17))
        XCTAssertEqual(layout.height, 0)
        XCTAssertEqual(layout.rows(from: 0, to: 100), 0..<0)
    }

    func testTextWindowSnapsToSteps() {
        XCTAssertEqual(DiffTextWindow.span(textWidth: 5000, visible: 600...993, margin: 393), 0...1536)
        XCTAssertEqual(DiffTextWindow.span(textWidth: 5000, visible: 2000...2393, margin: 393), 1536...3072)
        XCTAssertEqual(DiffTextWindow.span(textWidth: 1000, visible: 0...393, margin: 393), 0...1000)
        XCTAssertNil(DiffTextWindow.span(textWidth: 0, visible: 0...393, margin: 393))
        XCTAssertNil(DiffTextWindow.span(textWidth: 1000, visible: 3000...3393, margin: 393))
    }

    func testChunkStacksFiles() {
        let chunk = DiffChunkLayout([
            .init(width: 393, rowCount: 10, maxColumns: 40, maxLineNo: 120, showMoreTextHeight: 17),
            .init(width: 393, rowCount: 10, hiddenCount: 5, maxColumns: 100, maxLineNo: 120, paddingVertical: 4, showMoreTextHeight: 17),
        ])
        assertFrame(chunk.frames[0], rect(0, 0, 393, 180))
        assertFrame(chunk.frames[1], rect(0, 180, 393, 226))
        assertSize(chunk.size, CGSize(width: 393, height: 406))
        XCTAssertEqual(DiffChunkLayout.collapseAfter, 80)
    }
}

final class DiffFileHeaderLayoutTests: XCTestCase {
    let dir = DiffTextBox(size: CGSize(width: 80, height: 16), baseline: 12)
    let fileName = DiffTextBox(size: CGSize(width: 60, height: 17), baseline: 13)

    func testEverything() {
        let layout = DiffFileHeaderLayout(.init(
            width: 393,
            chevron: CGSize(width: 14, height: 15),
            dir: dir,
            fileName: fileName,
            badge: CGSize(width: 24, height: 14),
            additions: CGSize(width: 20, height: 16),
            deletions: CGSize(width: 18, height: 16)
        ))
        assertSize(layout.size, CGSize(width: 393, height: 35))
        assertFrame(layout.chevron, rect(12, 10, 14, 15))
        assertFrame(layout.icon, rect(34, 9.5, 16, 16))
        assertFrame(layout.dir, rect(58, 10, 80, 16))
        assertFrame(layout.fileName, rect(138, 9, 60, 17))
        assertFrame(layout.badge, rect(303, 10.5, 24, 14))
        assertFrame(layout.additions, rect(335, 9.5, 20, 16))
        assertFrame(layout.deletions, rect(363, 9.5, 18, 16))
    }

    func testTheDirectoryGivesWayFirst() {
        func layout(_ width: CGFloat) -> DiffFileHeaderLayout {
            DiffFileHeaderLayout(.init(width: width, chevron: nil, dir: dir, fileName: fileName))
        }
        XCTAssertNil(layout(200).chevron)
        assertFrame(layout(200).icon, rect(12, 9.5, 16, 16))
        assertFrame(layout(200).dir, rect(36, 10, 80, 16))
        assertFrame(layout(200).fileName, rect(116, 9, 60, 17))
        assertFrame(layout(150).dir, rect(36, 10, 42, 16))
        assertFrame(layout(150).fileName, rect(78, 9, 60, 17))
        assertFrame(layout(100).dir, rect(36, 10, 0, 16))
        assertFrame(layout(100).fileName, rect(36, 9, 52, 17))
    }

    func testTheTallestPartSetsTheRow() {
        let layout = DiffFileHeaderLayout(.init(width: 393, chevron: CGSize(width: 14, height: 20), dir: dir, fileName: fileName))
        assertSize(layout.size, CGSize(width: 393, height: 38))
        assertFrame(layout.icon, rect(34, 11, 16, 16))
        assertFrame(layout.fileName, rect(58 + 80, 10.5, 60, 17))
        assertFrame(layout.dir, rect(58, 11.5, 80, 16))
    }
}

final class DiffImageLayoutTests: XCTestCase {
    func testTwoSides() {
        let layout = DiffImageLayout(width: 393, count: 2, labelHeight: 14)
        assertSize(layout.size, CGSize(width: 393, height: 204))
        assertFrame(layout.panes[0].label, rect(12, 12, 178.5, 14))
        assertFrame(layout.panes[0].box, rect(12, 32, 178.5, 160))
        assertFrame(layout.panes[0].image, rect(13, 33, 176.5, 158))
        assertFrame(layout.panes[1].box, rect(202.5, 32, 178.5, 160))
    }

    func testOneSide() {
        let layout = DiffImageLayout(width: 393, count: 1, labelHeight: 14)
        XCTAssertEqual(layout.panes.count, 1)
        assertFrame(layout.panes[0].box, rect(12, 32, 369, 160))
    }
}

final class DiffSectionLayoutTests: XCTestCase {
    func testMessage() {
        let layout = DiffSectionLayout(width: 393, headerHeight: 35, body: .message(CGSize(width: 120, height: 17)))
        assertFrame(layout.frame, rect(0, 0, 393, 85))
        assertFrame(layout.header, rect(0, 0, 393, 35))
        assertFrame(layout.content, rect(136.5, 51, 120, 17))
        assertFrame(layout.border, rect(0, 84, 393, 1))
        XCTAssertNil(layout.hintRow)
    }

    func testSpinnerAndHint() {
        let spinner = DiffSectionLayout(width: 393, headerHeight: 35, body: .spinner(CGSize(width: 20, height: 20)))
        assertFrame(spinner.content, rect(186.5, 51, 20, 20))
        XCTAssertEqual(spinner.height, 88)
        let hint = DiffSectionLayout(width: 393, headerHeight: 35, body: .hint(CGSize(width: 150, height: 17)))
        assertFrame(hint.hintRow, rect(0, 35, 393, 41))
        assertFrame(hint.content, rect(121.5, 47, 150, 17))
        assertFrame(hint.border, rect(0, 76, 393, 1))
    }

    func testCollapsedFilesAndImages() {
        let collapsed = DiffSectionLayout(width: 393, headerHeight: 35, body: .none)
        XCTAssertEqual(collapsed.height, 36)
        XCTAssertNil(collapsed.content)
        let files = DiffSectionLayout(width: 393, headerHeight: 35, body: .files([226, 180]))
        assertFrame(files.files[0], rect(0, 35, 393, 226))
        assertFrame(files.files[1], rect(0, 261, 393, 180))
        XCTAssertEqual(files.height, 442)
        let image = DiffSectionLayout(width: 393, headerHeight: 35, body: .image(height: 204))
        assertFrame(image.image, rect(0, 35, 393, 204))
        XCTAssertEqual(image.height, 240)
    }

    func testCentredAtMaxWidth() {
        let layout = DiffSectionLayout(width: 1000, maxWidth: 800, headerHeight: 35, body: .message(CGSize(width: 900, height: 34)))
        assertFrame(layout.frame, rect(100, 0, 800, 102))
        assertFrame(layout.header, rect(0, 0, 800, 35))
        assertFrame(layout.content, rect(0, 51, 800, 34))
    }
}

final class DiffFilesListLayoutTests: XCTestCase {
    func testSectionsAfterTheHeader() {
        let layout = DiffFilesListLayout(width: 393, headerHeight: 50, sections: [36, 85], empty: .zero)
        assertFrame(layout.header, rect(0, 0, 393, 50))
        assertFrame(layout.sections[0], rect(0, 50, 393, 36))
        assertFrame(layout.sections[1], rect(0, 86, 393, 85))
        XCTAssertNil(layout.empty)
        XCTAssertEqual(layout.contentHeight, 203)
    }

    func testEmpty() {
        let layout = DiffFilesListLayout(width: 393, headerHeight: nil, sections: [], empty: CGSize(width: 100, height: 20))
        XCTAssertNil(layout.header)
        assertFrame(layout.empty, rect(146.5, 32, 100, 20))
        XCTAssertEqual(layout.contentHeight, 116)
    }

    func testNotices() {
        let notices = DiffFilesListLayout.notices(width: 393, texts: [fixed(300, 20), block(height: 40)])
        assertFrame(notices.frames[0], rect(16, 16, 300, 20))
        assertFrame(notices.frames[1], rect(16, 44, 361, 40))
        XCTAssertEqual(notices.height, 100)
    }
}
