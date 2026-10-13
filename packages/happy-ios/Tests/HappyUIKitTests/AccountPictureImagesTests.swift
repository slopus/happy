#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Profile pictures and thumbhashes as images, per account. The cache's
/// fetching, files and closing are covered on Linux by AccountPicturesTests.
@MainActor
final class AccountPictureImagesTests: XCTestCase {
    private let url = URL(string: "https://example.com/avatar.png")!

    private func png(width: CGFloat, height: CGFloat) -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).pngData { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    private func pictures(_ owner: String, serving data: Data?) -> AccountPictures {
        AccountPictures(owner: owner, directory: nil) { _, _ in data }
    }

    func testAPictureIsDecodedNoLargerThanItIsDrawn() throws {
        let decoded = try XCTUnwrap(AccountPictureImages.decode(png(width: 1000, height: 500)))
        let image = try XCTUnwrap((decoded.picture as? UIImage)?.cgImage)
        XCTAssertEqual(AccountPictureImages.maxPixelSize, Int(SettingsProfileHeaderLayout.Metrics.avatarSize * 3))
        XCTAssertEqual(image.width, 270)
        XCTAssertEqual(image.height, 135)
        XCTAssertEqual(decoded.cost, image.bytesPerRow * image.height)
    }

    func testBytesThatAreNoPictureAreNothing() {
        XCTAssertNil(AccountPictureImages.decode(Data("not a picture".utf8)))
    }

    func testAThumbhashIsItsPixels() throws {
        let decoded = try XCTUnwrap(AccountPictureImages.placeholder("HwgKPJxwd3dweHiHiHdwgAf3iA"))
        let image = try XCTUnwrap((decoded.picture as? UIImage)?.cgImage)
        XCTAssertEqual(image.width, 32)
        XCTAssertEqual(image.height, 18)
        XCTAssertEqual(decoded.cost, 32 * 18 * 4)
        XCTAssertNil(AccountPictureImages.placeholder("not base64!"))
    }

    func testAViewShowsOnlyItsAccountsPicture() async throws {
        let first = pictures("a", serving: png(width: 10, height: 10))
        let second = pictures("b", serving: nil)
        let loaded = await first.image(url)
        let picture = try XCTUnwrap(loaded)

        let view = RemoteImageView(size: 90)
        view.show(url, thumbhash: nil, from: second)
        XCTAssertFalse(view.isHidden)
        XCTAssertNil(view.image, "the same URL in another account is not its picture")

        view.show(url, thumbhash: nil, from: first)
        XCTAssertTrue(view.image === picture, "kept: shown at once")

        view.show(nil, thumbhash: nil, from: first)
        XCTAssertTrue(view.isHidden)
        XCTAssertNil(view.image)
    }
}
#endif
