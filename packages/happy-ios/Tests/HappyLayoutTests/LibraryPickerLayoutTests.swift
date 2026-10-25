import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for the library sheet, after Telegram's attachment gallery
/// (`MediaPickerScreen`, `MediaPickerGridItem`, `MediaPickerManageNode`).
final class LibraryPickerLayoutTests: XCTestCase {
    private func layout(width: CGFloat = 402, count: Int = 10, wide: Bool = false, note: Bool = false, picking: Bool = false) -> LibraryPickerLayout {
        LibraryPickerLayout(.init(
            width: width, height: 800, safeBottom: 34, wide: wide, pixel: 1.0 / 3, count: count,
            note: note ? fixed(240, 36) : nil, noteButton: note ? CGSize(width: 70, height: 18) : nil,
            title: CGSize(width: 64, height: 22), cancel: CGSize(width: 56, height: 22), picking: picking
        ))
    }

    /// Three a row, 1 apart, floored to the pixel; the last column takes
    /// what the rounding left so the row ends at the edge.
    func testThreeSquaresARow() {
        let grid = layout()
        XCTAssertEqual(grid.columns, 3)
        XCTAssertEqual(grid.cell.width, 133.333, accuracy: 0.001)
        assertFrame(grid.frame(at: 0), rect(0, 0, grid.cell.width, grid.cell.width))
        assertFrame(grid.frame(at: 1), rect(grid.cell.width + 1, 0, grid.cell.width, grid.cell.width))
        XCTAssertEqual(grid.frame(at: 2).maxX, 402, accuracy: 0.001)
        assertFrame(grid.frame(at: 3), rect(0, grid.cell.width + 1, grid.cell.width, grid.cell.width))
        XCTAssertEqual(grid.contentHeight, 4 * grid.cell.width + 3, accuracy: 0.001)
        XCTAssertEqual(layout(wide: true).columns, 5)
    }

    /// The picks' count after Cancel, 21 tall, 28 wider than its number;
    /// a wide Cancel pushes it along.
    func testTheSelectedCount() {
        func with(_ cancel: CGFloat) -> LibraryPickerLayout {
            LibraryPickerLayout(.init(
                width: 402, height: 800, safeBottom: 34, wide: false, pixel: 1.0 / 3, count: 10, note: nil, noteButton: nil,
                title: CGSize(width: 64, height: 22), cancel: CGSize(width: cancel, height: 22), picking: true, selected: CGSize(width: 8.4, height: 18)
            ))
        }
        XCTAssertEqual(with(44).selected, rect(72, 17, 37, 21))
        XCTAssertEqual(with(56).selected, rect(84, 17, 37, 21))
        XCTAssertNil(layout(picking: true).selected)
    }

    /// Laid out before it has a width: empty cells, never negative ones.
    func testNoWidth() {
        let grid = layout(width: 0)
        XCTAssertEqual(grid.cell, .zero)
        XCTAssertGreaterThanOrEqual(grid.contentHeight, 0)
    }

    func testTheBar() {
        let grid = layout()
        assertFrame(grid.bar, rect(0, 0, 402, 56))
        assertFrame(grid.title, rect(169, 17, 64, 22))
        assertFrame(grid.cancel, rect(16, 17, 56, 22))
        assertFrame(grid.grid, rect(0, 56, 402, 744))
    }

    /// Limited access: the note above the cells, its button 10 in from the
    /// right and both 5 above the middle, the cells under it.
    func testTheLimitedNote() {
        let grid = layout(note: true)
        assertFrame(grid.note!, rect(0, 0, 402, 64))
        assertFrame(grid.noteText!, rect(16, 9, 240, 36))
        assertFrame(grid.noteButton!, rect(402 - 10 - 96, 13, 96, 28))
        XCTAssertEqual(grid.frame(at: 0).minY, 64)
        XCTAssertEqual(grid.visible(minY: 0, maxY: 64, count: 10), 0..<3)
    }

    /// The button rises from below the sheet once something is picked, and
    /// the grid keeps room for it.
    func testTheAddButton() {
        let idle = layout()
        XCTAssertGreaterThan(idle.button.minY, 800)
        XCTAssertEqual(idle.bottomInset, 34)
        let picking = layout(picking: true)
        assertFrame(picking.button, rect(16, 800 - 34 - 8 - 50, 370, 50))
        XCTAssertEqual(picking.bottomInset, 34 + 66)
    }

    func testCellChrome() {
        let side = CGSize(width: 133, height: 133)
        assertFrame(LibraryPickerLayout.check(in: side), rect(101, 3, 29, 29))
        assertFrame(LibraryPickerLayout.duration(CGSize(width: 30, height: 13), in: side), rect(97, 114, 30, 13))
        XCTAssertEqual(LibraryPickerLayout.duration(seconds: 65.4), "1:05")
        XCTAssertEqual(LibraryPickerLayout.duration(seconds: 3725), "1:02:05")
        XCTAssertEqual(LibraryPickerLayout.numberSize(3), 16)
        XCTAssertEqual(LibraryPickerLayout.numberSize(12), 15)
        XCTAssertEqual(LibraryPickerLayout.numberSize(100), 13)
    }

    func testVisibleCells() {
        let grid = layout(count: 30)
        XCTAssertEqual(grid.visible(minY: 0, maxY: 200, count: 30), 0..<6)
        XCTAssertEqual(grid.visible(minY: 300, maxY: 400, count: 30), 6..<9)
        XCTAssertEqual(grid.visible(minY: 0, maxY: 10_000, count: 30), 0..<30)
    }
}
