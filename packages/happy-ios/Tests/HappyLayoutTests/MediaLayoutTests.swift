import CoreGraphics
@testable import HappyLayout
import XCTest

/// Desktop's mediaLayout.test.tsx cases, and the phone's own frames.
final class MediaLayoutTests: XCTestCase {
    typealias Flow = MediaFlow

    private func image(_ width: CGFloat, _ height: CGFloat, scale: CGFloat? = nil) -> Flow.Image {
        Flow.Image(width: width, height: height, scale: scale)
    }

    private lazy var wide = image(1440, 900)
    private lazy var flat = image(1400, 200)
    private lazy var narrow = image(300, 900)
    private lazy var square = image(1024, 1024)
    private lazy var portrait = image(1024, 1536)
    private lazy var page = image(1440, 7200)

    private func near(_ actual: CGFloat, _ expected: CGFloat, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertLessThan(abs(actual - expected), 0.01, "\(label): \(actual) vs \(expected)", file: file, line: line)
    }

    private func frames(_ plan: Flow.Plan, _ measure: CGFloat) -> [CGRect] {
        let geometry = Flow.geometry(plan, measure: measure)
        return geometry.frames.keys.sorted().map { geometry.frames[$0]! }
    }

    func testTwoColumnsKeepEveryShape() {
        let plan = Flow.columnsPlan([wide, flat, narrow, wide], columns: 2)
        let geometry = Flow.geometry(plan, measure: 720)
        let tiles = frames(plan, 720)
        let column: CGFloat = (720 - 8) / 2
        near(tiles[0].width, column, "wide fills its column")
        near(tiles[0].height, column / 1.6, "wide keeps 16:10")
        near(tiles[1].minX, column + 8, "second column after the gap")
        near(tiles[1].height, column / 7, "the strip whole")
        near(tiles[2].width, 160, "narrow narrows to the cap")
        near(tiles[2].height, 480, "narrow capped")
        near(tiles[2].minY, tiles[0].height + 8, "second row under the taller")
        near(tiles[3].minY, tiles[2].minY, "a row shares its top")
        near(geometry.height, column / 1.6 + 8 + 480, "grid height")
    }

    func testAPageCaptureLetterboxes() {
        let tile = frames(Flow.columnsPlan([page], columns: 2), 720)[0]
        near(tile.height, 480, "capped")
        near(tile.width, 160, "held at the minimum width")
    }

    func testOneColumnNeverPastItsOwnPixels() {
        let tiles = frames(Flow.columnsPlan([wide, square, portrait, image(120, 80)], columns: 1), 720)
        near(tiles[0].width, 720, "landscape fills")
        near(tiles[1].width, 640, "square to the 640 cap")
        near(tiles[2].height, 640, "portrait capped")
        near(tiles[2].width, 640 / 1.5, "portrait keeps its shape")
        near(tiles[3].width, 120, "a small picture is not blown up")
    }

    func testDensity() {
        let retina = image(1040, 720, scale: 2)
        near(frames(Flow.columnsPlan([retina], columns: 1), 900)[0].width, 520, "one column stops at 520")
        near(frames(Flow.justifiedPlan([retina]), 900)[0].width, 520, "alone at its point size")
        near(frames(Flow.columnsPlan([image(2880, 1800, scale: 2)], columns: 1), 720)[0].width, 720, "a wider capture fills")
        near(Flow.geometry(Flow.justifiedPlan([retina, retina]), measure: 1400).height, 360, "row capped at its point height")
    }

    func testJustifiedRows() {
        let connect = image(3680, 2392)
        let profile = image(3456, 2168)
        let pair = Flow.justifiedPlan([connect, profile])
        XCTAssertEqual(pair.rows.count, 1)
        let tiles = frames(pair, 720)
        near(tiles[0].height, tiles[1].height, "one height")
        near(tiles[0].width + 8 + tiles[1].width, 720, "fills the measure")

        let extremes = Flow.justifiedPlan([wide, flat, square, narrow, portrait])
        XCTAssertEqual(extremes.rows.count, 5)
        near(frames(extremes, 720)[1].width, 720, "the strip spans the measure")

        let many = [wide, square, portrait, wide, square, wide, portrait, square, wide]
        let plan = Flow.justifiedPlan(many)
        let geometry = Flow.geometry(plan, measure: 720)
        var order: [Int] = []
        for row in plan.rows {
            guard case .justified(_, let tiles) = row else { return XCTFail("a justified row") }
            XCTAssertLessThanOrEqual(tiles.count, 4)
            order += tiles.map(\.index)
            near(geometry.frames[tiles.last!.index]!.maxX, 720, "ends at the measure")
        }
        XCTAssertEqual(order, Array(0..<9))

        let small = frames(Flow.justifiedPlan([image(100, 100), image(150, 100)]), 720)
        near(small[0].height, 100, "held at their own height")
        near(small[1].width, 150, "second at its own width")
        XCTAssertEqual(frames(Flow.justifiedPlan([image(300, 200)]), 720), [CGRect(x: 0, y: 0, width: 300, height: 200)])
    }

    func testRecordingsFollowThePicturesAtTheirBox() {
        XCTAssertEqual(Flow.videoBox(width: nil, height: nil), CGSize(width: 380, height: 214))
        XCTAssertEqual(Flow.videoBox(width: 1920, height: 1080), CGSize(width: 380, height: 214))
        XCTAssertEqual(Flow.videoBox(width: 1080, height: 1920), CGSize(width: 240, height: 320))
        XCTAssertEqual(Flow.videoBox(width: 320, height: 240), CGSize(width: 320, height: 240))

        // A phone's 358: a picture, then a 16:9 recording scaled to fit.
        let items = [
            MediaLayout.Item(isVideo: true, image: image(1920, 1080)),
            MediaLayout.Item(isVideo: false, image: image(600, 400)),
        ]
        let layout = MediaLayout(width: 358, items: items, columns: 0)
        let picture: CGFloat = 358 / 1.5
        XCTAssertEqual(layout.frames, [
            CGRect(x: 0, y: picture + 8, width: 358, height: 202),
            CGRect(x: 0, y: 0, width: 358, height: picture),
        ])
        XCTAssertEqual(layout.size, CGSize(width: 358, height: picture + 8 + 202))
    }

    func testAnAgentsPictureSitsUnderItsText() {
        let layout = MessageLayout.agent(width: 390, parts: [
            .markdown([.text(block(height: 24))]),
            .media([MediaLayout.Item(isVideo: false, image: image(300, 200))], columns: 0),
        ])
        guard layout.parts.count == 2, case .media(let frames) = layout.parts[1] else { return XCTFail("two parts") }
        XCTAssertEqual(frames, [CGRect(x: 16, y: 40, width: 300, height: 200)])
        XCTAssertEqual(layout.size, CGSize(width: 390, height: 248))
    }

    func testAPersonsPhotosHugTheRightUnderTheBubble() {
        let layout = MessageLayout.user(width: 390, text: .fixed(width: 40, height: 20), pictures: [image(4032, 3024)], showsStatus: false)
        XCTAssertEqual(layout.bubble, CGRect(x: 310, y: 8, width: 64, height: 40))
        // 36 clear at the left leaves 338: the photo fills it at 4:3.
        XCTAssertEqual(layout.pictures, [CGRect(x: 36, y: 56, width: 338, height: 253.5)])
        XCTAssertEqual(layout.size.height, 317.5)

        let alone = MessageLayout.user(width: 390, text: nil, pictures: [image(100, 200), image(100, 200)], showsStatus: false)
        XCTAssertNil(alone.bubble)
        // Justified at their own 200 height, pushed to the right edge.
        XCTAssertEqual(alone.pictures, [CGRect(x: 166, y: 8, width: 100, height: 200), CGRect(x: 274, y: 8, width: 100, height: 200)])
        XCTAssertEqual(alone.size.height, 216)
    }

    func testAPlayButtonSitsInTheMiddleOfItsTile() {
        XCTAssertEqual(MediaFlow.playButton(in: CGSize(width: 380, height: 214)), CGRect(x: 166, y: 83, width: 48, height: 48))
        XCTAssertEqual(MediaFlow.playButton(in: CGSize(width: 161, height: 161)), CGRect(x: 57, y: 57, width: 48, height: 48))
    }
}
