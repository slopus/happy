import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for a Feed entry's row: desktop's feed row in home's inset
/// grouped cards.
final class FeedRowLayoutTests: XCTestCase {
    func testTheMeasuresAreDesktopsFeedRow() {
        typealias M = FeedMetrics
        XCTAssertEqual([M.avatar, M.minHeight, M.lineGap], [40, 64, 4])
        XCTAssertEqual([M.face, M.faceOverlap, M.faceRing, M.moreGap, M.summaryGap], [18, 6, 1.5, 4, 6])
        XCTAssertEqual(M.maxFaces, 3)
        XCTAssertEqual([M.dot, M.dotGap, M.titleSize, M.summarySize], [8, 6, 16, 13])
        XCTAssertEqual([M.clusterAvatar, M.clusterRow], [32, 52])
    }

    /// The avatar, the title with its time and the dot, and under them three
    /// overlapping faces, "+N" and the newest change; the hairline runs from
    /// the text to the card's edge.
    func testARowWithFacesMoreAndATime() {
        let row = FeedRowLayout(
            width: 390, place: CardPlace(first: true, last: false),
            title: .fixed(width: 200, height: 19), time: CGSize(width: 40, height: 16),
            faces: 3, more: CGSize(width: 20, height: 16), summary: .fixed(width: 150, height: 16),
            hairline: 0.5, scale: 2
        )
        XCTAssertEqual(row.size, CGSize(width: 390, height: 64))
        XCTAssertEqual(row.card, CGRect(x: 16, y: 0, width: 358, height: 64))
        XCTAssertEqual(row.avatar, CGRect(x: 32, y: 12, width: 40, height: 40))
        XCTAssertEqual(row.title, CGRect(x: 84, y: 11.5, width: 212, height: 19))
        XCTAssertEqual(row.time, CGRect(x: 304, y: 13, width: 40, height: 16))
        XCTAssertEqual(row.dot, CGRect(x: 350, y: 17, width: 8, height: 8))
        XCTAssertEqual(row.faces, [
            CGRect(x: 84, y: 34.5, width: 18, height: 18),
            CGRect(x: 96, y: 34.5, width: 18, height: 18),
            CGRect(x: 108, y: 34.5, width: 18, height: 18),
        ])
        XCTAssertEqual(row.more, CGRect(x: 130, y: 35.5, width: 20, height: 16))
        XCTAssertEqual(row.summary, CGRect(x: 156, y: 35.5, width: 202, height: 16))
        XCTAssertEqual(row.separator, CGRect(x: 84, y: 63.5, width: 290, height: 0.5))
    }

    /// No faces and no time: the summary starts under the title, which
    /// runs to the dot's lane; the dot's lane is kept all the same.
    func testARowWithNoFacesKeepsTheDotsLane() {
        let row = FeedRowLayout(
            width: 390, place: .alone,
            title: .fixed(width: 400, height: 19), time: nil,
            faces: 0, more: nil, summary: .fixed(width: 100, height: 16),
            hairline: 0.5, scale: 2
        )
        XCTAssertEqual(row.size.height, 64)
        XCTAssertEqual(row.title, CGRect(x: 84, y: 12.5, width: 260, height: 19))
        XCTAssertNil(row.time)
        XCTAssertEqual(row.dot, CGRect(x: 350, y: 18, width: 8, height: 8))
        XCTAssertEqual(row.faces, [])
        XCTAssertNil(row.more)
        XCTAssertEqual(row.summary, CGRect(x: 84, y: 35.5, width: 274, height: 16))
        XCTAssertNil(row.separator)
    }

    /// Faces past three are left to "+N"; larger text grows the row.
    func testLargerTextGrowsTheRowAndFacesStopAtThree() {
        let row = FeedRowLayout(
            width: 390, place: .alone,
            title: .fixed(width: 100, height: 30), time: CGSize(width: 40, height: 20),
            faces: 5, more: nil, summary: .fixed(width: 100, height: 20),
            hairline: 0.5, scale: 2
        )
        XCTAssertEqual(row.size.height, 74)
        XCTAssertEqual(row.avatar.minY, 17)
        XCTAssertEqual(row.title.minY, 10)
        XCTAssertEqual(row.faces.count, 3)
        XCTAssertEqual(row.faces.map(\.minY), [45, 45, 45])
        XCTAssertEqual(row.summary?.minX, 84 + 42 + 6)
    }

    /// On an iPad the row stands in the readable column.
    func testTheReadableColumn() {
        let row = FeedRowLayout(
            width: 1024, maxWidth: 800, place: .alone,
            title: .fixed(width: 100, height: 19), time: nil,
            faces: 1, more: nil, summary: nil,
            hairline: 0.5, scale: 2
        )
        XCTAssertEqual(row.card, CGRect(x: 128, y: 0, width: 768, height: 64))
        XCTAssertEqual(row.avatar.minX, 144)
        XCTAssertEqual(row.title.minX, 196)
        XCTAssertEqual(row.dot.maxX, 880)
        XCTAssertEqual(row.faces, [CGRect(x: 196, y: 34.5, width: 18, height: 18)])
        XCTAssertNil(row.summary)
    }
}
