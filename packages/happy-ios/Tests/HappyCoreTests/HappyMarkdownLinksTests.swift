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

    private var references: References {
        var references = References.entities(owners: Self.owners)
        references.instanceId = Self.here
        return references
    }

    private func kind(_ url: String, _ references: References) -> ChatLinks.Kind { ChatLinks.kind(url, references: references) }

    private func markdown(_ text: String, _ references: References) -> String {
        HappyReferences.markdown(text, instanceId: references.instanceId, view: references.view)
    }

    func testAHappyLinkReadsAsWhatItNamesNowAtItsOwnAddress() {
        let references = references
        let share = "https://link.happy.page/#1/\(Self.here)/agents/ab?as=bot"
        // Whatever words it was written with, or none: the live name.
        XCTAssertEqual(markdown("Ask [the bot](happy://agents/ab).", references), "Ask [Chef](happy://agents/ab).")
        XCTAssertEqual(markdown("Ask [](\(share)).", references), "Ask [Chef](\(share)).")
        XCTAssertEqual(markdown("[stale name](happy://workspaces/wb)", references), "[Chef](happy://workspaces/wb)")
        XCTAssertEqual(markdown("**[x](\(share))**", references), "**[Chef](\(share))**")
        // Nothing here names it, or it is another server's: the placeholder, still a link a tap routes.
        XCTAssertEqual(markdown("Ask [Researcher](happy://agents/zz).", references), "Ask [an unavailable agent](happy://agents/zz).")
        XCTAssertEqual(markdown("[Their bot](happy://\(Self.there)/agents/ab)", references), "[an unavailable agent](happy://\(Self.there)/agents/ab)")
        XCTAssertEqual(markdown("[Happy](happy://projects/p1)", references), "[an unavailable project](happy://projects/p1)")
        // A button stays one.
        XCTAssertEqual(markdown("[Open](happy://agents/ab \"button\")", references), "[Chef](happy://agents/ab \"button\")")
        // Malformed, a picture, a web link, a bare address: as written.
        for text in ["[x](happy://agents/)", "![](happy://workspaces/w1/files/a.png)", "[docs](https://a.io)", "See \(share) now"] {
            XCTAssertEqual(markdown(text, references), text)
        }
        // A file or settings link keeps its words, else its path or "Settings".
        XCTAssertEqual(markdown("[main](happy://agents/a1/files/src/main.ts#L4)", references), "[main](happy://agents/a1/files/src/main.ts#L4)")
        XCTAssertEqual(markdown("[](happy-file://workspaces/w1/a%20b.md)", references), "[a b.md](happy-file://workspaces/w1/a%20b.md)")
        XCTAssertEqual(markdown("[](happy://settings/general)", references), "[Settings](happy://settings/general)")
    }

    func testATagReadsAsALinkUnderItsLiveName() {
        var references = references
        references.users = ["u1": "Steve"]
        XCTAssertEqual(HappyReferences.markdown("Ask <happy-agent id=\"ab\"/>.", view: references.view), "Ask [Chef](happy://agents/ab).")
        XCTAssertEqual(HappyReferences.markdown("**<happy-workspace id=\"wb\"/>**", view: references.view), "**[Chef](happy://workspaces/wb)**")
        XCTAssertEqual(HappyReferences.markdown("<happy-user id=\"u1\"/>", view: references.view), "[@Steve](happy://users/u1)")
        XCTAssertEqual(HappyReferences.markdown("<happy-agent id=\"zz\"/>", view: references.view), "an unavailable agent")
        XCTAssertEqual(HappyReferences.markdown("<happy-artifact id=\"r1\" version=\"2\"/>", view: references.view), "[artifact](happy://artifacts/r1?version=2)")
    }

    func testWhereALinkGoesIsReadFromItsAddress() {
        var references = references
        let chef = HappyLink("happy://agents/ab")!
        XCTAssertEqual(kind("happy://agents/ab", references), .here(chef, busy: false))
        XCTAssertEqual(kind("happy://workspaces/wb", references), .here(HappyLink("happy://workspaces/wb")!, busy: false))
        // This installation's own instance link, or a share link naming it, is as much here.
        XCTAssertEqual(kind("happy://\(Self.here)/agents/ab", references), .here(HappyLink("happy://\(Self.here)/agents/ab")!, busy: false))
        XCTAssertEqual(kind("https://link.happy.page/#1/\(Self.here)/agents/ab?as=bot", references), .here(HappyLink("happy://\(Self.here)/agents/ab")!, busy: false))
        // While its agent works, it says so.
        references.busy = ["ab"]
        XCTAssertEqual(kind("happy://agents/ab", references), .here(chef, busy: true))
        XCTAssertEqual(kind("happy://workspaces/wb", references), .here(HappyLink("happy://workspaces/wb")!, busy: true))
        // What nothing here holds, or another server's: a share link is
        // routed on a tap, a `happy://` link is words.
        XCTAssertEqual(kind("https://link.happy.page/#1/\(Self.there)/agents/ab", references), .elsewhere(HappyLink("happy://\(Self.there)/agents/ab")!))
        XCTAssertEqual(kind("https://link.happy.page/#1/\(Self.here)/agents/zz", references), .elsewhere(HappyLink("happy://\(Self.here)/agents/zz")!))
        XCTAssertEqual(kind("happy://agents/zz", references), .words)
        XCTAssertEqual(kind("happy://\(Self.there)/agents/ab", references), .words)
        XCTAssertEqual(kind("happy://projects/p1", references), .words)
        // The web, and what isn't a link.
        XCTAssertEqual(kind("https://a.io/x", references), .web)
        XCTAssertEqual(kind("happy://agents/", references), .words)
        XCTAssertEqual(kind("notes.md", references), .words)
        // A person.
        references.users = ["u1": "Steve"]
        references.me = "u1"
        XCTAssertEqual(kind("happy://users/u1", references), .mention(me: true))
        // A button opens wherever a tap goes somewhere.
        XCTAssertTrue(ChatLinks.opens("happy://agents/ab", references: references, server: nil))
        XCTAssertTrue(ChatLinks.opens("https://link.happy.page/#1/\(Self.there)/agents/ab", references: references, server: nil))
        XCTAssertFalse(ChatLinks.opens("happy://\(Self.there)/agents/ab", references: references, server: nil))
        XCTAssertFalse(ChatLinks.opens("happy://agents/", references: references, server: nil))
    }

    func testAnArtifactIsReadForWhetherItIsThere() {
        var references = References()
        let text = "[Q3 report](happy://artifacts/r1?version=2)"
        XCTAssertEqual(references.unread(in: text), ["r1"])
        XCTAssertEqual(kind("happy://artifacts/r1?version=2", references), .here(HappyLink("happy://artifacts/r1?version=2")!, busy: false))
        references.artifacts["r1"] = .missing
        XCTAssertEqual(references.unread(in: text), [])
        XCTAssertEqual(kind("happy://artifacts/r1?version=2", references), .words)
        // A share link to one gone is routed; a deleted one's last title is words.
        var here = self.references
        here.artifacts["r1"] = .missing
        here.artifacts["r2"] = .deleted(title: "Old brief")
        XCTAssertEqual(kind("https://link.happy.page/#1/\(Self.here)/artifacts/r1", here), .elsewhere(HappyLink("happy://\(Self.here)/artifacts/r1")!))
        XCTAssertEqual(kind("https://link.happy.page/#1/\(Self.here)/artifacts/r2", here), .words)
        XCTAssertEqual(HappyReferences.plain("[](https://link.happy.page/#1/\(Self.here)/artifacts/r2)", instanceId: Self.here, view: here.view), "Old brief")
        // Another installation's isn't asked about; a share link to this one, bare or not, is.
        XCTAssertEqual(References().unread(in: "[x](happy://\(Self.there)/artifacts/r9)"), [])
        XCTAssertEqual(self.references.unread(in: "[x](https://link.happy.page/#1/\(Self.here)/artifacts/r2) and https://link.happy.page/#1/\(Self.here)/artifacts/r3."), ["r2", "r3"])
    }

    func testAFileLinkIsHereUntilItWontOpen() {
        var references = References()
        let url = "happy://agents/a1/files/src/main.ts#L4"
        XCTAssertEqual(ChatLinks.file(url), HappyLink.File(target: .agent("a1"), path: "src/main.ts", lines: 4...4))
        XCTAssertEqual(kind(url, references), .here(HappyLink(url)!, busy: false))
        references.closedFiles = [url]
        XCTAssertEqual(kind(url, references), .words)
        XCTAssertNil(ChatLinks.file("happy://\(Self.there)/workspaces/w1/files/a.md"))
    }

    func testTheAgentsAMessageLinks() {
        let references = references
        XCTAssertEqual(references.agents(in: "Ask <happy-workspace id=\"wb\"/>"), ["ab"])
        XCTAssertEqual(references.agents(in: "Ask [x](https://link.happy.page/#1/\(Self.here)/agents/ab?as=bot)"), ["ab"])
        XCTAssertEqual(references.agents(in: "Ask https://link.happy.page/#1/\(Self.here)/agents/ab?as=bot."), ["ab"])
        XCTAssertEqual(references.agents(in: "Ask [x](happy://agents/zz) or [y](happy://\(Self.there)/agents/ab)"), [])
    }

    func testPlainTextReadsLinksAsWhatTheyNameNow() {
        var references = references
        references.users = ["u1": "Steve"]
        let share = "https://link.happy.page/#1/\(Self.here)/agents/ab?as=bot"
        XCTAssertEqual(HappyReferences.plain("Ask [the bot](happy://agents/ab), [](happy://users/u1), <happy-user id=\"u1\"/> and \(share).", instanceId: Self.here, view: references.view),
                       "Ask Chef, @Steve, @Steve and \(share).")
        XCTAssertEqual(HappyReferences.plain("[old](happy://agents/zz)", instanceId: Self.here, view: references.view), "an unavailable agent")
    }

    func testAPersonsMessageLinksUnderWhatItNames() {
        var references = references
        references.users = ["u1": "Steve"]
        references.artifacts["r1"] = .active(title: "Q3 revenue", type: "markdown", latestVersion: 2)
        func segments(_ text: String) -> [HappyReferences.PlainSegment] { HappyReferences.segments(text, instanceId: Self.here, view: references.view) }
        let share = "https://link.happy.page/#1/\(Self.here)/agents/ab?as=bot"
        let text = "Ask \(share) or [](\(share)) about [the plan](happy://artifacts/r1), <happy-user id=\"u1\"/> and [old](happy://agents/zz)."
        XCTAssertEqual(segments(text), [
            .text("Ask "), .link(share, link: share), .text(" or "), .link("Chef", link: share), .text(" about "), .link("Q3 revenue", link: "happy://artifacts/r1"),
            .text(", "), .link("@Steve", link: "happy://users/u1"), .text(" and "), .link("an unavailable agent", link: "happy://agents/zz"), .text("."),
        ])
        // Joined, it reads as the plain text does.
        let joined = segments(text).map { if case .text(let words) = $0 { words } else if case .link(let words, _) = $0 { words } else { "" } }.joined()
        XCTAssertEqual(joined, HappyReferences.plain(text, instanceId: Self.here, view: references.view))
        // Another server's links are links too, a tap routes them.
        let foreign = "https://link.happy.page/#1/\(Self.there)/agents/ab?as=bot"
        XCTAssertEqual(segments("See \(foreign) and [theirs](happy://\(Self.there)/agents/ab)"), [
            .text("See "), .link(foreign, link: foreign), .text(" and "), .link("an unavailable agent", link: "happy://\(Self.there)/agents/ab"),
        ])
        XCTAssertEqual(segments("<happy-agent id=\"zz\"/> plain words"), [.text("an unavailable agent plain words")])
    }

    /// Nothing a message shows or copies is anything but what was written,
    /// or a tag's own Happy link: no private scheme ever.
    func testNothingShownOrCopiedHoldsAPrivateScheme() {
        var references = references
        references.busy = ["ab"]
        let text = "**[X](https://link.happy.page/#1/\(Self.here)/agents/ab?as=task)** and *<happy-agent id=\"ab\"/>* `[c](happy://agents/ab)`"
        let resolved = HappyReferences.markdown(text, instanceId: Self.here, view: references.view)
        guard case .text(let spans)? = LegacyMarkdown.parse(resolved).first else { return XCTFail("no paragraph") }
        XCTAssertEqual(spans.first, MarkdownSpan(styles: [.bold], text: "Chef", url: "https://link.happy.page/#1/\(Self.here)/agents/ab?as=task"))
        XCTAssertTrue(spans.contains(MarkdownSpan(styles: [.italic], text: "Chef", url: "happy://agents/ab")))
        for span in spans {
            XCTAssertFalse(span.text.contains("happy-reference"))
            XCTAssertTrue(span.url.map { $0.hasPrefix("happy://") || $0.hasPrefix("https://link.happy.page/") } ?? true)
        }
        XCTAssertFalse(HappyReferences.plain(text, instanceId: Self.here, view: references.view).contains("happy-reference"))
        XCTAssertEqual(LegacyMarkdown.plainText(spans), "Chef and Chef [c](happy://agents/ab)")
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
