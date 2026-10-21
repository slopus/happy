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
/// It works only while the screen is shown: `activate()` on appearance
/// makes the library's controller, `deactivate()` once the screen has gone
/// drops it, so nothing a covered screen lays out or hears brings it back.
///
/// Only the UltraList renderer under the floating dock makes one (a phone
/// in portrait). The UICollectionView renderer, and UltraList docked,
/// follow the keyboard layout guide as they always have.
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

    /// Kept until this is dropped, even past a renderer switch, so what the
    /// list's motion carried can still be landed on it.
    let list: UltraListView
    private weak var view: UIView?
    private var dismissal: KeyboardDismissalController?
    private let accessoryHeight: () -> CGFloat
    private let hasInput: () -> Bool
    private let changed: (Change) -> Void
    /// How far the keyboard covers the bottom of `view`. Under the
    /// controller it drops below the resting edge as it leaves.
    private(set) var height: CGFloat = 0
    /// Read the layout guide at the next layout: the keyboard wasn't
    /// followed while the screen was away.
    private var resync = true
    /// Moves when the screen goes, with every notification and with every
    /// update of the controller's, so only the latest notification queued
    /// behind the list's pass applies, and none once the screen has gone or
    /// the controller has moved the keyboard since.
    private var generation: UInt64 = 0

    private(set) var isActive = false
    /// The controller found a keyboard it can drive.
    var isAvailable: Bool { dismissal?.isAvailable ?? false }
    /// A finger or a release owns the keyboard.
    var isDriving: Bool { dismissal?.isDriving ?? false }

    init(list: UltraListView, view: UIView, accessoryHeight: @escaping () -> CGFloat,
         hasInput: @escaping () -> Bool, changed: @escaping (Change) -> Void) {
        self.list = list
        self.view = view
        self.accessoryHeight = accessoryHeight
        self.hasInput = hasInput
        self.changed = changed
        super.init()
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(keyboardWillChangeFrame(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        center.addObserver(self, selector: #selector(keyboardDidHide(_:)), name: UIResponder.keyboardDidHideNotification, object: nil)
    }

    /// The screen is appearing: the library's controller starts.
    func activate() {
        guard !isActive, let view else { return }
        isActive = true
        resync = true
        let accessoryHeight = accessoryHeight
        dismissal = KeyboardDismissalController(
            scrollView: list, coordinateView: view,
            accessoryHeight: { Double(accessoryHeight()) },
            restingHeight: { [weak view] in Double(view?.safeAreaInsets.bottom ?? 0) },
            hasInput: hasInput,
            update: { [weak self] update in self?.driven(update) }
        )
    }

    /// The screen has gone: the controller lets go of the keyboard, the
    /// window and the list, and is dropped.
    func deactivate() {
        guard isActive else { return }
        isActive = false
        generation &+= 1
        dismissal?.invalidate()
        dismissal = nil
    }

    /// The renderer changed or the screen is done with.
    func invalidate() {
        NotificationCenter.default.removeObserver(self)
        deactivate()
    }

    /// The keyboard's top in `view`. In the system's interactive dismissal
    /// only the layout guide follows the finger.
    func keyboardTop(guideTop: CGFloat) -> CGFloat {
        guard let view else { return guideTop }
        if !isAvailable, list.isTracking { return guideTop }
        return view.bounds.maxY - height
    }

    /// Before the screen's layout.
    func prepareLayout(guideTop: CGFloat) {
        guard isActive, resync, let view, view.window != nil, !isDriving else { return }
        resync = false
        height = max(0, view.bounds.maxY - guideTop)
    }

    /// After the screen's layout: the controller finds the keyboard and
    /// the window again.
    func refresh() {
        guard isActive else { return }
        dismissal?.refresh()
    }

    /// A navigation away while a finger or a release owns the keyboard:
    /// the keyboard goes at once.
    func dismissImmediately() {
        dismissal?.dismissImmediately()
    }

    /// The controller's update, applied before it returns, as its
    /// contract asks: the controller has already waited out the list's
    /// pass.
    private func driven(_ update: KeyboardDismissalUpdate) {
        guard isActive else { return }
        generation &+= 1
        // The finger moves the rows while it tracks; a release carries
        // them only when nothing else holds them. A released finger can
        // leave the rows coasting before its return arrives: moved against
        // that, they'd ride up with the composer and turn back.
        let held = list.isTracking || list.isDragging || list.isDecelerating
        take(CGFloat(update.height), Change(
            transition: update.transition, compensates: !held,
            finishes: update.transition.isImmediate && update.phase != .tracking
        ))
    }

    /// A notification's keyboard, once the list's current pass is done, so
    /// the dock joins the list's own transaction. A finger or a release
    /// that took the keyboard meanwhile keeps it.
    private func notified(height: CGFloat, _ change: Change) {
        generation &+= 1
        let generation = generation
        let apply: @MainActor @Sendable () -> Void = { [weak self] in
            guard let self, self.isActive, self.generation == generation, !self.isDriving else { return }
            self.take(height, change)
        }
        list.performAfterCurrentPass(apply)
    }

    private func take(_ height: CGFloat, _ change: Change) {
        guard abs(height - self.height) > 0.01 || change.finishes else { return }
        self.height = height
        changed(change)
    }

    @objc private func keyboardWillChangeFrame(_ notification: Notification) {
        guard isActive, dismissal?.handle(notification) != true, let view, view.window != nil,
              let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        let local = dismissal?.resolvedKeyboardFrame(frame) ?? view.convert(frame, from: nil)
        let duration = notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0
        // An undocked keyboard covers nothing, as the layout guide reads it
        // with `followsUndockedKeyboard` off.
        let docked = local.maxY >= view.bounds.maxY - 1
        notified(height: docked ? max(0, view.bounds.maxY - local.minY) : 0,
                 Change(transition: duration > 0 ? .keyboard(duration) : .immediate))
    }

    @objc private func keyboardDidHide(_ notification: Notification) {
        guard isActive, dismissal?.handle(notification) != true, view?.window != nil else { return }
        notified(height: 0, Change(transition: .immediate, finishes: true))
    }
}
#endif
