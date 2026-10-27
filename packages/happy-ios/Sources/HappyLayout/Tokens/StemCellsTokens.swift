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
    /// The composer's "+" sheet: its ground, and the fill of its rows'
    /// group and camera tile, as iOS's grouped lists draw them.
    public static let stemCellsAttachGround = ColorToken("#F2F2F7", "#1C1C1E")
    public static let stemCellsAttachFill = ColorToken("#FFFFFF", "#2C2C2E")
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
    public static let stemCellsSettingsTileRed = ColorToken("#ff3b30")
    public static let stemCellsSettingsTileTeal = ColorToken("#30b0c7")
    public static let stemCellsSettingsTileIndigo = ColorToken("#5856d6")
    public static let stemCellsSettingsGlyph = ColorToken("#ffffff")
    /// The QR sheet's first button and its ink; the second's tint.
    public static let stemCellsSettingsPrimary = ColorToken("#007aff", "#0a84ff")
    public static let stemCellsSettingsPrimaryInk = ColorToken("#ffffff")
    public static let stemCellsSettingsSecondaryFill = ColorToken(light: RGBA(red: 0, green: 0.478, blue: 1, alpha: 0.1), dark: RGBA(red: 0.039, green: 0.518, blue: 1, alpha: 0.15))
    /// The "+" circle at the end of the profiles.
    public static let stemCellsSettingsAddFill = ColorToken("#e5e5ea", "#2c2c2e")

    /// A held row, as Telegram's context menu themes it (day and night
    /// `PresentationThemeContextMenu`): the dim over the blurred sidebar,
    /// the menu's tint over its blur, its lines, a pressed item, its ink,
    /// and the red of putting away.
    public static let stemCellsHoldDim = ColorToken(light: RGBA(red: 0, green: 10 / 255.0, blue: 38 / 255.0, alpha: 0.2), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.6))
    public static let stemCellsHoldMenu = ColorToken(light: RGBA(red: 249 / 255.0, green: 249 / 255.0, blue: 249 / 255.0, alpha: 0.78), dark: RGBA(red: 37 / 255.0, green: 37 / 255.0, blue: 37 / 255.0, alpha: 0.78))
    public static let stemCellsHoldSeparator = ColorToken(light: RGBA(red: 138 / 255.0, green: 138 / 255.0, blue: 138 / 255.0, alpha: 0.2), dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.15))
    public static let stemCellsHoldHighlight = ColorToken(light: RGBA(red: 60 / 255.0, green: 60 / 255.0, blue: 67 / 255.0, alpha: 0.2), dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.15))
    public static let stemCellsHoldInk = ColorToken("#000000", "#ffffff")
    public static let stemCellsHoldDestructive = ColorToken("#ff3b30", "#eb5545")

    /// The model and effort lists, iOS's menus over their glass: a pressed
    /// line or heading, the hairline, the ink and the quiet ink, and the
    /// shadow under the panel.
    public static let stemCellsPanelPressed = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.08), dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.12))
    public static let stemCellsPanelDivider = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.1), dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.12))
    public static let stemCellsPanelShadow = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.16), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.4))
    public static let stemCellsPanelText = ColorToken("#000000", "#ffffff")
    public static let stemCellsPanelSecondary = ColorToken(light: RGBA(red: 60 / 255.0, green: 60 / 255.0, blue: 67 / 255.0, alpha: 0.6), dark: RGBA(red: 235 / 255.0, green: 235 / 255.0, blue: 245 / 255.0, alpha: 0.6))
    /// A usage ring (`UsageRing`): its quiet track, its arc, and the arc
    /// when little or almost nothing is left.
    public static let stemCellsUsageTrack = ColorToken("#c0c0c0", "#48484a")
    public static let stemCellsUsageArc = ColorToken("#49454f", "#cac4d0")
    public static let stemCellsUsageLow = ColorToken("#ff9500", "#ffab00")
    public static let stemCellsUsageCritical = ColorToken("#ff3b30", "#ff453a")
}

/// The model control panels as iOS's own menus draw theirs: liquid glass,
/// about 250 wide, 17pt lines 44 tall with the check in a column before the
/// names; desktop's headings, gauges and account windows inside.
public enum StemCellPickerMetrics {
    /// The panel's padding above and below its lines, and at its sides.
    public static let inset: CGFloat = 8
    /// Between a panel's blocks: services, hairlines, the footer.
    public static let gap: CGFloat = 5
    /// A menu's corners.
    public static let radius: CGFloat = 24
    /// Its shadow: soft and wide under the glass.
    public static let shadowRadius: CGFloat = 24
    public static let shadowY: CGFloat = 8
    /// A model, effort or account line, and a service's heading.
    public static let row: CGFloat = 44
    public static let heading: CGFloat = 32
    /// A line's text inset, and its highlight 2 inside it.
    public static let padding: CGFloat = 12
    public static let highlightInset: CGFloat = 2
    public static let highlightRadius: CGFloat = 14
    public static let labelSize: CGFloat = 17
    public static let headingSize: CGFloat = 13
    public static let linkSize: CGFloat = 15
    /// The check, in the column before every name: names start `checkColumn`
    /// past the line's padding, picked or not.
    public static let check: CGFloat = 15
    public static let checkColumn: CGFloat = 23
    /// Between a name and the gauge after it.
    public static let checkGap: CGFloat = 8
    /// A heading: its service, 5, its account (at most 110 wide), its
    /// usage 8 apart, and its chevron.
    public static let headingGap: CGFloat = 5
    public static let accountMax: CGFloat = 110
    public static let usageGap: CGFloat = 8
    public static let chevron: CGFloat = 13
    /// A usage gauge: its number, 4, a ring 13 across.
    public static let gaugeSize: CGFloat = 13
    public static let ring: CGFloat = 13
    public static let ringGap: CGFloat = 4
    /// The account's windows under its list: 7 in at top and bottom, lines
    /// 5 apart, the week's 22 high, the rest 18; a window's name at least
    /// 48 wide, so the times start together.
    public static let detailsInsetY: CGFloat = 7
    public static let detailsLine: CGFloat = 18
    public static let detailsPrimaryLine: CGFloat = 22
    public static let detailsLabelMin: CGFloat = 48
    public static let detailsGap: CGFloat = 8
    /// The panel stands 10 over its chip, at least 8 from the screen's edges.
    public static let anchorGap: CGFloat = 10
    public static let margin: CGFloat = 8
    public static let maxHeight: CGFloat = 560
    /// Widths: a menu's. The model list 200 to 250, effort 160 to 250,
    /// accounts 250 to 280 (their windows' times); a longer name ends early.
    public static let modelsMinWidth: CGFloat = 200
    public static let modelsMaxWidth: CGFloat = 250
    public static let effortsMinWidth: CGFloat = 160
    public static let accountsMinWidth: CGFloat = 250
    public static let accountsMaxWidth: CGFloat = 280
}

public enum StemCellsMetrics {
    /// A shimmer's pale band (`ShimmerText` `sheen`): the ink mixed 15%
    /// into its ground; one sweep takes 1.6s.
    public static let sheenInk: CGFloat = 0.15
    public static let sheenDuration: Double = 1.6
    // Desktop's sidebar at its own pixels (`Sidebar.tsx`: `SIDEBAR_ROW_HEIGHT`
    // and the rest, `styles/sidebar.css`, `theme.css`), half again as big on
    // the phone: rows, gaps, type and marks all `phone` times desktop's.
    // Nesting stays tight.
    /// How much bigger than desktop's the phone draws the sidebar.
    public static let phone: CGFloat = 1.5
    /// The row box's inset from the screen's edges.
    public static let inset: CGFloat = 8
    /// `SIDEBAR_ROW_HEIGHT`.
    public static let rowHeight: CGFloat = 32 * phone
    /// Each end of a row holds its mark in a square the row's height: the
    /// mark's optical centre half the row in from the row box's side, as
    /// far as it is from the box's top (desktop's 16 in a 32 row).
    public static let endInset: CGFloat = rowHeight / 2
    /// A top-level mark's centre, from the screen's left edge.
    public static let markCenter: CGFloat = inset + endInset
    /// The fold's optical centre, and the trailing square's, from the right edge.
    public static let trailingCenter: CGFloat = inset + endInset
    /// A row's title, lifted so its x-height's middle is the row's middle,
    /// where the end marks' centres are. Figtree 19.5 centred in the row
    /// sets its baseline at 30.83 (line 23.4, ascender 18.53) and its
    /// x-height (9.75) from 21.08: middle 25.95, 1.95 below the row's 24.
    /// On whole pixels at 3x, 2 (`StemCellsRowInkTests` measures it).
    public static let titleLift: CGFloat = 2
    /// Where a fold chevron's ink weighs, from its image's centre, at
    /// `chevronGlyph` (alpha-weighted at 3x; `StemCellsRowInkTests`):
    /// a "⌄" is heavier at its top, a "›" at its left.
    public static let chevronDownInk = CGVector(dx: 0, dy: -0.34)
    public static let chevronRightInk = CGVector(dx: -0.21, dy: -0.13)
    /// A section heading's title: desktop's row padding 10 in, which is
    /// where a top-level glyph's ink starts.
    public static let sectionTitleInset: CGFloat = 10 * phone
    /// `.happy-sidebar__section-item`.
    public static let sectionHeight: CGFloat = 28 * phone
    /// `.happy-sidebar__separator`.
    public static let separatorHeight: CGFloat = (17 * phone).rounded()
    public static let widgetMinHeight: CGFloat = 32 * phone
    /// Between one row and the next (`SIDEBAR_ROW_GAP`).
    public static let rowGap: CGFloat = 2 * phone
    /// The leading lane every mark stands in (`SIDEBAR_LEADING_SLOT`, the `xs` avatar).
    public static let mark: CGFloat = 20 * phone
    /// A glyph's size in that lane.
    public static let glyph: CGFloat = 16 * phone
    /// The row's flex gap: mark to label, label to trailing lane.
    public static let markGap: CGFloat = 8 * phone
    /// A nested row's mark stands this far right of its parent's: desktop's
    /// 28 (a mark and its gap), not scaled, so nesting stays narrow.
    public static let indent: CGFloat = 28
    /// The parent's stem runs down its mark's centre, from under the mark,
    /// and an elbow runs from it to `elbowGap` short of the child's mark.
    public static let stemInset: CGFloat = mark / 2
    public static let elbowGap: CGFloat = 4
    /// The trailing square a status mark, an unread dot or a fold stands in (`SIDEBAR_SLOT_CELL`).
    public static let trailing: CGFloat = 18 * phone
    public static let trailingGap: CGFloat = 8 * phone
    /// `.happy-sidebar__item-unread`.
    /// `--happy-hover-radius`.
    public static let cornerRadius: CGFloat = 6 * phone
    /// A picture's rounding in its lane: a rounded square, never a circle.
    public static let pictureRadius: CGFloat = 6 * phone
    /// `.happy-sidebar__item-label`: 13, weight 500, line 16.
    public static let labelSize: CGFloat = 13 * phone
    /// `.happy-sidebar__section-item-label`: mono 11, bold.
    public static let sectionLabelSize: CGFloat = 11 * phone
    /// `letter-spacing: 0.08em`.
    public static let sectionTracking: CGFloat = 0.08
    /// The tree's lines and a separator's rule: desktop's, not scaled.
    public static let line: CGFloat = 1
    /// The fold's chevron, the question and the clock in the trailing square.
    public static let chevronGlyph: CGFloat = 12 * phone
    public static let questionGlyph: CGFloat = 15 * phone
    public static let clockGlyph: CGFloat = 14 * phone
    /// A section's "+".
    public static let addGlyph: CGFloat = 14 * phone
    /// The tree's lines, at 0.28 of the row ink.
    public static let connectorAlpha: CGFloat = 0.28
    /// Room above the first row and below the last (`.happy-sidebar__body-content`).
    public static let contentTop: CGFloat = 6 * phone
    public static let contentBottom: CGFloat = 6 * phone
}

extension ChatTextStyles {
    /// A message from another agent (`agent-activity-row.css`): its sender,
    /// what it said it is, and the message opened under them.
    public static let stemCellsActivityVerb = ChatTextStyle(.figtree(.medium), size: 14, lineHeight: 20)
    public static let stemCellsActivityText = ChatTextStyle(.figtree(.regular), size: 14, lineHeight: 20)
    public static let stemCellsActivityBody = ChatTextStyle(.figtree(.regular), size: 12, lineHeight: 18)
    public static func stemCellsActivityHeader(_ level: Int) -> ChatTextStyle {
        ChatTextStyle(.figtree(.semibold), size: 12, lineHeight: 18)
    }
}
