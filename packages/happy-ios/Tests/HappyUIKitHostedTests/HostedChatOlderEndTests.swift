#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// ChatList's OlderEnd pressed through UIKit's own action dispatch, which
/// needs a running application: RoundButton registers a target and
/// selector, so the unhosted bundle can only check its wiring
/// (ChatOlderEndViewTests).
@MainActor
final class HostedChatOlderEndTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    /// Retry, after an older page failed, in a window of the host's scene:
    /// a touch-up inside reaches the screen once, and a touch that ends
    /// outside or only goes down doesn't.
    func testRetryReachesTheScreenOnce() async throws {
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene)
        // Undone on the main actor once the test returns, with only the
        // windows: `tearDown` is nonisolated and must not take the test
        // case onto the main actor.
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
        }
        let view = ChatOlderEndView(frame: CGRect(x: 0, y: 100, width: window.bounds.width, height: ChatOlderEndLayout.height))
        view.status = .error
        window.rootViewController?.view.addSubview(view)
        view.layoutIfNeeded()
        var pressed = 0
        view.onAction = { pressed += 1 }
        let button = try XCTUnwrap(view.subviews.compactMap { $0 as? RoundButton }.first)
        XCTAssertFalse(button.isHidden)
        XCTAssertEqual(button.title, Strings.Chat.retry)
        XCTAssertTrue(button.window === window)

        button.sendActions(for: .touchUpInside)
        XCTAssertEqual(pressed, 1)
        button.sendActions(for: .touchDown)
        button.sendActions(for: .touchUpOutside)
        XCTAssertEqual(pressed, 1)
    }
}
#endif
