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

    // MARK: Posts

    func testThePostsMeasures() {
        typealias M = FeedMetrics
        XCTAssertEqual(M.captionLines, 3)
        XCTAssertEqual([M.captionSize, M.postGap, M.postBottom, M.coverRadius], [15, 8, 16, 10])
    }

    private static let wide: CGFloat = 9.0 / 16.0

    private func post(width: CGFloat = 390, maxWidth: CGFloat = .greatestFiniteMagnitude, place: CardPlace = .alone, caption: Measurable? = nil, cover: CGFloat) -> FeedRowLayout {
        FeedRowLayout(
            width: width, maxWidth: maxWidth, place: place,
            title: .fixed(width: 200, height: 19), time: CGSize(width: 40, height: 16),
            faces: 1, more: nil, summary: .fixed(width: 100, height: 16),
            caption: caption, cover: cover, hairline: 0.5, scale: 2
        )
    }

    /// A wide cover under the row: the row's own frames stay where a
    /// plain row has them, the caption and the cover run inset to inset,
    /// and the cover is exactly 16:9.
    func testAPostIsTheRowThenItsCaptionAndCover() {
        let plain = FeedRowLayout(
            width: 390, place: .alone,
            title: .fixed(width: 200, height: 19), time: CGSize(width: 40, height: 16),
            faces: 1, more: nil, summary: .fixed(width: 100, height: 16),
            hairline: 0.5, scale: 2
        )
        let row = post(place: CardPlace(first: true, last: false), caption: .fixed(width: 300, height: 36), cover: Self.wide)
        XCTAssertEqual(row.avatar, plain.avatar)
        XCTAssertEqual(row.title, plain.title)
        XCTAssertEqual(row.time, plain.time)
        XCTAssertEqual(row.dot, plain.dot)
        XCTAssertEqual(row.faces, plain.faces)
        XCTAssertEqual(row.summary, plain.summary)
        XCTAssertNil(plain.caption)
        XCTAssertNil(plain.cover)

        XCTAssertEqual(row.caption, CGRect(x: 32, y: 64, width: 326, height: 36))
        // 326 wide at 16:9 is 183.375, on the half pixel.
        XCTAssertEqual(row.cover, CGRect(x: 32, y: 108, width: 326, height: 183.5))
        XCTAssertEqual(row.size, CGSize(width: 390, height: 307.5))
        XCTAssertEqual(row.card, CGRect(x: 16, y: 0, width: 358, height: 307.5))
        XCTAssertEqual(row.separator, CGRect(x: 84, y: 307, width: 290, height: 0.5))
    }

    /// A square cover, and no summary: the cover follows the row at once,
    /// as tall as it is wide.
    func testASquarePostWithoutACaption() {
        let row = post(caption: nil, cover: 1)
        XCTAssertNil(row.caption)
        XCTAssertEqual(row.cover, CGRect(x: 32, y: 64, width: 326, height: 326))
        XCTAssertEqual(row.size.height, 64 + 326 + 16)
        XCTAssertNil(row.separator)

        let empty = post(caption: .fixed(width: 0, height: 0), cover: 1)
        XCTAssertNil(empty.caption, "an empty caption takes no room")
        XCTAssertEqual(empty.cover, row.cover)
    }

    /// On a 3x screen the height lands on a third of a point.
    func testTheCoverIsOnThePixelGrid() {
        let row = FeedRowLayout(
            width: 390, place: .alone,
            title: .fixed(width: 200, height: 19), time: nil,
            faces: 0, more: nil, summary: nil,
            cover: Self.wide, hairline: 1.0 / 3, scale: 3
        )
        // 326 × 9/16 = 183.375 → 550.125 pixels → 550.
        XCTAssertEqual(row.cover?.height ?? 0, 550.0 / 3, accuracy: 0.0001)
    }

    /// No shape is no post; the row stays compact.
    func testNoShapeIsNoPost() {
        for ratio in [0, -1, .infinity] as [CGFloat] {
            let row = post(caption: .fixed(width: 100, height: 18), cover: ratio)
            XCTAssertNil(row.cover)
            XCTAssertNil(row.caption)
            XCTAssertEqual(row.size.height, 64)
        }
    }

    /// On an iPad the post stands in the readable column, so a square
    /// stays a sensible size.
    func testAPostInTheReadableColumn() {
        let wide = post(width: 1024, maxWidth: 800, cover: Self.wide)
        XCTAssertEqual(wide.cover, CGRect(x: 144, y: 64, width: 736, height: 414))
        XCTAssertEqual(wide.size.height, 64 + 414 + 16)
        let square = post(width: 1024, maxWidth: 800, cover: 1)
        XCTAssertEqual(square.cover, CGRect(x: 144, y: 64, width: 736, height: 736))
    }
}
