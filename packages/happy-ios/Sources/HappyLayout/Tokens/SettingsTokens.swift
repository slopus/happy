import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// Settings pages: settings/appearance.tsx, settings/connect/claude.tsx and
// app/(app)/changelog.tsx (iOS values).

extension Palette {
    /// A pressed dropdown option (`theme.colors.glass.backgroundStrong`).
    public static let optionPressed = ColorToken(
        light: RGBA(red: 1, green: 1, blue: 1, alpha: 0.84),
        dark: RGBA(red: 28 / 255, green: 28 / 255, blue: 28 / 255, alpha: 0.68)
    )
}

/// A user-bubble swatch on iOS, where it is a glass surface:
/// `resolveUserMessageBubbleGlassColor` lays a translucent preset over the
/// card. The lines keep the opaque indicator colour.
public struct BubbleGlass: Equatable, Sendable {
    public var background: ColorToken
    public var border: ColorToken
}

extension BubblePalette {
    public var glass: BubbleGlass {
        if self == .gray {
            return BubbleGlass(
                background: ColorToken(light: background.light.with(alpha: 0.48), dark: background.dark.with(alpha: 0.34)),
                border: ColorToken(
                    light: RGBA(red: 1, green: 1, blue: 1, alpha: 0.76),
                    dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.18)
                )
            )
        }
        return BubbleGlass(
            background: ColorToken(light: background.light.with(alpha: 0.54), dark: background.dark.with(alpha: 0.46)),
            border: ColorToken(light: border.light.with(alpha: 0.70), dark: border.dark.with(alpha: 0.56))
        )
    }
}

extension RGBA {
    /// The same colour at another opacity (`withAlpha`).
    public func with(alpha: Double) -> RGBA {
        RGBA(red: red, green: green, blue: blue, alpha: alpha)
    }
}

extension TextStyles {
    /// What's New's empty state.
    public static let changelogEmpty = TextStyle(.regular, size: 16, lineHeight: 24)
    /// The What's New navigation title (16, semibold, natural line height).
    public static let changelogNavigationTitle = TextStyle(.semiBold, size: 16)
}
