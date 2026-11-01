#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyLayout
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct OfflineRelay: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct OfflineSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A computer that keeps todo lists as the daemon does (happy-agent API.md,
/// "Todo routes"): a version on every change, `If-Match` checked (409 with
/// the current todo), a repeated creation ID answered with the first todo,
/// new todos first, every revision kept with who made it, and each change
/// sent on the event stream. Someone else can change a list, with or
/// without telling the phone, and the computer can go away.
actor TodoComputer: AgentTransport {
    static let groceries = "s00000000000000groceries"
    static let errands = "s000000000000000errands1"
    static let me = "u-me"
    static let sam = "u-sam"

    struct Write: Equatable { var method: String; var todoId: String; var mutationId: String }

    private(set) var surfaces: [AgentWire.Surface] = [
        AgentWire.Surface(id: groceries, type: "todo", name: "Groceries"),
        AgentWire.Surface(id: errands, type: "todo", name: "Errands"),
        AgentWire.Surface(id: "notes0000000000000000001", type: "document", name: "Notes"),
    ]
    private(set) var todos: [String: TodoItem] = [:]
    private(set) var revisions: [String: [JSONValue]] = [:]
    private(set) var writes: [Write] = []
    var online = true
    private var counter = 0
    private var clock = 1_761_998_400_000.0
    private var streams: [String: AsyncThrowingStream<Data, Error>.Continuation] = [:]
    private var connections = 0

    var isStreaming: Bool { !streams.isEmpty }

    func set(online: Bool) {
        self.online = online
        if !online {
            streams.values.forEach { $0.finish(throwing: URLError(.notConnectedToInternet)) }
            streams.removeAll()
        }
    }

    private func version() -> String { counter += 1; return String(format: "0199a000-0000-7000-8000-%012d", counter) }
    private func tick() -> Double { clock += 60_000; return clock }
    private func active(_ surfaceId: String) -> [TodoItem] {
        todos.values.filter { $0.surfaceId == surfaceId && $0.status == .active }.sorted(by: TodoOrder.active)
    }

    func activeTexts(_ surfaceId: String = groceries) -> [String] { active(surfaceId).map(\.text) }
    func todo(text: String) -> TodoItem? { todos.values.first { $0.text == text } }
    func creates(_ id: String) -> Int { writes.filter { $0.method == "POST" && $0.todoId == id }.count }

    @discardableResult
    func seed(_ text: String, in surfaceId: String = groceries, status: TodoItem.Status = .active, author: String? = me) -> TodoItem {
        counter += 1
        let id = String(format: "t%023d", counter)
        let key = status == .active ? TodoOrder.key(between: active(surfaceId).last?.orderKey, and: nil) : nil
        let at = tick()
        let todo = TodoItem(id: id, surfaceId: surfaceId, authorUserId: author, text: text, status: status, orderKey: key, createdAt: at, updatedAt: at,
                            completedAt: status == .completed ? at : nil, deletedAt: status == .deleted ? at : nil, version: version())
        record(todo, actor: author, previous: nil)
        return todo
    }

    /// Someone else's change, as the computer records it; `tell` sends its
    /// event, else the phone learns of it only when it next writes.
    @discardableResult
    func elsewhere(_ id: String, tell: Bool = true, _ change: @Sendable (inout TodoItem) -> Void) -> TodoItem {
        let before = todos[id]!
        var todo = before
        change(&todo)
        todo.updatedAt = tick()
        todo.version = version()
        record(todo, actor: Self.sam, previous: before, tell: tell)
        return todo
    }

    /// Someone else adds one, at the top.
    @discardableResult
    func addElsewhere(_ text: String, in surfaceId: String = groceries) -> TodoItem {
        counter += 1
        let at = tick()
        let todo = TodoItem(id: String(format: "x%023d", counter), surfaceId: surfaceId, authorUserId: Self.sam, text: text,
                            orderKey: TodoOrder.key(between: nil, and: active(surfaceId).first?.orderKey), createdAt: at, updatedAt: at, version: version())
        record(todo, actor: Self.sam, previous: nil)
        return todo
    }

    private func encode(_ todo: TodoItem) -> JSONValue { try! JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(todo)) }

    private func record(_ todo: TodoItem, actor: String?, previous: TodoItem?, tell: Bool = true) {
        todos[todo.id] = todo
        revisions[todo.id, default: []].append(.object([
            "todo": encode(todo), "actor": .object(["userId": actor.map(JSONValue.string) ?? .null, "agentId": .null]), "source": .string("api"),
        ]))
        guard tell else { return }
        if let previous {
            var changes: [String: JSONValue] = [:]
            if previous.text != todo.text { changes["text"] = .string(todo.text) }
            if previous.status != todo.status { changes["status"] = .string(todo.status.rawValue) }
            if previous.orderKey != todo.orderKey { changes["orderKey"] = todo.orderKey.map(JSONValue.string) ?? .null }
            if previous.completedAt != todo.completedAt { changes["completedAt"] = todo.completedAt.map(JSONValue.number) ?? .null }
            if previous.deletedAt != todo.deletedAt { changes["deletedAt"] = todo.deletedAt.map(JSONValue.number) ?? .null }
            changes["updatedAt"] = .number(todo.updatedAt)
            send("todo.updated", .object([
                "surfaceId": .string(todo.surfaceId), "todoId": .string(todo.id), "previousVersion": .string(previous.version),
                "version": .string(todo.version), "changes": .object(changes),
            ]))
        } else {
            send("todo.created", .object(["todo": encode(todo)]))
        }
    }

    private func send(_ type: String, _ payload: JSONValue) {
        let event: JSONValue = .object(["type": .string(type), "payload": payload])
        let data = Data("event: event\ndata: \(String(decoding: try! JSONEncoder().encode(event), as: UTF8.self))\n\n".utf8)
        for stream in streams.values { stream.yield(data) }
    }

    private var home: String {
        let members = surfaces.map { #"{"id":"\#($0.id)","name":"\#($0.name)","type":"\#($0.type)","members":[{"userId":"\#(Self.me)","orderKey":"a"}]}"# }
        return #"""
        {"cursor":"c1","profile":{"userId":"\#(Self.me)"},"userSettings":[],"projects":[],"workspaces":[],"bots":[],"tasks":[],"taskMemberships":[],"surfaces":[\#(members.joined(separator: ","))]}
        """#
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        guard online else { throw URLError(.notConnectedToInternet) }
        let json = try body.map { try JSONDecoder().decode(JSONValue.self, from: $0) }
        let route = String(path.split(separator: "?").first ?? "")
        let query = path.split(separator: "?").dropFirst().first.map(String.init) ?? ""
        func answer(_ value: JSONValue, status: Int = 200) -> HTTP1Response { .init(status: status, body: try! JSONEncoder().encode(value)) }
        func todoAnswer(_ todo: TodoItem) -> HTTP1Response { answer(.object(["todo": encode(todo)])) }
        let notFound = answer(.object(["error": .string("not_found")]), status: 404)
        let mutationId = json?["mutationId"]?.stringValue ?? ""
        switch (method, route) {
        case ("GET", "/v0/bootstrap/desktop"):
            return .init(status: 200, body: Data(home.utf8))
        case ("GET", "/v0/health"):
            return answer(.object(["capabilities": .object(["surfaceEditing": .bool(true)])]))
        case ("GET", "/v0/surfaces"):
            return answer(.object(["surfaces": .array(surfaces.map { .object(["id": .string($0.id), "type": .string($0.type), "name": .string($0.name)]) })]))
        case ("POST", "/v0/surfaces"):
            let id = json?["id"]?.stringValue ?? ClientID.make()
            let surface = AgentWire.Surface(id: id, type: json?["type"]?.stringValue ?? "", name: json?["name"]?.stringValue ?? "")
            if !surfaces.contains(where: { $0.id == id }) { surfaces.append(surface) }
            return answer(.object(["surface": .object(["id": .string(surface.id), "type": .string(surface.type), "name": .string(surface.name)])]))
        case ("GET", "/v0/users"):
            let ids = query.replacingOccurrences(of: "ids=", with: "").split(separator: ",").map(String.init)
            let names = [Self.me: "Steve Korshakov", Self.sam: "Sam Rivera"]
            return answer(.object(["users": .array(ids.compactMap { id in names[id].map { .object(["id": .string(id), "name": .string($0)]) } })]))
        default:
            break
        }
        let parts = route.split(separator: "/").map(String.init)
        guard parts.count >= 4, parts[0] == "v0", parts[1] == "surfaces", parts[2] == "todo" else { return answer(.object([:])) }
        let surfaceId = parts[3]
        guard surfaces.contains(where: { $0.id == surfaceId }) else { return notFound }
        if parts.count == 4 {
            if method == "GET" {
                let scope = TodoItem.Status(rawValue: query.replacingOccurrences(of: "scope=", with: "")) ?? .active
                return answer(.object(["todos": .array(todos.values.filter { $0.surfaceId == surfaceId && $0.status == scope }.map(encode))]))
            }
            let id = json?["id"]?.stringValue ?? ""
            writes.append(Write(method: "POST", todoId: id, mutationId: mutationId))
            if let held = todos[id] { return todoAnswer(held) }
            let at = tick()
            let todo = TodoItem(id: id, surfaceId: surfaceId, authorUserId: Self.me, text: json?["text"]?.stringValue ?? "",
                                orderKey: TodoOrder.key(between: nil, and: active(surfaceId).first?.orderKey), createdAt: at, updatedAt: at, version: version())
            record(todo, actor: Self.me, previous: nil)
            return todoAnswer(todo)
        }
        let todoId = parts[4]
        guard let held = todos[todoId], held.surfaceId == surfaceId else { return notFound }
        if method == "GET", parts.count == 6, parts[5] == "versions" {
            return answer(.object(["versions": .array(revisions[todoId] ?? []), "nextAfterVersion": .null]))
        }
        if method == "GET" { return todoAnswer(held) }
        writes.append(Write(method: parts.count == 6 ? "REORDER" : method, todoId: todoId, mutationId: mutationId))
        guard headers["If-Match"] == held.version else {
            return answer(.object(["error": .string("conflict"), "currentVersion": .string(held.version), "todo": encode(held)]), status: 409)
        }
        var todo = held
        let at = tick()
        switch (method, parts.count) {
        case ("PATCH", 5):
            if let text = json?["text"]?.stringValue { todo.text = text }
            if let status = json?["status"]?.stringValue.flatMap(TodoItem.Status.init(rawValue:)), status != todo.status {
                switch status {
                case .active: todo.completedAt = nil; todo.deletedAt = nil; todo.orderKey = TodoOrder.key(between: active(surfaceId).last?.orderKey, and: nil)
                case .completed: todo.completedAt = at; todo.deletedAt = nil; todo.orderKey = nil
                case .deleted: todo.deletedAt = at; todo.orderKey = nil
                }
                todo.status = status
            }
        case ("DELETE", 5):
            guard todo.status != .deleted else { return todoAnswer(todo) }
            todo.status = .deleted; todo.deletedAt = at; todo.orderKey = nil
        case ("POST", 6):
            let rest = active(surfaceId).filter { $0.id != todoId }
            let after = json?["afterId"]?.stringValue
            let index = after.flatMap { id in rest.firstIndex { $0.id == id }.map { $0 + 1 } } ?? 0
            todo.orderKey = TodoOrder.key(between: index > 0 ? rest[index - 1].orderKey : nil, and: index < rest.count ? rest[index].orderKey : nil)
        default:
            return notFound
        }
        todo.updatedAt = at
        todo.version = version()
        record(todo, actor: Self.me, previous: held)
        return todoAnswer(todo)
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        guard online else { throw URLError(.notConnectedToInternet) }
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        connections += 1
        let id = "stream\(connections)"
        streams[id] = continuation
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"c1\",\"resumed\":true,\"streamId\":\"\(id)\"}\n\n".utf8))
        return .init(status: 200, body: body)
    }

    func browserConnection() async throws -> any BrowserStream { throw URLError(.unsupportedURL) }
    func close() {}
}

/// What every todo screen test opens: an account paired with a
/// `TodoComputer`, its sync engine live, and a window to show screens in.
@MainActor
class HostedTodoCase: XCTestCase {
    struct Opened {
        let session: Session
        let window: UIWindow
        let navigation: UINavigationController
    }

    static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("evidence/todos")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    func capture(_ window: UIWindow, _ name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let device = UIDevice.current.userInterfaceIdiom == .pad ? "-ipad" : ""
        let file = "\(name)\(device)-\(window.traitCollection.userInterfaceStyle == .dark ? "dark" : "light")"
        let attachment = XCTAttachment(image: image)
        attachment.name = file
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = Self.evidence, let data = image.pngData() {
            try? data.write(to: folder.appendingPathComponent("\(file).png"))
        }
    }

    /// Light, then dark, once the rows are drawn dark.
    func captureBoth(_ window: UIWindow, _ name: String, list: CardListView) async throws {
        window.overrideUserInterfaceStyle = .light
        try await wait("the light drawing") { list.items.first?.drawing.dark == false }
        try await Task.sleep(for: .milliseconds(350))
        capture(window, name)
        window.overrideUserInterfaceStyle = .dark
        try await wait("the dark drawing") { list.items.first?.drawing.dark == true }
        try await Task.sleep(for: .milliseconds(350))
        capture(window, name)
        window.overrideUserInterfaceStyle = .light
    }

    func wait(_ what: String, timeout: Duration = .seconds(10), _ done: () async -> Bool) async throws {
        let deadline = ContinuousClock.now + timeout
        while !(await done()) {
            guard ContinuousClock.now < deadline else {
                XCTFail("timed out waiting for \(what)")
                throw CancellationError()
            }
            try await Task.sleep(for: .milliseconds(30))
        }
    }

    func open(_ computer: TodoComputer) async throws -> Opened {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("todo-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: directory,
            agentTransport: { _ in computer },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: OfflineRelay(), connector: OfflineSockets()
        )
        await account.agentConnections.setForeground(false)
        let pairing = try await account.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"todo-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Studio Mac"
        )
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: pairing.id, context: context))
        await session.engine.start()
        try await wait("live") { session.home.live }
        let navigation = UINavigationController(rootViewController: UIViewController())
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            await session.engine.stop()
            Session.forget(pairing.id)
        }
        return Opened(session: session, window: window, navigation: navigation)
    }
}

/// One todo list on a simulator against a computer that keeps it as the
/// daemon does: adding at the top and staying in the field, editing in
/// place, checking off and back, moving, deleting with an undo, the
/// deleted ones brought back, who changed what, another person's changes
/// arriving live, a stale write settled as desktop settles it, and changes
/// made with the computer away sent once it's back. Pictures, light and
/// dark, go to `.context/evidence/todos`.
final class HostedTodoListTests: HostedTodoCase {
    private func screen(_ opened: Opened, _ surfaceId: String = TodoComputer.groceries) throws -> TodoListViewController {
        let screen = try XCTUnwrap(SurfaceScreens.make(session: opened.session, surface: AgentWire.Surface(id: surfaceId, type: "todo", name: "Groceries")) as? TodoListViewController)
        opened.navigation.pushViewController(screen, animated: false)
        return screen
    }

    /// The todos on screen, in order, as VoiceOver reads them.
    private func shown(_ screen: TodoListViewController) -> [String] {
        screen.list.items.filter { TodoListItems.todoID($0.id) != nil }.map(\.accessibilityLabel)
    }

    private func value(_ screen: TodoListViewController, _ text: String) -> String? {
        screen.list.items.first { TodoListItems.todoID($0.id) != nil && $0.accessibilityLabel == text }?.accessibilityValue
    }

    private func id(_ computer: TodoComputer, _ text: String) async throws -> String {
        let todo = await computer.todo(text: text)
        return try XCTUnwrap(todo?.id, text)
    }

    private func seedGroceries(_ computer: TodoComputer) async {
        await computer.seed("Oat milk")
        await computer.seed("Sourdough bread")
        await computer.seed("Coffee beans, the Ethiopian ones from the market on Saturday morning", author: TodoComputer.sam)
        await computer.seed("# Weekend")
        await computer.seed("Basil")
        await computer.seed("Parmesan")
        await computer.seed("Olive oil", status: .completed)
        await computer.seed("Lemons", status: .completed)
        await computer.seed("Old receipt", status: .deleted)
    }

    func testTheListWithHeadingsAndItsCompletedLightAndDark() async throws {
        let computer = TodoComputer()
        await seedGroceries(computer)
        let opened = try await open(computer)
        let screen = try screen(opened)
        try await wait("the todos") { self.shown(screen).count == 6 }
        XCTAssertEqual(shown(screen), ["Oat milk", "Sourdough bread", "Coffee beans, the Ethiopian ones from the market on Saturday morning", "Weekend", "Basil", "Parmesan"])
        XCTAssertEqual(screen.list.items.first?.id, TodoListItems.addID, "the add row first")
        XCTAssertEqual(screen.list.items.first { $0.accessibilityLabel == "Weekend" }?.kind, .heading)
        XCTAssertEqual(screen.list.items.first { $0.id == TodoListItems.toggleID }?.accessibilityLabel, "Show 2 completed")
        try await wait("Sam's name") { self.value(screen, "Coffee beans, the Ethiopian ones from the market on Saturday morning") == "Not done, Added by Sam Rivera" }
        XCTAssertEqual(value(screen, "Oat milk"), "Not done, Added by Steve Korshakov")
        // A heading parts the cards: the rows above it end one, those under it start the next.
        let rows = screen.list.items.filter { $0.kind == .row && TodoListItems.todoID($0.id) != nil }
        XCTAssertEqual(rows.map(\.place), [CardPlace(first: true, last: false), CardPlace(first: false, last: false), CardPlace(first: false, last: true), CardPlace(first: true, last: false), CardPlace(first: false, last: true)])
        let column = CardColumn(width: screen.list.contentWidth, maxWidth: ContentWidth.maxWidth)
        for row in rows { XCTAssertEqual(row.card?.minX, column.x); XCTAssertEqual(row.card?.width, column.width) }
        if UIDevice.current.userInterfaceIdiom == .pad { XCTAssertLessThanOrEqual(column.width, ContentWidth.maxWidth) }

        screen.activated(TodoListItems.toggleID)
        try await wait("the completed") { self.shown(screen).count == 8 }
        XCTAssertEqual(Array(shown(screen).suffix(2)).sorted(), ["Lemons", "Olive oil"])
        XCTAssertEqual(screen.list.items.first { $0.id == TodoListItems.toggleID }?.accessibilityLabel, "Hide 2 completed")
        try await captureBoth(opened.window, "todo-list", list: screen.list)
    }

    func testAddingEditingAndCheckingOff() async throws {
        let computer = TodoComputer()
        await computer.seed("Oat milk")
        let opened = try await open(computer)
        let screen = try screen(opened)
        try await wait("the todo") { self.shown(screen) == ["Oat milk"] }

        // Adding: each Return keeps the field for the next one; new ones go on top.
        screen.startEditing(TodoListItems.addID)
        try await wait("the field") { screen.editor.window != nil && screen.editor.isFirstResponder }
        screen.editor.text = "  Bread "
        XCTAssertFalse(screen.textFieldShouldReturn(screen.editor))
        try await wait("the new todo") { self.shown(screen) == ["Bread", "Oat milk"] }
        XCTAssertEqual(screen.editingID, TodoListItems.addID, "still adding")
        XCTAssertEqual(screen.editor.text, "")
        screen.editor.text = "Eggs"
        _ = screen.textFieldShouldReturn(screen.editor)
        try await wait("the computer to have both") { await computer.activeTexts() == ["Eggs", "Bread", "Oat milk"] }
        try await wait("both on screen") { self.shown(screen) == ["Eggs", "Bread", "Oat milk"] }
        try await Task.sleep(for: .milliseconds(300))
        try await captureBoth(opened.window, "todo-adding", list: screen.list)
        screen.editor.resignFirstResponder()
        try await wait("done adding") { screen.editingID == nil }

        // Editing in place.
        let bread = try await id(computer, "Bread")
        screen.startEditing(bread)
        try await wait("the field over Bread") { screen.editor.isFirstResponder && screen.editor.text == "Bread" }
        screen.editor.text = "Rye bread"
        XCTAssertTrue(screen.textFieldShouldReturn(screen.editor))
        try await wait("the new text") { self.shown(screen).contains("Rye bread") }
        try await wait("the computer's text") { await computer.todos[bread]?.text == "Rye bread" }

        // Checking off: it stays a moment, ticked, then goes to the completed.
        screen.toggle(bread)
        try await wait("ticked in place") { self.value(screen, "Rye bread")?.hasPrefix("Done") == true }
        XCTAssertEqual(shown(screen).firstIndex(of: "Rye bread"), 1, "where it was")
        try await wait("gone to the completed") { self.shown(screen) == ["Eggs", "Oat milk"] }
        XCTAssertEqual(screen.list.items.first { $0.id == TodoListItems.toggleID }?.accessibilityLabel, "Show 1 completed")
        try await wait("completed on the computer") { await computer.todos[bread]?.status == .completed }

        // And back: it goes to the end of the active ones.
        screen.activated(TodoListItems.toggleID)
        try await wait("the completed shown") { self.shown(screen).last == "Rye bread" }
        screen.toggle(bread)
        try await wait("active again, last") { await computer.activeTexts() == ["Eggs", "Oat milk", "Rye bread"] }
        try await wait("on screen too") { self.shown(screen) == ["Eggs", "Oat milk", "Rye bread"] }
        XCTAssertNil(screen.list.items.first { $0.id == TodoListItems.toggleID })
    }

    func testMovingDeletingWithUndoAndTheDeletedOnes() async throws {
        let computer = TodoComputer()
        for text in ["Oat milk", "Bread", "Eggs", "Basil"] { await computer.seed(text) }
        let opened = try await open(computer)
        let screen = try screen(opened)
        try await wait("the todos") { self.shown(screen) == ["Oat milk", "Bread", "Eggs", "Basil"] }

        // Moving (what a drag and VoiceOver's Move down end in).
        let milk = try await id(computer, "Oat milk")
        screen.move(milk, to: 2)
        try await wait("moved on screen") { self.shown(screen) == ["Bread", "Eggs", "Oat milk", "Basil"] }
        try await wait("moved on the computer") { await computer.activeTexts() == ["Bread", "Eggs", "Oat milk", "Basil"] }
        let names = screen.list.accessibilityActions?(TodoListItems.rowID(milk)).map(\.name) ?? []
        XCTAssertEqual(names, ["Mark “Oat milk” done", "Todo text", "Move up", "Move down", "Delete “Oat milk”", "History"])

        // Deleting, with an undo that puts it back where it was.
        let eggs = try await id(computer, "Eggs")
        screen.delete(eggs)
        try await wait("gone") { self.shown(screen) == ["Bread", "Oat milk", "Basil"] }
        XCTAssertFalse(screen.undoBar.isHidden)
        XCTAssertEqual(screen.undoBar.accessibilityLabel, "Deleted “Eggs”")
        try await wait("deleted on the computer") { await computer.todos[eggs]?.status == .deleted }
        try await Task.sleep(for: .milliseconds(300))
        try await captureBoth(opened.window, "todo-undo", list: screen.list)
        screen.undoBar.button.sendActions(for: .primaryActionTriggered)
        try await wait("back in its place") { self.shown(screen) == ["Bread", "Eggs", "Oat milk", "Basil"] }
        try await wait("back on the computer") { await computer.activeTexts() == ["Bread", "Eggs", "Oat milk", "Basil"] }

        // The deleted ones, from the bar's menu, brought back to the end.
        let basil = try await id(computer, "Basil")
        let bread = try await id(computer, "Bread")
        screen.delete(basil)
        screen.delete(bread)
        try await wait("both gone") { self.shown(screen) == ["Eggs", "Oat milk"] }
        XCTAssertEqual(screen.navigationItem.rightBarButtonItem?.accessibilityIdentifier, "todo-more")
        screen.openDeleted()
        let deleted = try XCTUnwrap(opened.navigation.topViewController as? TodoListViewController)
        XCTAssertEqual(deleted.mode, .deleted)
        try await wait("the deleted") { Set(self.shown(deleted)) == ["Basil", "Bread"] }
        XCTAssertEqual(deleted.title, "Deleted")
        try await captureBoth(opened.window, "todo-deleted", list: deleted.list)
        deleted.activated(TodoListItems.rowID(basil))
        try await wait("restored") { self.shown(deleted) == ["Bread"] }
        try await wait("restored on the computer") { await computer.activeTexts() == ["Eggs", "Oat milk", "Basil"] }
        opened.navigation.popViewController(animated: false)
        try await wait("in the list again") { self.shown(screen) == ["Eggs", "Oat milk", "Basil"] }
    }

    func testWhoChangedWhat() async throws {
        let computer = TodoComputer()
        let milk = await computer.seed("Milk").id
        await computer.elsewhere(milk) { $0.text = "Oat milk" }
        await computer.elsewhere(milk) { $0.status = .completed; $0.completedAt = 1; $0.orderKey = nil }
        let opened = try await open(computer)
        let screen = try screen(opened)
        try await wait("the completed toggle") { screen.list.items.contains { $0.id == TodoListItems.toggleID } }
        screen.activated(TodoListItems.toggleID)
        try await wait("Oat milk") { self.shown(screen) == ["Oat milk"] }
        screen.openHistory(milk)
        let history = try XCTUnwrap(opened.navigation.topViewController as? TodoHistoryViewController)
        try await wait("three revisions") { history.rows.count == 3 }
        XCTAssertEqual(history.rows.map(\.change), [.completed, .edited(from: "Milk"), .created], "newest first")
        XCTAssertEqual(history.rows.map(\.revision.userId), [TodoComputer.sam, TodoComputer.sam, TodoComputer.me])
        try await wait("the names") {
            (history.tableView.cellForRow(at: IndexPath(row: 0, section: 0)) as? DocumentHistoryCell)?.accessibilityLabel?.contains("Sam Rivera") == true
        }
        try await Task.sleep(for: .milliseconds(300))
        history.view.window?.overrideUserInterfaceStyle = .light
        try await Task.sleep(for: .milliseconds(300))
        capture(opened.window, "todo-history")
        opened.window.overrideUserInterfaceStyle = .dark
        try await Task.sleep(for: .milliseconds(400))
        capture(opened.window, "todo-history")
    }

    /// Someone else's changes arrive live; a write over a change the phone
    /// never heard of is answered 409, and, as desktop does, it takes the
    /// computer's todo and sends the change again over it.
    func testOthersChangesArriveLiveAndAStaleWriteSettles() async throws {
        let computer = TodoComputer()
        let milk = await computer.seed("Milk").id
        let opened = try await open(computer)
        let screen = try screen(opened)
        try await wait("the todo") { self.shown(screen) == ["Milk"] }

        await computer.addElsewhere("Sam's coffee")
        try await wait("Sam's todo, live") { self.shown(screen) == ["Sam's coffee", "Milk"] }
        await computer.elsewhere(milk) { $0.text = "Oat milk" }
        try await wait("Sam's edit, live") { self.shown(screen) == ["Sam's coffee", "Oat milk"] }

        await computer.elsewhere(milk, tell: false) { $0.text = "Oat milk, two cartons" }
        screen.toggle(milk)
        try await wait("completed over Sam's text") {
            let todo = await computer.todos[milk]
            return todo?.status == .completed && todo?.text == "Oat milk, two cartons"
        }
        let writes = await computer.writes.filter { $0.todoId == milk }
        XCTAssertEqual(writes.count, 2, "refused once, then taken")
        XCTAssertEqual(writes.first?.mutationId, writes.last?.mutationId, "the same change, under its ID")
        try await wait("the completed") { screen.list.items.first { $0.id == TodoListItems.toggleID }?.accessibilityLabel == "Show 1 completed" }
        screen.activated(TodoListItems.toggleID)
        try await wait("the computer's text") { self.shown(screen) == ["Sam's coffee", "Oat milk, two cartons"] }
        XCTAssertNil(screen.list.items.first { $0.id == TodoListItems.failureID }, "nothing undone")
    }

    /// With the computer away every change shows at once, said not to be
    /// sent; once it's back each goes, once.
    func testChangesMadeAwayGoOnceTheComputerIsBack() async throws {
        let computer = TodoComputer()
        let milk = await computer.seed("Milk").id
        let opened = try await open(computer)
        let screen = try screen(opened)
        try await wait("the todo") { self.shown(screen) == ["Milk"] }

        await computer.set(online: false)
        try await wait("away") { !opened.session.home.live }
        screen.startEditing(TodoListItems.addID)
        screen.editor.text = "Bread"
        _ = screen.textFieldShouldReturn(screen.editor)
        screen.editor.resignFirstResponder()
        screen.toggle(milk)
        try await wait("shown at once") { self.shown(screen) == ["Bread"] }
        XCTAssertEqual(value(screen, "Bread")?.hasSuffix("Not sent yet"), true)
        try await Task.sleep(for: .milliseconds(300))
        try await captureBoth(opened.window, "todo-offline", list: screen.list)

        await computer.set(online: true)
        try await wait("sent", timeout: .seconds(30)) { await computer.activeTexts() == ["Bread"] }
        try await wait("Milk completed") { await computer.todos[milk]?.status == .completed }
        let bread = try await id(computer, "Bread")
        let creates = await computer.creates(bread)
        XCTAssertEqual(creates, 1)
        try await wait("sent, on screen") { self.value(screen, "Bread")?.contains("Not sent yet") == false }
    }

    func testAnEmptyListAndOneThatIsGone() async throws {
        let computer = TodoComputer()
        let opened = try await open(computer)
        let empty = try screen(opened, TodoComputer.errands)
        try await wait("the empty note") { empty.list.items.contains { $0.accessibilityLabel == Strings.Todos.empty } }
        let gone = try screen(opened, "s000000000000000missing1")
        try await wait("the missing note") { gone.list.items.contains { $0.accessibilityLabel == Strings.Todos.missing } }
    }
}

/// Home's Todos row: the todo lists, a new one made from the bar's +, and
/// a new document opened in the editor from the same menu.
final class HostedTodoListsTests: HostedTodoCase {
    private func rows(_ screen: TodoListsViewController) -> [String] {
        screen.list.items.filter { $0.kind == .row }.map(\.accessibilityLabel)
    }

    func testTheListsWithWhatsLeftAndNewOnes() async throws {
        let computer = TodoComputer()
        await computer.seed("Milk")
        await computer.seed("Bread")
        await computer.seed("# Saturday")
        await computer.seed("Post office", in: TodoComputer.errands)
        let opened = try await open(computer)

        // Home lists it, after Artifacts.
        try await wait("home's row") { opened.session.home.rows.contains { $0.id == "direct:todos" } }
        let ids = opened.session.home.rows.map(\.id)
        XCTAssertEqual(ids.firstIndex(of: "direct:todos"), (ids.firstIndex(of: "direct:artifacts") ?? -2) + 1)

        let screen = TodoListsViewController(session: opened.session)
        opened.navigation.pushViewController(screen, animated: false)
        try await wait("the lists") { self.rows(screen) == ["Errands", "Groceries"] }
        XCTAssertEqual(screen.newItem.accessibilityLabel, "New")
        XCTAssertEqual(screen.newItem.menu?.children.map(\.title), ["New todo list", "New document"])

        // A list opened here counts what's left (headings aren't todos).
        screen.list.onSelect?(TodoComputer.groceries)
        let groceries = try XCTUnwrap(opened.navigation.topViewController as? TodoListViewController)
        try await wait("its todos") { groceries.list.items.contains { $0.accessibilityLabel == "Bread" } }
        opened.navigation.popViewController(animated: false)
        try await wait("the count") { screen.list.items.first { $0.id == TodoComputer.groceries }?.accessibilityValue == "2 to do" }
        try await captureBoth(opened.window, "todo-lists", list: screen.list)

        // A new todo list opens on its (empty) todos.
        screen.create(type: "todo", name: "Packing")
        let top = await waitForTop(opened.navigation) { $0 is TodoListViewController && $0 !== groceries }
        let packing = try XCTUnwrap(top as? TodoListViewController)
        XCTAssertEqual(packing.title, "Packing")
        let made = await computer.surfaces.first { $0.name == "Packing" }
        XCTAssertEqual(made?.type, "todo")
        XCTAssertEqual(packing.surfaceId, made?.id)
        opened.navigation.popViewController(animated: false)
        try await wait("listed") { self.rows(screen) == ["Errands", "Groceries", "Packing"] }

        // A new document opens in the editor.
        screen.create(type: "document", name: "Trip plan")
        let document = await waitForTop(opened.navigation) { $0 is DocumentViewController }
        XCTAssertNotNil(document)
        let doc = await computer.surfaces.first { $0.name == "Trip plan" }
        XCTAssertEqual(doc?.type, "document")
        XCTAssertEqual(rows(screen), ["Errands", "Groceries", "Packing"], "a document isn't a todo list")
    }

    func testTheNameAlertKeepsCreateOffWhileBlank() async throws {
        let opened = try await open(TodoComputer())
        let screen = TodoListsViewController(session: opened.session)
        opened.navigation.pushViewController(screen, animated: false)
        try await wait("the lists") { self.rows(screen).count == 2 }
        screen.askName(type: "todo")
        let presented = await waitForPresented(screen)
        let alert = try XCTUnwrap(presented as? UIAlertController)
        XCTAssertEqual(alert.title, "New todo list")
        let create = try XCTUnwrap(alert.actions.first { $0.title == "Create" })
        XCTAssertFalse(create.isEnabled)
        let field = try XCTUnwrap(alert.textFields?.first)
        field.text = "  "
        field.sendActions(for: .editingChanged)
        XCTAssertFalse(create.isEnabled)
        field.text = "Packing"
        field.sendActions(for: .editingChanged)
        XCTAssertTrue(create.isEnabled)
        try await Task.sleep(for: .milliseconds(400))
        capture(opened.window, "todo-lists-new")
        screen.dismiss(animated: false)
    }

    private func waitForTop(_ navigation: UINavigationController, _ matches: (UIViewController) -> Bool) async -> UIViewController? {
        try? await wait("the screen") { navigation.topViewController.map(matches) ?? false }
        return navigation.topViewController
    }

    private func waitForPresented(_ screen: UIViewController) async -> UIViewController? {
        try? await wait("the alert") { screen.presentedViewController != nil }
        return screen.presentedViewController
    }
}
#endif
