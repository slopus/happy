import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The V2 sidebar's frames: one column of rows, each a fixed height
/// by its kind, so folding a section moves only the rows after it and no row
/// ever changes size.
public enum SidebarLayout {
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
        public var hasWorkingSignal: Bool
        /// Rows nested under it fold: its chevron takes the trailing square,
        /// and a status or dot stands just before it.
        public var hasFold: Bool
        /// A section heading's "+", which makes new work in it: one square
        /// before its fold, always shown.
        /// The fold points right ("›"), not down ("⌄"): its ink weighs elsewhere.
        public var foldClosed: Bool
        public var lineChangesWidth: CGFloat
        public var trailingInk: CGRect?
        /// A line under the title, as a search result's snippet: in a
        /// grouped list, the row is `detailRowHeight` tall.
        public var hasDetail: Bool

        public init(kind: Kind, depth: Int = 0, hasMark: Bool = true, hasTrailing: Bool = false, hasWorkingSignal: Bool = false, hasFold: Bool = false, foldClosed: Bool = false, lineChangesWidth: CGFloat = 0, trailingInk: CGRect? = nil, hasDetail: Bool = false) {
            self.kind = kind
            self.depth = depth
            self.hasMark = hasMark
            self.hasTrailing = hasTrailing
            self.hasWorkingSignal = hasWorkingSignal
            self.hasFold = hasFold
            self.foldClosed = foldClosed
            self.lineChangesWidth = lineChangesWidth
            self.trailingInk = trailingInk
            self.hasDetail = hasDetail
        }
    }

    public struct Frame: Equatable, Sendable {
        /// The row box: the tap target and its fill, in content coordinates.
        public var box: CGRect
        /// The leading mark, absent for a row without one; then the label
        /// starts there.
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
        /// A separator's hairline, across the row box's whole width.
        public var rule: CGRect?
        /// The working signal, the braille loader, in the trailing square's place.
        public var corner: CGRect?
        /// In a grouped list, the row's place in its card; nil in a plain
        /// list, and for a heading or a separator.
        public var cell: Cell?
        public var lineChanges: CGRect?
        /// The line under the title, for a row that has one.
        public var detail: CGRect?

        public init(box: CGRect, mark: CGRect? = nil, label: CGRect = .zero, trailing: CGRect? = nil, chevron: CGRect? = nil, chevronGlyph: CGRect? = nil, rule: CGRect? = nil, corner: CGRect? = nil, cell: Cell? = nil) {
            self.box = box
            self.mark = mark
            self.label = label
            self.trailing = trailing
            self.chevron = chevron
            self.chevronGlyph = chevronGlyph
            self.rule = rule
            self.corner = corner
            self.cell = cell
        }
    }

    public struct Result: Equatable, Sendable {
        public var frames: [Frame]
        /// The tree's lines: vertical stems and the elbows into nested rows, `line` wide.
        public var connectors: [CGRect]
        public var contentHeight: CGFloat
        /// A grouped list's cards, top first; none in a plain list.
        public var groups: [Group] = []
    }

    public static func height(_ kind: Kind) -> CGFloat {
        switch kind {
        case .row: Metrics.rowHeight
        case .section: Metrics.sectionHeight
        case .separator: Metrics.separatorHeight
        case .widget: Metrics.widgetMinHeight
        }
    }


    public static func layout(_ rows: [Row], width: CGFloat, top: CGFloat = Metrics.contentTop, bottom: CGFloat = Metrics.contentBottom, scale: CGFloat = 3) -> Result {
        layout(rows, width: width, top: top, bottom: bottom, scale: scale, style: .plain)
    }

    /// `rows` in `style`: desktop's column, or iOS's inset grouped cards.
    public static func layout(_ rows: [Row], width: CGFloat, top: CGFloat, bottom: CGFloat, scale: CGFloat = 3, style: Style) -> Result {
        if style == .grouped { return grouped(rows, width: width, top: top, bottom: bottom, scale: scale) }
        typealias M = Metrics
        var frames: [Frame] = []
        frames.reserveCapacity(rows.count)
        var y = top
        let boxX = M.inset
        let boxWidth = max(0, width - 2 * M.inset)
        func pixel(_ value: CGFloat) -> CGFloat { (value * max(1, scale)).rounded() / max(1, scale) }
        for (index, row) in rows.enumerated() {
            if index > 0 { y += M.rowGap }
            let height = height(row.kind)
            let box = CGRect(x: boxX, y: y, width: boxWidth, height: height)
            let midY = y + height / 2
            // Centred `trailingCenter` in, on the row's middle, on whole pixels.
            let trailingRect = CGRect(x: pixel(width - M.trailingCenter - M.trailing / 2), y: pixel(midY - M.trailing / 2), width: M.trailing, height: M.trailing)
            let inkRight = trailingRect.maxX
            var frame = Frame(box: box)
            func fold(_ midY: CGFloat = midY) -> CGRect {
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
                let end = trailingRect.minX
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
                // The renderer centers the font's x-height in this row box.
                frame.label = CGRect(x: x, y: y, width: max(0, right - x), height: height)
                if row.hasTrailing == false, row.kind == .row, row.hasWorkingSignal {
                    let signal = M.workingSignal
                    frame.corner = CGRect(x: slot.midX - signal.width / 2, y: slot.midY - signal.height / 2, width: signal.width, height: signal.height)
                    frame.label.size.width = max(0, slot.minX - M.trailingGap - x)
                }
            }
            reserveLineChanges(row, frame: &frame, activityRight: box.maxX - (M.endInset - M.mark / 2), scale: scale)
            frames.append(frame)
            y += height
        }
        return Result(frames: frames, connectors: connectors(rows, frames), contentHeight: y + bottom)
    }

    /// Between a section's title and its fold: `22 − 18`.
    static let sectionFoldGap: CGFloat = 4 * Metrics.phone

    /// Counts take their measured width before the activity/fold lanes.
    /// Only the title yields space; no count update changes a row's height.
    static func reserveLineChanges(_ row: Row, frame: inout Frame, activityRight: CGFloat, scale: CGFloat) {
        let ink = workingInk(scale: scale)
        if var corner = frame.corner, !row.hasFold {
            corner.origin.x = activityRight - ink.maxX
            corner.origin.y = frame.box.midY - ink.midY
            frame.corner = corner
            frame.label.size.width = max(0, corner.minX + ink.minX - 6 - frame.label.minX)
        }
        if var trailing = frame.trailing, let statusInk = row.trailingInk, !row.hasFold {
            trailing.origin.x = activityRight - statusInk.maxX
            trailing.origin.y = frame.box.midY - statusInk.midY
            frame.trailing = trailing
            frame.label.size.width = max(0, trailing.minX + statusInk.minX - 6 - frame.label.minX)
        }
        guard row.kind == .row, row.lineChangesWidth > 0 else { return }
        let right: CGFloat
        if let corner = frame.corner {
            right = corner.minX + ink.minX - 6
        } else {
            right = !row.hasTrailing && !row.hasFold ? activityRight : frame.label.maxX
        }
        let width = min(row.lineChangesWidth, max(0, right - frame.label.minX))
        frame.lineChanges = CGRect(x: right - width, y: frame.box.minY, width: width, height: frame.box.height)
        frame.label.size.width = max(0, right - width - 8 - frame.label.minX)
    }

    static func workingInk(scale: CGFloat) -> CGRect {
        let scale = max(1, scale)
        let signal = Metrics.workingSignal
        let dots = Braille.origins(width: Int((signal.width * scale).rounded()), height: Int((signal.height * scale).rounded()))
        let left = dots.origins.map(\.x).min() ?? 0
        let top = dots.origins.map(\.y).min() ?? 0
        let right = (dots.origins.map(\.x).max() ?? 0) + dots.diameter
        let bottom = (dots.origins.map(\.y).max() ?? 0) + dots.diameter
        return CGRect(x: CGFloat(left) / scale, y: CGFloat(top) / scale, width: CGFloat(right - left) / scale, height: CGFloat(bottom - top) / scale)
    }

    /// Where a row's mark (or, without one, its label) starts: a top-level
    /// mark centred `endInset` in from the row box, `indent` more per level.
    static func leadingX(depth: Int) -> CGFloat {
        typealias M = Metrics
        return M.markCenter - M.mark / 2 + CGFloat(depth) * M.indent
    }

    /// `SidebarTreeConnectors`: one stem per parent down its mark's centre,
    /// from under the mark to a point past its last child's middle, and an
    /// elbow into each child at its middle, stopping short of its mark.
    static func connectors(_ rows: [Row], _ frames: [Frame]) -> [CGRect] {
        typealias M = Metrics
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
            let parentMark = frames[parent].mark
            let stemX = ((parentMark.map(\.midX) ?? leadingX(depth: rows[parent].depth) + M.mark / 2) - M.line / 2).rounded(.down)
            let top = frames[parent].box.midY + (parentMark.map { $0.height / 2 } ?? M.stemInset)
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
