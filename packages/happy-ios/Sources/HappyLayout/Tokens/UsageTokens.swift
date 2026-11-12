import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// Settings › Usage: desktop's HappyAgentUsageSettings.tsx,
// UsageActivityGrid.tsx and usage-activity-grid.css.

extension Palette {
    /// The grid's shades are this at `UsageMetrics.levelAlpha` (desktop's
    /// `--text-link`), so the same five read in light and dark alike.
    public static let usageActivity = ColorToken("#2baccc")
    /// A day that spent nothing (`--surface-selected`).
    public static let usageActivityNone = ColorToken("#eaeaea", "#2c2c2e")
    /// A tapped cell's outline (`--text-secondary`).
    public static let usageActivitySelected = ColorToken("#8e8e93", "#98989f")
    /// The day's callout: its ground and hairline (`--surface`,
    /// `--modal-border`) and its shadow.
    public static let usageCallout = ColorToken("#ffffff", "#2c2c2e")
    public static let usageCalloutBorder = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.1), dark: RGBA(red: 1, green: 1, blue: 1, alpha: 0.12))
    public static let usageCalloutShadow = ColorToken(light: RGBA(red: 0, green: 0, blue: 0, alpha: 0.12), dark: RGBA(red: 0, green: 0, blue: 0, alpha: 0.4))
}

public enum UsageMetrics {
    // The grid: one 10pt cell a day on a 12pt pitch.
    public static let cell: CGFloat = 10
    public static let gap: CGFloat = 2
    public static let step: CGFloat = cell + gap
    public static let cellRadius: CGFloat = 2
    /// Level 0 to 4: nothing, then the quartiles.
    public static let levelAlpha: [CGFloat] = [1, 0.25, 0.45, 0.7, 1]
    /// The month row over the weeks, and the gap under it.
    public static let monthRow: CGFloat = 16
    public static let monthGap: CGFloat = 4
    /// Between the weekday column and the weeks.
    public static let weekdayGap: CGFloat = 6
    /// A month's label needs this many columns before the next.
    public static let monthMinColumns = 3
    public static let monthSize: CGFloat = 11
    public static let weekdaySize: CGFloat = 9

    // The page: a section's title and line over its card.
    public static let top: CGFloat = 20
    public static let side: CGFloat = 16
    public static let headerInset: CGFloat = 16
    public static let titleGap: CGFloat = 2
    public static let headerGap: CGFloat = 8
    public static let sectionGap: CGFloat = 24
    public static let bottom: CGFloat = 32
    public static let padding: CGFloat = 16
    public static let radius: CGFloat = 26
    public static let separator: CGFloat = 1 / 3
    public static let titleSize: CGFloat = 15
    public static let subtitleSize: CGFloat = 13

    // An account: its name and plan, its strip, its windows, its models.
    public static let nameLine: CGFloat = 20
    public static let nameSize: CGFloat = 15
    public static let planSize: CGFloat = 13
    public static let planGap: CGFloat = 8
    public static let itemGap: CGFloat = 6
    public static let limitLine: CGFloat = 20
    public static let lineSize: CGFloat = 13
    /// Where "resets …" starts, past "Week" and "Session".
    public static let labelColumn: CGFloat = 56
    public static let labelGap: CGFloat = 8
    public static let gaugeGap: CGFloat = 8
    public static let modelsGap: CGFloat = 4
    public static let modelLine: CGFloat = 16
    public static let modelGap: CGFloat = 2
    public static let modelIdSize: CGFloat = 11
    public static let modelSize: CGFloat = 12
    public static let modelIdGap: CGFloat = 12

    // The day's callout.
    public static let calloutPaddingX: CGFloat = 8
    public static let calloutPaddingY: CGFloat = 6
    public static let calloutLine: CGFloat = 16
    public static let calloutLineGap: CGFloat = 2
    public static let calloutModelGap: CGFloat = 12
    public static let calloutMaxWidth: CGFloat = 280
    public static let calloutGap: CGFloat = 6
    public static let calloutMargin: CGFloat = 8
    public static let calloutRadius: CGFloat = 8
    public static let calloutSize: CGFloat = 13
    public static let calloutIdSize: CGFloat = 12

    // Nothing to show yet.
    public static let emptyGap: CGFloat = 6
    public static let emptySide: CGFloat = 32
}
