#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A conversation someone looped the person into: its sidebar row stands
/// out until opened, and the message that names the person sets the name
/// apart. With `HAPPY_PREVIEW_DIR` set, each test also writes what it drew
/// there as a PNG to look at.
@MainActor
final class LoopInTests: XCTestCase {
    private static func rows(newOne: Bool) -> [Row] {
        var rows = [
            Row(id: "section:work", nodeId: "work", kind: .section, label: "Work", collapsed: false),
            Row(id: "space:happy", nodeId: "happy", kind: .space, label: "Happy", mark: .happy, isHappy: true),
            Row(id: "space:voice", nodeId: "voice", kind: .space, label: "Voice mode polish", mark: .clay("waveform"), status: .working),
            Row(id: "space:mic", nodeId: "mic", kind: .space, label: "Microphone permission copy", mark: .clay("microphone")),
            Row(id: "space:audio", nodeId: "audio", kind: .space, label: "Headphone route changes", mark: .clay("headphones"), unread: true),
        ]
        rows[3].isNew = newOne
        return rows
    }

    private static func sidebar(_ rows: [Row]) -> SidebarView {
        let sidebar = SidebarView(frame: CGRect(x: 0, y: 0, width: 402, height: 300))
        sidebar.overrideUserInterfaceStyle = .light
        sidebar.backgroundColor = UIColor(Palette.surface)
        sidebar.apply(rows)
        sidebar.layoutIfNeeded()
        return sidebar
    }

    private func rowView(_ sidebar: SidebarView, _ id: String) -> RowView? {
        sidebar.subviews.compactMap { $0 as? RowView }.first { $0.row?.id == id }
    }

    private func keep(_ view: UIView, _ name: String) {
        guard let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] else { return }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 3
        view.layer.setNeedsDisplay()
        view.layer.displayIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: view.bounds, format: format).image { context in view.layer.render(in: context.cgContext) }
        try? image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
    }

    /// The new row wears the tint, a dot in its trailing square and a bold
    /// title; opened (selected), it looks like any open row.
    func testANewRowStandsOutUntilOpened() throws {
        let sidebar = Self.sidebar(Self.rows(newOne: true))
        keep(sidebar, "loop-in-sidebar")
        let index = try XCTUnwrap(sidebar.rows.firstIndex { $0.id == "space:mic" })
        let frame = try XCTUnwrap(sidebar.layoutResult?.frames[index])
        XCTAssertNotNil(frame.trailing, "the new row's dot has no square")
        let view = try XCTUnwrap(rowView(sidebar, "space:mic"))
        XCTAssertEqual(view.accessibilityValue, "new, microphone")
        let fill = try XCTUnwrap(view.subviews.first?.backgroundColor).resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))
        XCTAssertEqual(fill, UIColor(Palette.rowNew).resolvedColor(with: UITraitCollection(userInterfaceStyle: .light)))
        // Its neighbour, not new, has neither.
        let other = try XCTUnwrap(sidebar.layoutResult?.frames[index + 1])
        XCTAssertNil(other.trailing)

        sidebar.selectedRowId = "space:mic"
        let opened = try XCTUnwrap(view.subviews.first?.backgroundColor).resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))
        XCTAssertEqual(opened, UIColor(Palette.rowSelected).resolvedColor(with: UITraitCollection(userInterfaceStyle: .light)))

        // Read: the row goes back to how any row looks.
        sidebar.selectedRowId = nil
        sidebar.apply(Self.rows(newOne: false))
        sidebar.layoutIfNeeded()
        XCTAssertNil(sidebar.layoutResult?.frames[index].trailing)
        XCTAssertEqual(view.accessibilityValue, "microphone")
    }

    /// "@Steve" in the mention's ink and strong face, on a tint because
    /// Steve is reading; another person's mention has no tint.
    func testAMentionOfTheReaderIsSetApart() throws {
        var references = References()
        references.users = ["u-steve": "Steve", "u-kirill": "Kirill"]
        references.me = "u-steve"
        let text = "<happy-user id=\"u-steve\"/>, could you take a pass at the voice screen? <happy-user id=\"u-kirill\"/> wants the new waveform icon in it."
        let spans = LegacyMarkdown.parseSpans(HappyReferences.markdown(text, view: references.view), header: false)
        let string = ChatSpans.string(spans, style: ChatTextStyles.text, color: Palette.text, in: nil)
        XCTAssertTrue(string.string.hasPrefix("@Steve, could you"), string.string)

        let light = UITraitCollection(userInterfaceStyle: .light)
        func attributes(of word: String) -> [NSAttributedString.Key: Any] {
            string.attributes(at: (string.string as NSString).range(of: word).location, effectiveRange: nil)
        }
        let steve = attributes(of: "@Steve")
        XCTAssertEqual((steve[.foregroundColor] as? UIColor)?.resolvedColor(with: light), UIColor(Palette.mention).resolvedColor(with: light))
        XCTAssertEqual((steve[.backgroundColor] as? UIColor)?.resolvedColor(with: light), UIColor(Palette.mentionMe).resolvedColor(with: light))
        XCTAssertNil(steve[.underlineStyle])
        let kirill = attributes(of: "@Kirill")
        XCTAssertEqual((kirill[.foregroundColor] as? UIColor)?.resolvedColor(with: light), UIColor(Palette.mention).resolvedColor(with: light))
        XCTAssertNil(kirill[.backgroundColor])
        XCTAssertNil(attributes(of: "could")[.backgroundColor])

        let layout = ChatTextLayout(string, width: 354)
        let canvas = MessagePreview(layout)
        canvas.overrideUserInterfaceStyle = .light
        keep(canvas, "loop-in-mention")
    }
}

/// An HTML artifact a call shows that asks to be inline: its card, then
/// its page under it, at the height the page measured once it has.
@MainActor
final class InlinePagePlanTests: XCTestCase {
    func testThePageSitsUnderItsCardAtItsMeasuredHeight() throws {
        let artifact = Artifact(id: "art1", version: 1, type: "html", title: "Voice waveform", followsLatest: true)
        let item = ChatItem(id: "m1", role: .agent, pieces: [.artifact(artifact)], delivery: .sent)
        var key = ChatPlanner.Key(width: 393, maxContentWidth: 10_000, environment: nil)
        func pages(_ plan: ChatRowPlan) -> [(InlinePage, CGRect)] {
            plan.items.compactMap { if case .embed(.page(let page), let frame) = $0 { (page, frame) } else { nil } }
        }
        // Not read yet, or not asking to be inline: the card alone.
        XCTAssertTrue(pages(ChatPlanner.plan(item, key: key, copied: false, syntax: CodeSyntaxService())).isEmpty)

        key.references.pages["art1"] = .init(version: 2, entry: "index.html")
        let plan = ChatPlanner.plan(item, key: key, copied: false, syntax: CodeSyntaxService())
        let (page, frame) = try XCTUnwrap(pages(plan).first)
        XCTAssertEqual(page, InlinePage(artifactId: "art1", title: "Voice waveform", page: .init(version: 2, entry: "index.html")))
        XCTAssertEqual(frame, CGRect(x: 16, y: 8 + ResultCardLayout.height + 8, width: 361, height: ChatPlanner.pageHeight))
        // The card still opens the artifact whole.
        XCTAssertTrue(plan.hits.contains { if case .openArtifact = $0.action { true } else { false } })

        key.pageHeights["art1"] = 152
        XCTAssertEqual(pages(ChatPlanner.plan(item, key: key, copied: false, syntax: CodeSyntaxService())).first?.1.height, 152)

        // A call that pinned one version is a record of it: a card, never the live page.
        let pinned = ChatItem(id: "m2", role: .agent, pieces: [.artifact(Artifact(id: "art1", version: 1, type: "html", title: "", followsLatest: false))], delivery: .sent)
        XCTAssertTrue(pages(ChatPlanner.plan(pinned, key: key, copied: false, syntax: CodeSyntaxService())).isEmpty)
    }
}

/// One message's text on the chat's ground, as the conversation draws it.
private final class MessagePreview: UIView {
    let layout: ChatTextLayout

    init(_ layout: ChatTextLayout) {
        self.layout = layout
        super.init(frame: CGRect(x: 0, y: 0, width: layout.width + 48, height: layout.size.height + 48))
        backgroundColor = UIColor(Palette.surface)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func draw(_ rect: CGRect) {
        layout.draw(at: CGPoint(x: 24, y: 24))
    }
}
#endif
