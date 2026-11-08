import Foundation

/// Home's search, typed into the header: the sidebar narrowed to what
/// answers the query, in its own order, then quick actions and settings,
/// ranked as desktop's ⌘K palette ranks them (happy-desktop
/// `commandPaletteResults.ts`).
public enum Search {
    /// How many quick actions or settings a query shows: desktop's `SECTION_LIMIT`.
    public static let sectionLimit = 6

    /// What a match in anything but the title loses: it ranks under every
    /// title match (desktop's `SECONDARY_PENALTY`).
    public static let secondaryPenalty = 3

    /// How well `text` answers `query`, as desktop's `rowRank`: 0 it starts
    /// with it, 1 a word in it does, 2 it holds it anywhere; a query of
    /// several words ranks, in any order, as its weakest word does, never
    /// 0. What a row answers to below its title (`secondary`, a Surface's
    /// kind) ranks `secondaryPenalty` lower, and the words may be split
    /// between the two. Nil: it doesn't answer. Case and accents don't count.
    public static func rank(_ text: String, _ query: String, secondary: [String] = []) -> Int? {
        let needle = fold(query.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !needle.isEmpty else { return nil }
        let words = needle.split(whereSeparator: \.isWhitespace).map(String.init)
        let title = fold(text)
        let primary = textRank(title, needle) ?? wordsRank(title, words)
        if primary == 0 { return 0 }
        var best = primary
        func demote(_ rank: Int?) {
            guard let rank else { return }
            if best == nil || rank + secondaryPenalty < best! { best = rank + secondaryPenalty }
        }
        let supporting = secondary.map(fold)
        supporting.forEach { demote(textRank($0, needle)) }
        if !supporting.isEmpty { demote(wordsRank(([title] + supporting).joined(separator: " "), words)) }
        return best
    }

    /// Several `words` all in `haystack`, in any order, as the weakest
    /// ranks; never a prefix, which only the whole query can be.
    private static func wordsRank(_ haystack: String, _ words: [String]) -> Int? {
        guard words.count > 1 else { return nil }
        var worst = 1
        for word in words {
            guard let rank = textRank(haystack, word) else { return nil }
            worst = max(worst, rank)
        }
        return worst
    }

    /// `needle` in `haystack`, both folded: 0 at its start, 1 at a word's, 2 anywhere.
    private static func textRank(_ haystack: String, _ needle: String) -> Int? {
        if haystack.hasPrefix(needle) { return 0 }
        var from = haystack.startIndex
        var holds = false
        while let found = haystack.range(of: needle, range: from..<haystack.endIndex) {
            holds = true
            let before = haystack[haystack.index(before: found.lowerBound)]
            if !before.isLetter && !before.isNumber { return 1 }
            from = haystack.index(after: found.lowerBound)
        }
        return holds ? 2 : nil
    }

    private static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
    }

    /// The `items` that answer `query`, best first and, among equals, in
    /// their own order; at most `limit`.
    public static func ranked<Item>(_ items: [Item], query: String, limit: Int = sectionLimit, title: (Item) -> String) -> [Item] {
        items.enumerated()
            .compactMap { entry in rank(title(entry.element), query).map { (rank: $0, index: entry.offset, item: entry.element) } }
            .sorted { ($0.rank, $0.index) < ($1.rank, $1.index) }
            .prefix(limit)
            .map(\.item)
    }

    /// Something the phone found in what it already holds, keyed as the
    /// computer keys its results (`<type>:<id>`, API.md "Search") so the
    /// two lists fuse (`fuse`).
    public enum Found: Equatable, Sendable {
        case row(Row)
        case surface(AgentWire.Surface)
        case artifact(ArtifactSummary)
        /// An open todo of a list in the sidebar, and its list.
        case todo(TodoItem, list: AgentWire.Surface)

        public var label: String {
            switch self {
            case .row(let row): row.label
            case .surface(let surface): surface.name
            case .artifact(let artifact): artifact.title
            case .todo(let todo, _): todo.text
            }
        }
    }

    /// One of the phone's own results: its key, what it is, how well its
    /// name answers (`rank`), and the line under it (desktop's meta).
    public struct Local: Equatable, Sendable {
        public var key: String
        public var found: Found
        public var rank: Int
        public var detail: String?
    }

    /// A sidebar row's key: a conversation is its agent's, a Surface its
    /// own (a document's as a document), and any other space only the
    /// phone's, which the computer never returns.
    public static func key(_ row: Row) -> String? {
        switch row.kind {
        case .session:
            return row.agentId.map { "agent:\($0)" }
        case .space:
            if row.targetKind == "surface", let id = row.targetId { return row.surfaceType == "document" ? "document:\(id)" : "surface:\(id)" }
            if ["task", "bot", "agent"].contains(row.targetKind ?? ""), let agentId = row.agentId { return "agent:\(agentId)" }
            return row.id
        default:
            return nil
        }
    }

    public static func key(_ surface: AgentWire.Surface) -> String {
        surface.type == "document" ? "document:\(surface.id)" : "surface:\(surface.id)"
    }

    /// The Surface kinds found by their own name (desktop's `surfaceRows`):
    /// one that only points at an artifact, a bot or a task is found under
    /// that thing's name, and a kind this build doesn't know isn't found.
    static let surfaceKinds: Set<String> = ["todo", "document", "calendar", "system_monitor", "chat", "vault"]

    /// What the phone finds for `query` in what it holds, as desktop's
    /// palette finds its own (`localFound`): the sidebar's bots, tasks and
    /// conversations, each also by its subtasks' titles (which aren't
    /// found apart), and the tasks the person isn't in (`unjoined`); its
    /// Surfaces, and the catalog's it isn't in; the open todos of its lists
    /// (`todos`, by list, as read); and the artifacts.
    /// Best name first (`rank`, a Surface also by its kind and an artifact
    /// by its type), then what is the person's own before what isn't
    /// (desktop's tier: a project's conversation or a Surface not joined,
    /// then a todo), then the latest changed. A key the sidebar holds is
    /// its row, which opens as the sidebar does.
    public static func local(rows: [Row], unjoined: [Row] = [], surfaces: [AgentWire.Surface] = [], artifacts: [ArtifactSummary] = [], todos: [String: [TodoItem]] = [:], query: String) -> [Local] {
        struct Candidate {
            var key: String
            var found: Found
            var secondary: [String] = []
            var tier = 0
            var updatedAt: Double = 0
            var detail: String?
        }
        let catalog = Dictionary(surfaces.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let line = { (parts: [String?]) -> String? in
            let shown = parts.compactMap { $0 }.joined(separator: " · ")
            return shown.isEmpty ? nil : shown
        }
        var candidates: [Candidate] = []
        var lists: [AgentWire.Surface] = []
        var joined: Set<String> = []
        // The rows above this one, and the bot's or task's result a subtask under it adds its title to.
        var above: [(row: Row, work: Int?)] = []
        for row in rows where row.kind == .space || row.kind == .session {
            while let last = above.last, last.row.depth >= row.depth { above.removeLast() }
            let parent = above.last
            if row.kind == .session, let work = parent?.work {
                candidates[work].secondary.append(row.label)
                above.append((row, work))
                continue
            }
            var flat = row
            flat.depth = 0
            flat.collapsed = nil
            flat.hasHiddenSessions = false
            guard let key = key(row) else { continue }
            var candidate = Candidate(key: key, found: .row(flat), updatedAt: row.activityTime ?? 0)
            switch row.targetKind {
            case "surface":
                guard let id = row.targetId else { continue }
                joined.insert(id)
                let type = row.surfaceType ?? catalog[id]?.type
                guard surfaceKinds.contains(type ?? "") else { continue }
                if type == "todo" { lists.append(AgentWire.Surface(id: id, type: "todo", name: catalog[id]?.name ?? row.label)) }
                candidate.secondary = [surfaceTypeLabel(type)]
                candidate.updatedAt = catalog[id]?.updatedAt ?? 0
                candidate.detail = line([surfaceTypeLabel(type), type == "todo" ? todos[id].map { "\(open($0).count) open" } : nil])
            case "task", "bot", "agent":
                candidate.detail = agentKindLabel(row.targetKind == "agent" ? "chat" : row.targetKind)
            default:
                if row.kind == .session {
                    // A project's conversation is one of its tabs on desktop, after what the sidebar lists.
                    let project = parent?.row.targetKind == "project" ? parent?.row.label : nil
                    candidate.tier = project == nil ? 0 : 1
                    candidate.detail = project ?? agentKindLabel("chat")
                }
            }
            above.append((row, ["task", "bot", "agent"].contains(row.targetKind ?? "") ? candidates.count : nil))
            candidates.append(candidate)
        }
        for row in unjoined {
            guard let agentId = row.agentId else { continue }
            candidates.append(Candidate(key: "agent:\(agentId)", found: .row(row), tier: 1, updatedAt: row.activityTime ?? 0, detail: "Task you have not joined"))
        }
        for surface in surfaces where !joined.contains(surface.id) && surfaceKinds.contains(surface.type) {
            candidates.append(Candidate(key: key(surface), found: .surface(surface), secondary: [surfaceTypeLabel(surface.type)], tier: 1,
                                        updatedAt: surface.updatedAt ?? 0, detail: line([surfaceTypeLabel(surface.type), "not joined"])))
        }
        // A todo is found by what it says, never by its list's name, under its list's own row.
        for list in lists {
            for todo in open(todos[list.id] ?? []) {
                candidates.append(Candidate(key: "todo:\(todo.id)", found: .todo(todo, list: list), tier: 2, updatedAt: todo.updatedAt, detail: list.name))
            }
        }
        for artifact in artifacts where !artifact.deleted {
            candidates.append(Candidate(key: "artifact:\(artifact.id)", found: .artifact(artifact), secondary: [artifactTypeLabel(artifact.type)],
                                        updatedAt: artifact.updatedAt, detail: artifactTypeLabel(artifact.type)))
        }
        var seen: Set<String> = []
        return candidates.enumerated()
            .compactMap { entry -> (order: (Int, Int, Double, Int), local: Local)? in
                let candidate = entry.element
                guard let rank = rank(candidate.found.label, query, secondary: candidate.secondary) else { return nil }
                return ((rank, candidate.tier, -candidate.updatedAt, entry.offset), Local(key: candidate.key, found: candidate.found, rank: rank, detail: candidate.detail))
            }
            .sorted { $0.order < $1.order }
            .filter { seen.insert($0.local.key).inserted }
            .map(\.local)
    }

    /// A list's open todos, as desktop counts them: no heading among them.
    private static func open(_ todos: [TodoItem]) -> [TodoItem] {
        todos.filter { $0.status == .active && $0.heading == nil }
    }

    /// How many bots and tasks an empty search shows.
    public static let recentLimit = 8

    /// What an empty search shows: the bots and tasks last active, newest
    /// first and, among equals, in the sidebar's order; at most `limit`. A
    /// bot's or task's activity is its own or its subtasks', whichever is
    /// latest, and it shows alone, without them. One never active isn't
    /// recent, so a computer with none shows nothing.
    public static func recent(_ all: [Row], limit: Int = recentLimit) -> [Row] {
        var active: [(index: Int, time: Double, row: Row)] = []
        var index = 0
        while index < all.count {
            let row = all[index]
            var end = index + 1
            while end < all.count, all[end].depth > row.depth { end += 1 }
            if row.depth == 0, row.kind == .space, row.agentId != nil, row.targetKind == "bot" || row.targetKind == "task",
               let time = all[index..<end].compactMap(\.activityTime).max() {
                active.append((index, time, row))
            }
            index = row.depth == 0 ? end : index + 1
        }
        return active.sorted { ($0.time, -$0.index) > ($1.time, -$1.index) }.prefix(limit).map { entry in
            var row = entry.row
            row.collapsed = nil
            row.hasHiddenSessions = false
            return row
        }
    }

    /// The sidebar's rows that answer `query`, folded away or not, in the
    /// sidebar's own order, with what makes sense of each: a nested match
    /// keeps the rows it nests under, and every match keeps its section's
    /// heading. A heading that answers keeps its whole section. Nothing
    /// folds here: the rows come without chevrons, and the document's own
    /// folds are untouched for when the search ends.
    public static func rows(_ all: [Row], query: String) -> [Row] {
        var kept = Set<Int>()
        /// The rows each depth's latest row nests under, down from the top.
        var ancestors: [Int] = []
        var section: Int?
        var sectionAnswers = false
        for (index, row) in all.enumerated() {
            switch row.kind {
            case .section where row.depth == 0:
                section = index
                ancestors = []
                sectionAnswers = rank(row.label, query) != nil
                if sectionAnswers { kept.insert(index) }
            case .separator where row.depth == 0:
                section = nil
                ancestors = []
                sectionAnswers = false
            case .space, .session:
                ancestors = Array(ancestors.prefix(row.depth))
                if sectionAnswers || rank(row.label, query) != nil {
                    kept.insert(index)
                    kept.formUnion(ancestors)
                    if let section { kept.insert(section) }
                }
                ancestors.append(index)
            default:
                continue
            }
        }
        return all.indices.filter(kept.contains).map { index in
            var row = all[index]
            row.collapsed = nil
            row.hasHiddenSessions = false
            return row
        }
    }
}
