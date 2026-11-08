import XCTest
@testable import HappyWire

/// The cases of happy-agent-client's `happyLinks.test.ts` this port shares.
final class HappyLinkTests: XCTestCase {
    private let id = "rg799k2m9q4w1e5t8y3u6i0o"
    private let agent = "a1b2c3d4"
    private let workspace = "k2h4j5l6"
    private let instance = "k3x9q2m7p0a4b8c1d5e6f7g2"

    func testEntitiesParseAndFormat() {
        for kind in HappyLink.Kind.allCases where kind != .service {
            let url = "happy://\(kind.rawValue)s/\(id)"
            XCTAssertEqual(HappyLink(url), HappyLink(.reference(.init(kind: kind, id: id))), url)
            XCTAssertEqual(HappyLink(.reference(.init(kind: kind, id: id))).url, url)
        }
        let versioned = HappyLink(.reference(.init(kind: .artifact, id: id, version: 12)))
        XCTAssertEqual(HappyLink("happy://artifacts/\(id)?version=12"), versioned)
        XCTAssertEqual(versioned.url, "happy://artifacts/\(id)?version=12")
        let service = HappyLink(.reference(.init(kind: .service, id: "web", workspaceId: workspace)))
        XCTAssertEqual(HappyLink("happy://workspaces/\(workspace)/services/web"), service)
        XCTAssertEqual(service.url, "happy://workspaces/\(workspace)/services/web")
    }

    func testMalformedEntitiesAreRefused() {
        for url in [
            "happy://session/abc", "happy://terminal?MDEyMzQ1Njc4OWFiY2RlZg", "happy://artifact/\(id)", "happy://things/\(id)",
            "HAPPY://artifacts/\(id)", "happy://Artifacts/\(id)", "happy://artifacts/", "happy://artifacts/\(id)/",
            "happy://artifacts/a.b", "happy://artifacts/\(String(repeating: "a", count: 129))", "happy://agents/\(id)?version=2",
            "happy://artifacts/\(id)?version=0", "happy://artifacts/\(id)?version=02", "happy://artifacts/\(id)?v=2",
            "happy://artifacts/\(id)?version=2&x=1", "happy://artifacts/\(id)#top", "happy://services/\(id)",
            "happy://agents/\(agent)/services/web", "happy://projects/\(id)/settings", "happy:artifacts/\(id)", " happy://artifacts/\(id)",
        ] {
            XCTAssertNil(HappyLink(url), url)
        }
        XCTAssertNil(HappyLink(.reference(.init(kind: .agent, id: "a", version: 2))).url)
        XCTAssertNil(HappyLink(.reference(.init(kind: .service, id: "s"))).url)
        XCTAssertNil(HappyLink(.reference(.init(kind: .artifact, id: "a", workspaceId: "w"))).url)
    }

    func testFilesDecodeAndRoundTrip() {
        XCTAssertEqual(HappyLink("happy://agents/\(agent)/files/packages/app/Foo.tsx#L42-L50"),
                       HappyLink(.file(.init(target: .agent(agent), path: "packages/app/Foo.tsx", lines: 42...50))))
        XCTAssertEqual(HappyLink("happy-file://workspaces/\(workspace)/README.md#L7"),
                       HappyLink(.file(.init(target: .workspace(workspace), path: "README.md", lines: 7...7))))
        XCTAssertEqual(path("happy://agents/\(agent)/files/docs/R%C3%A9sum%c3%a9%20%281%29.md"), "docs/Résumé (1).md")
        XCTAssertEqual(path("happy://agents/\(agent)/files/%2E%2E.ts"), "...ts")
        let odd = HappyLink(.file(.init(target: .agent(agent), path: "docs/Résumé (1) [old]:#?%.md")))
        XCTAssertEqual(odd.url, "happy://agents/\(agent)/files/docs/R%C3%A9sum%C3%A9%20%281%29%20%5Bold%5D%3A%23%3F%25.md")
        XCTAssertEqual(HappyLink(.file(.init(target: .agent(agent), path: "it's*!~_-.ts"))).url, "happy://agents/\(agent)/files/it%27s%2A%21~_-.ts")
        XCTAssertEqual(odd.url.flatMap(HappyLink.init), odd)
    }

    func testMalformedFilesAreRefused() {
        for rest in [
            "files", "files/", "files//a.ts", "files/src/", "files/src//a.ts", "files/./a.ts", "files/src/../a.ts",
            "files/%2e%2E/a.ts", "files/src%2Fa.ts", "files/src%5Ca.ts", "files/a%0A.ts", "files/a%C2%85.ts", "files/a%00.ts",
            "files/100%.ts", "files/a%4.ts", "files/a%+1.ts", "files/a%C3.ts", "files/a%ED%A0%80.ts", "files/a b.ts", "files/a(1).ts",
            "files/é.ts", "files/a.ts?raw=1", "files/a.ts#", "files/a.ts#l4", "files/a.ts#L0", "files/a.ts#L04",
            "files/a.ts#L1000000000", "files/a.ts#L9-L4", "files/a.ts#L4-9", "files/a.ts#readme", "a.ts",
        ] {
            XCTAssertNil(HappyLink("happy://agents/\(agent)/\(rest)"), rest)
        }
        XCTAssertNil(HappyLink("happy://projects/\(agent)/files/a.ts"))
    }

    func testInstanceLinks() {
        let cases: [(String, HappyLink.Target)] = [
            ("happy://\(instance)/artifacts/\(id)?version=2", .reference(.init(kind: .artifact, id: id, version: 2))),
            ("happy://\(instance)/workspaces/\(workspace)/services/web", .reference(.init(kind: .service, id: "web", workspaceId: workspace))),
            ("happy://\(instance)/agents/\(agent)/files/src/Foo.tsx#L42-L50", .file(.init(target: .agent(agent), path: "src/Foo.tsx", lines: 42...50))),
        ]
        for (url, target) in cases {
            XCTAssertEqual(HappyLink(url), HappyLink(target, instanceId: instance), url)
            XCTAssertEqual(HappyLink(target, instanceId: instance).url, url)
            XCTAssertEqual(HappyLink(target).url, url.replacingOccurrences(of: "\(instance)/", with: ""))
        }
        for url in [
            "happy://\(instance)", "happy://\(instance)/", "happy://\(instance.uppercased())/artifacts/\(id)",
            "happy://\(instance)x/artifacts/\(id)", "happy://\(instance.dropFirst())/artifacts/\(id)",
            "happy://1\(instance.dropFirst())/artifacts/\(id)", "happy://\(instance)/\(instance)/artifacts/\(id)",
            "happy://\(instance)/oauth/callback", "happy://\(instance)/unknown/\(id)",
            "happy-file://\(instance)/agents/\(agent)/Foo.tsx", "happy://oauth/callback?code=c&state=s",
        ] {
            XCTAssertNil(HappyLink(url), url)
        }
        XCTAssertNil(HappyLink(.reference(.init(kind: .agent, id: id)), instanceId: "Short").url)
        XCTAssertNil(HappyLink(.file(.init(target: .agent(agent), path: String(repeating: "a", count: 4060))), instanceId: instance).url)
        XCTAssertTrue(HappyLink.isInstanceID(instance))
        XCTAssertFalse(HappyLink.isInstanceID("oauth"))
    }

    func testSettingsLinksAreAClosedListOfPages() {
        let instance = "k3x9q2m7p0a4b8c1d5e6f7g2"
        XCTAssertEqual(HappyLink.SettingsPage.allCases.map(\.rawValue), [
            "general", "account", "sharing", "servers", "instructions", "secrets", "providers", "providers/import",
            "providers/add", "providers/add/openai", "providers/add/anthropic", "providers/add/api-key",
            "usage", "voice", "mobile-access", "members", "roles", "policy", "mcp", "computes",
        ])
        for page in HappyLink.SettingsPage.allCases {
            let url = "happy://settings/\(page.rawValue)"
            XCTAssertEqual(HappyLink(url), HappyLink(.settings(page)), url)
            XCTAssertEqual(HappyLink(.settings(page)).url, url)
            XCTAssertEqual(HappyLink("happy://\(instance)/settings/\(page.rawValue)"), HappyLink(.settings(page), instanceId: instance))
        }
        for url in [
            "happy://settings", "happy://settings/", "happy://settings/providers/", "happy://settings/Providers",
            "happy://settings/providers?x=1", "happy://settings/providers#top", "happy://settings/billing", "happy://Settings/providers",
            "happy://settings/providers/import/more",
        ] {
            XCTAssertNil(HappyLink(url), url)
        }
        // Under a Happy host, well-formed or not; the app's own routes aren't.
        for url in ["happy://settings/billing", "happy://agents/a1", "happy://\(instance)/x", "happy-file://agents/a/Foo", "HAPPY://Settings/x"] {
            XCTAssertTrue(HappyLink.owns(url), url)
        }
        for url in ["happy://direct?x", "happy://oauth/callback", "https://settings/providers", "happy://settingsx/providers"] {
            XCTAssertFalse(HappyLink.owns(url), url)
        }
    }

    private func path(_ url: String) -> String? {
        guard case .file(let file)? = HappyLink(url)?.target else { return nil }
        return file.path
    }
}
