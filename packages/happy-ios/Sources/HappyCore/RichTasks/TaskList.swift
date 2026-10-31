import Foundation
import HappyWire

/// The rich tasks as Home draws them, top to bottom: section headers, cards,
/// the sub-rows under each card and its "+N more". What is opened out and
/// what is folded is the screen's own, never written back.
public enum TaskList {
    /// Sub-rows a card shows before "+N more".
    public static let shown = 3
    /// The row in the classic rows the cards take the place of.
    public static let blockId = "rich:tasks"

    public enum Mark: Equatable, Sendable {
        /// A daemon-relative picture.
        case picture(String)
        case glyph(String)
    }

    public struct Card: Equatable, Sendable {
        public var taskId: String
        public var agentId: String
        public var title: String
        public var iconSlug: String?
        /// The last activity, to the minute (ms).
        public var time: Double?
        public var status: String?
        public var signal: Row.Corner
        /// The people who wrote to its agent since it was read, newest first.
        public var faces: [String]
        /// A story on its disc (stories come later; the ring is drawn already).
        public var story = false
        /// "+N more" in the corner: every child hidden, the card not opened out.
        public var more: Int?
    }

    public struct SubRow: Equatable, Sendable {
        public var taskId: String
        public var ref: TaskChild.Ref
        public var title: String
        public var mark: Mark
        public var working: Bool
        /// Hidden by an agent or Focus, shown faded once opened out.
        public var dimmed: Bool
        public var detail: String?
        public var changes: Row.LineChanges?
    }

    public enum Item: Equatable, Sendable {
        case header(id: String, name: String, collapsed: Bool)
        case card(Card)
        case subRow(SubRow)
        /// "+N more" under the sub-rows, or "hide" (`count` nil) once opened out.
        case more(taskId: String, count: Int?)

        public var id: String {
            switch self {
            case .header(let id, _, _): "section:\(id)"
            case .card(let card): "task:\(card.taskId)"
            case .subRow(let row): "task:\(row.taskId)/\(row.ref.kind):\(row.ref.id)"
            case .more(let taskId, _): "more:\(taskId)"
            }
        }
    }

    /// `tasks` as drawn, with the cards in `expanded` opened out and the
    /// sections in `folded` folded or unfolded over what the daemon says.
    /// It only picks among the cards as projected (`RichTasks.projected`).
    public static func items(_ tasks: RichTasks, expanded: Set<String> = [], folded: [String: Bool] = [:]) -> [Item] {
        var items: [Item] = []
        func add(_ card: RichTasks.Card) {
            guard var drawn = card.drawn else { return }
            let open = expanded.contains(card.taskId)
            if card.subRows.isEmpty, !card.hidden.isEmpty, !open { drawn.more = card.hidden.count }
            items.append(.card(drawn))
            if drawn.more != nil { return }
            let rows = open ? card.rows : Array(card.rows.prefix(min(shown, card.subRows.count)))
            items += rows.map(Item.subRow)
            if open { items.append(.more(taskId: card.taskId, count: nil)) }
            else if card.rows.count > rows.count { items.append(.more(taskId: card.taskId, count: card.rows.count - rows.count)) }
        }
        tasks.unsectioned.forEach(add)
        for section in tasks.sections {
            let collapsed = folded[section.id] ?? section.collapsed
            items.append(.header(id: section.id, name: section.name, collapsed: collapsed))
            if !collapsed { section.cards.forEach(add) }
        }
        return items
    }

    static func card(_ card: RichTasks.Card) -> Card {
        let status = Rows.activity(card.agent)
        let signal: Row.Corner = status == .working ? .braille : status == .awaitingInput || card.agent.unread != nil ? .dot : .none
        return Card(taskId: card.taskId, agentId: card.agent.id, title: card.name, iconSlug: card.iconSlug, time: card.agent.activityAt.map(Rows.minute),
                    status: card.agent.statusLine?.text, signal: signal, faces: card.faces)
    }

    static func subRow(_ taskId: String, _ row: RichTasks.SubRow, dimmed: Bool, _ children: [TaskChild.Ref: RichTasks.Child]) -> SubRow {
        let child = children[row.ref] ?? RichTasks.Child(title: row.ref.id)
        let mark: Mark = switch row.ref.kind {
        case "agent": .glyph("hardware-chip-outline")
        case "workspace": child.picture.map(Mark.picture) ?? .glyph("git-branch-outline")
        default: .glyph(glyph(artifact: child.type))
        }
        return SubRow(taskId: taskId, ref: row.ref, title: child.title, mark: mark, working: child.working, dimmed: dimmed, detail: child.detail, changes: child.changes)
    }

    /// An artifact's glyph by its type, as desktop's artifact list draws it.
    static func glyph(artifact type: String?) -> String {
        switch type {
        case "html": "globe-outline"
        case "video": "play-circle-outline"
        case "image", "image_series": "image-outline"
        default: "document-text-outline"
        }
    }
}

extension SidebarRows {
    /// The classic rows with the tasks' rows (and the subtasks under them)
    /// given over to one row the cards are drawn in; the rows unchanged
    /// while there are no rich tasks.
    public static func withRichTasks(_ rows: [Row], _ tasks: RichTasks?) -> [Row] {
        guard tasks != nil, let start = rows.firstIndex(where: { $0.id == "direct:tasks" }) else { return rows }
        let end = rows[(start + 1)...].firstIndex { $0.kind == .separator } ?? rows.endIndex
        return Array(rows[...start]) + [Row(id: TaskList.blockId, nodeId: TaskList.blockId, kind: .widget, label: "")] + rows[end...]
    }
}
