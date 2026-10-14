import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

/// Cases from happy-app's utils/flatSessionList.test.ts,
/// flatSessionRowPresentation.test.ts and sessionListTimestamp.test.ts.
final class SessionListTests: XCTestCase {
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    /// Tuesday 13 October 2026, 12:00 UTC.
    private lazy var now = calendar.date(from: DateComponents(year: 2026, month: 10, day: 13, hour: 12))!
    private lazy var clock = SessionList.Clock(now: now, calendar: calendar, locale: Locale(identifier: "en_GB"))

    private func ago(hours: Double) -> Int64 {
        Int64((now.timeIntervalSince1970 - hours * 3600) * 1000)
    }

    private func record(
        _ id: String,
        active: Bool = true,
        at activity: Int64? = nil,
        _ metadata: [String: JSONValue] = [:],
        agentState: JSONValue? = nil,
        projectId: String? = nil
    ) -> SessionRecord {
        var metadata = metadata
        metadata["lastMeaningfulMessageAt"] = .number(Double(activity ?? ago(hours: 1)))
        return SessionRecord(
            id: id, seq: 0, createdAt: 1, updatedAt: 1, active: active, activeAt: 1,
            projectId: projectId, metadataVersion: 1, metadataCipher: "c", metadata: .object(metadata),
            agentStateVersion: 0, agentStateCipher: nil, agentState: agentState,
            dataKeyCipher: "k", decryptable: true
        )
    }

    private func machine(_ id: String, active: Bool) -> MachineRecord {
        MachineRecord(
            id: id, seq: 0, createdAt: 1, updatedAt: 1, active: active, activeAt: 1,
            metadataVersion: 1, metadataCipher: "c", metadata: .object([:]),
            daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil, dataKeyCipher: "k", decryptable: true
        )
    }

    private func list(
        _ sessions: [SessionRecord],
        machines: [MachineRecord] = [],
        projects: [ProjectRecord] = [],
        settings: [String: JSONValue] = [:]
    ) -> SessionList {
        SessionList(
            HomeSnapshot(
                machines: MachinesSnapshot(synced: true, machines: machines),
                sessions: sessions,
                projects: projects,
                settings: SettingsSnapshot(pending: settings)
            ),
            clock: clock
        )
    }

    private func rows(_ list: SessionList) -> [SessionRow] {
        list.items.compactMap { if case .session(let row) = $0 { row } else { nil } }
    }

    // MARK: Order and archive

    func testActiveFirstThenNewestActivityThenId() {
        let list = list([
            record("old-active", at: ago(hours: 9)),
            record("rig-idle", active: false, at: ago(hours: 1), ["client": .object(["id": .string("rig")])]),
            record("b", at: ago(hours: 2)),
            record("a", at: ago(hours: 2)),
        ])
        XCTAssertEqual(list.items.compactMap(\.sessionId), ["a", "b", "old-active", "rig-idle"])
        XCTAssertEqual(rows(list).map(\.showsDivider), [true, true, true, false])
        XCTAssertEqual(list.visibleCount, 4)
        XCTAssertFalse(list.hasArchived)
    }

    func testSideChatsAreNeverListed() {
        let list = list([record("main"), record("side", ["isSideChat": .bool(true)])])
        XCTAssertEqual(list.items.compactMap(\.sessionId), ["main"])
    }

    func testTheArchiveIsHiddenBehindTheToggleByDefault() {
        let list = list([record("live"), record("gone", active: false)])
        XCTAssertEqual(list.items, [list.items[0], .archiveToggle(hidden: true)])
        XCTAssertEqual(list.visibleCount, 1)
        XCTAssertTrue(list.hasArchived)
    }

    func testAShownArchiveIsGroupedByDayAndOnlyItsLastRowDropsTheDivider() {
        let list = list([
            record("live"),
            record("today", active: false, at: ago(hours: 2)),
            record("yesterday", active: false, at: ago(hours: 14)),
            record("yesterday-2", active: false, at: ago(hours: 20)),
            record("old", active: false, at: ago(hours: 24 * 5)),
            record("lifecycle", at: ago(hours: 3), ["lifecycleState": .string("archived")]),
        ], settings: ["hideInactiveSessions": .bool(false)])
        let shape: [String] = list.items.map {
            switch $0 {
            case .session(let row): row.id + (row.showsDivider ? "" : " (last)")
            case .archiveToggle(let hidden): hidden ? "show" : "hide"
            case .dayHeader(let age): "\(age)"
            }
        }
        XCTAssertEqual(shape, [
            "live (last)", "hide",
            "today", "today", "lifecycle",
            "yesterday", "yesterday", "yesterday-2",
            "daysAgo(5)", "old (last)",
        ])
        XCTAssertEqual(list.visibleCount, 6)
        XCTAssertTrue(rows(list).dropFirst().allSatisfy { $0.archived && $0.faded })
    }

    func testAnArchiveInFlightLeavesTheLiveList() {
        var archiving = record("s")
        archiving.archiving = true
        XCTAssertEqual(list([archiving]).items, [.archiveToggle(hidden: true)])
    }

    // MARK: Corner and state

    func testCornerPrecedence() {
        let permission: JSONValue = .object(["requests": .object(["r1": .object(["tool": .string("Bash")])])])
        var thinking = record("thinking")
        thinking.thinking = true
        var unread = record("unread")
        unread.unread = true
        var unreadThinking = record("unread-thinking")
        unreadThinking.unread = true
        unreadThinking.thinking = true
        let question: JSONValue = .object(["communications": .object(["c1": .object(["kind": .string("question")])])])
        let byId = Dictionary(uniqueKeysWithValues: rows(list([
            record("permission", agentState: permission),
            record("question", agentState: question),
            thinking,
            unread,
            unreadThinking,
            record("idle"),
            record("offline-permission", ["machineId": .string("m")], agentState: permission),
        ], machines: [machine("m", active: false)])).map { ($0.id, $0) })

        XCTAssertEqual(byId["permission"]?.corner, .blockedDot)
        XCTAssertEqual(byId["permission"]?.state, .permissionRequired)
        XCTAssertEqual(byId["question"]?.corner, .blockedDot)
        XCTAssertEqual(byId["question"]?.state, .inputRequired)
        XCTAssertEqual(byId["thinking"]?.corner, .timestamp)
        XCTAssertEqual(byId["thinking"]?.shimmersTitle, true)
        XCTAssertEqual(byId["unread"]?.corner, .unreadDot)
        XCTAssertEqual(byId["unread-thinking"]?.corner, .timestamp, "working beats unread")
        XCTAssertEqual(byId["idle"]?.corner, .timestamp)
        XCTAssertEqual(byId["idle"]?.state, .waiting)
        XCTAssertEqual(byId["offline-permission"]?.faded, true, "its computer is offline")
        XCTAssertEqual(byId["offline-permission"]?.corner, .timestamp, "faded rows only show the time")
    }

    func testAnsweredCommunicationsAndFormsWithoutAnswersDoNotBlock() {
        let answered: JSONValue = .object([
            "communications": .object(["c1": .object(["kind": .string("question")])]),
            "completedCommunications": .object(["c1": .object([:])]),
        ])
        let dead: JSONValue = .object(["communications": .object(["c1": .object([
            "kind": .string("form"),
            "form": .object(["questions": .array([.object(["options": .array([]), "allowCustom": .bool(false)])])]),
        ])])])
        XCTAssertFalse(record("a", agentState: answered).hasPendingCommunications)
        XCTAssertFalse(record("b", agentState: dead).hasPendingCommunications)
    }

    func testInactiveIsDisconnected() {
        XCTAssertEqual(SessionState(record("s", active: false)), .disconnected)
    }

    // MARK: Text

    func testTitleIsTheBotNameThenTheSummaryElseNewChat() {
        XCTAssertEqual(record("a", ["bot": .object(["name": .string("Ops")]), "summary": .object(["text": .string("x")])]).title, "Ops")
        XCTAssertEqual(record("b", ["summary": .object(["text": .string("Fix the build")])]).title, "Fix the build")
        XCTAssertNil(record("c").title)
    }

    func testPlaceNamesTheProjectAndTheWorktree() {
        let project = ProjectRecord(
            id: "p1", externalId: "x", createdAt: 1, updatedAt: 1, metadataVersion: 1, metadataCipher: "c",
            metadata: .object(["name": .string("Linked")]), dataKeyCipher: nil
        )
        let byId = Dictionary(uniqueKeysWithValues: rows(list([
            record("plain", ["path": .string("/Users/me/src/happy")]),
            record("worktree", ["path": .string("/Users/me/src/happy/.dev/worktree/fix-login")]),
            record("named", ["path": .string("/x/y"), "project": .object(["name": .string("Named")]), "workspace": .object(["name": .string("ws")])]),
            record("linked", ["path": .string("/x/y")], projectId: "p1"),
            record("bot", ["bot": .object(["username": .string("ops"), "name": .string("Ops")]), "path": .string("/x")]),
        ], projects: [project])).map { ($0.id, $0) })

        XCTAssertEqual(byId["plain"]?.projectName, "happy")
        XCTAssertNil(byId["plain"]?.workspaceName)
        XCTAssertEqual(byId["worktree"]?.projectName, "happy")
        XCTAssertEqual(byId["worktree"]?.workspaceName, "fix-login")
        XCTAssertEqual(byId["named"]?.projectName, "Named")
        XCTAssertEqual(byId["named"]?.workspaceName, "ws")
        XCTAssertEqual(byId["linked"]?.projectName, "Linked")
        XCTAssertEqual(byId["bot"]?.projectName, "@ops")
        XCTAssertEqual(byId["bot"]?.isBot, true)
    }

    func testTimestampsByAge() {
        let formatter = SessionTimestampFormatter(clock: clock)
        XCTAssertEqual(formatter.timestamp(ago(hours: 0.5)), "11:30")
        XCTAssertEqual(formatter.timestamp(ago(hours: 30)), "Mon")
        XCTAssertEqual(formatter.timestamp(ago(hours: 24 * 20)), "09/23")
        XCTAssertEqual(formatter.timestamp(ago(hours: 24 * 300)), "12/17/25")
    }

    func testDayAgeCountsCalendarDays() {
        let formatter = SessionTimestampFormatter(clock: clock)
        let today = calendar.startOfDay(for: now)
        XCTAssertEqual(formatter.dayAge(today), .today)
        XCTAssertEqual(formatter.dayAge(today.addingTimeInterval(-86_400)), .yesterday)
        XCTAssertEqual(formatter.dayAge(today.addingTimeInterval(-3 * 86_400)), .daysAgo(3))
    }

    // MARK: Line changes

    private func git(_ insertions: Double, _ deletions: Double, exact: Bool = true) -> JSONValue {
        .object([
            "changedFiles": .number(2), "countsExact": .bool(exact),
            "insertions": .number(insertions), "deletions": .number(deletions),
        ])
    }

    private let rig: JSONValue = .object(["id": .string("rig")])

    /// FlatSessionRow.tsx draws RigGitLineChanges from rig.ts
    /// `getRigGitSummary` and `visibleRigGitLineChanges`: Happy Agent's own
    /// counts, nothing for a clean comparison, nothing from any other
    /// agent's metadata.
    func testARowCarriesHappyAgentsLineChanges() {
        let rows = rows(list([
            record("approximate", at: ago(hours: 1), ["client": rig, "git": git(1234, 7, exact: false)]),
            record("removed", at: ago(hours: 2), ["client": rig, "git": git(0, 3)]),
            record("clean", at: ago(hours: 3), ["client": rig, "git": git(0, 0)]),
            record("unknown", at: ago(hours: 4), ["client": rig]),
            record("happy", at: ago(hours: 5), ["git": git(5, 5)]),
        ]))
        XCTAssertEqual(rows.map(\.id), ["approximate", "removed", "clean", "unknown", "happy"])
        XCTAssertEqual(rows.map(\.changes), [
            GitLineChanges(approximate: true, insertions: 1234, deletions: 7),
            GitLineChanges(approximate: false, insertions: 0, deletions: 3),
            nil,
            nil,
            nil,
        ])
    }

    /// The flat list draws every row with FlatSessionRow, so a bot's and an
    /// archived session's counts show as a live one's do.
    func testBotsAndTheArchiveKeepTheirLineChanges() {
        let byId = Dictionary(uniqueKeysWithValues: rows(list([
            record("bot", ["client": rig, "bot": .object(["username": .string("ops")]), "git": git(4, 0)]),
            record("retired", ["client": rig, "lifecycleState": .string("archived"), "git": git(0, 9)]),
        ], settings: ["hideInactiveSessions": .bool(false)])).map { ($0.id, $0) })
        XCTAssertEqual(byId["bot"]?.changes, GitLineChanges(approximate: false, insertions: 4, deletions: 0))
        XCTAssertEqual(byId["retired"]?.archived, true)
        XCTAssertEqual(byId["retired"]?.changes, GitLineChanges(approximate: false, insertions: 0, deletions: 9))
    }

    // MARK: Avatar

    func testAvatarSeedIsMachineAndPathOrTheBot() {
        XCTAssertEqual(record("s", ["machineId": .string("m1"), "path": .string("/Users/steve/happy")]).avatarSeed, "m1:/Users/steve/happy")
        XCTAssertEqual(record("s", ["machineId": .string("m1"), "bot": .object(["id": .string("b1")])]).avatarSeed, "m1:bot:b1")
        XCTAssertEqual(record("s", ["bot": .object(["id": .string("b1")])]).avatarSeed, ":bot:b1")
        XCTAssertEqual(record("s").avatarSeed, "s")
    }

    func testHarnessBadgeOnlyWhenAskedAndHappyAgentWins() {
        let sessions = [
            record("claude", ["flavor": .string("claude")]),
            record("rig", ["flavor": .string("codex"), "client": .object(["id": .string("rig")])]),
            record("gemini", ["flavor": .string("gemini")]),
        ]
        XCTAssertEqual(rows(list(sessions)).map(\.avatar.harness), [nil, nil, nil])
        let shown = Dictionary(uniqueKeysWithValues: rows(list(sessions, settings: ["showFlavorIcons": .bool(true)])).map { ($0.id, $0.avatar.harness) })
        XCTAssertEqual(shown["claude"], .claude)
        XCTAssertEqual(shown["rig"], .rig)
        XCTAssertEqual(shown["gemini"], .some(nil), "retired harnesses get no badge")
    }
}
