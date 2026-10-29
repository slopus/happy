#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit
import XCTest
@testable import HappyUI

/// desktop's failure card in a Stem Cells conversation: the reason, the
/// daemon's steps, and Retry, or a switch to the model the composer holds.
@MainActor
final class StemCellFailureCardTests: XCTestCase {
    private let failure = StemCellFailure(
        messageId: "s1", reason: "Codex usage limit reached until Wednesday at 3:00 PM.",
        steps: ["Wait for the limit to reset, or switch to another account."], providerId: "codex", modelId: "gpt-6.1-sol"
    )

    private func plan(_ failure: StemCellFailure, target: StemCellChatPlanner.SwitchTarget? = nil) -> ChatRowPlan {
        var key = StemCellChatPlanner.Key(width: 393, maxContentWidth: 10_000, environment: nil)
        key.switchTarget = target
        key.modelNames = ["sonnet-5.5": "Sonnet 5.5"]
        let item = StemCellChatItem(id: failure.messageId, role: .failure(failure), pieces: [.text(failure.reason)], delivery: .sent)
        return StemCellChatPlanner.plan(item, key: key, copied: false, syntax: CodeSyntaxService())
    }

    private func mode(_ provider: String, _ model: String) -> AgentWire.Mode {
        AgentWire.Mode(providerId: provider, modelId: model, effort: "high", serviceTier: nil, permissionMode: "auto")
    }

    /// With `HAPPY_PREVIEW_DIR` set, what the card draws, as a PNG to look at.
    private func preview(_ plan: ChatRowPlan, _ name: String) {
        guard let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] else { return }
        let view = ChatPlanView(frame: CGRect(origin: .zero, size: plan.size))
        view.backgroundColor = UIColor(Palette.surface)
        view.apply(plan)
        view.layoutIfNeeded()
        let format = UIGraphicsImageRendererFormat()
        format.scale = 3
        let image = UIGraphicsImageRenderer(bounds: view.bounds, format: format).image { context in
            view.layer.setNeedsDisplay()
            view.layer.displayIfNeeded()
            view.layer.render(in: context.cgContext)
        }
        try? image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
    }

    func testTheCardSaysWhatFailedAndOffersRetry() {
        let card = plan(failure, target: .init(mode: mode("codex", "gpt-6.1-sol"), label: "GPT-6.1 Sol"))
        preview(card, "failure-retry")
        preview(plan(failure, target: .init(mode: mode("claude", "sonnet-5.5"), label: "Sonnet 5.5")), "failure-switch")
        XCTAssertGreaterThan(card.size.height, 0)
        XCTAssertEqual(card.accessibilityLabel, "Failure\n\nCodex usage limit reached until Wednesday at 3:00 PM.\n\nWait for the limit to reset, or switch to another account.\n\nRetry")
        XCTAssertEqual(card.hits.first?.action, .retry(localId: "s1"))
        XCTAssertEqual(StemCellChatPlanner.action(failure, target: .init(mode: mode("codex", "gpt-6.1-sol"), label: "GPT-6.1 Sol")), .retry)
    }

    func testAnotherModelInTheComposerIsOfferedToContinueOn() {
        let target = StemCellChatPlanner.SwitchTarget(mode: mode("claude", "sonnet-5.5"), label: "Sonnet 5.5")
        let card = plan(failure, target: target)
        XCTAssertTrue((card.accessibilityLabel ?? "").hasSuffix("Switch to Sonnet 5.5 and continue"))
        XCTAssertEqual(StemCellChatPlanner.action(failure, target: target), .switchTo(target))
        XCTAssertEqual(card.hits.first?.action, .retry(localId: "s1"))
    }

    func testOnceActedOnItSaysWhatWasDoneAndOffersNothing() {
        var switched = failure
        switched.resolution = .switched(providerId: "claude", modelId: "sonnet-5.5")
        let card = plan(switched)
        XCTAssertTrue((card.accessibilityLabel ?? "").hasSuffix("Switched to Sonnet 5.5"))
        XCTAssertFalse(card.hits.contains { $0.action == .retry(localId: "s1") })
        var tooLong = failure
        tooLong.retryable = false
        XCTAssertNil(StemCellChatPlanner.action(tooLong, target: nil))
    }
}
#endif
