#if canImport(UIKit)
import UIKit

// INVESTIGATION ONLY, never merged: what makes HostedKeyboardTests' field
// first responder again after the screens' language hold has let go
// (:111 on the Mac). Records, without changing what happens.

/// What the field and its window did, in order, from the window's making.
@MainActor
final class ProbeTimeline {
    /// The one for the window made last (`recordingKeyWindow`).
    static var current = ProbeTimeline()

    private let start = ContinuousClock.now
    private(set) var events: [String] = []

    func note(_ event: String, stack: [String]? = nil) {
        let elapsed = ContinuousClock.now - start
        var entry = "[+\(elapsed.components.seconds)s \(elapsed.components.attoseconds / 1_000_000_000_000_000)ms] \(event)"
        if let stack { entry += "\n" + stack.map { "    \($0)" }.joined(separator: "\n") }
        events.append(entry)
    }

    func report(_ title: String) -> String {
        "HostedKeyboardProbe \(title): \(events.count) events\n" + events.joined(separator: "\n") + "\nHostedKeyboardProbe end"
    }
}

/// A field that notes every becomeFirstResponder and resignFirstResponder,
/// with the call stack, whether its window is key, whether that window
/// takes touches (false while held) and what UIKit answered.
@MainActor
final class RecordingField: UITextField {
    @discardableResult
    override func becomeFirstResponder() -> Bool {
        let stack = Thread.callStackSymbols
        let before = recordedState
        let result = super.becomeFirstResponder()
        ProbeTimeline.current.note("field \(address) becomeFirstResponder -> \(result); before: \(before); after: \(recordedState)", stack: stack)
        return result
    }

    @discardableResult
    override func resignFirstResponder() -> Bool {
        let stack = Thread.callStackSymbols
        let before = recordedState
        let result = super.resignFirstResponder()
        ProbeTimeline.current.note("field \(address) resignFirstResponder -> \(result); before: \(before); after: \(recordedState)", stack: stack)
        return result
    }

    private var address: String { "\(Unmanaged.passUnretained(self).toOpaque())" }

    private var recordedState: String {
        guard let window else { return "no window, first responder \(isFirstResponder)" }
        let key = window.windowScene?.keyWindow
        return "first responder \(isFirstResponder), window key \(window.isKeyWindow), window takes touches \(window.isUserInteractionEnabled), scene's key window \(key === window ? "this" : key.map { "\(type(of: $0)) \(Unmanaged.passUnretained($0).toOpaque())" } ?? "none")"
    }
}

/// A window that notes when it becomes or stops being key, and every
/// change to whether it takes touches: the hold sets it false, the
/// release puts it back.
@MainActor
final class RecordingWindow: UIWindow {
    var recording = false

    override var isUserInteractionEnabled: Bool {
        didSet {
            guard recording else { return }
            ProbeTimeline.current.note("window \(Unmanaged.passUnretained(self).toOpaque()) takes touches: \(oldValue) -> \(isUserInteractionEnabled)")
        }
    }

    override func becomeKey() {
        super.becomeKey()
        guard recording else { return }
        ProbeTimeline.current.note("window \(Unmanaged.passUnretained(self).toOpaque()) became key", stack: Thread.callStackSymbols)
    }

    override func resignKey() {
        super.resignKey()
        guard recording else { return }
        ProbeTimeline.current.note("window \(Unmanaged.passUnretained(self).toOpaque()) resigned key", stack: Thread.callStackSymbols)
    }
}

/// `hostedKeyWindow(in:)` with a recording window and a fresh timeline.
@MainActor
func recordingKeyWindow(in scene: UIWindowScene, root: UIViewController = UIViewController()) -> RecordingWindow {
    ProbeTimeline.current = ProbeTimeline()
    let window = RecordingWindow(windowScene: scene)
    window.rootViewController = root
    window.recording = true
    window.makeKeyAndVisible()
    return window
}
#endif
