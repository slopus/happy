#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

@MainActor
final class DirectIdentityViewTests: XCTestCase {
    func testMeasuredPairingContentAtPhoneAndTabletWidths() {
        Fonts.registerBundledFonts()
        for width: CGFloat in [272, 345, 432, 720] {
            let content = DirectIdentityView()
            content.heading.string = "A computer with a long name that wraps"
            content.body.string = "Compare these four emoji with the computer. Continue only when all four match. Confirm on both screens."
            content.emoji.string = "🌀  👗  ⏳  👟"
            let size = content.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
            content.frame = CGRect(origin: .zero, size: size); content.layoutIfNeeded()
            let layout = content.layout(width)
            for (actual, expected) in [(content.heading.frame, layout.title), (content.body.frame, layout.body), (content.emoji.frame, layout.emoji)] {
                XCTAssertEqual(actual.minX, expected.minX, accuracy: 0.001)
                XCTAssertEqual(actual.minY, expected.minY, accuracy: 0.001)
                XCTAssertEqual(actual.width, expected.width, accuracy: 0.001)
                XCTAssertEqual(actual.height, expected.height, accuracy: 0.001)
            }
            XCTAssertGreaterThanOrEqual(content.body.frame.minY + 0.001, content.heading.frame.maxY + 12)
            XCTAssertGreaterThanOrEqual(content.emoji.frame.minY + 0.001, content.body.frame.maxY + 20)
            XCTAssertLessThanOrEqual(content.emoji.frame.maxY, size.height)
        }
    }
    func testHomeLogoAndAvatarUseMeasuredHeaderSlots() {
        let header = HomeHeaderView()
        header.frame = CGRect(x: 0, y: 0, width: 390, height: 111)
        header.layoutIfNeeded()
        XCTAssertEqual(header.logo.frame.width, 19)
        header.showsAccountAvatar = true; header.layoutIfNeeded()
        XCTAssertEqual(header.logo.frame.width, 32)
        XCTAssertEqual(header.logo.layer.cornerRadius, 16)
    }
    func testVerificationUsesEmojiFaceAndReadableSize() {
        let label = PairingEmojiLabel()
        label.string = "🐟  🚤  🐻  🍒"
        XCTAssertEqual(label.text, label.string)
        XCTAssertEqual(label.font.fontName, "AppleColorEmoji")
        XCTAssertEqual(label.font.pointSize, 36)
        XCTAssertGreaterThan(label.sizeThatFits(CGSize(width: 320, height: 100)).height, 30)
        label.string = "🐟 🚤 🐻 🍒"
        XCTAssertLessThan(label.sizeThatFits(CGSize(width: 345, height: 100)).height, 60)
    }
}
#endif