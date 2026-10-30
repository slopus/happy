import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// Layout blocks in an agent's text, split exactly as the reference
/// `splitMediaLayoutBlocks` splits them (`scripts/generate-media-block-fixtures.ts`),
/// and what the phone keeps of each.
final class MediaTests: XCTestCase {
    private static let vectors: JSONValue = {
        let url = Bundle.module.url(forResource: "media-layout-blocks", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONValue.decode(Data(contentsOf: url))
    }()

    func testSplitsAsTheReference() {
        for (index, entry) in Self.vectors["cases"]!.arrayValue!.enumerated() {
            let text = entry["text"]!.stringValue!
            let expected = entry["segments"]!.arrayValue!.map { segment -> String in
                segment["type"]!.stringValue! == "markdown"
                    ? "M:" + segment["text"]!.stringValue!
                    : "L\(segment["complete"]!.boolValue! ? "" : "?"):" + segment["html"]!.stringValue!
            }
            let actual = MediaBlocks.split(text).map { segment -> String in
                switch segment {
                case .markdown(let text): "M:" + text
                case .layout(let layout): "L\(layout.complete ? "" : "?"):" + layout.raw
                }
            }
            XCTAssertEqual(actual, expected, "case \(index): \(text.debugDescription)")
        }
    }

    private func image(_ path: String, index: Int = 0) -> Media {
        let item = AgentWire.MediaItem(kind: "image", name: path, mimeType: "image/png", size: 10, width: 100, height: 50, thumbhash: nil, scale: nil, source: .init(path: path, absolutePath: "/w/" + path))
        return Media(toolCallId: "t1", index: index, item: item)
    }

    func testABlockShowsWhatItNamesOrStaysMarkdown() {
        let shown = ["a.png": image("a.png"), "/w/b.png": image("b.png", index: 1)]
        let text = "Look:\n\n<div><img src=\"a.png\"><img src=\"/w/b.png\"><img src=\"c.png\"></div>\n\nNice."
        let pieces = Conversation.pieces(text, shown: shown, streaming: false)
        XCTAssertEqual(pieces.count, 3)
        XCTAssertEqual(pieces[0], .text("Look:"))
        guard case .tree(let media, let tree) = pieces[1] else { return XCTFail("no tree") }
        XCTAssertEqual(media.map(\.item.name), ["a.png", "b.png"])
        XCTAssertEqual(tree.root, [.element(tag: "div", style: [:], children: [.item(index: 0, alt: nil, style: [:]), .item(index: 1, alt: nil, style: [:])])])
        // A block that lost content to a limit is the Markdown it is.
        let long = "<div><img src=\"a.png\">" + String(repeating: "<span>x</span>", count: 600) + "</div>"
        XCTAssertEqual(Conversation.pieces(long, shown: shown, streaming: false), [.text(long)])
        XCTAssertEqual(pieces[2], .text("Nice."))
        // Naming nothing shown: the block is the Markdown it is.
        let none = Conversation.pieces("<div><img src=\"x.png\"></div>", shown: shown, streaming: false)
        XCTAssertEqual(none, [.text("<div><img src=\"x.png\"></div>")])
        // Still arriving: held back, never drawn as HTML.
        XCTAssertEqual(Conversation.pieces("Here:\n<div><img src=\"a.png\">", shown: shown, streaming: true), [.text("Here:")])
        // Final but never closed: Markdown.
        XCTAssertEqual(Conversation.pieces("<div><img src=\"a.png\">", shown: shown, streaming: false), [.text("<div><img src=\"a.png\">")])
    }

    func testColumnsFollowThePresentation() {
        XCTAssertEqual(Conversation.columns(nil, count: 1), 0)
        XCTAssertEqual(Conversation.columns(nil, count: 3), 0)
        XCTAssertEqual(Conversation.columns(.object(["type": .string("columns"), "columns": .number(1)]), count: 3), 1)
        XCTAssertEqual(Conversation.columns(.object(["type": .string("columns"), "columns": .number(2)]), count: 1), 2)
        XCTAssertEqual(Conversation.columns(.object(["type": .string("tree"), "root": .array([])]), count: 4), 0)
    }
}
