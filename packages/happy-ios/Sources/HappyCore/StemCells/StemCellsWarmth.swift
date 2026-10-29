import Foundation

/// Which conversations a phone reads ahead and keeps, so opening one shows
/// its transcript at once: desktop's read-ahead (`connectHappyAgent.ts`
/// `recentAgents`, `preloadRecentSessions`, `prefetchSession`,
/// `releaseSession`) and its retention (`happyAgentConversationRetention.ts`),
/// with the signals a phone's sidebar has.
///
/// Both read ahead what the sidebar shows (one rule, agreed with desktop):
/// the conversations whose rows are on screen, top to bottom, then those
/// just off it, nearest first, the one below before the one above, the
/// top 12 one at a time once nothing else is loading. Rows a fold hides
/// aren't shown, so they aren't read.
public enum StemCellsWarmth {
    public enum Limits {
        /// `PRELOADED_SESSIONS`: read ahead from the ranking.
        public static let preloaded = 12
        /// `PREFETCHED_SESSION_LIMIT`: read on a finger's intent and never
        /// opened, newest kept.
        public static let prefetched = 6
        /// `RELEASED_SESSION_LIMIT`: opened and left, kept for a quick return.
        public static let released = 16
        /// Low Data Mode, Low Power Mode or a hot phone: only the top few.
        public static let constrained = 3
        /// `PRELOAD_DELAY_MS`: after the sidebar lands, so its first paint
        /// and an open go first.
        public static let delay: Duration = .milliseconds(1_500)
        /// `PRELOAD_BUSY_WAIT_MS`: how often a read-ahead looks again while
        /// a conversation someone opened is still loading.
        public static let busyWait: Duration = .milliseconds(100)
    }

    /// One conversation the sidebar shows.
    public struct Candidate: Equatable, Sendable {
        public var agentId: String
        /// Its first row's place among the rows the sidebar shows.
        public var row: Int

        public init(agentId: String, row: Int) {
            self.agentId = agentId
            self.row = row
        }
    }

    /// The conversations of the rows the sidebar shows (`rows`, folds
    /// applied), once each at its first row: every row that opens one.
    public static func candidates(_ rows: [StemCellsRow]) -> [Candidate] {
        var seen = Set<String>()
        var found: [Candidate] = []
        for (index, row) in rows.enumerated() where row.kind == .space || row.kind == .session {
            guard row.targetKind != "surface", let agentId = row.agentId, seen.insert(agentId).inserted else { continue }
            found.append(Candidate(agentId: agentId, row: index))
        }
        return found
    }

    /// The `limit` most likely opened next, most likely first: the rows in
    /// `visible` (places among the rows shown) top to bottom, then the
    /// rest by how many rows they are from it, the one below before the
    /// one above. Nil before the sidebar is measured: the first rows.
    public static func ranked(_ candidates: [Candidate], visible: ClosedRange<Int>?, limit: Int) -> [String] {
        let visible = visible ?? (0...0)
        func key(_ candidate: Candidate) -> (Int, Int, Int) {
            if visible.contains(candidate.row) { return (0, candidate.row, 0) }
            return candidate.row > visible.upperBound ? (1, candidate.row - visible.upperBound, 0) : (1, visible.lowerBound - candidate.row, 1)
        }
        return candidates.sorted { key($0) < key($1) }.prefix(max(0, limit)).map(\.agentId)
    }

    /// How many kept conversations also keep their transcripts laid out,
    /// ready to draw: desktop's retention for the memory a device has
    /// (`happyAgentConversationRetentionFor`), one view per gigabyte, the
    /// one on screen included, between two and eight.
    public static func laidOut(physicalMemory bytes: UInt64) -> Int {
        let gigabytes = Int(bytes / 1_000_000_000)
        return min(8, max(2, gigabytes)) - 1
    }

    /// A conversation read and kept: on screen (`held`), or when it was
    /// last left and last reached for, in a count that only grows.
    public struct Kept: Equatable, Sendable {
        public var agentId: String
        public var held: Bool
        /// Opened and left; nil if never opened.
        public var left: Int?
        /// Read on a finger's intent; nil if never.
        public var intent: Int?

        public init(agentId: String, held: Bool = false, left: Int? = nil, intent: Int? = nil) {
            self.agentId = agentId
            self.held = held
            self.left = left
            self.intent = intent
        }
    }

    /// What stays of `kept`: what is on screen and what the ranking wants,
    /// the `released` last left (`releaseSession`), and the `prefetched`
    /// last reached for and never opened (`prefetchSession`). The rest goes.
    public static func retained(_ kept: [Kept], wanted: [String], released: Int = Limits.released, prefetched: Int = Limits.prefetched) -> Set<String> {
        var stays = Set(wanted).intersection(kept.map(\.agentId))
        for one in kept where one.held { stays.insert(one.agentId) }
        let left = kept.filter { $0.left != nil }.sorted { $0.left! > $1.left! }.prefix(max(0, released))
        let reached = kept.filter { $0.left == nil && $0.intent != nil }.sorted { $0.intent! > $1.intent! }.prefix(max(0, prefetched))
        for one in left { stays.insert(one.agentId) }
        for one in reached { stays.insert(one.agentId) }
        return stays
    }

    /// Which kept conversations also keep their rows laid out, `budget` of
    /// them: the last reached for first, as a finger on a row is the
    /// likeliest open, then the one just left, for a way back, then the
    /// ranking's order, then the rest left.
    public static func planned(_ kept: [Kept], ranked: [String], budget: Int) -> [String] {
        let known = Set(kept.map(\.agentId))
        let reached = kept.filter { $0.intent != nil && !$0.held }.sorted { $0.intent! > $1.intent! }.map(\.agentId)
        let left = kept.filter { $0.left != nil && !$0.held }.sorted { $0.left! > $1.left! }.map(\.agentId)
        var seen = Set<String>()
        var order: [String] = []
        for id in reached + left.prefix(1) + ranked + left where known.contains(id) && seen.insert(id).inserted {
            if kept.first(where: { $0.agentId == id })?.held == true { continue }
            order.append(id)
        }
        return Array(order.prefix(max(0, budget)))
    }
}
