#if canImport(UIKit)
import GRDB
@testable import HappyCore
import HappyStore
@testable import HappyUI
import UIKit
import XCTest

private struct OfflineTransport: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        throw URLError(.notConnectedToInternet)
    }
}

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

private final class Observer: @unchecked Sendable {
    var token: NSObjectProtocol?
}

/// Returns once what was posted for the main queue before it is delivered:
/// the main queue delivers in order.
@MainActor
private func deliveredSoFar() async {
    let name = Notification.Name("ScreensLanguageTestsDelivered")
    let observer = Observer()
    await withCheckedContinuation { (delivered: CheckedContinuation<Void, Never>) in
        observer.token = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
            delivered.resume()
        }
        NotificationCenter.default.post(name: name, object: nil)
    }
    if let token = observer.token { NotificationCenter.default.removeObserver(token) }
}

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

/// A window's stand-in that calls back the next time it is laid out, as a
/// screen coming in or going out can when the window is.
private final class LayingOutView: UIView {
    var whileLayingOut: (@MainActor () -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        let call = whileLayingOut
        whileLayingOut = nil
        call?()
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

    /// Whatever has the keyboard on the window loses it, so typing can't
    /// reach the screens being left, and then the window takes no touches:
    /// ended first, so UIKit has no responder of its own to resign for the
    /// hold and make first responder again as it lets go. A newer root
    /// keeps the hold and has nothing more to end.
    func testTheHoldEndsEditingBeforeTheWindowTakesNoTouches() async {
        let window = EditingWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        let language = ScreensLanguage(holding: window)
        let decided = Latch()
        language.request(for: nil, resolve: {
            await decided.wait()
            return "en"
        }, install: {})
        XCTAssertEqual(window.ends, ["forced, touchable"])
        XCTAssertFalse(window.isUserInteractionEnabled)
        language.request(for: nil, resolve: { "en" }, install: {})
        XCTAssertEqual(window.ends, ["forced, touchable"])
        XCTAssertFalse(window.isUserInteractionEnabled)
        await language.gate.waitForIdle()
        await decided.open()
        XCTAssertTrue(window.isUserInteractionEnabled)
        XCTAssertEqual(window.ends, ["forced, touchable"])
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
    /// at once in the language in use, before the request returns and
    /// before the hold has taken the window's touches (editing is ended
    /// first), and the window takes touches as it did before: nothing
    /// written after ending editing holds it again.
    func testCancelledWhileEndingEditingTheRootIsInBeforeLettingGo() async {
        let window = EditingWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        let language = ScreensLanguage(holding: window)
        var installed: [String] = []
        window.whileEnding = { language.gate.cancel() }
        language.request(for: nil, resolve: { "ja" }, install: {
            installed.append("\(window.isUserInteractionEnabled ? "touchable" : "held") in \(AppLocalization.language)")
        })
        window.whileEnding = nil
        XCTAssertEqual(installed, ["touchable in en"])
        XCTAssertEqual(window.ends, ["forced, touchable"])
        XCTAssertFalse(language.isDeciding)
        XCTAssertFalse(language.gate.isPending)
        XCTAssertTrue(window.isUserInteractionEnabled)
        await language.gate.waitForIdle()
        XCTAssertEqual(installed, ["touchable in en"])
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
        XCTAssertEqual(window.ends, ["forced, touchable"])
        XCTAssertTrue(window.isUserInteractionEnabled)
    }

    /// Letting go lays the window out first, so a root installed without
    /// animating has replaced the screens being left before the window
    /// takes touches again. A newer root asked for from there (a screen
    /// coming in or going out) keeps the hold until it is in.
    func testANewerRootAskedForWhileLettingGoKeepsTheHold() async {
        let window = LayingOutView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        let language = ScreensLanguage(holding: window)
        let firstIn = Latch()
        let decided = Latch()
        var installed: [String] = []
        language.request(for: nil, resolve: { "en" }, install: {
            installed.append("first, \(window.isUserInteractionEnabled ? "touchable" : "held")")
            window.whileLayingOut = {
                language.request(for: nil, resolve: {
                    await decided.wait()
                    return "en"
                }, install: {
                    installed.append("newer, \(window.isUserInteractionEnabled ? "touchable" : "held")")
                })
            }
            window.setNeedsLayout()
            Task { await firstIn.open() }
        })
        await firstIn.wait()
        XCTAssertEqual(installed, ["first, held"])
        XCTAssertNil(window.whileLayingOut, "laid out as the first let go")
        XCTAssertTrue(language.isDeciding)
        XCTAssertTrue(language.gate.isPending)
        XCTAssertFalse(window.isUserInteractionEnabled, "let go with the newer root pending")
        await decided.open()
        await language.gate.waitForIdle()
        XCTAssertEqual(installed, ["first, held", "newer, held"])
        XCTAssertFalse(language.gate.isPending)
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

    private func account() throws -> AccountSession {
        try AccountSession(
            credentials: Credentials(token: "t", secret: Data(repeating: 1, count: 32)),
            store: LocalStore(writer: DatabaseQueue()),
            dependencies: .init(serverURL: URL(string: "https://api.example.test")!, clientID: "ios/test", transport: OfflineTransport())
        )
    }

    /// The Language page's notification, as it posts it, reaches the
    /// window's screens: another account's choice does nothing, the
    /// screens' own account's builds them again in it.
    func testThePagesNotificationReachesOnlyItsOwnAccountsScreens() async throws {
        let (window, _, _) = window()
        let language = ScreensLanguage(holding: window)
        let a = try account(), b = try account()
        var rebuilt: [String] = []
        language.takeChoices { changed in rebuilt.append("\(changed) in \(AppLocalization.language)") }
        language.request(for: a, resolve: { "en" }, install: {})
        await language.gate.waitForIdle()

        // Delivered, B's choice would have started deciding by the time
        // what was posted after it is delivered, and been applied by the
        // time the gate is idle.
        NotificationCenter.default.post(name: .screensLanguageChosen, object: ScreensLanguageChoice(code: "ja", account: b))
        await deliveredSoFar()
        XCTAssertFalse(language.isDeciding)
        await language.gate.waitForIdle()
        XCTAssertEqual(rebuilt, [])
        XCTAssertNil(AppLocalization.screens)

        NotificationCenter.default.post(name: .screensLanguageChosen, object: ScreensLanguageChoice(code: "ja", account: a))
        await deliveredSoFar()
        await language.gate.waitForIdle()
        XCTAssertEqual(rebuilt, ["true in ja"])
        XCTAssertTrue(window.isUserInteractionEnabled)
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
