#if canImport(UIKit)
import HappyCore
import UIKit

/// The viewers' slot as a header's bar item, on agent conversations and
/// every Surface screen. Only a team has viewers: the item shows once the
/// session is known to be one (cloud, or a bootstrap that names the
/// person) and while its computer serves them (not after a 404, until the
/// next stream). Both are watched for the item's life, not the slot's
/// time in a window: a hidden item's slot is off screen.
@MainActor
final class ViewersBarItem: UIBarButtonItem {
    let slot: ViewersSlotView
    private var team = false
    private var available = true
    private var home: Watch?
    private var following: Task<Void, Never>?
    /// Hears the item hidden or shown again.
    var changed: (() -> Void)?

    /// The slot for `target` on a screen whose ground is `ground` (the
    /// faces' dot and badge are cut out of it); hidden until it is a team's.
    init(session: Session, target: ViewerTarget, ground: UIColor) {
        slot = ViewersSlotView(session: session, target: target, ground: ground)
        super.init()
        customView = slot
        // Faces in colour on the bar, not on a glass capsule of their own.
        if #available(iOS 26.0, *) { hidesSharedBackground = true }
        isHidden = true
        // Not loaded is not standalone: a cold link's screen comes before
        // the bootstrap that says whose team it is.
        home = session.watchHome { [weak self] home in
            self?.team = session.isCloud || home.userId != nil
            self?.update()
        }
        let store = session.engine.viewers
        following = Task { [weak self] in
            for await available in await store.available() {
                self?.available = available
                self?.update()
            }
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    // Not `isolated deinit` (see `Watch`).
    deinit { following?.cancel() }

    /// Whether the header shows it.
    var shown: Bool { team && available }

    private func update() {
        guard isHidden == shown else { return }
        isHidden = !shown
        changed?()
    }
}
#endif
