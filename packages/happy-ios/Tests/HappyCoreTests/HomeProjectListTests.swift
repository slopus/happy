import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

/// Cases after happy-app's utils/projectHomeList.test.ts and
/// sync/projectGroups.spec.ts, built from stored records.
final class HomeProjectListTests: XCTestCase {
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    private lazy var now = calendar.date(from: DateComponents(year: 2026, month: 10, day: 13, hour: 12))!
    private lazy var clock = SessionList.Clock(now: now, calendar: calendar, locale: Locale(identifier: "en_GB"))

    private func ago(hours: Double) -> Int64 {
        Int64((now.timeIntervalSince1970 - hours * 3600) * 1000)
    }

    private func record(
        _ id: String,
        machine: String? = "m1",
        path: String? = nil,
        active: Bool = true,
        at activity: Int64? = nil,
        rig: Bool = false,
        project: (id: String, name: String)? = nil,
        workspace: (id: String, name: String)? = nil,
        extra: [String: JSONValue] = [:],
        unread: Bool = false
    ) -> SessionRecord {
        var metadata = extra
        metadata["lastMeaningfulMessageAt"] = .number(Double(activity ?? ago(hours: 1)))
        if let machine { metadata["machineId"] = .string(machine) }
        if let path { metadata["path"] = .string(path) }
        if rig { metadata["client"] = .object(["id": .string("rig")]) }
        if let project { metadata["project"] = .object(["id": .string(project.id), "name": .string(project.name)]) }
        if let workspace { metadata["workspace"] = .object(["id": .string(workspace.id), "name": .string(workspace.name)]) }
        var record = SessionRecord(
            id: id, seq: 0, createdAt: 1, updatedAt: 1, active: active, activeAt: 1,
            projectId: nil, metadataVersion: 1, metadataCipher: "c", metadata: .object(metadata),
            agentStateVersion: 0, agentStateCipher: nil, agentState: nil,
            dataKeyCipher: "k", decryptable: true
        )
        record.unread = unread
        return record
    }

    private func machine(_ id: String, name: String, rig: Bool = false, active: Bool = true) -> MachineRecord {
        var metadata: [String: JSONValue] = ["displayName": .string(name)]
        if rig { metadata["machineKind"] = .string("rig") }
        return MachineRecord(
            id: id, seq: 0, createdAt: 1, updatedAt: 1, active: active, activeAt: 1,
            metadataVersion: 1, metadataCipher: "c", metadata: .object(metadata),
            daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil, dataKeyCipher: "k", decryptable: true
        )
    }

    private func data(
        _ sessions: [SessionRecord],
        machines: [MachineRecord] = [],
        settings: [String: JSONValue] = [:]
    ) -> ProjectHomeData {
        ProjectHomeData(
            HomeSnapshot(
                machines: MachinesSnapshot(synced: true, machines: machines),
                sessions: sessions,
                projects: [],
                settings: SettingsSnapshot(pending: settings)
            ),
            clock: clock
        )
    }

    private func shape(_ rows: [ProjectHomeRow]) -> [String] {
        rows.map { row in
            switch row {
            case .machine(_, let name): "machine:\(name)"
            case .section(_, let label): "section:\(label)"
            case .bot(let row): "bot:\(row.id)"
            case .project(let entry): "project:\(entry.name)(\(entry.worktreeCount))"
            case .worktree(let worktree, let last): "worktree:\(worktree.title)\(last ? ":last" : "")"
            case .worktreeToggle(let toggle): toggle.expanded ? "toggle:less" : "toggle:+\(toggle.hiddenCount)"
            case .archiveToggle(let hidden): hidden ? "archive:show" : "archive:hide"
            case .archiveHeader(let age): "archiveHeader:\(age)"
            case .archived(let row): "archived:\(row.id)"
            }
        }
    }

    func testTheProjectIsItsOwnCardWithItsWorktreesUnderIt() {
        let home = data([
            record("own", path: "/src/happy"),
            record("wt", path: "/src/happy/.dev/worktree/gdansk", at: ago(hours: 0.5)),
        ], machines: [machine("m1", name: "Studio")])
        XCTAssertEqual(shape(home.rows(expanded: [])), [
            "machine:Studio",
            "section:projects",
            "project:happy(1)",
            "worktree:gdansk:last",
        ])
        guard case .project(let card) = home.rows(expanded: [])[2] else { return XCTFail("no card") }
        XCTAssertEqual(card.sessionId, "own", "the card opens its own checkout, even when a worktree is newer")
        XCTAssertEqual(card.origin?.path, "/src/happy")
        XCTAssertEqual(card.origin?.machineId, "m1")
    }

    func testOnlyThreeWorktreesShowUntilTheProjectIsExpanded() {
        var sessions = [record("own", path: "/src/app")]
        for index in 1...5 {
            sessions.append(record("w\(index)", path: "/src/app/.dev/worktree/w\(index)", at: ago(hours: Double(index))))
        }
        let home = data(sessions, machines: [machine("m1", name: "Studio")])
        XCTAssertEqual(shape(home.rows(expanded: [])), [
            "machine:Studio", "section:projects", "project:app(5)",
            "worktree:w1", "worktree:w2", "worktree:w3", "toggle:+2",
        ])
        let projectId = home.sections[0].projects[0].id
        XCTAssertEqual(shape(home.rows(expanded: [projectId])).suffix(6), [
            "worktree:w1", "worktree:w2", "worktree:w3", "worktree:w4", "worktree:w5", "toggle:less",
        ])
    }

    func testExactlyThreeWorktreesNeedNoToggle() {
        var sessions = [record("own", path: "/src/app")]
        for index in 1...3 {
            sessions.append(record("w\(index)", path: "/src/app/.dev/worktree/w\(index)", at: ago(hours: Double(index))))
        }
        let home = data(sessions)
        XCTAssertEqual(shape(home.rows(expanded: [])).suffix(3), ["worktree:w1", "worktree:w2", "worktree:w3:last"])
    }

    func testTheToggleSpeaksForWhatItHides() {
        var sessions = [record("own", path: "/src/app")]
        for index in 1...4 {
            sessions.append(record("w\(index)", path: "/src/app/.dev/worktree/w\(index)", at: ago(hours: Double(index)), unread: index == 4))
        }
        let rows = data(sessions).rows(expanded: [])
        guard case .worktreeToggle(let toggle)? = rows.last else { return XCTFail("no toggle") }
        XCTAssertTrue(toggle.activity.unread)
        XCTAssertEqual(toggle.worktreeCount, 4)
    }

    func testHappyAgentMachinesLeadThenCLIThenUnknown() {
        let home = data([
            record("cli", machine: "cli", path: "/a/one", at: ago(hours: 1)),
            record("agent", machine: "agent", path: "/b/two", at: ago(hours: 5), rig: true, project: ("p1", "two")),
            record("nowhere", machine: nil, path: "/c/three", at: ago(hours: 0.1)),
        ], machines: [machine("cli", name: "Terminal"), machine("agent", name: "Studio", rig: true)])
        XCTAssertEqual(home.sections.map(\.name), ["Studio", "Terminal", "<unknown>"])
    }

    func testProjectsSortByNameUnderTheirComputer() {
        let home = data([
            record("z", path: "/src/zeta", at: ago(hours: 0.1)),
            record("a", path: "/src/Alpha", at: ago(hours: 3)),
            record("b", path: "/src/beta", at: ago(hours: 2)),
        ])
        XCTAssertEqual(home.sections[0].projects.map(\.name), ["Alpha", "beta", "zeta"])
    }

    func testBotsComeBeforeProjectsUnderTheirComputer() {
        let home = data([
            record("bot", extra: ["bot": .object(["id": .string("b"), "name": .string("Helper"), "orderKey": .string("a")])]),
            record("chat", path: "/src/app"),
        ], machines: [machine("m1", name: "Studio")])
        XCTAssertEqual(shape(home.rows(expanded: [])), [
            "machine:Studio", "section:bots", "bot:bot", "section:projects", "project:app(0)",
        ])
    }

    func testCatalogProjectsGroupByIdentityAndWorkspace() {
        let home = data([
            record("main", rig: true, project: ("p", "Shop")),
            record("feature", at: ago(hours: 0.2), rig: true, project: ("p", "Shop"), workspace: ("w1", "checkout")),
        ])
        let project = home.sections[0].projects[0]
        XCTAssertEqual(project.id, "p")
        XCTAssertEqual(project.checkouts.map(\.id), ["", "w1"], "the primary checkout leads")
        guard case .project(let card) = home.rows(expanded: [])[2] else { return XCTFail("no card") }
        XCTAssertEqual(card.origin?.projectId, "p")
        XCTAssertNil(card.origin?.path)
    }

    func testTheArchiveTrailsAsADayGroupedTail() {
        let sessions = [
            record("live", path: "/src/app"),
            record("old", path: "/src/app", active: false, at: ago(hours: 30)),
        ]
        XCTAssertEqual(shape(data(sessions).rows(expanded: [])).suffix(1), ["archive:show"])
        let shown = data(sessions, settings: ["hideInactiveSessions": .bool(false)])
        XCTAssertEqual(shape(shown.rows(expanded: [])).suffix(3), ["archive:hide", "archiveHeader:yesterday", "archived:old"])
    }

    func testPathProjectNamesFollowProjectGroups() {
        XCTAssertEqual(ProjectHomeData.pathProjectName("/Users/me/", homeDir: "/Users/me"), "Home")
        XCTAssertEqual(ProjectHomeData.pathProjectName("~", homeDir: nil), "Home")
        XCTAssertEqual(ProjectHomeData.pathProjectName("", homeDir: nil), "Home")
        XCTAssertEqual(ProjectHomeData.pathProjectName("/Users/me/src/happy/", homeDir: "/Users/me"), "happy")
        XCTAssertEqual(ProjectHomeData.jsonKey("m1", "/a/b"), #"["m1","/a/b"]"#)
        XCTAssertEqual(ProjectHomeData.jsonKey(nil, "/a"), #"[null,"/a"]"#)
    }

    func testRigLineChangesAndCompactCounts() {
        let home = data([
            record("own", rig: true, project: ("p", "Shop"), extra: ["git": .object([
                "changedFiles": .number(3), "countsExact": .bool(false), "insertions": .number(1234), "deletions": .number(7),
            ])]),
        ])
        guard case .project(let card) = home.rows(expanded: [])[2] else { return XCTFail("no card") }
        XCTAssertEqual(card.changes, GitLineChanges(approximate: true, insertions: 1234, deletions: 7))
        XCTAssertEqual(GitLineChanges.compact(999), "999")
        XCTAssertEqual(GitLineChanges.compact(1234), "1.2k")
        XCTAssertEqual(GitLineChanges.compact(2000), "2k")
        XCTAssertEqual(GitLineChanges.compact(12_400), "12k")
    }

    func testTheGroupingSettingBuildsTheProjectList() {
        let flat = SessionList(HomeSnapshot(machines: MachinesSnapshot(synced: true, machines: []), sessions: [record("a", path: "/x")]), clock: clock)
        XCTAssertNil(flat.projects)
        let grouped = SessionList(HomeSnapshot(
            machines: MachinesSnapshot(synced: true, machines: []),
            sessions: [record("a", path: "/x")],
            projects: [],
            settings: SettingsSnapshot(pending: ["sessionListGrouping": .string("project")])
        ), clock: clock)
        XCTAssertEqual(grouped.grouping, .project)
        XCTAssertNotNil(grouped.projects)
    }

    func testExpandedProjectsPersistAsHappyAppsRecord() {
        let storage = InMemoryKeyValueStore()
        let settings = LocalSettings(storage: storage)
        XCTAssertEqual(settings.expandedProjects, [])
        settings.expandedProjects = ["p1"]
        XCTAssertEqual(storage.string(forKey: "expandedProjects"), #"{"p1":true}"#)
        storage.set(#"{"a":true,"b":false}"#, forKey: "expandedProjects")
        XCTAssertEqual(settings.expandedProjects, ["a"])
        settings.clear()
        XCTAssertEqual(settings.expandedProjects, [])
    }
}

final class SessionQuickActionsTests: XCTestCase {
    private func session(
        active: Bool = false,
        rig: Bool = false,
        flavor: String? = nil,
        machine: String? = "m1",
        path: String? = "/src/app",
        claude: String? = "c-1",
        codex: String? = nil
    ) -> SessionRecord {
        var metadata: [String: JSONValue] = [:]
        if let machine { metadata["machineId"] = .string(machine) }
        if let path { metadata["path"] = .string(path) }
        if let claude { metadata["claudeSessionId"] = .string(claude) }
        if let codex { metadata["codexThreadId"] = .string(codex) }
        if let flavor { metadata["flavor"] = .string(flavor) }
        if rig { metadata["client"] = .object(["id": .string("rig")]) }
        return SessionRecord(
            id: "s1", seq: 0, createdAt: 1, updatedAt: 1, active: active, activeAt: 1,
            projectId: nil, metadataVersion: 1, metadataCipher: "c", metadata: .object(metadata),
            agentStateVersion: 0, agentStateCipher: nil, agentState: nil,
            dataKeyCipher: "k", decryptable: true
        )
    }

    private func machine(active: Bool = true, resume: Bool = true) -> MachineRecord {
        MachineRecord(
            id: "m1", seq: 0, createdAt: 1, updatedAt: 1, active: active, activeAt: 1,
            metadataVersion: 1, metadataCipher: "c",
            metadata: .object(resume ? ["resumeSupport": .object(["rpcAvailable": .bool(true)])] : [:]),
            daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil, dataKeyCipher: "k", decryptable: true
        )
    }

    func testAnOfflineSessionOnAnOnlineMachineOffersEverything() {
        let actions = SessionQuickActions(session: session(), machine: machine(), settings: AccountSettings(), devModeEnabled: false)
        XCTAssertEqual(actions.items, [.details, .resume, .fork, .duplicate, .archive])
        XCTAssertTrue(actions.resume.canResume)
    }

    func testDevModeAddsTheMetadataCopies() {
        let actions = SessionQuickActions(session: session(active: true), machine: machine(), settings: AccountSettings(), devModeEnabled: true)
        XCTAssertEqual(actions.items, [.details, .fork, .duplicate, .copyMetadata, .copyMetadataAndLogs, .archive])
    }

    func testAConnectedSessionHasNothingToResume() {
        let actions = SessionQuickActions(session: session(active: true), machine: machine(), settings: AccountSettings(), devModeEnabled: false)
        XCTAssertFalse(actions.resume.canShowResume)
    }

    func testResumeExplainsWhyItCannotRun() {
        func blocker(_ session: SessionRecord, _ machine: MachineRecord?) -> SessionQuickActions.Resume.Blocker? {
            SessionQuickActions.Resume(session: session, machine: machine).blocker
        }
        XCTAssertEqual(blocker(session(machine: nil), nil), .missingMachine)
        XCTAssertEqual(blocker(session(claude: nil), machine()), .missingBackendId)
        XCTAssertEqual(blocker(session(), nil), .sameMachineOnly)
        XCTAssertEqual(blocker(session(), machine(active: false)), .machineOffline)
        XCTAssertFalse(SessionQuickActions.Resume(session: session(), machine: machine(resume: false)).canShowResume,
                       "older daemons without the RPC hide the item")
        XCTAssertFalse(SessionQuickActions.Resume(session: session(rig: true), machine: machine()).canShowResume)
    }

    func testForkNeedsTheSettingTheSourceAndAnOnlineMachine() {
        let off = AccountSettings(["expResumeSession": .bool(false)])
        XCTAssertFalse(SessionQuickActions(session: session(), machine: machine(), settings: off, devModeEnabled: false).canFork)
        XCTAssertFalse(SessionQuickActions(session: session(), machine: machine(active: false), settings: AccountSettings(), devModeEnabled: false).canFork)
        XCTAssertFalse(SessionQuickActions(session: session(claude: nil), machine: machine(), settings: AccountSettings(), devModeEnabled: false).canFork)
    }

    func testForkSourceFollowsTheFlavor() {
        XCTAssertEqual(
            SessionQuickActions.forkSource(session(flavor: "codex", claude: nil, codex: "t-1")),
            .codex(sessionId: "s1", options: CodexForkThreadOptions(machineId: "m1", directory: "/src/app", codexThreadId: "t-1"))
        )
        XCTAssertEqual(
            SessionQuickActions.forkSource(session()),
            .claude(sessionId: "s1", options: ClaudeForkSessionOptions(machineId: "m1", directory: "/src/app", claudeSessionId: "c-1"))
        )
        XCTAssertNil(SessionQuickActions.forkSource(session(flavor: "codex")))
        XCTAssertNil(SessionQuickActions.forkSource(session(path: "  ")))
    }

    func testMetadataIsCopiedAsIndentedJSON() {
        let text = SessionQuickActions.metadataText(session(machine: "m1", path: "/a", claude: nil))
        XCTAssertEqual(text, "{\n  \"machineId\": \"m1\",\n  \"path\": \"/a\"\n}")
        XCTAssertEqual(
            SessionQuickActions.metadataAndLogsText(session(machine: nil, path: nil, claude: nil)),
            "=== Session Metadata ===\n{}"
        )
    }
}
