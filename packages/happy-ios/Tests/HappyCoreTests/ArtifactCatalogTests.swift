import Foundation
import XCTest
@testable import HappyCore
import HappyWire

private func json(_ text: String) -> JSONValue {
    try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
}

private func artifact(_ id: String, type: String = "markdown", title: String = "", updatedAt: Double, version: Int = 1, entry: String? = nil) -> String {
    let entry = entry.map { #","entry":{"path":"\#($0)","mimeType":"image/png","size":10,"sha256":"0"}"# } ?? ""
    return #"{"id":"\#(id)","type":"\#(type)","title":"\#(title)","status":"active","latestVersion":\#(version),"fileCount":1,"createdAt":1,"updatedAt":\#(updatedAt)\#(entry)}"#
}

/// The artifact catalog's rules: its pages, its events, its order and
/// search, and the date buckets the list groups it by.
final class ArtifactCatalogTests: XCTestCase {
    /// Tombstones are kept, for the Feed, which still names a deleted
    /// artifact; the Artifacts list leaves them out.
    func testAPageKeepsTombstonesAndItsCursor() {
        let page = ArtifactCatalog.page(json(#"{"artifacts":[\#(artifact("a", title: "Plan", updatedAt: 5, entry: "a.png")),{"id":"b","title":"Old","status":"deleted"},{"title":"no id"}],"nextPageCursor":"c2"}"#))
        XCTAssertEqual(page.items.map(\.id), ["a", "b"])
        XCTAssertEqual(page.items.map(\.deleted), [false, true])
        XCTAssertEqual(page.items[1].title, "Old")
        XCTAssertEqual(page.items[0].title, "Plan")
        XCTAssertEqual(page.items[0].entry, ArtifactSummary.Entry(path: "a.png", mimeType: "image/png", size: 10))
        XCTAssertTrue(page.items[0].showsPicture)
        XCTAssertEqual(page.next, "c2")
        XCTAssertNil(ArtifactCatalog.page(json(#"{"artifacts":[]}"#)).next)
    }

    func testALivePageShowsNoPicture() {
        let live = ArtifactSummary(json: json(#"{"id":"l","type":"html","status":"active","entry":{"path":"a.png","mimeType":"image/png","size":1},"live":{"url":"http://x"},"createdAt":1,"updatedAt":1}"#))
        XCTAssertEqual(live?.live, true)
        XCTAssertEqual(live?.showsPicture, false)
    }

    func testNewestChangeFirstTheIdBreakingTies() {
        let list = ["a": 1.0, "b": 3, "c": 3, "d": 2].map { ArtifactSummary(id: $0.key, type: "markdown", title: "", latestVersion: 1, entry: nil, createdAt: 0, updatedAt: $0.value) }
        XCTAssertEqual(ArtifactCatalog.sorted(list).map(\.id), ["c", "b", "d", "a"])
    }

    func testEventsChangeTheList() throws {
        let list = ArtifactCatalog.page(json(#"{"artifacts":[\#(artifact("a", title: "One", updatedAt: 2)),\#(artifact("b", title: "Two", updatedAt: 1))]}"#)).items

        guard case .changed(let created) = ArtifactCatalog.apply(json(#"{"type":"artifact.created","payload":{"artifact":\#(artifact("c", title: "New", updatedAt: 9))}}"#), to: list) else { return XCTFail() }
        XCTAssertEqual(created.map(\.id), ["c", "a", "b"])

        guard case .changed(let updated) = ArtifactCatalog.apply(json(#"{"type":"artifact.updated","payload":{"artifactId":"b","previousVersion":1,"version":2,"changes":{"title":"Renamed","latestVersion":2,"updatedAt":10}}}"#), to: list) else { return XCTFail() }
        XCTAssertEqual(updated.map(\.id), ["b", "a"])
        XCTAssertEqual(updated[0].title, "Renamed")
        XCTAssertEqual(updated[0].latestVersion, 2)

        guard case .changed(let deleted) = ArtifactCatalog.apply(json(#"{"type":"artifact.deleted","payload":{"artifactId":"a","changes":{"status":"deleted"}}}"#), to: list) else { return XCTFail() }
        XCTAssertEqual(deleted.map(\.id), ["a", "b"])
        XCTAssertEqual(deleted.map(\.deleted), [true, false], "a deletion leaves its tombstone")
        XCTAssertEqual(ArtifactCatalog.apply(json(#"{"type":"artifact.deleted","payload":{"artifactId":"a"}}"#), to: deleted), .none)
        guard case .changed(let viaUpdate) = ArtifactCatalog.apply(json(#"{"type":"artifact.updated","payload":{"artifactId":"b","changes":{"status":"deleted","updatedAt":11}}}"#), to: list) else { return XCTFail() }
        XCTAssertEqual(viaUpdate.first { $0.id == "b" }?.deleted, true)

        XCTAssertEqual(ArtifactCatalog.apply(json(#"{"type":"artifact.updated","payload":{"artifactId":"zzz","changes":{"title":"x"}}}"#), to: list), .read("zzz"))
        XCTAssertEqual(ArtifactCatalog.apply(json(#"{"type":"artifact.updated","payload":{"artifactId":"a","changes":{"title":"One"}}}"#), to: list), .none)
        // One this list doesn't hold: its tombstone is read, for the Feed.
        XCTAssertEqual(ArtifactCatalog.apply(json(#"{"type":"artifact.deleted","payload":{"artifactId":"zzz"}}"#), to: list), .read("zzz"))
        XCTAssertEqual(ArtifactCatalog.apply(json(#"{"type":"todo.created","payload":{}}"#), to: list), .none)
    }

    func testSearchMatchesEveryWordInTheTitleOrKindIgnoringCaseAndAccents() {
        let list = [("a", "Café menu", "markdown"), ("b", "Q3 roadmap", "html"), ("c", "Holiday", "image")].map {
            ArtifactSummary(id: $0.0, type: $0.2, title: $0.1, latestVersion: 1, entry: nil, createdAt: 0, updatedAt: 0)
        }
        let kind: (String) -> String = { ["markdown": "Document", "html": "Web page", "image": "Image"][$0] ?? $0 }
        XCTAssertEqual(ArtifactCatalog.matching("cafe", in: list, kindName: kind).map(\.id), ["a"])
        XCTAssertEqual(ArtifactCatalog.matching("ROAD web", in: list, kindName: kind).map(\.id), ["b"])
        XCTAssertEqual(ArtifactCatalog.matching("image", in: list, kindName: kind).map(\.id), ["c"])
        XCTAssertEqual(ArtifactCatalog.matching("  ", in: list, kindName: kind).map(\.id), ["a", "b", "c"])
        XCTAssertEqual(ArtifactCatalog.matching("menu roadmap", in: list, kindName: kind).map(\.id), [])
    }
}

final class DateBucketTests: XCTestCase {
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Berlin")!
        return calendar
    }()

    private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 12, _ minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
    }

    func testBucketsFromMidnightBack() {
        let now = date(2026, 11, 15, 9, 30)
        XCTAssertEqual(DateBucket.of(date(2026, 11, 15, 0, 0), now: now, calendar: calendar), .today)
        XCTAssertEqual(DateBucket.of(date(2026, 11, 15, 23, 0), now: now, calendar: calendar), .today, "a clock running ahead is still today")
        XCTAssertEqual(DateBucket.of(date(2026, 11, 14, 23, 59), now: now, calendar: calendar), .yesterday)
        XCTAssertEqual(DateBucket.of(date(2026, 11, 14, 0, 0), now: now, calendar: calendar), .yesterday)
        XCTAssertEqual(DateBucket.of(date(2026, 11, 13, 23, 59), now: now, calendar: calendar), .previous7Days)
        XCTAssertEqual(DateBucket.of(date(2026, 11, 8, 0, 0), now: now, calendar: calendar), .previous7Days)
        XCTAssertEqual(DateBucket.of(date(2026, 11, 7, 23, 59), now: now, calendar: calendar), .previous30Days)
        XCTAssertEqual(DateBucket.of(date(2026, 10, 16, 0, 0), now: now, calendar: calendar), .previous30Days)
        XCTAssertEqual(DateBucket.of(date(2026, 10, 15, 23, 59), now: now, calendar: calendar), .month(year: 2026, month: 10))
        XCTAssertEqual(DateBucket.of(date(2025, 12, 31), now: now, calendar: calendar), .month(year: 2025, month: 12))
    }

    /// Midnight is the calendar's, not 24 hours: across a clock change
    /// yesterday still starts at its midnight.
    func testAcrossTheClockChange() {
        // Berlin's clocks went back on 25 October 2026.
        let now = date(2026, 10, 26, 0, 30)
        XCTAssertEqual(DateBucket.of(date(2026, 10, 25, 0, 10), now: now, calendar: calendar), .yesterday)
        XCTAssertEqual(DateBucket.of(date(2026, 10, 24, 23, 50), now: now, calendar: calendar), .previous7Days)
    }

    func testGroupingKeepsOrderAndPutsALateItemWithItsBucket() {
        let now = date(2026, 11, 15)
        let dates = [date(2026, 11, 15, 8), date(2026, 11, 14), date(2026, 11, 15, 7), date(2026, 11, 1), date(2026, 9, 3), date(2026, 9, 1)]
        let groups = DateBucket.group(Array(dates.indices), now: now, calendar: calendar) { dates[$0] }
        XCTAssertEqual(groups.map(\.bucket), [.today, .yesterday, .previous30Days, .month(year: 2026, month: 9)])
        XCTAssertEqual(groups.map(\.items), [[0, 2], [1], [3], [4, 5]])
        XCTAssertTrue(DateBucket.group([Int](), now: now, calendar: calendar) { _ in now }.isEmpty)
    }
}

/// The feed: what it kept first, then the computer, then the events,
/// every change written back.
final class ArtifactCatalogFeedTests: XCTestCase {
    private actor Box {
        var kept: JSONValue?
        var writes = 0
        var pages: [String?: JSONValue] = [:]
        var status: Int?
        var reads = 0
        var single: [String: JSONValue] = [:]
        func keep(_ value: JSONValue) { kept = value; writes += 1 }
        func page(_ cursor: String?) throws -> JSONValue {
            reads += 1
            if let status { throw AgentClientError.status(status, code: nil, message: nil) }
            return pages[cursor] ?? json(#"{"artifacts":[]}"#)
        }
        func set(page cursor: String?, _ value: JSONValue) { pages[cursor] = value }
        func set(status: Int?) { self.status = status }
        func set(single id: String, _ value: JSONValue) { single[id] = value }
        func one(_ id: String) throws -> JSONValue { guard let value = single[id] else { throw URLError(.badServerResponse) }; return value }
    }

    private func make(_ box: Box, events: AsyncStream<Store.ConversationEvent>) -> ArtifactCatalogFeed {
        ArtifactCatalogFeed(
            fetch: { try await box.page($0) },
            fetchOne: { try await box.one($0) },
            keep: { await box.keep($0) },
            kept: { await box.kept },
            events: { events }
        )
    }

    private func eventually(_ seconds: Double = 3, _ condition: @escaping () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !(await condition()) {
            guard ContinuousClock.now < deadline else { return XCTFail("timed out", file: file, line: line) }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    private final class Last: @unchecked Sendable {
        private let lock = NSLock()
        private var value = ArtifactCatalogFeed.State()
        private var seen: [ArtifactCatalogFeed.State] = []
        func set(_ state: ArtifactCatalogFeed.State) { lock.withLock { value = state; seen.append(state) } }
        var state: ArtifactCatalogFeed.State { lock.withLock { value } }
        var all: [ArtifactCatalogFeed.State] { lock.withLock { seen } }
    }

    private func watch(_ feed: ArtifactCatalogFeed) async -> Last {
        let last = Last()
        let states = await feed.states()
        Task { for await state in states { last.set(state) } }
        return last
    }

    func testItOpensOnWhatItKeptThenReadsEveryPageAndWritesItBack() async throws {
        let box = Box()
        await box.keep(json("[\(artifact("old", title: "Kept", updatedAt: 1))]"))
        await box.set(page: nil, json(#"{"artifacts":[\#(artifact("a", updatedAt: 5))],"nextPageCursor":"p2"}"#))
        await box.set(page: "p2", json(#"{"artifacts":[\#(artifact("b", updatedAt: 4)),\#(artifact("a", updatedAt: 5))]}"#))
        let (events, _) = AsyncStream.makeStream(of: Store.ConversationEvent.self)
        let feed = make(box, events: events)
        let last = await watch(feed)
        await feed.start()
        try await eventually { last.all.contains { $0.items.map(\.id) == ["old"] && $0.loaded } }
        try await eventually { last.state.items.map(\.id) == ["a", "b"] }
        // Written down after it shows.
        try await eventually { await box.kept?.arrayValue?.compactMap { $0["id"]?.stringValue } == ["a", "b"] }
        await feed.stop()
    }

    func testEventsChangeItAndAnUnknownUpdateIsReadAlone() async throws {
        let box = Box()
        await box.set(page: nil, json(#"{"artifacts":[\#(artifact("a", title: "A", updatedAt: 5))]}"#))
        await box.set(single: "z", json(artifact("z", title: "Zed", updatedAt: 50)))
        let (events, input) = AsyncStream.makeStream(of: Store.ConversationEvent.self)
        let feed = make(box, events: events)
        let last = await watch(feed)
        await feed.start()
        try await eventually { last.state.items.map(\.id) == ["a"] }
        input.yield(.event(json(#"{"type":"artifact.updated","payload":{"artifactId":"a","changes":{"title":"A2"}}}"#)))
        try await eventually { last.state.items.first?.title == "A2" }
        input.yield(.event(json(#"{"type":"artifact.updated","payload":{"artifactId":"z","changes":{"title":"Zed"}}}"#)))
        try await eventually { last.state.items.map(\.id) == ["z", "a"] }
        input.yield(.event(json(#"{"type":"artifact.deleted","payload":{"artifactId":"a"}}"#)))
        try await eventually { last.state.items.first { $0.id == "a" }?.deleted == true }
        let kept = await box.kept
        XCTAssertEqual(kept?.arrayValue?.compactMap { $0["id"]?.stringValue }, ["z", "a"])
        XCTAssertEqual(kept?.arrayValue?.last?["deleted"], .bool(true), "kept as a tombstone")
        // A resync reads the whole catalog again.
        let before = await box.reads
        input.yield(.resync)
        try await eventually { await box.reads > before }
        await feed.stop()
    }

    func testAComputerWithoutArtifactsSaysSoAndAFailureKeepsTheList() async throws {
        let box = Box()
        await box.keep(json("[\(artifact("old", updatedAt: 1))]"))
        await box.set(status: 503)
        let (events, _) = AsyncStream.makeStream(of: Store.ConversationEvent.self)
        let feed = make(box, events: events)
        let last = await watch(feed)
        await feed.start()
        try await eventually { last.state.error != nil }
        XCTAssertEqual(last.state.items.map(\.id), ["old"])
        await box.set(status: 404)
        await feed.refresh()
        try await eventually { last.state.unsupported }
        XCTAssertEqual(last.state.items, [])
        XCTAssertNil(last.state.error)
        await feed.stop()
    }
}
