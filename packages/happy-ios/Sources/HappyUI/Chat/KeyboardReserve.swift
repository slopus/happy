#if canImport(UIKit)
import UIKit

/// The tallest docked keyboard seen over the foot of a screen of each
/// height (an orientation), kept across launches, so a compose chat's panel
/// stands where the keyboard leaves it before the keyboard comes, and the
/// keyboard coming or going moves nothing (`NewWorkLayout.heldBottom`).
///
/// It hears each keyboard as it is about to move, from its end frame,
/// before any frame of its animation is laid out: a keyboard taller than
/// any before it is held from its first frame, not caught up with as it
/// rises. A floating or undocked keyboard, which leaves the screen's foot
/// free, is not counted.
@MainActor
final class KeyboardReserve: NSObject {
    static let shared = KeyboardReserve()

    private static let defaultsKey = "compose-keyboard-reserve"
    /// Keyed by the screen's height, rounded.
    private var tallest: [String: Double]

    private override init() {
        tallest = UserDefaults.standard.dictionary(forKey: Self.defaultsKey) as? [String: Double] ?? [:]
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillChangeFrame), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    }

    /// Notes `keyboard` (over the foot of a screen `height` high) and
    /// answers the tallest yet.
    func hold(_ keyboard: CGFloat, height: CGFloat) -> CGFloat {
        let key = String(Int(height.rounded()))
        let held = max(tallest[key] ?? 0, Double(keyboard))
        if held > tallest[key] ?? 0 {
            tallest[key] = held
            UserDefaults.standard.set(tallest, forKey: Self.defaultsKey)
        }
        return CGFloat(held)
    }

    /// Forgets every keyboard seen.
    func forget() {
        tallest = [:]
        UserDefaults.standard.removeObject(forKey: Self.defaultsKey)
    }

    @objc private func keyboardWillChangeFrame(_ notification: Notification) {
        guard let end = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect, !end.isEmpty,
              let screen = notification.object as? UIScreen
                ?? UIApplication.shared.connectedScenes.lazy.compactMap({ ($0 as? UIWindowScene)?.screen }).first else { return }
        let bounds = screen.bounds
        // Docked: it reaches the screen's foot.
        guard end.maxY >= bounds.maxY - 1, end.minY < bounds.maxY else { return }
        _ = hold(bounds.maxY - end.minY, height: bounds.height)
    }
}
#endif
