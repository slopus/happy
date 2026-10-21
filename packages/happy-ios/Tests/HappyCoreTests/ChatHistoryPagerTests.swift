import Foundation
@testable import HappyCore
import XCTest

/// A history whose older fetches wait for the test's answer.
private final class HeldHistory: ChatHistoryClient, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []
    private var held: [CheckedContinuation<OlderPageResult, Never>] = []
    private let states: AsyncStream<ChatHistoryState>
    private let continuation: AsyncStream<ChatHistoryState>.Continuation

    init() {
        (states, continuation) = AsyncStream.makeStream(of: ChatHistoryState.self)
    }

    var calls: [String] { lock.withLock { recorded } }
    var waiting: Int { lock.withLock { held.count } }

    func snapshots(sessionId: String) -> AsyncStream<ChatHistoryState> { states }

    func ensureNewest(sessionId: String) async {
        lock.withLock { recorded.append("ensureNewest") }
    }

    func loadOlder(sessionId: String) async -> OlderPageResult {
        await withCheckedContinuation { continuation in
            lock.withLock {
                recorded.append("loadOlder")
                held.append(continuation)
            }
        }
    }

    func retry(sessionId: String, operation: ChatHistoryFailure.Operation) async -> OlderPageResult {
        lock.withLock { recorded.append("retry(\(operation))") }
        return OlderPageResult(advanced: false, hasMore: true)
    }

    /// Answers the oldest fetch still waiting.
    func answer(_ result: OlderPageResult) {
        let next = lock.withLock { held.isEmpty ? nil : held.removeFirst() }
        next?.resume(returning: result)
    }

    func publish(_ state: ChatHistoryState) {
        continuation.yield(state)
    }
}

/// The chat screen's history paging, over a history that answers when told
/// (W1–W4).
@MainActor
final class ChatHistoryPagerTests: XCTestCase {
    private func until(_ condition: () -> Bool) async {
        for _ in 0..<1000 where !condition() {
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    /// Lets queued main-actor work run.
    private func settle() async {
        for _ in 0..<20 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(20))
    }

    private func state(loadingOlder: Bool = false, loadingNewest: Bool = false, error: ChatHistoryFailure? = nil) -> ChatHistoryState {
        ChatHistoryState(sessionId: "s", initialLoaded: true, loadingNewest: loadingNewest, loadingOlder: loadingOlder,
                         hasMore: true, oldestSeq: nil, error: error)
    }

    private func facts(loaded: Bool = true, empty: Bool = false, more: Bool = true, boundary: Int? = 100, epoch: Int = 0) -> ChatHistoryPager.Facts {
        ChatHistoryPager.Facts(isLoaded: loaded, isEmpty: empty, hasMoreOlder: more, olderBoundary: boundary, windowEpoch: epoch)
    }

    private func olderCalls(_ history: HeldHistory) -> Int {
        history.calls.filter { $0 == "loadOlder" }.count
    }

    /// A pager on a list scrolled to its oldest row, everything rendered.
    private func makePager(_ history: HeldHistory, list: ChatHistoryPager.List? = nil) -> (ChatHistoryPager, Box) {
        let box = Box(list ?? .init(laidOut: true, nearOldest: true, windowCanGrow: false, growthPending: false, oldestBoundary: "m100"))
        let pager = ChatHistoryPager(sessionId: "s", history: history)
        pager.list = { box.list }
        pager.onGrowWindow = { box.grows += 1 }
        pager.isActive = true
        pager.start()
        return (pager, box)
    }

    private final class Box {
        var list: ChatHistoryPager.List
        var grows = 0
        init(_ list: ChatHistoryPager.List) { self.list = list }
    }

    func testOpeningAChatAsksForItsNewestPageOnce() async {
        let history = HeldHistory()
        let (pager, _) = makePager(history)
        pager.start()
        await until { history.calls.contains("ensureNewest") }
        await settle()
        XCTAssertEqual(history.calls, ["ensureNewest"])
    }

    func testFirstLoadRetryAsksForTheNewestWhateverTheErrorSays() async {
        let history = HeldHistory()
        let (pager, _) = makePager(history)
        pager.receive(facts(loaded: false, empty: true))
        // The error's own direction is not where Retry goes.
        history.publish(state(error: ChatHistoryFailure(operation: .older, message: "x")))
        await until { pager.firstLoadFailed }
        XCTAssertTrue(pager.firstLoadFailed)
        pager.retryFirstLoad()
        await until { history.calls.contains("retry(newest)") }
        XCTAssertEqual(history.calls.filter { $0.hasPrefix("retry") }, ["retry(newest)"])
        XCTAssertEqual(olderCalls(history), 0)

        // While the newest page is on its way again, no Retry.
        history.publish(state(loadingNewest: true, error: ChatHistoryFailure(operation: .newest, message: "x")))
        await until { !pager.firstLoadFailed }
        XCTAssertFalse(pager.firstLoadFailed)
    }

    func testOnceLoadedTheFirstLoadRetryDoesNothing() async {
        let history = HeldHistory()
        let (pager, _) = makePager(history)
        pager.receive(facts())
        history.publish(state(error: ChatHistoryFailure(operation: .newest, message: "x")))
        await settle()
        XCTAssertFalse(pager.firstLoadFailed)
        pager.retryFirstLoad()
        await settle()
        XCTAssertFalse(history.calls.contains { $0.hasPrefix("retry") })
    }

    func testAFailedOlderPageOffersRetryAndDoesntFetchAgainByItself() async {
        let history = HeldHistory()
        let (pager, _) = makePager(history)
        pager.receive(facts())
        pager.check()
        await until { history.waiting == 1 }
        // The partial prefix's newest page failed inside loadOlder.
        history.answer(OlderPageResult(advanced: false, hasMore: true, failureOperation: .newest))
        await until { pager.olderStatus(windowReachesOldest: true) == .error }
        XCTAssertEqual(pager.olderStatus(windowReachesOldest: true), .error)

        // Scrolls, status pulses and snapshots ask nothing.
        for _ in 0..<5 { pager.check() }
        history.publish(state(loadingOlder: true))
        history.publish(state())
        pager.receive(facts(boundary: 100))
        pager.check()
        await settle()
        XCTAssertEqual(olderCalls(history), 1)

        // Retry is an older fetch, though the newest page failed.
        pager.olderAction()
        await until { history.waiting == 1 }
        XCTAssertEqual(olderCalls(history), 2)
        XCTAssertFalse(history.calls.contains { $0.hasPrefix("retry") })
        XCTAssertEqual(pager.olderStatus(windowReachesOldest: true), .idle)
    }

    func testAnAdvancedPageWaitsForItsRowsInTheSnapshot() async {
        let history = HeldHistory()
        let (pager, box) = makePager(history)
        pager.receive(facts(boundary: 100))
        pager.check()
        await until { history.waiting == 1 }
        history.answer(OlderPageResult(advanced: true, hasMore: true, oldestSeq: 50))
        await settle()
        XCTAssertNotNil(pager.paging.pending, "still joining: the snapshot's oldest is 100")
        pager.check()
        await settle()
        XCTAssertEqual(olderCalls(history), 1)

        // The page's rows are in: the store renders them first.
        box.list.windowCanGrow = true
        pager.receive(facts(boundary: 50))
        XCTAssertNil(pager.paging.pending)
        pager.check()
        XCTAssertEqual(box.grows, 1)
        // Rendered, and the far end moved: the next page.
        box.list = .init(laidOut: true, nearOldest: true, windowCanGrow: false, growthPending: false, oldestBoundary: "m50")
        pager.check()
        await until { history.waiting == 1 }
        XCTAssertEqual(olderCalls(history), 2)
        XCTAssertEqual(pager.paging.invisiblePages, 0)
    }

    func testJoiningWaitsForThatFetchsOwnCursor() async {
        let history = HeldHistory()
        let (pager, _) = makePager(history)
        pager.receive(facts(boundary: 100))
        pager.check()
        await until { history.waiting == 1 }
        history.answer(OlderPageResult(advanced: true, hasMore: true, oldestSeq: 50))
        await settle()
        // A snapshot short of 50 doesn't settle it.
        pager.receive(facts(boundary: 70))
        XCTAssertNotNil(pager.paging.pending)
        pager.receive(facts(boundary: 49))
        XCTAssertNil(pager.paging.pending)
    }

    func testAPageThatMovedNothingRests() async {
        let history = HeldHistory()
        let (pager, _) = makePager(history)
        pager.receive(facts())
        pager.check()
        await until { history.waiting == 1 }
        history.answer(OlderPageResult(advanced: false, hasMore: true))
        await settle()
        XCTAssertNil(pager.paging.pending)
        XCTAssertEqual(olderCalls(history), 1, "no check of its own")
    }

    func testAWindowResetStartsOverAndDropsTheAnswerFromBefore() async {
        let history = HeldHistory()
        let (pager, _) = makePager(history)
        pager.receive(facts(boundary: 100, epoch: 0))
        pager.check()
        await until { history.waiting == 1 }
        let before = pager.paging.pending
        XCTAssertNotNil(before)

        // The covered window dropped rows it showed.
        XCTAssertTrue(pager.receive(facts(boundary: 900, epoch: 1)))
        XCTAssertNil(pager.paging.pending)
        XCTAssertFalse(pager.receive(facts(boundary: 900, epoch: 1)), "once")
        pager.check()
        await until { history.waiting == 2 }
        let after = try? XCTUnwrap(pager.paging.pending)
        XCTAssertNotNil(after)
        XCTAssertGreaterThan(after ?? 0, before ?? 0, "request numbers keep counting")

        // The answer from before lands: dropped, it settles nothing.
        history.answer(OlderPageResult(advanced: false, hasMore: true, failureOperation: .older))
        await settle()
        XCTAssertEqual(pager.paging.pending, after)
        XCTAssertNil(pager.paging.blocked)
        XCTAssertEqual(pager.olderStatus(windowReachesOldest: true), .idle)
    }

    func testAPartialPrefixWithoutHistoryPagesBack() async {
        // No marker yet: more is the prefix's own gap, and the oldest is 1.
        let history = HeldHistory()
        let (pager, _) = makePager(history)
        pager.receive(facts(more: true, boundary: 1))
        pager.check()
        await until { history.waiting == 1 }
        XCTAssertEqual(olderCalls(history), 1)

        let unknown = HeldHistory()
        let (other, _) = makePager(unknown)
        other.receive(facts(more: true, boundary: nil))
        other.check()
        await until { unknown.waiting == 1 }
        XCTAssertEqual(olderCalls(unknown), 1)
    }

    func testTheStoreIsRenderedBeforeAnythingIsFetched() async {
        let history = HeldHistory()
        let (pager, box) = makePager(history, list: .init(laidOut: true, nearOldest: true, windowCanGrow: true, growthPending: false, oldestBoundary: "m100"))
        pager.receive(facts())
        pager.check()
        await settle()
        XCTAssertEqual(box.grows, 1)
        XCTAssertEqual(olderCalls(history), 0)
        // Its growth is on its way: nothing again.
        box.list.growthPending = true
        pager.check()
        XCTAssertEqual(box.grows, 1)
    }

    func testAPageOnItsWayForAnyoneIsWaitedFor() async {
        let history = HeldHistory()
        let (pager, _) = makePager(history)
        pager.receive(facts())
        history.publish(state(loadingOlder: true))
        await until { pager.status?.loadingOlder == true }
        XCTAssertEqual(olderCalls(history), 0)
        // It lands: the status alone checks again.
        history.publish(state())
        await until { history.waiting == 1 }
        XCTAssertEqual(olderCalls(history), 1)
    }

    func testAnEmptyChatPagesBackFivePagesThenAsks() async {
        let history = HeldHistory()
        let (pager, _) = makePager(history)
        pager.receive(facts(empty: true, boundary: nil))
        pager.check()
        XCTAssertEqual(pager.emptyStatus, .loading)
        for page in 1...ChatOlderPaging.maxInvisiblePages {
            await until { history.waiting == 1 }
            XCTAssertEqual(olderCalls(history), page)
            let oldest = 1000 - page * 100
            history.answer(OlderPageResult(advanced: true, hasMore: true, oldestSeq: oldest))
            await settle()
            // Its rows (all hidden) reach the snapshot, and the screen checks.
            pager.receive(facts(empty: true, boundary: oldest))
            pager.check()
            await until { history.waiting == 1 || pager.emptyStatus == .loadMore }
        }
        XCTAssertEqual(pager.emptyStatus, .loadMore)
        XCTAssertEqual(olderCalls(history), ChatOlderPaging.maxInvisiblePages)
        pager.olderAction()
        await until { history.waiting == 1 }
        XCTAssertEqual(olderCalls(history), ChatOlderPaging.maxInvisiblePages + 1)
        XCTAssertFalse(history.calls.contains { $0.hasPrefix("retry") })
    }

    func testAnEmptyChatsPageWaitsForItsRowsBeforeTheNext() async {
        let history = HeldHistory()
        let (pager, _) = makePager(history)
        pager.receive(facts(empty: true, boundary: 70))
        pager.check()
        await until { history.waiting == 1 }
        history.answer(OlderPageResult(advanced: true, hasMore: true, oldestSeq: 50))
        await settle()
        // In the store, not yet in the snapshot: no second page, whatever
        // pulses meanwhile.
        XCTAssertNotNil(pager.paging.pending)
        history.publish(state(loadingOlder: true))
        history.publish(state())
        pager.receive(facts(empty: true, boundary: 70))
        pager.check()
        await settle()
        XCTAssertEqual(olderCalls(history), 1)
        XCTAssertEqual(pager.paging.invisiblePages, 0)

        // The snapshot holds it: counted, and the next page.
        pager.receive(facts(empty: true, boundary: 49))
        XCTAssertEqual(pager.paging.invisiblePages, 1)
        pager.check()
        await until { history.waiting == 1 }
        XCTAssertEqual(olderCalls(history), 2)
    }

    func testMessagesArrivingWhileAnEmptyPageJoinsAreTheListsToPage() async {
        let history = HeldHistory()
        let (pager, box) = makePager(history, list: .init(laidOut: true, nearOldest: true, windowCanGrow: true, growthPending: false, oldestBoundary: "m50"))
        pager.receive(facts(empty: true, boundary: 70))
        pager.check()
        await until { history.waiting == 1 }
        history.answer(OlderPageResult(advanced: true, hasMore: true, oldestSeq: 50))
        await settle()
        // The page brought messages: the list takes over from nothing.
        pager.receive(facts(empty: false, boundary: 50))
        XCTAssertNil(pager.paging.pending)
        XCTAssertEqual(pager.paging.invisiblePages, 0)
        pager.check()
        await settle()
        XCTAssertEqual(box.grows, 1, "the list renders the store first")
        XCTAssertEqual(olderCalls(history), 1)
    }

    func testAHiddenEmptyChatAsksForNothingOlderUntilShown() async {
        let history = HeldHistory()
        let (pager, _) = makePager(history)
        pager.isActive = false
        pager.receive(facts(empty: true, boundary: nil))
        pager.check()
        history.publish(state(loadingOlder: true))
        history.publish(state())
        await settle()
        XCTAssertEqual(olderCalls(history), 0)
        XCTAssertEqual(history.calls, ["ensureNewest"], "opening still asks for the newest, once")
        pager.isActive = true
        await until { history.waiting == 1 }
        XCTAssertEqual(olderCalls(history), 1)
    }

    func testAnEmptyChatsPageThatMovedNothingRestsAtOnce() async {
        let history = HeldHistory()
        let (pager, _) = makePager(history)
        pager.receive(facts(empty: true, boundary: nil))
        pager.check()
        await until { history.waiting == 1 }
        history.answer(OlderPageResult(advanced: false, hasMore: true))
        await settle()
        XCTAssertNil(pager.paging.pending)
        XCTAssertEqual(olderCalls(history), 1)
    }

    func testAnEmptyChatsRetryIsOlderAfterANewestFailure() async {
        let history = HeldHistory()
        let (pager, _) = makePager(history)
        pager.receive(facts(empty: true, boundary: nil))
        pager.check()
        await until { history.waiting == 1 }
        history.answer(OlderPageResult(advanced: false, hasMore: true, failureOperation: .newest))
        await until { pager.emptyStatus == .error }
        pager.check()
        await settle()
        XCTAssertEqual(olderCalls(history), 1)
        pager.olderAction()
        await until { history.waiting == 1 }
        XCTAssertEqual(olderCalls(history), 2)
        XCTAssertFalse(history.calls.contains { $0.hasPrefix("retry") })
    }

    func testNothingOlderLeftSaysNoMessages() {
        let history = HeldHistory()
        let (pager, _) = makePager(history)
        pager.receive(facts(empty: true, more: false, boundary: nil))
        pager.check()
        XCTAssertEqual(pager.emptyStatus, .noMessages)
        XCTAssertNil(pager.paging.pending)
    }

    func testTheListAfterEmptyMessagesStartsOver() async {
        let history = HeldHistory()
        let (pager, _) = makePager(history)
        pager.receive(facts(empty: true, boundary: nil))
        pager.check()
        await until { history.waiting == 1 }
        history.answer(OlderPageResult(advanced: false, hasMore: true, failureOperation: .older))
        await until { pager.emptyStatus == .error }
        // A page brought the first messages.
        pager.receive(facts(empty: false, boundary: 300))
        XCTAssertNil(pager.paging.blocked)
        pager.check()
        await until { history.waiting == 1 }
        XCTAssertEqual(olderCalls(history), 2)
    }

    func testAScreenNotShownAsksNothing() async {
        let history = HeldHistory()
        let (pager, _) = makePager(history)
        pager.isActive = false
        pager.receive(facts())
        pager.check()
        await settle()
        XCTAssertEqual(olderCalls(history), 0)
        pager.isActive = true
        await until { history.waiting == 1 }
        XCTAssertEqual(olderCalls(history), 1)
    }

    func testAStoppedPagerAsksAndAppliesNothing() async {
        let history = HeldHistory()
        let (pager, _) = makePager(history)
        pager.receive(facts())
        pager.check()
        await until { history.waiting == 1 }
        var changes = 0
        pager.onChange = { changes += 1 }
        pager.stop()
        history.answer(OlderPageResult(advanced: false, hasMore: true, failureOperation: .older))
        history.publish(state(loadingOlder: true))
        await settle()
        XCTAssertEqual(changes, 0)
        XCTAssertNil(pager.paging.blocked)
        pager.check()
        pager.olderAction()
        await settle()
        XCTAssertEqual(olderCalls(history), 1)
    }

    func testUntilLoadedNothingOlderIsAsked() async {
        let history = HeldHistory()
        let (pager, _) = makePager(history)
        pager.receive(facts(loaded: false, empty: true, more: true, boundary: nil))
        pager.check()
        await settle()
        XCTAssertEqual(olderCalls(history), 0)
    }
}
