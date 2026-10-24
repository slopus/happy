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
                frame.rule = CGRect(x: boxX, y: (midY - 0.5).rounded(.down), width: boxWidth, height: 1)
            case .section:
                // The title keeps clear of the fold's lane (`padding-right:
                // row padding + 22`), so showing the fold moves nothing.
                let x = boxX + M.padding
                frame.label = CGRect(x: x, y: y, width: max(0, trailingRect.minX - sectionFoldGap - x), height: height)
                frame.chevron = trailingRect
            case .widget, .row:
                var x = leadingX(depth: row.depth)
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

    /// Between a section's title and its fold: `22 − 18`.
    static let sectionFoldGap: CGFloat = 4

    /// Where a row's mark (or, without one, its label) starts. A nested row is
    /// padded `SIDEBAR_ROW_INDENT` per level and leads with its branch box,
    /// pulled back under the parent's lane, then the row's gap.
    static func leadingX(depth: Int) -> CGFloat {
        typealias M = StemCellsMetrics
        let padded = M.inset + M.padding + CGFloat(depth) * M.indent
        return depth > 0 ? padded - M.branchPull + M.branch + M.markGap : padded
    }

    /// `SidebarTreeConnectors`: one stem per parent at the centre of its
    /// children's branch boxes, from `SIDEBAR_BRANCH_STEM_INSET` under the
    /// parent's middle to a point past its last child's, and a 9-long elbow
    /// into each child at its middle.
    static func connectors(_ rows: [Row], _ frames: [Frame]) -> [CGRect] {
        typealias M = StemCellsMetrics
        var lines: [CGRect] = []
        var parents: [Int: Int] = [:]
        var children: [Int: [Int]] = [:]
        var order: [Int] = []
        for (index, row) in rows.enumerated() where row.depth > 0 && row.kind == .row {
            var parent = index - 1
            while parent >= 0, rows[parent].depth >= row.depth { parent -= 1 }
            guard parent >= 0, rows[parent].depth == row.depth - 1 else { continue }
            parents[index] = parent
            if children[parent] == nil { order.append(parent) }
            children[parent, default: []].append(index)
        }
        for parent in order {
            let kids = children[parent] ?? []
            let stemX = M.inset + M.padding + CGFloat(rows[parent].depth) * M.indent + M.branch / 2
            let top = frames[parent].box.midY + M.stemInset
            let bottom = (kids.map { frames[$0].box.midY }.max() ?? top) + 1
            lines.append(CGRect(x: stemX - 0.5, y: top, width: 1, height: max(0, bottom - top)))
            for kid in kids {
                lines.append(CGRect(x: stemX + 0.5, y: frames[kid].box.midY, width: M.elbow, height: 1))
            }
        }
        return lines
    }
}
