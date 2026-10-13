import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// React Native's text scaling on iOS (RCTUtils.mm `RCTFontSizeMultiplier`,
/// RCTAttributedTextUtils.mm `RCTEffectiveFontSizeMultiplierFromTextAttributes`).
final class TextScaleTests: XCTestCase {
    private func float(_ value: Double) -> CGFloat { CGFloat(Float(value)) }

    func testEveryCategoryHasReactNativesFactor() {
        let expected: [(TextSizeCategory, Double)] = [
            (.extraSmall, 0.823), (.small, 0.882), (.medium, 0.941), (.large, 1.0),
            (.extraLarge, 1.118), (.extraExtraLarge, 1.235), (.extraExtraExtraLarge, 1.353),
            (.accessibilityMedium, 1.786), (.accessibilityLarge, 2.143), (.accessibilityExtraLarge, 2.643),
            (.accessibilityExtraExtraLarge, 3.143), (.accessibilityExtraExtraExtraLarge, 3.571),
        ]
        XCTAssertEqual(expected.map(\.0), TextSizeCategory.allCases)
        for (category, factor) in expected {
            // Read through `floatValue`: the nearest Float, not the Double.
            XCTAssertEqual(TextScale(category).multiplier, float(factor), "\(category)")
        }
        XCTAssertNotEqual(TextScale(.extraLarge).multiplier, 1.118, "a Float, as RN reads it")
        XCTAssertEqual(TextScale(.extraLarge).multiplier, 1.1180000305175781)
    }

    func testLargeIsTheDesignedSize() {
        XCTAssertEqual(TextScale(.large), .standard)
        XCTAssertEqual(TextScale.standard.multiplier, 1)
        XCTAssertEqual(TextStyles.itemTitle.scaled(.standard), TextStyles.itemTitle)
        XCTAssertEqual(ChatTextStyles.bannerTitle.scaled(.standard), ChatTextStyles.bannerTitle)
    }

    func testTheFactorsOnlyGrow() {
        let factors = TextSizeCategory.allCases.map(\.reactNativeMultiplier)
        XCTAssertEqual(factors, factors.sorted())
        XCTAssertEqual(Set(factors).count, factors.count)
    }

    // MARK: The cap

    func testNoCapLetsTextGrowAllTheWay() {
        XCTAssertEqual(TextScale(.accessibilityExtraExtraExtraLarge).effective(maxScale: nil), float(3.571))
    }

    func testACapStopsGrowthAsAFloat() {
        // The onboarding titles' 1.2 under XXL's 1.235: fminf, so 1.2's Float.
        XCTAssertEqual(TextScale(.extraExtraLarge).effective(maxScale: 1.2), float(1.2))
        XCTAssertEqual(TextScale(.accessibilityExtraExtraExtraLarge).effective(maxScale: 1.2), float(1.2))
        XCTAssertNotEqual(TextScale(.extraExtraLarge).effective(maxScale: 1.2), 1.2)
        // Under the cap the factor stands.
        XCTAssertEqual(TextScale(.extraLarge).effective(maxScale: 1.2), float(1.118))
        // Capped, a factor is compared as a Float even when it wins.
        XCTAssertEqual(TextScale(multiplier: 1.1).effective(maxScale: 1.2), float(1.1))
    }

    func testACapNeverStopsShrinking() {
        XCTAssertEqual(TextScale(.extraSmall).effective(maxScale: 1.2), float(0.823))
        XCTAssertEqual(TextScale(.extraSmall).effective(maxScale: 1), float(0.823))
    }

    func testACapBelowOneIsIgnored() {
        XCTAssertEqual(TextScale(.accessibilityLarge).effective(maxScale: 0.5), float(2.143))
        XCTAssertEqual(TextScale(.accessibilityLarge).effective(maxScale: 0), float(2.143))
        // Exactly 1 is a cap: nothing grows past the designed size.
        XCTAssertEqual(TextScale(.accessibilityLarge).effective(maxScale: 1), 1)
    }

    // MARK: Styles

    func testAStyleGrowsItsFontAndLineButNotItsKern() {
        let style = TextStyles.itemTitle  // 17 / 22, kern -0.41
        let scaled = style.scaled(TextScale(.extraExtraExtraLarge))
        XCTAssertEqual(scaled.size, 17 * float(1.353))
        XCTAssertEqual(scaled.size, 23.001, accuracy: 0.0001)
        XCTAssertEqual(scaled.lineHeight, 22 * float(1.353))
        XCTAssertEqual(scaled.lineHeight ?? 0, 29.766, accuracy: 0.0001)
        XCTAssertEqual(scaled.letterSpacing, -0.41)
        XCTAssertEqual(scaled.face, style.face)
        XCTAssertEqual(scaled.uppercase, style.uppercase)
        XCTAssertNil(scaled.maxScale)
    }

    func testAStyleWithoutAFixedLineKeepsTheFontsOwn() {
        let scaled = TextStyles.homeDockEntry.scaled(TextScale(.accessibilityMedium))
        XCTAssertNil(scaled.lineHeight)
        XCTAssertEqual(scaled.size, 17 * float(1.786))
    }

    func testAStyleShrinks() {
        let scaled = TextStyles.sessionDayHeader.scaled(TextScale(.extraSmall))  // 14 / 18, kern 0.1
        XCTAssertEqual(scaled.size, 14 * float(0.823))
        XCTAssertEqual(scaled.lineHeight, 18 * float(0.823))
        XCTAssertEqual(scaled.letterSpacing, 0.1)
        XCTAssertTrue(scaled.uppercase == TextStyles.sessionDayHeader.uppercase)
    }

    func testACappedStyleStopsAtItsCap() {
        // As OnboardingContent.tsx's titles: `maxFontSizeMultiplier={1.2}`.
        let title = TextStyle(.semiBold, size: 28, lineHeight: 34, maxScale: 1.2)
        let largest = title.scaled(TextScale(.accessibilityExtraExtraExtraLarge))
        XCTAssertEqual(largest.size, 28 * float(1.2))
        XCTAssertEqual(largest.lineHeight, 34 * float(1.2))
        XCTAssertEqual(largest.maxScale, 1.2, "the cap travels with the style")
        XCTAssertEqual(title.scaled(TextScale(.extraLarge)).size, 28 * float(1.118))
        XCTAssertEqual(title.scaled(TextScale(.small)).size, 28 * float(0.882))
    }

    func testOnlyTheOnboardingTitlesAreCapped() {
        // OnboardingContent.tsx's TITLE_MAX_SCALE, happy-app's only cap.
        XCTAssertEqual(TextStyles.onboardingTitle.maxScale, 1.2)
        XCTAssertEqual(TextStyles.onboardingTitle.scaled(TextScale(.accessibilityExtraExtraExtraLarge)).size, 28 * float(1.2))
        XCTAssertEqual(TextStyles.onboardingTitle.scaled(TextScale(.extraLarge)).size, 28 * float(1.118))
        for style in [TextStyles.itemTitle, TextStyles.onboardingProp, TextStyles.checklistTitle, TextStyles.headerTitle] {
            XCTAssertNil(style.maxScale)
        }
        XCTAssertEqual(TextStyle(.regular, size: 17), TextStyle(.regular, size: 17, maxScale: nil))
        XCTAssertNotEqual(TextStyle(.regular, size: 17), TextStyle(.regular, size: 17, maxScale: 1.2))
    }

    // MARK: Chat styles

    func testAChatStyleScalesTheSameWay() {
        let style = ChatTextStyle(.plex(.regular), size: 16, lineHeight: 24, letterSpacing: 0.2)
        let scaled = style.scaled(TextScale(.accessibilityExtraLarge))
        XCTAssertEqual(scaled.size, 16 * float(2.643))
        XCTAssertEqual(scaled.lineHeight, 24 * float(2.643))
        XCTAssertEqual(scaled.letterSpacing, 0.2)
        XCTAssertEqual(scaled.face, style.face)
        XCTAssertNil(ChatTextStyles.bannerTitle.maxScale)
    }

    func testAChatStyleKeepsAStylesCap() {
        let style = ChatTextStyle(TextStyle(.semiBold, size: 28, lineHeight: 34, maxScale: 1.2))
        XCTAssertEqual(style.maxScale, 1.2)
        XCTAssertEqual(style.with(.plex(.regular)).maxScale, 1.2)
        XCTAssertEqual(style.scaled(TextScale(.accessibilityMedium)).size, 28 * float(1.2))
        XCTAssertEqual(
            ChatTextStyle(TextStyles.itemTitle.scaled(TextScale(.extraLarge))),
            ChatTextStyle(TextStyles.itemTitle).scaled(TextScale(.extraLarge)),
            "scaling before or after the conversion is the same"
        )
    }
}
