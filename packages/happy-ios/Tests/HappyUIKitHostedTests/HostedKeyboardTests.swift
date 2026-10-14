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
/// (ScreensLanguageTests' own first-responder case skips there). Hosted in
/// HappyUIKitTestHost, so these fail rather than skip without a scene.
@MainActor
final class HostedKeyboardTests: XCTestCase {
    private var window: UIWindow?
    private var hostWindow: UIWindow?
    private var field: UITextField?
    private var observers: [NSObjectProtocol] = []

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    override func tearDown() {
        // XCTest tears down on the main thread.
        MainActor.assumeIsolated {
            field?.resignFirstResponder()
            window?.isHidden = true
            hostWindow?.makeKey()
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
            observers = []
            field = nil
            window = nil
            hostWindow = nil
        }
        AppLocalization.use(nil)
        super.tearDown()
    }

    /// A window of the scene, made key over the host's, with a field that
    /// has the keyboard.
    private func editingWindow(in scene: UIWindowScene) -> (UIWindow, UITextField) {
        hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene)
        let field = UITextField(frame: CGRect(x: 20, y: 120, width: 280, height: 44))
        window.rootViewController?.view.addSubview(field)
        self.window = window
        self.field = field
        XCTAssertTrue(window.isKeyWindow)
        XCTAssertTrue(field.becomeFirstResponder())
        XCTAssertTrue(field.isFirstResponder)
        return (window, field)
    }

    private func observeKeyboard() -> KeyboardNotes {
        let notes = KeyboardNotes()
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: nil) { _ in
            notes.shown += 1
        })
        observers.append(center.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: nil) { _ in
            notes.hidden += 1
        })
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

        if notes.shown > 0 {
            let hidden = ContinuousClock.now + .seconds(2)
            while notes.hidden == 0, ContinuousClock.now < hidden {
                try await Task.sleep(for: .milliseconds(50))
            }
            XCTAssertGreaterThan(notes.hidden, 0, "the software keyboard was shown and never hidden")
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
}
#endif
