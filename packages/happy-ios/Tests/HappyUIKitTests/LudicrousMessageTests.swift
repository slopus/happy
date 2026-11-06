#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import XCTest
@testable import HappyUI

/// A person's message shows whole, and only one past
/// `MessageLayout.Metrics.foldLines` folds. A pasted blob that size costs the
/// main thread next to nothing: it is measured off the main thread, folded
/// to 70 lines, and opened it is drawn a tile at a time, never as one bitmap
/// the height of the blob.
@MainActor
final class LudicrousMessageTests: XCTestCase {
    private let key = ChatPlanner.Key(width: 390, maxContentWidth: 10_000, environment: TextEnvironment(scale: .standard, displayScale: 3))

    /// About a megabyte with no line breaks at all, as a pasted log line or
    /// base64 would be.
    private let blob = String(repeating: "0123456789abcdefghijklmnopqrstuvwxyz ", count: 28_000)

    private func plan(_ text: String, opened: Bool) async -> (ChatRowPlan, Duration) {
        let item = ChatItem(id: "u1", role: .user, pieces: [.text(text)], delivery: .sending, time: 1_000)
        let key = key
        return await Task.detached {
            let clock = ContinuousClock()
            var plan: ChatRowPlan?
            let took = clock.measure { plan = ChatPlanner.plan(item, key: key, copied: false, opened: opened, syntax: CodeSyntaxService()) }
            return (plan!, took)
        }.value
    }

    private func texts(_ view: UIView) -> [ChatTextView] {
        (view as? ChatTextView).map { [$0] } ?? view.subviews.flatMap(texts)
    }

    func testAnOrdinaryLongMessageShowsWhole() async {
        let text = (1...40).map { "Line \($0) of a long message" }.joined(separator: "\n")
        let (plan, _) = await plan(text, opened: false)
        XCTAssertNil(plan.toggles, "a 40-line message folded")
        XCTAssertGreaterThan(plan.size.height, 40 * 24)
    }

    func testABlobFoldsAndCostsTheMainThreadNothing() async throws {
        let (closed, closedTook) = await plan(blob, opened: false)
        let (open, openTook) = await plan(blob, opened: true)
        XCTAssertEqual(closed.toggles, Strings.showFull)
        XCTAssertEqual(open.toggles, Strings.showLess)
        // Folded: 70 lines and the control, whatever the blob's size.
        XCTAssertLessThan(closed.size.height, 70 * 24 + 100)
        XCTAssertGreaterThan(open.size.height, 20_000)

        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.isHidden = false
        defer { window.isHidden = true }
        var worst: [String: Duration] = [:]
        for (name, plan) in [("closed", closed), ("open", open)] {
            let view = ChatPlanView(frame: CGRect(origin: .zero, size: plan.size))
            view.cutsTallPlans = true
            view.drawsTextOffMain = true
            view.band = CGRect(x: 0, y: 0, width: 390, height: 844)
            let took = ContinuousClock().measure {
                window.addSubview(view)
                view.apply(plan)
                view.layoutIfNeeded()
                // What Core Animation does on the main thread for it: its
                // tiles draw on their own threads.
                CATransaction.flush()
                window.layer.displayIfNeeded()
            }
            worst[name] = took
            let tall = texts(view).filter { $0.bounds.height > ChatTextTiling.threshold }
            XCTAssertFalse(tall.isEmpty, "\(name): no tall text")
            for text in tall {
                XCTAssertTrue(text is ChatTiledTextView, "\(name): a \(text.bounds.height)pt text is one bitmap")
                // Its contents are the tiled layer's tile provider, never a
                // whole image the height of the text.
                let tiled = try XCTUnwrap(text.layer as? CATiledLayer, "\(name): not a tiled layer")
                XCTAssertEqual(tiled.tileSize.height, ChatTextTiling.tile * max(1, text.traitCollection.displayScale), "\(name): tiles")
                if let contents = text.layer.contents {
                    XCTAssertNotEqual(CFGetTypeID(contents as CFTypeRef), CGImage.typeID, "\(name): a tall text drew a whole bitmap")
                }
            }
            view.removeFromSuperview()
        }
        print("LudicrousMessageTests: planned off main \(closedTook) closed, \(openTook) open; main thread \(worst["closed"]!) closed, \(worst["open"]!) open")
        // Half a 60 Hz frame for either, measured and drawn.
        XCTAssertLessThan(worst["closed"]!, .milliseconds(TestTime.budget(8)))
        XCTAssertLessThan(worst["open"]!, .milliseconds(TestTime.budget(8)))
    }
}
#endif
