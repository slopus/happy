#if canImport(UIKit)
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Home's grouped list as drawn: a card under each heading exactly where the
/// layout puts it, rows that are its cells (their corners the card's,
/// hairlines between them), iOS's highlight clipped to the card's shape, a
/// fold that takes the card with it, and a carry whose gap is the card's.
@MainActor
final class HostedGroupedSidebarTests: XCTestCase {
    private let html = """
    <nav>
      <happy-search/>
      <happy-create/>
      <happy-space id="happy"/>
      <happy-section id="tasks" label="Tasks"/>
      <happy-space id="landing"/>
      <happy-space id="notes" expanded="true"><happy-space id="changelog"/><happy-space id="shots"/></happy-space>
      <happy-space id="triage"/>
      <happy-section id="bots" label="Bots"/>
      <happy-space id="research"/>
      <happy-space id="release"/>
      <happy-separator id="older"/>
      <happy-space id="review"/>
      <happy-section id="later" label="Later" collapsed="true"/>
      <happy-space id="icons"/>
    </nav>
    """

    private func all(_ document: SpaceSidebarDocument) -> [Row] {
        func rows(_ node: SpaceSidebarNode, depth: Int) -> [Row] {
            let kind: Row.Kind = switch node.kind {
            case .section: .section
            case .separator: .separator
            default: depth == 0 ? .space : .session
            }
            let row = Row(id: node.id, nodeId: node.id, kind: kind, depth: depth, label: node.kind == .section ? node.label : node.id.capitalized,
                          mark: kind == .space || kind == .session ? .glyph("tasks") : .none,
                          collapsed: node.kind == .section ? node.collapsed : node.children.isEmpty ? nil : !node.expanded, isHappy: node.id == "happy")
            return [row] + node.children.flatMap { rows($0, depth: depth + 1) }
        }
        // Search and Create stay in the document for desktop; a phone draws neither.
        return document.items.filter { $0.kind != .search && $0.kind != .create }.flatMap { rows($0, depth: 0) }
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
        list.style = .grouped
        controller.view.addSubview(list)
        return list
    }

    private func expected(_ list: SidebarView) -> SidebarLayout.Result {
        SidebarLayout.layout(SidebarView.layoutRows(list.shownRows), width: list.bounds.width, top: GroupedSidebarMetrics.contentTop, bottom: GroupedSidebarMetrics.contentBottom, scale: list.traitCollection.displayScale, style: .grouped)
    }

    private static let top: CACornerMask = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
    private static let bottom: CACornerMask = [.layerMinXMaxYCorner, .layerMaxXMaxYCorner]

    /// A dynamic colour as `view` draws it now.
    private func ink(_ color: UIColor?, in view: UIView) -> UIColor? { color?.resolvedColor(with: view.traitCollection) }
    private func ink(_ token: ColorToken, in view: UIView) -> UIColor { UIColor(token).resolvedColor(with: view.traitCollection) }

    func testCardsAndCellsAreWhereTheLayoutPutsThem() async throws {
        let list = try await list()
        let document = try SpaceSidebar.parse(html)
        list.apply(Rows.visible(all(document)))
        list.layoutIfNeeded()
        let layout = expected(list)
        XCTAssertEqual(list.rows.map(\.id), ["happy", "tasks", "landing", "notes", "changelog", "shots", "triage", "bots", "research", "release", "older", "review", "later"])
        // Happy's own card, Tasks', Bots', the one after the separator; Later is folded.
        XCTAssertEqual(list.cardFrames, layout.groups.map(\.frame))
        XCTAssertEqual(list.cardFrames.count, 4)
        for (row, frame) in zip(list.rows, layout.frames) {
            XCTAssertEqual(try XCTUnwrap(list.view(for: row.id)).frame, frame.box, row.id)
        }
        func corners(_ id: String) throws -> (radius: CGFloat, mask: CACornerMask) { try XCTUnwrap(list.view(for: id)).fillCorners }
        // A card of one: all four corners.
        XCTAssertEqual(try corners("happy").mask, Self.top.union(Self.bottom))
        XCTAssertEqual(try corners("happy").radius, GroupedSidebarMetrics.radius)
        // Tasks' card: the first row its top, nested rows square, the last its bottom.
        XCTAssertEqual(try corners("landing").mask, Self.top)
        XCTAssertEqual(try corners("changelog").radius, 0)
        XCTAssertEqual(try corners("triage").mask, Self.bottom)
        // Hairlines from each title to the card's end, none under a card's last row.
        let landing = try XCTUnwrap(list.view(for: "landing"))
        let hairline = try XCTUnwrap(landing.hairlineFrame.map { landing.convert($0, to: list) })
        let separator = try XCTUnwrap(layout.frames[2].cell?.separator)
        for (drawn, laid) in zip([hairline.minX, hairline.minY, hairline.width, hairline.height], [separator.minX, separator.minY, separator.width, separator.height]) {
            XCTAssertEqual(drawn, laid, accuracy: 0.0001)
        }
        XCTAssertNil(try XCTUnwrap(list.view(for: "triage")).hairlineFrame)
        XCTAssertNil(try XCTUnwrap(list.view(for: "happy")).hairlineFrame)
        // A cell rests on the card's fill; a heading on the ground.
        XCTAssertEqual(ink(landing.fillColor, in: landing), ink(Palette.groupedCard, in: landing))
        XCTAssertEqual(try XCTUnwrap(list.view(for: "tasks")).fillColor, .clear)
    }

    /// A finger or the open screen lights the cell in iOS's grey, clipped to
    /// the card's corners; a heading never lights.
    func testTheHighlightIsTheCellsShape() async throws {
        let list = try await list()
        list.onSelect = { _ in }
        list.apply(Rows.visible(all(try SpaceSidebar.parse(html))))
        list.layoutIfNeeded()
        let triage = try XCTUnwrap(list.view(for: "triage"))
        triage.pressed = true
        XCTAssertEqual(ink(triage.fillColor, in: triage), ink(Palette.groupedCellHighlight, in: triage))
        XCTAssertEqual(triage.fillCorners.mask, Self.bottom)
        triage.pressed = false
        list.selectedRowId = "triage"
        XCTAssertEqual(ink(triage.fillColor, in: triage), ink(Palette.groupedCellHighlight, in: triage))
        let heading = try XCTUnwrap(list.view(for: "tasks"))
        heading.pressed = true
        XCTAssertEqual(heading.fillColor, .clear)
    }

    /// Folding Tasks from its heading: its card goes, everything under it
    /// moves up to where the layout puts it, and opening it brings the card back.
    func testAFoldTakesTheCardWithIt() async throws {
        let list = try await list()
        let everything = all(try SpaceSidebar.parse(html))
        var folded = Set<String>()
        func shown() -> [Row] {
            Rows.visible(everything.map { row in
                var row = row
                if folded.contains(row.id) { row.collapsed = !(row.collapsed ?? false) }
                return row
            })
        }
        list.onFold = { [unowned list] row in
            if !folded.insert(row.id).inserted { folded.remove(row.id) }
            list.apply(shown())
        }
        list.apply(shown())
        list.layoutIfNeeded()
        let heading = try XCTUnwrap(list.view(for: "tasks"))
        list.tap(heading, at: CGPoint(x: heading.frame.midX, y: heading.frame.midY))
        list.layoutIfNeeded()
        XCTAssertEqual(list.rows.map(\.id), ["happy", "tasks", "bots", "research", "release", "older", "review", "later"])
        XCTAssertEqual(list.cardFrames, expected(list).groups.map(\.frame))
        XCTAssertEqual(list.cardFrames.count, 3)
        for (row, frame) in zip(list.rows, expected(list).frames) {
            XCTAssertEqual(try XCTUnwrap(list.view(for: row.id)).frame, frame.box, row.id)
        }
        list.tap(heading, at: CGPoint(x: heading.frame.midX, y: heading.frame.midY))
        list.layoutIfNeeded()
        XCTAssertEqual(list.cardFrames, expected(list).groups.map(\.frame))
        XCTAssertEqual(list.cardFrames.count, 4)
    }

    /// The plain list (search, the session tree, proposals) draws no card.
    /// A top-level glyph sits on its kind's tile; a nested row has no mark,
    /// so no tile; the plain list draws none.
    func testGlyphsSitOnTheirKindsTile() async throws {
        let list = try await list()
        var rows = Rows.visible(all(try SpaceSidebar.parse(html)))
        for index in rows.indices where rows[index].depth > 0 { rows[index].mark = .none }
        if let index = rows.firstIndex(where: { $0.id == "research" }) { rows[index].targetKind = "bot" }
        list.apply(rows)
        list.layoutIfNeeded()
        let research = try XCTUnwrap(list.view(for: "research"))
        XCTAssertEqual(ink(research.tileColor, in: research), ink(Palette.tileIndigoFill, in: research))
        XCTAssertNil(try XCTUnwrap(list.view(for: "changelog")).tileColor)
        list.style = .plain
        XCTAssertNil(research.tileColor)
    }

    func testThePlainStyleDrawsNoCards() async throws {
        let list = try await list()
        list.style = .plain
        list.apply(Rows.visible(all(try SpaceSidebar.parse(html))))
        list.layoutIfNeeded()
        XCTAssertEqual(list.cardFrames, [])
        XCTAssertEqual(try XCTUnwrap(list.view(for: "landing")).fillColor, .clear)
        XCTAssertEqual(try XCTUnwrap(list.view(for: "landing")).frame, SidebarLayout.layout(SidebarView.layoutRows(list.rows), width: list.bounds.width, scale: list.traitCollection.displayScale).frames[2].box)
    }
}
#endif
