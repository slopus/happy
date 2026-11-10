#if canImport(CoreGraphics)
import CoreGraphics
#endif
import Foundation

/// A `media` component's pictures and recordings (happy-agent
/// `ui/components/media.ts`), by the one rule every client shares
/// (happy-desktop `uiMediaLayout.ts`), from the items' stated sizes alone,
/// so nothing moves when their bytes come; every box in whole points:
///
///     one item   min(the column, 320 × its aspect) wide, at the left
///     rows       6 apart; a row takes items while it fits the width 160
///                tall, or while filling the width with the next one lands
///                nearer 160 than without it; then it grows or shrinks to
///                fill the width, 240 tall at most; the last row stays 160
///                tall at the left, shrinking only to fit the width
///     shapes     held to 0.4…3 wide per tall for the layout; the picture
///                covers its box; one that states no size is 4:3, or 16:9
///                for a recording
///     labels     one 18 line 4 under its item: a row with any label is
///                that much taller
public struct MediaRows: Equatable, Sendable {
    public enum Metrics {
        public static let rowHeight: CGFloat = 160
        public static let gap: CGFloat = 6
        /// A filled row grows to at most 1.5 times the row height.
        public static let maxGrowth: CGFloat = 1.5
        /// One item alone: at most twice the row height.
        public static let singleHeight: CGFloat = 320
        public static let minAspect: CGFloat = 0.4
        public static let maxAspect: CGFloat = 3
        public static let labelGap: CGFloat = 4
        public static let labelLine: CGFloat = 18
    }

    /// One item: its snapshot's size, and whether a label goes under it.
    public struct Item: Equatable, Sendable {
        public var width: CGFloat?
        public var height: CGFloat?
        public var isVideo: Bool
        public var labelled: Bool

        public init(width: CGFloat?, height: CGFloat?, isVideo: Bool = false, labelled: Bool = false) {
            self.width = width
            self.height = height
            self.isVideo = isVideo
            self.labelled = labelled
        }

        /// Its aspect for the layout: its own, held to 0.4…3.
        public var aspect: CGFloat {
            let own: CGFloat = if let width, let height, width > 0, height > 0 { width / height } else { isVideo ? 16 / 9 : 4 / 3 }
            return min(Metrics.maxAspect, max(Metrics.minAspect, own))
        }
    }

    public struct Tile: Equatable, Sendable {
        public var frame: CGRect
        /// Its label's line, when it has one.
        public var label: CGRect?

        public init(frame: CGRect, label: CGRect? = nil) {
            self.frame = frame
            self.label = label
        }
    }

    /// One per item, in the items' order.
    public var tiles: [Tile]
    public var size: CGSize

    /// `width` is the column, from x 0.
    public init(width: CGFloat, items: [Item], rowHeight: CGFloat = Metrics.rowHeight) {
        typealias M = Metrics
        let available = max(1, width.rounded(.down))
        let aspects = items.map(\.aspect)
        var tiles: [Tile] = []
        var y: CGFloat = 0
        func row(_ placed: [(index: Int, width: CGFloat)], height: CGFloat) {
            if !tiles.isEmpty { y += M.gap }
            let labelled = placed.contains { items[$0.index].labelled }
            var x: CGFloat = 0
            for one in placed {
                let frame = CGRect(x: x, y: y, width: one.width, height: height)
                let label = items[one.index].labelled ? CGRect(x: x, y: frame.maxY + M.labelGap, width: one.width, height: M.labelLine) : nil
                tiles.append(Tile(frame: frame, label: label))
                x = frame.maxX + M.gap
            }
            y += height + (labelled ? M.labelGap + M.labelLine : 0)
        }
        if aspects.count == 1 {
            let pictureWidth = min(available, M.singleHeight / M.rowHeight * rowHeight * aspects[0]).rounded()
            row([(0, pictureWidth)], height: (pictureWidth / aspects[0]).rounded())
        } else {
            var start = 0
            while start < aspects.count {
                var sum = aspects[start]
                var end = start + 1
                while end < aspects.count {
                    let next = sum + aspects[end]
                    let gapsNext = M.gap * CGFloat(end - start)
                    // It fits at the row height; or, filled, the row with it comes nearer than without.
                    let fits = next * rowHeight + gapsNext <= available
                    let without = (available - gapsNext + M.gap) / sum
                    let nearer = abs((available - gapsNext) / next - rowHeight) < abs(without - rowHeight)
                    if !fits, !nearer { break }
                    sum = next
                    end += 1
                }
                let gaps = M.gap * CGFloat(end - start - 1)
                // Filled when another item was waiting for room; the last row keeps the row height.
                let filled = end < aspects.count
                let fit = (available - gaps) / sum
                let height = min(filled ? M.maxGrowth * rowHeight : rowHeight, fit)
                let stretched = filled && height == fit
                // A filled row's edges are rounded from running totals, so its widths add up to the width.
                var placed: [(index: Int, width: CGFloat)] = []
                var edge: CGFloat = 0
                for index in start..<end {
                    let after = edge + aspects[index] * height
                    let right = stretched && index == end - 1 ? available - gaps : after.rounded()
                    placed.append((index, right - edge.rounded()))
                    edge = after
                }
                row(placed, height: height.rounded())
                start = end
            }
        }
        self.tiles = tiles
        size = CGSize(width: width, height: y)
    }
}
