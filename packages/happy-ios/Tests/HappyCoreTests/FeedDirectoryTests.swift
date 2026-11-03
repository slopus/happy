import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A team computer with something of everything a Feed entry can name:
/// tasks (one archived, one Ada's), bots (Happy's own, one with a
/// picture, one archived), Surfaces (one with a picture), a project and
/// a workspace, agents nested and archived.
enum FeedFixture {
    static let bootstrap = #"""
    {"cursor":"cursor-1","feedUnread":2,"profile":{"userId":"me","photo":{"thumbhash":"mine"}},"userSettings":[],
     "projects":[{"id":"p1","name":"happy","status":"active","orderKey":"a","agents":[{"id":"p-agent","workspaceId":"p1","title":"Explore the repo","status":"idle"}]}],
     "workspaces":[{"id":"w1","projectId":"p1","name":"feed-refs","kind":"worktree","status":"active","orderKey":"b","agents":[]}],
     "bots":[{"id":"happy","name":"Happy","systemKey":"chief_of_staff","status":"active","agent":{"id":"happy-agent","workspaceId":"h","status":"idle"}},
             {"id":"research","name":"Research","status":"active","avatar":{"thumbhash":"bot-th"},"agent":{"id":"research-agent","workspaceId":"r","status":"idle",
               "subtasks":[{"id":"sub-agent","workspaceId":"r","parentAgentId":"research-agent","title":"Read the papers","status":"idle"}]}},
             {"id":"old-bot","name":"Retired","status":"archived","agent":{"id":"old-bot-agent","workspaceId":"o","status":"idle"}}],
     "tasks":[{"id":"t1","name":"Ship the feed","ownerUserId":"me","status":"active","agent":{"id":"t1-agent","workspaceId":"tw1","status":"idle"}},
              {"id":"t2","name":"Fix login","ownerUserId":"ada","status":"archived","agent":{"id":"t2-agent","workspaceId":"tw2","status":"idle"}},
              {"id":"t3","name":"Not in the feed","ownerUserId":"me","status":"active","agent":{"id":"t3-agent","workspaceId":"tw3","status":"idle"}}],
     "taskMemberships":[{"taskId":"t1"},{"taskId":"t3"}],
     "surfaces":[{"id":"s1","name":"Groceries","type":"todo","members":[],"image":null},
                 {"id":"s2","name":"Launch notes","type":"document","members":[],"image":{"thumbhash":"doc-th"}}],
     "archivedAgents":[{"id":"gone-agent","workspaceId":"p1","title":"Old session","status":"idle","archivedAt":5},{"id":7}]}
    """#

    static func desktop(_ json: String = bootstrap) throws -> DesktopSnapshot {
        try JSONDecoder().decode(DesktopSnapshot.self, from: Data(json.utf8))
    }

    static func artifacts() -> [ArtifactSummary] {
        [
            ArtifactSummary(id: "r1", type: "markdown", title: "Q4 roadmap", latestVersion: 3, entry: nil, createdAt: 1, updatedAt: 2),
            ArtifactSummary(id: "r2", type: "html", title: "Old mockups", latestVersion: 1, entry: nil, createdAt: 1, updatedAt: 3, deleted: true),
        ]
    }

    static func item(_ n: Int, _ type: String, _ id: String, actors: [FeedActor] = [], latest: FeedLatest? = nil, created: Bool = false, updates: Int = 0, seen: Bool = false) -> FeedItem {
        FeedItem(
            id: "item\(n)", version: "v\(n)", cursor: String(format: "c%04d", n), subject: FeedSubject(type: type, id: id),
            cluster: "team", created: created, updates: updates, actors: actors, latest: latest,
            firstAt: Double(n), lastAt: Double(n) * 1000, seenAt: seen ? 1 : nil
        )
    }
}

final class FeedDirectoryTests: XCTestCase {
    private func directory(users: [String: TeamUser] = [:], found: FeedLookups.Found = .init(), titles: [String: String] = [:]) throws -> FeedDirectory {
        FeedDirectory.make(desktop: try FeedFixture.desktop(), users: users, artifacts: FeedFixture.artifacts(), found: found, titles: titles)
    }

    private func row(_ item: FeedItem, _ directory: FeedDirectory) -> FeedRow? {
        FeedRows.row(item, unread: item.open, directory: directory, personSeed: "person:seed")
    }

    /// Everything the bootstrap holds, archived ones too, with the faces
    /// home gives them.
    func testTheDirectoryHoldsWhatTheAccountSyncs() throws {
        let directory = try directory(users: ["ada": TeamUser(id: "ada", name: "Ada", photo: .init(thumbhash: "ada-th"))])
        XCTAssertTrue(directory.loaded)
        XCTAssertEqual(directory.tasks["t1"], .init(name: "Ship the feed", mark: .image(path: "/v0/users/me/photo", thumbhash: "mine"), agentId: "t1-agent", owner: "me"))
        XCTAssertEqual(directory.tasks["t2"], .init(name: "Fix login", mark: .image(path: "/v0/users/ada/photo", thumbhash: "ada-th"), agentId: "t2-agent", archived: true, owner: "ada"))
        XCTAssertEqual(directory.bots["happy"]?.mark, .happy)
        XCTAssertEqual(directory.bots["research"]?.mark, .image(path: "/v0/bots/research/avatar", thumbhash: "bot-th"))
        XCTAssertEqual(directory.bots["old-bot"], .init(name: "Retired", mark: .placeholder(seed: "old-bot"), agentId: "old-bot-agent", archived: true))
        XCTAssertEqual(directory.surfaces["s2"], .init(name: "Launch notes", type: "document", image: "doc-th"))
        XCTAssertEqual(directory.artifacts["r2"]?.deleted, true)
        XCTAssertEqual(directory.projects["p1"]?.name, "happy")
        XCTAssertEqual(directory.workspaces["w1"]?.name, "feed-refs")
        // A bot's or task's own conversation is it; any other its own.
        XCTAssertEqual(directory.agents["research-agent"], .init(name: "Research", mark: .image(path: "/v0/bots/research/avatar", thumbhash: "bot-th")))
        XCTAssertEqual(directory.agents["sub-agent"], .init(name: "Read the papers", mark: .placeholder(seed: "sub-agent")))
        XCTAssertEqual(directory.agents["p-agent"]?.name, "Explore the repo")
        XCTAssertEqual(directory.agents["gone-agent"]?.name, "Old session", "archived agents are in the bootstrap")
        XCTAssertEqual(directory.userId, "me")
    }

    /// A row is its subject as the account has it now, never a name copied
    /// into the entry.
    func testEveryKindOfSubjectResolves() throws {
        let directory = try directory()
        let task = try XCTUnwrap(row(FeedFixture.item(1, "task", "t1", created: true), directory))
        XCTAssertEqual(task.title, "Ship the feed")
        XCTAssertEqual(task.kind, .task)
        XCTAssertEqual(task.target, .chat(agentId: "t1-agent", title: "Ship the feed"))
        XCTAssertTrue(task.unread)

        let archived = try XCTUnwrap(row(FeedFixture.item(2, "task", "t2"), directory))
        XCTAssertEqual(archived.title, "Fix login")
        XCTAssertEqual(archived.target, .chat(agentId: "t2-agent", title: "Fix login"))

        let bot = try XCTUnwrap(row(FeedFixture.item(3, "bot", "old-bot"), directory))
        XCTAssertEqual(bot.title, "Retired")
        XCTAssertEqual(bot.face, .mark(.placeholder(seed: "old-bot"), round: false))

        let list = try XCTUnwrap(row(FeedFixture.item(4, "surface", "s1"), directory))
        XCTAssertEqual(list.kind, .todoList)
        XCTAssertEqual(list.face, .tile(.todoList, artifactType: nil))
        XCTAssertEqual(list.target, .surface(AgentWire.Surface(id: "s1", type: "todo", name: "Groceries")))

        let document = try XCTUnwrap(row(FeedFixture.item(5, "surface", "s2", latest: FeedLatest(type: "document.edited", seq: 4), updates: 2), directory))
        XCTAssertEqual(document.face, .mark(.image(path: "/v0/surfaces/s2/image", thumbhash: "doc-th"), round: false), "a Surface's own picture")
        XCTAssertEqual(FeedWords.english.summary(document), "2 edits")

        let artifact = try XCTUnwrap(row(FeedFixture.item(6, "artifact", "r1", latest: FeedLatest(type: "artifact.updated", artifactVersion: 3), created: true, updates: 2), directory))
        XCTAssertEqual(artifact.title, "Q4 roadmap")
        XCTAssertEqual(artifact.face, .tile(.artifact, artifactType: "markdown"))
        XCTAssertEqual(artifact.target, .artifact(Artifact(id: "r1", version: 3, type: "markdown", title: "Q4 roadmap", followsLatest: true)))

        let deleted = try XCTUnwrap(row(FeedFixture.item(7, "artifact", "r2"), directory))
        XCTAssertEqual(deleted.title, "Old mockups", "a deleted artifact keeps its name")
        XCTAssertNil(deleted.target, "and opens nothing: its versions are gone")
    }

    /// No stand-ins: an entry the directory can't show isn't a row.
    func testAnEntryThatCantBeResolvedIsLeftOut() throws {
        let directory = try directory()
        let items = [
            FeedFixture.item(1, "task", "t1"),
            FeedFixture.item(2, "task", "deleted-task"),
            FeedFixture.item(3, "surface", "not-synced"),
            FeedFixture.item(4, "artifact", "not-read-yet"),
            FeedFixture.item(5, "story", "s1"),
        ]
        XCTAssertEqual(FeedRows.make(items, unread: \.open, directory: directory, personSeed: "p").map(\.id), ["item1"])
        // Before the bootstrap is read, nothing shows.
        XCTAssertEqual(FeedRows.make(items, unread: \.open, directory: FeedDirectory(), personSeed: "p"), [])
        XCTAssertFalse(FeedDirectory().loaded)
    }

    /// The name this phone gave a task shows at once, before the computer
    /// has taken it.
    func testAPendingRenameShows() throws {
        let directory = try directory(titles: ["t1": "Ship the references", "s1": "Errands"])
        XCTAssertEqual(row(FeedFixture.item(1, "task", "t1"), directory)?.title, "Ship the references")
        XCTAssertEqual(row(FeedFixture.item(2, "surface", "s1"), directory)?.title, "Errands")
    }

    /// A todo list's newest todo says itself, as the todo reads now; until
    /// it is read, or for the first daemons' entries, what happened.
    func testANewTodoSaysItselfFromTheStore() throws {
        let item = FeedFixture.item(1, "surface", "s1", latest: FeedLatest(type: "todo.created", todoId: "td1"), updates: 3)
        XCTAssertEqual(FeedWords.english.summary(try XCTUnwrap(row(item, try directory()))), "3 new todos")
        var found = FeedLookups.Found()
        found.todos["s1/td1"] = TodoItem(id: "td1", surfaceId: "s1", text: " Buy\nmilk ")
        XCTAssertEqual(FeedWords.english.summary(try XCTUnwrap(row(item, try directory(found: found)))), "Buy milk")
        found.todos["s1/td1"]?.text = "Buy oat milk"
        XCTAssertEqual(FeedWords.english.summary(try XCTUnwrap(row(item, try directory(found: found)))), "Buy oat milk", "an edit shows")
        XCTAssertEqual(FeedWords.english.summary(try XCTUnwrap(row(FeedFixture.item(1, "surface", "s1", updates: 3), try directory(found: found)))), "3 new todos")
    }

    func testActorsWearTheirFacesAndNames() throws {
        var found = FeedLookups.Found()
        found.agents["far-agent"] = "Deep subtask"
        let directory = try directory(users: ["bo": TeamUser(id: "bo", name: "Bo")], found: found)
        let item = FeedFixture.item(1, "task", "t1", actors: [
            FeedActor(agentId: "research-agent"), FeedActor(userId: "me"), FeedActor(userId: "bo"),
            FeedActor(agentId: "far-agent"), FeedActor(agentId: "unknown-agent"),
        ])
        let row = try XCTUnwrap(row(item, directory))
        XCTAssertEqual(row.actors, [
            .mark(.image(path: "/v0/bots/research/avatar", thumbhash: "bot-th"), round: false),
            .mark(.image(path: "/v0/users/me/photo", thumbhash: "mine"), round: true),
            .mark(.placeholder(seed: "bo"), round: true),
        ])
        XCTAssertEqual(row.actorNames, [.named("Research"), .you, .named("Bo"), .named("Deep subtask")], "one not known isn't named")
        XCTAssertEqual(FeedWords.english.actors(named: row.actorNames, count: row.actorCount), "Research and 4 others")
        XCTAssertEqual(FeedRows.face(FeedActor(agentId: "unknown-agent"), directory: directory, personSeed: "p"), .mark(.placeholder(seed: "unknown-agent"), round: false))
        // Standalone: the installation's one person.
        let alone = FeedDirectory.make(desktop: try FeedFixture.desktop(FeedFixture.bootstrap.replacingOccurrences(of: #""userId":"me","photo":{"thumbhash":"mine"}"#, with: #""userId":null"#)), users: [:], artifacts: [])
        XCTAssertEqual(FeedRows.face(FeedActor(), directory: alone, personSeed: "person:seed"), .mark(.placeholder(seed: "person:seed"), round: true))
        XCTAssertEqual(FeedRows.name(FeedActor(), directory: alone), .you)
    }

    func testPlacesAreNamedFromTheDirectory() throws {
        var found = FeedLookups.Found()
        found.workspaces["w9"] = .init(name: "deep-worktree")
        let directory = try directory(found: found)
        func place(_ cluster: String, _ kind: String) -> FeedPlace? { FeedPlace(FeedCluster(cluster: cluster, kind: kind), directory: directory) }
        XCTAssertEqual(place("*", "everything")?.name, .everything)
        XCTAssertEqual(place("team", "team")?.name, .team)
        XCTAssertEqual(place("team", "team")?.face, .clusterTile("team"))
        XCTAssertEqual(place("task:t2", "task")?.name, .named("Fix login"))
        XCTAssertEqual(place("bot:research", "bot")?.face, .mark(.image(path: "/v0/bots/research/avatar", thumbhash: "bot-th"), round: false))
        XCTAssertEqual(place("surface:s1", "surface")?.name, .named("Groceries"))
        XCTAssertEqual(place("project:p1", "project")?.face, .mark(.placeholder(seed: "p1"), round: false))
        XCTAssertEqual(place("workspace:w9", "workspace")?.name, .named("deep-worktree"))
        XCTAssertEqual(place("workspace:w9", "workspace")?.face, .clusterTile("workspace"))
        XCTAssertNil(place("task:gone", "task"))
        XCTAssertNil(place("story:s1", "story"))
    }

    /// What the directory lacks is looked up; tasks, bots and Surfaces
    /// come whole with the bootstrap and are never asked for.
    func testWhatIsMissingIsLookedUp() throws {
        let directory = try directory()
        let items = [
            FeedFixture.item(1, "task", "t2", actors: [FeedActor(userId: "me"), FeedActor(userId: "cy", agentId: nil), FeedActor(agentId: "far-agent"), FeedActor(agentId: "t1-agent")]),
            FeedFixture.item(2, "surface", "s1", latest: FeedLatest(type: "todo.created", todoId: "td1")),
            FeedFixture.item(3, "artifact", "r9"),
            FeedFixture.item(4, "artifact", "r1"),
            FeedFixture.item(5, "task", "deleted-task"),
        ]
        let clusters = [FeedCluster(cluster: "project:p1", kind: "project"), FeedCluster(cluster: "project:p9", kind: "project"), FeedCluster(cluster: "workspace:w9", kind: "workspace")]
        let missing = directory.missing(items, clusters: clusters)
        XCTAssertEqual(missing.agents, ["far-agent"])
        XCTAssertEqual(missing.people, ["cy", "ada"], "an actor, and an archived task's member for its face")
        XCTAssertEqual(missing.todos, ["s1/td1"])
        XCTAssertEqual(missing.artifacts, ["r9"])
        XCTAssertEqual(missing.projects, ["p9"])
        XCTAssertEqual(missing.workspaces, ["w9"])
        let named = directory.references(items, clusters: clusters)
        XCTAssertEqual(named.artifacts, ["r1", "r9"])
        XCTAssertEqual(named.agents, ["far-agent", "t1-agent"])
    }
}
