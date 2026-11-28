import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// A Happy Cloud server's teams and the people in them (happy-cluster
/// docs/teams.md, `GET /v0/teams` and `GET /v0/members`): read as the
/// cluster writes them, read from a server before teams as the teams its
/// roles became, and flattened for a profile as the server flattens them.
final class TeamsTests: XCTestCase {
    private actor TeamsServer: AgentTransport {
        private(set) var paths: [String] = []
        private let teamsServed: Bool

        init(teamsServed: Bool = true) { self.teamsServed = teamsServed }

        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            paths.append("\(method) \(path)")
            switch path {
            case "/v0/teams" where teamsServed:
                return HTTP1Response(status: 200, body: Data(TeamsTests.teams.utf8))
            case "/v0/roles":
                return HTTP1Response(status: 200, body: Data(#"""
                {"roles":[{"id":"owner","name":"Owner","builtIn":true},{"id":"admin","name":"Admin","builtIn":true},
                          {"id":"member","name":"Member","builtIn":true},{"id":"r_7f3a","name":"Designers","builtIn":false},{"id":7}]}
                """#.utf8))
            case "/v0/members":
                return HTTP1Response(status: 200, body: Data(TeamsTests.members.utf8))
            default:
                return HTTP1Response(status: 404, body: Data(#"{"error":"Not here.","code":"not_found"}"#.utf8))
            }
        }

        func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.cannotConnectToHost) }
        func reset() async {}
        func close() async {}
    }

    /// Contractors sit inside Design, and Everyone inside Announcements.
    static let teams = #"""
    {"teams":[
      {"id":"owners","kind":"owners","name":"Owners","description":"","color":"gray","image":null,"permissions":[],"people":["acc-ada"],"teams":[],"memberCount":1,"version":"1","createdAt":0,"updatedAt":0},
      {"id":"members","kind":"members","name":"Members","description":"","color":"gray","image":null,"permissions":["content.write"],"people":null,"teams":[],"memberCount":3,"version":"1","createdAt":0,"updatedAt":0},
      {"id":"announce","kind":"custom","name":"Announcements","permissions":[],"people":[],"teams":["members"],"memberCount":3},
      {"id":"contractors","kind":"custom","name":"Contractors","permissions":[],"people":["acc-bo"],"teams":[],"memberCount":1},
      {"id":"design","kind":"custom","name":"Design","color":"red","image":{"url":"/v0/teams/design/image","digest":"d"},"permissions":["zones.manage"],"people":["acc-ada"],"teams":["contractors"],"memberCount":2},
      {"id":"leads","kind":"custom","name":"Leads","permissions":[],"people":[],"teams":["owners"],"memberCount":1},
      {"kind":"custom","name":"No ID"}]}
    """#

    static let members = #"""
    {"members":[
      {"accountId":"acc-ada","userId":"ada","name":"Ada Lovelace","teams":["design"],"owner":true,"role":"owner","joinedAt":"2026-11-01T00:00:00Z"},
      {"accountId":"acc-bo","userId":"bo","name":"Bo","teams":["contractors"],"owner":false,"role":"contractors","joinedAt":null},
      {"accountId":"acc-invited","userId":null,"name":null,"teams":[],"owner":false,"role":"member","joinedAt":null},
      {"userId":"broken"}]}
    """#

    func testTeamsAreReadAsTheClusterWritesThem() async throws {
        let server = TeamsServer()
        let teams = try await AgentClient(transport: server, token: "t").teams()
        XCTAssertEqual(teams.map(\.id), ["owners", "members", "announce", "contractors", "design", "leads"], "a team it can't read is left out")
        XCTAssertEqual(teams[0].kind, .owners)
        XCTAssertEqual(teams[1].kind, .members)
        XCTAssertEqual(teams[4], Team(id: "design", kind: .custom, name: "Design", teams: ["contractors"]))
        let paths = await server.paths
        XCTAssertEqual(paths, ["GET /v0/teams"])
    }

    /// Until every server has teams: one without `/v0/teams` names its
    /// roles, which become teams (`owner` and `member` the derived two).
    func testAServerBeforeTeamsHasItsRolesAsTeams() async throws {
        let server = TeamsServer(teamsServed: false)
        let teams = try await AgentClient(transport: server, token: "t").teams()
        XCTAssertEqual(teams, [
            Team(id: "owner", kind: .owners, name: "Owner"), Team(id: "admin", kind: .custom, name: "Admin"),
            Team(id: "member", kind: .members, name: "Member"), Team(id: "r_7f3a", kind: .custom, name: "Designers"),
        ])
        let paths = await server.paths
        XCTAssertEqual(paths, ["GET /v0/teams", "GET /v0/roles"])
    }

    func testMembersAreReadWithTheirTeamsAndOwnerFlag() async throws {
        let members = try await AgentClient(transport: TeamsServer(), token: "t").members()
        XCTAssertEqual(members, [
            ServerMember(accountId: "acc-ada", userId: "ada", name: "Ada Lovelace", teams: ["design"], owner: true),
            ServerMember(accountId: "acc-bo", userId: "bo", name: "Bo", teams: ["contractors"], owner: false),
            ServerMember(accountId: "acc-invited"),
        ], "someone it can't read is left out")
    }

    /// `role` alone: `owner` an owner, a role of the server's own the team
    /// it became, the built-in others no team.
    func testAMemberFromBeforeTeamsIsReadFromTheirRole() throws {
        func member(_ role: String) throws -> ServerMember {
            try JSONDecoder().decode(ServerMember.self, from: Data(#"{"accountId":"a","role":"\#(role)"}"#.utf8))
        }
        XCTAssertEqual(try member("owner"), ServerMember(accountId: "a", owner: true))
        XCTAssertEqual(try member("member"), ServerMember(accountId: "a"))
        XCTAssertEqual(try member("viewer"), ServerMember(accountId: "a"))
        XCTAssertEqual(try member("admin"), ServerMember(accountId: "a", teams: ["admin"]))
        XCTAssertEqual(try member("r_7f3a"), ServerMember(accountId: "a", teams: ["r_7f3a"]))
    }

    /// Their own teams, every team holding one of those, transitively, and
    /// those holding `owners` or `members`: by name, in the server's order.
    func testAStandingFlattensNestedTeams() throws {
        let teams = try JSONDecoder().decode([String: [Lossy<Team>]].self, from: Data(Self.teams.utf8))["teams"]!.compactMap(\.value)
        let members = try JSONDecoder().decode([String: [Lossy<ServerMember>]].self, from: Data(Self.members.utf8))["members"]!.compactMap(\.value)
        XCTAssertEqual(TeamStanding(members[0], teams: teams), TeamStanding(owner: true, teams: ["Announcements", "Design", "Leads"]))
        XCTAssertEqual(TeamStanding(members[1], teams: teams), TeamStanding(owner: false, teams: ["Announcements", "Contractors", "Design"]),
                       "in Design through Contractors")
        XCTAssertEqual(TeamStanding(members[2], teams: teams), TeamStanding(owner: false, teams: ["Announcements"]))
    }

    func testAStandingEndsOnACycleAndKeepsATeamTheListLacks() {
        let teams = [Team(id: "a", name: "A", teams: ["b"]), Team(id: "b", name: "B", teams: ["a"]), Team(id: "c", name: "C")]
        let standing = TeamStanding(ServerMember(accountId: "x", teams: ["a", "gone"]), teams: teams)
        XCTAssertEqual(standing, TeamStanding(owner: false, teams: ["A", "B", "gone"]))
    }

    /// Only custom teams hold teams: a derived one that says otherwise
    /// gives nothing.
    func testOnlyCustomTeamsHoldTeams() {
        let teams = [Team(id: "members", kind: .members, name: "Members", teams: ["design"]), Team(id: "design", name: "Design")]
        XCTAssertEqual(TeamStanding(ServerMember(accountId: "x", teams: ["design"]), teams: teams).teams, ["Design"])
        XCTAssertEqual(TeamStanding(ServerMember(accountId: "y"), teams: teams).teams, [])
    }
}
