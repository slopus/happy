import Foundation

/// Home's search, typed into the header: the sidebar narrowed to what
/// answers the query, in its own order, then quick actions and settings,
/// ranked as desktop's ⌘K palette ranks them (happy-desktop
/// `commandPaletteResults.ts`).
public enum Search {
    /// How many quick actions or settings a query shows: desktop's `SECTION_LIMIT`.
    public static let sectionLimit = 6

    /// How well `text` answers `query`, as desktop's `textRank`: 0 it starts
    /// with it, 1 a word in it does, 2 it holds it anywhere; nil it doesn't.
    /// Case and accents don't count.
    public static func rank(_ text: String, _ query: String) -> Int? {
        let needle = fold(query.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !needle.isEmpty else { return nil }
        let haystack = fold(text)
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

        public var label: String {
            switch self {
            case .row(let row): row.label
            case .surface(let surface): surface.name
            case .artifact(let artifact): artifact.title
            }
        }
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

    /// The computer's provider order (API.md "Result types"), which breaks
    /// ties between equally good names here as it does there; spaces,
    /// which it has no type for, last.
    private static let providers = ["vault_file", "vault_folder", "document", "message", "todo", "calendar_event", "artifact", "surface", "agent", "project", "workspace", "user", "skill"]

    private static func provider(_ key: String) -> Int {
        let type = key.prefix { $0 != ":" }
        return providers.firstIndex { $0 == type } ?? providers.count
    }

    /// What the phone finds for `query` in what it holds: the sidebar's
    /// conversations and Surfaces, the Surface catalog and the artifacts,
    /// one result per key, best name first (`rank`), then in the
    /// computer's provider order, then in their own. A key the sidebar
    /// holds is its row, which opens as the sidebar does.
    public static func local(rows: [Row], surfaces: [AgentWire.Surface] = [], artifacts: [ArtifactSummary] = [], query: String) -> [(key: String, found: Found)] {
        var candidates: [(key: String, found: Found)] = []
        for row in rows where row.kind == .space || row.kind == .session {
            guard let key = key(row) else { continue }
            var row = row
            row.depth = 0
            row.collapsed = nil
            row.hasHiddenSessions = false
            candidates.append((key, .row(row)))
        }
        candidates += surfaces.map { (key($0), .surface($0)) }
        candidates += artifacts.filter { !$0.deleted }.map { ("artifact:\($0.id)", .artifact($0)) }
        var best: [String: (rank: Int, provider: Int, index: Int, found: Found)] = [:]
        for (index, candidate) in candidates.enumerated() {
            guard let rank = rank(candidate.found.label, query) else { continue }
            let entry = (rank: rank, provider: provider(candidate.key), index: index, found: candidate.found)
            guard let held = best[candidate.key] else {
                best[candidate.key] = entry
                continue
            }
            // The sidebar's row stands for the key, at the better of the two places.
            let found: Found = if case .row = held.found { held.found } else { entry.found }
            let placed = (held.rank, held.index) <= (entry.rank, entry.index) ? held : entry
            best[candidate.key] = (placed.rank, placed.provider, placed.index, found)
        }
        return best.sorted { ($0.value.rank, $0.value.provider, $0.value.index) < ($1.value.rank, $1.value.provider, $1.value.index) }
            .map { ($0.key, $0.value.found) }
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
