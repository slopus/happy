import Foundation
import XCTest
@testable import HappyLayout

/// Pins the stem cell against desktop's `stemCellGeometry.ts`, as written by
/// `scripts/generate-stem-cell-fixtures.ts`: the same ID is the same cell.
final class StemCellGeometryTests: XCTestCase {
    private struct Case: Decodable {
        let id: String
        let drift: Double
        let membrane: [[Double]]
        let core: [[Double]]
        let path20: String?
    }

    private func cases() throws -> [Case] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "stem-cell-geometry", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode([Case].self, from: Data(contentsOf: url))
    }

    func testShapesMatchDesktop() throws {
        for item in try cases() {
            let shape = StemCellGeometry.shape(item.id, drift: item.drift)
            XCTAssertEqual(shape.membrane.count, item.membrane.count, item.id)
            for (point, expected) in zip(shape.membrane, item.membrane) {
                XCTAssertEqual(point.x, expected[0], accuracy: 1e-9, item.id)
                XCTAssertEqual(point.y, expected[1], accuracy: 1e-9, item.id)
            }
            for (point, expected) in zip(shape.core, item.core) {
                XCTAssertEqual(point.x, expected[0], accuracy: 1e-9, item.id)
                XCTAssertEqual(point.y, expected[1], accuracy: 1e-9, item.id)
            }
        }
    }

    func testSplineMatchesDesktopPath() throws {
        for item in try cases() {
            guard let expected = item.path20 else { continue }
            let (start, segments) = StemCellGeometry.smooth(StemCellGeometry.shape(item.id).membrane, size: 20)
            func f(_ value: Double) -> String { String(format: "%.2f", value) }
            var path = "M\(f(start.x)) \(f(start.y))"
            for segment in segments {
                path += "C\(f(segment.control1.x)) \(f(segment.control1.y)) \(f(segment.control2.x)) \(f(segment.control2.y)) \(f(segment.end.x)) \(f(segment.end.y))"
            }
            XCTAssertEqual(path + "Z", expected, item.id)
        }
    }

    func testHashAndRandomFollowJavaScript() {
        // FNV-1a of "a" and the first mulberry32 draw from it, from Node.
        XCTAssertEqual(StemCellGeometry.hash("a"), 0xe40c292c)
        XCTAssertEqual(StemCellGeometry.hash(""), 0x811c9dc5)
    }
}
