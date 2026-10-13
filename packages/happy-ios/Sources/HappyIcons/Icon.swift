import Foundation
import HappyLayout

/// An icon font that happy-app draws through `@expo/vector-icons`.
public enum IconFamily: String, CaseIterable, Sendable {
    case ionicons = "Ionicons"
    case octicons = "Octicons"
    case materialCommunityIcons = "MaterialCommunityIcons"
    case materialIcons = "MaterialIcons"
    case feather = "Feather"
    case fontAwesome = "FontAwesome"
    case fontAwesome5 = "FontAwesome5"
}

/// One of happy-app's icons, named exactly as the RN code names it, so
/// `<Ionicons name="chevron-forward" />` ports as `.ionicons("chevron-forward")`.
public struct Icon: Hashable, Sendable {
    public let family: IconFamily
    public let name: String

    public init(_ family: IconFamily, _ name: String) {
        self.family = family
        self.name = name
    }

    public static func ionicons(_ name: String) -> Icon { Icon(.ionicons, name) }
    public static func octicons(_ name: String) -> Icon { Icon(.octicons, name) }
    public static func materialCommunityIcons(_ name: String) -> Icon { Icon(.materialCommunityIcons, name) }
    public static func materialIcons(_ name: String) -> Icon { Icon(.materialIcons, name) }
    public static func feather(_ name: String) -> Icon { Icon(.feather, name) }
    public static func fontAwesome(_ name: String) -> Icon { Icon(.fontAwesome, name) }
    public static func fontAwesome5(_ name: String) -> Icon { Icon(.fontAwesome5, name) }
}

/// A glyph's outline and the font metrics needed to place it the way RN's
/// `<Text style={{ fontSize }}>` places it.
public struct IconGlyph: Equatable, Sendable {
    /// The outline in font units, y pointing down, origin at the top of the
    /// em box on the baseline's left edge minus the ascender.
    public var path: VectorPath
    public var unitsPerEm: CGFloat
    public var advance: CGFloat
    public var ascender: CGFloat
    public var descender: CGFloat

    public init(path: VectorPath, unitsPerEm: CGFloat, advance: CGFloat, ascender: CGFloat, descender: CGFloat) {
        self.path = path
        self.unitsPerEm = unitsPerEm
        self.advance = advance
        self.ascender = ascender
        self.descender = descender
    }
}

/// Every icon the app ships. The table is generated from the icon fonts by
/// `scripts/generate-icons.py`; only icons happy-app references are included.
public enum IconCatalog {
    /// Nil for an icon that was not generated. Tests check that every icon
    /// the app names is in the table.
    public static func glyph(for icon: Icon) -> IconGlyph? {
        generatedGlyph(icon)
    }
}
