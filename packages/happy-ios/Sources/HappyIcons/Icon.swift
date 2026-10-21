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
/// `<Text style={{ fontSize }}>` places it (see `IconLayout`).
public struct IconGlyph: Equatable, Sendable {
    /// The outline in font units, y pointing down, origin on the ascender
    /// line at the pen position: a font-space point (x, y) is at
    /// (x, ascender - y) here.
    public var path: VectorPath
    public var unitsPerEm: CGFloat
    public var advance: CGFloat
    /// The font's hhea ascender (positive) and descender (negative).
    public var ascender: CGFloat
    public var descender: CGFloat

    public init(path: VectorPath, unitsPerEm: CGFloat, advance: CGFloat, ascender: CGFloat, descender: CGFloat) {
        self.path = path
        self.unitsPerEm = unitsPerEm
        self.advance = advance
        self.ascender = ascender
        self.descender = descender
    }

    public var metrics: IconMetrics {
        IconMetrics(unitsPerEm: unitsPerEm, advance: advance, ascender: ascender, descender: descender)
    }

    /// Where RN draws this glyph at `size` on a screen of `scale`.
    public func layout(size: CGFloat, scale: CGFloat) -> IconLayout {
        IconLayout(metrics: metrics, size: size, scale: scale)
    }
}

/// Every icon the app ships. The tables are generated from the icon fonts by
/// `scripts/generate-icons.py`; only icons happy-app references are included.
public enum IconCatalog {
    /// Nil for an icon that was not generated. Tests check that every icon
    /// the app names is in the table.
    public static func glyph(for icon: Icon) -> IconGlyph? {
        guard let entry = index[icon] else { return nil }
        let font = generatedFonts[entry.font]
        guard let path = GlyphOutline.decode(entry.outline) else { return nil }
        return IconGlyph(
            path: path,
            unitsPerEm: CGFloat(font.unitsPerEm),
            advance: entry.advance,
            ascender: CGFloat(font.ascender),
            descender: CGFloat(font.descender)
        )
    }

    /// Every generated icon, in table order.
    public static var allIcons: [Icon] {
        generatedFonts.flatMap { font in
            font.glyphs.split(separator: "\n").compactMap { line in
                line.split(separator: " ", maxSplits: 1).first.map { Icon(font.family, String($0)) }
            }
        }
    }

    /// The @expo/vector-icons version the tables were generated from.
    public static var sourceVersion: String { generatedIconsVersion }

    /// Whether the tables still match the checksum the generator wrote: FNV-1a
    /// 64 over each font's family, metrics and glyph lines.
    public static var checksumMatches: Bool {
        var hash: UInt64 = 0xCBF2_9CE4_8422_2325
        for font in generatedFonts {
            let block = "\(font.family.rawValue)\n\(font.unitsPerEm) \(font.ascender) \(font.descender)\n\(font.glyphs)\n"
            for byte in block.utf8 {
                hash ^= UInt64(byte)
                hash = hash &* 0x0000_0100_0000_01B3
            }
        }
        return hash == generatedIconsChecksum
    }

    private struct Entry: Sendable {
        let font: Int
        let advance: CGFloat
        let outline: Substring
    }

    /// Built on first use: one line per glyph, split but not decoded.
    private static let index: [Icon: Entry] = {
        var index: [Icon: Entry] = [:]
        for (fontIndex, font) in generatedFonts.enumerated() {
            for line in font.glyphs.split(separator: "\n") {
                let fields = line.split(separator: " ")
                guard fields.count == 3, let advance = Int(fields[1]) else { continue }
                index[Icon(font.family, String(fields[0]))] = Entry(
                    font: fontIndex,
                    advance: CGFloat(advance),
                    outline: fields[2]
                )
            }
        }
        return index
    }()
}
