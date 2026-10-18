#if canImport(UIKit)
import UIKit
import UltraView

/// The chat's keyboard while its list renders with UltraList, through
/// UltraView's own keyboard integration (`KeyboardDismissalController`).
///
/// A finger that drags down from the list over the dock carries the
/// keyboard: the controller moves the keyboard and asks for the dock and
/// the list's newest inset in the same layout pass, and on release plays
/// the library's dismissal or return. Ordinary shows and hides come from
/// the keyboard's frame notifications, which the controller sees first,
/// and move the list on the library's keyboard transition. Where the
/// controller can't drive this keyboard (not a phone, a floating keyboard),
/// the list keeps the system's interactive dismissal.
///
/// Only the UltraList renderer makes one. The UICollectionView renderer
/// follows the keyboard layout guide as it always has.
@MainActor
final class ChatUltraKeyboard: NSObject {
    /// The keyboard moved: the screen lays itself out again at once, the
    /// list moving on `transition`.
    struct Change {
        var transition: ListTransition
        /// Whether the rows move with the newest inset; nil for the
        /// list's usual rule.
        var compensates: Bool?
        /// The library's motion has ended: nothing may keep animating.
        var finishes = false
    }

    private(set) weak var list: UltraListView?
    private weak var view: UIView?
    private var dismissal: KeyboardDismissalController?
    private let changed: (Change) -> Void
    /// How far the keyboard covers the bottom of `view`. Under the
    /// controller it drops below the resting edge as it leaves.
    private(set) var height: CGFloat = 0
    private var attached = false

    /// The controller found a keyboard it can drive.
    var isAvailable: Bool { dismissal?.isAvailable ?? false }
    /// A finger or a release owns the keyboard.
    var isDriving: Bool { dismissal?.isDriving ?? false }

    init(list: UltraListView, view: UIView, accessoryHeight: @escaping () -> CGFloat,
         hasInput: @escaping () -> Bool, changed: @escaping (Change) -> Void) {
        self.list = list
        self.view = view
        self.changed = changed
        super.init()
        dismissal = KeyboardDismissalController(
            scrollView: list, coordinateView: view,
            accessoryHeight: { Double(accessoryHeight()) },
            restingHeight: { [weak view] in Double(view?.safeAreaInsets.bottom ?? 0) },
            hasInput: hasInput,
            update: { [weak self] update in
                guard let self else { return }
                // The finger moves the rows while it tracks; a release
                // carries them only when nothing else holds them.
                let held = self.list.map { $0.isTracking || $0.isDragging } ?? false
                self.apply(height: CGFloat(update.height), Change(
                    transition: update.transition, compensates: !held,
                    finishes: update.transition.isImmediate && update.phase != .tracking
                ))
            }
        )
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(keyboardWillChangeFrame(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        center.addObserver(self, selector: #selector(keyboardDidHide(_:)), name: UIResponder.keyboardDidHideNotification, object: nil)
    }

    /// The keyboard's top in `view`. In the system's interactive dismissal
    /// only the layout guide follows the finger.
    func keyboardTop(guideTop: CGFloat) -> CGFloat {
        guard let view else { return guideTop }
        if !isAvailable, list?.isTracking == true { return guideTop }
        return view.bounds.maxY - height
    }

    /// Before the screen's layout. Back in a window, the keyboard is read
    /// from the layout guide: what it did meanwhile wasn't followed.
    func prepareLayout(guideTop: CGFloat) {
        guard let view else { return }
        let inWindow = view.window != nil
        if inWindow, !attached, !isDriving { height = max(0, view.bounds.maxY - guideTop) }
        attached = inWindow
    }

    /// After the screen's layout: the controller finds the keyboard and
    /// the window again.
    func refresh() {
        dismissal?.refresh()
    }

    /// The screen left its window.
    func detach() {
        attached = false
        dismissal?.invalidate()
    }

    /// A navigation away while a finger or a release owns the keyboard:
    /// the keyboard goes at once.
    func dismissImmediately() {
        dismissal?.dismissImmediately()
    }

    /// The renderer changed or the screen is done with.
    func invalidate() {
        NotificationCenter.default.removeObserver(self)
        attached = false
        dismissal?.invalidate()
        dismissal = nil
    }

    /// Takes the keyboard's new cover once the list's current pass is
    /// done, so the dock joins the list's own transaction.
    private func apply(height: CGFloat, _ change: Change) {
        let apply = { [weak self] in
            guard let self else { return }
            guard abs(height - self.height) > 0.01 || change.finishes else { return }
            self.height = height
            self.changed(change)
        }
        if let list { list.performAfterCurrentPass(apply) } else { apply() }
    }

    @objc private func keyboardWillChangeFrame(_ notification: Notification) {
        guard dismissal?.handle(notification) != true, let view, view.window != nil,
              let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        let local = dismissal?.resolvedKeyboardFrame(frame) ?? view.convert(frame, from: nil)
        let duration = notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0
        // An undocked keyboard covers nothing, as the layout guide reads it
        // with `followsUndockedKeyboard` off.
        let docked = local.maxY >= view.bounds.maxY - 1
        apply(height: docked ? max(0, view.bounds.maxY - local.minY) : 0,
              Change(transition: duration > 0 ? .keyboard(duration) : .immediate))
    }

    @objc private func keyboardDidHide(_ notification: Notification) {
        guard dismissal?.handle(notification) != true, view?.window != nil else { return }
        apply(height: 0, Change(transition: .immediate, finishes: true))
    }
}
#endif
