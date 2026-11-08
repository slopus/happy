import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// Adding inference providers on Happy Cloud (ONBOARDING-API v1): the
/// connections as listed, a key sent once to the right container, and the
/// server's sign-ins followed to their end without a token on the phone.
final class CloudProvidersTests: XCTestCase {
    func testTheListIsIncludedThenTeamThenMine() async throws {
        let server = ProvidersServer()
        await server.answer("GET /v0/cloud/providers", 200, #"""
        {"providers":[
          {"id":"private","name":"Personal","scope":"private","source":"tenant","vendors":["codex"],"models":["openai/gpt-6.1-terra"],"credentialCount":1,
           "credentials":[{"id":"k1","vendor":"codex","kind":"oauth","label":null,"enabled":true,"state":"ready"}]},
          {"id":"anthropic","name":"Anthropic","scope":"team","source":"tenant","vendors":[],"models":[],"credentialCount":1,"enabled":false},
          {"id":"operator:openai","name":"Happy (free)","scope":"team","source":"operator","vendors":["openai"],"models":["openai/gpt-6.1-terra"],"credentialCount":0}
        ]}
        """#)
        let providers = CloudProvider.sorted(try await AgentClient(transport: server, token: "t").cloudProviders())
        XCTAssertEqual(providers.map(\.id), ["operator:openai", "anthropic", "private"])
        XCTAssertEqual(providers.map(\.section), [.included, .team, .mine])
        XCTAssertEqual(providers.map(\.enabled), [true, false, true], "without `enabled`, a vendor that serves is on")
        XCTAssertEqual(providers[2].credentials?.first?.title, "ChatGPT")
    }

    func testWhatCanBeAddedFollowsTheServersCapabilities() async throws {
        let server = ProvidersServer()
        await server.answer("GET /v0/cloud/providers", 200, #"""
        {"providers":[],"capabilities":{"apiKeys":true,"claudeSetupToken":false,"codexSignIn":true,"claudeSignIn":false}}
        """#)
        let listing = try await AgentClient(transport: server, token: "t").cloudProviderListing()
        XCTAssertEqual(listing.offer, CloudAddOffer(apiKeys: true, setupToken: false, signIns: [.codex]))
        // Before the field lands: no word, so the caller asks /v0/provider-clis.
        await server.answer("GET /v0/cloud/providers", 200, #"{"providers":[]}"#)
        let older = try await AgentClient(transport: server, token: "t").cloudProviderListing()
        XCTAssertNil(older.offer)
        XCTAssertEqual(CloudAddOffer(), CloudAddOffer(apiKeys: true, setupToken: false, signIns: []), "without word: keys, and no setup token")
    }

    func testThePickersOfferConnectionsAndSendTheirExactIDs() {
        let terra = ModelCatalog.Model(id: "openai/gpt-6.1-terra", name: "GPT-6.1 Terra", efforts: ["low", "medium"], defaultEffort: "medium", serviceTiers: [])
        let base = ModelCatalog(defaultProviderId: "openai", defaultModelId: terra.id, models: [terra],
                                providers: [.init(id: "openai", name: nil, type: "openai", enabled: true, hidden: false, models: [terra])])
        let catalog = base.connections([
            CloudProvider(id: "private", name: "Personal", scope: .private, source: .tenant, vendors: ["codex"], models: [terra.id, "unknown/model"]),
            CloudProvider(id: "operator:openai", name: "Happy (free)", scope: .team, source: .operator, vendors: ["openai"], models: [terra.id]),
        ])
        XCTAssertEqual(catalog.providers.map(\.id), ["operator:openai", "private"])
        XCTAssertEqual(catalog.providers.map(\.name), ["Happy (free)", "My account"])
        XCTAssertEqual(catalog.providers[1].models.map(\.id), [terra.id], "a model the configuration doesn't define was offered")
        // The declared default isn't a connection: the first that serves.
        XCTAssertEqual(catalog.defaultMode().providerId, "operator:openai")
        XCTAssertEqual(catalog.select(providerId: "private", modelId: terra.id, from: catalog.defaultMode()).providerId, "private")
        XCTAssertEqual(base.connections([]), base)
    }

    func testDestinationsFollowTheRole() {
        let both = RoleGate.cloud(Permissions(granted: ["providers.own", "providers.manage"]))
        XCTAssertEqual(CloudProvider.destinations(both), [.mine, .team])
        XCTAssertEqual(CloudProvider.destinations(.cloud(Permissions(granted: ["providers.own"]))), [.mine])
        XCTAssertEqual(CloudProvider.destinations(.cloud(nil)), [])
        XCTAssertEqual(CloudProvider.Destination.team.container(vendor: "anthropic"), "anthropic")
        XCTAssertEqual(CloudProvider.Destination.mine.container(vendor: "anthropic"), "private")
    }

    func testAKeyGoesToItsContainerAndARefusalSaysWhy() async throws {
        let server = ProvidersServer()
        await server.answer("POST /v0/cloud/providers/private/credentials", 201, #"{"providerId":"private","credentialId":"k2","duplicate":false}"#)
        let client = AgentClient(transport: server, token: "t")
        try await client.addCloudCredential(container: "private", vendor: "openai", kind: "api_key", secret: "sk-test")
        let bodies = await server.bodies
        let sent = try XCTUnwrap(bodies.last)
        XCTAssertEqual(sent, ["vendor": "openai", "kind": "api_key", "secret": "sk-test"])

        await server.answer("POST /v0/cloud/providers/anthropic/credentials", 422,
                            #"{"error":{"code":"credential_check_failed","message":"The vendor rejected the credential."}}"#)
        do {
            try await client.addCloudCredential(container: "anthropic", vendor: "anthropic", kind: "api_key", secret: "bad")
            XCTFail("a refused key was taken")
        } catch let refusal as CloudCredentialRefusal {
            XCTAssertEqual(refusal, CloudCredentialRefusal(kind: "credential_check_failed", message: "The vendor rejected the credential."))
        }
    }

    func testTheDeviceSignInIsFollowedToItsEnd() async throws {
        let server = ProvidersServer()
        await server.answer("POST /v0/provider-clis/codex/sign-in", 200, Self.cli("waiting", code: "ABCD-1234"))
        await server.answer("GET /v0/provider-clis/codex", 200, Self.cli("waiting", code: "ABCD-1234"), then: Self.cli("succeeded", code: nil))
        let client = AgentClient(transport: server, token: "t")
        let started = try await client.startCloudSignIn(.codex, container: "private")
        XCTAssertEqual(started.userCode, "ABCD-1234")
        XCTAssertEqual(started.url, URL(string: "https://auth.openai.com/codex/device"))
        XCTAssertFalse(started.ended)
        let bodies = await server.bodies, raw = await server.rawBodies
        let start = try XCTUnwrap(bodies.first)
        XCTAssertEqual(start["method"], "device")
        XCTAssertNotNil(start["mutationId"])
        let target = try XCTUnwrap(raw.first?["target"])
        XCTAssertEqual(target, .object(["scope": .string("private")]))
        let done = try await client.waitForCloudSignIn(started, sleep: { _ in })
        XCTAssertEqual(done.status, .succeeded)
        XCTAssertEqual(done.providerId, "private")
    }

    func testClaudesCodeIsPastedBackAndAFailureReadsAsTheServerSays() async throws {
        let server = ProvidersServer()
        await server.answer("POST /v0/provider-clis/claude/sign-in/code", 200, Self.cli("failed", code: nil, error: #"{"code":"sign_in_failed","message":null}"#))
        let client = AgentClient(transport: server, token: "t")
        let result = try await client.finishCloudSignIn(.claude, code: "abc#def")
        XCTAssertEqual(result.status, .failed)
        XCTAssertEqual(result.failureText, "Claude didn’t accept the sign-in. Try again.")
        let bodies = await server.bodies
        XCTAssertEqual(bodies.first?["code"], "abc#def")
    }

    func testANotYetMountedSignInIsHidden() async throws {
        let server = ProvidersServer()
        await server.answer("POST /v0/provider-clis/codex/sign-in", 501, #"{"error":"Not on this server.","code":"machine_local"}"#)
        do {
            _ = try await AgentClient(transport: server, token: "t").startCloudSignIn(.codex, container: "private")
            XCTFail()
        } catch {
            XCTAssertTrue(AgentClient.unavailable(error))
        }
        XCTAssertFalse(AgentClient.unavailable(AgentClientError.status(403, code: "forbidden", message: nil)))
    }

    func testAnOnlyHTTPSPageOpens() {
        XCTAssertNil(CloudSignIn(cli: .codex, .object(["operation": .object([
            "id": .string("o"), "status": .string("waiting"),
            "authorization": .object(["url": .string("javascript:alert(1)")]),
        ])]))?.url)
    }

    func testProviderLinksCarryOnlyTheirChoices() {
        XCTAssertEqual(HappyLink("happy://settings/providers/add")?.target, .settings(.providersAdd))
        let key = HappyLink("happy://settings/providers/add/api-key?vendor=anthropic&to=team")
        XCTAssertEqual(key?.target, .settings(.providersAddAPIKey))
        XCTAssertEqual(key?.providerOptions, .init(vendor: "anthropic", destination: "team"))
        XCTAssertEqual(key?.url, "happy://settings/providers/add/api-key?vendor=anthropic&to=team")
        XCTAssertEqual(HappyLink("happy://settings/providers/add/openai?to=private")?.providerOptions.destination, "private")
        for url in ["happy://settings/providers/add?code=x", "happy://settings/providers/add/openai?vendor=openai",
                    "happy://settings/providers/add/api-key?vendor=grok", "happy://settings/providers/add?to=team&to=private",
                    "happy://settings/providers?to=team"] {
            XCTAssertNil(HappyLink(url), url)
        }
    }

    static func cli(_ status: String, code: String?, error: String = "null") -> String {
        """
        {"providerCli":{"id":"codex","operation":{"id":"q7","kind":"sign_in","status":"\(status)",
          "authorization":{"method":"device","url":"https://auth.openai.com/codex/device","userCode":\(code.map { "\"\($0)\"" } ?? "null"),"acceptsCode":false,"expiresAt":1755400600000},
          "target":{"providerId":"private"},"credentialId":null,"error":\(error)}}}
        """
    }
}

actor ProvidersServer: AgentTransport {
    private var answers: [String: [(Int, String)]] = [:]
    private(set) var rawBodies: [JSONValue] = []
    var bodies: [[String: String]] {
        rawBodies.map { ($0.objectValue ?? [:]).compactMapValues(\.stringValue) }
    }

    func answer(_ route: String, _ status: Int, _ body: String, then: String? = nil) {
        answers[route] = [(status, body)] + (then.map { [(status, $0)] } ?? [])
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        if let body { rawBodies.append(try JSONValue.decode(body)) }
        let route = "\(method) \(path)"
        guard var queue = answers[route], let first = queue.first else { return .init(status: 404, body: Data(#"{"error":"Not found.","code":"not_found"}"#.utf8)) }
        if queue.count > 1 { queue.removeFirst(); answers[route] = queue }
        return .init(status: first.0, body: Data(first.1.utf8))
    }

    func close() {}
}
