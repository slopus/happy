import HappyCore
import XCTest

/// ChatList.tsx's and EmptyMessages.tsx's history paging, step by step.
final class ChatOlderPagingTests: XCTestCase {
    private func reading(
        laidOut: Bool = true, messages: Bool = true, growing: Bool = false,
        near: Bool = true, canGrow: Bool = false, boundary: String? = "m1",
        hasMore: Bool = true, loading: Bool = false, active: Bool = true
    ) -> ChatOlderPaging.Reading {
        .init(
            laidOut: laidOut, storeHasMessages: messages, growthPending: growing,
            nearOldest: near, windowCanGrow: canGrow, oldestBoundary: boundary, hasMore: hasMore, loading: loading, active: active
        )
    }

    func testTheStoreIsRenderedBeforeTheServerIsAsked() {
        var paging = ChatOlderPaging()
        XCTAssertEqual(paging.check(reading(near: false)), .none)
        XCTAssertEqual(paging.check(reading(canGrow: true)), .growWindow)
        XCTAssertEqual(paging.check(reading(canGrow: true, hasMore: false)), .growWindow)
        XCTAssertNil(paging.pending)
        XCTAssertEqual(paging.check(reading()), .fetchOlder(request: 1))
        XCTAssertEqual(paging.pending, 1)
    }

    func testOnePageAtATimeAndNoneWhileAnotherIsOnItsWay() {
        var paging = ChatOlderPaging()
        XCTAssertEqual(paging.check(reading(loading: true)), .none, "a background page")
        XCTAssertEqual(paging.check(reading(hasMore: false)), .none)
        XCTAssertEqual(paging.check(reading(active: false)), .none)
        XCTAssertEqual(paging.check(reading()), .fetchOlder(request: 1))
        // Scroll events keep coming while it is out.
        XCTAssertEqual(paging.check(reading()), .none)
        XCTAssertEqual(paging.check(reading()), .none)
        XCTAssertEqual(paging.status(hasMore: true, loading: true, windowReachesOldest: true), .loading)
    }

    func testAPageThatShowsSomethingKeepsPagingAndOneThatMovedNothingRests() {
        var paging = ChatOlderPaging()
        XCTAssertEqual(paging.check(reading(boundary: "m1")), .fetchOlder(request: 1))
        XCTAssertTrue(paging.settled(request: 1, advanced: true))
        // Its rows joined the store: the window grows first, then the page
        // is judged by the new far end.
        XCTAssertEqual(paging.check(reading(canGrow: true, boundary: "m1")), .growWindow)
        XCTAssertEqual(paging.check(reading(boundary: "m0")), .fetchOlder(request: 2))
        XCTAssertEqual(paging.invisiblePages, 0)

        XCTAssertFalse(paging.settled(request: 2, advanced: false), "the cursor did not move")
        XCTAssertNil(paging.baseline)
        XCTAssertEqual(paging.check(reading(boundary: "m0")), .fetchOlder(request: 3), "the next scroll asks again")
        XCTAssertEqual(paging.invisiblePages, 0, "a page that moved nothing is not judged")
    }

    func testFivePagesThatShowNothingNewStopForLoadMore() {
        var paging = ChatOlderPaging()
        for request in 1...5 {
            XCTAssertEqual(paging.check(reading(boundary: "m1")), .fetchOlder(request: request), "page \(request)")
            XCTAssertTrue(paging.settled(request: request, advanced: true))
        }
        // The fifth is judged at the next check.
        XCTAssertEqual(paging.check(reading(boundary: "m1")), .none)
        XCTAssertEqual(paging.invisiblePages, 5)
        XCTAssertEqual(paging.blocked, .limit)
        XCTAssertEqual(paging.status(hasMore: true, loading: false, windowReachesOldest: true), .loadMore)
        XCTAssertEqual(paging.status(hasMore: false, loading: false, windowReachesOldest: true), .idle)
        XCTAssertEqual(paging.check(reading(boundary: "m1")), .none)

        paging.loadMore()
        XCTAssertEqual(paging.check(reading(boundary: "m1")), .fetchOlder(request: 6))
        XCTAssertEqual(paging.status(hasMore: true, loading: true, windowReachesOldest: true), .loading)
    }

    func testAPageThatShowsSomethingStartsTheCountAgain() {
        var paging = ChatOlderPaging()
        for request in 1...4 {
            XCTAssertEqual(paging.check(reading(boundary: "m1")), .fetchOlder(request: request))
            paging.settled(request: request, advanced: true)
        }
        XCTAssertEqual(paging.check(reading(boundary: "m1")), .fetchOlder(request: 5))
        XCTAssertEqual(paging.invisiblePages, 4)
        paging.settled(request: 5, advanced: true)
        XCTAssertEqual(paging.check(reading(boundary: "m0")), .fetchOlder(request: 6))
        XCTAssertEqual(paging.invisiblePages, 0)
        XCTAssertNil(paging.blocked)
    }

    func testAFailureStopsUntilRetry() {
        var paging = ChatOlderPaging()
        XCTAssertEqual(paging.check(reading()), .fetchOlder(request: 1))
        paging.failed(request: 1)
        XCTAssertEqual(paging.blocked, .error)
        XCTAssertEqual(paging.status(hasMore: true, loading: false, windowReachesOldest: true), .error)
        // Held until Retry, whatever scrolls or changes in the store.
        XCTAssertEqual(paging.check(reading()), .none)
        XCTAssertEqual(paging.check(reading(boundary: "m0")), .none)
        XCTAssertEqual(paging.pending, 1)

        paging.retry()
        XCTAssertNil(paging.pending)
        XCTAssertEqual(paging.status(hasMore: true, loading: false, windowReachesOldest: true), .idle)
        XCTAssertEqual(paging.check(reading()), .fetchOlder(request: 2))
    }

    func testASettlementForAFetchRetriedSinceIsIgnored() {
        var paging = ChatOlderPaging()
        XCTAssertEqual(paging.check(reading()), .fetchOlder(request: 1))
        paging.failed(request: 1)
        paging.retry()
        XCTAssertEqual(paging.check(reading()), .fetchOlder(request: 2))
        // The first fetch's late answer.
        XCTAssertFalse(paging.settled(request: 1, advanced: true))
        paging.failed(request: 1)
        XCTAssertNil(paging.blocked)
        XCTAssertEqual(paging.pending, 2)
        XCTAssertTrue(paging.settled(request: 2, advanced: true))
    }

    func testTheSpinnerShowsOnlyOnceTheWindowRendersAllTheStoreHolds() {
        let paging = ChatOlderPaging()
        XCTAssertEqual(paging.status(hasMore: true, loading: true, windowReachesOldest: false), .idle)
        XCTAssertEqual(paging.status(hasMore: true, loading: true, windowReachesOldest: true), .loading)
        XCTAssertEqual(paging.status(hasMore: true, loading: false, windowReachesOldest: true), .idle)
    }

    func testTheBoundaryOfAFoldedTurnIsItsOldestMember() {
        let answer = ChatMessage.agentText(AgentTextMessage(id: "a2", createdAt: 3, text: "Done"))
        let tool = ChatMessage.agentText(AgentTextMessage(id: "a1", createdAt: 2, text: "Reading"))
        let user = ChatMessage.agentText(AgentTextMessage(id: "u1", createdAt: 1, text: "Hi"))
        let group = ChatWorkGroup(id: "work-a2", turnUserMessageId: nil, messages: [tool], startedAt: 2, completedAt: 3)
        XCTAssertNil(ChatOlderPaging.boundary([]))
        XCTAssertEqual(ChatOlderPaging.boundary([.message(answer), .message(user)]), "u1")
        XCTAssertEqual(ChatOlderPaging.boundary([.message(answer), .workHeader(group, placement: .leading)]), "work-a2:a1")
        // A page that adds an older member to the same turn moves it.
        var grown = group
        grown.messages.insert(user, at: 0)
        XCTAssertEqual(ChatOlderPaging.boundary([.message(answer), .workHeader(grown, placement: .leading)]), "work-a2:u1")
    }

    func testWithNoMessagesEveryPageIsInvisibleAndFiveAskBeforeMore() {
        var paging = ChatOlderPaging()
        XCTAssertEqual(paging.emptyStatus(hasMore: false), .noMessages)
        XCTAssertEqual(paging.checkEmpty(hasMore: false, loading: false), .none)
        XCTAssertEqual(paging.checkEmpty(hasMore: true, loading: true), .none)
        for request in 1...4 {
            XCTAssertEqual(paging.checkEmpty(hasMore: true, loading: false), .fetchOlder(request: request))
            XCTAssertEqual(paging.checkEmpty(hasMore: true, loading: false), .none, "one at a time")
            XCTAssertEqual(paging.emptyStatus(hasMore: true), .loading)
            XCTAssertTrue(paging.settledEmpty(request: request, advanced: true))
        }
        XCTAssertEqual(paging.checkEmpty(hasMore: true, loading: false), .fetchOlder(request: 5))
        XCTAssertFalse(paging.settledEmpty(request: 5, advanced: true))
        XCTAssertEqual(paging.emptyStatus(hasMore: true), .loadMore)
        XCTAssertEqual(paging.checkEmpty(hasMore: true, loading: false), .none)
        paging.loadMore()
        XCTAssertEqual(paging.checkEmpty(hasMore: true, loading: false), .fetchOlder(request: 6))

        // A page that moved nothing is not counted; a failure offers Retry.
        XCTAssertFalse(paging.settledEmpty(request: 6, advanced: false))
        XCTAssertEqual(paging.invisiblePages, 0)
        XCTAssertEqual(paging.checkEmpty(hasMore: true, loading: false), .fetchOlder(request: 7))
        paging.failed(request: 7)
        XCTAssertEqual(paging.emptyStatus(hasMore: true), .error)
        XCTAssertEqual(paging.checkEmpty(hasMore: true, loading: false), .none)
        paging.retry()
        XCTAssertEqual(paging.checkEmpty(hasMore: true, loading: false), .fetchOlder(request: 8))
    }

    func testNothingHappensBeforeTheFirstLayoutWithoutMessagesOrWhileAGrowthIsOnItsWay() {
        var paging = ChatOlderPaging()
        XCTAssertEqual(paging.check(reading(laidOut: false)), .none)
        XCTAssertEqual(paging.check(reading(laidOut: false, canGrow: true)), .none)
        XCTAssertEqual(paging.check(reading(messages: false)), .none, "EmptyMessages pages")
        // Scrolls inside the zone while a growth renders ask for nothing:
        // not another growth, not a fetch.
        XCTAssertEqual(paging.check(reading(growing: true, canGrow: true)), .none)
        XCTAssertEqual(paging.check(reading(growing: true)), .none)
        XCTAssertNil(paging.pending)
        XCTAssertEqual(paging.check(reading()), .fetchOlder(request: 1))
    }

    func testAPageIsJudgedOnlyOnceItsRowsCouldHaveJoinedTheWindow() {
        var paging = ChatOlderPaging()
        XCTAssertEqual(paging.check(reading(boundary: "m1")), .fetchOlder(request: 1))
        XCTAssertTrue(paging.settled(request: 1, advanced: true))
        // The page's rows are in the store; the window takes them over two
        // growths, the far end not yet moved.
        XCTAssertEqual(paging.check(reading(canGrow: true, boundary: "m1")), .growWindow)
        XCTAssertEqual(paging.check(reading(growing: true, boundary: "m1")), .none)
        XCTAssertEqual(paging.check(reading(canGrow: true, boundary: "m1")), .growWindow)
        XCTAssertEqual(paging.invisiblePages, 0)
        XCTAssertEqual(paging.baseline, .some("m1"), "still awaiting judgement")
        XCTAssertEqual(paging.check(reading(boundary: "m-120")), .fetchOlder(request: 2))
        XCTAssertEqual(paging.invisiblePages, 0, "it showed something")
    }

    func testResetStartsOverAndAnAnswerFromBeforeSettlesNothing() {
        var paging = ChatOlderPaging()
        for request in 1...5 {
            XCTAssertEqual(paging.check(reading(boundary: "m1")), .fetchOlder(request: request))
            paging.settled(request: request, advanced: true)
        }
        XCTAssertEqual(paging.check(reading(boundary: "m1")), .none)
        XCTAssertEqual(paging.blocked, .limit)
        XCTAssertEqual(paging.check(reading(boundary: "m1")), .none)
        // A sixth was never asked; the reader opens another chat with one
        // of this one's in flight.
        paging.loadMore()
        XCTAssertEqual(paging.check(reading(boundary: "m1")), .fetchOlder(request: 6))

        paging.reset()
        XCTAssertNil(paging.pending)
        XCTAssertNil(paging.baseline)
        XCTAssertNil(paging.blocked)
        XCTAssertEqual(paging.invisiblePages, 0)
        XCTAssertEqual(paging.status(hasMore: true, loading: false, windowReachesOldest: true), .idle)
        XCTAssertEqual(paging.check(reading(boundary: "n1")), .fetchOlder(request: 7))
        // The old chat's answer, success or failure, belongs to request 6.
        XCTAssertFalse(paging.settled(request: 6, advanced: true))
        paging.failed(request: 6)
        XCTAssertNil(paging.blocked)
        XCTAssertEqual(paging.pending, 7)
    }

    func testTheListTakingOverFromEmptyMessagesStartsItsOwnCount() {
        var paging = ChatOlderPaging()
        for request in 1...3 {
            XCTAssertEqual(paging.checkEmpty(hasMore: true, loading: false), .fetchOlder(request: request))
            XCTAssertTrue(paging.settledEmpty(request: request, advanced: true))
        }
        XCTAssertEqual(paging.invisiblePages, 3)
        XCTAssertEqual(paging.checkEmpty(hasMore: true, loading: false), .fetchOlder(request: 4))
        // That page brought the first visible message: the list replaces
        // the placeholder, with the placeholder's page still out.
        paging.reset()
        XCTAssertEqual(paging.check(reading(boundary: "m1")), .fetchOlder(request: 5))
        XCTAssertFalse(paging.settledEmpty(request: 4, advanced: true))
        XCTAssertEqual(paging.invisiblePages, 0)
        XCTAssertTrue(paging.settled(request: 5, advanced: true))
    }
}
