import Foundation

/// Which conversations a phone reads ahead and keeps, so opening one shows
/// its transcript at once: desktop's read-ahead (`connectHappyAgent.ts`
/// `recentAgents`, `preloadRecentSessions`, `prefetchSession`,
/// `releaseSession`) and its retention (`happyAgentConversationRetention.ts`),
/// with the signals a phone's sidebar has.
///
/// Desktop ranks every active agent the sidebar can show, running ones
/// first, then the most recently updated, and reads the top 12 one at a
/// time once nothing else is loading. The phone has no agent `updatedAt` in
/// its rows, and shows a dozen of a hundred at a time, so what stands for
/// "recently updated" here is what a thumb can reach: the rows on screen,
/// top first, then news the person hasn't read, then the conversations they last
/// left, then the rest in the sidebar's order.
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

    /// One conversation the sidebar can open.
    public struct Candidate: Equatable, Sendable {
        public var agentId: String
        /// Working, waiting or asking: desktop's `status !== "idle"`.
        public var running: Bool
        public var unread: Bool

        public init(agentId: String, running: Bool, unread: Bool) {
            self.agentId = agentId
            self.running = running
            self.unread = unread
        }
    }

    /// The sidebar's conversations, once each, in its order: every row that
    /// opens one, folded away or not.
    public static func candidates(_ rows: [StemCellsRow]) -> [Candidate] {
        var seen = Set<String>()
        var found: [Candidate] = []
        for row in rows where row.kind == .space || row.kind == .session {
            guard row.targetKind != "surface", let agentId = row.agentId, seen.insert(agentId).inserted else { continue }
            found.append(Candidate(agentId: agentId, running: row.status != .none, unread: row.unread))
        }
        return found
    }

    /// The `limit` most likely opened next, most likely first. `left` are
    /// the conversations the person opened and left, the last left first;
    /// `visible` those whose rows are on screen.
    public static func ranked(_ candidates: [Candidate], left: [String], visible: Set<String>, limit: Int) -> [String] {
        let recency = Dictionary(left.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        let order = candidates.enumerated().sorted { a, b in
            let (l, r) = (a.element, b.element)
            if l.running != r.running { return l.running }
            let (lv, rv) = (visible.contains(l.agentId), visible.contains(r.agentId))
            if lv != rv { return lv }
            // On screen, top first, as the eye and thumb go.
            if lv { return a.offset < b.offset }
            if l.unread != r.unread { return l.unread }
            let (ll, rl) = (recency[l.agentId], recency[r.agentId])
            if ll != rl {
                guard let ll else { return false }
                guard let rl else { return true }
                return ll < rl
            }
            return a.offset < b.offset
        }
        return order.prefix(max(0, limit)).map(\.element.agentId)
    }

    /// How many kept conversations also keep their transcripts laid out,
    /// ready to draw: as many as are read ahead, so every row on screen
    /// opens drawn. Desktop sizes what it keeps rendered by memory, 4GB
    /// assumed where unknown; a phone with less lays out one per gigabyte,
    /// at least two.
    public static func laidOut(physicalMemory bytes: UInt64) -> Int {
        let gigabytes = Int(bytes / 1_000_000_000)
        return gigabytes >= 4 ? Limits.preloaded : max(2, gigabytes)
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
