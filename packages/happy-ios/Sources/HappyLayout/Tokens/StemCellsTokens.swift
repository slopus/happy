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
    /// The working line's loader, clock and phase (`--text-secondary`), and
    /// the "·" between them (`--input-placeholder`).
    public static let stemCellsWorkingText = ColorToken("#49454f", "#cac4d0")
    public static let stemCellsWorkingSeparator = ColorToken("#999999", "#8e8e93")
    /// A usage ring (`UsageRing`): its quiet track, its arc, and the arc
    /// when little or almost nothing is left.
    public static let stemCellsUsageTrack = ColorToken("#c0c0c0", "#48484a")
    public static let stemCellsUsageArc = ColorToken("#49454f", "#cac4d0")
    public static let stemCellsUsageLow = ColorToken("#ff9500", "#ffab00")
    public static let stemCellsUsageCritical = ColorToken("#ff3b30", "#ff453a")
    /// A recording's play button over its first frame, and its glyph.
    public static let stemCellsPlayFill = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.55), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.55))
    public static let stemCellsPlayGlyph = ColorToken("#ffffff")
    /// A result card (`ResultCard`): its fill (`--surface`), its chip
    /// (`--surface-selected`), its title (`--text`) and its glyph, detail and
    /// chevron (`--text-secondary`); its ring is `stemCellsDivider`.
    public static let stemCellsCardFill = ColorToken("#ffffff", "#212121")
    public static let stemCellsCardChip = ColorToken("#eaeaea", "#2c2c2e")
    public static let stemCellsCardTitle = ColorToken("#000000", "#ffffff")
    public static let stemCellsCardDetail = ColorToken("#49454f", "#cac4d0")
    /// A media layout's text tones (`data-tone`): default, muted, accent.
    public static let stemCellsTreeText = ColorToken("#000000", "#ffffff")
    public static let stemCellsTreeMuted = ColorToken("#49454f", "#cac4d0")
    public static let stemCellsTreeAccent = ColorToken("#2baccc")
    /// A picture that could not be read: its quiet glyph over the placeholder.
    public static let stemCellsMediaFailed = ColorToken("#49454f", "#cac4d0")
    /// A picture opened on its own: black behind it, white controls.
    public static let stemCellsViewerGround = ColorToken("#000000")
    public static let stemCellsViewerControl = ColorToken("#ffffff")
    /// A sidebar proposal (`SidebarProposal`): its card's hairline
    /// (`--modal-border`) on `stemCellsCardFill`, the rows on
    /// `stemCellsBackground`; "Use this sidebar" black in both themes with
    /// white ink (`--button-primary-*`), grey while it waits; "Keep mine" on
    /// `stemCellsButton` ringed in `stemCellsDivider`; a refusal's notice
    /// (`--status-error`).
    public static let stemCellsProposalBorder = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.1), dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.1))
    public static let stemCellsPrimaryButton = ColorToken("#000000")
    public static let stemCellsPrimaryButtonInk = ColorToken("#ffffff")
    public static let stemCellsPrimaryButtonDisabled = ColorToken("#c0c0c0")
    public static let stemCellsNotice = ColorToken("#ff3b30", "#ff453a")
    /// A row pulled open: its quiet action, its destructive one, and their ink.
    public static let stemCellsSwipeAction = ColorToken("#8e8e93", "#636366")
    public static let stemCellsSwipeDestructive = ColorToken("#ff3b30", "#ff453a")
    public static let stemCellsSwipeInk = ColorToken("#ffffff")

    /// Settings, after Telegram's: the ground under the cards, a card, its
    /// separators, a row's title and quieter value, and the red of leaving.
    public static let stemCellsSettingsGround = ColorToken("#efeff4", "#000000")
    public static let stemCellsSettingsCard = ColorToken("#ffffff", "#1c1c1e")
    public static let stemCellsSettingsSeparator = ColorToken("#c8c7cc", "#38383a")
    public static let stemCellsSettingsText = ColorToken("#000000", "#ffffff")
    public static let stemCellsSettingsSecondary = ColorToken("#8e8e93", "#98989f")
    public static let stemCellsSettingsDestructive = ColorToken("#ff3b30", "#ff453a")
    /// The chosen profile's ring, and the bar's glass buttons' glyphs.
    public static let stemCellsSettingsRing = ColorToken("#000000", "#ffffff")
    /// The squares under a row's white glyph (iOS's system colours).
    public static let stemCellsSettingsTileOrange = ColorToken("#ff9500")
    public static let stemCellsSettingsTileGray = ColorToken("#8e8e93")
    public static let stemCellsSettingsTileBlue = ColorToken("#007aff")
    public static let stemCellsSettingsTilePurple = ColorToken("#af52de")
    public static let stemCellsSettingsTileGreen = ColorToken("#34c759")
    public static let stemCellsSettingsGlyph = ColorToken("#ffffff")
    /// The QR sheet's first button and its ink; the second's tint.
    public static let stemCellsSettingsPrimary = ColorToken("#007aff", "#0a84ff")
    public static let stemCellsSettingsPrimaryInk = ColorToken("#ffffff")
    public static let stemCellsSettingsSecondaryFill = ColorToken(light: RGBA(red: 0, green: 0.478, blue: 1, alpha: 0.1), dark: RGBA(red: 0.039, green: 0.518, blue: 1, alpha: 0.15))
    /// The "+" circle at the end of the profiles.
    public static let stemCellsSettingsAddFill = ColorToken("#e5e5ea", "#2c2c2e")
}

public enum StemCellsMetrics {
    /// A shimmer's pale band (`ShimmerText` `sheen`): the ink mixed 15%
    /// into its ground; one sweep takes 1.6s.
    public static let sheenInk: CGFloat = 0.15
    public static let sheenDuration: Double = 1.6
    // Desktop's sidebar at its own pixels, a point for a pixel: `Sidebar.tsx`
    // (`SIDEBAR_ROW_HEIGHT` and the rest), `styles/sidebar.css`, `theme.css`.
    /// The row box's inset from the screen's edges (`--happy-panel-inset`).
    public static let inset: CGFloat = 6
    /// Ink's inset inside the row box (`--happy-panel-row-padding`, `SIDEBAR_ROW_PADDING_X`).
    public static let padding: CGFloat = 10
    /// `SIDEBAR_ROW_HEIGHT`.
    public static let rowHeight: CGFloat = 32
    /// `.happy-sidebar__section-item`.
    public static let sectionHeight: CGFloat = 28
    /// `.happy-sidebar__separator`.
    public static let separatorHeight: CGFloat = 17
    public static let widgetMinHeight: CGFloat = 32
    /// Between one row and the next (`SIDEBAR_ROW_GAP`).
    public static let rowGap: CGFloat = 2
    /// The leading lane every mark stands in (`SIDEBAR_LEADING_SLOT`, the `xs` avatar).
    public static let mark: CGFloat = 20
    /// A glyph's size in that lane.
    public static let glyph: CGFloat = 16
    /// The row's flex gap: mark to label, label to trailing lane.
    public static let markGap: CGFloat = 8
    /// Added per nesting level (`SIDEBAR_ROW_INDENT`).
    public static let indent: CGFloat = 16
    /// A nested row's branch box (`.happy-sidebar__item-branch`): 20 wide,
    /// pulled back 16, so its centre is the parent's stem; the elbow runs 9.
    public static let branch: CGFloat = 20
    public static let branchPull: CGFloat = 16
    public static let elbow: CGFloat = 9
    /// How far under the parent's middle its stem starts (`SIDEBAR_BRANCH_STEM_INSET`).
    public static let stemInset: CGFloat = 10
    /// The trailing square a status mark, an unread dot or a fold stands in (`SIDEBAR_SLOT_CELL`).
    public static let trailing: CGFloat = 18
    public static let trailingGap: CGFloat = 8
    /// `.happy-sidebar__item-unread`.
    public static let unreadDot: CGFloat = 6
    /// `--happy-hover-radius`.
    public static let cornerRadius: CGFloat = 6
    /// A picture's rounding in its lane: a rounded square, never a circle.
    public static let pictureRadius: CGFloat = 6
    /// `.happy-sidebar__item-label`: 13, weight 500, line 16.
    public static let labelSize: CGFloat = 13
    /// `.happy-sidebar__section-item-label`: mono 11, bold.
    public static let sectionLabelSize: CGFloat = 11
    /// `letter-spacing: 0.08em`.
    public static let sectionTracking: CGFloat = 0.08
    /// The tree's lines, at 0.28 of the row ink.
    public static let connectorAlpha: CGFloat = 0.28
    /// Room above the first row and below the last (`.happy-sidebar__body-content`).
    public static let contentTop: CGFloat = 6
    public static let contentBottom: CGFloat = 6
}
