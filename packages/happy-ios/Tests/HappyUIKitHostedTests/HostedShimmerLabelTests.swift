#if canImport(UIKit)
@testable import HappyUI
import UIKit
import XCTest

@MainActor
final class HostedShimmerLabelTests: XCTestCase {
    func testPlainTitleSkipsBandLayoutAndShimmerCanStillStartLater() async throws {
        let scene = try await hostedActiveScene()
        let previous = scene.keyWindow
        let controller = UIViewController()
        let window = hostedKeyWindow(in: scene, root: controller)
        addTeardownBlock { @MainActor in window.isHidden = true; previous?.makeKey() }
        let label = ShimmerLabel(frame: CGRect(x: 0, y: 100, width: 300, height: 48))
        controller.view.addSubview(label)
        let text = NSAttributedString(string: "A title", attributes: [.font: UIFont.systemFont(ofSize: 17)])
        label.attributedText = text
        label.layoutIfNeeded()
        let children = label.subviews.compactMap { $0 as? UILabel }
        let band = try XCTUnwrap(children.compactMap { $0.layer.mask }.first)
        XCTAssertEqual(band.bounds, .zero, "a plain title must not measure an unused shimmer band")
        XCTAssertTrue(children.allSatisfy { $0.attributedText?.string == "A title" })
        XCTAssertNil(label.sweepBegan)

        label.shimmering = true
        label.layoutIfNeeded()
        XCTAssertGreaterThan(band.bounds.width, 0)
        XCTAssertNotNil(label.sweepBegan)
        let began = label.sweepBegan
        label.attributedText = text
        label.layoutIfNeeded()
        XCTAssertEqual(label.sweepBegan, began, "an equal title must not restart the shimmer")

        label.shimmering = false
        XCTAssertNil(label.sweepBegan)
        label.attributedText = nil
        label.layoutIfNeeded()
        XCTAssertTrue(children.allSatisfy { $0.attributedText == nil }, "clearing a title must clear both labels")
    }
}
#endif