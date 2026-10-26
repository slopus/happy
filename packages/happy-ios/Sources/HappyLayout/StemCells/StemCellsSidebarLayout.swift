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
        /// Rows nested under it fold: its chevron takes the trailing square,
        /// and a status or dot stands just before it.
        public var hasFold: Bool
        /// A section heading's "+", which makes new work in it: one square
        /// before its fold, always shown.
        public var hasAdd: Bool
        /// The fold points right ("›"), not down ("⌄"): its ink weighs elsewhere.
        public var foldClosed: Bool

        public init(kind: Kind, depth: Int = 0, hasMark: Bool = true, hasTrailing: Bool = false, hasFold: Bool = false, hasAdd: Bool = false, foldClosed: Bool = false) {
            self.kind = kind
            self.depth = depth
            self.hasMark = hasMark
            self.hasTrailing = hasTrailing
            self.hasFold = hasFold
            self.hasAdd = hasAdd
            self.foldClosed = foldClosed
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
        /// A section's fold chevron, on the same trailing column: its lane.
        public var chevron: CGRect?
        /// The chevron's image (`chevronGlyph` square), placed so its ink's
        /// optical centre is the fold's: `trailingCenter` from the right,
        /// on the row's middle. On whole pixels at `scale`.
        public var chevronGlyph: CGRect?
        /// A section's "+", one square before its fold.
        public var add: CGRect?
        /// A separator's hairline, across the row box's whole width.
        public var rule: CGRect?
    }

    public struct Result: Equatable, Sendable {
        public var frames: [Frame]
        /// The tree's lines: vertical stems and the elbows into nested rows, `line` wide.
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

    public static func layout(_ rows: [Row], width: CGFloat, top: CGFloat = StemCellsMetrics.contentTop, bottom: CGFloat = StemCellsMetrics.contentBottom, scale: CGFloat = 3) -> Result {
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
            func pixel(_ value: CGFloat) -> CGFloat { (value * max(1, scale)).rounded() / max(1, scale) }
            // Centred `trailingCenter` in, on the row's middle, on whole pixels.
            let trailingRect = CGRect(x: pixel(width - M.trailingCenter - M.trailing / 2), y: pixel(midY - M.trailing / 2), width: M.trailing, height: M.trailing)
            let inkRight = trailingRect.maxX
            var frame = Frame(box: box, mark: nil, label: .zero, trailing: nil, chevron: nil, chevronGlyph: nil, add: nil, rule: nil)
            func fold() -> CGRect {
                let ink = row.foldClosed ? M.chevronRightInk : M.chevronDownInk
                let size = M.chevronGlyph
                return CGRect(x: pixel(width - M.trailingCenter - size / 2 - ink.dx), y: pixel(midY - size / 2 - ink.dy), width: size, height: size)
            }
            switch row.kind {
            case .separator:
                frame.rule = CGRect(x: boxX, y: (midY - M.line / 2).rounded(.down), width: boxWidth, height: M.line)
            case .section:
                // The title starts where a top-level glyph's ink does, and keeps
                // clear of the fold's lane (`padding-right: row padding + 22`),
                // so showing the fold moves nothing.
                let x = boxX + M.sectionTitleInset
                var end = trailingRect.minX
                if row.hasAdd {
                    let add = trailingRect.offsetBy(dx: -(M.trailing + M.trailingGap), dy: 0)
                    frame.add = add
                    end = add.minX
                }
                frame.label = CGRect(x: x, y: y, width: max(0, end - sectionFoldGap - x), height: height)
                frame.chevron = trailingRect
                frame.chevronGlyph = fold()
            case .widget, .row:
                var x = leadingX(depth: row.depth)
                if row.hasMark {
                    frame.mark = CGRect(x: x, y: midY - M.mark / 2, width: M.mark, height: M.mark)
                    x += M.mark + M.markGap
                }
                var right = inkRight
                var slot = trailingRect
                if row.hasFold, row.kind == .row {
                    frame.chevron = slot
                    frame.chevronGlyph = fold()
                    right = slot.minX - M.trailingGap
                    slot = slot.offsetBy(dx: -(M.trailing + M.trailingGap), dy: 0)
                }
                if row.hasTrailing {
                    frame.trailing = slot
                    right = slot.minX - M.trailingGap
                }
                // A row's title rides up to its marks' middle.
                frame.label = CGRect(x: x, y: row.kind == .row ? y - M.titleLift : y, width: max(0, right - x), height: height)
            }
            frames.append(frame)
            y += height
        }
        return Result(frames: frames, connectors: connectors(rows, frames), contentHeight: y + bottom)
    }

    /// Between a section's title and its fold: `22 − 18`.
    static let sectionFoldGap: CGFloat = 4 * StemCellsMetrics.phone

    /// Where a row's mark (or, without one, its label) starts: a top-level
    /// mark centred `endInset` in from the row box, `indent` more per level.
    static func leadingX(depth: Int) -> CGFloat {
        typealias M = StemCellsMetrics
        return M.markCenter - M.mark / 2 + CGFloat(depth) * M.indent
    }

    /// `SidebarTreeConnectors`: one stem per parent down its mark's centre,
    /// from under the mark to a point past its last child's middle, and an
    /// elbow into each child at its middle, stopping short of its mark.
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
            let stemX = (leadingX(depth: rows[parent].depth) + M.mark / 2 - M.line / 2).rounded(.down)
            let top = frames[parent].box.midY + M.stemInset
            let bottom = (kids.map { frames[$0].box.midY }.max() ?? top) + M.line
            lines.append(CGRect(x: stemX, y: top, width: M.line, height: max(0, bottom - top)))
            for kid in kids {
                let end = leadingX(depth: rows[kid].depth) - M.elbowGap
                lines.append(CGRect(x: stemX + M.line, y: (frames[kid].box.midY - M.line / 2).rounded(.down), width: max(0, end - stemX - M.line), height: M.line))
            }
        }
        return lines
    }
}
