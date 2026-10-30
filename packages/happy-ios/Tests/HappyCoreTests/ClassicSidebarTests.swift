import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A computer for the classic sidebar: its bootstrap, the reorder routes
/// desktop's classic sidebar uses, and the Stem Cells setting.
private actor ClassicComputer: AgentTransport {
    static let fixture = #"""
    {"cursor":"cursor-1","profile":{"userId":null},"userSettings":[],
     "projects":[
       {"id":"p1","name":"App","status":"active","orderKey":"a","agents":[{"id":"root","workspaceId":"p1","title":"Root chat","status":"idle"}]},
       {"id":"p2","name":"Docs","status":"active","orderKey":"b","agents":[]}],
     "workspaces":[
       {"id":"w1","projectId":"p1","parentId":"p1","name":"Feature","kind":"worktree","status":"active","orderKey":"a","agents":[]},
       {"id":"w2","projectId":"p1","parentId":"p1","name":"Fix","kind":"worktree","status":"active","orderKey":"b","agents":[]}],
     "bots":[
       {"id":"happy","name":"Happy","systemKey":"chief_of_staff","status":"active","agent":{"id":"happy-agent","workspaceId":"happy-work","status":"idle","subtasks":[
         {"id":"sub1","workspaceId":"happy-work","parentAgentId":"happy-agent","title":"Sub one","status":"idle"},
         {"id":"sub2","workspaceId":"happy-work","parentAgentId":"happy-agent","title":"Sub two","status":"idle"}]}},
       {"id":"research","name":"Research","status":"active","agent":{"id":"research-agent","workspaceId":"research-work","status":"idle"}},
       {"id":"release","name":"Release","status":"active","agent":{"id":"release-agent","workspaceId":"release-work","status":"idle","statusLine":{"text":"Signed and uploaded","updatedAt":1700000000000}}}],
     "tasks":[
       {"id":"t1","name":"One","agent":{"id":"t1-agent","workspaceId":"t1-work","status":"idle"}},
       {"id":"t2","name":"Two","agent":{"id":"t2-agent","workspaceId":"t2-work","status":"idle"}},
       {"id":"t3","name":"Three","agent":{"id":"t3-agent","workspaceId":"t3-work","status":"idle"}}],
     "taskMemberships":[{"taskId":"t3"},{"taskId":"t1"},{"taskId":"t2"}],
     "surfaces":[
       {"id":"todo","name":"Groceries","type":"todo","members":[{"userId":null,"orderKey":"b"}]},
       {"id":"doc","name":"Notes","type":"document","members":[{"userId":null,"orderKey":"a"}]}]}
    """#
    var value = try! JSONDecoder().decode(JSONValue.self, from: Data(fixture.utf8))
    var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []
    var online = true
    var version = 0
    /// Every write: method, path, If-Match and body.
    var writes: [(method: String, path: String, ifMatch: String?, body: JSONValue)] = []
    /// Refuse reorders, as a computer that lost the race or forbids it.
    var refuses = false
    /// A reorder waits for this before it answers.
    var gate: CheckedContinuation<Void, Never>?
    var holding = false

    func configure(online: Bool) { self.online = online }
    func refuse() { refuses = true }
    func hold() { holding = true }
    func release() { holding = false; gate?.resume(); gate = nil }
    func recorded() -> [(method: String, path: String, ifMatch: String?, body: JSONValue)] { writes }

    /// The person's Stem Cells setting, changed on the computer.
    func setStemCells(_ on: Bool) {
        version += 1
        let setting: JSONValue = .object(["key": .string(DesktopSettingKeys.v2), "value": .bool(on), "version": .string(String(format: "%08d", version)), "updatedAt": .number(Date().timeIntervalSince1970 * 1000)])
        var object = value.objectValue!
        object["userSettings"] = .array([setting])
        value = .object(object)
        emit(.object(["type": .string("user_settings.updated"), "payload": .object(["setting": setting])]))
    }

    private func emit(_ event: JSONValue) {
        let json = String(data: try! JSONEncoder().encode(event), encoding: .utf8)!
        continuations.forEach { $0.yield(Data("event: message\ndata: \(json)\n\n".utf8)) }
    }

    /// Moves `id` after `afterId` (nil: first) in a list of objects by id.
    private func moved(_ list: [JSONValue], key: String, _ id: String, after afterId: String?) -> [JSONValue] {
        var list = list
        guard let index = list.firstIndex(where: { $0[key]?.stringValue == id }) else { return list }
        let item = list.remove(at: index)
        let at = afterId.flatMap { after in list.firstIndex { $0[key]?.stringValue == after }.map { $0 + 1 } } ?? 0
        list.insert(item, at: at)
        return list
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        guard online else { throw URLError(.notConnectedToInternet) }
        if path == "/v0/bootstrap/desktop" { return .init(status: 200, body: try JSONEncoder().encode(value)) }
        if method == "GET", path.hasPrefix("/v0/bots/") {
            return .init(status: 200, body: Data(#"{"bot":{"version":"bot-v7"}}"#.utf8))
        }
        if method == "POST", path.hasSuffix("/reorder") {
            let request = try JSONDecoder().decode(JSONValue.self, from: body!)
            writes.append((method, path, headers["If-Match"], request))
            if holding { await withCheckedContinuation { gate = $0 } }
            if refuses { return .init(status: 409, body: Data(#"{"error":{"code":"conflict","message":"Moved elsewhere"}}"#.utf8)) }
            let parts = path.split(separator: "/").map(String.init)
            let after = request["afterId"]?.stringValue
            var object = value.objectValue!
            switch parts[1] {
            case "bots": object["bots"] = .array(moved(object["bots"]!.arrayValue!, key: "id", parts[2], after: after))
            case "tasks": object["taskMemberships"] = .array(moved(object["taskMemberships"]!.arrayValue!, key: "taskId", parts[2], after: after))
            default: break
            }
            value = .object(object)
            return .init(status: 200, body: Data("{}".utf8))
        }
        return .init(status: 404, body: Data("{}".utf8))
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        guard online else { throw URLError(.notConnectedToInternet) }
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        continuations.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"cursor-1\",\"resumed\":true}\n\n".utf8))
        return .init(status: 200, body: body)
    }

    func close() { continuations.forEach { $0.finish() }; continuations.removeAll() }
}

final class ClassicSidebarTests: XCTestCase {
    private func rows() throws -> [Row] {
        let desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(ClassicComputer.fixture.utf8))
        return Rows.visible(SidebarRows.make(desktop, settings: [:]))
    }

    private func labels(_ rows: [Row]) -> [String] { rows.map(\.label) }

    // MARK: What the classic list draws

    func testDesktopsSectionsAndOrder() throws {
        XCTAssertEqual(labels(try rows()), [
            "Artifacts", "Notes", "Groceries",
            "Bots", "Happy", "Sub one", "Sub two", "Research", "Release",
            "Tasks", "Three", "One", "Two",
            "Projects", "App", "Root chat", "Feature", "Fix", "Docs",
        ])
    }

    func testRowsCarryWhatAStoryRowSays() throws {
        let release = try XCTUnwrap(try rows().first { $0.label == "Release" })
        XCTAssertTrue(release.hasAgent)
        XCTAssertEqual(release.statusLine, "Signed and uploaded")
        XCTAssertEqual(release.statusTime, 1700000000000)
        XCTAssertEqual(try rows().first { $0.label == "Groceries" }?.mark, .glyph("tasks"))
    }

    /// Stories on: bots and tasks wear their rings, and the tree stays,
    /// unlike the spaces sidebar's, which keeps its top level only.
    func testStoriesKeepTheTree() throws {
        let rows = try rows()
        let ring = StoryRing(agentId: "release-agent", storyIds: ["s1", "s2"], unseenCount: 1, latestPostedAt: nil)
        let shown = ClassicDrag.withStories(rows, rings: ["release-agent": ring])
        XCTAssertEqual(labels(shown), labels(rows))
        XCTAssertEqual(shown.first { $0.label == "Release" }?.story, Row.StoryRowState(segments: 2, unseen: 1))
        XCTAssertEqual(shown.first { $0.label == "Three" }?.story, Row.StoryRowState())
        XCTAssertNil(shown.first { $0.label == "Sub one" }?.story)
        XCTAssertNil(shown.first { $0.label == "App" }?.story)
        XCTAssertTrue(shown.first { $0.label == "Bots" }?.amongStories == true)
        XCTAssertEqual(ClassicDrag.withStories(rows, rings: nil), rows)
    }

    // MARK: Reordering: within a section only

    func testBotMovesAmongBotsAndNeverPastItsSection() throws {
        let rows = try rows()
        let drag = try XCTUnwrap(ClassicDrag.drag(holding: "bot:research", rows: rows))
        XCTAssertEqual(drag.units.map { rows[$0[0]].label }, ["Happy", "Research", "Release"])
        // However far down the hand goes, the last slot is Bots' last.
        let heights = Array(repeating: 60.0, count: drag.units.count)
        XCTAssertEqual(drag.target(deltaY: 10_000, heights: heights), 2)
        XCTAssertEqual(drag.target(deltaY: -10_000, heights: heights), 0)
        let down = drag.order(to: 2)
        XCTAssertEqual(labels(down), [
            "Artifacts", "Notes", "Groceries",
            "Bots", "Happy", "Sub one", "Sub two", "Release", "Research",
            "Tasks", "Three", "One", "Two",
            "Projects", "App", "Root chat", "Feature", "Fix", "Docs",
        ])
        XCTAssertEqual(ClassicDrag.move(drag, to: 2), ClassicMove(kind: .bot, id: "research", afterId: "release", family: "direct:bots", order: ["bot:happy", "bot:release", "bot:research"]))
        XCTAssertEqual(ClassicDrag.move(drag, to: 0)?.afterId, .some(nil))
        XCTAssertNil(ClassicDrag.move(drag, to: drag.from))
    }

    func testSectionsArtifactsAndProjectSessionsNeverLift() throws {
        let rows = try rows()
        for id in ["direct:bots", "direct:tasks", "direct:projects", "direct:artifacts", "session:root"] {
            XCTAssertNil(ClassicDrag.drag(holding: id, rows: rows), id)
        }
        // A lone row has nobody to pass.
        let lone = rows.filter { $0.id != "task:t1" && $0.id != "task:t2" }
        XCTAssertNil(ClassicDrag.drag(holding: "task:t3", rows: lone))
    }

    func testTasksMoveInThePersonsOwnList() throws {
        let rows = try rows()
        let drag = try XCTUnwrap(ClassicDrag.drag(holding: "task:t2", rows: rows))
        XCTAssertEqual(drag.units.count, 3)
        XCTAssertEqual(ClassicDrag.move(drag, to: 0), ClassicMove(kind: .task, id: "t2", afterId: nil, family: "direct:tasks", order: ["task:t2", "task:t3", "task:t1"]))
    }

    func testSurfacesMoveBelowArtifactsWhichStays() throws {
        let rows = try rows()
        let drag = try XCTUnwrap(ClassicDrag.drag(holding: "surface:todo", rows: rows))
        XCTAssertEqual(drag.units.map { rows[$0[0]].label }, ["Notes", "Groceries"])
        XCTAssertEqual(labels(drag.order(to: 0)).prefix(4), ["Artifacts", "Groceries", "Notes", "Bots"])
        XCTAssertEqual(ClassicDrag.move(drag, to: 0), ClassicMove(kind: .surface, id: "todo", afterId: nil, family: ClassicDrag.topFamily, order: ["surface:todo", "surface:doc"]))
    }

    func testSubtasksMoveAmongTheirSiblings() throws {
        let rows = try rows()
        let drag = try XCTUnwrap(ClassicDrag.drag(holding: "session:sub2", rows: rows))
        XCTAssertEqual(drag.parent, "bot:happy")
        XCTAssertEqual(drag.units.map { rows[$0[0]].label }, ["Sub one", "Sub two"])
        XCTAssertEqual(ClassicDrag.move(drag, to: 0), ClassicMove(kind: .subtask, id: "sub2", afterId: nil, family: "bot:happy", order: ["session:sub2", "session:sub1"]))
    }

    func testWorktreesMoveAmongWorktreesAndProjectsCarryTheirTrees() throws {
        let rows = try rows()
        let worktree = try XCTUnwrap(ClassicDrag.drag(holding: "workspace:w2", rows: rows))
        XCTAssertEqual(worktree.units.map { rows[$0[0]].label }, ["Feature", "Fix"])
        XCTAssertEqual(ClassicDrag.move(worktree, to: 0), ClassicMove(kind: .workspace, id: "w2", afterId: nil, family: "project:p1", order: ["workspace:w2", "workspace:w1"]))
        let project = try XCTUnwrap(ClassicDrag.drag(holding: "project:p2", rows: rows))
        XCTAssertEqual(labels(project.order(to: 0)).suffix(6), ["Projects", "Docs", "App", "Root chat", "Feature", "Fix"])
        XCTAssertEqual(ClassicDrag.move(project, to: 0)?.kind, .project)
    }

    /// The order a move asked for shows until the computer answers.
    func testHeldOrderDrawsTheMoveAsMade() throws {
        let held = ClassicDrag.held(try rows(), orders: ["direct:bots": ["bot:release", "bot:happy", "bot:research"]])
        XCTAssertEqual(Array(labels(held)[3...9]), ["Bots", "Release", "Happy", "Sub one", "Sub two", "Research", "Tasks"])
    }

    // MARK: The engine

    private struct Timeout: Error {}
    private func wait(_ engine: SyncEngine, _ predicate: @escaping @Sendable (HomeSnapshot) -> Bool) async throws -> HomeSnapshot {
        try await withThrowingTaskGroup(of: HomeSnapshot.self) { group in
            group.addTask {
                for await snapshot in await engine.snapshots() where predicate(snapshot) { return snapshot }
                throw Timeout()
            }
            group.addTask { try await Task.sleep(for: .seconds(6)); throw Timeout() }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }

    private func bots(_ snapshot: HomeSnapshot) -> [String] {
        snapshot.rows.filter { $0.targetKind == "bot" }.map(\.label)
    }

    /// Home's choice is the setting alone, followed live both ways, and a
    /// relaunch before the computer answers keeps the last answer.
    func testHomeFollowsStemCellsAndKeepsTheLastAnswer() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("classic-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let computer = ClassicComputer()
        let engine = SyncEngine(client: AgentClient(transport: computer, token: "test"), directory: directory)
        await engine.start()
        _ = try await wait(engine) { $0.live && $0.loaded && !$0.usesSpaces }
        await computer.setStemCells(true)
        _ = try await wait(engine) { $0.usesSpaces }
        await computer.setStemCells(false)
        _ = try await wait(engine) { !$0.usesSpaces && $0.settings[DesktopSettingKeys.v2] == .bool(false) }
        await computer.setStemCells(true)
        _ = try await wait(engine) { $0.usesSpaces }
        await engine.stop()

        await computer.configure(online: false)
        let reopened = SyncEngine(client: AgentClient(transport: computer, token: "test"), directory: directory)
        await reopened.start()
        let offline = try await wait(reopened) { $0.loaded }
        XCTAssertFalse(offline.live)
        XCTAssertTrue(offline.usesSpaces, "a relaunch didn't keep the last answer")
        await reopened.stop()
    }

    /// A move within Bots goes by desktop's route, naming the bot's
    /// version, shows as made while it is asked, and the computer's own
    /// order follows.
    func testWithinSectionMovePersistsAsDesktopsDoes() async throws {
        let computer = ClassicComputer()
        let engine = SyncEngine(client: AgentClient(transport: computer, token: "test"), directory: nil)
        await engine.start()
        let start = try await wait(engine) { $0.live && $0.loaded }
        XCTAssertEqual(bots(start), ["Happy", "Research", "Release"])
        let drag = try XCTUnwrap(ClassicDrag.drag(holding: "bot:release", rows: start.rows))
        let move = try XCTUnwrap(ClassicDrag.move(drag, to: 0))
        await computer.hold()
        let asking = Task { await engine.reorder(move) }
        let held = try await wait(engine) { snapshot in snapshot.rows.first { $0.targetKind == "bot" }?.label == "Release" }
        XCTAssertEqual(bots(held), ["Release", "Happy", "Research"])
        await computer.release()
        await asking.value
        let writes = await computer.recorded()
        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes.first?.path, "/v0/bots/release/reorder")
        XCTAssertEqual(writes.first?.ifMatch, "bot-v7")
        XCTAssertEqual(writes.first?.body["afterId"], .null)
        XCTAssertNotNil(writes.first?.body["mutationId"]?.stringValue)
        let answered = try await wait(engine) { _ in true }
        XCTAssertEqual(bots(answered), ["Release", "Happy", "Research"])

        // A task: the person's own list, no version named.
        let tasks = try XCTUnwrap(ClassicDrag.drag(holding: "task:t2", rows: answered.rows))
        await engine.reorder(try XCTUnwrap(ClassicDrag.move(tasks, to: 0)))
        let task = await computer.recorded().last
        XCTAssertEqual(task?.path, "/v0/tasks/t2/reorder")
        XCTAssertNil(task?.ifMatch)
        let after = try await wait(engine) { _ in true }
        XCTAssertEqual(after.rows.filter { $0.targetKind == "task" }.map(\.label), ["Two", "Three", "One"])
        await engine.stop()
    }

    /// A refused move puts the row back and says why.
    func testRefusedMoveGoesBack() async throws {
        let computer = ClassicComputer()
        await computer.refuse()
        let engine = SyncEngine(client: AgentClient(transport: computer, token: "test"), directory: nil)
        await engine.start()
        let start = try await wait(engine) { $0.live && $0.loaded }
        let drag = try XCTUnwrap(ClassicDrag.drag(holding: "bot:release", rows: start.rows))
        await engine.reorder(try XCTUnwrap(ClassicDrag.move(drag, to: 0)))
        let after = try await wait(engine) { _ in true }
        XCTAssertEqual(bots(after), ["Happy", "Research", "Release"])
        XCTAssertNotNil(after.error)
        await engine.stop()
    }
}
