#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A reply many screens tall in the agents' transcript has views only for
/// the part of it on screen (`ChatChunks`), and that part is the one the
/// reader sees: the list is upside down and the row the right way up in it,
/// so the part the list reports is turned over. Taken as it came, the foot
/// of a long reply on screen mounted its head, and the screen was blank
/// until it scrolled past it.
@MainActor
final class HostedAgentTallRowTests: XCTestCase {
    private final class Screen: AgentChatTranscriptHost {
        func show(_ plan: ChatRowPlan, in view: ChatPlanView) { view.apply(plan) }
        func placedChunks(of plan: ChatRowPlan, in view: ChatPlanView) {}
        func transcriptScrolled() {}
        func transcriptWillBeginDragging() {}
        func transcriptDidEndDragging() {}
        func transcriptTapped(_ action: ChatRowAction) {}
        func transcriptOpened(_ url: String) {}
        func transcriptHeld(_ action: ChatRowAction, in view: UIView, frame: CGRect, at point: CGPoint) {}
    }

    /// A reply `height` tall: a box every 100 points down it.
    private func tall(_ id: String, height: CGFloat) -> ChatRowPlan {
        let items: [ChatDrawItem] = stride(from: 0, to: height, by: 100).map { y in
            .box(ChatBox(frame: CGRect(x: 16, y: y + 10, width: 358, height: 80), fill: Palette.surface))
        }
        return ChatRowPlan(id: id, size: CGSize(width: 390, height: height), items: items)
    }

    private static func boxes(in view: UIView) -> [UIView] {
        view.subviews.flatMap { subview -> [UIView] in
            subview is ChatPlanView ? boxes(in: subview) : (subview.isHidden ? [] : [subview])
        }
    }

    private func until(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition(), "timed out", file: file, line: line)
    }

    func testTheFootOfALongReplyOnScreenIsDrawn() async throws {
        let screen = Screen()
        let transcript = AgentChatUltraList(frame: CGRect(x: 0, y: 0, width: 390, height: 800))
        transcript.host = screen
        defer { transcript.deactivate() }
        let scene = try await hostedActiveScene()
        let original = scene.keyWindow
        let root = UIViewController()
        let window = hostedKeyWindow(in: scene, root: root)
        defer {
            window.isHidden = true
            original?.makeKey()
        }
        root.view.addSubview(transcript)
        transcript.setViewport(frame: CGRect(origin: .zero, size: transcript.bounds.size), insets: UIEdgeInsets(top: 100, left: 0, bottom: 120, right: 0))
        // The newest reply is 12,000 points: the screen rests on its foot.
        transcript.apply([tall("question", height: 300), tall("answer", height: 12_000)])
        window.layoutIfNeeded()

        let viewport = transcript.convert(CGRect(x: 0, y: 100, width: 390, height: 580), to: window)
        var shown: [CGRect] = []
        try await until {
            transcript.layoutIfNeeded()
            guard let row = Self.rows(in: transcript).first(where: { $0.row.plan.id == "answer" }) else { return false }
            shown = Self.boxes(in: row.canvas).map { $0.convert($0.bounds, to: window) }.filter { $0.intersects(viewport) }
            return !shown.isEmpty
        }
        XCTAssertFalse(shown.isEmpty, "nothing of the reply on screen has a view: the part mounted is another")
        // Its foot is what shows, low on the screen, over the composer.
        let foot = try XCTUnwrap(shown.map(\.maxY).max())
        XCTAssertGreaterThan(foot, viewport.midY)
    }

    /// The part on screen, in the list's coordinates, turned over into the row's.
    func testThePartOnScreenIsTurnedOver() {
        XCTAssertEqual(AgentChatRowView.band(of: CGRect(x: 0, y: 0, width: 390, height: 600), height: 12_000),
                       CGRect(x: 0, y: 11_400, width: 390, height: 600))
        XCTAssertEqual(AgentChatRowView.band(of: CGRect(x: 0, y: 200, width: 390, height: 100), height: 1000),
                       CGRect(x: 0, y: 700, width: 390, height: 100))
    }

    private static func rows(in view: UIView) -> [AgentChatRowView] {
        ((view as? AgentChatRowView).map { [$0] } ?? []) + view.subviews.flatMap { rows(in: $0) }
    }
}
#endif
