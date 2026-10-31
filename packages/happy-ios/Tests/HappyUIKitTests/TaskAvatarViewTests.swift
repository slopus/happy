#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A task, a bot or a session without a picture wears the placeholder its
/// seed picks, whatever avatar style is set. A task still has no harness
/// badge, in every list and the chat's header.
@MainActor
final class TaskAvatarViewTests: XCTestCase {
    private func shown(_ avatar: SessionAvatar, style: AvatarStyle, monochrome: Bool = false) async throws -> AvatarView {
        let view = AvatarView(frame: CGRect(x: 0, y: 0, width: 48, height: 48))
        view.content = .init(avatar: avatar, style: style, monochrome: monochrome)
        view.layoutIfNeeded()
        let deadline = ContinuousClock.now + .seconds(5)
        while view.glyph.image == nil, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        return view
    }

    func testATaskWearsItsPlaceholderAndNoBadge() async throws {
        let expected = await AvatarPlaceholderImages.image(seed: "m1:task:a", side: 48)
        for style in [AvatarStyle.brutalist, .gradient, .pixelated] {
            let view = try await shown(SessionAvatar(seed: "m1:task:a", isTask: true, harness: .rig), style: style)
            XCTAssertNotNil(view.glyph.image, "\(style)")
            XCTAssertTrue(view.glyph.image === expected, "the seed's placeholder whatever the style (\(style))")
            XCTAssertEqual(view.glyph.contentMode, .scaleAspectFill)
            XCTAssertEqual(view.glyph.frame, view.disc.bounds, "it fills the disc")
            XCTAssertTrue(view.badge.isHidden)
            XCTAssertNil(view.photo.image)
        }
    }

    func testABotAndASessionWearTheirOwn() async throws {
        let bot = try await shown(SessionAvatar(seed: "m1:bot:b", isBot: true), style: .brutalist)
        let session = try await shown(SessionAvatar(seed: "m1:/Users/steve/happy", harness: .claude), style: .gradient)
        let botImage = await AvatarPlaceholderImages.image(seed: "m1:bot:b", side: 48)
        let sessionImage = await AvatarPlaceholderImages.image(seed: "m1:/Users/steve/happy", side: 48)
        XCTAssertTrue(bot.glyph.image === botImage)
        XCTAssertTrue(session.glyph.image === sessionImage)
        XCTAssertFalse(session.badge.isHidden, "a session keeps its harness badge")
    }

    /// Black & White Avatars drains the placeholder of colour.
    func testMonochromeIsGrey() async throws {
        let view = try await shown(SessionAvatar(seed: "monochrome"), style: .brutalist, monochrome: true)
        let image = try XCTUnwrap(view.glyph.image?.cgImage)
        XCTAssertEqual(image.colorSpace?.model, .monochrome)
    }
}
#endif
