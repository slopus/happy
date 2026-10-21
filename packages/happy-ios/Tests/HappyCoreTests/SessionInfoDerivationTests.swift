import Foundation
import GRDB
import XCTest
@testable import HappyCore
@testable import HappyStore
import HappyWire

/// info.tsx off the main thread: the session's own snapshot (never home's),
/// and exactly which groups and rows each change touches.
final class SessionInfoDerivationTests: XCTestCase {
    typealias Fixture = TabletGroupedListTests

    static func detail(_ session: SessionRecord?, dataReady: Bool = true, composer: JSONValue = .object([:])) -> SessionDetailSnapshot {
        SessionDetailSnapshot(
            session: session,
            machine: Fixture.machine("m1", active: true, name: "Studio"),
            settings: SettingsSnapshot(),
            dataReady: dataReady,
            composer: composer
        )
    }

    static let record = Fixture.session("s1", machine: "m1", path: "/work/happy", title: "Primary")

    private func derive(
        _ detail: SessionDetailSnapshot,
        git: GitStatus? = nil,
        raw: Bool = true,
        after applied: SessionInfoFrame? = nil,
        _ edit: (inout SessionInfoInput) -> Void = { _ in }
    ) -> (output: SessionInfoUpdate, state: SessionInfoFrame)? {
        var input = SessionInfoInput(includesRaw: raw)
        input.detail = detail
        input.git = git
        edit(&input)
        return SessionInfoDerivation.derive(input, applied: applied)
    }

    func testFirstApplyBuildsEveryGroup() throws {
        let first = try XCTUnwrap(derive(Self.detail(Self.record)))
        XCTAssertEqual(first.output.frame.sections, [.quickActions, .details, .metadata, .activity, .raw])
        XCTAssertEqual(first.output.changes, SessionInfoChanges(
            state: true, rebuilt: [.quickActions, .details, .metadata, .activity, .raw], title: true
        ))
        XCTAssertEqual(first.output.frame.raw.map(\.kind), [.metadata, .session])
        // Release builds have no raw group.
        XCTAssertEqual(try XCTUnwrap(derive(Self.detail(Self.record), raw: false)).output.frame.sections.last, .activity)
    }

    func testANewMessageRetextsTwoRowsAndTheRawSession() throws {
        let first = try XCTUnwrap(derive(Self.detail(Self.record)))
        var record = Self.record
        record.updatedAt += 5_000
        record.seq += 1
        let update = try XCTUnwrap(derive(Self.detail(record), after: first.state))
        XCTAssertEqual(update.output.changes, SessionInfoChanges(lastUpdated: true, sequence: true, rawBlocks: [1]))
        // Without the raw group, those two rows alone.
        let plain = try XCTUnwrap(derive(Self.detail(Self.record), raw: false))
        let quiet = try XCTUnwrap(derive(Self.detail(record), raw: false, after: plain.state))
        XCTAssertEqual(quiet.output.changes, SessionInfoChanges(lastUpdated: true, sequence: true))
    }

    func testWhatItDoesNotDrawDerivesNothing() throws {
        let first = try XCTUnwrap(derive(Self.detail(Self.record), raw: false))
        // The same snapshot, and a composer pick that changes no row.
        XCTAssertNil(derive(Self.detail(Self.record), raw: false, after: first.state))
        XCTAssertNil(derive(Self.detail(Self.record, composer: .object(["model": .string("x")])), raw: false, after: first.state))
    }

    func testTheCheckoutStatusRebuildsOnlyTheQuickActions() throws {
        let first = try XCTUnwrap(derive(Self.detail(Self.record)))
        var status = GitStatusParser.parse(status: "# branch.head main\n1 .M N... 100644 100644 100644 abc def a.swift", unstagedNumstat: "4\t2\ta.swift")
        status.lastUpdatedAt = 1
        let update = try XCTUnwrap(derive(Self.detail(Self.record), git: status, after: first.state))
        XCTAssertEqual(update.output.changes, SessionInfoChanges(rebuilt: [.quickActions]))
        // A refresh that finds the same files changes nothing drawn.
        status.lastUpdatedAt = 2
        XCTAssertNil(derive(Self.detail(Self.record), git: status, after: update.state))
    }

    /// Home's record gives the title the first frame shows, so the screen's
    /// own snapshot, holding the same record, changes no title.
    func testHomesRecordSeedsTheTitleTheFirstFrameShows() throws {
        let untitled = Fixture.session("s2", machine: "m1", path: "/work/other")
        let home = HomeSnapshot(machines: MachinesSnapshot(synced: true, machines: []), sessions: [untitled, Self.record])
        for record in [Self.record, untitled] {
            let seed = try XCTUnwrap(SessionInfoSeed(home, sessionId: record.id))
            let first = try XCTUnwrap(derive(Self.detail(record)))
            XCTAssertEqual(seed.title, first.output.frame.model?.title, record.id)
        }
        XCTAssertEqual(SessionInfoSeed(home, sessionId: Self.record.id)?.title, "Primary")
        XCTAssertNil(SessionInfoSeed(home, sessionId: untitled.id)?.title, "reads New chat")
        // Not in home, or no home yet: nothing to seed.
        XCTAssertNil(SessionInfoSeed(home, sessionId: "missing"))
        XCTAssertNil(SessionInfoSeed(nil, sessionId: Self.record.id))
    }

    func testMetadataRebuildsItsGroupAndRetextsItsBlock() throws {
        let first = try XCTUnwrap(derive(Self.detail(Self.record)))
        var record = Self.record
        var metadata = record.metadata?.objectValue ?? [:]
        metadata["host"] = .string("studio.local")
        record.metadata = .object(metadata)
        let update = try XCTUnwrap(derive(Self.detail(record), after: first.state))
        XCTAssertEqual(update.output.changes, SessionInfoChanges(rebuilt: [.metadata], rawBlocks: [0, 1]))
    }

    func testTheScreensOwnStateRebuildsItsGroup() throws {
        let first = try XCTUnwrap(derive(Self.detail(Self.record), raw: false))
        let forking = try XCTUnwrap(derive(Self.detail(Self.record), raw: false, after: first.state) { $0.forking = true })
        XCTAssertEqual(forking.output.changes, SessionInfoChanges(rebuilt: [.quickActions]))
        var record = Self.record
        record.active = false
        let offline = try XCTUnwrap(derive(Self.detail(record), raw: false, after: forking.state) { $0.forking = true })
        // Disconnected: the resume command shows, and the dot goes grey.
        XCTAssertTrue(offline.output.changes.rebuilt.contains(.details))
        let copied = try XCTUnwrap(derive(Self.detail(record), raw: false, after: offline.state) {
            $0.forking = true
            $0.copiedResumeCommand = true
        })
        XCTAssertEqual(copied.output.changes, SessionInfoChanges(rebuilt: [.details]))
    }

    func testLoadingThenDeleted() throws {
        let loading = try XCTUnwrap(derive(Self.detail(nil, dataReady: false)))
        XCTAssertEqual(loading.output.frame.content, .loading)
        XCTAssertEqual(loading.output.changes, SessionInfoChanges(state: true, title: true))
        let shown = try XCTUnwrap(derive(Self.detail(Self.record), after: loading.state))
        XCTAssertTrue(shown.output.changes.state)
        XCTAssertEqual(shown.output.changes.rebuilt, Set(shown.output.frame.sections))
        let deleted = try XCTUnwrap(derive(Self.detail(nil), after: shown.state))
        XCTAssertEqual(deleted.output.frame.content, .deleted)
        XCTAssertEqual(deleted.output.changes, SessionInfoChanges(state: true, title: true))
        // Nothing before the first snapshot.
        XCTAssertNil(SessionInfoDerivation.derive(SessionInfoInput(), applied: nil))
    }
}

/// The session's own snapshot: only its row, its computer, the settings,
/// the list cursor and its composer, fetched and compared off the main
/// thread.
final class SessionDetailSnapshotTests: XCTestCase {
    typealias Fixture = TabletGroupedListTests

    private func store() throws -> LocalStore {
        let store = try LocalStore.inMemory()
        try store.upsertMachine(Fixture.machine("m1", active: true, name: "Studio"))
        try store.upsertSessions([
            Fixture.session("s1", machine: "m1", path: "/work/happy", title: "Primary"),
            Fixture.session("s2", machine: "m1", path: "/work/other", title: "Other"),
        ])
        return store
    }

    private func waitUntil(_ condition: @Sendable () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<300 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("timed out", file: file, line: line)
    }

    func testTheSnapshotReadsTheSessionsOwnRows() throws {
        let store = try store()
        try store.saveComposerState(ComposerStateRecord(sessionId: "s1", values: .object(["permissionMode": .string("plan")])))
        let detail = try store.sessionDetail(sessionId: "s1")
        XCTAssertEqual(detail.session?.id, "s1")
        XCTAssertEqual(detail.machine?.id, "m1")
        XCTAssertEqual(detail.composer, .object(["permissionMode": .string("plan")]))
        XCTAssertTrue(detail.dataReady)
        // A session that isn't stored: deleted once any session is, else
        // still loading.
        XCTAssertTrue(try store.sessionDetail(sessionId: "gone").dataReady)
        XCTAssertFalse(try LocalStore.inMemory().sessionDetail(sessionId: "gone").dataReady)
    }

    func testTheStreamYieldsOnlyWhatChangedForThisSession() async throws {
        let store = try store()
        let seen = DetailSeen()
        let stream = store.sessionDetailSnapshots(sessionId: "s1")
        let reader = Task { for await value in stream { await seen.append(value) } }
        try await waitUntil { await seen.values.count == 1 }

        // Another session's message: fetched again off main, yields nothing.
        var other = Fixture.session("s2", machine: "m1", path: "/work/other", title: "Other")
        other.updatedAt += 1_000
        other.seq = 9
        try store.upsertSessions([other])
        // A presence checkpoint the overlay already shows: nothing either.
        let s1 = try XCTUnwrap(store.session(id: "s1"))
        store.setSessionPresenceOverlay(id: "s1", value: PresenceOverlayValue(
            active: true, latestAt: s1.activeAt + 30_000, displayedAt: s1.activeAt
        ))
        try store.persistPresence(sessions: ["s1": PresenceOverlayValue(active: true, latestAt: s1.activeAt + 30_000, displayedAt: s1.activeAt)], machines: [:])
        try await Task.sleep(for: .milliseconds(100))
        let quiet = await seen.values.count
        XCTAssertEqual(quiet, 1)

        // This session's message: its updatedAt and seq.
        var mine = s1
        mine.updatedAt += 2_000
        mine.seq = 4
        try store.upsertSessions([mine])
        try await waitUntil { await seen.values.count == 2 }
        let last = await seen.values.last
        XCTAssertEqual(last?.session?.seq, 4)
        XCTAssertEqual(last?.session?.activeAt, s1.activeAt)

        // Its composer.
        try store.saveComposerState(ComposerStateRecord(sessionId: "s1", values: .object(["permissionMode": .string("plan")])))
        try await waitUntil { await seen.values.count == 3 }
        reader.cancel()
    }

    func testASendAcceptedHereWakesNothing() async throws {
        let store = try store()
        let seen = DetailSeen()
        let stream = store.sessionDetailSnapshots(sessionId: "s1")
        let reader = Task { for await value in stream { await seen.append(value) } }
        try await waitUntil { await seen.values.count == 1 }
        let opened = await seen.values.first
        let first = try XCTUnwrap(opened)

        // The composer's send: the outbox row and the local activity stamp,
        // in one commit.
        let sentAt = Fixture.now + 5_000
        try store.enqueueAcceptedSend(
            [OutboxRecord(localId: "l1", kind: .message, sessionId: "s1", payload: .null, createdAt: sentAt)], attachments: []
        )
        // Stored, and read by whoever acts on the session.
        XCTAssertEqual(try store.session(id: "s1")?.lastMessageSentAt, sentAt)
        XCTAssertEqual(try store.sessionDetail(sessionId: "s1").session?.lastMessageSentAt, sentAt)
        try await Task.sleep(for: .milliseconds(100))
        let quiet = await seen.values.count
        XCTAssertEqual(quiet, 1)
        // Info derives nothing from it either.
        var input = SessionInfoInput()
        input.detail = first
        let shown = try XCTUnwrap(SessionInfoDerivation.derive(input, applied: nil))
        input.detail = try store.sessionDetail(sessionId: "s1")
        XCTAssertNil(SessionInfoDerivation.derive(input, applied: shown.state))

        // The server's echo: a new seq and updatedAt, which info shows.
        var echoed = try XCTUnwrap(store.session(id: "s1"))
        echoed.updatedAt += 6_000
        echoed.seq = 7
        try store.upsertSessions([echoed])
        try await waitUntil { await seen.values.count == 2 }
        let latest = await seen.values.last
        let last = try XCTUnwrap(latest)
        XCTAssertEqual(last.session?.seq, 7)
        XCTAssertEqual(last.session?.updatedAt, echoed.updatedAt)
        XCTAssertNil(last.session?.lastMessageSentAt)
        input.detail = last
        let update = try XCTUnwrap(SessionInfoDerivation.derive(input, applied: shown.state))
        XCTAssertEqual(update.output.changes, SessionInfoChanges(lastUpdated: true, sequence: true))
        reader.cancel()
    }

    func testEachAccountHasItsOwnFileCache() throws {
        func account() throws -> AccountSession {
            try AccountSession(
                credentials: Credentials(token: "test", secret: Data(repeating: 3, count: 32)),
                store: try LocalStore.inMemory(),
                dependencies: .init(serverURL: URL(string: "https://test.invalid")!, clientID: "test", transport: FakeHTTP(), connector: FakeConnector())
            )
        }
        let first = try account()
        let second = try account()
        let snapshot = FileViewer.Snapshot(content: .init(content: "secret", isBinary: false), diff: "+x")
        first.fileCache.setRoot(sessionId: "s", SessionFileCache.Root(path: "/repo"))
        first.fileCache.set(sessionId: "s", path: "/repo/a.swift", snapshot)
        // The same session id and path in another account reads nothing.
        XCTAssertEqual(first.fileCache.get(sessionId: "s", path: "/repo/a.swift"), snapshot)
        XCTAssertNil(second.fileCache.get(sessionId: "s", path: "/repo/a.swift"))
        XCTAssertNil(second.fileCache.root(sessionId: "s"))
        XCTAssertEqual(first.fileCache.root(sessionId: "s"), SessionFileCache.Root(path: "/repo"))
    }

    func testAccountStopEndsTheDetailFeed() async throws {
        let session = try AccountSession(
            credentials: Credentials(token: "test", secret: Data(repeating: 3, count: 32)),
            store: try store(),
            dependencies: .init(serverURL: URL(string: "https://test.invalid")!, clientID: "test", transport: FakeHTTP(), connector: FakeConnector())
        )
        let stream = session.sessionDetails.snapshots(sessionId: "s1")
        let first = try await syncPerfNext(stream)
        XCTAssertEqual(first?.session?.id, "s1")
        await session.stop()
        let ended = try await syncPerfNext(stream)
        XCTAssertNil(ended)
    }
}

private actor DetailSeen {
    var values: [SessionDetailSnapshot] = []
    func append(_ value: SessionDetailSnapshot) { values.append(value) }
}
