import Foundation
@testable import HappyCore
import HappyWire
import XCTest

/// happy-agent's `docs/genui/render/conformance/actions.json` (copied at
/// 26d1619): which elements each host enables, for every action type.
final class GenUIActionsTests: XCTestCase {
    private static let hosts: [String: GenUIHost] = [
        "happy_agent": GenUIHost(server: .happyAgent, origin: true, secretActions: true, plugins: true),
        "happy_agent_without_origin": GenUIHost(server: .happyAgent, origin: false, secretActions: true, plugins: true),
        "cluster": GenUIHost(server: .cluster, origin: true, secretActions: true, plugins: true),
    ]

    private func conformance() throws -> (document: GenUIRenderDocument, cases: [JSONValue]) {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "actions", withExtension: "json", subdirectory: "Fixtures/GenUI/conformance"))
        let file = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        return (try XCTUnwrap(file["document"].flatMap(GenUIRenderDocument.parse)), try XCTUnwrap(file["cases"]?.arrayValue))
    }

    /// Every element the document draws, by key, with its action.
    private func actions(_ node: GenUINode) -> [String: GenUIAction?] {
        switch node.kind {
        case .box(_, let children): return children.map(actions).reduce(into: [:]) { $0.merge($1) { a, _ in a } }
        case .press(let press, _): return [node.key: press.action]
        case .button(let button): return [node.key: button.action]
        default: return [:]
        }
    }

    func testEveryHostEnablesWhatTheConformanceCasesSay() throws {
        let (document, cases) = try conformance()
        let drawn = actions(try XCTUnwrap(document.tree()))
        XCTAssertEqual(cases.count, 14)
        XCTAssertEqual(drawn.count, cases.count, "nothing is dropped")
        for item in cases {
            let element = try XCTUnwrap(item["element"]?.stringValue)
            let action = try XCTUnwrap(drawn[element] ?? nil, element)
            for (name, enabled) in try XCTUnwrap(item["enabled"]?.objectValue) {
                let host = try XCTUnwrap(Self.hosts[name], name)
                XCTAssertEqual(host.enables(action), enabled.boolValue, "\(element) on \(name)")
            }
        }
    }

    func testAHostThatDoesNotReportACapabilityDisablesItsActions() throws {
        let (document, _) = try conformance()
        let drawn = actions(try XCTUnwrap(document.tree()))
        let quiet = GenUIHost(server: .happyAgent, origin: true, secretActions: false, plugins: false)
        XCTAssertFalse(quiet.enables(try XCTUnwrap(drawn["secret"] ?? nil)))
        XCTAssertFalse(quiet.enables(try XCTUnwrap(drawn["plugin"] ?? nil)))
        XCTAssertTrue(quiet.enables(try XCTUnwrap(drawn["message"] ?? nil)))
    }

    func testPrefillsAreReadAsTheFormStartsWithThem() throws {
        let (document, _) = try conformance()
        let drawn = actions(try XCTUnwrap(document.tree()))
        XCTAssertEqual(drawn["secret"], .secret(GenUISecretPrefill(id: "stripe", description: "Stripe test-mode keys", variables: [
            .init(name: "STRIPE_SECRET_KEY", description: "Secret key, starts with sk_test_"),
        ])))
        guard case .clusterSecret(let endpoint)?? = drawn["cluster-secret"], case .clusterSecret(let key)?? = drawn["cluster-ssh-key"] else { return XCTFail("cluster secrets") }
        XCTAssertEqual(endpoint.kind, .endpoint)
        XCTAssertEqual(endpoint.name, "Stripe API")
        XCTAssertEqual(endpoint.owner, .team)
        XCTAssertEqual(endpoint.uses, ["egress"])
        XCTAssertEqual(endpoint.metadata?["targets"]?.arrayValue?.first?["host"], .string("api.stripe.com"))
        XCTAssertEqual(key.kind, .sshKey)
        XCTAssertNil(key.owner)
        XCTAssertEqual(drawn["plugin"], .plugin(id: "linear"))
        for broken in ["unknown", "secret-without-variables", "secret-with-value", "cluster-secret-with-value", "press-unknown"] {
            XCTAssertEqual(drawn[broken], .unsupported, broken)
        }
    }

    func testAPrefillBreakingItsSchemaIsNoAction() {
        func secret(_ fields: [String: JSONValue]) -> GenUIAction? {
            GenUIAction(.object(["type": .string("secret"), "secret": .object(fields)]))
        }
        let variable: JSONValue = .array([.object(["name": .string("KEY")])])
        XCTAssertEqual(secret(["variables": variable]), .secret(GenUISecretPrefill(variables: [.init(name: "KEY")])))
        XCTAssertEqual(secret(["variables": variable, "id": .string("A")]), .unsupported, "a name starts lowercase")
        XCTAssertEqual(secret(["variables": variable, "value": .string("x")]), .unsupported)
        XCTAssertEqual(secret(["variables": .array([.object(["name": .string("KEY")]), .object(["name": .string("key")])])]), .unsupported, "names are unique ignoring case")
        XCTAssertEqual(secret(["variables": .array([.object(["name": .string("1KEY")])])]), .unsupported)
        XCTAssertEqual(secret(["variables": .array(Array(repeating: .object(["name": .string("K")]), count: 65))]), .unsupported)

        func cluster(_ fields: [String: JSONValue]) -> GenUIAction? {
            GenUIAction(.object(["type": .string("cluster_secret"), "secret": .object(["type": .string("ssh_key"), "name": .string("Deploy")].merging(fields) { _, new in new })]))
        }
        guard case .clusterSecret = cluster([:]) else { return XCTFail("a cluster secret") }
        XCTAssertEqual(cluster(["uses": .array([.string("egress")])]), .unsupported, "uses fit the type")
        XCTAssertEqual(cluster(["owner": .string("everyone")]), .unsupported)
        XCTAssertEqual(cluster(["name": .string(" Deploy")]), .unsupported)
        XCTAssertEqual(cluster(["public": .string("x")]), .unsupported)
        XCTAssertEqual(cluster(["type": .string("password")]), .unsupported)
        XCTAssertEqual(GenUIAction(.object(["type": .string("plugin"), "plugin": .object([:])])), .unsupported)
        XCTAssertNil(GenUIAction(nil))
    }

    func testOnlyHttpsOpens() {
        let host = GenUIHost(server: .happyAgent, origin: false, secretActions: false, plugins: false)
        XCTAssertTrue(host.enables(.open("https://example.com")))
        XCTAssertTrue(host.enables(.open("HTTPS://example.com")))
        XCTAssertFalse(host.enables(.open("http://example.com")))
        XCTAssertFalse(host.enables(.open("javascript:alert(1)")))
        XCTAssertFalse(host.enables(.open("report.html")))
    }

    func testAVersionsOriginIsTheAgentThatMadeIt() throws {
        func origin(_ createdBy: String) throws -> String? {
            let json = #"{"artifactId":"a","number":2,"title":"t","files":[],"createdBy":\#(createdBy)}"#
            return try JSONDecoder().decode(AgentWire.ArtifactVersion.self, from: Data(json.utf8)).origin
        }
        XCTAssertEqual(try origin(#"{"kind":"agent","agentId":"a9","botId":null}"#), "a9")
        XCTAssertNil(try origin(#"{"kind":"user","userId":"u1"}"#))
        XCTAssertNil(try origin("null"))
        // Before authors had kinds: read, naming no agent.
        XCTAssertNil(try origin(#"{"userId":"u1","agentId":"a9"}"#))
        XCTAssertNil(try JSONDecoder().decode(AgentWire.ArtifactVersion.self, from: Data(#"{"artifactId":"a","number":1,"title":"t","files":[]}"#.utf8)).origin)
    }

    func testWhatAServerDoesNotReportItDoesNotServe() throws {
        func served(_ capabilities: String) throws -> GenUIServed {
            GenUIServed(try JSONDecoder().decode(AgentWire.Health.self, from: Data(#"{"ready":true,"capabilities":\#(capabilities)}"#.utf8)).capabilities)
        }
        XCTAssertEqual(try served(#"{"vaults":true}"#), GenUIServed(secretActions: false, plugins: false))
        XCTAssertEqual(try served(#"{"artifactSecretActions":true,"plugins":true}"#), GenUIServed(secretActions: true, plugins: true))
        XCTAssertEqual(GenUIServed(nil), GenUIServed())
    }

    /// What VoiceOver says of the controls, in every language, in its own words.
    func testEveryLanguageSaysTheControlsWords() async {
        for language in AppLanguage.supported.map(\.code) { _ = await TranslationCatalog.load(language) }
        let english = TranslationCatalog.genUISources["en"] ?? [:]
        XCTAssertEqual(Set(TranslationCatalog.genUISources.keys), Set(AppLanguage.supported.map(\.code)))
        XCTAssertEqual(english.count, 3)
        for language in AppLanguage.supported.map(\.code) {
            let words = TranslationCatalog.genUISources[language] ?? [:]
            let catalog = TranslationCatalog.catalog(for: language)
            XCTAssertEqual(Set(words.keys), Set(english.keys), language)
            for (key, text) in words {
                XCTAssertEqual(catalog(key), text, "\(language) \(key)")
                if language != "en" { XCTAssertNotEqual(text, english[key], "\(language) \(key) is English") }
            }
        }
    }

    /// The secret forms' words in every language, each its own but for
    /// names that stay as they are, with the same `${}` values.
    func testEveryLanguageSaysTheSecretFormsWords() async {
        for language in AppLanguage.supported.map(\.code) { _ = await TranslationCatalog.load(language) }
        let alike: Set<String> = [
            "native.genuiSecret.variables", "native.genuiClusterSecret.use.ssh", "native.genuiClusterSecret.use.git", "native.genuiClusterSecret.team",
            "native.genuiClusterSecret.server", "native.genuiClusterSecret.sshHosts", "native.genuiClusterSecret.method.password",
            "native.genuiClusterSecret.method.token", "native.genuiClusterSecret.portLabel", "native.genuiClusterSecret.portsLabel",
            "native.genuiClusterSecret.prefixLabel", "native.genuiClusterSecret.reposLabel", "native.genuiClusterSecret.passphraseLabel",
        ]
        func values(_ text: String) -> [String] { text.matches(of: /\$\{\w+\}/).map { String($0.output) }.sorted() }
        for (sources, count) in [(TranslationCatalog.genUISecretSources, 36), (TranslationCatalog.genUIClusterSecretSources, 66)] {
            let english = sources["en"] ?? [:]
            XCTAssertEqual(Set(sources.keys), Set(AppLanguage.supported.map(\.code)))
            XCTAssertEqual(english.count, count)
            for language in AppLanguage.supported.map(\.code) {
                let words = sources[language] ?? [:]
                let catalog = TranslationCatalog.catalog(for: language)
                XCTAssertEqual(Set(words.keys), Set(english.keys), language)
                for (key, text) in words {
                    // Each value given as itself, the words come back as written.
                    let given = Dictionary(values(text).map { (String($0.dropFirst(2).dropLast()), TranslationValue.text($0)) }) { first, _ in first }
                    XCTAssertEqual(catalog(key, given), text, "\(language) \(key)")
                    XCTAssertEqual(values(text), values(english[key] ?? ""), "\(language) \(key)")
                    if language != "en", !alike.contains(key) { XCTAssertNotEqual(text, english[key], "\(language) \(key) is English") }
                }
            }
        }
    }
}
