import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Home's grouped sidebar as a virtualized list holds it (`SidebarList`):
/// one slot per drawn row, each the stretch of content from where the one
/// before it ends to where its own box ends, so the slots tile the content
/// with no gap and the rows land exactly where `layout` puts them. The room
/// above the first row is the first slot's and the room below the last is
/// the last slot's. A separator draws nothing, so it has no slot: the gap
/// it makes between two cards is the next row's, above its box, and so is
/// the gap a heading leaves under the card before it.
extension SidebarLayout {
    public struct Slot: Equatable, Sendable {
        /// The row's index in the rows laid out.
        public var row: Int
        /// The slot in the content, the list's whole width.
        public var frame: CGRect
        /// The row's box, from the slot's top-left.
        public var box: CGRect

        public init(row: Int, frame: CGRect, box: CGRect) {
            self.row = row
            self.frame = frame
            self.box = box
        }
    }

    /// The slots of `rows`, laid out as `result`, `width` wide.
    public static func slots(_ rows: [Row], _ result: Result, width: CGFloat) -> [Slot] {
        var slots: [Slot] = []
        var top: CGFloat = 0
        for (index, row) in rows.enumerated() where row.kind != .separator && result.frames.indices.contains(index) {
            let box = result.frames[index].box
            slots.append(Slot(row: index, frame: CGRect(x: 0, y: top, width: width, height: max(0, box.maxY - top)), box: box.offsetBy(dx: 0, dy: -top)))
            top = box.maxY
        }
        // The room under the last row, and any separators after it.
        if var last = slots.popLast() {
            last.frame.size.height = max(0, result.contentHeight - last.frame.minY)
            slots.append(last)
        }
        return slots
    }

    /// `frame` moved into a slot whose top is `top`: content coordinates to
    /// the slot's own.
    public static func local(_ frame: Frame, top: CGFloat) -> Frame {
        func move(_ rect: CGRect?) -> CGRect? { rect?.offsetBy(dx: 0, dy: -top) }
        var moved = frame
        moved.box = frame.box.offsetBy(dx: 0, dy: -top)
        moved.mark = move(frame.mark)
        moved.label = frame.label.offsetBy(dx: 0, dy: -top)
        moved.trailing = move(frame.trailing)
        moved.chevron = move(frame.chevron)
        moved.chevronGlyph = move(frame.chevronGlyph)
        moved.rule = move(frame.rule)
        moved.corner = move(frame.corner)
        moved.lineChanges = move(frame.lineChanges)
        moved.detail = move(frame.detail)
        if let cell = frame.cell {
            moved.cell = Cell(roundsTop: cell.roundsTop, roundsBottom: cell.roundsBottom, separator: move(cell.separator))
        }
        return moved
    }
}
