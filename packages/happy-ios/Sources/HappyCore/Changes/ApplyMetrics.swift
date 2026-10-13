import Foundation

/// The places the main thread applies precomputed changes.
public enum ApplySite: String, Sendable, CaseIterable, Comparable {
    case home
    case homeList = "home list"
    case sidebar
    case chatSession = "chat session"
    case chatSnapshot = "chat snapshot"
    case chatList = "chat list"
    case screen

    public static func < (lhs: ApplySite, rhs: ApplySite) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// AGENTS.md rule 8's main-thread budgets, in milliseconds.
public enum ApplyBudget {
    /// A typical delta: one session, one message, one token.
    public static let typical: Double = 1
    /// A 1000-session catch-up.
    public static let catchUp: Double = 4
    /// Any one block: half a 120 Hz frame.
    public static let block: Double = 4.2
}

/// Debug builds count every main-thread apply, per site and per batch (the
/// applies of one main queue turn). Release builds record nothing.
public final class ApplyMetrics: @unchecked Sendable {
    public static let shared = ApplyMetrics()

    public struct Tally: Equatable, Sendable {
        public var applies = 0
        public var rows = 0
        public var milliseconds: Double = 0

        public init(applies: Int = 0, rows: Int = 0, milliseconds: Double = 0) {
            self.applies = applies
            self.rows = rows
            self.milliseconds = milliseconds
        }
    }

    public struct Batch: Equatable, Sendable {
        public var sites: [ApplySite: Tally] = [:]

        public init(sites: [ApplySite: Tally] = [:]) { self.sites = sites }

        public var milliseconds: Double { sites.values.reduce(0) { $0 + $1.milliseconds } }
        public var applies: Int { sites.values.reduce(0) { $0 + $1.applies } }

        public var summary: String {
            let parts = sites.keys.sorted().map { site -> String in
                let tally = sites[site] ?? Tally()
                return "\(site.rawValue) \(tally.applies)×\(String(format: "%.2f", tally.milliseconds))ms (\(tally.rows) rows)"
            }
            return parts.joined(separator: ", ") + " = " + String(format: "%.2f", milliseconds) + "ms"
        }
    }

    private let lock = NSLock()
    private var open = Batch()
    private var batchOpen = false
    private var totals: [ApplySite: Tally] = [:]
    private var closed: [Batch] = []
    private var overBudget = 0

    public init() {}

    /// Counts one apply. True when it opened a batch, so the caller
    /// schedules `endBatch` for the end of the main queue turn.
    @discardableResult
    public func record(_ site: ApplySite, rows: Int = 0, milliseconds: Double) -> Bool {
        #if DEBUG
        return lock.withLock {
            open.sites[site, default: Tally()].applies += 1
            open.sites[site, default: Tally()].rows += rows
            open.sites[site, default: Tally()].milliseconds += milliseconds
            totals[site, default: Tally()].applies += 1
            totals[site, default: Tally()].rows += rows
            totals[site, default: Tally()].milliseconds += milliseconds
            if milliseconds > ApplyBudget.block { overBudget += 1 }
            let opened = !batchOpen
            batchOpen = true
            return opened
        }
        #else
        return false
        #endif
    }

    /// Closes the open batch; the last 64 are kept.
    @discardableResult
    public func endBatch() -> Batch? {
        lock.withLock {
            guard batchOpen else { return nil }
            let batch = open
            open = Batch()
            batchOpen = false
            closed.append(batch)
            if closed.count > 64 { closed.removeFirst(closed.count - 64) }
            return batch
        }
    }

    public func total(_ site: ApplySite) -> Tally {
        lock.withLock { totals[site] ?? Tally() }
    }

    /// Applies longer than `ApplyBudget.block`.
    public var blocksOverBudget: Int {
        lock.withLock { overBudget }
    }

    public var batches: [Batch] {
        lock.withLock { closed }
    }

    public func reset() {
        lock.withLock {
            open = Batch()
            batchOpen = false
            totals = [:]
            closed = []
            overBudget = 0
        }
    }
}
