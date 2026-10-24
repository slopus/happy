import CoreGraphics
@testable import HappyLayout
import XCTest

/// A tree layout's exact frames at a phone's reading column.
final class StemCellMediaTreeLayoutTests: XCTestCase {
    typealias Tree = StemCellMediaTreeLayout

    /// A 2× capture of 1600 × 1000: 800 × 500 points.
    let shot = Tree.Item(isCard: false, ratio: 1.6, natural: CGSize(width: 800, height: 500))

    func item(_ index: Int, _ css: [String: String] = [:], _ item: Tree.Item? = nil) -> Tree.Box {
        .item(index: index, Tree.Style(css), item ?? shot)
    }

    func testAGridSharesItsWidthByItsTracks() {
        let tree = Tree(width: 361, root: [
            .container(Tree.Style(["display": "grid", "gridTemplateColumns": "1fr 1fr", "gap": "8px"]), [item(0), item(1), item(2)]),
        ])
        XCTAssertEqual(tree.items[0], CGRect(x: 0, y: 0, width: 176.5, height: 110.3125))
        XCTAssertEqual(tree.items[1], CGRect(x: 184.5, y: 0, width: 176.5, height: 110.3125))
        XCTAssertEqual(tree.items[2], CGRect(x: 0, y: 118.3125, width: 176.5, height: 110.3125))
        XCTAssertEqual(tree.size, CGSize(width: 361, height: 228.625))
    }

    func testTracksMixLengthsSharesAndRepeats() {
        XCTAssertEqual(Tree.tracks(["100px", "3fr", "1fr"], width: 316, gap: 8, count: 3), [100, 150, 50])
        XCTAssertEqual(Tree.tracks(["repeat(3, 1fr)"], width: 316, gap: 8, count: 3), [100, 100, 100])
        // At 361 a 200 minimum fits once; at 720, three times.
        XCTAssertEqual(Tree.tracks(["repeat(auto-fill, minmax(200px, 1fr))"], width: 361, gap: 8, count: 4), [361])
        XCTAssertEqual(Tree.tracks(["repeat(auto-fill, minmax(200px, 1fr))"], width: 720, gap: 8, count: 4).count, 3)
        // `auto-fit` keeps only the tracks its two items fill.
        XCTAssertEqual(Tree.tracks(["repeat(auto-fit, minmax(100px, 1fr))"], width: 720, gap: 8, count: 2), [356, 356])
        XCTAssertEqual(Tree.tracks(["minmax(200px, 1fr)", "1fr"], width: 300, gap: 0, count: 2), [200, 100])
    }

    func testAnItemKeepsItsNaturalSizeShrinksAndNeverGrows() {
        let small = Tree.Item(isCard: false, ratio: 2, natural: CGSize(width: 100, height: 50))
        let tall = Tree.Item(isCard: false, ratio: 0.2, natural: CGSize(width: 400, height: 2000))
        let tree = Tree(width: 361, root: [item(0, [:], small), item(1, [:], tall), item(2, ["width": "100%"], small), item(3, ["width": "50%", "aspectRatio": "1"])])
        XCTAssertEqual(tree.items[0], CGRect(x: 0, y: 0, width: 100, height: 50))
        // Past 640 tall it narrows to keep its shape.
        XCTAssertEqual(tree.items[1], CGRect(x: 0, y: 50, width: 128, height: 640))
        XCTAssertEqual(tree.items[2], CGRect(x: 0, y: 690, width: 361, height: 180.5))
        XCTAssertEqual(tree.items[3], CGRect(x: 0, y: 870.5, width: 180.5, height: 180.5))
    }

    func testAWrappingRowBreaksWhereItsBoxesNoLongerFit() {
        let row = Tree.Box.container(Tree.Style(["display": "flex", "flexWrap": "wrap", "gap": "12px"]), [
            item(0, ["width": "200px"]), item(1, ["width": "149px"]), item(2, ["width": "200px"]),
        ])
        let tree = Tree(width: 361, root: [row])
        XCTAssertEqual(tree.items[0], CGRect(x: 0, y: 0, width: 200, height: 125))
        XCTAssertEqual(tree.items[1], CGRect(x: 212, y: 0, width: 149, height: 93.125))
        XCTAssertEqual(tree.items[2], CGRect(x: 0, y: 137, width: 200, height: 125))
        XCTAssertEqual(tree.size.height, 262)
    }

    func testARowSharesFreeRoomByGrowAndCentresAcross() {
        let row = Tree.Box.container(Tree.Style(["display": "flex", "gap": "10px", "alignItems": "center"]), [
            item(0, ["flex": "1"]), item(1, ["flex": "1"]),
        ])
        let tree = Tree(width: 210, root: [row])
        XCTAssertEqual(tree.items[0], CGRect(x: 0, y: 0, width: 100, height: 62.5))
        XCTAssertEqual(tree.items[1], CGRect(x: 110, y: 0, width: 100, height: 62.5))
    }

    func testTextAndCardsTakeTheirRows() {
        let card = Tree.Item(isCard: true, ratio: 1, natural: nil)
        let figure = Tree.Box.container(Tree.Style(["padding": "8px 12px"]), [
            item(0),
            .text(id: 0, .fixed(width: 120, height: 20)),
            item(1, [:], card),
        ])
        let tree = Tree(width: 361, root: [figure])
        XCTAssertEqual(tree.items[0], CGRect(x: 12, y: 8, width: 337, height: 210.625))
        XCTAssertEqual(tree.texts[0], CGRect(x: 12, y: 218.625, width: 337, height: 20))
        XCTAssertEqual(tree.items[1], CGRect(x: 12, y: 238.625, width: 337, height: 64))
        XCTAssertEqual(tree.size.height, 310.625)
    }

    func testMarginsCollapseAndAutoCentres() {
        let small = Tree.Item(isCard: false, ratio: 1, natural: CGSize(width: 100, height: 100))
        let tree = Tree(width: 300, root: [
            item(0, ["marginBottom": "16px"], small),
            item(1, ["marginTop": "8px", "margin": "8px auto"], small),
        ])
        XCTAssertEqual(tree.items[0], CGRect(x: 0, y: 0, width: 100, height: 100))
        XCTAssertEqual(tree.items[1], CGRect(x: 100, y: 116, width: 100, height: 100))
    }

    func testATallLayoutIsCutAtItsCap() {
        let tall = Tree.Item(isCard: false, ratio: 0.5, natural: CGSize(width: 320, height: 640))
        let tree = Tree(width: 361, root: [item(0, [:], tall), item(1, [:], tall), item(2, [:], tall)])
        XCTAssertEqual(tree.size.height, 1200)
        XCTAssertEqual(tree.items[1], CGRect(x: 0, y: 640, width: 320, height: 560))
        XCTAssertNil(tree.items[2])
    }

    func testStylesReadTheirShorthands() {
        let style = Tree.Style(["flex": "2 0 120px", "gridColumn": "span 2", "padding": "4px 8px 12px", "gap": "8px 4px", "placeItems": "center end"])
        XCTAssertEqual(style.grow, 2)
        XCTAssertEqual(style.shrink, 0)
        XCTAssertEqual(style.basis, .px(120))
        XCTAssertEqual(style.columnSpan, 2)
        XCTAssertEqual(style.padding, [.px(4), .px(8), .px(12), .px(8)])
        XCTAssertEqual(style.rowGap, .px(8))
        XCTAssertEqual(style.columnGap, .px(4))
        XCTAssertEqual(style.alignItems, "center")
        XCTAssertEqual(style.justifyItems, "end")
        XCTAssertEqual(Tree.Style(["gridColumn": "2 / 4"]).columnStart, 1)
        XCTAssertEqual(Tree.Style(["gridColumn": "2 / 4"]).columnSpan, 2)
        XCTAssertEqual(Tree.Style(["aspectRatio": "16 / 9"]).aspectRatio, 16.0 / 9)
    }
}
