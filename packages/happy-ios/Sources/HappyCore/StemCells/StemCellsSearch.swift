import Foundation

/// Home's search, typed into the header: the sidebar narrowed to what
/// answers the query, in its own order, then quick actions and settings,
/// ranked as desktop's ⌘K palette ranks them (happy-desktop
/// `commandPaletteResults.ts`).
public enum StemCellsSearch {
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

    /// The sidebar's rows that answer `query`, folded away or not, in the
    /// sidebar's own order, with what makes sense of each: a nested match
    /// keeps the rows it nests under, and every match keeps its section's
    /// heading. A heading that answers keeps its whole section. Nothing
    /// folds here: the rows come without chevrons, and the document's own
    /// folds are untouched for when the search ends.
    public static func rows(_ all: [StemCellsRow], query: String) -> [StemCellsRow] {
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
