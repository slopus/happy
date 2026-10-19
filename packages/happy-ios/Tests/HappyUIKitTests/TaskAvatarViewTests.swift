#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A task wears a checkbox on the bot's plain disc: no generated face, no
/// photo, no harness badge, in every list and the chat's header.
@MainActor
final class TaskAvatarViewTests: XCTestCase {
    func testATaskWearsItsGlyphNotAFace() {
        for style in [AvatarStyle.brutalist, .gradient, .pixelated] {
            let view = AvatarView(frame: CGRect(x: 0, y: 0, width: 48, height: 48))
            view.content = .init(avatar: SessionAvatar(seed: "m1:task:a", isTask: true, harness: .rig), style: style, monochrome: false)
            view.layoutIfNeeded()
            XCTAssertNotNil(view.glyph.image, "\(style)")
            XCTAssertEqual(view.glyph.contentMode, .center, "the drawn glyph, not a face image")
            let traits = view.traitCollection
            XCTAssertEqual(view.disc.backgroundColor?.resolvedColor(with: traits), UIColor(Palette.surface).resolvedColor(with: traits))
            XCTAssertTrue(view.pixels.isHidden)
            XCTAssertTrue(view.badge.isHidden)
            XCTAssertNil(view.photo.image)
        }
    }
}
#endif
