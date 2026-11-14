#if canImport(UIKit)
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A message's Happy links as drawn: under what they name now, bold where
/// they sit in bold, and a link to a conversation at work carrying the band.
@MainActor
final class ChatLinkDrawingTests: XCTestCase {
    private static let here = "k3x9q2m7p0a4b8c1d5e6f7g2"

    private var references: References {
        var references = References(agents: ["a1": .init(label: "Fix login crash", agentId: "a1"), "a2": .init(label: "Research Assistant", agentId: "a2")])
        references.instanceId = Self.here
        references.busy = ["a2"]
        return references
    }

    private func string(_ markdown: String) -> NSAttributedString {
        let references = references
        let spans = LegacyMarkdown.parseSpans(HappyReferences.markdown(markdown, instanceId: references.instanceId, view: references.view), header: false)
        return ChatSpans.string(spans, style: ChatTextStyles.text, color: Palette.text, in: nil, links: references)
    }

    private func attributes(of word: String, in string: NSAttributedString) -> [NSAttributedString.Key: Any] {
        string.attributes(at: (string.string as NSString).range(of: word).location, effectiveRange: nil)
    }

    func testALinkReadsAsWhatItNamesAndBoldStaysBold() {
        let share = "https://link.happy.page/#1/\(Self.here)/agents/a1?as=task"
        let string = string("**[the crash](\(share))** and [elsewhere](https://link.happy.page/#1/m1n2b3v4c5x6z7l8k9j0h1g2/agents/x) and [gone](happy://agents/zz) and \(share)")
        XCTAssertEqual(string.string, "Fix login crash and an unavailable agent and an unavailable agent and \(share)")
        let crash = attributes(of: "Fix login crash", in: string)
        XCTAssertEqual(crash[.chatLink] as? String, share)
        XCTAssertNotNil(crash[.underlineStyle])
        XCTAssertTrue((crash[.font] as? UIFont)?.fontDescriptor.symbolicTraits.contains(.traitBold) == true || (crash[.font] as? UIFont)?.fontName.contains("Bold") == true)
        XCTAssertNil(crash[.chatBusy])
        // Another server's share link still taps, to be routed; a `happy://` one nothing holds is words; a bare share link is its address.
        XCTAssertEqual(attributes(of: "an unavailable agent", in: string)[.chatLink] as? String, "https://link.happy.page/#1/m1n2b3v4c5x6z7l8k9j0h1g2/agents/x")
        let gone = (string.string as NSString).range(of: "an unavailable agent", options: .backwards)
        XCTAssertNil(string.attribute(.chatLink, at: gone.location, effectiveRange: nil))
        XCTAssertEqual(attributes(of: share, in: string)[.chatLink] as? String, share)
    }

    func testABusyLinkCarriesTheBand() {
        let string = string("Ask [](happy://agents/a2) or <happy-agent id=\"a1\"/>.")
        XCTAssertEqual(string.string, "Ask Research Assistant or Fix login crash.")
        XCTAssertEqual(attributes(of: "Research Assistant", in: string)[.chatBusy] as? Bool, true)
        XCTAssertNil(attributes(of: "Fix login crash", in: string)[.chatBusy])
        let layout = ChatTextLayout(string, width: 320)
        let items = ChatSheen.items(layout, frame: CGRect(x: 10, y: 20, width: 320, height: layout.size.height), ground: Palette.surface)
        XCTAssertEqual(items.count, 1)
        guard case .sheen(let copy, let frame, let run)? = items.first else { return XCTFail("no band") }
        XCTAssertEqual(frame.origin, CGPoint(x: 10, y: 20))
        XCTAssertEqual(copy.string.string, string.string)
        XCTAssertGreaterThan(run.minX, 0)
        XCTAssertGreaterThan(run.width, 0)
        // The copy shows only the link's words.
        let clear = copy.string.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? UIColor
        XCTAssertEqual(clear?.cgColor.alpha, 0)
    }
}
#endif
