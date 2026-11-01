import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The System Monitor's cards (`MonitorSummaryLayout` and the rest): the
/// desktop's machine overview as home's inset grouped cards.
public enum MonitorMetrics {
    /// A card's room above its first line and below its last.
    public static let padding: CGFloat = 14
    /// The resource's glyph tile, and the gap to its name.
    public static let tile: CGFloat = 30
    public static let tileGlyph: CGFloat = 17
    public static let tileGap: CGFloat = 10
    /// Between the tile's line and the subtitle under it.
    public static let subtitleGap: CGFloat = 8
    /// The history chart under a reading, and the per-core bars under that.
    public static let chartHeight: CGFloat = 72
    public static let chartGap: CGFloat = 12
    public static let barsHeight: CGFloat = 28
    public static let barsGap: CGFloat = 10
    public static let barGap: CGFloat = 2
    /// A detail row: never shorter, its meter under its line.
    public static let detailRow: CGFloat = 40
    public static let detailPadding: CGFloat = 10
    public static let meterHeight: CGFloat = 4
    public static let meterGap: CGFloat = 6
    public static let noteGap: CGFloat = 4
    /// A process's CPU over the last minute, before its percentage.
    public static let sparkWidth: CGFloat = 44
    public static let sparkHeight: CGFloat = 16
    public static let sparkGap: CGFloat = 8
    /// The status's dot, before its words.
    public static let statusDot: CGFloat = 8
    public static let statusGap: CGFloat = 6

    public static let hostTitleSize: CGFloat = 22
    public static let titleSize: CGFloat = 15
    public static let valueSize: CGFloat = 22
    public static let textSize: CGFloat = 15
    public static let smallSize: CGFloat = 13
}

extension Palette {
    /// The desktop's levels: calm, warm and hot, and the second line of a
    /// chart of two (disk writes).
    public static let monitorCalm = tileBlue
    public static let monitorWarm = tileOrange
    public static let monitorHot = tileRed
    public static let monitorLive = tileGreen
    /// A meter's or a chart's ground, and its faint guide lines.
    public static let monitorTrack = ColorToken("#e6e6ea", "#38383c")
    public static let monitorGrid = ColorToken("#ececf0", "#2a2a2d")
}
