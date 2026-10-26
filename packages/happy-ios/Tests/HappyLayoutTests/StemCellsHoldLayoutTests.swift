import XCTest
@testable import HappyLayout

final class StemCellsHoldLayoutTests: XCTestCase {
    private let menuTitles: [[CGFloat]] = [[40, 90, 95], [70, 90]]

    func testTheMenuIsTelegramsActionStack() {
        let menu = StemCellsHoldLayout.Menu(titles: menuTitles, titleHeight: 20.3)
        // 95 + 18 + 32 + 20 + 8 is narrower than the least, 220.
        XCTAssertEqual(menu.size, CGSize(width: 220, height: 255))
        XCTAssertEqual(menu.corner, 30)
        XCTAssertEqual(menu.items[0][0], .init(frame: CGRect(x: 0, y: 10, width: 220, height: 43), icon: CGRect(x: 24, y: 19, width: 24, height: 24), title: CGRect(x: 60, y: 21, width: 40, height: 21)))
        XCTAssertEqual(menu.items[0][2].frame.maxY, 139)
        XCTAssertEqual(menu.separators, [CGRect(x: 18, y: 148, width: 184, height: 1)])
        XCTAssertEqual(menu.items[1][0].frame, CGRect(x: 0, y: 159, width: 220, height: 43))
    }

    func testALongTitleWidensTheMenuToAtMost240AndIsCut() {
        let menu = StemCellsHoldLayout.Menu(titles: [[200]], titleHeight: 20)
        XCTAssertEqual(menu.size.width, 240)
        XCTAssertEqual(menu.items[0][0].title.width, 162)
        XCTAssertEqual(menu.size.height, 62)
        XCTAssertEqual(menu.corner, 30)
    }

    func testThePreviewAndMenuRestOnTheFootWhenCentringWouldOverrunIt() {
        let layout = StemCellsHoldLayout(screen: CGSize(width: 402, height: 874), top: 62, bottom: 34, source: CGRect(x: 6, y: 343, width: 390, height: 32), card: CGSize(width: 378, height: 460), menu: CGSize(width: 220, height: 255))
        XCTAssertEqual(layout.card, CGRect(x: 12, y: 105, width: 378, height: 460))
        XCTAssertEqual(layout.menu, CGRect(x: 170, y: 575, width: 220, height: 255))
    }

    func testAShortScreenTakesHeightFromThePreview() {
        let layout = StemCellsHoldLayout(screen: CGSize(width: 375, height: 667), top: 20, bottom: 0, source: CGRect(x: 6, y: 300, width: 363, height: 32), card: CGSize(width: 351, height: 460), menu: CGSize(width: 220, height: 255))
        XCTAssertEqual(layout.card, CGRect(x: 12, y: 28, width: 351, height: 364))
        XCTAssertEqual(layout.menu, CGRect(x: 143, y: 402, width: 220, height: 255))
    }

    func testARowWithoutAPreviewKeepsItsPlaceWithTheMenuUnderOrOverIt() {
        let screen = CGSize(width: 402, height: 874)
        let under = StemCellsHoldLayout(screen: screen, top: 62, bottom: 34, source: CGRect(x: 6, y: 343, width: 390, height: 32), card: nil, menu: CGSize(width: 220, height: 150))
        XCTAssertEqual(under.card, CGRect(x: 6, y: 343, width: 390, height: 32))
        XCTAssertEqual(under.menu, CGRect(x: 170, y: 385, width: 220, height: 150))
        let over = StemCellsHoldLayout(screen: screen, top: 62, bottom: 34, source: CGRect(x: 6, y: 800, width: 390, height: 32), card: nil, menu: CGSize(width: 220, height: 150))
        XCTAssertEqual(over.menu, CGRect(x: 170, y: 640, width: 220, height: 150))
    }
}
