#if canImport(UIKit)
@testable import HappyUI
import UIKit
import XCTest

/// When text drawn off the main thread is drawn at once instead: only when
/// it shows with nothing drawn.
@MainActor
final class ChatOffMainTextViewTests: XCTestCase {
    private func text(in row: UIView) -> ChatOffMainTextView {
        let view = ChatOffMainTextView(frame: CGRect(x: 16, y: 8, width: 300, height: 40))
        view.layout = ChatTextLayout(NSAttributedString(string: "Words on screen", attributes: [.font: UIFont.systemFont(ofSize: 17)]), width: 300)
        row.addSubview(view)
        return view
    }

    /// On screen with nothing drawn: drawn now, so nothing shows blank.
    func testShownTextOnScreenIsDrawnAtOnce() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.isHidden = false
        defer { window.isHidden = true }
        let row = UIView(frame: CGRect(x: 0, y: 0, width: 390, height: 60))
        window.addSubview(row)
        let view = text(in: row)
        view.layer.displayIfNeeded()
        XCTAssertNotNil(view.layer.contents)
    }

    /// A row built ahead of a scroll waits hidden, though it sits on screen:
    /// its words are drawn off the main thread, as off screen.
    func testTextInAHiddenRowOnScreenIsDrawnOffTheMainThread() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.isHidden = false
        defer { window.isHidden = true }
        let row = UIView(frame: CGRect(x: 0, y: 0, width: 390, height: 60))
        row.isHidden = true
        window.addSubview(row)
        let view = text(in: row)
        view.layer.displayIfNeeded()
        XCTAssertNil(view.layer.contents, "the hidden row's words were drawn on the main thread")
        for _ in 0..<200 where view.layer.contents == nil {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertNotNil(view.layer.contents, "the words were never drawn")
    }
}
#endif
