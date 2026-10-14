#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Fonts at the person's text size. The factors and the cap are covered on
/// Linux by TextScaleTests; these need UIFont, so they run only in the
/// simulator.
@MainActor
final class TextEnvironmentTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func environment(_ category: TextSizeCategory) -> TextEnvironment {
        TextEnvironment(scale: TextScale(category), displayScale: 3)
    }

    /// Reading an override never set raises; the trait reads as off.
    func testAnOverrideNeverSetReadsAsNotFollowing() {
        let view = UIView()
        XCTAssertFalse(view.traitOverrides.followsTextSize)
        view.traitOverrides.followsTextSize = true
        XCTAssertTrue(view.traitOverrides.followsTextSize)
        view.traitOverrides.followsTextSize = false
        XCTAssertTrue(view.traitOverrides.contains(FollowsTextSize.self))
        XCTAssertFalse(view.traitOverrides.followsTextSize)
        let controller = UIViewController()
        XCTAssertFalse(controller.traitOverrides.followsTextSize)
        controller.followsTextSize()
        XCTAssertTrue(controller.traitOverrides.followsTextSize)
    }

    func testUIKitsCategoriesMapOneToOne() {
        let uikit: [UIContentSizeCategory] = [
            .extraSmall, .small, .medium, .large, .extraLarge, .extraExtraLarge, .extraExtraExtraLarge,
            .accessibilityMedium, .accessibilityLarge, .accessibilityExtraLarge,
            .accessibilityExtraExtraLarge, .accessibilityExtraExtraExtraLarge,
        ]
        XCTAssertEqual(uikit.map(TextSizeCategory.init), TextSizeCategory.allCases)
        XCTAssertEqual(TextSizeCategory(.unspecified), .large)
    }

    func testTraitsGiveTheirSizeAndScale() {
        let traits = UITraitCollection { traits in
            traits.preferredContentSizeCategory = .accessibilityLarge
            traits.displayScale = 2
        }
        let environment = TextEnvironment(traits)
        XCTAssertEqual(environment.scale, TextScale(.accessibilityLarge))
        XCTAssertEqual(environment.displayScale, 2)
    }

    func testTheDesignedSizeIsTodaysFont() {
        let designed = environment(.large)
        for style in [TextStyles.itemTitle, TextStyles.sessionDayHeader, TextStyles.homeDockEntry] {
            XCTAssertEqual(style.font(in: designed), style.font)
            XCTAssertEqual(style.font(in: designed).pointSize, style.size)
            XCTAssertEqual(style.lineHeightValue(in: designed), style.lineHeightValue)
        }
        let chat = ChatTextStyles.bannerTitle
        XCTAssertEqual(chat.font(in: designed), chat.font)
        XCTAssertEqual(chat.lineHeightValue(in: designed), chat.lineHeightValue)
    }

    /// RN hands UIFont `size × multiplier` unrounded, and the fixed line
    /// grows by the same factor.
    func testAScaledFontIsTheExactFractionalSize() {
        let style = TextStyles.itemTitle  // 17 / 22
        let large = environment(.extraExtraExtraLarge)
        let font = style.font(in: large)
        XCTAssertEqual(font.pointSize, 17 * TextScale(.extraExtraExtraLarge).multiplier, accuracy: 0.0001)
        XCTAssertNotEqual(font.pointSize, font.pointSize.rounded())
        XCTAssertEqual(font.fontName, style.font.fontName)
        XCTAssertEqual(style.lineHeightValue(in: large), 22 * TextScale(.extraExtraExtraLarge).multiplier)
    }

    func testWithoutAFixedLineTheScaledFontsLineIsRoundedUp() {
        let style = TextStyles.homeDockEntry  // 17, no lineHeight
        let large = environment(.accessibilityMedium)
        XCTAssertEqual(style.lineHeightValue(in: large), style.font(in: large).lineHeight.rounded(.up))
        XCTAssertGreaterThan(style.lineHeightValue(in: large), style.lineHeightValue)
    }

    func testACapStopsTheFont() {
        let title = TextStyle(.semiBold, size: 28, lineHeight: 34, maxScale: 1.2)
        let largest = environment(.accessibilityExtraExtraExtraLarge)
        XCTAssertEqual(title.font(in: largest).pointSize, 28 * CGFloat(Float(1.2)), accuracy: 0.0001)
        XCTAssertEqual(title.lineHeightValue(in: largest), 34 * CGFloat(Float(1.2)))
    }

    func testEveryChatFaceScales() {
        let named: [ChatFace] = [.plex(.regular), .plex(.mono), .menlo, .menloBold, .menloItalic]
        let system: [ChatFace] = [.system(.semibold), .systemItalic]
        let large = environment(.accessibilityMedium)
        for face in named + system {
            let style = ChatTextStyle(face, size: 14)
            XCTAssertEqual(style.font(in: large).pointSize, 14 * TextScale(.accessibilityMedium).multiplier, accuracy: 0.0001, "\(face)")
        }
        // The system face's name follows its optical size; a named one keeps its face.
        for face in named {
            let style = ChatTextStyle(face, size: 14)
            XCTAssertEqual(style.font(in: large).fontName, style.font.fontName, "\(face)")
        }
    }

    /// Measurers ask from background threads at once: one font per face
    /// and size, whoever asks first.
    func testTheCacheGivesTheSameFontOnEveryThread() async {
        let style = TextStyle(.regular, size: 17, lineHeight: 22, letterSpacing: -0.41)
        let size = environment(.extraLarge)
        let fonts = await withTaskGroup(of: ObjectIdentifier.self) { group in
            for _ in 0..<32 {
                group.addTask { ObjectIdentifier(style.font(in: size)) }
            }
            var fonts = Set<ObjectIdentifier>()
            for await font in group {
                fonts.insert(font)
            }
            return fonts
        }
        XCTAssertEqual(fonts, [ObjectIdentifier(style.font(in: size))])
    }
}
#endif
