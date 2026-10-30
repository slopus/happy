#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import UltraView
import XCTest

/// What the agents' transcript keeps when UltraList moves its rows: the
/// order it reads in, the views it drew with, and the screen's say over
/// what each row shows.
@MainActor
final class AgentChatUltraListTests: XCTestCase {
    private final class Screen: AgentChatTranscriptHost {
        var shown: [(id: String, view: ChatPlanView)] = []
        var chunked: [String] = []
        var scrolls = 0
        var tapped: [ChatRowAction] = []
        var opened: [String] = []
        var held: [ChatRowAction] = []

        func show(_ plan: ChatRowPlan, in view: ChatPlanView) { shown.append((plan.id, view)) }
        func placedChunks(of plan: ChatRowPlan, in view: ChatPlanView) { chunked.append(plan.id) }
        func transcriptScrolled() { scrolls += 1 }
        func transcriptWillBeginDragging() {}
        func transcriptDidEndDragging() {}
        func transcriptTapped(_ action: ChatRowAction) { tapped.append(action) }
        func transcriptOpened(_ url: String) { opened.append(url) }
        func transcriptHeld(_ action: ChatRowAction, in view: UIView, frame: CGRect, at point: CGPoint) { held.append(action) }
    }

    private func plan(_ id: String, height: CGFloat = 60) -> ChatRowPlan {
        ChatRowPlan(id: id, size: CGSize(width: 390, height: height), items: [])
    }

    private func list(_ screen: Screen) -> AgentChatUltraList {
        let list = AgentChatUltraList(frame: CGRect(x: 0, y: 0, width: 390, height: 600))
        list.host = screen
        list.setViewport(size: CGSize(width: 390, height: 600), insets: UIEdgeInsets(top: 60, left: 0, bottom: 100, right: 0))
        return list
    }

    /// The screen hands its rows over oldest first, as it plans them; the
    /// list holds them newest first, since it is upside down, which reads
    /// as the newest at the foot.
    func testRowsGoInNewestFirstAndKeepTheirIdentities() {
        let screen = Screen()
        let transcript = list(screen)
        defer { transcript.deactivate() }
        transcript.apply([plan("first"), plan("second"), plan("third")])
        XCTAssertEqual(transcript.list.items.map(\.identity), ["chat:row:third", "chat:row:second", "chat:row:first"])
    }

    /// A plan that has not changed keeps its row, so the view it drew with
    /// is not made again; a new plan for the same message takes a new
    /// revision, which is what tells the list to show it again.
    func testAnUnchangedPlanKeepsItsRowAndANewOneTakesANewRevision() throws {
        let screen = Screen()
        let transcript = list(screen)
        defer { transcript.deactivate() }
        let settled = plan("settled")
        transcript.apply([settled, plan("streaming")])
        let first = try XCTUnwrap(transcript.list.items.last as? AgentChatRow)
        transcript.apply([settled, plan("streaming", height: 90)])
        let again = try XCTUnwrap(transcript.list.items.last as? AgentChatRow)
        XCTAssertTrue(first === again, "the settled row was made again")
        let streaming = transcript.list.items.compactMap { $0 as? AgentChatRow }.first { $0.identity == "chat:row:streaming" }
        XCTAssertEqual(streaming?.plan.size.height, 90)
        XCTAssertNotEqual(streaming?.revision, 0)
    }

    /// A row's view is the `ChatPlanView` the mounted transcript draws
    /// with, set up as that one is, and the screen is what shows the plan
    /// in it: its cards, media and VoiceOver are unchanged.
    func testARowDrawsWithThePlanViewTheScreenConfigures() throws {
        let screen = Screen()
        let transcript = list(screen)
        defer { transcript.deactivate() }
        let row = AgentChatRow(identity: "chat:row:one", revision: 1, plan: plan("one"), transcript: transcript)
        let view = try XCTUnwrap(row.makeView() as? AgentChatRowView)
        XCTAssertEqual(screen.shown.map(\.id), ["one"], "the screen shows the plan, not the row")
        XCTAssertTrue(screen.shown.first?.view === view.canvas)
        XCTAssertTrue(view.canvas.drawsStaticContent, "the row draws its own marks, as a mounted row does")
        XCTAssertTrue(view.canvas.cutsTallPlans, "a tall row still has views only where it shows")
        XCTAssertTrue(view.canvas.drawsTextOffMain)
        XCTAssertEqual(view.canvas.accessibilityIdentifier, "message")
        XCTAssertEqual(view.update(width: 390, transition: .none), 60, "as tall as its plan")
        // The part on screen is the part with views in it.
        let band = CGRect(x: 0, y: 10, width: 390, height: 40)
        view.visibleRectUpdated(band)
        XCTAssertEqual(view.canvas.band, band)
        view.visibleRectUpdated(nil)
        XCTAssertEqual(view.canvas.band, .null, "off screen: none of it")
    }

    /// Let go of, the list answers nothing: its rows go, and a row view
    /// still held by something asks the screen for nothing.
    func testALetGoOfListAnswersNothing() throws {
        let screen = Screen()
        let transcript = list(screen)
        transcript.apply([plan("one")])
        let row = try XCTUnwrap(transcript.list.items.first as? AgentChatRow)
        let view = try XCTUnwrap(row.makeView() as? AgentChatRowView)
        screen.shown.removeAll()
        transcript.deactivate()
        XCTAssertTrue(transcript.list.items.isEmpty)
        XCTAssertFalse(transcript.isActive)
        view.apply(row)
        XCTAssertTrue(screen.shown.isEmpty, "a row of a list let go of asked the screen to show it")
    }
}
#endif
