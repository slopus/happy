import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A computer in a team: Alex signed in, with a picture; tasks Alex made,
/// that Ada (with a picture), Bo (without one) and Cy (whom the computer
/// doesn't name) made, one nobody owns, one archived and one not joined.
private actor TeamFixture: AgentTransport {
    static let alexHash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"
    static let adaHash = "HBkSHYSIeHiPiHh8eJd4eTN0EEQG"
    static let fixture = #"""
    {"cursor":"cursor-1","profile":{"userId":"alex","name":"Alex","photo":{"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"}},"userSettings":[],
     "projects":[{"id":"p","name":"App","status":"active","orderKey":"a","agents":[]}],
     "workspaces":[],
     "bots":[{"id":"research","name":"Research","status":"active","agent":{"id":"research-agent","workspaceId":"r","status":"idle"}}],
     "tasks":[
       {"id":"mine","name":"Mine","ownerUserId":"alex","agent":{"id":"mine-agent","workspaceId":"w1","status":"idle"}},
       {"id":"adas","name":"Ada's","ownerUserId":"ada","agent":{"id":"adas-agent","workspaceId":"w2","status":"idle"}},
       {"id":"bos","name":"Bo's","ownerUserId":"bo","agent":{"id":"bos-agent","workspaceId":"w3","status":"idle"}},
       {"id":"cys","name":"Cy's","ownerUserId":"cy","agent":{"id":"cys-agent","workspaceId":"w4","status":"idle"}},
       {"id":"nobodys","name":"Nobody's","ownerUserId":null,"agent":{"id":"nobodys-agent","workspaceId":"w5","status":"idle"}},
       {"id":"old","name":"Old","status":"archived","ownerUserId":"dee","agent":{"id":"old-agent","workspaceId":"w6","status":"idle"}},
       {"id":"elsewhere","name":"Not joined","ownerUserId":"eve","agent":{"id":"elsewhere-agent","workspaceId":"w7","status":"idle"}}],
     "taskMemberships":[{"taskId":"mine"},{"taskId":"adas"},{"taskId":"bos"},{"taskId":"cys"},{"taskId":"nobodys"},{"taskId":"old"}],
     "surfaces":[]}
    """#

    var users: [String: JSONValue] = [
        "ada": ["id": "ada", "name": "Ada", "photo": ["thumbhash": .string(TeamFixture.adaHash)], "version": "1", "updatedAt": 1],
        "bo": ["id": "bo", "name": "Bo", "photo": .null, "version": "1", "updatedAt": 1],
        "alex": ["id": "alex", "name": "Alex", "photo": ["thumbhash": .string(TeamFixture.alexHash)], "version": "1", "updatedAt": 1],
    ]
    let bootstrap: String
    var online = true
    var requested: [String] = []
    var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []

    /// `team` false: the same computer standalone, no team user signed in.
    init(team: Bool = true) {
        bootstrap = team ? Self.fixture : Self.fixture.replacingOccurrences(of: #""userId":"alex""#, with: #""userId":null"#)
    }

    func requestedPaths() -> [String] { requested }
    func configure(online: Bool) { self.online = online }
    func setUser(_ id: String, _ value: JSONValue) { users[id] = value }
    func emit(_ event: JSONValue) {
        let json = String(data: try! JSONEncoder().encode(event), encoding: .utf8)!
        continuations.forEach { $0.yield(Data("event: message\ndata: \(json)\n\n".utf8)) }
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        guard online else { throw URLError(.notConnectedToInternet) }
        requested.append(path)
        if path == "/v0/bootstrap/desktop" { return .init(status: 200, body: Data(bootstrap.utf8)) }
        if path.hasPrefix("/v0/users?ids=") {
            let ids = path.dropFirst("/v0/users?ids=".count).split(separator: ",").map(String.init)
            let found = ids.compactMap { users[$0] }
            return .init(status: 200, body: try JSONEncoder().encode(JSONValue.object(["users": .array(found)])))
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

/// In a team, a task wears the face of the member it belongs to, who made
/// it, in place of its own placeholder: their picture over its ThumbHash,
/// or, without one or before they are read, their own placeholder picked
/// by their user ID. Outside a team nothing changes.
final class TeamTaskAuthorTests: XCTestCase {
    private func desktop(_ json: String = TeamFixture.fixture) throws -> DesktopSnapshot {
        try JSONDecoder().decode(DesktopSnapshot.self, from: Data(json.utf8))
    }

    private func marks(_ desktop: DesktopSnapshot, users: [String: TeamUser] = [:]) -> [String: Row.Mark] {
        Dictionary(SidebarRows.make(desktop, settings: [:], users: users).map { ($0.label, $0.mark) }, uniquingKeysWith: { first, _ in first })
    }

    private static let read: [String: TeamUser] = [
        "ada": TeamUser(id: "ada", name: "Ada", photo: .init(thumbhash: TeamFixture.adaHash)),
        "bo": TeamUser(id: "bo", name: "Bo"),
    ]

    func testATeamTaskWearsItsAuthorsFace() throws {
        let marks = marks(try desktop(), users: Self.read)
        // Their own: the signed-in person's picture, from the profile.
        XCTAssertEqual(marks["Mine"], .image(path: "/v0/users/alex/photo", thumbhash: TeamFixture.alexHash))
        XCTAssertEqual(marks["Ada's"], .image(path: "/v0/users/ada/photo", thumbhash: TeamFixture.adaHash))
        // No picture: the member's own placeholder, never the task's.
        XCTAssertEqual(marks["Bo's"], .placeholder(seed: "bo"))
        // Not read yet (or not named): the member's placeholder too.
        XCTAssertEqual(marks["Cy's"], .placeholder(seed: "cy"))
        // Nobody owns it: the task keeps its own.
        XCTAssertEqual(marks["Nobody's"], .placeholder(seed: "nobodys"))
    }

    /// The task's profile wears what its home row wears: the author's face.
    func testATeamTasksProfileWearsItsAuthorsFace() throws {
        let rows = SidebarRows.make(try desktop(), settings: [:], users: Self.read)
        let adas = SidebarRows.row(agentId: "adas-agent", spaceId: nil, in: rows)
        XCTAssertEqual(SidebarRows.profileMark(adas, agentId: "adas-agent"), .image(path: "/v0/users/ada/photo", thumbhash: TeamFixture.adaHash))
        let bos = SidebarRows.row(agentId: "bos-agent", spaceId: nil, in: rows)
        XCTAssertEqual(SidebarRows.profileMark(bos, agentId: "bos-agent"), .placeholder(seed: "bo"))
    }

    /// A task's row is its title alone; its picture, not a line under it,
    /// says whose it is.
    func testTeamTasksHaveNoLineUnderTheirTitle() throws {
        let details = Dictionary(SidebarRows.make(try desktop(), settings: [:], users: Self.read).map { ($0.label, $0.detail) }, uniquingKeysWith: { first, _ in first })
        for label in ["Mine", "Ada's", "Bo's", "Cy's", "Nobody's", "Research"] { XCTAssertNil(details[label] ?? nil, label) }
    }

    func testBotsSurfacesAndProjectsAreUnchangedInATeam() throws {
        let marks = marks(try desktop(), users: Self.read)
        XCTAssertEqual(marks["Research"], .placeholder(seed: "research"))
        XCTAssertEqual(marks["App"], .placeholder(seed: "p"))
        XCTAssertEqual(marks["Artifacts"], .glyph("doc"))
    }

    func testTheSignedInPersonWithoutAPictureWearsTheirOwnPlaceholder() throws {
        let json = TeamFixture.fixture.replacingOccurrences(of: #""photo":{"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"}"#, with: #""photo":null"#)
        XCTAssertEqual(marks(try desktop(json))["Mine"], .placeholder(seed: "alex"))
    }

    /// Standalone: no signed-in team user, so every task keeps its own
    /// placeholder, whatever owner a task still names, and nobody is read.
    func testOutsideATeamTasksKeepTheirOwnPlaceholder() throws {
        let json = TeamFixture.fixture.replacingOccurrences(of: #""userId":"alex""#, with: #""userId":null"#)
        let standalone = try desktop(json)
        let marks = marks(standalone, users: Self.read)
        XCTAssertEqual(marks["Mine"], .placeholder(seed: "mine"))
        XCTAssertEqual(marks["Ada's"], .placeholder(seed: "adas"))
        XCTAssertEqual(marks["Bo's"], .placeholder(seed: "bos"))
        XCTAssertEqual(SidebarRows.authors(standalone), [])
    }

    /// Only the listed tasks' authors are read: joined and not archived,
    /// and never the signed-in person, whose face is the profile's.
    func testOnlyTheListedTasksAuthorsAreRead() throws {
        XCTAssertEqual(SidebarRows.authors(try desktop()), ["ada", "bo", "cy"])
    }

    /// A picture the bootstrap can't read is none, never a lost list.
    func testAnUnreadablePictureIsNone() throws {
        let json = TeamFixture.fixture.replacingOccurrences(of: #""photo":{"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"}"#, with: #""photo":"nope""#)
        let desktop = try desktop(json)
        XCTAssertEqual(desktop.profile?.userId, "alex")
        XCTAssertNil(desktop.profile?.photo)
        let user = try JSONDecoder().decode(TeamUser.self, from: Data(#"{"id":"ada","name":"Ada","photo":7}"#.utf8))
        XCTAssertEqual(user, TeamUser(id: "ada", name: "Ada"))
    }

    // MARK: The engine

    private struct Timeout: Error {}
    private func wait(_ engine: SyncEngine, _ predicate: @escaping @Sendable (HomeSnapshot) -> Bool) async throws -> HomeSnapshot {
        try await withThrowingTaskGroup(of: HomeSnapshot.self) { group in
            group.addTask {
                for await snapshot in await engine.snapshots() where predicate(snapshot) { return snapshot }
                throw Timeout()
            }
            group.addTask { try await Task.sleep(for: .seconds(4)); throw Timeout() }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }

    private static func mark(_ snapshot: HomeSnapshot, _ label: String) -> Row.Mark? { snapshot.allRows.first { $0.label == label }?.mark }

    /// The engine reads the members it doesn't know, in one read, and the
    /// rows wear their faces; kept, they show on a relaunch with the
    /// computer out of reach.
    func testTheEngineReadsAndKeepsTheAuthors() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("team-authors-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let transport = TeamFixture()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: directory)
        await engine.start()
        let read = try await wait(engine) { Self.mark($0, "Ada's") == .image(path: "/v0/users/ada/photo", thumbhash: TeamFixture.adaHash) }
        XCTAssertEqual(Self.mark(read, "Bo's"), .placeholder(seed: "bo"))
        XCTAssertEqual(Self.mark(read, "Cy's"), .placeholder(seed: "cy"))
        XCTAssertEqual(Self.mark(read, "Mine"), .image(path: "/v0/users/alex/photo", thumbhash: TeamFixture.alexHash))
        let reads = await transport.requestedPaths().filter { $0.hasPrefix("/v0/users") }
        XCTAssertEqual(reads.first, "/v0/users?ids=ada,bo,cy")
        await engine.stop()

        await transport.configure(online: false)
        let relaunched = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: directory)
        await relaunched.start()
        let kept = try await wait(relaunched) { $0.loaded }
        XCTAssertFalse(kept.live)
        XCTAssertEqual(Self.mark(kept, "Ada's"), .image(path: "/v0/users/ada/photo", thumbhash: TeamFixture.adaHash))
        XCTAssertEqual(Self.mark(kept, "Bo's"), .placeholder(seed: "bo"))
        await relaunched.stop()
    }

    /// A member's new picture (`profile.updated` naming them) is read and
    /// worn; one the computer still doesn't name keeps their placeholder.
    func testAMembersNewPictureIsWorn() async throws {
        let transport = TeamFixture()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil)
        await engine.start()
        _ = try await wait(engine) { $0.live && Self.mark($0, "Ada's") == .image(path: "/v0/users/ada/photo", thumbhash: TeamFixture.adaHash) }
        await transport.setUser("bo", ["id": "bo", "name": "Bo", "photo": ["thumbhash": .string(TeamFixture.alexHash)], "version": "2", "updatedAt": 2])
        await transport.emit(["type": "profile.updated", "payload": ["userId": "bo"]])
        let changed = try await wait(engine) { Self.mark($0, "Bo's") == .image(path: "/v0/users/bo/photo", thumbhash: TeamFixture.alexHash) }
        XCTAssertEqual(Self.mark(changed, "Cy's"), .placeholder(seed: "cy"))
        await engine.stop()
    }

    /// Standalone, nobody is read and the rows are as they were.
    func testOutsideATeamNobodyIsRead() async throws {
        let transport = TeamFixture(team: false)
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil)
        await engine.start()
        _ = try await wait(engine) { $0.live && $0.loaded }
        try await Task.sleep(for: .milliseconds(200))
        let snapshot = try await wait(engine) { _ in true }
        XCTAssertEqual(Self.mark(snapshot, "Mine"), .placeholder(seed: "mine"))
        XCTAssertEqual(Self.mark(snapshot, "Ada's"), .placeholder(seed: "adas"))
        let reads = await transport.requestedPaths().filter { $0.hasPrefix("/v0/users") }
        XCTAssertEqual(reads, [])
        await engine.stop()
    }
}
