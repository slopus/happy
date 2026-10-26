import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// Opt-in, on a Mac: a throwaway Happy Agent daemon with the mobile
/// connector on. `HAPPY_STEM_CELLS_E2E_API` is a script that calls the
/// daemon's own socket (`api.sh METHOD PATH [JSON]`), which the test uses as
/// the desktop side of pairing; `HAPPY_STEM_CELLS_E2E_DIR` keeps the paired
/// credentials between runs. Everything else goes over Tailcat as the phone
/// does.
final class StemCellsDaemonTests: XCTestCase {
    private func daemon() throws -> (api: String, directory: URL) {
        let environment = ProcessInfo.processInfo.environment
        guard let api = environment["HAPPY_STEM_CELLS_E2E_API"], let directory = environment["HAPPY_STEM_CELLS_E2E_DIR"] else {
            throw XCTSkip("Requires a throwaway mobile-connector daemon")
        }
        return (api, URL(fileURLWithPath: directory))
    }

    private func call(_ api: String, _ arguments: [String]) throws -> JSONValue {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: api)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    /// Pairs through the real handshake once, then reuses the device.
    private func credentials() async throws -> DirectDeviceCredentials {
        let (api, directory) = try daemon()
        let saved = directory.appendingPathComponent("credentials.json")
        if let data = try? Data(contentsOf: saved), let credentials = try? JSONDecoder().decode(DirectDeviceCredentials.self, from: data) {
            let transport = TailcatHTTPTransport(address: credentials.address, port: credentials.port)
            let health = try? await transport.request("/v0/spaces/sidebar", credential: credentials.deviceToken)
            await transport.close()
            if health?.status == 200 { return credentials }
        }
        let started = try call(api, ["POST", "/v0/mobile-connector/pairing", "{}"])
        guard let qr = started["mobileConnector"]?["pairing"]?["qr"]?.stringValue,
              let pairingId = started["mobileConnector"]?["pairing"]?["id"]?.stringValue else { throw XCTSkip("No pairing code") }
        let service = DirectPairingService(link: try DirectPairingLink(qr))
        let emoji = try await service.start(deviceName: "Stem Cells e2e")
        let state = try call(api, ["GET", "/v0/mobile-connector"])
        XCTAssertEqual(state["mobileConnector"]?["pairing"]?["emoji"]?.arrayValue?.compactMap(\.stringValue), emoji)
        _ = try call(api, ["POST", "/v0/mobile-connector/pairing/confirm", "{\"pairingId\":\"\(pairingId)\"}"])
        let credentials = try await service.confirm()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(credentials).write(to: saved)
        return credentials
    }

    private func client(_ credentials: DirectDeviceCredentials) -> DirectAgentClient {
        DirectAgentClient(transport: TailcatHTTPTransport(address: credentials.address, port: credentials.port), token: credentials.deviceToken)
    }

    func testSidebarReadsAndStreamsOverTailcat() async throws {
        let client = client(try await credentials())
        defer { Task { await client.close() } }
        let health = try await client.health()
        XCTAssertEqual(health.capabilities?.sidebarOperations, true)
        let sidebar = try await client.sidebar(widgets: true)
        let document = try SpaceSidebar.parse(sidebar.html)
        XCTAssertTrue(document.items.contains(.search))
        let bots = try await client.bots()
        XCTAssertTrue(bots.contains { $0["systemKey"]?.stringValue == "chief_of_staff" })
        var frames = try await client.events(after: nil).makeAsyncIterator()
        let hello = try await frames.next()
        XCTAssertEqual(hello?.event, "hello")
    }

    func testStoreFoldsAndHearsItsOwnEcho() async throws {
        let credentials = try await credentials()
        let (api, _) = try daemon()
        let before = try call(api, ["GET", "/v0/spaces/sidebar?widgets=true"])
        let store = StemCellsStore(client: client(credentials))
        await store.start()
        var updates = store.updates.makeAsyncIterator()
        func next(_ where: (StemCellsSnapshot) -> Bool) async -> StemCellsSnapshot? {
            let deadline = ContinuousClock.now + .seconds(20)
            while ContinuousClock.now < deadline {
                guard let snapshot = await updates.next() else { return nil }
                if `where`(snapshot) { return snapshot }
            }
            return nil
        }
        let ready = await next { $0.live && $0.availability == .available && $0.rows.contains { $0.isHappy } }
        let rows = try XCTUnwrap(ready?.rows)
        XCTAssertEqual(rows.first?.kind, .search)
        XCTAssertEqual(rows.dropFirst().first?.kind, .create)
        let section = try XCTUnwrap(rows.first { $0.kind == .section })
        let folded = section.collapsed == true
        await store.fold(section.nodeId)
        let after = await next { $0.rows.first { $0.id == section.id }?.collapsed == !folded }
        XCTAssertNotNil(after)
        // Back as it was, so the next run starts from the same document.
        await store.fold(section.nodeId)
        _ = await next { $0.rows.first { $0.id == section.id }?.collapsed == folded }
        await store.flush()
        await store.stop()
        let written = try call(api, ["GET", "/v0/spaces/sidebar?widgets=true"])
        XCTAssertEqual(written["html"], before["html"])
        XCTAssertEqual(written["version"]?.numberValue, (before["version"]?.numberValue ?? 0) + 2)
    }

    /// New work below Happy, its first message sent before the daemon has
    /// made it, and the agent's answer streamed back, with no tool call shown.
    func testNewWorkTalksBack() async throws {
        let credentials = try await credentials()
        let client = client(credentials)
        let store = StemCellsStore(client: client)
        await store.start()
        var updates = store.updates.makeAsyncIterator()
        let deadline = ContinuousClock.now + .seconds(20)
        var ready: StemCellsSnapshot?
        while ContinuousClock.now < deadline, let snapshot = await updates.next() {
            if snapshot.live, snapshot.happySpaceId != nil { ready = snapshot; break }
        }
        XCTAssertNotNil(ready)
        let creation = await store.createStemCell()
        // Drawn at once, right below Happy, before the daemon has answered.
        let drawn = await updates.next()
        let rows = try XCTUnwrap(drawn?.rows)
        let happy = try XCTUnwrap(rows.firstIndex { $0.isHappy })
        XCTAssertEqual(rows[happy + 1].spaceId, creation.spaceId)
        XCTAssertTrue(rows[happy + 1].isUntouchedStemCell)

        let conversation = StemCellConversation(client: client, store: store, agentId: creation.agentId, creation: creation.created)
        await conversation.start()
        await conversation.send(text: "Reply with exactly the word: pineapple")
        var chat = conversation.updates.makeAsyncIterator()
        var answered: StemCellChatSnapshot?
        let until = ContinuousClock.now + .seconds(120)
        while ContinuousClock.now < until, let snapshot = await chat.next() {
            if !snapshot.working, snapshot.items.contains(where: { $0.role == .agent && $0.text.lowercased().contains("pineapple") }) {
                answered = snapshot
                break
            }
        }
        let items = try XCTUnwrap(answered?.items)
        XCTAssertEqual(items.first?.role, .user)
        XCTAssertEqual(items.first?.text, "Reply with exactly the word: pineapple")
        XCTAssertEqual(items.first?.delivery, .sent)
        let agentId = try await creation.created.value
        XCTAssertEqual(agentId, creation.agentId)
        await conversation.stop()
        await store.stop()
    }

    /// New work left empty goes: off the sidebar at once, even while the
    /// daemon is still making it, and off the computer once it is made.
    func testEmptyNewWorkGoesEverywhere() async throws {
        let credentials = try await credentials()
        let (api, _) = try daemon()
        let store = StemCellsStore(client: client(credentials))
        await store.start()
        var updates = store.updates.makeAsyncIterator()
        let deadline = ContinuousClock.now + .seconds(20)
        while ContinuousClock.now < deadline, let snapshot = await updates.next() {
            if snapshot.live, snapshot.happySpaceId != nil { break }
        }
        let creation = await store.createStemCell()
        let drawn = await updates.next()
        XCTAssertTrue(drawn?.rows.contains { $0.spaceId == creation.spaceId } == true)
        await store.discard(creation.spaceId)
        // Gone in the very next snapshot, and never back.
        let gone = await updates.next()
        XCTAssertFalse(gone?.rows.contains { $0.spaceId == creation.spaceId } ?? true)
        _ = try await creation.created.value
        let until = ContinuousClock.now + .seconds(10)
        var onComputer = true
        while ContinuousClock.now < until {
            let spaces = try call(api, ["GET", "/v0/spaces/sidebar"])["spaces"]?.arrayValue ?? []
            onComputer = spaces.contains { $0["id"]?.stringValue == creation.spaceId }
            if !onComputer { break }
            try await Task.sleep(for: .milliseconds(250))
        }
        XCTAssertFalse(onComputer, "the computer kept it")
        await store.stop()
    }

    /// The setting the banner follows reads as the daemon holds it.
    func testTheSettingReadsAsTheDaemonHoldsIt() async throws {
        let credentials = try await credentials()
        let client = client(credentials)
        let store = StemCellsStore(client: client)
        await store.start()
        var updates = store.updates.makeAsyncIterator()
        let deadline = ContinuousClock.now + .seconds(20)
        var ready: StemCellsSnapshot?
        while ContinuousClock.now < deadline, let snapshot = await updates.next() {
            if snapshot.live, snapshot.availability == .available { ready = snapshot; break }
        }
        let (api, _) = try daemon()
        let held = try call(api, ["GET", "/v0/user-settings/" + StemCellsStore.settingKey])["setting"]?["value"]
        let read = try await client.userSetting(StemCellsStore.settingKey)
        XCTAssertEqual(read, held == .null ? nil : held)
        XCTAssertEqual(ready?.prioritizing, held == .bool(true))
        await store.stop()
    }

    /// A Surface made elsewhere (desktop, an agent) reads here: a todo list
    /// takes a todo, a document reads as its Markdown.
    func testSurfacesMadeElsewhereRead() async throws {
        let credentials = try await credentials()
        let client = client(credentials)
        let (api, _) = try daemon()
        let list = try XCTUnwrap(call(api, ["POST", "/v0/surfaces", #"{"type":"todo","name":"Read list"}"#])["surface"]?["id"]?.stringValue)
        try await client.addTodo(list, id: ClientID.make(), text: "Buy oranges")
        let todos = try await client.todos(list)
        XCTAssertEqual(todos.map(\.text), ["Buy oranges"])
        let made = try call(api, ["POST", "/v0/surfaces", ##"{"type":"document","name":"Read notes","text":"# Read notes\n"}"##])
        guard let document = made["surface"]?["id"]?.stringValue else { throw XCTSkip("This daemon serves no documents") }
        let text = try await client.document(document)
        XCTAssertTrue(text.contains("Read notes"), text)
    }

    /// Every task row whose conversation has subtasks offers to show them,
    /// or already shows them.
    func testTaskRowsOfferTheirSubtasks() async throws {
        let credentials = try await credentials()
        let (api, _) = try daemon()
        let tasks = try call(api, ["GET", "/v0/tasks?scope=joined"])["tasks"]?.arrayValue ?? []
        let withSubtasks = Set(tasks.compactMap { task -> String? in
            let live = task["agent"]?["subtasks"]?.arrayValue?.filter { $0["archivedAt"] == nil || $0["archivedAt"] == .null } ?? []
            return live.isEmpty || task["archivedAt"].map({ $0 != .null }) == true ? nil : task["id"]?.stringValue
        })
        let store = StemCellsStore(client: client(credentials))
        await store.start()
        var updates = store.updates.makeAsyncIterator()
        let deadline = ContinuousClock.now + .seconds(20)
        var ready: StemCellsSnapshot?
        while ContinuousClock.now < deadline, let snapshot = await updates.next() {
            if snapshot.live, snapshot.availability == .available, !snapshot.allRows.isEmpty { ready = snapshot; break }
        }
        let rows = try XCTUnwrap(ready?.allRows).filter { $0.targetKind == "task" && withSubtasks.contains($0.targetId ?? "") }
        for row in rows {
            XCTAssertTrue(row.hasHiddenSessions || row.hasShownSessions, "\(row.label) offers none of its subtasks")
            XCTAssertFalse(row.sessions.isEmpty, "\(row.label) has no sessions")
        }
        await store.stop()
    }
}
