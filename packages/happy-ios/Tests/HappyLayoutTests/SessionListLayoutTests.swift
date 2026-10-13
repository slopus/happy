import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

final class FlatSessionRowLayoutTests: XCTestCase {
    private func row(
        width: CGFloat = 393,
        timestamp: String = "12:55",
        workspace: String? = "fix-login",
        divider: Bool = true
    ) -> FlatSessionRowLayout {
        FlatSessionRowLayout(.init(
            width: width,
            title: text("Fix the build", lineHeight: 22, maxLines: 1),
            timestamp: text(timestamp, lineHeight: 22, maxLines: 1),
            project: text("happy", lineHeight: 20, maxLines: 1),
            workspace: workspace.map { text($0, lineHeight: 18, maxLines: 1) },
            showsDivider: divider
        ))
    }

    func testRowGeometry() {
        let layout = row()
        assertSize(layout.size, CGSize(width: 393, height: 81))
        assertFrame(layout.avatar, rect(16, 10.5, 60, 60))
        // Corner slot: at least 56 wide; the stamp is right-aligned in it.
        assertFrame(layout.timestamp, rect(337, 10, 40, 22))
        assertFrame(layout.dot, rect(357, 11, 20, 20))
        assertFrame(layout.title, rect(88, 10, 225, 22))
        assertFrame(layout.project, rect(88, 32, 289, 20))
        assertFrame(layout.workspace, rect(88, 53, 72, 18))
        assertFrame(layout.branchIcon, rect(164, 55.5, 13, 13))
        assertFrame(layout.divider, rect(88, 80.67, 305, 0.33))
    }

    func testAWideStampSizesTheSlotAndTheTitleGivesWay() {
        let layout = row(timestamp: "12/17/25")
        assertFrame(layout.timestamp, rect(313, 10, 64, 22))
        assertFrame(layout.title, rect(88, 10, 217, 22))
    }

    func testThePrimaryCheckoutHasNoWorkspaceLineButKeepsItsHeight() {
        let layout = row(workspace: nil, divider: false)
        XCTAssertNil(layout.workspace)
        XCTAssertNil(layout.branchIcon)
        XCTAssertNil(layout.divider)
        XCTAssertEqual(layout.size.height, 81, "every row is the same height, so the list never jumps")
    }
}

final class SessionListChromeLayoutTests: XCTestCase {
    func testDayHeader() {
        let layout = SessionDayHeaderLayout(width: 393, label: text("Today", lineHeight: 18))
        assertFrame(layout.label, rect(16, 20, 361, 18))
        assertSize(layout.size, CGSize(width: 393, height: 46))
    }

    func testArchiveToggleCentresTheLabelBetweenHairlines() {
        let layout = ArchiveToggleLayout(width: 393, label: text("Show archived", lineHeight: 18))
        assertFrame(layout.leadingLine, rect(24, 32.835, 108.5, 0.33))
        assertFrame(layout.label, rect(144.5, 24, 104, 18))
        assertFrame(layout.trailingLine, rect(260.5, 32.835, 108.5, 0.33))
        assertSize(layout.size, CGSize(width: 393, height: 50))
    }

    func testNoSessionsIsCentredInTheSafeArea() {
        let layout = NoSessionsLayout(.init(
            size: phone,
            safeArea: phoneUnderBar,
            title: text("No sessions yet", lineHeight: 30),
            description: text("Start one on a connected machine.", lineHeight: 22),
            action: nil
        ))
        assertFrame(layout.icon, rect(168.5, 364.5, 56, 56))
        assertFrame(layout.title, rect(136.5, 440.5, 120, 30))
        assertFrame(layout.description, rect(64.5, 478.5, 264, 22))
        XCTAssertNil(layout.action)
    }

    func testNoSessionsWithAnAction() {
        let layout = NoSessionsLayout(.init(
            size: phone,
            safeArea: phoneUnderBar,
            title: text("No sessions yet", lineHeight: 30),
            description: text("Start one on a connected machine.", lineHeight: 22),
            action: fixed(132, 40)
        ))
        // 44 more content lifts everything by 22.
        assertFrame(layout.icon, rect(168.5, 342.5, 56, 56))
        assertFrame(layout.action, rect(130.5, 506.5, 132, 40))
    }

    func testNoSessionsStartNewSessionStretchesAcross() {
        let layout = NoSessionsLayout(.init(
            size: phone,
            safeArea: phoneUnderBar,
            title: text("No sessions yet", lineHeight: 30),
            description: text("Start one on a connected machine.", lineHeight: 22),
            buttonHeight: 50,
            action: fixed(132, 40)
        ))
        // 94 more content lifts everything by 47; the button follows the
        // description's 24 and the action sits 4 under it.
        assertFrame(layout.icon, rect(168.5, 317.5, 56, 56))
        assertFrame(layout.description, rect(64.5, 431.5, 264, 22))
        assertFrame(layout.button, rect(0, 477.5, 393, 50))
        assertFrame(layout.action, rect(130.5, 531.5, 132, 40))
    }

    func testTextAction() {
        let layout = TextActionLayout(width: 393, label: text("Show archived", lineHeight: 20))
        assertSize(layout.size, CGSize(width: 132, height: 40))
        assertFrame(layout.label, rect(14, 10, 104, 20))
    }
}

/// Seeds hashed by node with happy-app's `hashCode`.
final class GeneratedAvatarTests: XCTestCase {
    func testHashMatchesJavaScript() {
        XCTAssertEqual(GeneratedAvatar.hashCode("avatar-style-preview"), 2_011_298_248)
        XCTAssertEqual(GeneratedAvatar.hashCode("avatar-style-previewcolor"), 2_095_860_779)
        XCTAssertEqual(GeneratedAvatar.hashCode("m1:/Users/steve/happy"), 1_073_159_556)
        XCTAssertEqual(GeneratedAvatar.hashCode("abc"), 96_354)
        XCTAssertEqual(GeneratedAvatar.hashCode(""), 0)
        XCTAssertEqual(GeneratedAvatar.hashCode("machine:bot:b1"), 1_899_767_499)
        XCTAssertEqual(GeneratedAvatar.hashCode("😀x"), 54_959_989, "UTF-16 code units, as charCodeAt")
    }

    func testBrutalistPicks() {
        let preview = GeneratedAvatar.brutalist(seed: "avatar-style-preview", monochrome: false)
        XCTAssertEqual(preview.imageName, "Abstract-149")
        XCTAssertEqual(preview.tint, RGBA(hex: "#84E600"))
        XCTAssertEqual(preview.background, RGBA(hex: "#C026D3"))
        XCTAssertEqual(GeneratedAvatar.brutalist(seed: "m1:/Users/steve/happy", monochrome: false).imageName, "Brutalism-35")
        XCTAssertEqual(GeneratedAvatar.brutalist(seed: "m1:/Users/steve/happy", monochrome: false).background, RGBA(hex: "#047857"))
        XCTAssertEqual(GeneratedAvatar.brutalist(seed: "machine:bot:b1", monochrome: false).imageName, "Brutalism-98")
        XCTAssertEqual(GeneratedAvatar.brutalist(seed: "", monochrome: false).imageName, "Abstract-1")

        let mono = GeneratedAvatar.brutalist(seed: "abc", monochrome: true)
        XCTAssertEqual(mono.imageName, "Abstract-175")
        XCTAssertEqual(mono.tint, RGBA(hex: "#999999"))
        XCTAssertEqual(mono.background, RGBA(hex: "#F0F0F0"))
    }

    func testBrutalistImageOrder() {
        XCTAssertEqual(GeneratedAvatar.brutalistImageName(261), "Abstract-262")
        XCTAssertEqual(GeneratedAvatar.brutalistImageName(262), "Bauhaus-1")
        XCTAssertEqual(GeneratedAvatar.brutalistImageName(301), "Bauhaus-40")
        XCTAssertEqual(GeneratedAvatar.brutalistImageName(302), "Brutalism-1")
        XCTAssertEqual(GeneratedAvatar.brutalistImageName(419), "Brutalism-118")
    }

    func testGradientPicks() {
        XCTAssertEqual(GeneratedAvatar.gradientImageName(seed: "avatar-style-preview"), "gradient-49")
        XCTAssertEqual(GeneratedAvatar.gradientImageName(seed: ""), "gradient-01")
        XCTAssertEqual(GeneratedAvatar.gradientImageName(seed: "machine:bot:b1"), "gradient-100")
        XCTAssertEqual(GeneratedAvatar.gradientImageName(seed: "😀x"), "gradient-90")
    }

    func testPixels() {
        let palette = ["#0a0310", "#49007e", "#ff005b", "#ff7d10", "#ffb238"].map { RGBA(hex: $0)! }
        let cells = GeneratedAvatar.pixels(seed: "abc", monochrome: false)
        XCTAssertEqual(cells.count, 64)
        // node: [0,0,0,2,4,0,1,2]
        XCTAssertEqual(Array(cells.prefix(8)), [0, 0, 0, 2, 4, 0, 1, 2].map { palette[$0] })
        XCTAssertEqual(GeneratedAvatar.pixels(seed: "abc", monochrome: true).first, RGBA(hex: "#070707"))
        let frames = GeneratedAvatar.pixelFrames(size: 60)
        assertFrame(frames[9], rect(7.5, 7.5, 7.5, 7.5))
        assertFrame(frames[63], rect(52.5, 52.5, 7.5, 7.5))
    }

    func testGlyphsAndBadge() {
        assertFrame(GeneratedAvatar.brutalistGlyphFrame(avatarSize: 60), rect(6, 6, 48, 48))
        assertFrame(GeneratedAvatar.botGlyphFrame(avatarSize: 60), rect(13.5, 13.5, 33, 33))
        let badge = GeneratedAvatar.badge(avatarSize: 60, glyphRatio: GeneratedAvatar.badgeGlyphRatio(harness: "claude"))
        // round(60 × 0.42) = 25, hanging 2 past the bottom-right corner.
        assertFrame(badge.circle, rect(37, 37, 25, 25))
        assertFrame(badge.glyph, rect(39.5, 39.5, 20, 20))
        XCTAssertEqual(GeneratedAvatar.badgeGlyphRatio(harness: "rig"), 0.26)
        XCTAssertEqual(GeneratedAvatar.badgeGlyphRatio(harness: "agy"), 0.42)
    }

    /// Every image a seed can pick ships in HappyUI's resources.
    func testEveryAvatarImageIsBundled() {
        let resources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("../../Sources/HappyUI/Resources/Avatars")
            .standardizedFileURL
        for index in 0..<GeneratedAvatar.brutalistImageCount {
            let name = GeneratedAvatar.brutalistImageName(index)
            let path = resources.appendingPathComponent("Brutalist/\(name).png").path
            XCTAssertTrue(FileManager.default.fileExists(atPath: path), "missing \(path)")
        }
        for index in 1...GeneratedAvatar.gradientImageCount {
            let path = resources.appendingPathComponent(String(format: "Gradients/gradient-%02d.png", index)).path
            XCTAssertTrue(FileManager.default.fileExists(atPath: path), "missing \(path)")
        }
    }
}
