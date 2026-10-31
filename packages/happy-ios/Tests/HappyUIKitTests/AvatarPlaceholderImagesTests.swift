#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The placeholders as the app reads them: every one in HappyUI's bundle,
/// decodable, and decoded at the size it is drawn.
@MainActor
final class AvatarPlaceholderImagesTests: XCTestCase {
    func testTheBundleHoldsEveryPlaceholder() throws {
        for name in AvatarPlaceholder.names {
            let url = try XCTUnwrap(AvatarPlaceholderImages.url(name), "\(name) is not in the bundle")
            let image = try XCTUnwrap(AvatarPlaceholderImages.decode(url, pixels: AvatarPlaceholderImages.maxPixels, scale: 3, monochrome: false), "\(name) does not decode")
            XCTAssertEqual(image.cgImage?.width, 384, name)
            XCTAssertEqual(image.cgImage?.height, 384, name)
        }
        XCTAssertNotNil(Bundle.module.url(forResource: "LICENSE-craftedstudios-shaders", withExtension: "txt"), "the shaders' MIT notice ships with them")
    }

    func testDecodedAtTheSizeDrawnAndKept() async throws {
        let decoded = await AvatarPlaceholderImages.image(seed: "account-1", side: 28, scale: 3)
        let image = try XCTUnwrap(decoded)
        XCTAssertEqual(image.size, CGSize(width: 28, height: 28))
        XCTAssertEqual(image.scale, 3)
        XCTAssertEqual(image.cgImage?.width, 84)
        XCTAssertTrue(AvatarPlaceholderImages.cached(seed: "account-1", side: 28, scale: 3) === image)
        // Another seed on the same picture shares it.
        let twin = try XCTUnwrap((0..<10_000).map { "twin-\($0)" }.first { AvatarPlaceholder.index(seed: $0) == AvatarPlaceholder.index(seed: "account-1") })
        let shared = await AvatarPlaceholderImages.image(seed: twin, side: 28, scale: 3)
        XCTAssertTrue(shared === image)
        // The largest is the bundled size.
        let largest = await AvatarPlaceholderImages.image(seed: "account-1", side: 200, scale: 3)
        let large = try XCTUnwrap(largest)
        XCTAssertEqual(large.cgImage?.width, 384)
    }

    func testPendingIsAnEmptyCircleTheSameSize() {
        let pending = AvatarPlaceholderImages.pending(side: 28)
        XCTAssertEqual(pending.size, CGSize(width: 28, height: 28))
        XCTAssertEqual(pending.renderingMode, .alwaysOriginal)
        XCTAssertFalse(pending.isSymbolImage)
    }
}
#endif
