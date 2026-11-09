#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

/// A team server that finds Ada by name (`POST /v0/search`'s `user`
/// result), names her picture (`GET /v0/users`) and serves her profile;
/// her role is one the team made, named by `GET /v0/roles` unless
/// `rolesFail`.
private struct PeopleTransport: AgentTransport {
    var rolesFail = false

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        if path == "/v0/health" { return HTTP1Response(status: 200, body: Data(#"{"ok":true,"capabilities":{"search":true}}"#.utf8)) }
        if path == "/v0/search" {
            return HTTP1Response(status: 200, body: Data(#"""
            {"results":[{"type":"agent","key":"agent:a9","rank":1,"agentId":"a9","workspaceId":"w9","kind":"task","title":"Ada's notes"},
                        {"type":"user","key":"user:ada","rank":2,"userId":"ada","name":"Ada Lovelace"}],"truncated":false,"partial":false}
            """#.utf8))
        }
        if path.hasPrefix("/v0/users?ids=") {
            return HTTP1Response(status: 200, body: Data(#"{"users":[{"id":"ada","name":"Ada Lovelace","photo":{"thumbhash":"HBkSHYSIeHiPiHh8eJd4eTN0EEQG"}}]}"#.utf8))
        }
        if path == "/v0/roles" {
            if rolesFail { return HTTP1Response(status: 500) }
            return HTTP1Response(status: 200, body: Data(#"{"roles":[{"id":"owner","name":"Owner","builtIn":true},{"id":"r_7f3a","name":"Designers","builtIn":false}]}"#.utf8))
        }
        if path.hasPrefix("/v0/users/ada/profile") {
            return HTTP1Response(status: 200, body: Data(#"""
            {"user":{"id":"ada","name":"Ada Lovelace","photo":{"thumbhash":"HBkSHYSIeHiPiHh8eJd4eTN0EEQG"},"role":"Design lead","teamRole":"r_7f3a"},
             "stats":{"tasks":{"total":12,"active":3},"lastActivityAt":null,"activeDays":14,
                      "usage":{"hour":{},"day":{"anthropic":{"opus":{"input":1000,"cacheRead":0,"cacheWrite":0,"output":200,"reasoning":0}}},"week":{},"month":{}}},
             "recentTasks":[{"id":"t1","name":"Ship the profile","agent":{"id":"a1","workspaceId":"w1","status":"idle"}}]}
            """#.utf8))
        }
        return HTTP1Response(status: 404)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.notConnectedToInternet) }
    func reset() async {}
    func close() async {}
}

@MainActor
final class HostedUserProfileTests: XCTestCase {
    private func rig(server: String?, rolesFail: Bool = false) async throws -> (AppContext, String) {
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "people-test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in PeopleTransport(rolesFail: rolesFail) })
        await account.agentConnections.setForeground(false)
        let connection: AgentConnection
        if let server {
            connection = try await account.agentConnections.addServer(AgentOrigin(server),
                signIn: ServerSignInRecord(method: HappyCloud.method(server: server), grant: OAuthGrant(clientId: "test"), userId: "me"),
                access: OAuthAccess(token: "test", expiresAt: nil), name: "People test")
        } else {
            let credentials = try JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"people-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"test"}"#.utf8))
            connection = try await account.agentConnections.add(credentials, name: "Paired test")
        }
        addTeardownBlock { @MainActor in
            Session.forget(connection.id)
            try? await account.agentConnections.remove(connection.id)
        }
        return (AppContext(account: account, variant: .preview, version: "test"), connection.id)
    }

    private func host(_ controller: UIViewController) async throws -> UINavigationController {
        let navigation = UINavigationController(rootViewController: controller)
        let scene = try await hostedActiveScene()
        let previous = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in window.isHidden = true; previous?.makeKey() }
        window.layoutIfNeeded()
        return navigation
    }

    private func until(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition())
    }

    private func search(_ server: String?, rolesFail: Bool = false) async throws -> (HomeViewController, HomeSearchResultsView, UINavigationController) {
        let (context, id) = try await rig(server: server, rolesFail: rolesFail)
        let home = HomeViewController(context: context, computer: id)
        let navigation = try await host(home)
        home.beginSearch()
        home.search("Ada")
        let results = try XCTUnwrap(home.view.subviews.compactMap { $0 as? HomeSearchResultsView }.first)
        // The computer answered: its task is among what was found.
        try await until { results.list.shownRows.contains { $0.id == "found:agent:a9" } }
        return (home, results, navigation)
    }

    func testCloudSearchListsPeopleWithTheirPictureAndOpensTheirProfile() async throws {
        let (_, results, navigation) = try await search(HappyCloud.server(named: "people-test"))
        try await until { results.list.shownRows.first { $0.id == "search:people:ada" }?.mark == .image(path: "/v0/users/ada/photo", thumbhash: "HBkSHYSIeHiPiHh8eJd4eTN0EEQG") }
        let rows = results.list.shownRows
        let heading = try XCTUnwrap(rows.firstIndex { $0.id == "search:people" })
        XCTAssertEqual(rows[heading].label, "People")
        XCTAssertEqual(rows[heading + 1].id, "search:people:ada")
        XCTAssertEqual(rows[heading + 1].label, "Ada Lovelace")

        results.list.onSelect?(rows[heading + 1])
        try await until { navigation.topViewController is UserProfileViewController }
        let profile = try XCTUnwrap(navigation.topViewController as? UserProfileViewController)
        try await until { profile.shownTiles.first == "12" }
        XCTAssertEqual(profile.shownTiles, ["12", "3", "14 of 30", "—"])
        XCTAssertEqual(profile.header.name.text, "Ada Lovelace")
        XCTAssertEqual(profile.header.subtitle.text, "Design lead · Designers", "the team's own role, by the name it gave it")
        XCTAssertEqual(profile.shownTaskCount, 1)

        profile.selectTask(0)
        try await until { navigation.topViewController is ChatViewController }
    }

    func testARoleTheTeamCantNameShowsItsID() async throws {
        let (_, results, navigation) = try await search(HappyCloud.server(named: "people-roles-test"), rolesFail: true)
        try await until { results.list.shownRows.contains { $0.id == "search:people:ada" } }
        let row = try XCTUnwrap(results.list.shownRows.first { $0.id == "search:people:ada" })
        results.list.onSelect?(row)
        try await until { (navigation.topViewController as? UserProfileViewController)?.shownTiles.first == "12" }
        let profile = try XCTUnwrap(navigation.topViewController as? UserProfileViewController)
        XCTAssertEqual(profile.header.subtitle.text, "Design lead · r_7f3a")
    }

    func testAComputerOfOnesOwnShowsNoPeople() async throws {
        let (_, results, _) = try await search(nil)
        XCTAssertFalse(results.list.shownRows.contains { $0.id.hasPrefix("search:people") })
    }
}
#endif
