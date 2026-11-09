import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// A team member's profile on a Happy Cloud server (happy-cluster
/// `GET /v0/users/:id/profile`) and the people search finds there: the
/// route as asked, the answer as read, the tokens summed for display.
final class UserProfileTests: XCTestCase {
    private actor ProfileServer: AgentTransport {
        private(set) var paths: [String] = []
        var status = 200

        func refuse(_ status: Int) { self.status = status }

        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            paths.append("\(method) \(path)")
            if path == "/v0/roles" {
                return HTTP1Response(status: 200, body: Data(#"""
                {"roles":[{"id":"owner","name":"Owner","builtIn":true},{"id":"r_7f3a","name":"Designers","builtIn":false},{"id":7}]}
                """#.utf8))
            }
            switch status {
            case 403: return HTTP1Response(status: 403, body: Data(#"{"error":"Profiles need the profiles permission.","code":"profile_required"}"#.utf8))
            case 404: return HTTP1Response(status: 404, body: Data(#"{"error":"No such user.","code":"not_found"}"#.utf8))
            default: return HTTP1Response(status: 200, body: Data(UserProfileTests.profile.utf8))
            }
        }

        func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.cannotConnectToHost) }
        func reset() async {}
        func close() async {}
    }

    static let profile = #"""
    {"user":{"id":"ada","name":"Ada Lovelace","photo":{"thumbhash":"HBkSHYSIeHiPiHh8eJd4eTN0EEQG"},"version":"0199a000-0000-7000-8000-000000000001",
             "updatedAt":1,"kind":"member","canLogIn":true,"role":"Design lead","follows":null,"teamRole":"owner"},
     "stats":{"tasks":{"total":12,"active":3},"lastActivityAt":1762560000000,"activeDays":14,
              "usage":{"hour":{"anthropic":{"claude-opus":{"input":1000,"cacheRead":200,"cacheWrite":30,"output":400,"reasoning":5}}},
                       "day":{"anthropic":{"claude-opus":{"input":10000,"cacheRead":2000,"cacheWrite":300,"output":4000,"reasoning":50}},
                              "openai":{"gpt-6":{"input":500,"cacheRead":0,"cacheWrite":0,"output":250,"reasoning":250,"images":2}}},
                       "week":{},"month":"garbled"}},
     "recentTasks":[
       {"id":"t1","name":"Ship the iOS profile","version":"1","agent":{"id":"a1","workspaceId":"w1","status":"thinking","lastActivityAt":1762560000000}},
       {"id":"broken","name":7},
       {"id":"t2","name":"Fix login","agent":{"id":"a2","workspaceId":"w2","status":"idle","archivedAt":1}}]}
    """#

    func testTheProfileIsAskedForByIdAndLimit() async throws {
        let server = ProfileServer()
        let client = AgentClient(transport: server, token: "t")
        _ = try await client.userProfile("ada lovelace")
        _ = try await client.userProfile("ada", limit: 500)
        let paths = await server.paths
        XCTAssertEqual(paths, ["GET /v0/users/ada%20lovelace/profile?limit=10", "GET /v0/users/ada/profile?limit=50"])
    }

    func testTheProfileIsReadAsTheClusterWritesIt() async throws {
        let profile = try await AgentClient(transport: ProfileServer(), token: "t").userProfile("ada")
        XCTAssertEqual(profile.user, AgentWire.ProfileUser(id: "ada", name: "Ada Lovelace", photo: .init(thumbhash: "HBkSHYSIeHiPiHh8eJd4eTN0EEQG"), role: "Design lead", teamRole: "owner"))
        XCTAssertEqual(profile.stats.tasks, .init(total: 12, active: 3))
        XCTAssertEqual(profile.stats.activeDays, 14)
        XCTAssertEqual(profile.stats.lastActivityAt, 1762560000000)
        XCTAssertEqual(profile.recentTasks.map(\.id), ["t1", "t2"], "a task it can't read is left out, never the profile")
        XCTAssertEqual(profile.recentTasks.first?.agent?.id, "a1")
    }

    /// Input and output, summed across providers and models: input holds
    /// the cached tokens and output the reasoning ones (happy-cluster
    /// `metering.rs`), so neither is counted twice.
    func testTokensAreInputAndOutputSummedAcrossProvidersAndModels() async throws {
        let stats = try await AgentClient(transport: ProfileServer(), token: "t").userProfile("ada").stats
        XCTAssertEqual(stats.tokens(.hour), 1000 + 400)
        XCTAssertEqual(stats.tokens(.day), 10000 + 4000 + 500 + 250)
        XCTAssertEqual(stats.tokens(.week), 0)
        XCTAssertEqual(stats.tokens(.month), 0, "a window it can't read counts nothing")
    }

    func testCacheAndReasoningNeverAddToTheTotal() throws {
        let stats = try JSONDecoder().decode(AgentWire.UserProfile.Stats.self, from: Data(#"""
        {"tasks":{"total":1,"active":0},"activeDays":1,"usage":{"week":{
          "anthropic":{"claude-opus":{"input":2000,"cacheRead":900000000,"cacheWrite":80000000,"output":300,"reasoning":700000000}},
          "openai":{"gpt-6":{"input":50,"cacheRead":40,"cacheWrite":0,"output":20,"reasoning":10}}}}}
        """#.utf8))
        XCTAssertEqual(stats.tokens(.week), 2000 + 300 + 50 + 20)
    }

    func testTheTeamsRolesAreReadByName() async throws {
        let server = ProfileServer()
        let roles = try await AgentClient(transport: server, token: "t").teamRoles()
        XCTAssertEqual(roles, [TeamRole(id: "owner", name: "Owner"), TeamRole(id: "r_7f3a", name: "Designers")], "a role it can't read is left out")
        let paths = await server.paths
        XCTAssertEqual(paths, ["GET /v0/roles"])
    }

    func testAProfileWithoutStatsStillReads() throws {
        let profile = try JSONDecoder().decode(AgentWire.UserProfile.self, from: Data(#"{"user":{"id":"bo","name":"Bo","photo":null,"teamRole":null}}"#.utf8))
        XCTAssertEqual(profile.user.name, "Bo")
        XCTAssertNil(profile.user.teamRole)
        XCTAssertEqual(profile.stats, .init())
        XCTAssertEqual(profile.recentTasks, [])
    }

    func testARefusalKeepsItsStatus() async throws {
        let server = ProfileServer()
        let client = AgentClient(transport: server, token: "t")
        await server.refuse(403)
        do {
            _ = try await client.userProfile("ada")
            XCTFail("a refused profile was read")
        } catch let error as AgentClientError {
            XCTAssertEqual(error, .status(403, code: "profile_required", message: "Profiles need the profiles permission."))
        }
        await server.refuse(404)
        do {
            _ = try await client.userProfile("zed")
            XCTFail("an unknown member was read")
        } catch let error as AgentClientError {
            XCTAssertEqual(error.status, 404)
        }
    }

    /// The computer's `user` results, as search lists them under People.
    func testSearchFindsPeopleInTheComputersOrderEachOnce() throws {
        let results = try JSONDecoder().decode([Search.Result].self, from: Data(#"""
        [{"type":"agent","key":"agent:a1","rank":1,"agentId":"a1","title":"Ada's task"},
         {"type":"user","key":"user:ada","rank":2,"userId":"ada","name":"Ada Lovelace"},
         {"type":"user","key":"user:bo","rank":3,"userId":"bo","name":"Bo"},
         {"type":"user","key":"user:ada-again","rank":4,"userId":"ada","name":"Ada"},
         {"type":"user","key":"user:nobody","rank":5,"name":"No ID"}]
        """#.utf8))
        XCTAssertEqual(Search.people(results), [.init(userId: "ada", name: "Ada Lovelace"), .init(userId: "bo", name: "Bo")])
        XCTAssertEqual(Search.people(results, limit: 1).map(\.userId), ["ada"])
        XCTAssertNil(Search.shown(results[1], names: .init()), "a person isn't among what was found: they have People")
    }
}
