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

/// A window that notes each time it is asked to end editing, and whether
/// it took touches then, and can call back from there as a text field's
/// delegate can.
private final class EditingWindow: UIWindow {
    var ends: [String] = []
    var whileEnding: (@MainActor () -> Void)?

    override func endEditing(_ force: Bool) -> Bool {
        ends.append("\(force ? "forced" : "asked"), \(isUserInteractionEnabled ? "touchable" : "held")")
        whileEnding?()
        return super.endEditing(force)
    }
}

/// Something on the screens being left that has the keyboard.
private final class Focusable: UIView {
    override var canBecomeFirstResponder: Bool { true }
}

/// A new root's language is decided off the main thread while the window
/// takes no touches, and the root replacing the screens on it is in before
/// it takes them again. The Language page's choice reaches only the screens
/// of the account it was made in.
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
        language.request(for: nil, resolve: {
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
            language.request(for: nil, resolve: { code }, install: {
                installed.append("\(code) as \(AppLocalization.language)")
            })
            XCTAssertFalse(window.isUserInteractionEnabled)
        }
        await language.gate.waitForIdle()
        XCTAssertEqual(installed, ["ja as ja"])
        XCTAssertTrue(window.isUserInteractionEnabled)

        // Back to English: the screens' own words, nothing to decode.
        language.request(for: nil, resolve: { "en" }, install: { installed.append("en as \(AppLocalization.language)") })
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
        language.request(for: nil, resolve: { "ja" }, install: { installs += 1 })
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
        language.request(for: nil, resolve: { throw Unanswered.settings }, install: {
            installedIn = AppLocalization.language
            heldWhileInstalling = !window.isUserInteractionEnabled
        })
        await language.gate.waitForIdle()
        XCTAssertEqual(installedIn, "ja")
        XCTAssertEqual(heldWhileInstalling, true)
        XCTAssertTrue(window.isUserInteractionEnabled)
    }

    /// Once the window takes no touches, whatever has the keyboard on it
    /// loses it, so typing can't reach the screens being left; a newer root
    /// keeps the hold and has nothing more to end.
    func testTheHoldEndsEditingOnceTheWindowTakesNoTouches() async {
        let window = EditingWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        let language = ScreensLanguage(holding: window)
        let decided = Latch()
        language.request(for: nil, resolve: {
            await decided.wait()
            return "en"
        }, install: {})
        XCTAssertEqual(window.ends, ["forced, held"])
        language.request(for: nil, resolve: { "en" }, install: {})
        XCTAssertEqual(window.ends, ["forced, held"])
        await language.gate.waitForIdle()
        await decided.open()
        XCTAssertTrue(window.isUserInteractionEnabled)
        XCTAssertEqual(window.ends, ["forced, held"])
    }

    func testTheFocusedViewOnTheScreensBeingLeftLosesTheKeyboard() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        window.isHidden = false
        defer { window.isHidden = true }
        let focused = Focusable(frame: CGRect(x: 0, y: 0, width: 320, height: 44))
        window.addSubview(focused)
        try XCTSkipUnless(focused.becomeFirstResponder(), "no first responder in this window without an application")
        let language = ScreensLanguage(holding: window)
        language.request(for: nil, resolve: { "en" }, install: {})
        XCTAssertFalse(focused.isFirstResponder)
        await language.gate.waitForIdle()
        XCTAssertTrue(window.isUserInteractionEnabled)
    }

    /// Ending editing can call back. Cancelled there, the root is installed
    /// at once in the language in use, still held, and the window takes
    /// touches again as it did before: nothing written after ending editing
    /// holds it again.
    func testCancelledWhileEndingEditingTheRootIsInBeforeLettingGo() async {
        let window = EditingWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        let language = ScreensLanguage(holding: window)
        var installed: [String] = []
        window.whileEnding = { language.gate.cancel() }
        language.request(for: nil, resolve: { "ja" }, install: {
            installed.append("\(window.isUserInteractionEnabled ? "touchable" : "held") in \(AppLocalization.language)")
        })
        window.whileEnding = nil
        XCTAssertEqual(installed, ["held in en"])
        XCTAssertFalse(language.isDeciding)
        XCTAssertFalse(language.gate.isPending)
        XCTAssertTrue(window.isUserInteractionEnabled)
        await language.gate.waitForIdle()
        XCTAssertEqual(installed, ["held in en"])
        XCTAssertTrue(window.isUserInteractionEnabled)
    }

    /// Asked for while ending editing, a newer root replaces the one that
    /// took the hold, which is kept until the newer one is in.
    func testANewerRootAskedForWhileEndingEditingKeepsTheHold() async {
        let window = EditingWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        let language = ScreensLanguage(holding: window)
        var installed: [String] = []
        window.whileEnding = {
            window.whileEnding = nil
            language.request(for: nil, resolve: { "en" }, install: {
                installed.append("newer, \(window.isUserInteractionEnabled ? "touchable" : "held")")
            })
        }
        language.request(for: nil, resolve: { "en" }, install: { installed.append("first") })
        XCTAssertTrue(language.isDeciding)
        XCTAssertFalse(window.isUserInteractionEnabled)
        await language.gate.waitForIdle()
        XCTAssertEqual(installed, ["newer, held"])
        XCTAssertEqual(window.ends, ["forced, held"])
        XCTAssertTrue(window.isUserInteractionEnabled)
    }

    /// The Language page's choice in the screens' own account: decoded off
    /// the main thread while held, then they are built again in it. Chosen
    /// again, nothing is decoded or built.
    func testAChoiceInTheScreensAccountRebuildsThemInIt() async {
        let (window, _, _) = window()
        let language = ScreensLanguage(holding: window)
        let a = NSObject()
        language.request(for: a, resolve: { "en" }, install: {})
        await language.gate.waitForIdle()
        var rebuilt: [String] = []
        language.choose("ja", in: a) { changed in
            rebuilt.append("\(changed) in \(AppLocalization.language), \(window.isUserInteractionEnabled ? "touchable" : "held")")
        }
        XCTAssertTrue(language.isDeciding)
        XCTAssertFalse(window.isUserInteractionEnabled)
        await language.gate.waitForIdle()
        XCTAssertEqual(rebuilt, ["true in ja, held"])
        let japanese = AppLocalization.screens
        language.choose("ja", in: a) { changed in rebuilt.append("\(changed)") }
        await language.gate.waitForIdle()
        XCTAssertEqual(rebuilt, ["true in ja, held", "false"])
        XCTAssertTrue(AppLocalization.screens === japanese)
        XCTAssertTrue(window.isUserInteractionEnabled)
    }

    /// A choice made in A's screens that arrives once B's root is pending,
    /// or once it is in, changes nothing: not B's root or its language,
    /// and nothing is held for it.
    func testAChoiceFromAnAccountSwitchedAwayFromChangesNothing() async {
        let (window, _, _) = window()
        let language = ScreensLanguage(holding: window)
        let a = NSObject(), b = NSObject()
        language.request(for: a, resolve: { "en" }, install: {})
        await language.gate.waitForIdle()
        var events: [String] = []
        let decided = Latch()
        language.request(for: b, resolve: {
            await decided.wait()
            return "en"
        }, install: { events.append("B in \(AppLocalization.language)") })
        language.choose("ja", in: a) { _ in events.append("A rebuilt") }
        await decided.open()
        await language.gate.waitForIdle()
        XCTAssertEqual(events, ["B in en"])
        XCTAssertTrue(window.isUserInteractionEnabled)

        language.choose("ja", in: a) { _ in events.append("A rebuilt") }
        XCTAssertFalse(language.isDeciding)
        XCTAssertFalse(language.gate.isPending)
        XCTAssertTrue(window.isUserInteractionEnabled)
        await language.gate.waitForIdle()
        XCTAssertEqual(events, ["B in en"])
        XCTAssertNil(AppLocalization.screens)
    }

    /// A's choice not yet applied when B's root is asked for: B's root
    /// replaces it, held throughout, and A's language never reaches it.
    func testARootAskedForReplacesAChoiceNotYetApplied() async {
        let (window, _, _) = window()
        let language = ScreensLanguage(holding: window)
        let a = NSObject(), b = NSObject()
        language.request(for: a, resolve: { "en" }, install: {})
        await language.gate.waitForIdle()
        var events: [String] = []
        language.choose("ja", in: a) { _ in events.append("A rebuilt") }
        XCTAssertTrue(language.isDeciding)
        language.request(for: b, resolve: { "en" }, install: {
            events.append("B in \(AppLocalization.language), \(window.isUserInteractionEnabled ? "touchable" : "held")")
        })
        XCTAssertFalse(window.isUserInteractionEnabled)
        await language.gate.waitForIdle()
        XCTAssertEqual(events, ["B in en, held"])
        XCTAssertNil(AppLocalization.screens)
        XCTAssertTrue(window.isUserInteractionEnabled)
    }

    /// A choice in the account whose own root is still pending decides the
    /// language that root is installed in, not whether it is.
    func testAChoiceWhileTheAccountsRootIsPendingStillInstallsIt() async {
        let (window, _, _) = window()
        let language = ScreensLanguage(holding: window)
        let a = NSObject()
        let decided = Latch()
        var events: [String] = []
        language.request(for: a, resolve: {
            await decided.wait()
            return "en"
        }, install: { events.append("A in \(AppLocalization.language)") })
        language.choose("ja", in: a) { _ in events.append("rebuilt") }
        await language.gate.waitForIdle()
        XCTAssertEqual(events, ["A in ja"])
        XCTAssertTrue(window.isUserInteractionEnabled)
        await decided.open()
    }

    /// Letting go gives back what the window allowed before, not more.
    func testTheHoldGivesBackWhatTheWindowAllowed() async {
        let (window, _, _) = window()
        window.isUserInteractionEnabled = false
        let language = ScreensLanguage(holding: window)
        var installs = 0
        language.request(for: nil, resolve: { "en" }, install: { installs += 1 })
        await language.gate.waitForIdle()
        XCTAssertEqual(installs, 1)
        XCTAssertFalse(window.isUserInteractionEnabled)
    }
}
#endif
