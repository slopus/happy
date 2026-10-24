import Foundation

/// A top-level row carried through the sidebar, as desktop's `Sidebar.tsx`
/// reorders: the rows it can be set down among (its peers), the slots a
/// drop may not take, the slot the hand is over, and where the document
/// puts it there.
///
/// A peer is a top-level row with the rows nested under it. A section is
/// carried with its block, the rows after it up to the next section or
/// separator, and its peers are the other blocks. Rows are the drawn ones:
/// Search and Create are never peers and never move, and a drop at the very
/// top lands right after them.
public struct StemCellsDrag: Equatable, Sendable {
    /// The node carried.
    public let moving: String
    /// Each peer's rows, as indices into the drawn rows, top to bottom.
    public let units: [[Int]]
    /// The carried peer.
    public let from: Int
    /// Slots a drop would hide a row in (desktop's `dragSlotsBlocked`).
    public let blocked: [Bool]
    private let drawn: [StemCellsRow]
    private let all: [StemCellsRow]

    /// Nil when `rowId` can't be carried: a hidden row, Happy's, a session, a
    /// nested row, or one inside a section's block it can't leave alone.
    public init?(holding rowId: String, drawn: [StemCellsRow], all: [StemCellsRow], document: SpaceSidebarDocument) {
        guard let index = drawn.firstIndex(where: { $0.id == rowId }) else { return nil }
        let row = drawn[index]
        guard row.depth == 0, StemCellsDrop.canMove(row) else { return nil }
        let units = row.kind == .section ? Self.sectionBlocks(drawn) : Self.blocks(drawn)
        guard let from = units.firstIndex(where: { $0.first == index }) else { return nil }
        self.moving = row.nodeId
        self.units = units
        self.from = from
        self.drawn = drawn
        self.all = all
        var blocked = Array(repeating: false, count: units.count)
        // A folded section too: set down above rows it would fold them away.
        let shown = Self.shownTop(document)
        for to in units.indices where to != from {
            guard case .some(let after) = Self.anchor(to: to, units: units, from: from, drawn: drawn, all: all, moving: row.nodeId),
                  let moved = SidebarDocumentEdits.move(document, row.nodeId, after: after) else { continue }
            blocked[to] = !shown.isSubset(of: Self.shownTop(moved))
        }
        self.blocked = blocked
    }

    /// Top-level rows with what is nested under them.
    static func blocks(_ rows: [StemCellsRow]) -> [[Int]] {
        var units: [[Int]] = []
        for (index, row) in rows.enumerated() {
            if row.depth == 0 || units.isEmpty { units.append([index]) } else { units[units.count - 1].append(index) }
        }
        return units
    }

    /// The rows before the first section, then each section with its run;
    /// a separator stands alone.
    static func sectionBlocks(_ rows: [StemCellsRow]) -> [[Int]] {
        var units: [[Int]] = []
        for (index, row) in rows.enumerated() {
            let breaks = row.depth == 0 && (row.kind == .section || row.kind == .separator)
            let afterSeparator = units.last.map { rows[$0[0]].kind == .separator } ?? false
            if breaks || units.isEmpty || afterSeparator { units.append([index]) } else { units[units.count - 1].append(index) }
        }
        return units
    }

    /// The top-level nodes a fold leaves showing.
    static func shownTop(_ document: SpaceSidebarDocument) -> Set<String> {
        var shown = Set<String>()
        var hidden = false
        for node in document.items {
            if node.kind == .section || node.kind == .separator {
                hidden = node.kind == .section && node.collapsed
                shown.insert(node.id)
            } else if !hidden {
                shown.insert(node.id)
            }
        }
        return shown
    }

    /// Desktop's `dragTargetIndex`, then `dragSlotOpen`: the slot whose
    /// neighbours the hand has passed by half their height, or the nearest
    /// open one short of it. `heights` are each peer's, gaps inside included.
    public func target(deltaY: Double, heights: [Double]) -> Int {
        var index = from
        var travel = deltaY
        while travel > 0, index < heights.count - 1 {
            let next = heights[index + 1]
            if travel <= next / 2 { break }
            travel -= next
            index += 1
        }
        while travel < 0, index > 0 {
            let previous = heights[index - 1]
            if -travel <= previous / 2 { break }
            travel += previous
            index -= 1
        }
        let step = index > from ? -1 : 1
        while index != from, blocked[index] { index += step }
        return index
    }

    /// The drawn rows in the order a drop in slot `to` leaves them.
    public func order(to: Int) -> [StemCellsRow] {
        var peers = units
        let held = peers.remove(at: from)
        peers.insert(held, at: to)
        return peers.flatMap { $0.map { drawn[$0] } }
    }

    /// The rows carried.
    public var held: [StemCellsRow] { units[from].map { drawn[$0] } }

    /// The node it is set down after in slot `to`, nil for first; nil
    /// overall where nothing changes.
    public func after(to: Int) -> String?? {
        to == from ? nil : Self.anchor(to: to, units: units, from: from, drawn: drawn, all: all, moving: moving)
    }

    private static func anchor(to: Int, units: [[Int]], from: Int, drawn: [StemCellsRow], all: [StemCellsRow], moving: String) -> String?? {
        var remaining = units
        remaining.remove(at: from)
        if to > 0 { return .some(drawn[remaining[to - 1][0]].nodeId) }
        guard let first = remaining.first else { return nil }
        // Above every drawn row: after whatever hidden node stands before it.
        return StemCellsDrop.after(moving, droppedBefore: drawn[first[0]].nodeId, rows: all)
    }
}
