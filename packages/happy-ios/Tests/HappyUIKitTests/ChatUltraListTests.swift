#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

@MainActor
final class ChatUltraListTests: XCTestCase {
    private func row(_ plan: ChatRowPlan, revision: UInt64 = 1, adapter: ChatUltraListAdapter) -> ChatUltraRow {
        ChatUltraRow(identity: plan.id, revision: revision, plan: plan, contentY: 0, adapter: adapter)
    }

    func testTallMessagesAndPainterOverlapRetainNativeDrawing() {
        let adapter = ChatUltraListAdapter(olderEnd: ChatOlderEndView())
        let tall = ChatRowPlan(id: "tall", size: .init(width: 390, height: 6000), items: [])
        XCTAssertTrue(row(tall, adapter: adapter).usesNativeDrawing)
        let frame = CGRect(x: 10, y: 10, width: 20, height: 20)
        let spinner = ChatDrawItem.spinner(frame, tint: Palette.text, scale: 1)
        let box = ChatDrawItem.box(ChatBox(frame: frame, fill: Palette.surface))
        let size = CGSize(width: 390, height: 100)
        XCTAssertFalse(row(ChatRowPlan(id: "behind", size: size, items: [box, spinner]), adapter: adapter).usesNativeDrawing)
        XCTAssertTrue(row(ChatRowPlan(id: "over", size: size, items: [spinner, box]), adapter: adapter).usesNativeDrawing)
        adapter.deactivate()
    }

    func testUpdatedRowKeepsNativeScrollerAndMermaidViewsAndInvalidatesOldActions() throws {
        let adapter = ChatUltraListAdapter(olderEnd: ChatOlderEndView())
        let size = CGSize(width: 390, height: 400)
        let inner = ChatRowPlan(id: "code", size: .init(width: 1000, height: 60), items: [])
        let diagram = ChatMermaid(row: "message", index: 0, content: "graph TD; A-->B")
        let items: [ChatDrawItem] = [
            .scroller(inner, frame: .init(x: 0, y: 0, width: 390, height: 60)),
            .mermaid(diagram, frame: .init(x: 0, y: 80, width: 390, height: 200)),
        ]
        let first = row(ChatRowPlan(id: "message", size: size, items: items), adapter: adapter)
        let view = try XCTUnwrap(first.makeView() as? ChatUltraRowView)
        let scroller = try XCTUnwrap(view.canvas.subviews.first { $0 is ChatScrollerView } as? ChatScrollerView)
        let mermaid = try XCTUnwrap(view.canvas.subviews.first { $0 is ChatMermaidView })
        scroller.contentOffset.x = 170
        let changed = row(ChatRowPlan(id: "message", size: size, items: items, alpha: 0.5), revision: 2, adapter: adapter)
        changed.apply(to: view, transition: .none)
        XCTAssertTrue(view.canvas.subviews.contains { $0 === scroller })
        XCTAssertTrue(view.canvas.subviews.contains { $0 === mermaid })
        XCTAssertEqual(scroller.contentOffset.x, 170)
        XCTAssertEqual(view.canvas.alpha, 0.5)
        var actions = 0
        adapter.onAction = { _ in actions += 1 }
        view.canvas.onAction?(.toggleTool("tool"))
        XCTAssertEqual(actions, 1)
        adapter.deactivate()
        view.canvas.onAction?(.toggleTool("tool"))
        XCTAssertEqual(actions, 1, "departed renderers cannot act on an old account")
    }
}
#endif