#if canImport(UIKit)
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import UIKit.UIGestureRecognizerSubclass
import XCTest

/// Carrying a row through home's list as a finger does it, with stories on
/// (two-line rows with their statuses, among headings and separators): the
/// lifted card is the row as drawn, the rows around it open a gap exactly
/// its height, the drop is the document's edit for that gap, and nothing
/// moves when the edited document comes back.
@MainActor
final class HostedSidebarDragTests: XCTestCase {
    private let html = """
    <nav>
      <happy-search/>
      <happy-create/>
      <happy-space id="happy"/>
      <happy-separator id="divider"/>
      <happy-section id="focus" label="Focus"/>
      <happy-space id="notes" expanded="true"><happy-space id="changelog"/><happy-space id="shots"/></happy-space>
      <happy-space id="landing"/>
      <happy-space id="triage"/>
      <happy-section id="tasks" label="Tasks"/>
      <happy-space id="perf"/>
      <happy-space id="android"/>
      <happy-space id="docs"/>
      <happy-separator id="older"/>
      <happy-space id="review"/>
      <happy-section id="later" label="Later" collapsed="true"/>
      <happy-space id="icons"/>
    </nav>
    """

    /// Every row of `document`, nested ones included, each with a status.
    private func all(_ document: SpaceSidebarDocument) -> [Row] {
        func rows(_ node: SpaceSidebarNode, depth: Int) -> [Row] {
            let kind: Row.Kind = switch node.kind {
            case .search: .search
            case .create: .create
            case .section: .section
            case .separator: .separator
            case .widget: .widget
            case .space: depth == 0 ? .space : .session
            }
            var row = Row(id: node.id, nodeId: node.id, kind: kind, depth: depth, label: node.kind == .section ? node.label : node.id.capitalized,
                          collapsed: node.kind == .section ? node.collapsed : node.children.isEmpty ? nil : !node.expanded, isHappy: node.id == "happy")
            if kind == .space || kind == .session { row.statusLine = "Working on \(node.id): a status long enough to wrap to its second line" }
            return [row] + node.children.flatMap { rows($0, depth: depth + 1) }
        }
        return document.items.flatMap { rows($0, depth: 0) }
    }

    /// What home draws of `document` with stories on.
    private func drawn(_ document: SpaceSidebarDocument) -> [Row] {
        Rows.withStories(Rows.visible(all(document)).filter { !Drop.isHidden($0) }, rings: [:])
    }

    /// A finger UIKit never sent: where it is and how it stands.
    private final class Finger: UIPanGestureRecognizer {
        var at: CGPoint = .zero
        var down: CGPoint = .zero
        var phase: UIGestureRecognizer.State = .began
        override var state: UIGestureRecognizer.State {
            get { phase }
            set { phase = newValue }
        }
        override func location(in view: UIView?) -> CGPoint { view?.convert(at, from: nil) ?? at }
        override func translation(in view: UIView?) -> CGPoint { CGPoint(x: at.x - down.x, y: at.y - down.y) }
    }

    private func list() async throws -> SidebarView {
        LegacyFonts.registerBundledFonts()
        let scene = try await hostedActiveScene()
        let previous = scene.keyWindow
        let controller = UIViewController()
        let window = hostedKeyWindow(in: scene, root: controller)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            previous?.makeKey()
        }
        window.layoutIfNeeded()
        let list = SidebarView(frame: controller.view.bounds)
        controller.view.addSubview(list)
        return list
    }

    func testACarriedStoryRowKeepsItsSizeAndLandsWhereItsGapWas() async throws {
        try await carry(html)
    }

    /// Folded, Notes' sessions are not drawn either way: the rows a carry
    /// shows are the story rows still.
    func testTheSameWithTheSessionsFolded() async throws {
        try await carry(html.replacingOccurrences(of: #"id="notes" expanded="true""#, with: #"id="notes""#))
    }

    /// A carry made from rows other than the ones drawn (plain rows where
    /// story rows are drawn) lifts nothing, rather than drawing every row
    /// at another size while it is on.
    func testADragMadeFromOtherRowsLiftsNothing() async throws {
        let list = try await list()
        let document = try SpaceSidebar.parse(html.replacingOccurrences(of: #"id="notes" expanded="true""#, with: #"id="notes""#))
        let everything = all(document)
        list.beginDrag = { row in Drag(holding: row.id, drawn: Rows.visible(everything).filter { !Drop.isHidden($0) }, all: everything, document: document) }
        list.apply(drawn(document))
        list.layoutIfNeeded()
        let before = list.rows.map { list.view(for: $0.id)!.frame }
        list.armReorder("landing")
        list.layoutIfNeeded()
        XCTAssertNil(list.liftedCard)
        XCTAssertEqual(list.rows.map { list.view(for: $0.id)!.frame }, before)
        XCTAssertFalse(list.rows.contains { list.view(for: $0.id)!.isHidden })
    }

    /// A hold lifts a row that can be carried as itself, exactly where and
    /// as big as it is drawn, not as its conversation's card: moving on then
    /// carries the same size. Happy's row, which never moves, still shows
    /// its conversation.
    func testAHoldLiftsACarriableRowAtItsOwnSize() async throws {
        let list = try await list()
        let document = try SpaceSidebar.parse(html)
        let everything = all(document)
        list.beginDrag = { [unowned list] row in Drag(holding: row.id, drawn: list.rows, all: everything, document: document) }
        list.menu = { _ in [[MenuItem(title: "Reorder", icon: "reorder") {}]] }
        var previewed: [String] = []
        list.preview = { row in
            previewed.append(row.id)
            let preview = UIViewController()
            preview.preferredContentSize = CGSize(width: 190, height: 230)
            return preview
        }
        list.apply(drawn(document))
        list.layoutIfNeeded()
        let window = try XCTUnwrap(list.window)
        func hold(_ id: String) throws -> HoldOverlay? {
            let view = try XCTUnwrap(list.view(for: id))
            list.openHold(at: CGPoint(x: view.frame.midX, y: view.frame.midY))
            return window.rootViewController?.view.subviews.compactMap { $0 as? HoldOverlay }.last
        }
        let landing = try XCTUnwrap(list.view(for: "landing"))
        let overlay = try XCTUnwrap(try hold("landing"), "no hold")
        let card = try XCTUnwrap(overlay.subviews.first { $0.subviews.first?.bounds.size == landing.bounds.size }, "the lifted card is not the row's size")
        XCTAssertEqual(card.convert(card.bounds, to: window), landing.convert(landing.bounds, to: window), "lifted where it is drawn")
        XCTAssertEqual(previewed, [], "a carriable row showed its conversation")
        overlay.close(animated: false)
        _ = try hold("happy")
        XCTAssertEqual(previewed, ["happy"])
    }

    private func carry(_ html: String) async throws {
        let list = try await list()
        var document = try SpaceSidebar.parse(html)
        let everything = all(document)
        list.beginDrag = { [unowned list] row in Drag(holding: row.id, drawn: list.rows, all: everything, document: document) }
        var dropped: (drag: Drag, to: Int)?
        list.onDrop = { drag, to in dropped = (drag, to) }
        list.apply(drawn(document))
        list.layoutIfNeeded()
        // Two-line story rows: the sessions under Notes are not drawn.
        XCTAssertEqual(list.rows.map(\.id), ["happy", "divider", "focus", "notes", "landing", "triage", "tasks", "perf", "android", "docs", "older", "review", "later"])
        let landing = try XCTUnwrap(list.view(for: "landing"))
        let home = landing.frame
        XCTAssertEqual(home.height, SidebarLayout.storyHeight(StoryRowText.scale(list.traitCollection)), "a story row with its status line")

        // Lifted: the card is the row as it was drawn, whole.
        list.armReorder("landing")
        let card = try XCTUnwrap(list.liftedCard, "nothing lifted")
        XCTAssertEqual(card.bounds.size.height, home.height, "the lifted card is the row's height")
        XCTAssertEqual(card.bounds.size.width, home.width, accuracy: 0.5, "the lifted card is the row's width")
        XCTAssertTrue(landing.isHidden)

        // Carried down past Triage, the Tasks heading and Perf.
        let finger = Finger()
        finger.down = list.convert(CGPoint(x: home.midX, y: home.midY), to: nil)
        finger.at = finger.down
        finger.phase = .began
        list.reorderPanned(finger)
        let others = ["triage", "tasks", "perf"].map { list.view(for: $0)!.frame }
        let travel = others.reduce(0) { $0 + $1.height } + 3 * 8
        finger.at.y += travel
        finger.phase = .changed
        list.reorderPanned(finger)
        let order = ["happy", "divider", "focus", "notes", "triage", "tasks", "perf", "landing", "android", "docs", "older", "review", "later"]
        XCTAssertEqual(list.shownRows.map(\.id), order)
        // Every row keeps its size; the gap is the row's own height, and it
        // stands exactly where the rows drawn in that order put it.
        let expected = SidebarLayout.layout(SidebarView.layoutRows(list.shownRows, textScale: StoryRowText.scale(list.traitCollection)), width: list.bounds.width, scale: list.traitCollection.displayScale).frames
        for (row, frame) in zip(list.shownRows, expected) {
            let view = try XCTUnwrap(list.view(for: row.id))
            XCTAssertEqual(view.frame, frame.box, "\(row.id) during the carry")
        }
        let gap = try XCTUnwrap(list.view(for: "landing")).frame
        XCTAssertEqual(gap.height, home.height, "the gap is the carried row's height")
        XCTAssertEqual(try XCTUnwrap(list.view(for: "perf")).frame.maxY, gap.minY - StoryRowMetrics.rowGap, accuracy: 0.01)
        XCTAssertEqual(try XCTUnwrap(list.view(for: "android")).frame.minY, gap.maxY + StoryRowMetrics.rowGap, accuracy: 0.01)

        // Let go: the drop is the document's move to that gap.
        finger.phase = .ended
        list.reorderPanned(finger)
        let drop = try XCTUnwrap(dropped, "nothing dropped")
        guard case .some(let after) = drop.drag.after(to: drop.to) else { return XCTFail("the drop changed nothing") }
        XCTAssertEqual(after, "perf")
        document = try XCTUnwrap(SidebarDocumentEdits.move(document, "landing", after: after))
        XCTAssertEqual(document.items.map(\.id), ["happy-search", "happy-create", "happy", "divider", "focus", "notes", "triage", "tasks", "perf", "landing", "android", "docs", "older", "review", "later", "icons"])
        let atDrop = Dictionary(uniqueKeysWithValues: order.map { ($0, list.view(for: $0)!.frame) })

        // The edited document comes back, and the card lands: nothing moves.
        list.apply(drawn(document))
        list.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(450))
        list.layoutIfNeeded()
        XCTAssertNil(list.liftedCard, "the card is gone once it has landed")
        XCTAssertEqual(list.shownRows.map(\.id), order)
        for id in order {
            let view = try XCTUnwrap(list.view(for: id))
            XCTAssertFalse(view.isHidden, "\(id) shows again")
            XCTAssertEqual(view.frame, atDrop[id], "\(id) jumped when the document confirmed the drop")
        }
    }
}
#endif
