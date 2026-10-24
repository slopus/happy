import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The Stem Cells sidebar's frames: one column of rows, each a fixed height
/// by its kind, so folding a section moves only the rows after it and no row
/// ever changes size.
public enum StemCellsSidebarLayout {
    public enum Kind: Equatable, Sendable {
        case row, section, separator, widget
    }

    /// What the layout needs to know about a row.
    public struct Row: Equatable, Sendable {
        public var kind: Kind
        public var depth: Int
        public var hasMark: Bool
        /// A status mark or an unread dot in the trailing square.
        public var hasTrailing: Bool

        public init(kind: Kind, depth: Int = 0, hasMark: Bool = true, hasTrailing: Bool = false) {
            self.kind = kind
            self.depth = depth
            self.hasMark = hasMark
            self.hasTrailing = hasTrailing
        }
    }

    public struct Frame: Equatable, Sendable {
        /// The row box: the tap target and its fill, in content coordinates.
        public var box: CGRect
        /// The leading mark, absent for a row without one; then the label starts there.
        public var mark: CGRect?
        public var label: CGRect
        /// The status mark or unread dot.
        public var trailing: CGRect?
        /// A section's fold chevron, on the same trailing column.
        public var chevron: CGRect?
        /// A separator's hairline, across the row box's whole width.
        public var rule: CGRect?
    }

    public struct Result: Equatable, Sendable {
        public var frames: [Frame]
        /// The tree's lines: vertical stems and the elbows into nested rows, 1pt wide.
        public var connectors: [CGRect]
        public var contentHeight: CGFloat
    }

    public static func height(_ kind: Kind) -> CGFloat {
        switch kind {
        case .row: StemCellsMetrics.rowHeight
        case .section: StemCellsMetrics.sectionHeight
        case .separator: StemCellsMetrics.separatorHeight
        case .widget: StemCellsMetrics.widgetMinHeight
        }
    }

    public static func layout(_ rows: [Row], width: CGFloat, top: CGFloat = StemCellsMetrics.contentTop, bottom: CGFloat = StemCellsMetrics.contentBottom) -> Result {
        typealias M = StemCellsMetrics
        var frames: [Frame] = []
        frames.reserveCapacity(rows.count)
        var y = top
        let boxX = M.inset
        let boxWidth = max(0, width - 2 * M.inset)
        for (index, row) in rows.enumerated() {
            if index > 0 { y += M.rowGap }
            let height = height(row.kind)
            let box = CGRect(x: boxX, y: y, width: boxWidth, height: height)
            let midY = y + height / 2
            let inkRight = boxX + boxWidth - M.padding
            let trailingRect = CGRect(x: inkRight - M.trailing, y: midY - M.trailing / 2, width: M.trailing, height: M.trailing)
            var frame = Frame(box: box, mark: nil, label: .zero, trailing: nil, chevron: nil, rule: nil)
            switch row.kind {
            case .separator:
                frame.rule = CGRect(x: boxX, y: midY - 0.5, width: boxWidth, height: 1)
            case .section:
                // The title keeps clear of the fold's lane, so showing the fold moves nothing.
                let x = boxX + M.padding
                frame.label = CGRect(x: x, y: y, width: max(0, trailingRect.minX - M.trailingGap - x), height: height)
                frame.chevron = trailingRect
            case .widget, .row:
                var x = boxX + M.padding + CGFloat(row.depth) * M.indent
                if row.hasMark {
                    frame.mark = CGRect(x: x, y: midY - M.mark / 2, width: M.mark, height: M.mark)
                    x += M.mark + M.markGap
                }
                var right = inkRight
                if row.hasTrailing {
                    frame.trailing = trailingRect
                    right = trailingRect.minX - M.trailingGap
                }
                frame.label = CGRect(x: x, y: y, width: max(0, right - x), height: height)
            }
            frames.append(frame)
            y += height
        }
        return Result(frames: frames, connectors: connectors(rows, frames), contentHeight: y + bottom)
    }

    /// A nested row hangs off a stem under its parent's mark: an elbow into
    /// the row at its middle, and the stem running on to its next sibling.
    static func connectors(_ rows: [Row], _ frames: [Frame]) -> [CGRect] {
        typealias M = StemCellsMetrics
        var lines: [CGRect] = []
        for (index, row) in rows.enumerated() where row.depth > 0 && row.kind == .row {
            let stemX = M.inset + M.padding + CGFloat(row.depth - 1) * M.indent + M.mark / 2
            let midY = frames[index].box.midY
            // From the parent's mark, or the row before at the same depth, down to this row's middle.
            var top = frames[index].box.minY
            if index > 0, rows[index - 1].depth == row.depth - 1, let mark = frames[index - 1].mark { top = mark.maxY }
            else if index > 0, rows[index - 1].depth == row.depth - 1 { top = frames[index - 1].box.midY + M.mark / 2 }
            lines.append(CGRect(x: stemX - 0.5, y: top, width: 1, height: max(0, midY - top)))
            let elbowEnd = frames[index].mark?.minX ?? frames[index].label.minX
            lines.append(CGRect(x: stemX, y: midY - 0.5, width: max(0, elbowEnd - 4 - stemX), height: 1))
            // The stem runs on past this row's subtree, gaps included, to the
            // sibling that follows it.
            var next = index + 1
            while next < rows.count, rows[next].depth > row.depth { next += 1 }
            if next < rows.count, rows[next].depth == row.depth, rows[next].kind == .row {
                lines.append(CGRect(x: stemX - 0.5, y: midY, width: 1, height: frames[next].box.minY - midY))
            }
        }
        return lines
    }
}
