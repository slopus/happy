#if canImport(UIKit)
import HappyLayout
import UIKit

extension TextSizeCategory {
    /// UIKit's category. One without a size (`.unspecified`, a detached
    /// trait collection's) or one newer than this list is the designed size.
    public init(_ category: UIContentSizeCategory) {
        switch category {
        case .extraSmall: self = .extraSmall
        case .small: self = .small
        case .medium: self = .medium
        case .large: self = .large
        case .extraLarge: self = .extraLarge
        case .extraExtraLarge: self = .extraExtraLarge
        case .extraExtraExtraLarge: self = .extraExtraExtraLarge
        case .accessibilityMedium: self = .accessibilityMedium
        case .accessibilityLarge: self = .accessibilityLarge
        case .accessibilityExtraLarge: self = .accessibilityExtraLarge
        case .accessibilityExtraExtraLarge: self = .accessibilityExtraExtraLarge
        case .accessibilityExtraExtraExtraLarge: self = .accessibilityExtraExtraExtraLarge
        default: self = .large
        }
    }
}

/// What a screen's text is drawn at: captured on main from its traits and
/// handed to off-main measurers with their other inputs, so a cache keyed
/// on it is redone when the person changes their text size.
public struct TextEnvironment: Hashable, Sendable {
    public var scale: TextScale
    /// The screen's pixels per point, for snapping measured text boxes.
    public var displayScale: CGFloat

    public init(scale: TextScale, displayScale: CGFloat) {
        self.scale = scale
        self.displayScale = displayScale
    }

    /// The environment `traits` describe.
    @MainActor
    public init(_ traits: UITraitCollection) {
        let displayScale = traits.displayScale
        self.init(
            scale: TextScale(TextSizeCategory(traits.preferredContentSizeCategory)),
            displayScale: displayScale > 0 ? displayScale : UIGraphicsImageRendererFormat.preferred().scale
        )
    }
}

/// UIFonts by face and point size, shared by every thread. RN builds each
/// font at exactly `size × multiplier`, unrounded (docs/DYNAMIC-TYPE.md).
enum ScaledFonts {
    private struct Key: Hashable {
        let face: ChatFace
        let size: CGFloat
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var fonts: [Key: UIFont] = [:]

    static func font(_ face: ChatFace, size: CGFloat) -> UIFont {
        let key = Key(face: face, size: size)
        lock.lock()
        if let font = fonts[key] {
            lock.unlock()
            return font
        }
        lock.unlock()
        // Before the first lookup, so a font asked for early is never
        // cached as its system fallback.
        Fonts.registerBundledFonts()
        let font = ChatTextStyle(face, size: size).font
        lock.lock()
        defer { lock.unlock() }
        if let raced = fonts[key] { return raced }
        fonts[key] = font
        return font
    }
}

extension TextStyle {
    /// `font` at the environment's text size. Safe off main.
    public func font(in environment: TextEnvironment) -> UIFont {
        ScaledFonts.font(.plex(face), size: scaled(environment.scale).size)
    }

    /// `lineHeightValue` at the environment's text size. Safe off main.
    public func lineHeightValue(in environment: TextEnvironment) -> CGFloat {
        scaled(environment.scale).lineHeight ?? font(in: environment).lineHeight.rounded(.up)
    }
}

extension ChatTextStyle {
    /// `font` at the environment's text size. Safe off main.
    func font(in environment: TextEnvironment) -> UIFont {
        ScaledFonts.font(face, size: scaled(environment.scale).size)
    }

    /// `lineHeightValue` at the environment's text size. Safe off main.
    func lineHeightValue(in environment: TextEnvironment) -> CGFloat {
        scaled(environment.scale).lineHeight ?? font(in: environment).lineHeight.rounded(.up)
    }
}
#endif
