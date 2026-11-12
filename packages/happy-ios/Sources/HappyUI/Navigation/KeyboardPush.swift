#if canImport(UIKit)
import UIKit

/// A screen `KeyboardPush` pushes. While the keyboard is on its way it
/// builds what it can, nothing moving yet. Told before the push starts, it
/// lays itself out with the keyboard down and takes the keyboard from the
/// stand-in only once the push is over; told the keyboard's notification
/// once it is in its window, it rides the keyboard up from there.
@MainActor
protocol KeyboardPushed: UIViewController {
    func keyboardPushWillWait()
    /// `keyboardUp`: the keyboard was up already, handed to the stand-in.
    func keyboardPushWillStart(keyboardUp: Bool)
    func keyboardPushStarted(_ keyboard: Notification)
}

extension KeyboardPushed {
    func keyboardPushWillWait() {}
}

/// Pushes a screen that opens with the keyboard (new work, a legacy
/// compose chat) so the push and the keyboard start in the same frame and
/// nothing the keyboard costs lands inside the push.
///
/// Asked for during a push (the screen's `viewIsAppearing`), the keyboard
/// was set up on the main thread while the push's first frames were due:
/// UIKit reloads its input views, starts an input session and asks the
/// keyboard's process for its size, about 150 ms on a warm simulator and
/// 400 ms the first time in a process. The push froze for that long and
/// then jumped most of the way in, the keyboard starting after it.
///
/// Here the keyboard is asked for first, by an off-screen stand-in text
/// view on the screen under, while nothing moves. As Telegram's navigation
/// waits for a screen to be ready before it slides it in, the push starts
/// only when the keyboard says it is coming, inside its will-change
/// notification, so the push, the keyboard and the composer riding it all
/// start in one transaction. UIKit keeps the stand-in's keyboard up through
/// the push; the screen's composer takes it over once the push is done,
/// the same keyboard, so nothing on it moves. A keyboard that never comes
/// (a hardware one) lets the push go after `timeout`. A keyboard already up
/// (compose from a chat that was typing) is handed to the stand-in and
/// the push goes at once.
@MainActor
final class KeyboardPush {
    private let screen: UIViewController
    private let navigation: UINavigationController
    private let standIn: StandInTextView
    /// Brings the screen in: a push, or the stack with it in another's place.
    private let show: (UINavigationController) -> Void
    private var observer: NSObjectProtocol?
    private var pushed = false
    private var keyboardUp = false
    /// The stacks with a push waiting for its keyboard.
    private static var waiting: Set<ObjectIdentifier> = []

    /// `traits` are the composer's, which the stand-in copies. `show`
    /// brings the screen in, a push unless said otherwise.
    static func push(_ screen: UIViewController, on navigation: UINavigationController, traits: UITextInputTraits? = nil, keyboardUp: Bool = false,
                     timeout: TimeInterval = 0.5, show: ((UINavigationController) -> Void)? = nil) {
        let show = show ?? { $0.pushViewController(screen, animated: true) }
        // A second tap while the keyboard comes pushes nothing more.
        guard !waiting.contains(ObjectIdentifier(navigation)) else { return }
        guard let host = navigation.view.window else { return show(navigation) }
        waiting.insert(ObjectIdentifier(navigation))
        let run = KeyboardPush(screen: screen, navigation: navigation, standIn: StandInTextView(traits: traits), show: show)
        host.addSubview(run.standIn)
        run.keyboardUp = keyboardUp
        // Heard before the screen's own observers, which its view adds.
        run.observer = NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: nil) { note in
            nonisolated(unsafe) let note = note
            MainActor.assumeIsolated { run.go(note) }
        }
        screen.loadViewIfNeeded()
        (screen as? KeyboardPushed)?.keyboardPushWillWait()
        guard run.standIn.becomeFirstResponder(), !keyboardUp else { return run.go(nil) }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { run.go(nil) }
    }

    private init(screen: UIViewController, navigation: UINavigationController, standIn: StandInTextView, show: @escaping (UINavigationController) -> Void) {
        self.screen = screen
        self.navigation = navigation
        self.standIn = standIn
        self.show = show
    }

    private func go(_ keyboard: Notification?) {
        guard !pushed else { return }
        pushed = true
        Self.waiting.remove(ObjectIdentifier(navigation))
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        let pushed = screen as? KeyboardPushed
        pushed?.keyboardPushWillStart(keyboardUp: keyboardUp)
        show(navigation)
        // The push starts now, in this transaction, with the screen in
        // its window to hear the keyboard.
        navigation.view.layoutIfNeeded()
        if let keyboard { pushed?.keyboardPushStarted(keyboard) }
        // By the push's end the screen has taken the keyboard, or didn't
        // want it, and it goes with the stand-in.
        let standIn = standIn
        let done = {
            DispatchQueue.main.async {
                if standIn.isFirstResponder { standIn.resignFirstResponder() }
                standIn.removeFromSuperview()
            }
        }
        if let coordinator = navigation.transitionCoordinator {
            coordinator.animate(alongsideTransition: nil) { _ in done() }
        } else {
            done()
        }
    }
}

/// Holds the keyboard for the screen on its way: off screen, with the
/// composer's traits, so handing the keyboard over changes nothing on it.
private final class StandInTextView: UITextView {
    init(traits: UITextInputTraits?) {
        super.init(frame: CGRect(x: -10, y: -10, width: 1, height: 1), textContainer: nil)
        isAccessibilityElement = false
        if let traits {
            autocorrectionType = traits.autocorrectionType ?? .default
            autocapitalizationType = traits.autocapitalizationType ?? .sentences
            keyboardType = traits.keyboardType ?? .default
            returnKeyType = traits.returnKeyType ?? .default
            keyboardAppearance = traits.keyboardAppearance ?? .default
            spellCheckingType = traits.spellCheckingType ?? .default
            // A code's or an address's bar over the keys is part of its height.
            if let type = traits.textContentType { textContentType = type }
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
}
#endif
