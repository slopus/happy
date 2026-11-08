import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// link.happy.page share links. The vectors are the page's own
/// (`link.happy.page/src/link.test.ts` in slopus/happy-link), as
/// happy-desktop's `happyShareLink.test.ts` reuses them, so the app writes
/// and reads exactly what the page and desktop do.
final class ShareLinksTests: XCTestCase {
    private static let instance = "k3x9q2m7p0a4b8c1d5e6f7g2"
    private static let other = "m1n2b3v4c5x6z7l8k9j0h1g2"
    private static let id = "t7bgxjt05aexj73frl6ul37e"
    private static let page = "https://link.happy.page/#"

    func testRoundTrip() {
        let (i, id) = (Self.instance, Self.id)
        let cases: [(String, String, HappyShareLink.Role?)] = [
            ("happy://\(i)/agents/\(id)", "1/\(i)/agents/\(id)", nil),
            ("happy://\(i)/agents/\(id)", "1/\(i)/agents/\(id)?as=task", .task),
            ("happy://\(i)/agents/\(id)", "1/\(i)/agents/\(id)?as=bot", .bot),
            ("happy://\(i)/agents/\(id)", "1/\(i)/agents/\(id)?as=subtask", .subtask),
            ("happy://\(i)/agents/\(id)", "1/\(i)/agents/\(id)?as=subagent", .subagent),
            ("happy://\(i)/agents/\(id)", "1/\(i)/agents/\(id)?as=session", .session),
            ("happy://\(i)/artifacts/\(id)", "1/\(i)/artifacts/\(id)", nil),
            ("happy://\(i)/artifacts/\(id)?version=12", "1/\(i)/artifacts/\(id)?version=12", nil),
            ("happy://\(i)/workspaces/\(id)", "1/\(i)/workspaces/\(id)", nil),
            ("happy://\(i)/projects/\(id)", "1/\(i)/projects/\(id)", nil),
            ("happy://\(i)/surfaces/\(id)", "1/\(i)/surfaces/\(id)", nil),
            ("happy://\(i)/users/\(id)", "1/\(i)/users/\(id)", nil),
            ("happy://\(i)/workspaces/ws_1/services/web-2", "1/\(i)/workspaces/ws_1/services/web-2", nil),
            ("happy://\(i)/agents/\(id)/files/src/main.ts#L42", "1/\(i)/agents/\(id)/files/src/main.ts?lines=42", nil),
            ("happy://\(i)/workspaces/\(id)/files/docs/My%20Notes.md#L3-L9", "1/\(i)/workspaces/\(id)/files/docs/My%20Notes.md?lines=3-9", nil),
        ]
        for (url, payload, role) in cases {
            XCTAssertEqual(HappyShareLink.format(url, as: role), Self.page + payload, payload)
            XCTAssertEqual(HappyShareLink.parse(Self.page + payload), .init(url: url, instanceId: i, role: role), payload)
        }
    }

    func testRefusesWhateverIsNotExactlyAShareLink() {
        let (i, id) = (Self.instance, Self.id)
        let fragments = [
            "",
            "2/\(i)/agents/\(id)",
            "10/\(i)/agents/\(id)",
            "1/\(i)/agents/\(String(repeating: "a", count: 4100))",
            // link.happy.engineering's v1: names something, but no installation.
            "1/agents/\(id)",
            "1/artifacts/\(id)?version=2",
            "hello",
            "1/",
            "1/\(i)",
            "1/\(i)/",
            "1/\(i.uppercased())/agents/\(id)",
            "1/\(i)x/agents/\(id)",
            "1/9\(i.dropFirst())/agents/\(id)",
            "1/\(i)/agent/\(id)",
            "1/\(i)/agents/\(id)/",
            "1/\(i)/agents/a.b",
            "1/\(i)/sessions/\(id)",
            "1/\(i)/agents/\(id)?title=Plan",
            "1/\(i)/chief-of-staff?text=hi",
            "1/\(i)/organizations/org_1/join",
            "1/\(i)/agents/\(id)?as=task&as=bot",
            "1/\(i)/agents/\(id)?as=Task",
            "1/\(i)/agents/\(id)?as=admin",
            "1/\(i)/agents/\(id)?as=",
            "1/\(i)/agents/\(id)?",
            "1/\(i)/artifacts/\(id)?as=task",
            "1/\(i)/agents/\(id)?version=2",
            "1/\(i)/artifacts/\(id)?version=0",
            "1/\(i)/artifacts/\(id)?version=01",
            "1/\(i)/artifacts/\(id)?version=1000000000",
            "1/\(i)/agents/\(id)/files/a/../b",
            "1/\(i)/agents/\(id)/files/a%2Fb",
            "1/\(i)/agents/\(id)/files/a%5Cb",
            "1/\(i)/agents/\(id)/files/a%00b",
            "1/\(i)/agents/\(id)/files/a%zz",
            "1/\(i)/agents/\(id)/files/a//b",
            "1/\(i)/agents/\(id)/files/a.ts?lines=9-3",
            "1/\(i)/agents/\(id)/files/a.ts?lines=L9",
            "1/\(i)/agents/\(id)#x",
            "1/\(i)/agents/\(id)?as=task#x",
            "1/javascript:alert(1)",
            // Not the page's: what ICU reads differently from JavaScript.
            "1/\(i)/agents/\(id)\n",
            "1/\(i)/agents/\(id)?as=task\n",
            "1/\u{301}\(i)/agents/\(id)",
            "1/\(i)/\u{301}agents/\(id)",
            "1/\(i)/agents/\(id)/files/a%+F",
        ]
        for fragment in fragments {
            XCTAssertNil(HappyShareLink.parse(Self.page + fragment), String(fragment.prefix(80)))
        }
        for url in [
            "https://link.happy.engineering/#1/\(i)/agents/\(id)",
            "http://link.happy.page/#1/\(i)/agents/\(id)",
            "https://link.happy.page.evil.com/#1/\(i)/agents/\(id)",
            "https://evil.com/?https://link.happy.page/#1/\(i)/agents/\(id)",
        ] {
            XCTAssertNil(HappyShareLink.parse(url), url)
        }
    }

    func testAcceptsWhatThePageDecodes() {
        // decodeURIComponent reads an escaped value, and a path's non-ASCII.
        XCTAssertEqual(HappyShareLink.parse("\(Self.page)1/\(Self.instance)/agents/\(Self.id)?as=ta%73k")?.role, .task)
        let notes = "happy://\(Self.instance)/agents/\(Self.id)/files/caf%C3%A9/%E2%80%9Cq%E2%80%9D.md"
        XCTAssertEqual(HappyShareLink.parse("\(Self.page)1/\(Self.instance)/agents/\(Self.id)/files/caf%c3%a9/%E2%80%9Cq%E2%80%9D.md")?.url, notes)
        XCTAssertEqual(HappyShareLink.format(notes), "\(Self.page)1/\(Self.instance)/agents/\(Self.id)/files/caf%C3%A9/%E2%80%9Cq%E2%80%9D.md")
    }

    func testWritesAShareLinkOnlyForACanonicalInstanceLink() {
        let (i, id) = (Self.instance, Self.id)
        for url in [
            "happy://agents/\(id)",
            "happy://\(i)/agents/\(id)/",
            "happy://\(i)/agents/\(id)?as=task",
            "happy://\(i)/agents/\(id)/files/a%2fb",
            "\(Self.page)1/\(i)/agents/\(id)",
            "HAPPY://\(i)/agents/\(id)",
            "happy://\(i)/settings/providers",
            "happy://\(i)/agents/\(id)\n",
        ] {
            XCTAssertNil(HappyShareLink.format(url), url)
        }
        // The role is said of agents only.
        XCTAssertNil(HappyShareLink.format("happy://\(i)/artifacts/\(id)", as: .task))
    }

    func testOpensFromOutsideTheAppAsTheInstanceLinkItCarries() {
        var mine = AgentConnection(id: "mine", name: "Mine")
        mine.instanceId = Self.instance
        guard case .open(let connection, let link) = InstanceLinkRoute.route("\(Self.page)1/\(Self.instance)/artifacts/\(Self.id)?version=2", connections: [mine], active: nil) else {
            return XCTFail("not opened")
        }
        XCTAssertEqual(connection, "mine")
        XCTAssertEqual(link, HappyLink(.reference(.init(kind: .artifact, id: Self.id, version: 2)), instanceId: Self.instance))
        XCTAssertEqual(InstanceLinkRoute.route("\(Self.page)1/\(Self.other)/agents/\(Self.id)?as=bot", connections: [mine], active: nil), .unknownInstance)
        // One the page can't read isn't a Happy link: a web address.
        XCTAssertEqual(InstanceLinkRoute.route("\(Self.page)1/agents/\(Self.id)", connections: [mine], active: nil), .notALink)
    }

    /// A universal link arrives as the `webpageURL` of a browsing-web
    /// activity: a `URL`, read back as the share link it was.
    func testOpensAsAUniversalLink() throws {
        var mine = AgentConnection(id: "mine", name: "Mine")
        mine.instanceId = Self.instance
        for payload in [
            "1/\(Self.instance)/agents/\(Self.id)?as=task",
            "1/\(Self.instance)/artifacts/\(Self.id)?version=2",
            "1/\(Self.instance)/agents/\(Self.id)/files/src/a%20b.ts?lines=42-50",
        ] {
            let url = try XCTUnwrap(URL(string: Self.page + payload))
            XCTAssertEqual(url.host, "link.happy.page")
            XCTAssertEqual(url.path, "/")
            XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedFragment, payload)
            XCTAssertNotNil(HappyShareLink.parse(url.absoluteString), payload)
            guard case .open(let connection, _) = InstanceLinkRoute.route(url.absoluteString, connections: [mine], active: nil) else {
                return XCTFail(payload)
            }
            XCTAssertEqual(connection, "mine")
        }
        // Anything else on the host stays the web's.
        for other in ["https://link.happy.page/", "https://link.happy.page/#1/agents/\(Self.id)", "https://link.happy.page/x#1/\(Self.instance)/agents/\(Self.id)"] {
            XCTAssertNil(HappyShareLink.parse(try XCTUnwrap(URL(string: other)).absoluteString), other)
        }
    }

    func testReadsShareLinksNamingThisInstanceInMarkdownAsTheHappyLinksTheyCarry() {
        let share = "\(Self.page)1/\(Self.instance)/agents/\(Self.id)?as=task"
        let happy = "happy://\(Self.instance)/agents/\(Self.id)"
        let foreign = "\(Self.page)1/\(Self.other)/agents/\(Self.id)"
        let here: (String) -> Bool = { $0 == Self.instance }
        XCTAssertEqual(HappyShareLink.rewrite("See \(share).", here: here), "See [](\(happy)).")
        XCTAssertEqual(HappyShareLink.rewrite("See [the plan](\(share)) now", here: here), "See [the plan](\(happy)) now")
        XCTAssertEqual(HappyShareLink.rewrite("<\(share)>", here: here), "[](\(happy))")
        // Another server's, or any without an instance here, is a web address.
        XCTAssertEqual(HappyShareLink.rewrite("See \(foreign)", here: here), "See \(foreign)")
        XCTAssertEqual(HappyShareLink.rewrite("See \(share)", here: { _ in false }), "See \(share)")
        // Code stays literal.
        XCTAssertEqual(HappyShareLink.rewrite("`\(share)` and \(share)", here: here), "`\(share)` and [](\(happy))")
        XCTAssertEqual(HappyShareLink.rewrite("```\n\(share)\n```\n\(share)", here: here), "```\n\(share)\n```\n[](\(happy))")
        // A fence in CRLF text closes at its line's end, as JavaScript splits it.
        XCTAssertEqual(HappyShareLink.rewrite("```\r\n\(share)\r\n```\r\n\(share)", here: here), "```\r\n\(share)\r\n```\r\n[](\(happy))")
    }

    func testAShareLinkInAMessageReadsAsWhatItNames() {
        var references = References.entities(owners: [
            .object(["name": .string("Chef"), "workspaceId": .string("wb"), "agent": .object(["id": .string("ab"), "workspaceId": .string("wb"), "subtasks": .array([])])]),
        ])
        references.instanceId = Self.instance
        let share = "\(Self.page)1/\(Self.instance)/agents/ab?as=bot"
        // Bare, its address; as a link, the live name at its own address: where it goes is read as it is drawn.
        XCTAssertEqual(HappyReferences.markdown("Ask \(share).", instanceId: Self.instance, view: references.view), "Ask \(share).")
        XCTAssertEqual(HappyReferences.markdown("Ask [](\(share)).", instanceId: Self.instance, view: references.view), "Ask [Chef](\(share)).")
        XCTAssertEqual(HappyReferences.plain("Ask [the bot](\(share)).", instanceId: Self.instance, view: references.view), "Ask Chef.")
        XCTAssertEqual(ChatLinks.kind(share, references: references), .here(HappyLink("happy://\(Self.instance)/agents/ab")!, busy: false))
        XCTAssertEqual(HappyShareLink.bare(in: "Ask \(share). Or [x](\(share))").map(\.url), [share])
        // Another server's is routed as the instance link it carries.
        let foreign = "\(Self.page)1/\(Self.other)/agents/ab?as=bot"
        XCTAssertEqual(ChatLinks.kind(foreign, references: references), .elsewhere(HappyLink("happy://\(Self.other)/agents/ab")!))
        // An artifact it names is read here.
        XCTAssertEqual(References().unread(in: "\(Self.page)1/\(Self.instance)/artifacts/r1"), [])
        var here = References()
        here.instanceId = Self.instance
        XCTAssertEqual(here.unread(in: "See \(Self.page)1/\(Self.instance)/artifacts/r1?version=2"), ["r1"])
        XCTAssertEqual(here.unread(in: "See \(Self.page)1/\(Self.other)/artifacts/r1"), [])
    }
}
