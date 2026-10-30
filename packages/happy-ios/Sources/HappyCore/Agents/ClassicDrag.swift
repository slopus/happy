import Foundation
import HappyWire

/// A row set down in the classic sidebar, as desktop's `onItemReorder`
/// persists it: what moved and the sibling it now follows (nil: first),
/// through the ordinary reorder routes, never the sidebar document.
public struct ClassicMove: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// `POST /v0/bots/:id/reorder`, among the bots.
        case bot
        /// `POST /v0/tasks/:id/reorder`, in the person's own task list.
        case task
        /// `POST /v0/projects/:id/reorder`, among the projects.
        case project
        /// `POST /v0/workspaces/:id/reorder`, among one project's worktrees.
        case workspace
        /// `POST /v0/agents/:id/subtask-reorder`, among one parent's subtasks.
        case subtask
        /// `POST /v0/surfaces/:id/reorder`, among the joined Surfaces.
        case surface
    }

    public var kind: Kind
    public var id: String
    public var afterId: String?
    /// The family the row moved in, and its rows' IDs in the new order:
    /// what the list holds on screen until the computer says the same.
    public var family: String
    public var order: [String]

    public init(kind: Kind, id: String, afterId: String?, family: String, order: [String]) {
        self.kind = kind
        self.id = id
        self.afterId = afterId
        self.family = family
        self.order = order
    }
}

/// Carrying a row in the classic sidebar (`SidebarRows`), which desktop's
/// classic `Sidebar` reorders: a row moves among its own section's rows of
/// the same kind, or a nested row among its siblings, and nowhere else.
/// Sections never move and a row never leaves its section; Artifacts, a
/// project's sessions and the headings are never picked up. A drag is a
/// `Drag` whose peers are only that family, so the carry can't reach a
/// slot outside it: a cross-section drop is impossible by construction.
public enum ClassicDrag {
    /// The family a row at the top of the list belongs to before any heading.
    static let topFamily = "classic:top"

    /// What a row stands for, for the reorder route: nil where nothing
    /// may move it.
    static func entity(_ rows: [Row], _ index: Int) -> (kind: ClassicMove.Kind, id: String)? {
        let row = rows[index]
        switch row.kind {
        case .space where row.depth == 0 && row.targetKind == "bot":
            return row.targetId.map { (.bot, $0) }
        case .space where row.depth == 0 && row.targetKind == "task":
            return row.targetId.map { (.task, $0) }
        case .space where row.depth == 0 && row.targetKind == "surface":
            return row.targetId.map { (.surface, $0) }
        case .space where row.depth == 0 && row.targetKind == "project":
            return (.project, String(row.id.dropFirst("project:".count)))
        case .space where row.targetKind == "workspace":
            return (.workspace, String(row.id.dropFirst("workspace:".count)))
        case .session where row.depth > 0:
            // A subtask: under a bot's, a task's or another subtask's row.
            // A project's or worktree's sessions keep their own order.
            guard let parent = parentIndex(rows, index), let agentId = row.agentId,
                  rows[parent].kind == .session || ["bot", "task"].contains(rows[parent].targetKind) else { return nil }
            return (.subtask, agentId)
        default:
            return nil
        }
    }

    /// The row a nested row hangs under, or the heading over a top-level
    /// one (nil before any heading).
    static func parentIndex(_ rows: [Row], _ index: Int) -> Int? {
        let depth = rows[index].depth
        var parent = index - 1
        if depth == 0 {
            while parent >= 0, !(rows[parent].kind == .section && rows[parent].depth == 0) { parent -= 1 }
        } else {
            while parent >= 0, rows[parent].depth >= depth { parent -= 1 }
            guard parent >= 0, rows[parent].depth == depth - 1 else { return nil }
        }
        return parent >= 0 ? parent : nil
    }

    /// A row's family: its parent (heading or row), each peer with what is
    /// nested under it, and the rows before and after them, which stay
    /// where they are. Nil for a row that can't move, or has no peer to pass.
    static func family(_ rows: [Row], _ index: Int) -> (parent: String, units: [[Int]], before: [Int], after: [Int])? {
        guard let held = entity(rows, index) else { return nil }
        let depth = rows[index].depth
        let parent = parentIndex(rows, index)
        let start = (parent ?? -1) + 1
        var end = start
        // The family's span: up to the next heading, or out of the parent.
        while end < rows.count {
            let row = rows[end]
            if depth == 0 ? (row.kind == .section && row.depth == 0) : row.depth < depth { break }
            end += 1
        }
        var units: [[Int]] = []
        var first: Int?
        var last: Int?
        var closed = false
        for position in start..<end {
            if rows[position].depth == depth {
                let peer = entity(rows, position)?.kind == held.kind
                if peer {
                    // A peer after a row of another kind would split the family.
                    if closed { return nil }
                    if first == nil { first = position }
                    units.append([position])
                    last = position
                } else if first != nil {
                    closed = true
                }
            } else if let unit = units.indices.last, !closed, last != nil, rows[position].depth > depth {
                units[unit].append(position)
            }
        }
        guard let first, units.count > 1, let tail = units.last?.last else { return nil }
        let parentId = parent.map { rows[$0].nodeId } ?? topFamily
        return (parentId, units, Array(0..<first), Array((tail + 1)..<rows.count))
    }

    /// A carry for `rowId` among the rows drawn (`rows`, in drawn order), or
    /// nil where it can't move.
    public static func drag(holding rowId: String, rows: [Row]) -> Drag? {
        guard let index = rows.firstIndex(where: { $0.id == rowId }),
              let family = family(rows, index),
              let from = family.units.firstIndex(where: { $0.first == index }) else { return nil }
        return Drag(
            moving: rows[index].nodeId, units: family.units, from: from,
            blocked: Array(repeating: false, count: family.units.count), parent: family.parent,
            drawn: rows, all: rows, before: family.before, afterFamily: family.after
        )
    }

    /// What a drop in slot `to` asks the computer for; nil where nothing moved.
    public static func move(_ drag: Drag, to: Int) -> ClassicMove? {
        guard to != drag.from else { return nil }
        let order = drag.order(to: to)
        let heldId = drag.held[0].id
        guard let index = order.firstIndex(where: { $0.id == heldId }), let held = entity(order, index) else { return nil }
        // The peers' heads in their new order.
        guard let heads = family(order, index)?.units.map({ $0[0] }), let at = heads.firstIndex(of: index) else { return nil }
        let after = at > 0 ? entity(order, heads[at - 1])?.id : nil
        return ClassicMove(kind: held.kind, id: held.id, afterId: after, family: drag.parent ?? topFamily, order: heads.map { order[$0].id })
    }

    /// The rows with each family in `orders` (row IDs, by family) drawn in
    /// that order: a move shows as made until the computer's own order
    /// arrives. A row the order doesn't name keeps its place after those it does.
    public static func held(_ rows: [Row], orders: [String: [String]]) -> [Row] {
        var rows = rows
        for order in orders.values {
            guard let index = rows.firstIndex(where: { order.contains($0.id) }), let family = family(rows, index) else { continue }
            let rank = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
            let sorted = family.units.enumerated().sorted {
                (rank[rows[$0.element[0]].id] ?? Int.max, $0.offset) < (rank[rows[$1.element[0]].id] ?? Int.max, $1.offset)
            }.map(\.element)
            rows = (family.before + sorted.flatMap { $0 } + family.after).map { rows[$0] }
        }
        return rows
    }

    /// The classic rows while agent stories are on (`rings` set, keyed by
    /// agent): each bot's and task's row a story row wearing its agent's
    /// ring, with its status line and time, and everything nested, the
    /// projects and the headings kept where they are. Unlike the spaces
    /// sidebar's (`Rows.withStories`) the tree stays: the classic list is
    /// where projects and their sessions live.
    public static func withStories(_ rows: [Row], rings: [String: StoryRing]?) -> [Row] {
        guard let rings else { return rows }
        return rows.map { row in
            var row = row
            if row.kind == .section && row.depth == 0 { row.amongStories = true }
            guard row.depth == 0, row.kind == .space, let agentId = row.agentId,
                  row.targetKind == "bot" || row.targetKind == "task" else { return row }
            let ring = rings[agentId]
            row.story = Row.StoryRowState(segments: ring?.storyIds.count ?? 0, unseen: min(ring?.unseenCount ?? 0, ring?.storyIds.count ?? 0))
            return row
        }
    }
}

extension AgentClient {
    /// A classic sidebar move, by the route desktop's classic sidebar uses
    /// for it. Bots, projects and workspaces name the version they move
    /// (`If-Match`); one that lost a race reads the newer and moves that.
    public func reorder(_ move: ClassicMove) async throws {
        let after: JSONValue = move.afterId.map(JSONValue.string) ?? .null
        let body: JSONValue = .object(["afterId": after, "mutationId": .string(ClientID.make())])
        let versioned: (path: String, key: String)? = switch move.kind {
        case .bot: ("/v0/bots/\(Self.escape(move.id))", "bot")
        case .project: ("/v0/projects/\(Self.escape(move.id))", "project")
        case .workspace: ("/v0/workspaces/\(Self.escape(move.id))", "workspace")
        default: nil
        }
        if let versioned {
            for attempt in 0..<2 {
                guard let version = try await decode(JSONValue.self, "GET", versioned.path)[versioned.key]?["version"]?.stringValue else { throw AgentClientError.invalidResponse }
                do {
                    _ = try await send("POST", versioned.path + "/reorder", json: body, headers: ["If-Match": version])
                    return
                } catch AgentClientError.status(409, _, _) where attempt == 0 {
                    continue
                }
            }
            return
        }
        let path = switch move.kind {
        case .task: "/v0/tasks/\(Self.escape(move.id))/reorder"
        case .surface: "/v0/surfaces/\(Self.escape(move.id))/reorder"
        default: "/v0/agents/\(Self.escape(move.id))/subtask-reorder"
        }
        _ = try await send("POST", path, json: body)
    }
}
