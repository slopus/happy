import XCTest
@testable import HappyLayout

final class StartLayoutTests: XCTestCase {
    private let phone = CGSize(width: 393, height: 852)
    private let safe = LayoutInsets(top: 59, left: 0, bottom: 34, right: 0)
    private let dots = CGSize(width: 120, height: 26)

    /// Four slides whose words are `lines` lines tall at the column's width:
    /// 34 a title line, 24 a body line.
    private func slides(_ lines: [(title: Int, body: Int)] = [(1, 2), (1, 1), (2, 2), (1, 1)]) -> [StartLayout.Slide] {
        lines.map { lines in
            StartLayout.Slide(
                title: Measurable { CGSize(width: $0, height: CGFloat(lines.title) * 34) },
                body: Measurable { CGSize(width: $0, height: CGFloat(lines.body) * 24) }
            )
        }
    }

    private func layout(size: CGSize? = nil, safeArea: LayoutInsets? = nil, button: CGSize = CGSize(width: 120, height: 56), slides: [StartLayout.Slide]? = nil) -> StartLayout {
        StartLayout(size: size ?? phone, safeArea: safeArea ?? safe, button: button, slides: slides ?? self.slides(), dots: dots)
    }

    func testStartSitsFortyEightAboveTheBottomInset() {
        let layout = layout()
        XCTAssertEqual(layout.button.maxY, 852 - 34 - 48)
        XCTAssertEqual(layout.contentHeight, 759)
        XCTAssertEqual(layout.cloud, .zero)
    }

    /// Happy Cloud's text action sits 12 under Start and 24 above the
    /// bottom inset; Start rises from its 48 to make room, and the slides
    /// stay centred between the top row and Start.
    func testCloudAndStartShareTheWiderLabelAndKeepTheirGap() {
        let layout = StartLayout(size: phone, safeArea: safe, button: CGSize(width: 120, height: 56),
                                 cloud: CGSize(width: 260, height: 56), slides: slides(), dots: dots)
        XCTAssertEqual(layout.button, CGRect(x: 56.5, y: 670, width: 280, height: 56))
        XCTAssertEqual(layout.cloud, CGRect(x: 56.5, y: 738, width: 280, height: 56))
        XCTAssertEqual(layout.cloud.minY - layout.button.maxY, 12)
        XCTAssertEqual(layout.cloud.maxY, 852 - 34 - 24)
        XCTAssertEqual(layout.bottomPadding, 92)
        XCTAssertEqual(layout.gallery, CGRect(x: 0, y: 243.5, width: 393, height: 294))
        XCTAssertEqual(layout.gallery.minY - layout.help.maxY, layout.button.minY - layout.gallery.maxY, accuracy: 0.001)
        XCTAssertEqual(layout.contentHeight, 759)
    }

    func testCloudAndStartScrollTogetherInLandscape() {
        let layout = StartLayout(size: CGSize(width: 852, height: 393),
                                 safeArea: LayoutInsets(top: 0, left: 59, bottom: 21, right: 59),
                                 button: CGSize(width: 120, height: 56), cloud: CGSize(width: 260, height: 56),
                                 slides: slides(), dots: dots)
        XCTAssertEqual(layout.button, CGRect(x: 286, y: 318, width: 280, height: 56))
        XCTAssertEqual(layout.cloud, CGRect(x: 286, y: 386, width: 280, height: 56))
        XCTAssertEqual(layout.gallery, CGRect(x: 59, y: 68, width: 734, height: 234))
        XCTAssertEqual(layout.contentHeight, 466)
        XCTAssertEqual(layout.cloud.maxY + 24, layout.contentHeight)
    }

    func testStartIsAsWideAsItsLabelAtLeast280AndCentred() {
        let layout = layout()
        XCTAssertEqual(layout.button.width, 280)
        XCTAssertEqual(layout.button.midX, 196.5)
        let wide = self.layout(button: CGSize(width: 320, height: 56))
        XCTAssertEqual(wide.button.width, 320)
        XCTAssertEqual(wide.button.midX, 196.5)
        let shifted = self.layout(safeArea: LayoutInsets(top: 59, left: 40, bottom: 34, right: 0))
        XCTAssertEqual(shifted.button.midX, 40 + 353 / 2)
    }

    func testHelpSitsFourInFromTheTopRightOfTheSafeArea() {
        let layout = layout(safeArea: LayoutInsets(top: 59, left: 0, bottom: 34, right: 20))
        XCTAssertEqual(layout.help, CGRect(x: 393 - 20 - 4 - 48, y: 63, width: 48, height: 48))
    }

    func testTheLogotypeIsSmallAndCentredOnHelpsRow() {
        let layout = layout()
        XCTAssertEqual(layout.logo.width, 88)
        XCTAssertEqual(layout.logo.height, 88 / (1200.0 / 319.0), accuracy: 0.001)
        XCTAssertEqual(layout.logo.midX, 196.5)
        XCTAssertEqual(layout.logo.midY, layout.help.midY, accuracy: 0.001)
    }

    /// The art's square, the tallest slide's words and the dots, centred
    /// between ⋯'s row and Start.
    func testTheSlidesAreCentredBetweenTheTopRowAndStart() {
        let layout = layout()
        // Tallest words: two title lines and two body lines.
        let words: CGFloat = 68 + 8 + 48
        XCTAssertEqual(layout.pager, CGRect(x: 0, y: 0, width: 393, height: 96 + 24 + words))
        XCTAssertEqual(layout.gallery.height, layout.pager.height + 24 + 26)
        XCTAssertEqual(layout.gallery.minY - layout.help.maxY, layout.button.minY - layout.gallery.maxY, accuracy: 0.001)
        XCTAssertEqual(layout.gallery.minX, 0)
        XCTAssertEqual(layout.gallery.width, 393)
        XCTAssertEqual(layout.dots, CGRect(x: 136.5, y: layout.pager.maxY + 24, width: 120, height: 26))
    }

    /// Nothing moves as the slides change: every title starts where the
    /// others do, and every line under the tallest title's room, even
    /// under a shorter title.
    func testEverySlidesWordsStartWhereTheOthersDo() {
        let layout = layout(slides: slides([(1, 2), (2, 1), (1, 1), (2, 2)]))
        XCTAssertEqual(layout.art, CGRect(x: 148.5, y: 0, width: 96, height: 96))
        XCTAssertEqual(layout.mark.width, 96 * 0.8, accuracy: 0.001)
        XCTAssertEqual(layout.mark.midX, layout.art.midX, accuracy: 0.001)
        XCTAssertEqual(layout.mark.midY, layout.art.midY, accuracy: 0.001)
        // The liquid metal cloud's square is 1.3 times the art's, on its centre.
        XCTAssertEqual(layout.metal.width, 124.8, accuracy: 0.001)
        XCTAssertEqual(layout.metal.height, 124.8, accuracy: 0.001)
        XCTAssertEqual(layout.metal.midX, layout.art.midX, accuracy: 0.001)
        XCTAssertEqual(layout.metal.midY, layout.art.midY, accuracy: 0.001)
        XCTAssertEqual(Set(layout.titles.map(\.minY)), [120])
        XCTAssertEqual(Set(layout.bodies.map(\.minY)), [120 + 68 + 8])
        for (title, body) in zip(layout.titles, layout.bodies) {
            XCTAssertEqual(title.minX, 24)
            XCTAssertEqual(title.width, 345)
            XCTAssertEqual(body.width, 345)
        }
        XCTAssertEqual(layout.titles[0].height, 34)
        XCTAssertEqual(layout.bodies[3].maxY, layout.pager.height)
        // The room is the tallest title's and the tallest line's, though no one slide has both.
        let mixed = self.layout(slides: slides([(1, 2), (2, 1)]))
        XCTAssertEqual(mixed.pager.height, 96 + 24 + 68 + 8 + 48)
    }

    func testPagesSitSideBySide() {
        let layout = layout()
        XCTAssertEqual(layout.page(2), CGRect(x: 786, y: 0, width: 393, height: layout.pager.height))
        XCTAssertEqual(layout.pagerContent(count: 4), CGSize(width: 1572, height: layout.pager.height))
        XCTAssertEqual(layout.pageShowing(offset: 0, count: 4), 0)
        XCTAssertEqual(layout.pageShowing(offset: 393 * 1.4, count: 4), 1)
        XCTAssertEqual(layout.pageShowing(offset: 393 * 1.6, count: 4), 2)
        XCTAssertEqual(layout.pageShowing(offset: 393 * 9, count: 4), 3)
        XCTAssertEqual(layout.pageShowing(offset: -50, count: 4), 0)
    }

    /// A tablet: the art grows to 128 and the words keep to a 440 column.
    func testATabletGivesTheArtMoreRoomAndCapsTheColumn() {
        let layout = layout(size: CGSize(width: 1024, height: 1366), safeArea: LayoutInsets(top: 24, left: 0, bottom: 20, right: 0))
        XCTAssertEqual(layout.art.size, CGSize(width: 128, height: 128))
        XCTAssertEqual(layout.art.midX, 512)
        XCTAssertEqual(layout.titles[0], CGRect(x: (1024 - 440) / 2, y: 128 + 24, width: 440, height: 34))
        XCTAssertEqual(layout.button.midX, 512)
        XCTAssertEqual(layout.contentHeight, 1366 - 24 - 20)
    }

    /// A phone on its side: smaller art and gaps, and it scrolls only if
    /// even that doesn't fit.
    func testAShortWindowShrinksTheArt() {
        let landscape = layout(size: CGSize(width: 852, height: 393), safeArea: LayoutInsets(top: 0, left: 59, bottom: 21, right: 59))
        XCTAssertEqual(landscape.art.size, CGSize(width: 56, height: 56))
        XCTAssertEqual(landscape.titles[0].minY, 56 + 16)
        XCTAssertEqual(landscape.dots.minY, landscape.pager.maxY + 12)
        XCTAssertEqual(landscape.gallery.minX, 59)
        XCTAssertEqual(landscape.gallery.width, 852 - 118)
    }

    func testTooTallItScrollsWithNothingFree() {
        let layout = layout(size: CGSize(width: 393, height: 300), button: CGSize(width: 120, height: 180))
        XCTAssertEqual(layout.gallery.minY, 59 + 52 + 16, accuracy: 0.001)
        XCTAssertEqual(layout.button.minY, layout.gallery.maxY + 16, accuracy: 0.001)
        XCTAssertEqual(layout.contentHeight, 52 + 16 + layout.gallery.height + 16 + 180 + 48, accuracy: 0.001)
    }

    func testNoSlidesLeaveTheArtAndDotsAlone() {
        let layout = StartLayout(size: phone, safeArea: safe, button: CGSize(width: 120, height: 56))
        XCTAssertEqual(layout.titles, [])
        XCTAssertEqual(layout.pager.height, 96 + 24)
        XCTAssertEqual(layout.dots.size, .zero)
    }
}
