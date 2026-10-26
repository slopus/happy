import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The composer's "+" sheet, as Claude's "Add to session" is laid out: a
/// header row with Photos at its left, the title in its middle and the
/// close circle at its right (`SheetCloseLayout`); under it a strip of square tiles (the camera,
/// then the newest photos) scrolling sideways; then one rounded group of
/// rows. Frames are in the sheet's own space; the strip's tiles and the
/// rows are in the strip's content and the group's own space.
public struct StemCellAttachSheetLayout: Equatable, Sendable {
    public enum Metrics {
        public static let padding: CGFloat = 16
        public static let top: CGFloat = 16
        public static let control: CGFloat = 44
        public static let titleHeight: CGFloat = 22
        /// Room between the title and the controls either side of it.
        public static let titleGap: CGFloat = 8
        public static let sectionGap: CGFloat = 16
        public static let tile: CGFloat = 104
        public static let tileGap: CGFloat = 8
        public static let tileRadius: CGFloat = 18
        public static let check: CGFloat = 24
        public static let checkInset: CGFloat = 6
        public static let rowHeight: CGFloat = 52
        public static let groupRadius: CGFloat = 18
        public static let icon: CGFloat = 24
        public static let iconLeading: CGFloat = 16
        public static let iconGap: CGFloat = 12
        public static let chevron: CGFloat = 14
        public static let trailing: CGFloat = 16
        public static let valueGap: CGFloat = 6
        public static let bottom: CGFloat = 16
    }

    public struct Row: Equatable, Sendable {
        /// The whole row, in the group's space.
        public var frame: CGRect
        public var icon: CGRect
        public var title: CGRect
        public var value: CGRect?
        public var chevron: CGRect?
        /// The hairline above it, from the title's start; none on the first.
        public var separator: CGRect?
    }

    public var close: CGRect
    public var title: CGRect
    /// Photos, or "Add N", at the left.
    public var photos: CGRect
    /// The strip, the sheet's whole width.
    public var strip: CGRect
    public var stripContentWidth: CGFloat
    public var tiles: [CGRect]
    public var group: CGRect
    public var rows: [Row]
    /// The sheet's height above its bottom safe area.
    public var height: CGFloat

    /// `values` holds each row's trailing value width, nil for a row
    /// without one (it then has no chevron either). `photosWidth` is the
    /// header's left button measured; `scale` rounds the hairline.
    public init(width: CGFloat, titleWidth: CGFloat, photosWidth: CGFloat, tiles count: Int, values: [CGFloat?], scale: CGFloat = 3) {
        typealias M = Metrics
        let width = max(0, width)
        close = SheetCloseLayout.frame(width: width)
        let photosWidth = ceil(max(0, photosWidth))
        photos = CGRect(x: M.padding, y: close.minY, width: photosWidth, height: M.control)
        // Centred on the sheet, never under the controls either side.
        let room = max(0, width - 2 * (M.padding + max(M.control, photosWidth) + M.titleGap))
        let shown = min(ceil(max(0, titleWidth)), room)
        title = CGRect(x: ((width - shown) / 2).rounded(), y: close.midY - M.titleHeight / 2, width: shown, height: M.titleHeight)

        strip = CGRect(x: 0, y: close.maxY + M.sectionGap, width: width, height: M.tile)
        tiles = (0..<max(0, count)).map { index in
            CGRect(x: M.padding + CGFloat(index) * (M.tile + M.tileGap), y: 0, width: M.tile, height: M.tile)
        }
        stripContentWidth = (tiles.last?.maxX ?? 0) + M.padding

        group = CGRect(x: M.padding, y: strip.maxY + M.sectionGap, width: max(0, width - 2 * M.padding), height: CGFloat(values.count) * M.rowHeight)
        let groupWidth = group.width
        let hairline = 1 / max(1, scale)
        rows = values.enumerated().map { index, value in
            let frame = CGRect(x: 0, y: CGFloat(index) * M.rowHeight, width: groupWidth, height: M.rowHeight)
            let icon = CGRect(x: M.iconLeading, y: frame.midY - M.icon / 2, width: M.icon, height: M.icon)
            let titleX = icon.maxX + M.iconGap
            var end = groupWidth - M.trailing
            var chevron: CGRect?
            var shownValue: CGRect?
            if let value {
                let arrow = CGRect(x: end - M.chevron, y: frame.midY - M.chevron / 2, width: M.chevron, height: M.chevron)
                chevron = arrow
                let valueWidth = min(ceil(max(0, value)), max(0, (arrow.minX - M.valueGap - titleX) / 2))
                let box = CGRect(x: arrow.minX - M.valueGap - valueWidth, y: frame.midY - M.titleHeight / 2, width: valueWidth, height: M.titleHeight)
                shownValue = box
                end = box.minX - M.valueGap
            }
            return Row(
                frame: frame, icon: icon,
                title: CGRect(x: titleX, y: frame.midY - M.titleHeight / 2, width: max(0, end - titleX), height: M.titleHeight),
                value: shownValue, chevron: chevron,
                separator: index == 0 ? nil : CGRect(x: titleX, y: frame.minY, width: max(0, groupWidth - titleX), height: hairline)
            )
        }
        height = group.maxY + M.bottom
    }

    /// The numbered check in a tile's corner, in the tile's space.
    public static var check: CGRect {
        CGRect(x: Metrics.tile - Metrics.checkInset - Metrics.check, y: Metrics.checkInset, width: Metrics.check, height: Metrics.check)
    }
}
