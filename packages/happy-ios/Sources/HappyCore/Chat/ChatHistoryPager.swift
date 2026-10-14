import Foundation

/// What a chat screen asks of its account's history (`ChatHistory`), for
/// tests to stand in for.
public protocol ChatHistoryClient: Sendable {
    func snapshots(sessionId: String) -> AsyncStream<ChatHistoryState>
    func ensureNewest(sessionId: String) async
    func loadOlder(sessionId: String) async -> OlderPageResult
    func retry(sessionId: String, operation: ChatHistoryFailure.Operation) async -> OlderPageResult
}

extension ChatHistory: ChatHistoryClient {}

/// One chat screen's history paging: ChatList's `fillOlder` and OlderEnd,
/// EmptyMessages' paging, and SessionView's first load, over the account's
/// `ChatHistory` and the policy in `ChatOlderPaging`.
///
/// - Opening a real chat asks for its newest page once, without waiting
///   (`ensureNewest`); History answers a complete prefix or a covered tail
///   from the store, with no request.
/// - Until the chat is loaded, Retry asks for the newest page again
///   (`retry(.newest)`). The history's error only decides that Retry shows.
/// - Once loaded, every fetch is an older one (`loadOlder`), from the
///   older end, an empty chat's own paging and their Retry alike, whatever
///   failed before. A failed fetch stops paging until Retry.
/// - Whether there is more comes from the snapshot the rows came in
///   (`ChatSnapshotFacts.hasMoreOlder`); whether a page is on its way, from
///   the history's status (`loadingOlder`). A page that moved the cursor is
///   still joining until the snapshot reaches the oldest sequence that
///   fetch returned; only then is it judged against the far end, or, in
///   EmptyMessages, counted and followed by the next.
/// - A screen not shown asks for no older page, EmptyMessages' included.
/// - When the covered window drops rows it showed (`windowEpoch` moves),
///   paging starts over (request numbers keep counting) and an answer to a
///   fetch from before is dropped; the screen goes back to the newest.
///
/// Main thread only; the history works on its own actor. The screen reads
/// its list into `List` when asked (`list`), grows its window when told
/// (`onGrowWindow`), and redraws the older end and its placeholder on
/// `onChange`, which is all a status change does: no rows are worked out
/// again for one.
@MainActor
public final class ChatHistoryPager {
    /// What the list shows, for a check.
    public struct List: Equatable, Sendable {
        /// The list has a measured viewport and rows.
        public var laidOut: Bool
        /// The oldest rendered row is within a screen of the visible area.
        public var nearOldest: Bool
        /// The store holds messages older than the window renders.
        public var windowCanGrow: Bool
        /// A growth was asked for and its rows have not rendered yet.
        public var growthPending: Bool
        /// `ChatOlderPaging.boundary` of the rendered rows.
        public var oldestBoundary: String?

        public init(laidOut: Bool, nearOldest: Bool, windowCanGrow: Bool, growthPending: Bool, oldestBoundary: String?) {
            self.laidOut = laidOut
            self.nearOldest = nearOldest
            self.windowCanGrow = windowCanGrow
            self.growthPending = growthPending
            self.oldestBoundary = oldestBoundary
        }
    }

    /// The snapshot's facts paging reads.
    public struct Facts: Equatable, Sendable {
        public var isLoaded: Bool
        public var isEmpty: Bool
        public var hasMoreOlder: Bool
        public var olderBoundary: Int?
        public var windowEpoch: Int

        public init(isLoaded: Bool, isEmpty: Bool, hasMoreOlder: Bool, olderBoundary: Int?, windowEpoch: Int) {
            self.isLoaded = isLoaded
            self.isEmpty = isEmpty
            self.hasMoreOlder = hasMoreOlder
            self.olderBoundary = olderBoundary
            self.windowEpoch = windowEpoch
        }

        public init(_ facts: ChatSnapshotFacts) {
            self.init(isLoaded: facts.isLoaded, isEmpty: facts.isEmpty, hasMoreOlder: facts.hasMoreOlder,
                      olderBoundary: facts.olderBoundary, windowEpoch: facts.windowEpoch)
        }
    }

    public let sessionId: String
    private let history: any ChatHistoryClient
    public private(set) var paging = ChatOlderPaging()
    public private(set) var facts: Facts?
    /// The history's latest status for the chat.
    public private(set) var status: ChatHistoryState?
    /// The screen is the one shown (`active`).
    public var isActive = false {
        didSet { if isActive && !oldValue { check() } }
    }

    /// The list as it is now; nil before it shows.
    public var list: (() -> List?)?
    public var onGrowWindow: (() -> Void)?
    public var onChange: (() -> Void)?

    /// EmptyMessages pages on its own; the list after it starts over.
    private var showsEmpty = false
    /// A page that moved the cursor, until the snapshot holds it, and
    /// whether EmptyMessages asked for it.
    private var joining: (request: Int, oldestSeq: Int, empty: Bool)?
    /// Moves when paging starts over or stops: answers from before drop.
    private var generation = 0
    private var started = false
    private var stopped = false
    private let subscription = Subscription()

    /// The status observation, ended when the pager goes too.
    private final class Subscription: @unchecked Sendable {
        var task: Task<Void, Never>?
        deinit { task?.cancel() }
    }

    public init(sessionId: String, history: any ChatHistoryClient) {
        self.sessionId = sessionId
        self.history = history
    }

    /// Follows the history's status and asks for the newest page, once.
    public func start() {
        guard !started, !stopped else { return }
        started = true
        let stream = history.snapshots(sessionId: sessionId)
        subscription.task = Task { [weak self] in
            for await state in stream {
                guard let self, !self.stopped else { return }
                self.statusChanged(state)
            }
        }
        let history = history
        let sessionId = sessionId
        Task.detached(priority: .userInitiated) { await history.ensureNewest(sessionId: sessionId) }
    }

    /// The screen left the chat: nothing more is asked or applied. The
    /// history itself goes on; only its account stops it.
    public func stop() {
        stopped = true
        generation += 1
        subscription.task?.cancel()
        subscription.task = nil
        joining = nil
    }

    private func statusChanged(_ state: ChatHistoryState) {
        guard state != status else { return }
        status = state
        onChange?()
        check()
    }

    /// The snapshot's facts, as the screen applies its rows. True when the
    /// window was reset (`windowEpoch` moved): the screen goes back to the
    /// newest. Checks nothing; the screen checks once its rows are in.
    @discardableResult
    public func receive(_ next: Facts) -> Bool {
        guard !stopped else { return false }
        let previous = facts
        facts = next
        var reset = false
        if let previous, previous.windowEpoch != next.windowEpoch {
            startOver()
            reset = true
        }
        let empty = next.isLoaded && next.isEmpty
        if empty != showsEmpty {
            // EmptyMessages and the list page on their own.
            if !reset { startOver() }
            showsEmpty = empty
        }
        // A change between EmptyMessages and the list started over above,
        // so a page still joining is the shown one's.
        if let page = joining, let boundary = next.olderBoundary, boundary <= page.oldestSeq {
            joining = nil
            if page.empty {
                paging.settledEmpty(request: page.request, advanced: true)
            } else {
                paging.settled(request: page.request, advanced: true)
            }
        }
        if previous != next { onChange?() }
        return reset
    }

    private func startOver() {
        paging.reset()
        joining = nil
        generation += 1
    }

    /// `fillOlder` for the list, or EmptyMessages' check.
    public func check() {
        guard started, !stopped, let facts, facts.isLoaded else { return }
        let loading = status?.loadingOlder ?? false
        let step: ChatOlderPaging.Step
        if showsEmpty {
            guard isActive else { return }
            step = paging.checkEmpty(hasMore: facts.hasMoreOlder, loading: loading)
        } else {
            guard let list = list?() else { return }
            step = paging.check(.init(
                laidOut: list.laidOut, storeHasMessages: !facts.isEmpty, growthPending: list.growthPending,
                nearOldest: list.nearOldest, windowCanGrow: list.windowCanGrow, oldestBoundary: list.oldestBoundary,
                hasMore: facts.hasMoreOlder, loading: loading, active: isActive
            ))
        }
        switch step {
        case .none:
            break
        case .growWindow:
            onGrowWindow?()
        case .fetchOlder(let request):
            fetch(request, empty: showsEmpty)
        }
    }

    private func fetch(_ request: Int, empty: Bool) {
        let generation = generation
        let history = history
        let sessionId = sessionId
        onChange?()
        Task { [weak self] in
            let result = await history.loadOlder(sessionId: sessionId)
            guard let self, !self.stopped, self.generation == generation else { return }
            self.settle(request, result, empty: empty)
        }
    }

    private func settle(_ request: Int, _ result: OlderPageResult, empty: Bool) {
        defer { onChange?() }
        if result.failed {
            // Whichever way it failed (a partial prefix asks for the newest
            // page first), Retry asks for an older one.
            paging.failed(request: request)
            return
        }
        guard result.advanced, let oldestSeq = result.oldestSeq else {
            if empty {
                paging.settledEmpty(request: request, advanced: result.advanced)
            } else {
                paging.settled(request: request, advanced: false)
            }
            return
        }
        // Counted, and followed by the next page, once the snapshot holds
        // its rows: a page in the store but not yet on screen isn't asked
        // for again.
        if let boundary = facts?.olderBoundary, boundary <= oldestSeq {
            if empty {
                if paging.settledEmpty(request: request, advanced: true) { check() }
            } else {
                paging.settled(request: request, advanced: true)
                check()
            }
        } else {
            joining = (request, oldestSeq, empty)
        }
    }

    // MARK: Retry and Load more

    /// The older end's or EmptyMessages' button: Retry after a failure,
    /// Load more after five pages that showed nothing. Either way the next
    /// fetch is an older one.
    public func olderAction() {
        guard !stopped else { return }
        switch paging.blocked {
        case .error?: paging.retry()
        case .limit?: paging.loadMore()
        case nil: return
        }
        onChange?()
        check()
    }

    /// Retry before the chat has loaded: its newest page again.
    public func retryFirstLoad() {
        guard !stopped, facts?.isLoaded != true else { return }
        let history = history
        let sessionId = sessionId
        Task.detached(priority: .userInitiated) { _ = await history.retry(sessionId: sessionId, operation: .newest) }
    }

    // MARK: What shows

    /// The older end's status.
    public func olderStatus(windowReachesOldest: Bool) -> ChatOlderPaging.Status {
        paging.status(hasMore: facts?.hasMoreOlder ?? false, loading: status?.loadingOlder ?? false, windowReachesOldest: windowReachesOldest)
    }

    /// What EmptyMessages shows under the session's details.
    public var emptyStatus: ChatOlderPaging.EmptyStatus {
        paging.emptyStatus(hasMore: facts?.hasMoreOlder ?? false)
    }

    /// The first load failed: the loading placeholder offers Retry.
    public var firstLoadFailed: Bool {
        guard facts?.isLoaded != true, let status else { return false }
        return status.error != nil && !status.loadingNewest
    }
}
