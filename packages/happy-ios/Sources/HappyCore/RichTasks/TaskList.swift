import Foundation
import HappyWire

/// The rich tasks as Home draws them: one list of cards in the tasks' place
/// and one under each section's heading, each card with its sub-rows and
/// "+N more". What is opened out and what is folded is the screen's own,
/// never written back.
public enum TaskList {
    /// Sub-rows a card shows before "+N more".
    public static let shown = 3
    /// The row the cards above the first section are drawn in; a section's is `blockId:<id>`.
    public static let blockId = "rich:tasks"

    public enum Mark: Equatable, Sendable {
        /// A daemon-relative picture.
        case picture(String)
        case glyph(String)
    }

    public struct Card: Equatable, Sendable {
        public var taskId, agentId, title: String
        public var iconSlug, iconPath: String?
        /// The last activity, to the minute (ms).
        public var time: Double?
        public var status: String?
        public var signal: Row.Corner
        /// The people who wrote to its agent since it was read, newest first.
        public var faces: [String]
        /// A story ring on its disc: one segment per live story, the new ones coloured.
        public var story = false, ring: StoryRing?
        /// Who its faces are, as read; nil for one not read yet.
        public var people: [Person?] = []
        /// "+N more" in the corner: every child hidden, the card not opened out.
        public var more: Int?
        /// Its tile while (or when no) icon is drawn: its name's first letter, on the colour `tint` picks by task.
        public var letter: String? { title.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } }
    }

    /// Which of `count` colours is `id`'s own: a face's, a card's tile.
    public static func tint(_ id: String, among count: Int) -> Int {
        id.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xffff } % count
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
        case card(Card)
        case subRow(SubRow)
        /// "+N more" under the sub-rows, or "hide" (`count` nil) once opened out.
        case more(taskId: String, count: Int?)

        public var id: String {
            switch self {
            case .card(let card): "task:\(card.taskId)"
            case .subRow(let row): "task:\(row.taskId)/\(row.ref.kind):\(row.ref.id)"
            case .more(let taskId, _): "more:\(taskId)"
            }
        }
    }

    /// The cards the list in row `block` draws; nil for every card.
    public static func cards(_ tasks: RichTasks, block: String?) -> [RichTasks.Card] {
        guard let block else { return tasks.cards }
        return block == blockId ? tasks.unsectioned : tasks.sections.first { "\(blockId):\($0.id)" == block }?.cards ?? []
    }

    /// `cards` as drawn, with the ones in `expanded` opened out. It only
    /// picks among the cards as projected (`RichTasks.projected`).
    public static func items(_ cards: [RichTasks.Card], expanded: Set<String> = []) -> [Item] {
        var items: [Item] = []
        for card in cards {
            guard var drawn = card.drawn else { continue }
            let open = expanded.contains(card.taskId)
            if card.subRows.isEmpty, !card.hidden.isEmpty, !open { drawn.more = card.hidden.count }
            items.append(.card(drawn))
            if drawn.more != nil { continue }
            let rows = open ? card.rows : Array(card.rows.prefix(min(shown, card.subRows.count)))
            items += rows.map(Item.subRow)
            if open { items.append(.more(taskId: card.taskId, count: nil)) }
            else if card.rows.count > rows.count { items.append(.more(taskId: card.taskId, count: card.rows.count - rows.count)) }
        }
        return items
    }

    static func card(_ card: RichTasks.Card) -> Card {
        let status = Rows.activity(card.agent)
        let signal: Row.Corner = status == .working ? .braille : status == .awaitingInput || card.agent.unread != nil ? .dot : .none
        return Card(taskId: card.taskId, agentId: card.agent.id, title: card.name, iconSlug: card.iconSlug, iconPath: card.iconPath, time: card.agent.activityAt.map(Rows.minute),
                    status: card.agent.statusLine?.text, signal: signal, faces: card.faces)
    }

    static func subRow(_ taskId: String, _ row: RichTasks.SubRow, dimmed: Bool, _ children: [TaskChild.Ref: RichTasks.Child]) -> SubRow {
        let child = children[row.ref] ?? RichTasks.Child(title: row.ref.id)
        let mark: Mark = switch row.ref.kind {
        case "agent": .glyph("hardware-chip-outline")
        case "workspace": child.picture.map(Mark.picture) ?? .glyph("git-branch-outline")
        // An artifact's by its type, as desktop's artifact list draws it.
        default: .glyph(["html": "globe-outline", "video": "play-circle-outline", "image": "image-outline", "image_series": "image-outline"][child.type ?? ""] ?? "document-text-outline")
        }
        return SubRow(taskId: taskId, ref: row.ref, title: child.title, mark: mark, working: child.working, dimmed: dimmed, detail: child.detail, changes: child.changes)
    }
}

extension SidebarRows {
    /// The classic rows with the tasks' (and their subtasks') given over to the cards' list, then each section's heading
    /// (`rich:section:<id>`, folded as `folded` says over the daemon) and its list; unchanged with no rich tasks.
    public static func withRichTasks(_ rows: [Row], _ tasks: RichTasks?, folded: [String: Bool] = [:]) -> [Row] {
        guard let tasks, let start = rows.firstIndex(where: { $0.id == "direct:tasks" }) else { return rows }
        let end = rows[(start + 1)...].firstIndex { $0.kind == .separator } ?? rows.endIndex
        func list(_ id: String) -> Row { Row(id: id, nodeId: id, kind: .widget, label: "") }
        var rich = tasks.unsectioned.isEmpty ? [] : [list(TaskList.blockId)]
        for section in tasks.sections {
            let id = "rich:section:\(section.id)", collapsed = folded[id] ?? section.collapsed
            rich.append(Row(id: id, nodeId: id, kind: .section, label: section.name, collapsed: collapsed))
            if !collapsed, !section.cards.isEmpty { rich.append(list("\(TaskList.blockId):\(section.id)")) }
        }
        return Array(rows[...start]) + rich + rows[end...]
    }
}
