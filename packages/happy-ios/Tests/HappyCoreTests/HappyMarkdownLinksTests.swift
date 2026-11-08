import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// Happy links written as Markdown (`[label](happy://agents/…)`): where
/// they are found, and how a message reads with them on this phone.
final class HappyMarkdownLinksTests: XCTestCase {
    private static let here = "k" + String(repeating: "a", count: 23)
    private static let there = "m" + String(repeating: "b", count: 23)

    private func sources(_ text: String) -> [String] { HappyMarkdownLinks.matches(text).map(\.source) }

    func testFindsInlineLinksOutsideCode() {
        XCTAssertEqual(sources("See [the plan](happy://artifacts/r1) and [x](https://a.b)."), ["[the plan](happy://artifacts/r1)"])
        XCTAssertEqual(sources("`[a](happy://agents/a1)` and\n```\n[b](happy://agents/a2)\n```\n[c](happy://agents/a3)"), ["[c](happy://agents/a3)"])
        XCTAssertEqual(sources(#"\[a](happy://agents/a1)"#), [])
        XCTAssertEqual(sources("![cover](happy://artifacts/r1?version=2)"), ["![cover](happy://artifacts/r1?version=2)"])
        XCTAssertEqual(sources("[Providers](happy://settings/providers \"button\")"), ["[Providers](happy://settings/providers \"button\")"])
        XCTAssertEqual(sources("[nested [label]](<happy://agents/a1>)"), ["[nested [label]](<happy://agents/a1>)"])
        // Any letter case of the scheme is a Happy link, well-formed or not.
        let malformed = HappyMarkdownLinks.matches("[x](HAPPY://nope)")
        XCTAssertEqual(malformed.count, 1)
        XCTAssertNil(malformed.first?.link)
        XCTAssertTrue(HappyMarkdownLinks.matches("[Go](happy://agents/a1 \"button\")").first!.button)
    }

    private static let owners: [JSONValue] = [
        .object(["name": .string("Chef"), "workspaceId": .string("wb"), "agent": .object(["id": .string("ab"), "workspaceId": .string("wb"), "subtasks": .array([])])]),
    ]

    private func markdown(_ text: String, _ references: References) -> String {
        HappyReferences.markdown(text, instanceId: references.instanceId, files: references.opens, view: references.view)
            .replacingOccurrences(of: HappyReferences.linkPrefix, with: "ref:")
    }

    func testAnEntityReadsAsItsLiveNameOverTheLabel() {
        var references = References.entities(owners: Self.owners)
        references.instanceId = Self.here
        XCTAssertEqual(markdown("Ask [the bot](happy://agents/ab).", references), "Ask [Chef](ref:agent/ab).")
        XCTAssertEqual(markdown("[ws](happy://workspaces/wb)", references), "[Chef](ref:workspace/wb)")
        // One this phone doesn't list keeps its label, as words.
        XCTAssertEqual(markdown("Ask [Researcher](happy://agents/zz).", references), "Ask Researcher.")
        XCTAssertEqual(markdown("[](happy://agents/zz)", references), "an unavailable agent")
        // A project, a service: words.
        XCTAssertEqual(markdown("[Happy](happy://projects/p1)", references), "Happy")
        XCTAssertEqual(markdown("[api](happy://workspaces/wb/services/s1)", references), "api")
        // This installation's own instance link reads as the plain one.
        XCTAssertEqual(markdown("[x](happy://\(Self.here)/agents/ab)", references), "[Chef](ref:agent/ab)")
        // Another installation's: the label as words.
        XCTAssertEqual(markdown("[Their bot](happy://\(Self.there)/agents/ab)", references), "Their bot")
        // Malformed: left for the Markdown reader, which shows the words.
        XCTAssertEqual(markdown("[x](happy://agents/)", references), "[x](happy://agents/)")
        // A button names anything.
        XCTAssertEqual(markdown("[Open](happy://agents/ab \"button\")", references), "[Chef](ref:agent/ab \"button\")")
        // A button that opens nothing stays one, for the screen to draw as its words in place.
        XCTAssertEqual(markdown("[Gone](happy://agents/zz \"button\")", references), "[Gone](happy://agents/zz \"button\")")
        XCTAssertEqual(markdown("[Theirs](happy://\(Self.there)/agents/ab \"button\")", references), "[Theirs](happy://\(Self.there)/agents/ab \"button\")")
        XCTAssertFalse(ChatLinks.opens("happy://agents/zz", server: nil))
        XCTAssertFalse(ChatLinks.opens("happy://\(Self.there)/agents/ab", server: nil))
    }

    func testAnArtifactKeepsItsLabelWhileItsTitleIsRead() {
        var references = References()
        let text = "[Q3 report](happy://artifacts/r1?version=2)"
        XCTAssertEqual(references.unread(in: text), ["r1"])
        XCTAssertEqual(markdown(text, references), "[Q3 report](ref:artifact/r1/2)")
        references.artifacts["r1"] = .active(title: "Q3 revenue", type: "markdown", latestVersion: 2)
        XCTAssertEqual(references.unread(in: text), [])
        XCTAssertEqual(markdown(text, references), "[Q3 revenue](ref:artifact/r1/2)")
        references.artifacts["r1"] = .missing
        XCTAssertEqual(markdown(text, references), "Q3 report")
        // Another installation's isn't asked about.
        XCTAssertEqual(References().unread(in: "[x](happy://\(Self.there)/artifacts/r9)"), [])
    }

    func testASurfaceAndAPerson() {
        var references = References()
        references.surfaces = ["s1": AgentWire.Surface(id: "s1", type: "todo", name: "Groceries"), "s2": AgentWire.Surface(id: "s2", type: "system_monitor", name: " ")]
        XCTAssertEqual(markdown("[list](happy://surfaces/s1)", references), "[Groceries](ref:surface/s1)")
        XCTAssertEqual(markdown("[m](happy://surfaces/s2)", references), "[Untitled system monitor](ref:surface/s2)")
        XCTAssertEqual(markdown("[Old list](happy://surfaces/s3)", references), "Old list")
        references.users = ["u1": "Steve"]
        XCTAssertEqual(markdown("[someone](happy://users/u1)", references), "[@Steve](ref:user/u1)")
        XCTAssertEqual(references.unknownUsers(in: "[x](happy://users/u2)"), ["u2"])
    }

    func testAFileLinkStaysUntilItWontOpen() {
        var references = References()
        let text = "See [main.ts](happy://agents/a1/files/src/main.ts#L4)."
        XCTAssertEqual(markdown(text, references), text)
        XCTAssertEqual(ChatLinks.file("happy://agents/a1/files/src/main.ts#L4"), HappyLink.File(target: .agent("a1"), path: "src/main.ts", lines: 4...4))
        XCTAssertTrue(ChatLinks.opens("happy://agents/a1/files/src/main.ts#L4", server: nil))
        references.closedFiles = ["happy://agents/a1/files/src/main.ts#L4"]
        XCTAssertEqual(markdown(text, references), "See main.ts.")
        XCTAssertEqual(markdown("[main.ts](happy://agents/a1/files/src/main.ts#L4-L4 \"button\")", references), "[main.ts](happy://agents/a1/files/src/main.ts#L4 \"button\")")
        // One with no words of its own reads as its path, as desktop fills it in.
        XCTAssertEqual(markdown("[](happy-file://workspaces/w1/a%20b.md)", References()), "[a b.md](happy://workspaces/w1/files/a%20b.md)")
        XCTAssertEqual(markdown("![](happy://workspaces/w1/files/a.png)", References()), "![](happy://workspaces/w1/files/a.png)")
        XCTAssertEqual(markdown("[](happy://\(Self.there)/workspaces/w1/files/a%20b.md)", References()), "a b.md")
        XCTAssertNil(ChatLinks.file("happy://\(Self.there)/workspaces/w1/files/a.md"))
    }

    func testALabelThatIsOnlyItsAddressIsNoName() {
        var references = References.entities(owners: Self.owners)
        references.instanceId = Self.here
        let share = "https://link.happy.page/#1/\(Self.here)/agents/zz?as=task"
        // A bare share link written as a link to itself names nothing: its placeholder, not its address.
        XCTAssertEqual(markdown("See [\(share)](\(share)).", references), "See an unavailable agent.")
        XCTAssertEqual(markdown("[happy://agents/zz](happy://agents/zz)", references), "an unavailable agent")
        XCTAssertEqual(markdown("[\(share)](https://link.happy.page/#1/\(Self.here)/agents/ab?as=bot)", references), "[Chef](ref:agent/ab)")
        XCTAssertEqual(HappyReferences.plain("[\(share)](\(share))", instanceId: Self.here, view: references.view), "an unavailable agent")
        // A bare share link to a file reads as its path.
        let file = HappyShareLink.format("happy://\(Self.here)/agents/ab/files/src/main.ts#L4")!
        XCTAssertEqual(markdown("Open \(file)", references), "Open [src/main.ts](happy://agents/ab/files/src/main.ts#L4)")
    }

    func testAPersonsMessageNamesWhatOpensAsLinks() {
        var references = References.entities(owners: Self.owners)
        references.instanceId = Self.here
        references.users = ["u1": "Steve"]
        references.artifacts["r1"] = .active(title: "Q3 revenue", type: "markdown", latestVersion: 2)
        func segments(_ text: String) -> [HappyReferences.PlainSegment] {
            HappyReferences.segments(text, instanceId: Self.here, view: references.view).map {
                switch $0 {
                case .text: $0
                case .link(let words, let link): .link(words, link: link.replacingOccurrences(of: HappyReferences.linkPrefix, with: "ref:"))
                }
            }
        }
        let share = "https://link.happy.page/#1/\(Self.here)/agents/ab?as=bot"
        let text = "Ask \(share) about [the plan](happy://artifacts/r1), <happy-user id=\"u1\"/> and [old](happy://agents/zz)."
        XCTAssertEqual(segments(text), [
            .text("Ask "), .link("Chef", link: "ref:agent/ab"), .text(" about "), .link("Q3 revenue", link: "ref:artifact/r1"),
            .text(", "), .link("@Steve", link: "ref:user/u1"), .text(" and old."),
        ])
        // Joined, it reads as the plain text does.
        let joined = segments(text).map { if case .text(let words) = $0 { words } else if case .link(let words, _) = $0 { words } else { "" } }.joined()
        XCTAssertEqual(joined, HappyReferences.plain(text, instanceId: Self.here, view: references.view))
        // Another server's links stay as written: an address, or its words.
        let foreign = "https://link.happy.page/#1/\(Self.there)/agents/ab?as=bot"
        XCTAssertEqual(segments("See \(foreign) and [theirs](happy://\(Self.there)/agents/ab)"), [.text("See \(foreign) and theirs")])
        XCTAssertEqual(segments("plain words"), [.text("plain words")])
    }

    func testAFileReadsAsTheServerAnswers() {
        XCTAssertEqual(LinkedFiles.outcome(AgentClientError.status(403, code: nil, message: nil)), .forbidden)
        XCTAssertEqual(LinkedFiles.outcome(AgentClientError.status(404, code: nil, message: nil)), .unavailable)
        XCTAssertEqual(LinkedFiles.outcome(AgentClientError.status(501, code: nil, message: nil)), .unavailable)
        XCTAssertEqual(LinkedFiles.outcome(AgentClientError.status(409, code: nil, message: "starting")), .failed("starting"))
        XCTAssertEqual(LinkedFiles.outcome(AgentClientError.status(500, code: nil, message: nil)), .failed(nil))
        XCTAssertEqual(LinkedFiles.outcome(URLError(.notConnectedToInternet)), .failed(nil))
    }
}
