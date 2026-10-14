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

/// Whether the text in a view, and in everything in it, follows the
/// person's text size. Off unless a screen turns it on, which it does once
/// every height on it comes from text measured at that size; a screen
/// whose heights are planned at the designed size stays at it
/// (docs/DYNAMIC-TYPE.md).
public struct FollowsTextSize: UITraitDefinition {
    public static let defaultValue = false
    public static let name = "FollowsTextSize"
}

extension UITraitCollection {
    /// The environment text here is drawn in; nil where it stays at its
    /// designed size.
    @MainActor
    public var textEnvironment: TextEnvironment? {
        self[FollowsTextSize.self] ? TextEnvironment(self) : nil
    }
}

extension UIMutableTraits {
    /// Turns the person's text size on for a view and what is in it.
    public var followsTextSize: Bool {
        get { self[FollowsTextSize.self] }
        set { self[FollowsTextSize.self] = newValue }
    }
}

extension UITraitOverrides {
    /// As above. An override never set reads as off, where reading it
    /// would raise.
    public var followsTextSize: Bool {
        get { contains(FollowsTextSize.self) && self[FollowsTextSize.self] }
        set { self[FollowsTextSize.self] = newValue }
    }
}

extension UIViewController {
    /// Draws this screen's text at the person's text size, as React Native
    /// does. Only for a screen whose every height is measured from its text
    /// as drawn, with no plan made at the designed size.
    func followsTextSize() {
        traitOverrides.followsTextSize = true
    }
}

extension UIView {
    /// The traits a view's text environment comes from.
    static var textSizeTraits: [UITrait] { [UITraitPreferredContentSizeCategory.self, FollowsTextSize.self] }

    /// Measures this view and every view it is in again: a new text size
    /// moves every frame measured from text, up to the screen.
    func setNeedsLayoutUpTheTree() {
        var view: UIView? = self
        while let current = view {
            current.invalidateIntrinsicContentSize()
            current.setNeedsLayout()
            view = current.superview
        }
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

    /// One line of this style as a one-line `StyledLabel` measures it in
    /// the environment: the line height, or the font's own, unrounded, up
    /// to the screen's next pixel. Safe off main.
    public func oneLine(in environment: TextEnvironment) -> CGFloat {
        let height = scaled(environment.scale).lineHeight ?? font(in: environment).lineHeight
        let pixels = environment.displayScale
        return pixels > 0 ? (height * pixels).rounded(.up) / pixels : height
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
