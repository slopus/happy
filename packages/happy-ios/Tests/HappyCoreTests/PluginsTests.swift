import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// A Happy Cloud server's plugins (happy-cluster API.md, "Plugins"): the
/// catalog by name, the team's installations with what each still needs,
/// and the writes that change them.
final class PluginsTests: XCTestCase {
    static let catalog = #"""
    {"plugins":[
      {"id":"linear","name":"Linear","description":"Issues.","version":"0.2.0","image":null,"tools":[],
       "auth":{"required":false,"methods":[]}},
      {"id":"github","name":"GitHub","description":"Repositories, issues and pull requests.","version":"1.0.0",
       "image":{"digest":"ab12","mime":"image/png","thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"},
       "tools":[{"name":"list_repos","summary":"Lists repositories."},{"name":"get_issue"}],
       "auth":{"required":true,"methods":[
         {"id":"install","label":"Install the GitHub App","type":"oauth","scopes":["repo"]},
         {"id":"token","label":"Personal access token","type":"fields","fields":[
           {"key":"token","label":"Token","help":"From github.com/settings/tokens.","required":true,"secret":true,"multiline":false}]},
         {"id":"later","label":"Something newer","type":"passkey"}]}},
      {"name":"No ID"}
    ]}
    """#

    static let installations = #"""
    {"installations":[
      {"id":"i1","plugin":"github","pluginName":"GitHub","ordinal":1,"label":null,"status":"active","reason":null,
       "authMethod":"token","toolPrefix":"plugin_github_","image":{"digest":"ab12","mime":"image/png","thumbhash":null},"available":true},
      {"id":"i2","plugin":"github","pluginName":"GitHub","ordinal":2,"label":"Acme","status":"not_configured","reason":"method_unavailable",
       "authMethod":"install","toolPrefix":"plugin_github_2_","image":null,"available":true},
      {"id":"i3","plugin":"github","pluginName":"GitHub","ordinal":3,"label":null,"status":"not_configured","reason":null,
       "authMethod":null,"toolPrefix":"plugin_github_3_","image":null,"available":true},
      {"id":"i4","plugin":"jira","pluginName":null,"ordinal":1,"label":null,"status":"active","reason":null,
       "authMethod":null,"toolPrefix":"plugin_jira_","image":null,"available":false}
    ]}
    """#

    func testACloudServerListsPluginsUnderArtifacts() throws {
        let json = #"{"cursor":"c","profile":{"userId":"me"},"userSettings":[],"projects":[],"workspaces":[],"surfaces":[]}"#
        let desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(json.utf8))
        let cloud = SidebarRows.make(desktop, settings: [:], plugins: true).prefix(3).map(\.id)
        XCTAssertEqual(cloud, ["direct:artifacts", "direct:plugins", "direct:todos"])
        XCTAssertFalse(SidebarRows.make(desktop, settings: [:]).contains { $0.targetKind == "plugins" }, "a computer listed plugins")
    }

    func testTheCatalogIsByNameAndKeepsWhatItCanRead() async throws {
        let server = ProvidersServer()
        await server.answer("GET /v0/plugins", 200, Self.catalog)
        await server.answer("GET /v0/plugins/installations", 200, Self.installations)
        let catalog = try await AgentClient(transport: server, token: "t").pluginCatalog()
        XCTAssertEqual(catalog.plugins.map(\.id), ["github", "linear"], "an entry without an ID was kept, or the order isn't by name")
        XCTAssertTrue(catalog.canManage, "installations were readable, so the reader manages")
        let github = try XCTUnwrap(catalog.plugin("github"))
        XCTAssertEqual(github.image?.path, "/v0/plugins/images/ab12")
        XCTAssertEqual(github.tools, [.init(name: "list_repos", summary: "Lists repositories."), .init(name: "get_issue", summary: "")])
        XCTAssertEqual(github.authMethods, [
            .oauth(id: "install", label: "Install the GitHub App", scopes: ["repo"]),
            .fields(id: "token", label: "Personal access token", fields: [
                .init(key: "token", label: "Token", help: "From github.com/settings/tokens.", required: true, secret: true)]),
        ], "a method of a kind this build doesn't know was offered")
        XCTAssertTrue(github.authRequired)
    }

    func testEachInstallationSaysWhatItNeeds() async throws {
        let server = ProvidersServer()
        await server.answer("GET /v0/plugins", 200, Self.catalog)
        await server.answer("GET /v0/plugins/installations", 200, Self.installations)
        let catalog = try await AgentClient(transport: server, token: "t").pluginCatalog()
        let installations = try XCTUnwrap(catalog.installations)
        XCTAssertEqual(installations.map(\.title), ["GitHub", "GitHub · Acme", "GitHub 3", "jira"])
        XCTAssertEqual(installations.map(\.status), [.active, .methodUnavailable, .notConfigured, .active])
        XCTAssertEqual(installations.map(\.isSignedIn), [true, false, false, false])
        let methods = try XCTUnwrap(catalog.plugin("github")).authMethods
        XCTAssertEqual(installations.map(catalog.setup), [.ready, .signIn(methods), .signIn(methods), .unavailable])
        XCTAssertEqual(catalog.installations(of: "github").map(\.id), ["i1", "i2", "i3"])
        XCTAssertEqual(catalog.name(of: "jira"), "jira", "a plugin the server no longer offers is named by its ID")
    }

    func testAMemberWhoCantReadInstallationsCantManage() async throws {
        let server = ProvidersServer()
        await server.answer("GET /v0/plugins", 200, Self.catalog)
        await server.answer("GET /v0/plugins/installations", 403, #"{"error":"This needs the mcp.manage permission.","code":"forbidden"}"#)
        let catalog = try await AgentClient(transport: server, token: "t").pluginCatalog()
        XCTAssertNil(catalog.installations)
        XCTAssertFalse(catalog.canManage)
        XCTAssertEqual(catalog.plugins.count, 2)

        await server.answer("GET /v0/plugins/installations", 200, #"{"installations":[],"canManage":false}"#)
        let readable = try await AgentClient(transport: server, token: "t").pluginCatalog()
        XCTAssertEqual(readable.installations, [])
        XCTAssertFalse(readable.canManage, "the server's own canManage decides once it says")
    }

    func testInstallSendsThePluginAndAnswersTheInstallation() async throws {
        let server = ProvidersServer()
        await server.answer("POST /v0/plugins/installations", 201, #"""
        {"installation":{"id":"i9","plugin":"github","pluginName":"GitHub","ordinal":4,"label":null,"status":"not_configured","reason":null,"authMethod":null,"toolPrefix":"plugin_github_4_","image":null,"available":true}}
        """#)
        let installation = try await AgentClient(transport: server, token: "t").installPlugin("github")
        XCTAssertEqual(installation.id, "i9")
        XCTAssertEqual(installation.status, .notConfigured)
        let bodies = await server.rawBodies
        XCTAssertEqual(bodies.last, .object(["plugin": .string("github")]))
    }

    func testRefusedFieldsSayWhatIsWrongWithEach() async throws {
        let server = ProvidersServer()
        await server.answer("POST /v0/plugins/installations/i3/configure", 422,
                            #"{"code":"invalid_fields","error":"GitHub refused the token.","fields":{"token":"GitHub didn’t accept this token."}}"#)
        let client = AgentClient(transport: server, token: "t")
        do {
            _ = try await client.configurePluginInstallation("i3", method: "token", values: ["token": "ghp_bad"])
            XCTFail("a refused token was taken")
        } catch let refusal as PluginFieldsRefusal {
            XCTAssertEqual(refusal, PluginFieldsRefusal(message: "GitHub refused the token.", fields: ["token": "GitHub didn’t accept this token."]))
        }
        let bodies = await server.rawBodies
        XCTAssertEqual(bodies.last, .object(["method": .string("token"), "values": .object(["token": .string("ghp_bad")])]))

        await server.answer("POST /v0/plugins/installations/i3/configure", 400, #"{"code":"invalid","error":"A method of another kind."}"#)
        do {
            _ = try await client.configurePluginInstallation("i3", method: "install", values: [:])
            XCTFail("a refusal was taken")
        } catch let error as AgentClientError {
            XCTAssertEqual(error, .status(400, code: "invalid", message: "A method of another kind."))
        }
    }

    func testConnectTakesOnlyAnHttpsPage() async throws {
        let server = ProvidersServer()
        let client = AgentClient(transport: server, token: "t")
        await server.answer("POST /v0/plugins/installations/i3/connect", 200, #"{"authorizeUrl":"https://github.com/apps/happy/installations/new?state=s"}"#)
        let url = try await client.connectPluginInstallation("i3", method: "install")
        XCTAssertEqual(url.absoluteString, "https://github.com/apps/happy/installations/new?state=s")
        await server.answer("POST /v0/plugins/installations/i3/connect", 200, #"{"authorizeUrl":"javascript:alert(1)"}"#)
        do {
            _ = try await client.connectPluginInstallation("i3", method: "install")
            XCTFail("a page that isn't https was taken")
        } catch let error as AgentClientError {
            XCTAssertEqual(error, .invalidResponse)
        }
    }

    func testRemovingOneAlreadyGoneCountsAsRemoved() async throws {
        let server = ProvidersServer()
        let client = AgentClient(transport: server, token: "t")
        try await client.removePluginInstallation("gone")
        await server.answer("DELETE /v0/plugins/installations/i1", 500, #"{"code":"internal","error":"Boom."}"#)
        do {
            try await client.removePluginInstallation("i1")
            XCTFail("a failed removal counted as removed")
        } catch let error as AgentClientError {
            XCTAssertEqual(error.status, 500)
        }
    }
}
