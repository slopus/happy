import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The text size the person picked in Settings (UIKit's
/// `UIContentSizeCategory`), smallest to largest. The UI maps UIKit's value
/// onto it; nothing here depends on UIKit.
public enum TextSizeCategory: CaseIterable, Sendable {
    case extraSmall
    case small
    case medium
    case large
    case extraLarge
    case extraExtraLarge
    case extraExtraExtraLarge
    case accessibilityMedium
    case accessibilityLarge
    case accessibilityExtraLarge
    case accessibilityExtraExtraLarge
    case accessibilityExtraExtraExtraLarge

    /// React Native's `RCTFontSizeMultiplier` (React/Base/RCTUtils.mm):
    /// one factor for all text, not UIKit's per-style ramp. It is read as
    /// `floatValue`, so each factor is the nearest `Float`.
    public var reactNativeMultiplier: CGFloat {
        let value: Float = switch self {
        case .extraSmall: 0.823
        case .small: 0.882
        case .medium: 0.941
        case .large: 1.0
        case .extraLarge: 1.118
        case .extraExtraLarge: 1.235
        case .extraExtraExtraLarge: 1.353
        case .accessibilityMedium: 1.786
        case .accessibilityLarge: 2.143
        case .accessibilityExtraLarge: 2.643
        case .accessibilityExtraExtraLarge: 3.143
        case .accessibilityExtraExtraExtraLarge: 3.571
        }
        return CGFloat(value)
    }
}

/// How much bigger than designed text is drawn: React Native's
/// `fontSizeMultiplier` for the person's text size. Only text grows; the
/// spacing, fixed heights and icons around it do not.
public struct TextScale: Hashable, Sendable {
    /// 1 at the default text size (Large).
    public var multiplier: CGFloat

    public init(multiplier: CGFloat) {
        self.multiplier = multiplier
    }

    public init(_ category: TextSizeCategory) {
        multiplier = category.reactNativeMultiplier
    }

    /// The default text size: text as designed.
    public static let standard = TextScale(multiplier: 1)

    /// `RCTEffectiveFontSizeMultiplierFromTextAttributes`: a style's cap
    /// (`maxFontSizeMultiplier`) applies only from 1 up, so it never stops
    /// text from shrinking. Capped, the two are compared as `Float`
    /// (`fminf`).
    public func effective(maxScale: CGFloat?) -> CGFloat {
        guard let maxScale, maxScale >= 1 else { return multiplier }
        return CGFloat(Swift.min(Float(maxScale), Float(multiplier)))
    }
}

extension TextStyle {
    /// This style at a text size, as React Native draws it: the font size
    /// and a fixed line height grow by the multiplier; letter spacing is
    /// kept, as RN leaves `NSKern` alone. Scale the token once; the cap is
    /// kept, so scaling a scaled style scales it twice.
    public func scaled(_ scale: TextScale) -> TextStyle {
        let multiplier = scale.effective(maxScale: maxScale)
        var scaled = self
        scaled.size = size * multiplier
        scaled.lineHeight = lineHeight.map { $0 * multiplier }
        return scaled
    }
}

extension ChatTextStyle {
    /// As `TextStyle.scaled(_:)`.
    public func scaled(_ scale: TextScale) -> ChatTextStyle {
        let multiplier = scale.effective(maxScale: maxScale)
        var scaled = self
        scaled.size = size * multiplier
        scaled.lineHeight = lineHeight.map { $0 * multiplier }
        return scaled
    }
}
