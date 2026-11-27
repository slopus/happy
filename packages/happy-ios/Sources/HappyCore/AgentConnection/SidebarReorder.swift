import Foundation

/// Moving a bot or a task in home's list (`SidebarRows`), as desktop's
/// sidebar moves them (`botReorder`, `taskReorder`): a bot among the bots,
/// a task among the person's own tasks, each with the subtasks nested under
/// it. Nothing else moves and nothing leaves its section. The computer
/// hears a move as the row it now follows, nil for first
/// (`POST /v0/bots/:id/reorder`, `POST /v0/tasks/:id/reorder`).
public enum SidebarReorder {
    /// One move: the bot or task (`kind`), its ID, and the one of its kind
    /// it now follows, nil for first.
    public struct Move: Equatable, Sendable {
        public var kind: String
        public var id: String
        public var afterId: String?

        public init(kind: String, id: String, afterId: String?) {
            self.kind = kind
            self.id = id
            self.afterId = afterId
        }
    }

    /// Whether a finger may carry `row`: a bot's or task's own row, but
    /// not a shared bot's, which stands in the first group.
    public static func movable(_ row: Row) -> Bool {
        row.kind == .space && row.depth == 0 && row.targetId != nil && !row.sharedBot && (row.targetKind == "bot" || row.targetKind == "task")
    }

    /// The rows of the family `rows[index]` is one of: each peer's row with
    /// what nests under it, in order. Nil for a row nothing may move.
    public static func family(_ rows: [Row], at index: Int) -> [Range<Int>]? {
        guard rows.indices.contains(index), movable(rows[index]) else { return nil }
        let kind = rows[index].targetKind
        func peer(_ row: Row) -> Bool { movable(row) && row.targetKind == kind }
        var start = index
        var probe = index - 1
        while probe >= 0 {
            if rows[probe].depth > 0 { probe -= 1; continue }
            guard peer(rows[probe]) else { break }
            start = probe
            probe -= 1
        }
        var units: [Range<Int>] = []
        var at = start
        while at < rows.count, peer(rows[at]) {
            var end = at + 1
            while end < rows.count, rows[end].depth > 0 { end += 1 }
            units.append(at..<end)
            at = end
        }
        return units
    }

    /// Where the bot or task `kind`/`id` heads its row, if `rows` has it.
    public static func index(_ rows: [Row], kind: String, id: String) -> Int? {
        rows.firstIndex { movable($0) && $0.targetKind == kind && $0.targetId == id }
    }

    /// `rows` with `move` made: the row and what nests under it set down
    /// after the row of its kind it now follows, or first among them. A
    /// move whose row, or the row it follows, isn't there changes nothing.
    public static func moved(_ rows: [Row], _ move: Move) -> [Row] {
        guard let from = index(rows, kind: move.kind, id: move.id), let units = family(rows, at: from),
              let unit = units.first(where: { $0.lowerBound == from }) else { return rows }
        let rest = units.filter { $0 != unit }
        let at: Int
        if let afterId = move.afterId {
            guard let after = rest.first(where: { rows[$0.lowerBound].targetId == afterId }) else { return rows }
            at = after.upperBound
        } else {
            at = units[0].lowerBound
        }
        guard at != unit.lowerBound else { return rows }
        var result = rows
        let carried = Array(rows[unit])
        result.removeSubrange(unit)
        result.insert(contentsOf: carried, at: at > unit.lowerBound ? at - carried.count : at)
        return result
    }

    /// The move that puts the row at `index` at `place` among its peers,
    /// counted without it (0 first): what to tell the computer, nil where
    /// the row would stay where it is.
    public static func move(_ rows: [Row], at index: Int, to place: Int) -> Move? {
        guard let units = family(rows, at: index), let from = units.firstIndex(where: { $0.lowerBound == index }),
              let kind = rows[index].targetKind, let id = rows[index].targetId else { return nil }
        let rest = units.enumerated().filter { $0.offset != from }.map(\.element)
        let place = min(max(place, 0), rest.count)
        guard place != from else { return nil }
        return Move(kind: kind, id: id, afterId: place == 0 ? nil : rows[rest[place - 1].lowerBound].targetId)
    }
}
