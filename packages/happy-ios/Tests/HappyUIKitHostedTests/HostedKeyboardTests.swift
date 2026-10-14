#if canImport(UIKit)
@testable import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// The keyboard notifications seen, counted where they are posted.
private final class KeyboardNotes: @unchecked Sendable {
    var shown = 0
    var hidden = 0
}

/// The keyboard observers a test added, removed when it ends.
@MainActor
private final class KeyboardObservers {
    var tokens: [any NSObjectProtocol] = []
}

/// A field's delegate that does something the moment it stops editing.
@MainActor
private final class EndsEditing: NSObject, UITextFieldDelegate {
    var didEnd: (@MainActor () -> Void)?

    func textFieldDidEndEditing(_ textField: UITextField) {
        didEnd?()
    }
}

/// The screens' language hold on a real window in the host's scene, over a
/// field that has the keyboard: what the unhosted bundle can't give a view
/// (ScreensLanguageTests' own first-responder case uses a stub responder in
/// a window with no scene). Hosted in HappyUIKitTestHost, so these fail
/// rather than skip without a scene.
@MainActor
final class HostedKeyboardTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    override func tearDown() {
        AppLocalization.use(nil)
        super.tearDown()
    }

    /// A window of the scene, made key over the host's, with a field that
    /// has the keyboard.
    private func editingWindow(in scene: UIWindowScene) -> (UIWindow, UITextField) {
        let hostWindow = scene.keyWindow
        let window = recordingKeyWindow(in: scene)
        let field = RecordingField(frame: CGRect(x: 20, y: 120, width: 280, height: 44))
        window.rootViewController?.view.addSubview(field)
        // Undone on the main actor once the test returns, with only what it
        // made: `tearDown` is nonisolated and must not take the test case
        // onto the main actor.
        addTeardownBlock { @MainActor in
            field.resignFirstResponder()
            window.isHidden = true
            hostWindow?.makeKey()
        }
        XCTAssertTrue(window.isKeyWindow)
        XCTAssertTrue(field.becomeFirstResponder())
        XCTAssertTrue(field.isFirstResponder)
        return (window, field)
    }

    private func observeKeyboard() -> KeyboardNotes {
        let notes = KeyboardNotes()
        let center = NotificationCenter.default
        let observers = KeyboardObservers()
        observers.tokens.append(center.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: nil) { _ in
            notes.shown += 1
        })
        observers.tokens.append(center.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: nil) { _ in
            notes.hidden += 1
        })
        addTeardownBlock { @MainActor in
            for token in observers.tokens { NotificationCenter.default.removeObserver(token) }
        }
        return notes
    }

    /// The field on the screens being left loses the keyboard as the hold
    /// begins, with the window already taking no touches; the root is
    /// installed while held, and the window takes touches again after.
    func testTheHoldTakesTheKeyboardFromTheScreensBeingLeft() async throws {
        let scene = try await hostedActiveScene()
        let notes = observeKeyboard()
        let (window, field) = editingWindow(in: scene)
        // A software keyboard, where this simulator shows one, has a moment
        // to come up; with a hardware keyboard none does.
        let shown = ContinuousClock.now + .seconds(1)
        while notes.shown == 0, ContinuousClock.now < shown {
            try await Task.sleep(for: .milliseconds(50))
        }
        let language = ScreensLanguage(holding: window)
        var installed: [String] = []
        // Counted from here: a hide still on its way from an earlier test's
        // field is not this hold's.
        let hiddenBefore = notes.hidden
        language.request(for: nil, resolve: { "en" }, install: {
            installed.append("\(window.isUserInteractionEnabled ? "touchable" : "held"), \(field.isFirstResponder ? "editing" : "not editing")")
        })
        XCTAssertFalse(field.isFirstResponder)
        XCTAssertFalse(window.isUserInteractionEnabled)
        XCTAssertTrue(language.isDeciding)
        await language.gate.waitForIdle()
        XCTAssertEqual(installed, ["held, not editing"])
        XCTAssertFalse(language.isDeciding)
        XCTAssertTrue(window.isUserInteractionEnabled)
        XCTAssertFalse(field.isFirstResponder)
        if field.isFirstResponder { print(ProbeTimeline.current.report(":111 failed, the field is first responder after the release")) }

        if notes.shown > 0 {
            let hidden = ContinuousClock.now + .seconds(2)
            while notes.hidden == hiddenBefore, ContinuousClock.now < hidden {
                try await Task.sleep(for: .milliseconds(50))
            }
            XCTAssertGreaterThan(notes.hidden, hiddenBefore, "the software keyboard was shown and never hidden")
            print("HostedKeyboardTests: software keyboard shown, then hidden by the hold")
        } else {
            print("HostedKeyboardTests: no software keyboard shown (hardware keyboard); first responder checked only")
        }
    }

    /// The field's delegate cancels the hold the moment the field stops
    /// editing, inside the hold's own ending of editing: the root is
    /// installed at once in the language in use, still held, and then the
    /// window takes touches again; nothing written after holds it again.
    func testAFieldThatCancelsAsItStopsEditingStillGetsTheRootFirst() async throws {
        let scene = try await hostedActiveScene()
        let (window, field) = editingWindow(in: scene)
        let language = ScreensLanguage(holding: window)
        let delegate = EndsEditing()
        var events: [String] = []
        delegate.didEnd = {
            events.append("ended editing")
            language.gate.cancel()
        }
        field.delegate = delegate
        language.request(for: nil, resolve: { "ja" }, install: {
            events.append("installed \(window.isUserInteractionEnabled ? "touchable" : "held") in \(AppLocalization.language)")
        })
        field.delegate = nil
        XCTAssertEqual(events, ["ended editing", "installed held in en"])
        XCTAssertFalse(field.isFirstResponder)
        XCTAssertFalse(language.isDeciding)
        XCTAssertFalse(language.gate.isPending)
        XCTAssertTrue(window.isUserInteractionEnabled)
        await language.gate.waitForIdle()
        XCTAssertEqual(events, ["ended editing", "installed held in en"])
        XCTAssertTrue(window.isUserInteractionEnabled)
        withExtendedLifetime(delegate) {}
    }

    /// INVESTIGATION ONLY (HostedKeyboardProbe): the install replaces the
    /// screen the field is on, as AppCoordinator.install does, with the
    /// navigation's `setViewControllers([root], animated: false)`. Once
    /// the hold has let go and the run loop has turned, the field is off
    /// the window, nothing has it editing, and the keyboard did not come
    /// back.
    func testProbeAnInstallThatReplacesTheFieldsScreenKeepsTheKeyboardAway() async throws {
        let scene = try await hostedActiveScene()
        let notes = observeKeyboard()
        let hostWindow = scene.keyWindow
        let screen = UIViewController()
        let navigation = UINavigationController(rootViewController: screen)
        let window = recordingKeyWindow(in: scene, root: navigation)
        window.layoutIfNeeded()
        let field = RecordingField(frame: CGRect(x: 20, y: 120, width: 280, height: 44))
        screen.view.addSubview(field)
        addTeardownBlock { @MainActor in
            field.resignFirstResponder()
            window.isHidden = true
            hostWindow?.makeKey()
        }
        XCTAssertTrue(window.isKeyWindow)
        XCTAssertTrue(field.becomeFirstResponder())
        XCTAssertTrue(field.isFirstResponder)
        let shown = ContinuousClock.now + .seconds(1)
        while notes.shown == 0, ContinuousClock.now < shown {
            try await Task.sleep(for: .milliseconds(50))
        }
        let language = ScreensLanguage(holding: window)
        let root = UIViewController()
        let shownBefore = notes.shown
        let hiddenBefore = notes.hidden
        var installed: [String] = []
        language.request(for: nil, resolve: { "en" }, install: {
            navigation.setViewControllers([root], animated: false)
            installed.append("\(window.isUserInteractionEnabled ? "touchable" : "held"), \(field.isFirstResponder ? "editing" : "not editing")")
        })
        XCTAssertFalse(field.isFirstResponder)
        XCTAssertFalse(window.isUserInteractionEnabled)
        await language.gate.waitForIdle()
        XCTAssertEqual(installed, ["held, not editing"])
        XCTAssertTrue(window.isUserInteractionEnabled)
        XCTAssertEqual(navigation.viewControllers, [root])

        // Whatever UIKit does after the replacement, the run loop let go.
        try await Task.sleep(for: .milliseconds(500))
        if shownBefore > 0 {
            let hidden = ContinuousClock.now + .seconds(2)
            while notes.hidden == hiddenBefore, ContinuousClock.now < hidden {
                try await Task.sleep(for: .milliseconds(50))
            }
            XCTAssertGreaterThan(notes.hidden, hiddenBefore, "the software keyboard was shown and never hidden")
        }
        XCTAssertNil(field.window, "the install took the field's screen off the window")
        XCTAssertFalse(field.isFirstResponder, "the field has the keyboard again")
        XCTAssertEqual(notes.shown, shownBefore, "the keyboard came back after the hold")
        print(ProbeTimeline.current.report("replaced screen, software keyboard shown before the hold: \(shownBefore > 0)"))
    }
}
#endif
