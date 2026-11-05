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
        XCTAssertEqual(M.captionLines, 4)
        XCTAssertEqual([M.captionSize, M.postGap, M.postBottom, M.coverRadius, M.postMaxWidth], [15, 8, 16, 10, 640])
        XCTAssertEqual([M.toggleTarget, M.toggleSlop], [44, 8])
    }

    private static let wide: CGFloat = 9.0 / 16.0

    private func post(width: CGFloat = 390, maxWidth: CGFloat = .greatestFiniteMagnitude, place: CardPlace = .alone, caption: Measurable? = nil, cover: CGFloat?) -> FeedRowLayout {
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

    /// No shape is no cover; with no words either the row stays compact.
    func testNoShapeIsNoCover() {
        for ratio in [nil, 0, -1, .infinity] as [CGFloat?] {
            let row = post(caption: nil, cover: ratio)
            XCTAssertNil(row.cover)
            XCTAssertNil(row.caption)
            XCTAssertEqual(row.size.height, 64)
            XCTAssertEqual(post(caption: .fixed(width: 0, height: 0), cover: ratio).size.height, 64, "an empty caption is no post")
        }
    }

    /// A summary with no cover is a post of words: the row, the caption
    /// inset to inset, and the post's margin under it.
    func testASummaryWithoutACover() {
        for ratio in [nil, 0] as [CGFloat?] {
            let row = post(place: CardPlace(first: true, last: false), caption: .fixed(width: 300, height: 72), cover: ratio)
            XCTAssertNil(row.cover)
            XCTAssertEqual(row.caption, CGRect(x: 32, y: 64, width: 326, height: 72))
            XCTAssertEqual(row.size.height, 64 + 72 + 16)
            XCTAssertEqual(row.separator, CGRect(x: 84, y: 151.5, width: 290, height: 0.5))
        }
    }

    /// The caption is measured at the post's width and is as tall as what
    /// it says: four lines cut, or all of them opened, the cover under
    /// it at its shape either way and only moved down.
    func testCollapsedAndExpanded() {
        var offered: [CGFloat] = []
        func lines(_ count: Int) -> Measurable {
            Measurable { width in
                offered.append(width)
                return CGSize(width: width, height: CGFloat(count) * 19.5)
            }
        }
        let collapsed = post(caption: lines(4), cover: Self.wide)
        let expanded = post(caption: lines(11), cover: Self.wide)
        XCTAssertEqual(offered, [326, 326])
        XCTAssertEqual(collapsed.caption, CGRect(x: 32, y: 64, width: 326, height: 78))
        XCTAssertEqual(expanded.caption, CGRect(x: 32, y: 64, width: 326, height: 214.5))
        XCTAssertEqual(collapsed.cover, CGRect(x: 32, y: 150, width: 326, height: 183.5))
        XCTAssertEqual(expanded.cover, CGRect(x: 32, y: 286.5, width: 326, height: 183.5))
        XCTAssertEqual(expanded.size.height - collapsed.size.height, 214.5 - 78)
        XCTAssertEqual(collapsed.title, expanded.title, "the row on top never moves")

        // A new width measures again at the new width.
        let narrow = post(width: 320, caption: lines(6), cover: Self.wide)
        XCTAssertEqual(offered.last, 256)
        XCTAssertEqual(narrow.caption?.height, 117)
        XCTAssertEqual(FeedRowLayout.postWidth(width: 320), 256)
    }

    /// On an iPad the post stands in the readable column, its caption and
    /// cover no wider than desktop's 640 from the card's inset, so a
    /// square stays a sensible size.
    func testAPostInTheReadableColumn() {
        XCTAssertEqual(FeedRowLayout.postWidth(width: 1024, maxWidth: 800), 640)
        XCTAssertEqual(FeedRowLayout.postWidth(width: 390), 326)
        XCTAssertEqual(FeedRowLayout.postWidth(width: 800), 640, "any list that wide stops at 640")
        let wide = post(width: 1024, maxWidth: 800, caption: .fixed(width: 600, height: 78), cover: Self.wide)
        XCTAssertEqual(wide.card, CGRect(x: 128, y: 0, width: 768, height: wide.size.height), "the card keeps the readable column")
        XCTAssertEqual(wide.caption, CGRect(x: 144, y: 64, width: 640, height: 78))
        XCTAssertEqual(wide.cover, CGRect(x: 144, y: 150, width: 640, height: 360))
        XCTAssertEqual(wide.size.height, 64 + 78 + 8 + 360 + 16)
        let square = post(width: 1024, maxWidth: 800, cover: 1)
        XCTAssertEqual(square.cover, CGRect(x: 144, y: 64, width: 640, height: 640))
    }
}
