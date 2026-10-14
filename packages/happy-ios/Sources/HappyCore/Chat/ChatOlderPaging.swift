import Foundation

/// When the chat asks the server for older messages, and what its older end
/// shows: ChatList.tsx's `fillOlder` and `olderStatus`, and EmptyMessages'
/// paging while no message is in the store yet.
///
/// History fills in ahead of the reader. Whenever the oldest rendered
/// message is within a screen (which includes a list too short to fill
/// one), the window grows from the store first; once the store is spent,
/// one older page is fetched. Each settlement checks again, so paging walks
/// back exactly as far as the reader goes and stops at the end, at an
/// error, or after five pages that showed nothing new (a run of events the
/// list hides), where "Load more" asks the reader before going on.
///
/// Pure and main-thread agnostic: the screen reads its list and the store's
/// history flags into a `Reading`, carries out the `Step`, and reports how
/// each fetch it started settled.
public struct ChatOlderPaging: Equatable, Sendable {
    /// `MAX_INVISIBLE_OLDER_PAGES`.
    public static let maxInvisiblePages = 5

    public enum Step: Equatable, Sendable {
        case none
        /// Render the next page the store already holds.
        case growWindow
        /// Fetch one older page; report it with `settled` or `failed`.
        case fetchOlder(request: Int)
    }

    /// OlderEnd's `status`.
    public enum Status: Equatable, Sendable {
        case idle
        case loading
        /// Retry.
        case error
        /// Load more.
        case loadMore
    }

    public enum Block: Equatable, Sendable {
        case error
        case limit
    }

    /// What the screen sees at a check.
    public struct Reading: Equatable, Sendable {
        /// The list has a measured viewport and content; before its first
        /// layout nothing is near anything.
        public var laidOut: Bool
        /// The store holds a message; with none the screen is
        /// EmptyMessages, which pages on its own (`checkEmpty`).
        public var storeHasMessages: Bool
        /// A window growth was asked for and has not reached the screen
        /// (`requestedWindowEndRef`): scrolls inside the zone meanwhile
        /// neither grow it again nor fetch.
        public var growthPending: Bool
        /// The oldest rendered row is within a screen of the visible area.
        public var nearOldest: Bool
        /// The store holds messages older than the window renders.
        public var windowCanGrow: Bool
        /// `oldestBoundary` of the rendered rows; nil for none.
        public var oldestBoundary: String?
        /// The server has messages older than the store's.
        public var hasMore: Bool
        /// The store's flag: an older page is on its way, for anyone.
        public var loading: Bool
        /// The screen is the one shown.
        public var active: Bool

        public init(
            laidOut: Bool, storeHasMessages: Bool, growthPending: Bool,
            nearOldest: Bool, windowCanGrow: Bool, oldestBoundary: String?, hasMore: Bool, loading: Bool, active: Bool
        ) {
            self.laidOut = laidOut
            self.storeHasMessages = storeHasMessages
            self.growthPending = growthPending
            self.nearOldest = nearOldest
            self.windowCanGrow = windowCanGrow
            self.oldestBoundary = oldestBoundary
            self.hasMore = hasMore
            self.loading = loading
            self.active = active
        }
    }

    /// The number of this screen's fetch still out, until it settles; a
    /// failed one stays out until Retry (`pendingOlderRef`).
    public private(set) var pending: Int?
    /// The far end a settled page is judged against, once its rows have had
    /// the chance to join the window (`olderPageRef`): `.some(nil)` is an
    /// empty list, nil no page awaiting judgement.
    public private(set) var baseline: String??
    public private(set) var invisiblePages = 0
    public private(set) var blocked: Block?
    private var requests = 0

    public init() {}

    /// `oldestBoundary`: the oldest row's id, and for a folded turn its
    /// oldest member too, so a page that extends that turn counts as seen.
    /// `items` newest first, as the list renders them.
    public static func boundary(_ items: [ChatListItem]) -> String? {
        guard let oldest = items.last else { return nil }
        if case .workHeader(let group, _) = oldest { return "\(oldest.id):\(group.messages.first?.id ?? "")" }
        return oldest.id
    }

    /// `fillOlder`.
    public mutating func check(_ reading: Reading) -> Step {
        guard reading.laidOut, reading.storeHasMessages, !reading.growthPending, reading.nearOldest else { return .none }
        if reading.windowCanGrow { return .growWindow }
        // A settled page is judged once its rows could have joined.
        if let judged = baseline, pending == nil {
            baseline = nil
            if reading.oldestBoundary != judged {
                invisiblePages = 0
                blocked = nil
            } else {
                invisiblePages += 1
                if invisiblePages >= Self.maxInvisiblePages {
                    blocked = .limit
                    return .none
                }
            }
        }
        guard reading.active, reading.hasMore, !reading.loading, blocked == nil, pending == nil,
              invisiblePages < Self.maxInvisiblePages else { return .none }
        requests += 1
        pending = requests
        baseline = .some(reading.oldestBoundary)
        return .fetchOlder(request: requests)
    }

    /// A fetch came back. True when it moved the server's cursor, so the
    /// screen checks again once its rows are in; a page that moved nothing
    /// rests until the next scroll or store change, so it cannot spin.
    @discardableResult
    public mutating func settled(request: Int, advanced: Bool) -> Bool {
        guard pending == request else { return false }
        pending = nil
        if !advanced { baseline = nil }
        return advanced
    }

    /// A fetch failed: paging stops, and the older end offers Retry.
    public mutating func failed(request: Int) {
        guard pending == request else { return }
        baseline = nil
        blocked = .error
    }

    /// Starts over for another chat, or for the list taking over from
    /// EmptyMessages, each of which has its own paging in happy-app. The
    /// request numbers keep counting, so an answer to a fetch from before
    /// never settles one started after.
    public mutating func reset() {
        pending = nil
        baseline = nil
        invisiblePages = 0
        blocked = nil
    }

    /// `retryOlder`.
    public mutating func retry() {
        pending = nil
        blocked = nil
    }

    /// `loadMoreOlder`: five more pages before asking again.
    public mutating func loadMore() {
        invisiblePages = 0
        blocked = nil
    }

    /// `olderStatus`. The store's loading flag also pulses for pages the
    /// reader never sees; the spinner shows only while the window already
    /// renders all the store holds.
    public func status(hasMore: Bool, loading: Bool, windowReachesOldest: Bool) -> Status {
        if blocked == .error && hasMore { return .error }
        if blocked == .limit && hasMore { return .loadMore }
        return loading && windowReachesOldest ? .loading : .idle
    }

    // MARK: No messages yet

    /// What EmptyMessages shows under the session's details.
    public enum EmptyStatus: Equatable, Sendable {
        /// "No messages yet": the server has nothing older either.
        case noMessages
        case loading
        case error
        case loadMore
    }

    public func emptyStatus(hasMore: Bool) -> EmptyStatus {
        guard hasMore else { return .noMessages }
        switch blocked {
        case .error: return .error
        case .limit: return .loadMore
        case nil: return .loading
        }
    }

    /// EmptyMessages: while the store has no message the screen shows its
    /// placeholder and pages back on its own, every page invisible by
    /// definition, five at most before Load more.
    public mutating func checkEmpty(hasMore: Bool, loading: Bool) -> Step {
        guard hasMore, !loading, blocked == nil, pending == nil else { return .none }
        requests += 1
        pending = requests
        return .fetchOlder(request: requests)
    }

    /// An empty screen's fetch came back. True to check again.
    @discardableResult
    public mutating func settledEmpty(request: Int, advanced: Bool) -> Bool {
        guard pending == request else { return false }
        pending = nil
        guard advanced else { return false }
        invisiblePages += 1
        if invisiblePages >= Self.maxInvisiblePages {
            blocked = .limit
            return false
        }
        return true
    }
}
