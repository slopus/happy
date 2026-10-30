import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

/// Tasks: Happy Agent's bot-like conversations for one piece of work
/// (`metadata.task`), listed under each computer's bots, opened as chats,
/// left by anyone in them, archived only by their owner, never deleted.
final class TasksHomeTests: XCTestCase {
    typealias Fixture = TabletGroupedListTests

    static func task(
        _ id: String,
        taskId: String,
        name: String = "Fix login redirect",
        folder: String? = "fix_login_redirect",
        orderKey: String? = nil,
        machine: String? = "m1",
        createdAt: Int64 = Fixture.now - Fixture.minute,
        archived: Bool = false,
        canArchive: Bool? = nil,
        rpcMethods: [String]? = nil,
        extra: [String: JSONValue] = [:]
    ) -> SessionRecord {
        var task: [String: JSONValue] = ["id": .string(taskId), "name": .string(name)]
        if let folder { task["folderName"] = .string(folder) }
        if let orderKey { task["orderKey"] = .string(orderKey) }
        if let canArchive { task["canArchive"] = .bool(canArchive) }
        var metadata: [String: JSONValue] = [
            "task": .object(task),
            "client": .object(["id": .string("rig")]),
            // The daemon names the session after its task, as it does a bot.
            "summary": .object(["text": .string("summary of \(name)")]),
        ]
        if archived { metadata["lifecycleState"] = .string("archived") }
        if let rpcMethods { metadata["capabilities"] = .object(["rpcMethods": .array(rpcMethods.map(JSONValue.string))]) }
        metadata.merge(extra) { _, new in new }
        var record = Fixture.session(id, machine: machine, path: folder.map { "/work/Happy/Tasks/\($0)" }, at: createdAt, metadata: metadata)
        record.createdAt = createdAt
        return record
    }

    static let bot: [String: JSONValue] = ["bot": .object([
        "id": .string("bot1"), "name": .string("Helper"), "username": .string("helper"), "orderKey": .string("a"),
    ])]

    static func snapshot(_ sessions: [SessionRecord], grouping: String = "project") -> LegacyHomeSnapshot {
        LegacyHomeSnapshot(
            machines: MachinesSnapshot(synced: true, machines: [Fixture.machine("m1", active: true, name: "Studio")]),
            sessions: sessions,
            settings: SettingsSnapshot(pending: [
                "sessionListGrouping": .string(grouping),
                "hideInactiveSessions": .bool(false),
            ]),
            sessionsSynced: true
        )
    }

    static func home(_ sessions: [SessionRecord]) -> ProjectHomeData {
        ProjectHomeData(snapshot(sessions), clock: ApplyPerfFixtures.clock)
    }

    static func shape(_ rows: [ProjectHomeRow]) -> [String] {
        rows.map { row in
            switch row {
            case .machine(_, let name): "machine:\(name)"
            case .section(_, let label): "section:\(label)"
            case .bot(let row): "bot:\(row.id)"
            case .task(let row): "task:\(row.id)"
            case .project(let entry): "project:\(entry.name)"
            case .worktree(let worktree, _): "worktree:\(worktree.title)"
            case .worktreeToggle: "toggle"
            case .archiveToggle(let hidden): hidden ? "archive:show" : "archive:hide"
            case .archiveHeader(let age): "archiveHeader:\(age)"
            case .archived(let row): "archived:\(row.id)"
            }
        }
    }

    // MARK: What a task is

    func testATaskIsNamedByItsMetadata() {
        XCTAssertTrue(Self.task("t1", taskId: "task1").isTask)
        XCTAssertFalse(Self.task("t1", taskId: "task1").isBot)
        XCTAssertFalse(Fixture.session("s1", machine: "m1", path: "/work/happy").isTask)
        XCTAssertFalse(Fixture.session("s1", machine: "m1", path: "/work/happy", metadata: ["task": .null]).isTask)
        XCTAssertFalse(Fixture.session("s1", machine: "m1", path: "/work/happy", metadata: ["task": .string("task1")]).isTask, "not an object, not a task")
        XCTAssertFalse(Fixture.session("s1", machine: "m1", path: "/work/happy", metadata: ["task": .array([])]).isTask)
        // A session naming both is a bot: bots came first and their rules win.
        let both = Self.task("t1", taskId: "task1", extra: Self.bot)
        XCTAssertTrue(both.isBot)
        XCTAssertFalse(both.isTask)
    }

    func testARowShowsTheTaskNameItsFolderAndAGlyphForAFace() {
        var record = Self.task("t1", taskId: "task1", name: "Ship the launch", folder: "ship_the_launch")
        // Even a picture on the session (an owner's photo) is not drawn.
        record.avatar = AvatarDescriptor(ref: "owner-photo", preview: "p", version: 1)
        XCTAssertEqual(record.title, "Ship the launch", "the task's own name, over the summary")
        XCTAssertEqual(record.avatarSeed, "m1:task:task1", "the row's identity follows the task, not its folder or session")
        let row = SessionList.row(
            record, archived: false, showsDivider: false, machines: [:], projects: [:],
            showFlavorIcons: false, formatter: SessionTimestampFormatter(clock: ApplyPerfFixtures.clock)
        )
        XCTAssertEqual(row.projectName, "~/Tasks/ship_the_launch")
        XCTAssertNil(row.workspaceName)
        XCTAssertFalse(row.isBot, "a task has no bot face")
        XCTAssertFalse(row.avatar.isBot)
        XCTAssertTrue(row.avatar.isTask, "drawn as the checkbox glyph, not a generated face")
        XCTAssertNil(row.avatar.image, "no photo")
        XCTAssertNil(AvatarImageSource.resolve(record, project: nil), "the chat's header has no photo either")
        XCTAssertFalse(SessionAvatar(seed: "x", isBot: true, isTask: true).isTask, "a bot keeps its own face")
    }

    func testATaskWithoutAFolderStillReadsAsATask() {
        let record = Self.task("t1", taskId: "task1", folder: nil)
        let row = SessionList.row(
            record, archived: false, showsDivider: false, machines: [:], projects: [:],
            showFlavorIcons: false, formatter: SessionTimestampFormatter(clock: ApplyPerfFixtures.clock)
        )
        XCTAssertEqual(row.projectName, "~/Tasks")
    }

    // MARK: Home's project list

    func testTasksSitUnderTheBotsBeforeTheProjects() {
        let home = Self.home([
            Fixture.session("b1", machine: "m1", path: "/work/helper", metadata: Self.bot),
            Self.task("t1", taskId: "task1"),
            Fixture.session("s1", machine: "m1", path: "/work/happy", title: "Primary"),
        ])
        XCTAssertEqual(Self.shape(home.rows(expanded: [])), [
            "machine:Studio",
            "section:bots", "bot:b1",
            "section:tasks", "task:t1",
            "section:projects", "project:happy",
        ])
        guard case .task(let row) = home.rows(expanded: [])[4] else { return XCTFail("no task row") }
        XCTAssertEqual(row.title, "Fix login redirect")
        XCTAssertEqual(HomeListRow.project(.task(row)).sessionId, "t1", "a tap opens the task's chat")
    }

    func testAComputerWithOnlyTasksStillGetsItsSection() {
        let home = Self.home([Self.task("t1", taskId: "task1")])
        XCTAssertEqual(Self.shape(home.rows(expanded: [])), ["machine:Studio", "section:tasks", "task:t1"])
    }

    /// Keys are decimal fractions compared as strings, as Happy Desktop
    /// does: "45" sorts before "5". Equal keys fall back to the session id.
    func testOrderKeysCompareAsStrings() {
        let home = Self.home([
            Self.task("five", taskId: "a", orderKey: "5"),
            Self.task("forty-five", taskId: "b", orderKey: "45"),
            Self.task("tie-b", taskId: "c", orderKey: "7"),
            Self.task("tie-a", taskId: "d", orderKey: "7"),
            Self.task("fraction", taskId: "e", orderKey: "4.5"),
        ])
        XCTAssertEqual(Self.shape(home.rows(expanded: [])), [
            "machine:Studio", "section:tasks",
            "task:fraction", "task:forty-five", "task:five", "task:tie-a", "task:tie-b",
        ])
        let sidebar = Fixture.list(Self.snapshot([
            Self.task("five", taskId: "a", orderKey: "5"),
            Self.task("forty-five", taskId: "b", orderKey: "45"),
        ]))
        XCTAssertEqual(Array(sidebar.ids.prefix(3)), [.tasksHeader, .task("forty-five"), .task("five")])
    }

    func testTasksFollowThePersonsOwnOrderThenTheNewest() {
        let home = Self.home([
            Self.task("old", taskId: "a", createdAt: Fixture.now - 3 * Fixture.hour),
            Self.task("second", taskId: "b", orderKey: "5"),
            Self.task("new", taskId: "c", createdAt: Fixture.now - Fixture.minute),
            Self.task("first", taskId: "d", orderKey: "3"),
        ])
        XCTAssertEqual(Self.shape(home.rows(expanded: [])), [
            "machine:Studio", "section:tasks",
            // Joined tasks in their member order, then the rest newest first.
            "task:first", "task:second", "task:new", "task:old",
        ])
    }

    /// An archived task (archived by its owner, or left: its machine
    /// archives a left task for the one who left) goes from every list and
    /// never into the archive, where it could be resumed or deleted. It may
    /// still run for the rest of its members.
    func testARetiredTaskLeavesEveryListAndSkipsTheArchive() {
        var leaving = Self.task("leaving", taskId: "c")
        leaving.archiving = true
        let sessions = [
            Self.task("live", taskId: "a"),
            Self.task("done", taskId: "b", archived: true),
            leaving,
        ]
        let home = Self.home(sessions)
        XCTAssertEqual(Self.shape(home.rows(expanded: [])), ["machine:Studio", "section:tasks", "task:live"])
        XCTAssertFalse(home.hasArchived)

        let flat = SessionList(Self.snapshot(sessions, grouping: "flat"), clock: ApplyPerfFixtures.clock)
        XCTAssertEqual(flat.items.compactMap(\.sessionId), ["live"])
        XCTAssertFalse(flat.hasArchived)

        let sidebar = Fixture.list(Self.snapshot(sessions))
        XCTAssertEqual(sidebar.ids, [.tasksHeader, .task("live")])
    }


    func testATaskIsNeverAProjectOrAPlaceToStartIn() {
        let task = Self.task("t1", taskId: "task1")
        let home = Self.home([task])
        XCTAssertFalse(Self.shape(home.rows(expanded: [])).contains { $0.hasPrefix("project:") })
        let places = SessionPlaces.collect(machineIds: ["m1"], sessions: [task])
        XCTAssertFalse(places.contains { $0.path == "/work/Happy/Tasks/fix_login_redirect" })
    }

    // MARK: Changesets

    /// One task starting to think reconfigures its row alone; the line
    /// counts it never draws reconfigure nothing.
    func testOneTasksChangeReconfiguresExactlyItsRow() throws {
        var snapshot = Self.snapshot([
            Fixture.session("b1", machine: "m1", path: "/work/helper", metadata: Self.bot),
            Self.task("t1", taskId: "a", orderKey: "1"),
            Self.task("t2", taskId: "b", orderKey: "2"),
            Fixture.session("s1", machine: "m1", path: "/work/happy", title: "Primary"),
        ])
        let applied = try XCTUnwrap(ApplyPerfHomeTests.listOnly(snapshot, after: nil)).state
        let rows = try XCTUnwrap(applied.content?.list?.rows)
        let index = try XCTUnwrap(rows.firstIndex { $0.sessionId == "t2" })

        snapshot.sessions[2].thinking = true
        let update = try XCTUnwrap(ApplyPerfHomeTests.listOnly(snapshot, after: applied))
        XCTAssertEqual(update.output.changeset, RowChangeset(reconfigures: [index]))
        XCTAssertFalse(update.output.kindChanged)

        snapshot.sessions[2] = ApplyPerfHomeTests.withLineChanges(snapshot.sessions[2], insertions: 30)
        XCTAssertNil(ApplyPerfHomeTests.listOnly(snapshot, after: update.state), "a task's row draws no line counts")
    }

    func testANewTaskIsOneInsert() throws {
        var snapshot = Self.snapshot([
            Self.task("t1", taskId: "a", orderKey: "2"),
            Fixture.session("s1", machine: "m1", path: "/work/happy", title: "Primary"),
        ])
        let applied = try XCTUnwrap(ApplyPerfHomeTests.listOnly(snapshot, after: nil)).state
        snapshot.sessions.append(Self.task("t0", taskId: "z", orderKey: "1"))
        let update = try XCTUnwrap(ApplyPerfHomeTests.listOnly(snapshot, after: applied))
        XCTAssertEqual(update.output.changeset.inserts, [2], "joined at the top of the tasks")
        XCTAssertEqual(update.output.changeset.deletes, [])
        XCTAssertEqual(update.output.changeset.reconfigures, [])
    }

    // MARK: Tablet sidebar

    func testTheSidebarListsTasksUnderTheBots() {
        let list = Fixture.list(Self.snapshot([
            Fixture.session("b1", machine: "m1", path: "/work/helper", metadata: Self.bot),
            Self.task("t1", taskId: "a", orderKey: "1"),
            Self.task("t2", taskId: "b", orderKey: "2"),
            Fixture.session("s1", machine: "m1", path: "/work/happy", title: "Primary"),
        ]))
        XCTAssertEqual(Array(list.ids.prefix(6)), [.botsHeader, .bot("b1"), .tasksHeader, .task("t1"), .task("t2"), .machine("m1")])
        guard case .task(let first) = list.rows[3], case .task(let last) = list.rows[4] else { return XCTFail("\(list.rows)") }
        XCTAssertTrue(first.showsDivider)
        XCTAssertFalse(last.showsDivider, "the last task keeps no hairline, as the last bot")
        XCTAssertEqual(list.rows[3].sessionId, "t1")
    }

    // MARK: Leave, archive, never delete

    func testOnlyATasksMachineArchivesIt() {
        XCTAssertEqual(SessionActions.needsMachine(Self.task("t1", taskId: "a")), .taskNeedsMachine)
        XCTAssertEqual(SessionActions.needsMachine(Fixture.session("b1", machine: "m1", path: "/w", metadata: Self.bot)), .botNeedsMachine)
        XCTAssertNil(SessionActions.needsMachine(Fixture.session("s1", machine: "m1", path: "/w")))
    }

    static func info(_ session: SessionRecord) -> SessionInfoModel {
        SessionInfoModel(session: session, machine: nil, settings: AccountSettings(SettingsSnapshot()), gitStatus: nil, permissionMode: nil)
    }

    static func menu(_ session: SessionRecord) -> [SessionQuickActions.Item] {
        SessionQuickActions(session: session, machine: nil, settings: AccountSettings(SettingsSnapshot()), devModeEnabled: false).items
    }

    func testSessionInfoOffersNoDeleteForATask() {
        let model = Self.info(Self.task("t1", taskId: "a"))
        XCTAssertTrue(model.isTask)
        XCTAssertFalse(model.isBot)
        XCTAssertTrue(model.keepsConversation)
    }

    /// Archive is offered only where the task says this person may; a
    /// daemon that doesn't say means no. Leave only where the machine takes
    /// `leaveTask`.
    func testEachActionFollowsWhatTheTaskAllows() {
        let silent = Self.task("t1", taskId: "a")
        XCTAssertFalse(silent.taskCanArchive)
        XCTAssertFalse(silent.canLeaveTask)
        XCTAssertFalse(Self.info(silent).canArchive)
        XCTAssertFalse(Self.info(silent).canLeaveTask)
        XCTAssertFalse(Self.menu(silent).contains(.archive))
        XCTAssertFalse(Self.menu(silent).contains(.leaveTask))

        let member = Self.task("t1", taskId: "a", canArchive: false, rpcMethods: ["killSession", "leaveTask"])
        XCTAssertFalse(Self.info(member).canArchive)
        XCTAssertTrue(Self.info(member).canLeaveTask)
        XCTAssertEqual(Self.menu(member).filter { $0 == .archive || $0 == .leaveTask }, [.leaveTask])

        let owner = Self.task("t1", taskId: "a", canArchive: true, rpcMethods: ["killSession", "leaveTask"])
        XCTAssertTrue(Self.info(owner).canArchive)
        XCTAssertTrue(Self.info(owner).canLeaveTask)
        XCTAssertEqual(Self.menu(owner).filter { $0 == .archive || $0 == .leaveTask }, [.leaveTask, .archive])
        // The rows' swipe leaves only where the machine takes it.
        func swipeLeaves(_ session: SessionRecord) -> Bool {
            SessionList.row(
                session, archived: false, showsDivider: false, machines: [:], projects: [:],
                showFlavorIcons: false, formatter: SessionTimestampFormatter(clock: ApplyPerfFixtures.clock)
            ).leaves
        }
        XCTAssertFalse(swipeLeaves(silent))
        XCTAssertTrue(swipeLeaves(member))

        // `canArchive` must be a real true, and `leaveTask` a listed method.
        let loose = Self.task("t1", taskId: "a", extra: [
            "task": .object(["id": .string("a"), "canArchive": .string("true")]),
            "capabilities": .object(["rpcMethods": .string("leaveTask")]),
        ])
        XCTAssertFalse(loose.taskCanArchive)
        XCTAssertFalse(loose.canLeaveTask)

        // Not a task: leave never shows, archive always does.
        let plain = Fixture.session("s1", machine: "m1", path: "/w", metadata: ["capabilities": .object(["rpcMethods": .array([.string("leaveTask")])])])
        XCTAssertFalse(plain.canLeaveTask)
        XCTAssertTrue(Self.info(plain).canArchive)
        XCTAssertFalse(Self.info(plain).canLeaveTask)
        XCTAssertEqual(Self.menu(plain).filter { $0 == .archive || $0 == .leaveTask }, [.archive])
    }

    /// Two tasks share no checkout, so a task's chat has no worktree tabs,
    /// as a bot's has none.
    func testATaskHasNoWorktreeTabs() {
        let snapshot = Self.snapshot([
            Self.task("t1", taskId: "a", folder: "same"),
            Self.task("t2", taskId: "b", folder: "same"),
        ])
        XCTAssertNil(WorktreeCheckout.locate("t1", in: snapshot))
    }
}
