import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// Stem Cells: happy-desktop-ui's spaces sidebar (`Sidebar.tsx`,
// `styles/sidebar.css`, `theme.css`), scaled from its 32px pointer rows to
// touch.

extension Palette {
    /// A row's ink at rest (`--text-secondary`).
    public static let stemCellsRowText = ColorToken("#49454f", "#cac4d0")
    /// The open row's ink (`--text`).
    public static let stemCellsRowTextActive = ColorToken("#000000", "#ffffff")
    /// The open row's fill (`--surface-selected`).
    public static let stemCellsRowSelected = ColorToken("#eaeaea", "#2c2c2e")
    /// A pressed or carried row's fill (`--surface-ripple`).
    public static let stemCellsRowPressed = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.08), dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.08))
    /// A separator's hairline (`--divider`).
    public static let stemCellsDivider = ColorToken("#eaeaea", "#292929")
    /// The stem cell (`--stem-cell-membrane`, `--stem-cell-core`).
    public static let stemCellMembrane = ColorToken("#f6cfe3", "#653c53")
    public static let stemCellCore = ColorToken("#ee9fcb")
    /// A question waiting on the person (`--status-error`).
    public static let stemCellsQuestion = ColorToken("#FF3B30", "#FF453A")
    /// The person's own message (`--user-message-background`).
    public static let stemCellsUserBubble = ColorToken("#f0eee6", "#2c2c2e")
    /// A secondary button's fill (`--surface-high`), ringed in `--divider`.
    public static let stemCellsButton = ColorToken("#f8f8f8", "#171717")
    /// The sidebar's ground (`--groupped-background`).
    public static let stemCellsBackground = ColorToken("#f5f5f5", "#1e1e1e")
    /// A usage ring (`UsageRing`): its quiet track, its arc, and the arc
    /// when little or almost nothing is left.
    public static let stemCellsUsageTrack = ColorToken("#c0c0c0", "#48484a")
    public static let stemCellsUsageArc = ColorToken("#49454f", "#cac4d0")
    public static let stemCellsUsageLow = ColorToken("#ff9500", "#ffab00")
    public static let stemCellsUsageCritical = ColorToken("#ff3b30", "#ff453a")
    /// A recording's play button over its first frame, and its glyph.
    public static let stemCellsPlayFill = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.55), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.55))
    public static let stemCellsPlayGlyph = ColorToken("#ffffff")
    /// A picture opened on its own: black behind it, white controls.
    public static let stemCellsViewerGround = ColorToken("#000000")
    public static let stemCellsViewerControl = ColorToken("#ffffff")
}

public enum StemCellsMetrics {
    /// The row box's inset from the screen's edges (`--happy-panel-inset`).
    public static let inset: CGFloat = 8
    /// Ink's inset inside the row box (`--happy-panel-row-padding`).
    public static let padding: CGFloat = 12
    public static let rowHeight: CGFloat = 40
    public static let sectionHeight: CGFloat = 34
    public static let separatorHeight: CGFloat = 21
    public static let widgetMinHeight: CGFloat = 32
    /// Between one row and the next (`SIDEBAR_ROW_GAP`).
    public static let rowGap: CGFloat = 2
    /// The leading lane every mark stands in.
    public static let mark: CGFloat = 22
    public static let markGap: CGFloat = 10
    /// A nested row starts where its parent's label does.
    public static var indent: CGFloat { mark + markGap }
    /// The trailing square a status mark, an unread dot or a fold stands in.
    public static let trailing: CGFloat = 18
    public static let trailingGap: CGFloat = 8
    public static let unreadDot: CGFloat = 8
    public static let cornerRadius: CGFloat = 8
    /// A picture's rounding in its lane: a rounded square, never a circle.
    public static let pictureRadius: CGFloat = 6
    public static let labelSize: CGFloat = 16
    public static let sectionLabelSize: CGFloat = 12
    /// `letter-spacing: 0.08em`.
    public static let sectionTracking: CGFloat = 0.08
    /// The tree's lines, at 0.28 of the row ink.
    public static let connectorAlpha: CGFloat = 0.28
    /// Room above the first row and below the last.
    public static let contentTop: CGFloat = 4
    public static let contentBottom: CGFloat = 12
}
