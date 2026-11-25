import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// `PUT /v0/viewers/streams/:streamId` as API.md has it: every call heard,
/// each target answered with the people set for it, or 404 while refused.
private actor FakeViewersServer {
    private(set) var calls: [(stream: String, targets: [ViewerTarget])] = []
    var people: [ViewerTarget: [Viewer]] = [:]
    var refusing = false

    func set(_ target: ViewerTarget, _ viewers: [Viewer]) { people[target] = viewers }
    func refuse(_ refusing: Bool) { self.refusing = refusing }

    func put(_ stream: String, _ targets: [ViewerTarget]) throws -> [(target: ViewerTarget, viewers: [Viewer])] {
        calls.append((stream, targets))
        if refusing { throw AgentClientError.status(404, code: "not_found", message: nil) }
        return targets.map { ($0, people[$0] ?? []) }
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
}

final class ViewersStoreTests: XCTestCase {
    private func makeStore(_ server: FakeViewersServer, heartbeat: Duration = .seconds(60)) -> ViewersStore {
        ViewersStore(heartbeat: heartbeat, settle: .milliseconds(5)) { stream, targets in try await server.put(stream, targets) }
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
        let answered = await states.next()
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
}
