import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

/// The iPad sidebar grouped by project: SessionsList.tsx's own hierarchy
/// (bots, then computers, their projects by name, a heading per checkout
/// over a card of its chats, then the archive), not home's project cards.
final class TabletGroupedListTests: XCTestCase {
    static let now = ApplyPerfFixtures.now
    static let minute: Int64 = 60_000
    static let hour: Int64 = 60 * minute
    static let day: Int64 = 24 * hour

    static func machine(_ id: String, active: Bool, name: String) -> MachineRecord {
        MachineRecord(
            id: id, seq: 1, createdAt: now, updatedAt: now, active: active, activeAt: now,
            metadataVersion: 1, metadataCipher: "c", metadata: .object(["displayName": .string(name)]),
            daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil, dataKeyCipher: "k", decryptable: true
        )
    }

    static func session(
        _ id: String,
        machine: String?,
        path: String?,
        active: Bool = true,
        at: Int64 = now - minute,
        title: String? = nil,
        metadata extra: [String: JSONValue] = [:],
        agentState: JSONValue? = nil,
        thinking: Bool = false,
        unread: Bool = false
    ) -> SessionRecord {
        var metadata: [String: JSONValue] = ["homeDir": .string("/work"), "lastMeaningfulMessageAt": .number(Double(at))]
        if let machine { metadata["machineId"] = .string(machine) }
        if let path { metadata["path"] = .string(path) }
        if let title { metadata["summary"] = .object(["text": .string(title)]) }
        metadata.merge(extra) { _, new in new }
        return SessionRecord(
            id: id, seq: 1, createdAt: at, updatedAt: at, active: active, activeAt: at, projectId: nil,
            metadataVersion: 1, metadataCipher: "c", metadata: .object(metadata),
            agentStateVersion: 0, agentStateCipher: nil, agentState: agentState,
            dataKeyCipher: "k", decryptable: true, thinking: thinking, unread: unread
        )
    }

    static let worktreePath = "/work/happy/.dev/worktree/fix-x"

    /// Two computers (one offline), a bot, two projects with a worktree,
    /// a chat that names no computer, and two archived chats.
    static func snapshot(hidesArchive: Bool = false, grouping: String = "project", presenceNow: Int64? = nil) -> HomeSnapshot {
        let bot: [String: JSONValue] = ["bot": .object([
            "id": .string("bot1"), "name": .string("Helper"), "username": .string("helper"), "orderKey": .string("a"),
        ])]
        var snapshot = HomeSnapshot(
            machines: MachinesSnapshot(synced: true, machines: [
                machine("m1", active: true, name: "Studio"),
                machine("m2", active: false, name: "Laptop"),
            ]),
            sessions: [
                session("b1", machine: "m1", path: "/work/helper", metadata: bot),
                session("s1", machine: "m1", path: "/work/happy", title: "Primary"),
                session("s2", machine: "m1", path: worktreePath, at: now - 2 * minute, title: "Worktree", thinking: true),
                session("s3", machine: "m1", path: "/work/alpha", title: "Alpha",
                        agentState: .object(["requests": .object(["r1": .object(["tool": .string("Bash")])])])),
                session("s4", machine: "m2", path: "/home/u/proj", title: "Away"),
                session("s5", machine: nil, path: nil, title: "Nowhere"),
                session("a1", machine: "m1", path: "/work/old", active: false, at: now - 2 * hour, title: "Old"),
                session("a2", machine: "m1", path: "/work/older", active: false, at: now - day, title: "Older"),
            ],
            settings: SettingsSnapshot(pending: [
                "sessionListGrouping": .string(grouping),
                "hideInactiveSessions": .bool(hidesArchive),
            ]),
            sessionsSynced: true
        )
        snapshot.presenceNow = presenceNow
        return snapshot
    }

    static func list(_ snapshot: HomeSnapshot) -> TabletGroupedList {
        TabletGroupedList(snapshot, offline: nil, clock: ApplyPerfFixtures.clock)
    }

    static func projectId(_ machine: String?, _ path: String) -> String {
        "happy:" + ProjectHomeData.jsonKey(machine, path)
    }

    func testSessionsListsHierarchy() {
        let list = Self.list(Self.snapshot())
        let happy = Self.projectId("m1", "/work/happy")
        XCTAssertEqual(list.ids, [
            .botsHeader, .bot("b1"),
            // An offline computer goes by its id (useAllMachines lists only
            // online ones), which sorts it before "Studio".
            .machine("m2"), .workspace(Self.projectId("m2", "/home/u/proj") + "\u{0}"), .chat("s4"),
            .machine("m1"),
            .workspace(Self.projectId("m1", "/work/alpha") + "\u{0}"), .chat("s3"),
            .workspace(happy + "\u{0}"), .chat("s1"),
            .workspace(happy + "\u{0}" + Self.worktreePath), .chat("s2"),
            // Chats that name no computer come last.
            .machine(nil), .workspace(Self.projectId(nil, "") + "\u{0}"), .chat("s5"),
            .archiveToggle, .archiveHeader(0), .archived("a1"), .archiveHeader(1), .archived("a2"),
        ])
        XCTAssertEqual(list.rows[2], .machine(id: "m2", name: "m2"))
        XCTAssertEqual(list.rows[5], .machine(id: "m1", name: "Studio"))
        XCTAssertEqual(list.rows[12], .machine(id: nil, name: "<unknown>"))
        XCTAssertEqual(list.rows[16], .archiveHeader(.today))
        XCTAssertEqual(list.rows[18], .archiveHeader(.yesterday))
    }

    func testBotsAreHomesFlatRows() throws {
        let list = Self.list(Self.snapshot())
        guard case .bot(let row) = list.rows[1] else { return XCTFail("\(list.rows[1])") }
        XCTAssertEqual(row.title, "Helper")
        XCTAssertEqual(row.projectName, "@helper")
        // The only bot keeps no hairline; the order key is not drawn.
        XCTAssertFalse(row.showsDivider)
        XCTAssertEqual(row.lastActivityAt, 0)
    }

    func testCheckoutHeadings() {
        let list = Self.list(Self.snapshot())
        guard case .workspace(let primary) = list.rows[8], case .workspace(let worktree) = list.rows[10],
              case .workspace(let nowhere) = list.rows[13]
        else { return XCTFail("\(list.rows)") }
        XCTAssertEqual(primary.projectName, "happy")
        XCTAssertEqual(primary.branch, "main")
        XCTAssertEqual(primary.avatar, SessionAvatar(seed: "m1:/work/happy"))
        XCTAssertNil(primary.changes)
        XCTAssertEqual(primary.place, TabletNewSessionPlace(machineId: "m1", path: "~/happy", worktreeKey: nil))
        XCTAssertEqual(worktree.projectName, "happy")
        XCTAssertEqual(worktree.branch, "fix-x")
        XCTAssertEqual(worktree.place, TabletNewSessionPlace(machineId: "m1", path: "~/happy", worktreeKey: Self.worktreePath))
        XCTAssertEqual(nowhere.projectName, "Home")
        XCTAssertEqual(nowhere.avatar, SessionAvatar(seed: "s5"))
        XCTAssertEqual(nowhere.place, TabletNewSessionPlace(machineId: nil, path: nil, worktreeKey: nil))
    }

    func testChatsInTheirCards() {
        let list = Self.list(Self.snapshot())
        XCTAssertEqual(list.rows[7], .chat(TabletChatRow(
            id: "s3", title: "Alpha", connected: true, indicator: .dot(.attention, pulsing: true),
            showsBorder: false, first: true, last: true, projectEnd: true
        )))
        // The primary checkout's card, then the worktree's closes the project.
        XCTAssertEqual(list.rows[9], .chat(TabletChatRow(
            id: "s1", title: "Primary", connected: true, indicator: .dot(.idle, pulsing: false),
            showsBorder: false, first: true, last: true, projectEnd: false
        )))
        XCTAssertEqual(list.rows[11], .chat(TabletChatRow(
            id: "s2", title: "Worktree", connected: true, indicator: .dot(.working, pulsing: true),
            showsBorder: false, first: true, last: true, projectEnd: true
        )))
    }

    func testCompactRowIndicators() {
        func indicator(_ session: SessionRecord) -> TabletChatRow.Indicator? {
            var snapshot = Self.snapshot()
            snapshot.sessions = [session]
            guard case .chat(let row)? = Self.list(snapshot).rows.first(where: { $0.sessionId == session.id }) else { return nil }
            return row.indicator
        }
        // Unread is blue and still; waiting on the person stays orange.
        XCTAssertEqual(indicator(Self.session("u", machine: "m1", path: "/p", unread: true)), .dot(.working, pulsing: false))
        XCTAssertEqual(
            indicator(Self.session("q", machine: "m1", path: "/p", agentState: .object(["requests": .object(["r": .object([:])])]), unread: true)),
            .dot(.attention, pulsing: true)
        )
        // A disconnected Happy Agent chat stays live and shows no dot.
        let rig: [String: JSONValue] = ["client": .object(["id": .string("rig")])]
        XCTAssertEqual(indicator(Self.session("r", machine: "m1", path: "/p", active: false, metadata: rig)), TabletChatRow.Indicator.none)
    }

    func testCardsSpanEveryChatInACheckout() {
        var snapshot = Self.snapshot()
        snapshot.sessions = [
            Self.session("x1", machine: "m1", path: "/work/happy", at: Self.now - Self.minute),
            Self.session("x2", machine: "m1", path: "/work/happy", at: Self.now - 2 * Self.minute),
            Self.session("x3", machine: "m1", path: "/work/happy", at: Self.now - 3 * Self.minute),
        ]
        let chats: [TabletChatRow] = Self.list(snapshot).rows.compactMap {
            if case .chat(let row) = $0 { return row }
            return nil
        }
        XCTAssertEqual(chats.map(\.id), ["x1", "x2", "x3"])
        XCTAssertEqual(chats.map(\.first), [true, false, false])
        XCTAssertEqual(chats.map(\.last), [false, false, true])
        XCTAssertEqual(chats.map(\.showsBorder), [true, true, false])
        XCTAssertEqual(chats.map(\.projectEnd), [false, false, true])
    }

    func testArchivedCards() {
        let list = Self.list(Self.snapshot())
        guard case .archived(let old) = list.rows[17] else { return XCTFail("\(list.rows[17])") }
        XCTAssertEqual(old.title, "Old")
        XCTAssertFalse(old.connected)
        XCTAssertEqual(old.subtitle, .folder("old"))
        XCTAssertEqual(old.status, .lastSeen(.hours(2)))
        XCTAssertEqual(old.tone, .offline)
        XCTAssertFalse(old.pulsing)
        XCTAssertNil(old.modelName)
        XCTAssertNil(old.activity)
        // Alone under its day: both ends rounded.
        XCTAssertTrue(old.first)
        XCTAssertTrue(old.last)
    }

    func testHappyAgentArchivedCard() throws {
        var snapshot = Self.snapshot()
        snapshot.sessions = [Self.session("r", machine: "m1", path: "/work/rigproj", title: "Agent", metadata: [
            "client": .object(["id": .string("rig"), "name": .string("Rig")]),
            "provider": .object(["name": .string("Anthropic")]),
            "currentModelCode": .string("opus"),
            "lifecycleState": .string("archived"),
            "activity": .object([
                "subagents": .object(["running": .number(2), "queued": .number(1)]),
                "workflows": .object(["running": .number(0)]),
                "processes": .object(["running": .number(0)]),
                "tasks": .object(["pending": .number(3), "inProgress": .number(1)]),
            ]),
        ], unread: true)]
        let list = Self.list(snapshot)
        guard case .archived(let row)? = list.rows.last else { return XCTFail("\(list.rows)") }
        XCTAssertEqual(row.subtitle, .identity("Rig · Anthropic"))
        XCTAssertEqual(row.modelName, "opus")
        XCTAssertEqual(row.activity, "2+1 subagents · 1+3 tasks")
        // Connected and unread: blue, still, "new results".
        XCTAssertTrue(row.connected)
        XCTAssertEqual(row.status, .unread)
        XCTAssertEqual(row.tone, .working)
        XCTAssertFalse(row.pulsing)
    }

    func testHiddenArchiveKeepsOnlyItsToggle() {
        let list = Self.list(Self.snapshot(hidesArchive: true))
        XCTAssertEqual(list.ids.last, .archiveToggle)
        XCTAssertEqual(list.rows.last, .archiveToggle(hidden: true))
        XCTAssertFalse(list.ids.contains(.archived("a1")))
    }

    func testLastSeenOnThePresenceClockDatesOnTheClock() {
        let plain = Self.list(Self.snapshot())
        // The presence clock last moved an hour on: "last seen" follows it,
        // while the row stamps and day headings stay on the real clock.
        let later = Self.list(Self.snapshot(presenceNow: Self.now + Self.hour))
        guard case .archived(let old) = later.rows[17] else { return XCTFail("\(later.rows[17])") }
        XCTAssertEqual(old.status, .lastSeen(.hours(3)))
        XCTAssertEqual(later.rows[1], plain.rows[1])
        // A presence clock stood still two days ago dates nothing.
        let stale = Self.list(Self.snapshot(presenceNow: Self.now - 2 * Self.day))
        XCTAssertEqual(stale.rows[1], plain.rows[1])
        XCTAssertEqual(stale.rows[16], .archiveHeader(.today))
    }

    func testTheOpenChatIsFoundWhereverItIs() {
        let list = Self.list(Self.snapshot())
        XCTAssertEqual(list.rows.firstIndex { $0.sessionId == "s2" }, 11)
        XCTAssertEqual(list.rows.firstIndex { $0.sessionId == "b1" }, 1)
        XCTAssertEqual(list.rows.firstIndex { $0.sessionId == "a2" }, 19)
        XCTAssertNil(list.rows[10].sessionId, "a heading opens nothing")
    }
}

/// The sidebar's derivation off the main thread: exactly which rows each
/// change touches, against the rows each list last applied.
final class TabletSidebarChangesetTests: XCTestCase {
    typealias Fixture = TabletGroupedListTests

    private func derive(_ snapshot: HomeSnapshot, after state: TabletSidebarDerivation.Applied = .init()) -> (output: TabletSidebarUpdate, state: TabletSidebarDerivation.Applied)? {
        TabletSidebarDerivation.derive(snapshot, applied: state, clock: ApplyPerfFixtures.clock)
    }

    func testFirstGroupedApplyInsertsEveryRow() throws {
        let first = try XCTUnwrap(derive(Fixture.snapshot()))
        let list = try XCTUnwrap(first.output.frame.grouped)
        XCTAssertNil(first.output.frame.list)
        XCTAssertEqual(first.output.changeset, RowChangeset(inserts: Array(list.ids.indices)))
        XCTAssertEqual(first.state.grouped, list)
        XCTAssertNil(first.state.list)
    }

    func testOneRetitledChatReconfiguresExactlyItsRow() throws {
        let first = try XCTUnwrap(derive(Fixture.snapshot()))
        var snapshot = Fixture.snapshot()
        snapshot.sessions[1] = ApplyPerfFixtures.retitled(snapshot.sessions[1], "Renamed")
        let update = try XCTUnwrap(derive(snapshot, after: first.state))
        XCTAssertEqual(update.output.changeset, RowChangeset(reconfigures: [9]))
    }

    func testHeartbeatsAndCursorsDeriveNothing() throws {
        let first = try XCTUnwrap(derive(Fixture.snapshot()))
        var snapshot = Fixture.snapshot()
        for index in snapshot.sessions.indices where snapshot.sessions[index].active {
            snapshot.sessions[index] = ApplyPerfFixtures.invisiblyTouched(snapshot.sessions[index], by: 5_000)
        }
        XCTAssertNil(derive(snapshot, after: first.state))
    }

    func testAPresenceTickThatChangesNoTextDerivesNothing() throws {
        let first = try XCTUnwrap(derive(Fixture.snapshot(presenceNow: Fixture.now)))
        XCTAssertNil(derive(Fixture.snapshot(presenceNow: Fixture.now + Fixture.minute), after: first.state))
        // Once "2 hours" reads "3 hours", that card alone redraws.
        let update = try XCTUnwrap(derive(Fixture.snapshot(presenceNow: Fixture.now + Fixture.hour), after: first.state))
        XCTAssertEqual(update.output.changeset, RowChangeset(reconfigures: [17]))
    }

    func testHidingTheArchiveDeletesOnlyItsRows() throws {
        let first = try XCTUnwrap(derive(Fixture.snapshot()))
        let update = try XCTUnwrap(derive(Fixture.snapshot(hidesArchive: true), after: first.state))
        XCTAssertEqual(update.output.changeset, RowChangeset(deletes: [16, 17, 18, 19], reconfigures: [15]))
        XCTAssertTrue(update.output.frame.hidesArchived)
    }

    func testSwitchingGroupingDiffsEachListAgainstItsOwnRows() throws {
        let flat = try XCTUnwrap(derive(Fixture.snapshot(grouping: "flat")))
        let flatRows = try XCTUnwrap(flat.output.frame.list)
        XCTAssertNil(flat.output.frame.grouped)

        let grouped = try XCTUnwrap(derive(Fixture.snapshot(), after: flat.state))
        let groupedRows = try XCTUnwrap(grouped.output.frame.grouped)
        // The grouped list starts empty, so every row is an insert; the flat
        // list keeps its rows, hidden.
        XCTAssertEqual(grouped.output.changeset, RowChangeset(inserts: Array(groupedRows.ids.indices)))
        XCTAssertEqual(grouped.state.list, flatRows)

        // Back to flat: those rows are still on its table, so nothing moves.
        let back = try XCTUnwrap(derive(Fixture.snapshot(grouping: "flat"), after: grouped.state))
        XCTAssertEqual(back.output.frame.list, flatRows)
        XCTAssertEqual(back.output.changeset, RowChangeset())
        XCTAssertEqual(back.state.grouped, groupedRows)
    }

    func testTheSpinnerKeepsBothLists() throws {
        let grouped = try XCTUnwrap(derive(Fixture.snapshot()))
        // Before the first fetch, with no computer stored.
        var loading = Fixture.snapshot()
        loading.machines = MachinesSnapshot(synced: false, machines: [])
        let update = try XCTUnwrap(derive(loading, after: grouped.state))
        XCTAssertEqual(update.output.frame.content, .loading)
        XCTAssertNil(update.output.changeset)
        XCTAssertEqual(update.state.grouped, grouped.state.grouped)
        // And coming back applies nothing to the rows.
        let back = try XCTUnwrap(derive(Fixture.snapshot(), after: update.state))
        XCTAssertEqual(back.output.changeset, RowChangeset())
    }
}
