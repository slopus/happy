#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The suggestion list's LocalBlurHalo reaches past the list and takes no
/// touches.
@MainActor
final class ComposerSuggestionHaloTests: XCTestCase {
    func testTouchesBesideTheListPassThroughTheHalo() {
        let list = ComposerSuggestionListView()
        list.set([
            ComposerSuggestion(key: "a", text: "/clear", kind: .command(name: "clear", description: nil)),
            ComposerSuggestion(key: "b", text: "/compact", kind: .command(name: "compact", description: nil)),
        ], selected: 0)
        list.frame = CGRect(x: 0, y: 0, width: 361, height: 97)
        list.layoutIfNeeded()

        // 20 above the list is inside the halo, which is not hit.
        XCTAssertNil(list.hitTest(CGPoint(x: 100, y: -20), with: nil))
        XCTAssertFalse(list.point(inside: CGPoint(x: 100, y: -20), with: nil))
        // A row is.
        XCTAssertTrue(list.hitTest(CGPoint(x: 100, y: 24), with: nil) is ComposerSuggestionRowView)
    }
}
#endif
