import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// `PUT /v0/viewers/streams/:streamId` as API.md has it, under the test's
/// hand: every call heard; while `holding`, each waits until the test
/// says how it ends. `lose` applies the request and then loses the
/// answer, as a dropped connection after the server did its part; `drop`
/// loses the request before the server sees it.
private actor FakeViewersServer {
    enum Outcome { case answer, lose, drop, refuse }

    private(set) var calls: [(stream: String, targets: [ViewerTarget])] = []
    /// What each stream looks at, as the server applied it.
    private(set) var holds: [String: [ViewerTarget]] = [:]
    var people: [ViewerTarget: [Viewer]] = [:]
    var outcome = Outcome.answer
    var holding = false
    private var waiting: [(stream: String, continuation: CheckedContinuation<Outcome, Never>)] = []

    func set(_ target: ViewerTarget, _ viewers: [Viewer]) { people[target] = viewers }
    func refuse(_ refusing: Bool) { outcome = refusing ? .refuse : .answer }
    func end(_ outcome: Outcome) { self.outcome = outcome }
    func hold(_ holding: Bool) { self.holding = holding }

    /// Ends the oldest call held, or the oldest on `stream`.
    func release(_ outcome: Outcome, stream: String? = nil) {
        guard let index = waiting.firstIndex(where: { stream == nil || $0.stream == stream }) else { return }
        waiting.remove(at: index).continuation.resume(returning: outcome)
    }
    var held: Int { waiting.count }
    func held(on stream: String) -> Int { waiting.filter { $0.stream == stream }.count }

    func put(_ stream: String, _ targets: [ViewerTarget]) async throws -> [(target: ViewerTarget, viewers: [Viewer])] {
        calls.append((stream, targets))
        var ending = outcome
        if holding { ending = await withCheckedContinuation { waiting.append((stream, $0)) } }
        switch ending {
        case .refuse:
            throw AgentClientError.status(404, code: "not_found", message: nil)
        case .lose:
            holds[stream] = targets
            throw URLError(.networkConnectionLost)
        case .drop:
            throw URLError(.networkConnectionLost)
        case .answer:
            holds[stream] = targets
            return targets.map { ($0, people[$0] ?? []) }
        }
    }

    var said: [[ViewerTarget]] { calls.map(\.targets) }
}

private let todo = ViewerTarget.surface("todo-1")
private let chat = ViewerTarget.agent("agent-1")
private let now: Double = 1_800_000_000_000

private func hello(_ stream: String, daemon: String? = "d1") -> JSONValue {
    var object: [String: JSONValue] = ["cursor": .string("c1"), "streamId": .string(stream)]
    if let daemon { object["daemonId"] = .string(daemon) }
    return .object(object)
}

final class ViewerTierTests: XCTestCase {
    func testTiersFollowTheTenMinuteWindow() {
        XCTAssertEqual(ViewerTiers.tier(Viewer(userId: "a", here: true, lastSeenAt: now - 3_600_000), now: now), .here)
        XCTAssertEqual(ViewerTiers.tier(Viewer(userId: "a", here: false, lastSeenAt: now - 5_000), now: now), .recent(minutes: 1))
        XCTAssertEqual(ViewerTiers.tier(Viewer(userId: "a", here: false, lastSeenAt: now - 4 * 60_000 - 59_000), now: now), .recent(minutes: 4))
        XCTAssertEqual(ViewerTiers.tier(Viewer(userId: "a", here: false, lastSeenAt: now - 10 * 60_000), now: now), .recent(minutes: 10))
        XCTAssertEqual(ViewerTiers.tier(Viewer(userId: "a", here: false, lastSeenAt: now - 10 * 60_000 - 1), now: now), .seen)
        XCTAssertEqual(ViewerTiers.tier(Viewer(userId: "a", here: false, lastSeenAt: now + 2_000), now: now), .recent(minutes: 1))
    }

    func testNextChangeIsTheNearestMinuteOrTheEndOfRecent() {
        let viewers = [
            Viewer(userId: "here", here: true, lastSeenAt: now),
            Viewer(userId: "four", here: false, lastSeenAt: now - 4 * 60_000 - 20_000),
            Viewer(userId: "old", here: false, lastSeenAt: now - 86_400_000),
        ]
        XCTAssertEqual(ViewerTiers.nextChange(viewers, now: now), now + 40_000)
        let last = [Viewer(userId: "nine", here: false, lastSeenAt: now - 9 * 60_000 - 30_000)]
        XCTAssertEqual(ViewerTiers.nextChange(last, now: now), now + 30_000)
        XCTAssertEqual(ViewerTiers.nextChange(last, now: now + 30_000), now + 30_001)
        XCTAssertNil(ViewerTiers.nextChange(last, now: now + 30_001))
        XCTAssertNil(ViewerTiers.nextChange([Viewer(userId: "here", here: true, lastSeenAt: now)], now: now))
    }

    func testAFrameReplacesItsPersonAndKeepsHereFirstThenNewest() {
        let list = [
            Viewer(userId: "kirill", here: true, lastSeenAt: now),
            Viewer(userId: "anna", here: false, lastSeenAt: now - 360_000),
            Viewer(userId: "max", here: false, lastSeenAt: now - 86_400_000),
        ]
        let arrived = ViewerTiers.applying(Viewer(userId: "max", here: true, lastSeenAt: now + 1), to: list)
        XCTAssertEqual(arrived.map(\.userId), ["max", "kirill", "anna"])
        let left = ViewerTiers.applying(Viewer(userId: "kirill", here: false, lastSeenAt: now + 2), to: arrived)
        XCTAssertEqual(left.map(\.userId), ["max", "kirill", "anna"])
        XCTAssertEqual(left.map(\.here), [true, false, false])
        let many = (0..<60).map { Viewer(userId: "u\($0)", here: false, lastSeenAt: Double($0)) }
        let capped = ViewerTiers.applying(Viewer(userId: "new", here: true, lastSeenAt: 100), to: many)
        XCTAssertEqual(capped.count, 50)
        XCTAssertEqual(capped.first?.userId, "new")
        XCTAssertEqual(capped.last?.userId, "u11")
    }

    func testTargetsAndFramesDecodeAsTheWireHasThem() throws {
        let frame = try JSONDecoder().decode(ViewersFrame.self, from: Data(#"{"target":{"type":"surface","id":"s1"},"viewer":{"userId":"anna","here":true,"lastSeenAt":1800000000000}}"#.utf8))
        XCTAssertEqual(frame, ViewersFrame(target: .surface("s1"), viewer: Viewer(userId: "anna", here: true, lastSeenAt: 1_800_000_000_000)))
        XCTAssertEqual(String(decoding: try JSONEncoder().encode(ViewerTarget.agent("a1")), as: UTF8.self).contains(#""type":"agent""#), true)
    }

    func testAnAnswerSkipsATargetOfATypeThisAppDoesNotKnow() throws {
        let answer = try JSONDecoder().decode(ViewersAnswer.self, from: Data(#"""
        {"targets":[
          {"target":{"type":"agent","id":"a1"},"viewers":[{"userId":"anna","here":true,"lastSeenAt":1800000000000}]},
          {"target":{"type":"whiteboard","id":"w1"},"viewers":[{"userId":"max","here":true,"lastSeenAt":1800000000000}]},
          {"target":{"type":"surface","id":"s1"},"viewers":[]}
        ]}
        """#.utf8))
        XCTAssertEqual(answer.targets.map(\.target), [.agent("a1"), .surface("s1")])
        XCTAssertEqual(answer.targets.first?.viewers, [Viewer(userId: "anna", here: true, lastSeenAt: now)])
    }
}

final class ViewersStoreTests: XCTestCase {
    private func makeStore(_ server: FakeViewersServer, heartbeat: Duration = .seconds(60)) -> ViewersStore {
        ViewersStore(heartbeat: heartbeat, settle: .milliseconds(5), retry: .milliseconds(20)) { stream, targets in try await server.put(stream, targets) }
    }

    /// The next state a header draws that `wanted` accepts, skipping any
    /// in between (a watch keeps only the newest).
    private func next(_ states: inout AsyncStream<ViewersState>.Iterator, _ what: String, _ wanted: (ViewersState) -> Bool) async -> ViewersState? {
        while let state = await states.next() {
            if wanted(state) { return state }
        }
        XCTFail("never: \(what)")
        return nil
    }

    private func eventually(_ what: String, timeout: TimeInterval = 2, _ check: () async -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await check() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("never: \(what)")
    }

    func testShownTargetsAreSaidOnceTheStreamSaysHelloAndAnswersReachTheHeader() async throws {
        let server = FakeViewersServer()
        let anna = Viewer(userId: "anna", here: true, lastSeenAt: now)
        await server.set(todo, [anna])
        let store = makeStore(server)
        var states = await store.view(todo).makeAsyncIterator()
        let first = await states.next()
        XCTAssertEqual(first, .viewers([], live: false))
        try await Task.sleep(for: .milliseconds(30))
        let before = await server.calls.count
        XCTAssertEqual(before, 0)
        await store.opened(hello("s1"))
        let answered = await next(&states, "answered") { $0 != .viewers([], live: false) }
        XCTAssertEqual(answered, .viewers([anna], live: true))
        let calls = await server.calls
        XCTAssertEqual(calls.map(\.stream), ["s1"])
        XCTAssertEqual(calls.map(\.targets), [[todo]])
    }

    func testTheHeartbeatSaysItAgainAndLeavingSaysNothingIsLookedAt() async {
        let server = FakeViewersServer()
        let store = makeStore(server, heartbeat: .milliseconds(40))
        await store.opened(hello("s1"))
        let watching = Task { for await _ in await store.view(todo) {} }
        await eventually("two heartbeats") { await server.said.count >= 3 }
        let said = await server.said
        XCTAssertEqual(Set(said.map { $0 }), [[todo]])
        watching.cancel()
        await eventually("told nothing is looked at") { await server.said.last == [] }
        let count = await server.said.count
        try? await Task.sleep(for: .milliseconds(120))
        let after = await server.said.count
        XCTAssertEqual(after, count, "no heartbeat once nothing is looked at")
    }

    func testAPushIsSaidOnceWithBothScreensAndThenTheOneLeft() async {
        let server = FakeViewersServer()
        let store = makeStore(server)
        await store.opened(hello("s1"))
        let below = Task { for await _ in await store.view(chat) {} }
        let above = Task { for await _ in await store.view(todo) {} }
        await eventually("both said") { await server.said.last == [chat, todo] }
        let observed1 = await server.said
        XCTAssertEqual(observed1, [[chat, todo]])
        below.cancel()
        await eventually("only the top one") { await server.said.last == [todo] }
        above.cancel()
    }

    func testOnlyTheNewestEightAreSaid() async {
        let server = FakeViewersServer()
        let store = makeStore(server)
        await store.opened(hello("s1"))
        let all = (0..<10).map { ViewerTarget.surface("s\($0)") }
        var shown: [AsyncStream<ViewersState>] = []
        for target in all { shown.append(await store.view(target)) }
        await eventually("eight said") { await server.said.last?.count == 8 }
        let said = await server.said
        XCTAssertEqual(said, [Array(all.suffix(8))])
        shown.removeAll()
    }

    func testAScreenSwappedForOneOfTheSameTargetSaysNothingNew() async {
        let server = FakeViewersServer()
        let store = makeStore(server)
        await store.opened(hello("s1"))
        var folder: AsyncStream<ViewersState>? = await store.view(todo)
        await eventually("said") { await server.said == [[todo]] }
        let next = await store.view(todo)
        folder = nil
        try? await Task.sleep(for: .milliseconds(80))
        let said = await server.said
        XCTAssertEqual(said, [[todo]], "the same target again is not news")
        _ = (folder, next)
    }

    func testTheBackgroundSaysNothingIsLookedAtAndTheForegroundSaysItAgain() async {
        let server = FakeViewersServer()
        let store = makeStore(server, heartbeat: .milliseconds(40))
        await store.opened(hello("s1"))
        let watching = Task { for await _ in await store.view(chat) {} }
        await eventually("said") { await server.said.last == [chat] }
        await store.setForeground(false)
        await eventually("hidden") { await server.said.last == [] }
        let count = await server.said.count
        try? await Task.sleep(for: .milliseconds(120))
        let observed3 = await server.said.count
        XCTAssertEqual(observed3, count, "nothing said while away")
        await store.setForeground(true)
        await eventually("back") { await server.said.last == [chat] }
        watching.cancel()
    }

    func testA404HidesTheSlotUntilTheNextStreamSaysHello() async {
        let server = FakeViewersServer()
        await server.refuse(true)
        let store = makeStore(server, heartbeat: .milliseconds(30))
        await store.opened(hello("s1"))
        var states = await store.view(chat).makeAsyncIterator()
        _ = await states.next()
        let refused = await states.next()
        XCTAssertEqual(refused, .unavailable)
        try? await Task.sleep(for: .milliseconds(100))
        let afterRefusal = await server.calls.count
        XCTAssertEqual(afterRefusal, 1, "nothing asked again on the stream that was refused")
        await store.opened(hello("s1"))
        try? await Task.sleep(for: .milliseconds(60))
        let sameStream = await server.calls.count
        XCTAssertEqual(sameStream, 1, "the same stream's hello again is not a new stream")
        await store.closed()
        _ = await states.next()
        await server.refuse(false)
        await store.opened(hello("s2", daemon: nil))
        let back = await states.next()
        XCTAssertEqual(back, .viewers([], live: false))
        let answered = await states.next()
        XCTAssertEqual(answered, .viewers([], live: true))
        let last = await server.calls.last?.stream
        XCTAssertEqual(last, "s2")
    }

    func testFramesApplyInArrivalOrderOverTheLastAnswer() async {
        let server = FakeViewersServer()
        await server.set(todo, [Viewer(userId: "anna", here: false, lastSeenAt: now - 360_000)])
        let store = makeStore(server)
        await store.opened(hello("s1"))
        var states = await store.view(todo).makeAsyncIterator()
        _ = await states.next()
        _ = await states.next()
        await store.frame(#"{"target":{"type":"surface","id":"todo-1"},"viewer":{"userId":"kirill","here":true,"lastSeenAt":1800000000000}}"#)
        let arrived = await states.next()
        XCTAssertEqual(arrived, .viewers([Viewer(userId: "kirill", here: true, lastSeenAt: now), Viewer(userId: "anna", here: false, lastSeenAt: now - 360_000)], live: true))
        await store.frame(#"{"target":{"type":"surface","id":"todo-1"},"viewer":{"userId":"kirill","here":false,"lastSeenAt":1800000005000}}"#)
        let left = await states.next()
        XCTAssertEqual(left, .viewers([Viewer(userId: "kirill", here: false, lastSeenAt: now + 5_000), Viewer(userId: "anna", here: false, lastSeenAt: now - 360_000)], live: true))
        await store.frame(#"{"target":{"type":"agent","id":"other"},"viewer":{"userId":"max","here":true,"lastSeenAt":1}}"#)
        await store.closed()
        let closed = await states.next()
        XCTAssertEqual(closed, .viewers([Viewer(userId: "kirill", here: false, lastSeenAt: now + 5_000), Viewer(userId: "anna", here: false, lastSeenAt: now - 360_000)], live: false))
    }

    // MARK: Lost answers, in flight, reconnects, reopening

    func testAnAnswerLostAfterTheServerAppliedItStillEndsInAClearWhenTheScreenLeaves() async {
        let server = FakeViewersServer()
        await server.hold(true)
        let store = makeStore(server)
        await store.opened(hello("s1"))
        let watching = Task { for await _ in await store.view(todo) {} }
        await eventually("asked") { await server.held == 1 }
        // The screen goes while the PUT is out; then its answer is lost.
        watching.cancel()
        try? await Task.sleep(for: .milliseconds(20))
        await server.hold(false)
        await server.release(.lose)
        await eventually("the server holds it though the phone never heard so") { await server.holds["s1"] != nil }
        await eventually("cleared") { await server.holds["s1"] == [] }
        let said = await server.said
        XCTAssertEqual(said.last, [])
    }

    func testAnAnswerLostBeforeTheAppGoesAwayStillEndsInAClear() async {
        let server = FakeViewersServer()
        await server.end(.lose)
        let store = makeStore(server)
        await store.opened(hello("s1"))
        let watching = Task { for await _ in await store.view(chat) {} }
        await eventually("applied, answer lost") { await server.holds["s1"] == [chat] }
        await server.end(.answer)
        await store.setForeground(false)
        await eventually("cleared") { await server.holds["s1"] == [] }
        let count = await server.said.count
        try? await Task.sleep(for: .milliseconds(80))
        let after = await server.said.count
        XCTAssertEqual(after, count, "known clear: nothing more while away")
        watching.cancel()
    }

    func testAClearLostOnTheWayIsSaidAgain() async {
        let server = FakeViewersServer()
        let store = makeStore(server)
        await store.opened(hello("s1"))
        let watching = Task { for await _ in await store.view(chat) {} }
        await eventually("said") { await server.holds["s1"] == [chat] }
        await server.hold(true)
        watching.cancel()
        await eventually("clearing") { await server.held == 1 }
        // Lost before the server applied it: it still holds the chat.
        await server.hold(false)
        await server.release(.drop)
        await eventually("cleared") { await server.holds["s1"] == [] }
    }

    func testAPutInFlightWhenTheAppGoesAwayIsFollowedByAClearInOrder() async {
        let server = FakeViewersServer()
        await server.set(chat, [Viewer(userId: "anna", here: true, lastSeenAt: now)])
        await server.hold(true)
        let store = makeStore(server)
        await store.opened(hello("s1"))
        var states = await store.view(chat).makeAsyncIterator()
        _ = await states.next()
        await eventually("in flight") { await server.held == 1 }
        await store.setForeground(false)
        try? await Task.sleep(for: .milliseconds(30))
        let whileHeld = await server.said
        XCTAssertEqual(whileHeld, [[chat]], "one PUT at a time: the clear waits for the one in flight")
        await server.release(.answer)
        await eventually("clear asked") { await server.held == 1 }
        await server.release(.answer)
        await eventually("cleared") { await server.holds["s1"] == [] }
        let said = await server.said
        XCTAssertEqual(said, [[chat], []])
        // Answered after the app went away: drawn as history, nobody here.
        let drawn = await next(&states, "drawn") { $0 != .viewers([], live: false) }
        XCTAssertEqual(drawn, .viewers([Viewer(userId: "anna", here: false, lastSeenAt: now)], live: false))
    }

    func testAfterAReconnectNobodyIsHereUntilTheNewStreamAnswers() async {
        let server = FakeViewersServer()
        let anna = Viewer(userId: "anna", here: true, lastSeenAt: now)
        await server.set(chat, [anna])
        let store = makeStore(server)
        await store.opened(hello("s1"))
        var states = await store.view(chat).makeAsyncIterator()
        let live = await next(&states, "live") { $0 == .viewers([anna], live: true) }
        XCTAssertNotNil(live)
        await server.hold(true)
        await store.closed()
        let closed = await states.next()
        XCTAssertEqual(closed, .viewers([Viewer(userId: "anna", here: false, lastSeenAt: now)], live: false))
        // Anna left while the phone was away from the stream.
        await server.set(chat, [Viewer(userId: "anna", here: false, lastSeenAt: now + 9_000)])
        await store.opened(hello("s2"))
        await eventually("asked on s2") { await server.held == 1 }
        await server.release(.answer)
        let fresh = await states.next()
        XCTAssertEqual(fresh, .viewers([Viewer(userId: "anna", here: false, lastSeenAt: now + 9_000)], live: true))
    }

    func testReopeningAScreenDoesNotDrawTheOldAnswerAsHere() async {
        let server = FakeViewersServer()
        let anna = Viewer(userId: "anna", here: true, lastSeenAt: now)
        await server.set(todo, [anna])
        let store = makeStore(server)
        await store.opened(hello("s1"))
        var first = await store.view(todo).makeAsyncIterator()
        let live = await next(&first, "live") { $0 == .viewers([anna], live: true) }
        XCTAssertNotNil(live)
        first = AsyncStream<ViewersState> { $0.finish() }.makeAsyncIterator()
        await eventually("left") { await server.holds["s1"] == [] }
        // Anna leaves; this phone, looking elsewhere, hears no frame.
        await server.set(todo, [Viewer(userId: "anna", here: false, lastSeenAt: now + 4_000)])
        await server.hold(true)
        var again = await store.view(todo).makeAsyncIterator()
        let reopened = await again.next()
        XCTAssertEqual(reopened, .viewers([Viewer(userId: "anna", here: false, lastSeenAt: now)], live: false))
        await eventually("asked again") { await server.held == 1 }
        await server.release(.answer)
        let fresh = await again.next()
        XCTAssertEqual(fresh, .viewers([Viewer(userId: "anna", here: false, lastSeenAt: now + 4_000)], live: true))
    }

    func testAwayNobodyIsHere() async {
        let server = FakeViewersServer()
        let anna = Viewer(userId: "anna", here: true, lastSeenAt: now)
        await server.set(chat, [anna])
        let store = makeStore(server)
        await store.opened(hello("s1"))
        var states = await store.view(chat).makeAsyncIterator()
        _ = await next(&states, "live") { $0 == .viewers([anna], live: true) }
        await store.setForeground(false)
        let away = await states.next()
        XCTAssertEqual(away, .viewers([Viewer(userId: "anna", here: false, lastSeenAt: now)], live: false))
        await store.setForeground(true)
        let back = await states.next()
        XCTAssertEqual(back, .viewers([anna], live: true))
    }

    func testAvailabilityIsWatchedWithoutLookingAtAnything() async {
        let server = FakeViewersServer()
        await server.refuse(true)
        let store = makeStore(server)
        var available = await store.available().makeAsyncIterator()
        let first = await available.next()
        XCTAssertEqual(first, true)
        await store.opened(hello("s1"))
        let watching = Task { for await _ in await store.view(chat) {} }
        let refused = await available.next()
        XCTAssertEqual(refused, false)
        watching.cancel()
        try? await Task.sleep(for: .milliseconds(30))
        await store.closed()
        await server.refuse(false)
        await store.opened(hello("s2"))
        let back = await available.next()
        XCTAssertEqual(back, true)
        let calls = await server.calls.count
        XCTAssertEqual(calls, 1, "watching availability says nothing to the server")
    }

    func testANewStreamSaysWhatIsShownWhileAPutOnTheOldOneIsStillOut() async {
        let server = FakeViewersServer()
        let anna = Viewer(userId: "anna", here: true, lastSeenAt: now)
        await server.set(chat, [anna])
        await server.hold(true)
        let store = makeStore(server)
        await store.opened(hello("s1"))
        var states = await store.view(chat).makeAsyncIterator()
        _ = await states.next()
        await eventually("out on s1") { await server.held(on: "s1") == 1 }
        // The stream is replaced while s1's PUT waits for an answer.
        await store.opened(hello("s2"))
        await eventually("said on s2 before s1 answers") { await server.held(on: "s2") == 1 }
        guard await server.held(on: "s2") == 1 else {
            await server.hold(false)
            await server.release(.answer, stream: "s1")
            return
        }
        let streams = await server.calls.map(\.stream)
        XCTAssertEqual(streams, ["s1", "s2"])
        await server.release(.answer, stream: "s2")
        let live = await next(&states, "s2's answer") { $0 == .viewers([anna], live: true) }
        XCTAssertNotNil(live)
        // s1 answers late, with what was so then: it changes nothing.
        await server.set(chat, [Viewer(userId: "max", here: true, lastSeenAt: now)])
        await server.hold(false)
        await server.release(.answer, stream: "s1")
        try? await Task.sleep(for: .milliseconds(60))
        let after = await server.calls.map(\.stream)
        XCTAssertEqual(after, ["s1", "s2"], "the late answer neither re-asks nor un-says s2")
        let watching = Task { for await _ in await store.view(todo) {} }
        await eventually("the s2 pump still speaks") { await server.said.last == [chat, todo] }
        let last = await server.calls.last?.stream
        XCTAssertEqual(last, "s2")
        watching.cancel()
    }
}
