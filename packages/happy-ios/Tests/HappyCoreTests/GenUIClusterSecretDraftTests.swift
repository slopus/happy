import Foundation
@testable import HappyCore
import HappyWire
import XCTest

/// The Happy Cloud secret form as the person edits it, per type: a create
/// body of the action's type, or a change of the stored secret the action
/// names with its version, and what stops a save.
final class GenUIClusterSecretDraftTests: XCTestCase {
    private func prefill(_ json: String) throws -> GenUIClusterSecretPrefill {
        let action = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"type":"cluster_secret","secret":\#(json)}"#.utf8))
        guard case .clusterSecret(let prefill)? = GenUIAction(action) else { throw XCTSkip("not a cluster secret") }
        return prefill
    }

    func testAnEndpointIsACreateBodyWithAValuePerHeader() throws {
        var draft = GenUIClusterSecretDraft(try prefill(#"""
        {"type":"endpoint","name":"Stripe API","owner":"team","uses":["egress"],
         "public":{"targets":[{"host":"api.stripe.com","pathPrefixes":["/v1"]}],"algorithm":{"kind":"headers","headers":[{"name":"Authorization","prefix":"Bearer "}]}}}
        """#))
        XCTAssertEqual(draft.targets.map(\.host), ["api.stripe.com"])
        XCTAssertEqual(draft.targets.first?.paths, "/v1")
        XCTAssertEqual(draft.headers.map(\.prefix), ["Bearer "])
        XCTAssertEqual(draft.problems, [.value])
        draft.headers[0].value = "sk_live_1"
        draft.targets[0].methods = "get, post"
        XCTAssertEqual(draft.problems, [])
        XCTAssertEqual(draft.body(), .object([
            "type": .string("endpoint"), "name": .string("Stripe API"), "description": .string(""), "owner": .string("team"), "uses": .array([.string("egress")]),
            "public": .object([
                "targets": .array([.object(["host": .string("api.stripe.com"), "pathPrefixes": .array([.string("/v1")]), "methods": .array([.string("GET"), .string("POST")])])]),
                "algorithm": .object(["kind": .string("headers"), "headers": .array([.object(["name": .string("Authorization"), "prefix": .string("Bearer ")])])]),
            ]),
            "material": .object(["Authorization": .string("sk_live_1")]),
        ]))
        draft.forget()
        XCTAssertEqual(draft.headers[0].value, "")
    }

    func testAnSSHKeyAndAGitCredentialAskTheirMaterial() throws {
        var key = GenUIClusterSecretDraft(try prefill(#"{"type":"ssh_key","name":"Deploy key","uses":["ssh"],"public":{"hosts":["deploy.example.com"],"ports":[2222]}}"#))
        XCTAssertEqual(key.hosts, "deploy.example.com")
        XCTAssertEqual(key.sshPorts, "2222")
        XCTAssertEqual(key.problems, [.value])
        // Pasted into a one-line field, its line breaks came as spaces.
        key.privateKey = "-----BEGIN OPENSSH PRIVATE KEY----- \(String(repeating: "a", count: 80)) bb -----END OPENSSH PRIVATE KEY-----"
        XCTAssertEqual(key.problems, [])
        XCTAssertEqual(key.body()["public"], .object(["hosts": .array([.string("deploy.example.com")]), "ports": .array([.number(2222)])]))
        let lines = "-----BEGIN OPENSSH PRIVATE KEY-----\n\(String(repeating: "a", count: 70))\n\(String(repeating: "a", count: 10))bb\n-----END OPENSSH PRIVATE KEY-----\n"
        XCTAssertEqual(key.body()["material"], .object(["privateKey": .string(lines), "passphrase": .null]))
        key.sshPorts = "99999"
        XCTAssertEqual(key.problems, [.port])

        var git = GenUIClusterSecretDraft(try prefill(#"{"type":"git_credential","name":"GitLab","public":{"server":"gitlab.com","method":{"kind":"token","username":"oauth2"},"repos":["acme/*"],"operations":["read","write"]}}"#))
        XCTAssertEqual(git.uses, ["git"])
        XCTAssertEqual(git.method, .token)
        git.token = "glpat-1234567890abcdef"
        XCTAssertEqual(git.problems, [])
        XCTAssertEqual(git.body()["public"], .object([
            "server": .string("gitlab.com"), "method": .object(["kind": .string("token"), "username": .string("oauth2")]),
            "repos": .array([.string("acme/*")]), "operations": .array([.string("read"), .string("write")]),
        ]))
        XCTAssertEqual(git.body()["material"], .object(["token": .string("glpat-1234567890abcdef")]))
        git.method = .password
        git.password = "app-password-123456"
        XCTAssertEqual(git.body()["material"], .object(["password": .string("app-password-123456")]))
    }

    func testAnEnvironmentSecretNamesItsVariablesInItsMaterial() throws {
        var draft = GenUIClusterSecretDraft(try prefill(#"{"type":"environment","name":"Billing","public":{"variables":["STRIPE_KEY"]}}"#))
        XCTAssertEqual(draft.variables.map(\.name), ["STRIPE_KEY"])
        draft.addVariable()
        draft.variables[1].name = "stripe_key"
        draft.variables[0].value = "a"
        draft.variables[1].value = "b"
        XCTAssertEqual(draft.problems, [.variables])
        draft.variables[1].name = "WEBHOOK"
        XCTAssertEqual(draft.problems, [])
        XCTAssertNil(draft.body()["public"], "the cluster names them from the material")
        XCTAssertEqual(draft.body()["material"], .object(["STRIPE_KEY": .string("a"), "WEBHOOK": .string("b")]))
    }

    func testChangingTheNamedSecretSendsItsVersionAndKeepsWhatIsLeftEmpty() throws {
        let suggested = try prefill(#"{"type":"endpoint","id":"abcdefghijklmnopqrstuvwx","name":"Stripe API"}"#)
        var draft = GenUIClusterSecretDraft(suggested)
        let stored = ClusterSecret(id: "abcdefghijklmnopqrstuvwx", type: "endpoint", name: "Stripe", description: "Old", public: try JSONDecoder().decode(JSONValue.self, from: Data(
            #"{"targets":[{"host":"api.stripe.com","ports":[],"pathPrefixes":[],"methods":[]}],"algorithm":{"kind":"headers","headers":[{"name":"Authorization","prefix":"Bearer "}]}}"#.utf8)),
            uses: ["egress"], owner: "team", version: "v3")
        draft.adopt(stored, suggested: suggested)
        XCTAssertTrue(draft.changing)
        XCTAssertEqual(draft.name, "Stripe API")
        XCTAssertEqual(draft.description, "Old")
        XCTAssertEqual(draft.problems, [], "an empty value keeps the stored one")
        let body = draft.body()
        XCTAssertEqual(body["version"], .string("v3"))
        XCTAssertNil(body["type"])
        XCTAssertNil(body["owner"])
        XCTAssertNil(body["public"], "where the value goes didn't change")
        XCTAssertEqual(body["material"], .object(["Authorization": .null]))

        // A new host moves the value: it is asked for again.
        draft.targets[0].host = "api.stripe.dev"
        XCTAssertTrue(draft.movesValues)
        XCTAssertEqual(draft.problems, [.value])
        draft.headers[0].value = "sk_2"
        XCTAssertNotNil(draft.body()["public"])
    }

    func testWhatStopsASave() throws {
        var draft = GenUIClusterSecretDraft(try prefill(#"{"type":"endpoint","name":"API"}"#))
        draft.headers[0].value = "v"
        XCTAssertEqual(draft.problems, [.targets, .headers])
        draft.targets[0].host = "api.example.com"
        draft.headers[0].name = "X-Key"
        draft.name = " API"
        XCTAssertEqual(draft.problems, [.name])
        draft.name = "API"
        draft.uses = []
        XCTAssertEqual(draft.problems, [.uses])
        draft.uses = ["ssh"]
        XCTAssertEqual(draft.problems, [.uses])
    }
}
