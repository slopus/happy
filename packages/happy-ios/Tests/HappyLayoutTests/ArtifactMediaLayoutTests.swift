import Foundation
import HappyLayout
import XCTest

final class ArtifactMediaLayoutTests: XCTestCase {
    /// A phone in portrait under its navigation bar.
    private let size = CGSize(width: 393, height: 852)
    private let safeArea = LayoutInsets(top: 103, bottom: 34)

    private func picture(_ width: CGFloat, _ height: CGFloat) -> MediaLayout.Item {
        MediaLayout.Item(isVideo: false, image: MediaFlow.Image(width: width, height: height))
    }

    private func assertEqual(_ a: CGRect?, _ b: CGRect?, file: StaticString = #filePath, line: UInt = #line) {
        guard let a, let b else { return XCTAssertEqual(a, b, file: file, line: line) }
        for (x, y) in [(a.minX, b.minX), (a.minY, b.minY), (a.width, b.width), (a.height, b.height)] {
            XCTAssertEqual(x, y, accuracy: 0.0001, "\(a) != \(b)", file: file, line: line)
        }
    }

    func testOnePictureFillsTheWidthCentred() {
        let layout = ArtifactMediaLayout(size: size, safeArea: safeArea, items: [picture(1200, 800)], count: CGSize(width: 80, height: 18), badges: [nil])
        XCTAssertNil(layout.count)
        XCTAssertEqual(layout.tiles, [CGRect(x: 16, y: 340, width: 361, height: 241)])
        XCTAssertEqual(layout.badges, [nil])
        XCTAssertEqual(layout.contentSize, size)
    }

    func testOneSmallPictureKeepsItsSize() {
        let layout = ArtifactMediaLayout(size: size, safeArea: safeArea, items: [picture(200, 100)], count: nil, badges: [])
        XCTAssertEqual(layout.tiles, [CGRect(x: 97, y: 411, width: 200, height: 100)])
    }

    func testOneTallPictureFitsTheHeight() {
        let layout = ArtifactMediaLayout(size: size, safeArea: safeArea, items: [picture(1000, 4000)], count: nil, badges: [])
        // 683 tall at most: 1000 × 4000 scaled by 683 / 4000.
        XCTAssertEqual(layout.tiles, [CGRect(x: 111, y: 119, width: 171, height: 683)])
    }

    func testOneVideoOfUnknownSizeIsWideWithItsDuration() {
        let video = MediaLayout.Item(isVideo: true, image: MediaFlow.Image())
        let layout = ArtifactMediaLayout(size: size, safeArea: safeArea, items: [video], count: nil, badges: [30])
        XCTAssertEqual(layout.tiles, [CGRect(x: 16, y: 359, width: 361, height: 203)])
        XCTAssertEqual(layout.badges, [CGRect(x: 22, y: 536, width: 42, height: 20)])
    }

    func testFourPicturesFallIntoTwoRowsUnderTheirCount() {
        let items = Array(repeating: picture(1600, 1200), count: 4)
        let layout = ArtifactMediaLayout(size: size, safeArea: safeArea, items: items, count: CGSize(width: 80, height: 18), badges: [nil, nil, nil, nil])
        XCTAssertEqual(layout.count, CGRect(x: 16, y: 119, width: 80, height: 18))
        // Justified rows of two: (361 − 8) / (4/3 + 4/3) tall each.
        let height: CGFloat = 132.375
        let width: CGFloat = 176.5
        assertEqual(layout.tiles[0], CGRect(x: 16, y: 149, width: width, height: height))
        assertEqual(layout.tiles[1], CGRect(x: 200.5, y: 149, width: width, height: height))
        assertEqual(layout.tiles[2], CGRect(x: 16, y: 289.375, width: width, height: height))
        assertEqual(layout.tiles[3], CGRect(x: 200.5, y: 289.375, width: width, height: height))
        XCTAssertEqual(layout.contentSize.width, 393)
        XCTAssertEqual(layout.contentSize.height, 149 + 272.75 + 16 + 34, accuracy: 0.0001)
        XCTAssertEqual(layout.badges, [nil, nil, nil, nil])
    }

    func testAPillNeverOutgrowsItsTile() {
        let items = [picture(100, 100), MediaLayout.Item(isVideo: true, image: MediaFlow.Image(width: 40, height: 40))]
        let layout = ArtifactMediaLayout(size: size, safeArea: safeArea, items: items, count: CGSize(width: 80, height: 18), badges: [nil, 60])
        let tile = layout.tiles[1]
        XCTAssertEqual(layout.badges[1], CGRect(x: tile.minX + 6, y: tile.maxY - 26, width: 28, height: 20))
    }

    func testSpinnerInTheMiddleOfTheSafeArea() {
        XCTAssertEqual(ArtifactMediaLayout.spinner(size: size, safeArea: safeArea), CGRect(x: 187, y: 451, width: 20, height: 20))
    }

    func testViewerControlsAndPlayer() {
        let layout = PictureViewerLayout(size: size, safeArea: LayoutInsets(top: 59, bottom: 34), picture: .zero)
        XCTAssertEqual(layout.close, CGRect(x: 341, y: 67, width: 44, height: 44))
        XCTAssertEqual(layout.share, CGRect(x: 8, y: 67, width: 44, height: 44))
        XCTAssertEqual(layout.player, CGRect(x: 0, y: 119, width: 393, height: 699))
    }

    func testDocumentPictureInItsOwnShape() {
        let large = MarkdownLayout(width: 361, blocks: [.picture(caption: nil, size: CGSize(width: 1200, height: 800))])
        XCTAssertEqual(large.blocks, [.image(frame: CGRect(x: 0, y: 8, width: 361, height: 241), picture: CGRect(x: 0, y: 0, width: 361, height: 241), caption: nil)])
        XCTAssertEqual(large.size, CGSize(width: 361, height: 257))

        let small = MarkdownLayout(width: 361, blocks: [.picture(caption: .fixed(width: 50, height: 20), size: CGSize(width: 100, height: 50))], gap: 8)
        XCTAssertEqual(small.blocks, [.image(frame: CGRect(x: 0, y: 0, width: 100, height: 78), picture: CGRect(x: 0, y: 0, width: 100, height: 50), caption: CGRect(x: 0, y: 58, width: 100, height: 20))])

        let unknown = MarkdownLayout(width: 361, blocks: [.picture(caption: nil, size: nil)], gap: 8)
        XCTAssertEqual(unknown.blocks, [.image(frame: CGRect(x: 0, y: 0, width: 361, height: 271), picture: CGRect(x: 0, y: 0, width: 361, height: 271), caption: nil)])
        XCTAssertEqual(MarkdownLayout.naturalWidth(of: [.picture(caption: nil, size: CGSize(width: 100, height: 50))], available: 361), 100)
    }
}
