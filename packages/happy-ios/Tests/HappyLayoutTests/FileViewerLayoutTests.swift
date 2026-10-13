import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// file.tsx's header, toggle and DiffDisplay rows.
final class FileViewerLayoutTests: XCTestCase {
    func testHeaderAndToggle() {
        let layout = FileViewerLayout(.init(
            size: CGSize(width: 393, height: 852),
            top: 100,
            path: fixed(200, 18),
            toggle: (diff: CGSize(width: 30, height: 18), file: CGSize(width: 26, height: 18))
        ))
        assertFrame(layout.header, rect(0, 100, 393, 52.5))
        assertFrame(layout.icon, rect(16, 116, 20, 20))
        assertFrame(layout.path, rect(44, 117, 333, 18))
        assertFrame(layout.headerBorder, rect(0, 152, 393, 0.5))
        assertFrame(layout.toggleBar, rect(0, 152.5, 393, 58.5))
        assertFrame(layout.diffButton, rect(16, 164.5, 62, 34))
        assertFrame(layout.diffLabel, rect(32, 172.5, 30, 18))
        assertFrame(layout.fileButton, rect(86, 164.5, 58, 34))
        assertFrame(layout.fileLabel, rect(102, 172.5, 26, 18))
        assertFrame(layout.toggleBorder, rect(0, 210.5, 393, 0.5))
        assertFrame(layout.content, rect(0, 211, 393, 641))
    }

    func testLongPathsWrapAndNoToggle() {
        let layout = FileViewerLayout(.init(size: CGSize(width: 393, height: 852), top: 0, path: text(String(repeating: "a", count: 60), advance: 8, lineHeight: 18), toggle: nil))
        // 333 wide holds 41 characters: two lines. The text box is flex: 1.
        assertFrame(layout.path, rect(44, 16, 333, 36))
        assertFrame(layout.icon, rect(16, 24, 20, 20))
        assertFrame(layout.header, rect(0, 0, 393, 68.5))
        XCTAssertNil(layout.toggleBar)
        XCTAssertNil(layout.diffButton)
        assertFrame(layout.content, rect(0, 68.5, 393, 783.5))
    }

    func testDiffRows() {
        let none = CGFloat.greatestFiniteMagnitude
        XCTAssertEqual(FileLinesLayout.textWidth(width: 393, maxWidth: none, insets: .diff, bar: false), 345)
        XCTAssertEqual(FileLinesLayout.textWidth(width: 393, maxWidth: none, insets: .diff, bar: true), 342)
        let layout = FileLinesLayout(width: 393, maxWidth: none, insets: .diff, textHeights: [20, 40, 20], bars: [false, true, false])
        XCTAssertEqual(layout.count, 3)
        assertFrame(layout.row(0), rect(16, 16, 361, 22))
        assertFrame(layout.row(1), rect(16, 38, 361, 42))
        assertFrame(layout.row(2), rect(16, 80, 361, 22))
        assertFrame(layout.text(0), rect(8, 1, 345, 20))
        assertFrame(layout.text(1), rect(11, 1, 342, 40))
        XCTAssertNil(layout.bar(0))
        assertFrame(layout.bar(1), rect(0, 0, 3, 42))
        assertFrame(layout.block, rect(16, 16, 361, 86))
        assertSize(layout.contentSize, CGSize(width: 393, height: 118))
        XCTAssertEqual(layout.rows(from: 0, to: 16), 0..<0)
        XCTAssertEqual(layout.rows(from: 0, to: 17), 0..<1)
        XCTAssertEqual(layout.rows(from: 37, to: 39), 0..<2)
        XCTAssertEqual(layout.rows(from: 38, to: 80), 1..<2)
        XCTAssertEqual(layout.rows(from: 50, to: 1000), 1..<3)
        XCTAssertEqual(layout.rows(from: 102, to: 1000), 3..<3)
    }

    func testCodeLinesCentreInTheMaxWidth() {
        // An iPad's 1024 holds the 800 column, centred.
        XCTAssertEqual(FileLinesLayout.textWidth(width: 1024, maxWidth: 800, insets: .code, bar: false), 768)
        let layout = FileLinesLayout(width: 1024, maxWidth: 800, insets: .code, textHeights: [20, 60], bars: [])
        assertFrame(layout.row(0), rect(128, 16, 768, 20))
        assertFrame(layout.row(1), rect(128, 36, 768, 60))
        assertFrame(layout.text(1), rect(0, 0, 768, 60))
        XCTAssertNil(layout.bar(1))
        assertSize(layout.contentSize, CGSize(width: 1024, height: 112))
    }

    func testMessage() {
        let message = FileLinesLayout.message(width: 393, maxWidth: .greatestFiniteMagnitude, text: fixed(120, 21))
        assertFrame(message.frame, rect(16, 16, 361, 21))
        assertSize(message.contentSize, CGSize(width: 393, height: 53))
        let wide = FileLinesLayout.message(width: 1024, maxWidth: 800, text: fixed(120, 21))
        assertFrame(wide.frame, rect(128, 16, 768, 21))
    }

    func testNoRows() {
        let layout = FileLinesLayout(width: 393, maxWidth: .greatestFiniteMagnitude, insets: .diff, textHeights: [], bars: [])
        XCTAssertEqual(layout.count, 0)
        XCTAssertEqual(layout.rows(from: 0, to: 100), 0..<0)
        assertFrame(layout.block, rect(16, 16, 361, 0))
        assertSize(layout.contentSize, CGSize(width: 393, height: 32))
    }
}
