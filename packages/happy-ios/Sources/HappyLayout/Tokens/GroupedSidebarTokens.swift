import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// Home's list as iOS's inset grouped lists draw theirs, in Settings' card
// shapes (`SettingsLayout`), but quiet: the cards barely lift off the
// screen's own ground, enough to tell one section from the next. Hairlines
// run between rows from the title's start, and each section's heading
// stands over its card. A top-level row's glyph sits on a softly tinted
// tile, one tint per kind.

extension Palette {
    /// The screen's ground under the cards: the conversation's own.
    public static let groupedGround = surface
    /// A card: a breath off the ground.
    public static let groupedCard = ColorToken("#f6f6f8", "#1f1f21")
    /// Between rows in a card, and a row pressed or open.
    public static let groupedSeparator = ColorToken("#e6e6ea", "#2e2e31")
    public static let groupedCellHighlight = ColorToken("#ebebef", "#2b2b2e")

    /// A glyph tile's ink and its fill: iOS's system colours, the fill
    /// the same colour very light.
    public static let tileBlue = ColorToken("#007aff", "#0a84ff")
    public static let tileBlueFill = ColorToken(light: RGBA(red: 0, green: 0.478, blue: 1, alpha: 0.11), dark: RGBA(red: 0.039, green: 0.518, blue: 1, alpha: 0.2))
    public static let tileGreen = ColorToken("#28a745", "#30d158")
    public static let tileGreenFill = ColorToken(light: RGBA(red: 0.204, green: 0.78, blue: 0.349, alpha: 0.14), dark: RGBA(red: 0.188, green: 0.82, blue: 0.345, alpha: 0.2))
    public static let tileOrange = ColorToken("#f08c00", "#ff9f0a")
    public static let tileOrangeFill = ColorToken(light: RGBA(red: 1, green: 0.584, blue: 0, alpha: 0.14), dark: RGBA(red: 1, green: 0.624, blue: 0.039, alpha: 0.2))
    public static let tileIndigo = ColorToken("#5856d6", "#7d7aff")
    public static let tileIndigoFill = ColorToken(light: RGBA(red: 0.345, green: 0.337, blue: 0.839, alpha: 0.12), dark: RGBA(red: 0.369, green: 0.361, blue: 0.902, alpha: 0.24))
    public static let tilePurple = ColorToken("#a347d6", "#bf5af2")
    public static let tilePurpleFill = ColorToken(light: RGBA(red: 0.686, green: 0.322, blue: 0.871, alpha: 0.12), dark: RGBA(red: 0.749, green: 0.353, blue: 0.949, alpha: 0.2))
    public static let tileRed = ColorToken("#ff3b30", "#ff453a")
    public static let tileRedFill = ColorToken(light: RGBA(red: 1, green: 0.231, blue: 0.188, alpha: 0.11), dark: RGBA(red: 1, green: 0.271, blue: 0.227, alpha: 0.2))
    public static let tileTeal = ColorToken("#1c9fb8", "#40c8e0")
    public static let tileTealFill = ColorToken(light: RGBA(red: 0.188, green: 0.69, blue: 0.78, alpha: 0.14), dark: RGBA(red: 0.251, green: 0.784, blue: 0.878, alpha: 0.2))
}

/// The grouped sidebar's sizes. Rows keep the plain sidebar's height, mark
/// and type (`Metrics`); only the room around them is the card's.
public enum GroupedSidebarMetrics {
    /// The cards' inset from the list's edges, and their corners: Settings'.
    public static let side: CGFloat = SettingsLayout.Metrics.side
    public static let radius: CGFloat = SettingsLayout.Metrics.radius
    /// A top-level mark's left edge, from its card's: iOS's cell margin.
    public static let markInset: CGFloat = 16
    /// Each end of a row holds its mark the same way: the mark's centre this
    /// far from the card's left, the trailing square's from its right.
    public static let endCenter: CGFloat = markInset + Metrics.mark / 2
    /// A nested row's mark stands under its parent's title: a mark and its gap.
    public static let indent: CGFloat = Metrics.mark + Metrics.markGap
    /// A story row's own card, this far inside the cell on either side, so
    /// its disc and its corner signal keep clear of the card's corners.
    public static let storyInset: CGFloat = 4
    /// A section's heading over its card: its title (13 on an 18 line)
    /// stands `headingBottom` above the card, in a box `headingHeight` tall
    /// that a finger folds anywhere along.
    public static let headingHeight: CGFloat = 36
    public static let headingLine: CGFloat = 18
    public static let headingBottom: CGFloat = 7
    public static let headingSize: CGFloat = 13
    /// The heading's fold, smaller than a row's, on the rows' trailing column.
    public static let headingGlyph: CGFloat = 14
    /// From a card down to the next heading.
    public static let headingGap: CGFloat = 14
    /// Between two cards with no heading between them: Settings'.
    public static let cardGap: CGFloat = SettingsLayout.Metrics.cardGap
    /// Room above the first card or heading and below the last.
    public static let contentTop: CGFloat = 8
    public static let contentBottom: CGFloat = 24
    /// A glyph's tile: the mark's square, rounded as Settings' tiles are
    /// for their size, the glyph smaller inside it; a picture's rounding.
    public static let tileRadius: CGFloat = 8
    public static let tileGlyph: CGFloat = 18
}
