import XCTest
@testable import HappyLayout

/// A `media` component's items in a phone's 370 column, by the rule every
/// client shares; the frames are happy-desktop `uiMediaLayout`'s at a 160
/// row height.
final class MediaRowsTests: XCTestCase {
    private func layout(_ width: CGFloat, _ sizes: [(CGFloat, CGFloat)], labelled: Set<Int> = []) -> MediaRows {
        MediaRows(width: width, items: sizes.enumerated().map { MediaRows.Item(width: $1.0, height: $1.1, labelled: labelled.contains($0)) })
    }

    private func frames(_ rows: MediaRows) -> [CGRect] { rows.tiles.map(\.frame) }

    /// Alone, an item is the column wide at most and 320 tall at most, at the left.
    func testOneItemIsAtMostTheColumnWideAndTwiceTheRowTall() {
        XCTAssertEqual(frames(layout(370, [(1600, 900)])), [CGRect(x: 0, y: 0, width: 370, height: 208)])
        XCTAssertEqual(frames(layout(370, [(900, 1600)])), [CGRect(x: 0, y: 0, width: 180, height: 320)])
        XCTAssertEqual(layout(370, [(1000, 1000)]).size, CGSize(width: 370, height: 320))
    }

    /// A wide and a tall picture share a row: filled with the tall one it
    /// comes nearer 160 than the wide one filling it alone.
    func testAWideAndATallPictureShareARow() {
        let rows = layout(370, [(1600, 900), (900, 1600)])
        XCTAssertEqual(frames(rows), [CGRect(x: 0, y: 0, width: 277, height: 156), CGRect(x: 283, y: 0, width: 87, height: 156)])
        XCTAssertEqual(rows.size, CGSize(width: 370, height: 156))
        // Two 4:3 do too, a little under 160.
        XCTAssertEqual(frames(layout(370, [(1200, 900), (1200, 900)])), [CGRect(x: 0, y: 0, width: 182, height: 137), CGRect(x: 188, y: 0, width: 182, height: 137)])
    }

    /// A filled row's widths add up to the column; the last row, short of
    /// it at 160, shrinks only to fit.
    func testFourItemsMakeTwoRowsAcrossTheColumn() {
        let rows = layout(370, [(2, 1), (1, 2), (1, 1), (3, 2)])
        XCTAssertEqual(frames(rows), [
            CGRect(x: 0, y: 0, width: 291, height: 146), CGRect(x: 297, y: 0, width: 73, height: 146),
            CGRect(x: 0, y: 152, width: 146, height: 146), CGRect(x: 152, y: 152, width: 218, height: 146),
        ])
        XCTAssertEqual(rows.size, CGSize(width: 370, height: 298))
    }

    /// Shapes past 3 wide or 0.4 narrow are laid out as those, cropped; the
    /// last row stays 160 tall at the left.
    func testExtremeShapesAreHeldTo3And04() {
        let rows = layout(360, [(10, 1), (1, 10)])
        XCTAssertEqual(frames(rows), [CGRect(x: 0, y: 0, width: 360, height: 120), CGRect(x: 0, y: 126, width: 64, height: 160)])
        XCTAssertEqual(rows.size, CGSize(width: 360, height: 286))
    }

    /// One that states no size is 4:3, or 16:9 for a recording.
    func testAnItemWithoutASizeIsFourByThreeOrSixteenByNineForARecording() {
        let rows = MediaRows(width: 370, items: [MediaRows.Item(width: nil, height: nil, isVideo: true), MediaRows.Item(width: nil, height: nil)])
        XCTAssertEqual(frames(rows), [CGRect(x: 0, y: 0, width: 208, height: 117), CGRect(x: 214, y: 0, width: 156, height: 117)])
    }

    /// A label is one 18 line 4 under its item, and its row is that much
    /// taller, whether or not the others in it have one.
    func testALabelMakesItsRowItsLineTaller() {
        let rows = layout(370, [(1, 1), (1, 1), (1, 1)], labelled: [0])
        XCTAssertEqual(rows.tiles, [
            .init(frame: CGRect(x: 0, y: 0, width: 182, height: 182), label: CGRect(x: 0, y: 186, width: 182, height: 18)),
            .init(frame: CGRect(x: 188, y: 0, width: 182, height: 182)),
            .init(frame: CGRect(x: 0, y: 210, width: 160, height: 160)),
        ])
        XCTAssertEqual(rows.size, CGSize(width: 370, height: 370))
    }

    /// Every case of happy-agent's `mediaLayout` table, at every width and
    /// row height: the same frames, labels and height as `layoutMedia`.
    func testTheFramesAreTheClientsForEveryCaseOfTheTable() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/media-layout.json")
        let table = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let cases = try XCTUnwrap(table["mediaLayout"] as? [[String: Any]])
        XCTAssertEqual(cases.count, 11)
        func rect(_ value: Any?) -> CGRect? {
            guard let value = value as? [String: Double] else { return nil }
            return CGRect(x: value["x"] ?? -1, y: value["y"] ?? -1, width: value["width"] ?? -1, height: value["height"] ?? -1)
        }
        for one in cases {
            let name = one["name"] as? String ?? ""
            let items = (one["items"] as? [[String: Any]] ?? []).map { item in
                MediaRows.Item(width: (item["width"] as? Double).map { CGFloat($0) }, height: (item["height"] as? Double).map { CGFloat($0) },
                               isVideo: item["kind"] as? String == "video", labelled: item["label"] != nil)
            }
            for expected in one["layouts"] as? [[String: Any]] ?? [] {
                let width = expected["width"] as? Double ?? 0, rowHeight = expected["rowHeight"] as? Double ?? 0
                let rows = MediaRows(width: width, items: items, rowHeight: rowHeight)
                let context = "\(name) at \(width) × \(rowHeight)"
                XCTAssertEqual(rows.tiles.map(\.frame), (expected["frames"] as? [Any] ?? []).compactMap(rect), context)
                XCTAssertEqual(rows.tiles.map(\.label), (expected["labels"] as? [Any] ?? []).map(rect), context)
                XCTAssertEqual(rows.size.height, expected["height"] as? Double ?? -1, context)
            }
        }
    }
}
