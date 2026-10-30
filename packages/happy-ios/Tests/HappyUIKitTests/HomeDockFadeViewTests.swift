#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Part-way through its fade the resting dock's parts carry the presence
/// themselves: no blur sits under a view below full alpha, which would turn
/// it off (HomeDock.tsx:166).
@MainActor
final class HomeDockFadeViewTests: XCTestCase {
    private func effectViews(in view: UIView) -> [UIVisualEffectView] {
        view.subviews.flatMap { child -> [UIVisualEffectView] in
            ((child as? UIVisualEffectView).map { [$0] } ?? []) + effectViews(in: child)
        }
    }

    func testPartWayThePartsFadeAndNoBlurIsUnderAFadedView() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.isHidden = false
        defer { window.isHidden = true }
        let dock = HomeDockView(frame: window.bounds)
        dock.showsScrim = true
        window.addSubview(dock)
        dock.layoutIfNeeded()

        dock.fadeIn(HomeDockFade(surfaceFrom: 0.6, contentFrom: 0.4, duration: 60))
        XCTAssertEqual(dock.presence, 0.6)
        XCTAssertEqual(dock.contentPresence, 0.4)
        XCTAssertEqual(dock.alpha, 1)
        XCTAssertEqual(dock.sendButton.alpha, 0.4, accuracy: 1e-6)
        let blurs = effectViews(in: dock).compactMap { $0 as? PartialBlurView }
        // The foot's scrim is a fade with no blur (HeaderScrimView `.bottom`).
        XCTAssertEqual(blurs.count, 1, "the capsule's material")
        for blur in blurs {
            var view: UIView? = blur
            while let current = view, current !== window {
                XCTAssertEqual(current.alpha, 1, "\(type(of: current)) over a blur")
                view = current.superview
            }
        }
        // The capsule's material takes the surface's, the scrim the
        // content's.
        XCTAssertEqual(blurs.map(\.presence), [0.6])
        XCTAssertEqual(dock.scrim.presence, 0.4)
        XCTAssertEqual(dock.scrim.alpha, 1)

        dock.finishFade()
        XCTAssertEqual(dock.presence, 1)
        XCTAssertEqual(dock.contentPresence, 1)
        XCTAssertEqual(dock.sendButton.alpha, 1)
        XCTAssertEqual(dock.scrim.presence, 1)
        for blur in blurs { XCTAssertEqual(blur.presence, 1) }
    }

    func testNoFadeShowsTheDockInFull() {
        let dock = HomeDockView(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        dock.fadeIn(HomeDockFade(surfaceFrom: 0, contentFrom: 0, duration: 60))
        XCTAssertEqual(dock.presence, 0)
        dock.fadeIn(nil)
        XCTAssertEqual(dock.presence, 1)
        XCTAssertEqual(dock.contentPresence, 1)
    }

    func testLeavingTheWindowMidFadeEndsItInFull() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.isHidden = false
        defer { window.isHidden = true }
        let dock = HomeDockView(frame: window.bounds)
        window.addSubview(dock)
        dock.fadeIn(HomeDockFade(surfaceFrom: 0, contentFrom: 0, duration: 60))
        dock.removeFromSuperview()
        XCTAssertEqual(dock.presence, 1)
        XCTAssertEqual(dock.contentPresence, 1)
    }

    func testThePressStillDimsTheSendButtonUnderTheFade() {
        let button = HomeDockSendButton()
        button.presence = 0.5
        button.pressedAlphaChanged(true)
        XCTAssertEqual(button.alpha, 0.35, accuracy: 1e-6)
        button.pressedAlphaChanged(false)
        XCTAssertEqual(button.alpha, 0.5, accuracy: 1e-6)
    }
}
#endif
