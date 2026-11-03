import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A computer's Feed routes as API.md has them: newest first by cursor,
/// pages before a cursor, seeing that closes a subject's open entry
/// through a cursor, and read-all. It can lack a feed or be away, and
/// every write is heard.
actor FakeFeedServer: FeedRoutes {
    struct Write: Equatable { var route: String; var target: String; var through: String?; var mutationId: String }
    private(set) var items: [FeedItem] = []
    private(set) var writes: [Write] = []
    private(set) var reads: [String?] = []
    var capable = true
    var away = false
    var gone = false
    var clusters: [FeedCluster] = []

    func setAway(_ away: Bool) { self.away = away }
    func setCapable(_ capable: Bool) { self.capable = capable }
    func setGone(_ gone: Bool) { self.gone = gone }
    func seed(_ items: [FeedItem]) { self.items = items.sorted(by: FeedLibrary.newestFirst) }

    private func reachable() throws {
        if away { throw URLError(.cannotConnectToHost) }
        if gone { throw AgentClientError.status(404, code: "not_found", message: nil) }
    }

    var unread: Int { items.filter(\.open).count }

    func feedCapable() async throws -> Bool {
        if away { throw URLError(.cannotConnectToHost) }
        return capable
    }

    func feed(before: String?, limit: Int) async throws -> FeedPage {
        try reachable()
        reads.append(before)
        let older = items.filter { before == nil || $0.cursor < before! }
        return FeedPage(items: Array(older.prefix(limit)), unread: unread, hasMore: older.count > limit, cursor: nil)
    }

    func markFeedSeen(_ subject: FeedSubject, through: String?, mutationId: String) async throws -> FeedSeenAnswer {
        try reachable()
        writes.append(Write(route: "seen", target: subject.key, through: through, mutationId: mutationId))
        var closed: [FeedItem] = []
        for index in items.indices where items[index].subject == subject && items[index].open && (through.map { items[index].cursor <= $0 } ?? true) {
            items[index].seenAt = 9
            items[index].version = items[index].version + "z"
            closed.append(items[index])
        }
        return FeedSeenAnswer(items: closed, unread: unread)
    }

    func markFeedReadAll(through: String?, mutationId: String) async throws -> Int {
        try reachable()
        writes.append(Write(route: "readAll", target: "all", through: through, mutationId: mutationId))
        for index in items.indices where items[index].open && (through.map { items[index].cursor <= $0 } ?? true) {
            items[index].seenAt = 9
            items[index].version = items[index].version + "z"
        }
        return unread
    }

    func feedClusters() async throws -> [FeedCluster] {
        try reachable()
        return clusters
    }

    func followFeedCluster(_ cluster: String, follow: Bool, mutationId: String) async throws -> FeedCluster {
        try reachable()
        writes.append(Write(route: follow ? "follow" : "mute", target: cluster, through: nil, mutationId: mutationId))
        guard let index = clusters.firstIndex(where: { $0.cluster == cluster }) else { throw AgentClientError.status(404, code: "not_found", message: nil) }
        clusters[index].state = follow ? "subscribed" : "muted"
        return clusters[index]
    }

    func peekFeedCluster(_ cluster: String, limit: Int) async throws -> FeedPeek {
        try reachable()
        let found = clusters.first { $0.cluster == cluster } ?? FeedCluster(cluster: cluster, kind: "team", name: "")
        return FeedPeek(cluster: found, entries: items.filter { $0.cluster == cluster })
    }

    func teamUsers(_ ids: [String]) async throws -> [TeamUser] { ids.map { TeamUser(id: $0, name: "Person \($0)") } }
}

/// What the Feed keeps between launches, as the account's checkpoints do;
/// it counts its writes.
actor MemoryFeedKeep: FeedKeep {
    private(set) var values: [String: JSONValue] = [:]
    private(set) var writes = 0
    func read(_ key: String) async -> JSONValue? { values[key] }
    func write(_ key: String, _ value: JSONValue) async { values[key] = value; writes += 1 }
}

final class FeedLibraryTests: XCTestCase {
    /// UUIDv7-like cursors that sort as text, newest greatest.
    private static func cursor(_ n: Int) -> String { String(format: "0199%08x-0000-7000-8000-000000000000", n) }

    private static func item(_ n: Int, subject: String = "task", id: String? = nil, version: Int = 1, open: Bool = true, actors: [FeedActor] = [], detail: String? = nil) -> FeedItem {
        FeedItem(
            id: "item\(n)", version: String(format: "v%04d", version), cursor: cursor(n),
            subject: FeedSubject(type: subject, id: id ?? "\(subject)\(n)"), cluster: "team",
            created: true, updates: 0, actors: actors,
            snapshot: FeedSnapshot(title: "Entry \(n)", detail: detail),
            firstAt: Double(n) * 1000, lastAt: Double(n) * 1000, seenAt: open ? nil : 5
        )
    }

    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var ms: Int64 = 1_000_000
        func now() -> Int64 { lock.lock(); defer { lock.unlock() }; return ms }
        func advance(_ duration: Duration) {
            lock.lock(); defer { lock.unlock() }
            ms += Int64(duration.components.seconds * 1000) + Int64(duration.components.attoseconds / 1_000_000_000_000_000)
        }
    }

    private struct Account {
        let library: FeedLibrary
        let outbox: IntentOutbox
    }

    /// One launch of an account: its outbox over `storage`, its feed over `keep`.
    private func launch(_ server: FakeFeedServer, storage: MemoryIntentStorage = MemoryIntentStorage(), keep: MemoryFeedKeep, online: Bool = true) async -> Account {
        let clock = Clock()
        let delivery = FeedDelivery()
        let outbox = IntentOutbox(storage: storage, deliver: { try await delivery.deliver($0) }, now: { clock.now() }, sleep: { clock.advance($0); await Task.yield() })
        let library = FeedLibrary(routes: server, outbox: outbox, keep: keep, now: { 7 })
        delivery.library = library
        await outbox.setOnline(online)
        await library.start()
        return Account(library: library, outbox: outbox)
    }

    /// Connected as the engine connects: the bootstrap's count, then health
    /// and the newest page on their own task.
    private func connect(_ account: Account, unread: Int?, cursor: String? = nil) async {
        await account.library.bootstrap(unread: unread, cursor: cursor)
        await account.library.connected()
    }

    private func eventually(_ seconds: Double = 3, _ condition: @escaping () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !(await condition()) {
            guard ContinuousClock.now < deadline else { return XCTFail("timed out", file: file, line: line) }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    private static func event(_ type: String, cursor: Int, _ payload: [String: JSONValue]) -> JSONValue {
        .object(["cursor": .string(Self.cursor(cursor)), "type": .string(type), "occurredAt": .number(1), "payload": .object(payload)])
    }

    private static func json(_ item: FeedItem) -> JSONValue {
        try! JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(item))
    }

    func testTheNewestPageShowsWithItsUnreadCount() async throws {
        let server = FakeFeedServer()
        await server.seed([Self.item(1, open: false), Self.item(2), Self.item(3)])
        let account = await launch(server, keep: MemoryFeedKeep())
        await connect(account, unread: 2)
        try await eventually { await account.library.current.items.count == 3 }
        let state = await account.library.current
        XCTAssertEqual(state.available, true)
        XCTAssertEqual(state.items.map(\.id), ["item3", "item2", "item1"], "newest change first")
        XCTAssertEqual(state.unread, 2)
        XCTAssertEqual(state.items.filter(state.isUnread).map(\.id), ["item3", "item2"])
    }

    /// No feed on this computer, by health or by the bootstrap: nothing
    /// shows, and nothing kept of an earlier one either.
    func testAComputerWithoutAFeedShowsNone() async throws {
        let server = FakeFeedServer()
        await server.seed([Self.item(1)])
        await server.setCapable(false)
        let keep = MemoryFeedKeep()
        let account = await launch(server, keep: keep)
        await connect(account, unread: 1)
        try await eventually { await account.library.current.available == false }
        let state = await account.library.current
        XCTAssertEqual(state.items, [])
        XCTAssertEqual(state.unread, 0)
        let reads = await server.reads
        XCTAssertEqual(reads, [], "a computer without a feed is never asked for one")

        let bootstrapless = await launch(FakeFeedServer(), keep: MemoryFeedKeep())
        await connect(bootstrapless, unread: nil)
        try await eventually { await bootstrapless.library.current.available == false }
    }

    /// The route itself answers 404 (a guest, an older daemon): the feed goes away.
    func testAFeedThatIsGoneGoesAway() async throws {
        let server = FakeFeedServer()
        await server.setGone(true)
        let account = await launch(server, keep: MemoryFeedKeep())
        await connect(account, unread: 0)
        try await eventually { await account.library.current.available == false }
    }

    func testEventsChangeOneEntryAndAnOlderVersionIsIgnored() async throws {
        let server = FakeFeedServer()
        await server.seed([Self.item(1), Self.item(2)])
        let account = await launch(server, keep: MemoryFeedKeep())
        await connect(account, unread: 2, cursor: Self.cursor(2))
        try await eventually { await account.library.current.items.count == 2 }

        var newer = Self.item(1, version: 2, detail: "Edited")
        newer.cursor = Self.cursor(5)
        await account.library.receive(Self.event("feed.item.updated", cursor: 5, ["item": Self.json(newer)]))
        var state = await account.library.current
        XCTAssertEqual(state.items.map(\.id), ["item1", "item2"], "a newer change moves its entry to the top")
        XCTAssertEqual(state.items.first?.snapshot.detail, "Edited")

        let stale = Self.item(1, version: 1, detail: "Old")
        await account.library.receive(Self.event("feed.item.updated", cursor: 6, ["item": Self.json(stale)]))
        state = await account.library.current
        XCTAssertEqual(state.items.first?.snapshot.detail, "Edited", "the greater version wins")

        await account.library.receive(Self.event("feed.item.created", cursor: 7, ["item": Self.json(Self.item(7))]))
        await account.library.receive(Self.event("feed.item.removed", cursor: 8, ["itemId": .string("item2")]))
        state = await account.library.current
        XCTAssertEqual(state.items.map(\.id), ["item7", "item1"])
    }

    /// An unread count is as of its event's cursor: an older one, read out
    /// of order, is ignored.
    func testAnOlderUnreadCountIsIgnored() async throws {
        let server = FakeFeedServer()
        let account = await launch(server, keep: MemoryFeedKeep())
        await connect(account, unread: 0, cursor: Self.cursor(1))
        try await eventually { let state = await account.library.current; return state.available == true && state.loaded && !state.refreshing }
        await account.library.receive(Self.event("feed.unread.updated", cursor: 10, ["unread": .number(4)]))
        await account.library.receive(Self.event("feed.unread.updated", cursor: 9, ["unread": .number(1)]))
        let unread = await account.library.current.unread
        XCTAssertEqual(unread, 4)
    }

    /// Opening an entry offline closes it at once and counts it off; it
    /// reaches the computer, through the change it showed, once online.
    func testOpeningAnEntryIsSeenAtOnceAndReachesTheComputer() async throws {
        let server = FakeFeedServer()
        await server.seed([Self.item(1), Self.item(2)])
        let account = await launch(server, keep: MemoryFeedKeep())
        await connect(account, unread: 2)
        try await eventually { await account.library.current.items.count == 2 }
        await account.outbox.setOnline(false)
        let held = await account.library.current.items
        let entry = try XCTUnwrap(held.first { $0.id == "item2" })
        await account.library.open(entry)
        var state = await account.library.current
        XCTAssertEqual(state.seenHere, ["item2"])
        XCTAssertEqual(state.unread, 1)
        XCTAssertFalse(state.isUnread(entry))

        await account.outbox.setOnline(true)
        try await eventually { await account.outbox.pending().isEmpty }
        let writes = await server.writes
        XCTAssertEqual(writes.map(\.route), ["seen"])
        XCTAssertEqual(writes.first?.target, "task:task2")
        XCTAssertEqual(writes.first?.through, Self.cursor(2))
        try await eventually { await account.library.current.seenHere.isEmpty }
        state = await account.library.current
        XCTAssertEqual(state.seenHere, [], "the computer's answer closed the held entry")
        XCTAssertEqual(state.items.first { $0.id == "item2" }?.open, false)
        XCTAssertEqual(state.unread, 1)
    }

    /// Something opened elsewhere (an artifact, a Surface) is seen only
    /// while its entry is open, never twice.
    func testSeeingElsewhereSendsOnlyForAnOpenEntry() async throws {
        let server = FakeFeedServer()
        await server.seed([Self.item(1, subject: "artifact", id: "a1", open: false), Self.item(2, subject: "surface", id: "s1")])
        let account = await launch(server, keep: MemoryFeedKeep())
        await connect(account, unread: 1)
        try await eventually { await account.library.current.items.count == 2 }
        await account.library.seen(FeedSubject(type: "artifact", id: "a1"))
        await account.library.seen(FeedSubject(type: "surface", id: "s1"))
        try await eventually { let writes = await server.writes.count; let pending = await account.outbox.pending(); return writes == 1 && pending.isEmpty }
        await account.library.seen(FeedSubject(type: "surface", id: "s1"))
        let writes = await server.writes
        XCTAssertEqual(writes.map(\.target), ["surface:s1"])
        XCTAssertNil(writes.first?.through)
        let unread = await account.library.current.unread
        XCTAssertEqual(unread, 0)
    }

    func testMarkAllReadClosesEveryEntryShown() async throws {
        let server = FakeFeedServer()
        await server.seed([Self.item(1), Self.item(2), Self.item(3)])
        let account = await launch(server, keep: MemoryFeedKeep())
        await connect(account, unread: 3)
        try await eventually { await account.library.current.items.count == 3 }
        await account.outbox.setOnline(false)
        await account.library.readAll()
        var state = await account.library.current
        XCTAssertEqual(state.unread, 0)
        XCTAssertEqual(state.items.filter(state.isUnread), [])
        await account.outbox.setOnline(true)
        try await eventually { await account.outbox.pending().isEmpty }
        let writes = await server.writes
        XCTAssertEqual(writes.map(\.route), ["readAll"])
        XCTAssertEqual(writes.first?.through, Self.cursor(3), "through the newest entry shown")
        try await eventually { await account.library.current.seenHere.isEmpty }
        state = await account.library.current
        XCTAssertEqual(state.items.filter(\.open), [])
        XCTAssertEqual(state.unread, 0)
    }

    /// What was shown is kept: a launch offline opens on it, and the
    /// seeing that hadn't gone yet is still laid over it.
    func testAKeptFeedOpensOfflineWithItsSeeing() async throws {
        let server = FakeFeedServer()
        await server.seed([Self.item(1), Self.item(2)])
        let storage = MemoryIntentStorage(), keep = MemoryFeedKeep()
        let first = await launch(server, storage: storage, keep: keep)
        await connect(first, unread: 2)
        try await eventually { await first.library.current.items.count == 2 }
        await first.outbox.setOnline(false)
        let held = await first.library.current.items
        let entry = try XCTUnwrap(held.first)
        await first.library.open(entry)
        await first.library.stop()
        await first.outbox.close()

        await server.setAway(true)
        let second = await launch(server, storage: storage, keep: keep, online: false)
        let state = await second.library.current
        XCTAssertEqual(state.available, true)
        XCTAssertTrue(state.loaded)
        XCTAssertEqual(state.items.map(\.id), ["item2", "item1"])
        XCTAssertEqual(state.seenHere, [entry.id])
        XCTAssertEqual(state.unread, 1)
    }

    /// An event that changes nothing kept writes nothing.
    func testAnEventThatChangesNothingWritesNothing() async throws {
        let server = FakeFeedServer()
        await server.seed([Self.item(1)])
        let keep = MemoryFeedKeep()
        let account = await launch(server, keep: keep)
        await connect(account, unread: 1)
        try await eventually { await keep.writes > 0 }
        try await Task.sleep(for: .milliseconds(100))
        let writes = await keep.writes
        await account.library.receive(Self.event("feed.item.updated", cursor: 2, ["item": Self.json(Self.item(1))]))
        let after = await keep.writes
        XCTAssertEqual(after, writes)
    }

    /// The people entries credit are read once, and kept with them.
    func testThePeopleCreditedAreRead() async throws {
        let server = FakeFeedServer()
        await server.seed([Self.item(1, actors: [FeedActor(userId: "u1"), FeedActor(agentId: "ag1")])])
        let account = await launch(server, keep: MemoryFeedKeep())
        await connect(account, unread: 1)
        try await eventually { await account.library.current.people["u1"]?.name == "Person u1" }
    }

    /// Paging reads older than the last entry held and appends it.
    func testLoadingMoreAppendsTheOlderPage() async throws {
        let server = FakeFeedServer()
        await server.seed((1...(FeedLibrary.page + 5)).map { Self.item($0) })
        let account = await launch(server, keep: MemoryFeedKeep())
        await connect(account, unread: 0)
        try await eventually { await account.library.current.items.count == FeedLibrary.page }
        var hasMore = await account.library.current.hasMore
        XCTAssertTrue(hasMore)
        await account.library.loadMore()
        let state = await account.library.current
        XCTAssertEqual(state.items.count, FeedLibrary.page + 5)
        XCTAssertEqual(state.items.last?.id, "item1")
        hasMore = state.hasMore
        XCTAssertFalse(hasMore)
    }
}
