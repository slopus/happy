#if canImport(UIKit)
@testable import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// Opens once; whoever waits before then waits for it.
private actor Latch {
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        opened = true
        for waiter in waiters { waiter.resume() }
        waiters.removeAll()
    }
}

private enum Unanswered: Error { case settings }

/// A new root's language is decided off the main thread while the window
/// takes no touches, and the root replacing the screens on it is in before
/// it takes them again.
@MainActor
final class ScreensLanguageTests: XCTestCase {
    private let middle = CGPoint(x: 160, y: 100)
    private let bottom = CGPoint(x: 160, y: 440)

    override func tearDown() {
        AppLocalization.use(nil)
        super.tearDown()
    }

    /// A window's stand-in with a root that fills its top, and something
    /// presented over the root at its bottom, outside the root's view.
    private func window() -> (window: UIView, root: UIButton, presented: UIButton) {
        let window = UIView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        let root = UIButton(frame: CGRect(x: 0, y: 0, width: 320, height: 400))
        let presented = UIButton(frame: CGRect(x: 0, y: 400, width: 320, height: 80))
        window.addSubview(root)
        window.addSubview(presented)
        return (window, root, presented)
    }

    private func replaceRoot(of window: UIView, _ old: UIView) -> UIButton {
        old.removeFromSuperview()
        let root = UIButton(frame: CGRect(x: 0, y: 0, width: 320, height: 400))
        window.insertSubview(root, at: 0)
        return root
    }

    func testNothingOnTheWindowTakesATouchUntilTheNewRootIsIn() async {
        let (window, old, presented) = window()
        XCTAssertTrue(window.hitTest(middle, with: nil) === old)
        XCTAssertTrue(window.hitTest(bottom, with: nil) === presented)
        let language = ScreensLanguage(holding: window)
        let decided = Latch()
        var heldWhileInstalling: Bool?
        var new: UIButton?
        language.request(resolve: {
            await decided.wait()
            return "en"
        }, install: {
            heldWhileInstalling = !window.isUserInteractionEnabled
            new = self.replaceRoot(of: window, old)
        })
        XCTAssertTrue(language.isDeciding)
        XCTAssertNil(window.hitTest(middle, with: nil), "the account being left")
        XCTAssertNil(window.hitTest(bottom, with: nil), "what is presented over it")
        await decided.open()
        await language.gate.waitForIdle()
        XCTAssertEqual(heldWhileInstalling, true)
        XCTAssertFalse(language.isDeciding)
        XCTAssertNotNil(new)
        XCTAssertTrue(window.hitTest(middle, with: nil) === new)
        XCTAssertTrue(window.hitTest(bottom, with: nil) === presented)
    }

    /// Japanese, then English, then Japanese again, asked for before the
    /// first is decided: the hold never lets go between them, and only the
    /// last root is installed, in its language.
    func testANewerRootReplacesAPendingOneWithoutLettingGo() async {
        let (window, _, _) = window()
        let language = ScreensLanguage(holding: window)
        var installed: [String] = []
        for code in ["ja", "en", "ja"] {
            language.request(resolve: { code }, install: {
                installed.append("\(code) as \(AppLocalization.language)")
            })
            XCTAssertFalse(window.isUserInteractionEnabled)
        }
        await language.gate.waitForIdle()
        XCTAssertEqual(installed, ["ja as ja"])
        XCTAssertTrue(window.isUserInteractionEnabled)

        // Back to English: the screens' own words, nothing to decode.
        language.request(resolve: { "en" }, install: { installed.append("en as \(AppLocalization.language)") })
        await language.gate.waitForIdle()
        XCTAssertEqual(installed, ["ja as ja", "en as en"])
        XCTAssertNil(AppLocalization.screens)
    }

    /// Another account in the language already spoken still gets its root.
    func testTheSameLanguageStillInstallsTheRoot() async {
        let (window, _, _) = window()
        let language = ScreensLanguage(holding: window)
        AppLocalization.use(await TranslationCatalog.load("ja"))
        let before = AppLocalization.screens
        var installs = 0
        language.request(resolve: { "ja" }, install: { installs += 1 })
        await language.gate.waitForIdle()
        XCTAssertEqual(installs, 1)
        XCTAssertTrue(AppLocalization.screens === before)
        XCTAssertTrue(window.isUserInteractionEnabled)
    }

    /// Undecided, the root is still installed, in the language spoken.
    func testAFailedDecisionInstallsTheRootInTheLanguageInUse() async {
        let (window, _, _) = window()
        let language = ScreensLanguage(holding: window)
        AppLocalization.use(await TranslationCatalog.load("ja"))
        var installedIn: String?
        var heldWhileInstalling: Bool?
        language.request(resolve: { throw Unanswered.settings }, install: {
            installedIn = AppLocalization.language
            heldWhileInstalling = !window.isUserInteractionEnabled
        })
        await language.gate.waitForIdle()
        XCTAssertEqual(installedIn, "ja")
        XCTAssertEqual(heldWhileInstalling, true)
        XCTAssertTrue(window.isUserInteractionEnabled)
    }

    /// Letting go gives back what the window allowed before, not more.
    func testTheHoldGivesBackWhatTheWindowAllowed() async {
        let (window, _, _) = window()
        window.isUserInteractionEnabled = false
        let language = ScreensLanguage(holding: window)
        var installs = 0
        language.request(resolve: { "en" }, install: { installs += 1 })
        await language.gate.waitForIdle()
        XCTAssertEqual(installs, 1)
        XCTAssertFalse(window.isUserInteractionEnabled)
    }
}
#endif
