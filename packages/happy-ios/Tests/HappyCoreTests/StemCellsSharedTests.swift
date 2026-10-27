import Foundation
import XCTest
@testable import HappyCore

final class StemCellsSharedTests: XCTestCase {
    private func item(_ name: String, kind: String = "image") -> AgentWire.MediaItem {
        AgentWire.MediaItem(kind: kind, name: name, mimeType: kind == "image" ? "image/png" : "application/pdf", size: 10, width: 10, height: 10, thumbhash: nil, scale: nil, source: nil)
    }

    private func media(_ call: String, _ items: [AgentWire.MediaItem]) -> AgentWire.Block {
        .toolCall(id: call, name: "present_files", status: "completed", presentation: AgentWire.Presentation(type: "media", items: items))
    }

    /// Markdown links with their text, bare ones as written, the
    /// punctuation after them left out, in the text's order.
    func testLinksAreFoundInTheirOrder() {
        let links = StemCellsShared.links(in: "See [the docs](https://www.example.com/docs) and https://github.com/slopus/happy. Also (https://a.io/x), then [https://b.dev](https://b.dev).")
        XCTAssertEqual(links.map(\.url), ["https://www.example.com/docs", "https://github.com/slopus/happy", "https://a.io/x", "https://b.dev"])
        XCTAssertEqual(links.map(\.title), ["the docs", nil, nil, nil])
        XCTAssertEqual(links.map(\.host), ["example.com", "github.com", "a.io", "b.dev"])
        XCTAssertEqual(StemCellsShared.links(in: "no links, not even ftp://x.y or http://"), [])
        // A Markdown image is a picture, not a link; a URL keeps its own parentheses.
        let wiki = StemCellsShared.links(in: "![chart](https://img.dev/c.png) see https://en.wikipedia.org/wiki/Swift_(programming_language), [it](https://en.wikipedia.org/wiki/A_(b)).")
        XCTAssertEqual(wiki.map(\.url), ["https://en.wikipedia.org/wiki/Swift_(programming_language)", "https://en.wikipedia.org/wiki/A_(b)"])
    }

    /// Newest first: a later message's media and links before an earlier
    /// one's, each message's in its own order; a person's pictures and a
    /// tool's media and files alike. Reasoning and other roles show none.
    func testAPageSharesItsMediaAndLinksNewestFirst() {
        let png = Data([1, 2, 3]).base64EncodedString()
        let messages = [
            AgentWire.Message(id: "m1", role: "user", createdAt: 1, content: [.text("look https://one.dev"), .image(mimeType: "image/png", data: png), .text("again https://one.dev")]),
            AgentWire.Message(id: "m2", role: "agent", createdAt: 2, content: [
                .reasoning("https://thinking.dev"),
                media("call", [item("a.png"), item("report.pdf", kind: "file")]),
                .text("Done: [report](https://two.dev/r)"),
            ]),
            AgentWire.Message(id: "m3", role: "system", createdAt: 3, content: [.text("https://system.dev")]),
        ]
        let shared = StemCellsShared.of(messages: messages)
        XCTAssertEqual(shared.media.map(\.key), ["tool/call/0", "tool/call/1", "sent/m1#0"])
        XCTAssertEqual(shared.media.map(\.isPicture), [true, false, true])
        XCTAssertEqual(shared.links.map(\.url), ["https://two.dev/r", "https://one.dev"])
    }

    /// The transcript the phone holds reads the same way; a collaborator's
    /// report is not this conversation's.
    func testTheTranscriptSharesTheSame() {
        let one = StemCellMedia(toolCallId: "c", index: 0, item: item("a.png"))
        let items = [
            StemCellChatItem(id: "1", role: .user, pieces: [.text("https://first.dev"), .picture(id: "1:1", mimeType: "image/png", data: Data([1]))], delivery: .sent),
            StemCellChatItem(id: "2", role: .collaborator(agentId: "x", explanation: nil), pieces: [.text("https://theirs.dev")], delivery: .sent),
            StemCellChatItem(id: "3", role: .agent, pieces: [.gallery([one], columns: 0), .text("https://last.dev")], delivery: .sent),
        ]
        let shared = StemCellsShared.of(items: items)
        XCTAssertEqual(shared.media.map(\.key), ["tool/c/0", "sent/1#0"])
        XCTAssertEqual(shared.links.map(\.url), ["https://last.dev", "https://first.dev"])
    }

    /// A picture still on its way and the same one in history are one:
    /// both named by their message and which of its pictures they are.
    func testASentPictureIsTheSameBeforeAndAfterItsEcho() {
        let bytes = Data([7])
        let sending = StemCellsShared.of(items: [StemCellChatItem(id: "s", role: .user, pieces: [.picture(id: "s:1", mimeType: "image/png", data: bytes)], delivery: .sending)])
        let echoed = StemCellsShared.of(messages: [AgentWire.Message(id: "s", role: "user", createdAt: 1, content: [.image(mimeType: "image/png", data: bytes.base64EncodedString())])])
        XCTAssertEqual(sending.merged(older: echoed).media.map(\.key), ["sent/s#0"])
    }

    /// Read again, an unchanged item gives what it gave; a changed one is read anew.
    func testTheReaderReadsWhatChanged() {
        var reader = StemCellsShared.Reader()
        var items = [
            StemCellChatItem(id: "1", role: .user, pieces: [.text("https://one.dev")], delivery: .sent),
            StemCellChatItem(id: "2", role: .agent, pieces: [.text("streaming https://two")], delivery: .sent),
        ]
        XCTAssertEqual(reader.read(items).links.map(\.url), ["https://two", "https://one.dev"])
        items[1].pieces = [.text("streaming https://two.dev/more")]
        XCTAssertEqual(reader.read(items).links.map(\.url), ["https://two.dev/more", "https://one.dev"])
        XCTAssertEqual(reader.read(items), StemCellsShared.of(items: items))
    }

    /// An older page adds only what the newer one didn't have.
    func testOlderPagesAddWhatIsNew() {
        let newer = StemCellsShared(media: [.tool(StemCellMedia(toolCallId: "c", index: 0, item: item("a.png")))], links: [.init(url: "https://a.dev", host: "a.dev")])
        let older = StemCellsShared(
            media: [.tool(StemCellMedia(toolCallId: "c", index: 0, item: item("a.png"))), .tool(StemCellMedia(toolCallId: "d", index: 0, item: item("b.png")))],
            links: [.init(url: "https://a.dev", host: "a.dev"), .init(url: "https://b.dev", host: "b.dev")]
        )
        let merged = newer.merged(older: older)
        XCTAssertEqual(merged.media.map(\.key), ["tool/c/0", "tool/d/0"])
        XCTAssertEqual(merged.links.map(\.url), ["https://a.dev", "https://b.dev"])
    }
}
