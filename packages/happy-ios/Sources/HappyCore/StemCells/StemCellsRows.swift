import Foundation

/// What the sidebar's rows are drawn from beside the document: the bots and
/// tasks whose conversations the rows open (`HappyAgentSpacesPlaces`).
public struct StemCellsPlaces: Equatable, Sendable {
    public var bots: [AgentWire.Bot]
    public var tasks: [AgentWire.Task]
    public var surfaces: [AgentWire.Surface]

    public init(bots: [AgentWire.Bot] = [], tasks: [AgentWire.Task] = [], surfaces: [AgentWire.Surface] = []) {
        self.bots = bots
        self.tasks = tasks
        self.surfaces = surfaces
    }

    /// The system key of Happy's own bot.
    static let happyBotKey = "chief_of_staff"

    func bot(_ id: String) -> AgentWire.Bot? { bots.first { $0.id == id } }
    func task(_ id: String) -> AgentWire.Task? { tasks.first { $0.id == id } }
    func surface(_ id: String) -> AgentWire.Surface? { surfaces.first { $0.id == id } }

    /// The conversation a space's row stands for.
    func conversation(_ space: AgentWire.Space) -> AgentWire.Agent? {
        switch space.target.kind {
        case "task": task(space.target.id)?.agent
        case "bot": bot(space.target.id)?.agent
        case "agent": space.target.agentId.flatMap(agent)
        default: nil
        }
    }

    /// Any conversation in a task's or bot's subtask tree, at any depth.
    func agent(_ id: String) -> AgentWire.Agent? {
        func find(_ agents: [AgentWire.Agent]) -> AgentWire.Agent? {
            for agent in agents {
                if agent.id == id { return agent }
                if let nested = find(agent.subtasks ?? []) { return nested }
            }
            return nil
        }
        return find(tasks.compactMap(\.agent) + bots.compactMap(\.agent))
    }

    func isHappy(_ space: AgentWire.Space) -> Bool {
        space.target.kind == "bot" && bot(space.target.id)?.systemKey == Self.happyBotKey
    }
}

/// One drawn row of the Stem Cells sidebar, as `happyAgentSpacesItems` makes
/// it: everything a cell renders, and nothing it does not, so two equal rows
/// draw the same.
public struct StemCellsRow: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable {
        case search, create, section, separator, widget, space, session
    }

    /// The mark in a row's leading lane.
    public enum Mark: Equatable, Sendable {
        /// No mark and no lane: the label starts where the mark would.
        case none
        /// Happy's own logo.
        case happy
        /// The stem cell, its shape seeded by the space ID.
        case stemCell(seed: String)
        /// A clay icon from the library, drawn as it stands.
        case clay(String)
        /// A picture read from the daemon, drawn as a rounded square.
        case image(path: String, thumbhash: String?)
        /// A plain glyph: "search", "compose", "tasks", "agents", "doc",
        /// "calendar", "pulse" or "users".
        case glyph(String)
    }

    public enum Status: Equatable, Sendable {
        case none, working, waiting, awaitingInput
    }

    /// Unique among the rows: `space:<id>`, `session:<agentId>`, or the node ID.
    public var id: String
    /// The document node this row stands for.
    public var nodeId: String
    public var kind: Kind
    public var depth: Int
    public var label: String
    public var mark: Mark
    public var status: Status
    public var unread: Bool
    /// Set when something folds under it: whether it is folded now.
    public var collapsed: Bool?
    /// Happy's own row, which never goes under another.
    public var isHappy: Bool
    /// Where the row opens: its conversation and the workspace it runs in.
    public var agentId: String?
    public var workspaceId: String?
    public var spaceId: String?
    /// `task`, `bot`, `surface` or `agent` for a space's row.
    public var targetKind: String?
    /// New work nobody named yet, which "Close new work" may close.
    public var isUntouchedStemCell: Bool
    /// The task or bot the row stands for, and whether the person may archive it.
    public var targetId: String?
    public var canArchive = false
    /// The row's conversation's subtasks as they nest, which "Show subtasks"
    /// puts under it; whether some are not drawn, and whether some are.
    public var sessions: [SidebarDocumentEdits.SessionTree] = []
    public var hasHiddenSessions = false
    public var hasShownSessions = false
    /// A Surface row's type: `todo`, `document`, `calendar`, `system_monitor` or `chat`.
    public var surfaceType: String?

    public init(id: String, nodeId: String, kind: Kind, depth: Int = 0, label: String, mark: Mark = .none, status: Status = .none, unread: Bool = false, collapsed: Bool? = nil, isHappy: Bool = false, agentId: String? = nil, workspaceId: String? = nil, spaceId: String? = nil, targetKind: String? = nil, isUntouchedStemCell: Bool = false) {
        self.id = id
        self.nodeId = nodeId
        self.kind = kind
        self.depth = depth
        self.label = label
        self.mark = mark
        self.status = status
        self.unread = unread
        self.collapsed = collapsed
        self.isHappy = isHappy
        self.agentId = agentId
        self.workspaceId = workspaceId
        self.spaceId = spaceId
        self.targetKind = targetKind
        self.isUntouchedStemCell = isUntouchedStemCell
    }

    public var opens: Bool { kind == .space || kind == .session || kind == .search || kind == .create }
}

/// The document as the rows the sidebar draws.
public enum StemCellsRows {
    public struct Labels: Equatable, Sendable {
        public var search: String
        public var create: String
        /// A space with no title yet.
        public var untitled: String
        /// A session the lists know with no title yet.
        public var untitledSession: String
        /// Prioritizing's own markup, never drawn as HTML.
        public var widget: String

        public init(search: String = "Search", create: String = "Create", untitled: String = "New", untitledSession: String = "Untitled", widget: String = "Prioritizing") {
            self.search = search
            self.create = create
            self.untitled = untitled
            self.untitledSession = untitledSession
            self.widget = widget
        }
    }

    /// Every row in document order, folded ones included.
    public static func all(_ document: SpaceSidebarDocument, spaces: [String: AgentWire.Space], places: StemCellsPlaces, agentIcons: [String: AgentWire.LibraryIcon], labels: Labels = Labels()) -> [StemCellsRow] {
        var rows: [StemCellsRow] = []
        var held = Set<String>()
        func hold(_ node: SpaceSidebarNode) {
            guard node.kind == .space else { return }
            held.insert(node.id)
            node.children.forEach(hold)
        }
        document.items.forEach(hold)
        for node in document.items {
            switch node.kind {
            case .search:
                rows.append(StemCellsRow(id: node.id, nodeId: node.id, kind: .search, label: labels.search, mark: .glyph("search")))
            case .create:
                rows.append(StemCellsRow(id: node.id, nodeId: node.id, kind: .create, label: labels.create, mark: .glyph("compose")))
            case .section:
                rows.append(StemCellsRow(id: node.id, nodeId: node.id, kind: .section, label: node.label, collapsed: node.collapsed))
            case .separator:
                rows.append(StemCellsRow(id: node.id, nodeId: node.id, kind: .separator, label: ""))
            case .widget:
                rows.append(StemCellsRow(id: node.id, nodeId: node.id, kind: .widget, label: widgetText(node.html) ?? labels.widget))
            case .space:
                // A space this client does not know yet draws nothing until it does.
                guard let space = spaces[node.id], knownTarget(space) else { continue }
                rows.append(contentsOf: spaceRows(node, space, depth: 0, spaces: spaces, places: places, agentIcons: agentIcons, labels: labels, held: held))
            }
        }
        return rows
    }

    /// The rows a fold leaves showing: a folded section takes every row up
    /// to the next section or separator, a folded row its whole tree.
    public static func visible(_ rows: [StemCellsRow]) -> [StemCellsRow] {
        var shown: [StemCellsRow] = []
        var hiddenBelow: Int?
        var runHidden = false
        for row in rows {
            if (row.kind == .section || row.kind == .separator) && row.depth == 0 {
                hiddenBelow = nil
                runHidden = row.kind == .section && row.collapsed == true
                shown.append(row)
                continue
            }
            if runHidden { continue }
            if let below = hiddenBelow {
                if row.depth >= below { continue }
                hiddenBelow = nil
            }
            shown.append(row)
            if row.collapsed == true { hiddenBelow = row.depth + 1 }
        }
        return shown
    }

    static func knownTarget(_ space: AgentWire.Space) -> Bool {
        ["task", "bot", "surface", "agent"].contains(space.target.kind)
    }

    private static func spaceRows(_ node: SpaceSidebarNode, _ space: AgentWire.Space, depth: Int, spaces: [String: AgentWire.Space], places: StemCellsPlaces, agentIcons: [String: AgentWire.LibraryIcon], labels: Labels, held: Set<String>) -> [StemCellsRow] {
        let children = nested(node.children, depth: depth + 1, spaces: spaces, places: places, agentIcons: agentIcons, labels: labels, held: held)
        let conversation = places.conversation(space)
        var row = StemCellsRow(
            id: "space:\(space.id)", nodeId: node.id, kind: .space, depth: depth,
            label: space.title ?? labels.untitled,
            mark: mark(space, places: places),
            status: status(conversation, working: space.working),
            unread: conversation?.unread != nil,
            collapsed: children.isEmpty ? nil : !node.expanded,
            isHappy: places.isHappy(space),
            agentId: space.target.agentId, workspaceId: space.target.workspaceId,
            spaceId: space.id, targetKind: space.target.kind,
            isUntouchedStemCell: space.target.kind == "task" && space.title == nil && space.icon == .stemCell
        )
        if row.workspaceId == nil, let agentId = row.agentId { row.workspaceId = places.agent(agentId)?.workspaceId }
        row.targetId = space.target.id
        row.sessions = sessionTree(conversation?.subtasks ?? [])
        row.hasHiddenSessions = hasMissing(row.sessions, under: node, held: held)
        // Subtasks not yet in the sidebar: folded, and unfolding brings them.
        if row.collapsed == nil, row.hasHiddenSessions { row.collapsed = true }
        row.hasShownSessions = node.children.contains { spaces[$0.id] == nil && places.agent($0.id) != nil }
        if space.target.kind == "surface" { row.surfaceType = places.surface(space.target.id)?.type }
        // A bot can always be archived; a task only where the daemon says so.
        row.canArchive = space.target.kind == "bot" || places.task(space.target.id)?.canArchive == true
        return [row] + children
    }

    static func sessionTree(_ agents: [AgentWire.Agent]) -> [SidebarDocumentEdits.SessionTree] {
        agents.filter { $0.archivedAt == nil }.map { SidebarDocumentEdits.SessionTree(id: $0.id, children: sessionTree($0.subtasks ?? [])) }
    }

    /// Whether showing `node`'s sessions would bring any, as
    /// `revealSessions` walks them: one the document doesn't hold, or one
    /// missing under a session nested here. A session held elsewhere is
    /// that place's to show.
    static func hasMissing(_ trees: [SidebarDocumentEdits.SessionTree], under node: SpaceSidebarNode, held: Set<String>) -> Bool {
        trees.contains { tree in
            guard held.contains(tree.id) else { return true }
            guard let child = node.children.first(where: { $0.id == tree.id }) else { return false }
            return hasMissing(tree.children, under: child, held: held)
        }
    }

    private static func nested(_ nodes: [SpaceSidebarNode], depth: Int, spaces: [String: AgentWire.Space], places: StemCellsPlaces, agentIcons: [String: AgentWire.LibraryIcon], labels: Labels, held: Set<String>) -> [StemCellsRow] {
        var rows: [StemCellsRow] = []
        for node in nodes where node.kind == .space {
            if let space = spaces[node.id] {
                guard knownTarget(space) else { continue }
                rows.append(contentsOf: spaceRows(node, space, depth: depth, spaces: spaces, places: places, agentIcons: agentIcons, labels: labels, held: held))
                continue
            }
            // A session the lists do not know yet draws nothing until they do.
            guard let agent = places.agent(node.id) else { continue }
            let children = nested(node.children, depth: depth + 1, spaces: spaces, places: places, agentIcons: agentIcons, labels: labels, held: held)
            var row = StemCellsRow(
                id: "session:\(node.id)", nodeId: node.id, kind: .session, depth: depth,
                label: agent.title ?? labels.untitledSession,
                mark: agentIcons[node.id].map { ClayIcons.contains($0.slug) ? .clay($0.slug) : .none } ?? .none,
                status: status(agent, working: false),
                unread: agent.unread != nil,
                collapsed: children.isEmpty ? nil : !node.expanded,
                agentId: agent.id, workspaceId: agent.workspaceId
            )
            // A subtask's own subtasks show and hide under it as a row's do.
            row.sessions = sessionTree(agent.subtasks ?? [])
            row.hasHiddenSessions = hasMissing(row.sessions, under: node, held: held)
            // Subtasks not yet in the sidebar: folded, and unfolding brings them.
            if row.collapsed == nil, row.hasHiddenSessions { row.collapsed = true }
            row.hasShownSessions = node.children.contains { spaces[$0.id] == nil && places.agent($0.id) != nil }
            rows.append(row)
            rows.append(contentsOf: children)
        }
        return rows
    }

    /// `happyAgentSpaceMark`: Happy's logo; the stem cell while the work takes
    /// shape; the chosen clay icon or picture; a face; then the stem cell for
    /// unnamed work or the plain glyph of what it is.
    static func mark(_ space: AgentWire.Space, places: StemCellsPlaces) -> StemCellsRow.Mark {
        if places.isHappy(space) { return .happy }
        switch space.icon {
        case .stemCell?: return .stemCell(seed: space.id)
        case .library(let slug)? where ClayIcons.contains(slug): return .clay(slug)
        case .image(let url)?:
            let thumbhash = space.target.kind == "bot" ? places.bot(space.target.id)?.avatar?.thumbhash : nil
            return .image(path: url, thumbhash: thumbhash)
        default: break
        }
        if space.target.kind == "bot", let bot = places.bot(space.target.id), bot.avatar != nil {
            return .image(path: "/v0/bots/\(bot.id)/avatar", thumbhash: bot.avatar?.thumbhash)
        }
        if space.title == nil { return .stemCell(seed: space.id) }
        switch space.target.kind {
        case "surface": return .glyph(surfaceGlyph(places.surface(space.target.id)?.type))
        case "task": return .glyph("tasks")
        default: return .glyph("agents")
        }
    }

    /// The glyph desktop's Create menu gives each kind of Surface.
    public static func surfaceGlyph(_ type: String?) -> String {
        switch type {
        case "todo": "tasks"
        case "calendar": "calendar"
        case "system_monitor": "pulse"
        case "chat": "users"
        default: "doc"
        }
    }

    static func status(_ agent: AgentWire.Agent?, working: Bool) -> StemCellsRow.Status {
        if agent?.pendingQuestionId != nil { return .awaitingInput }
        if agent?.wait != nil { return .waiting }
        if working || agent?.isWorking == true { return .working }
        return .none
    }

    /// A widget's words without its markup; nil when it has none.
    static func widgetText(_ html: String) -> String? {
        var text = ""
        var inTag = false
        for character in html {
            if character == "<" { inTag = true; text.append(" ") }
            else if character == ">" { inTag = false }
            else if !inTag { text.append(character) }
        }
        let words = SpaceSidebar.decodeEntities(text).split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return words.isEmpty ? nil : words
    }
}

/// Where a row dragged on a phone lands. A phone doesn't draw desktop's
/// Search and Create rows, but they stay in the document: they never move,
/// and every drop is anchored on the rows the person can see, so desktop's
/// order doesn't shift around them.
public enum StemCellsDrop {
    /// Kept in the document for desktop; never drawn on a phone.
    public static func isHidden(_ row: StemCellsRow) -> Bool {
        row.kind == .search || row.kind == .create
    }

    /// A row the person can pick up: a space, a section, a separator or a
    /// widget, never Happy's own row, a session or a hidden one.
    public static func canMove(_ row: StemCellsRow) -> Bool {
        !isHidden(row) && !row.isHappy && [.space, .section, .separator, .widget].contains(row.kind)
    }

    /// The top-level node `moving` is set down after when it is dropped
    /// just above the drawn top-level row `before` (nil: below the last).
    /// A drop at the very top lands right after whatever hidden node sits
    /// before the first drawn row (Create), never before it. Nil when the
    /// row can't move there, or `before` is hidden. `rows` are all of them,
    /// hidden ones included, so the anchor is the document's real neighbour.
    public static func after(_ moving: String, droppedBefore before: String?, rows: [StemCellsRow]) -> String?? {
        guard let row = rows.first(where: { $0.nodeId == moving }), canMove(row), row.depth == 0 else { return nil }
        let top = rows.filter { $0.depth == 0 && $0.nodeId != moving }
        guard let before else { return .some(top.last?.nodeId) }
        guard let index = top.firstIndex(where: { $0.nodeId == before }), !isHidden(top[index]) else { return nil }
        return .some(index > 0 ? top[index - 1].nodeId : nil)
    }
}
