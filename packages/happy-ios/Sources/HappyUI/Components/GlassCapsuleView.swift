#if canImport(UIKit)
import UIKit

/// The system's Liquid Glass (`UIGlassEffect`) as a capsule, its ends round
/// at any size: what a chat's title sits on, as Telegram's does on iOS 26
/// (its `GlassBackgroundView` with the `.panel` tint): the regular glass,
/// a faint white over it, fainter in the dark. What it carries goes in
/// `contentView`. Interactive, it answers a finger as the bar's own
/// buttons do. Reduce Transparency and the like are the system's to apply.
final class GlassCapsuleView: UIVisualEffectView {
    private let interactive: Bool

    init(interactive: Bool = false) {
        self.interactive = interactive
        super.init(effect: nil)
        cornerConfiguration = .capsule()
        applyGlass()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.applyGlass()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Telegram's panel tint: white at 10% in the light, 2.5% in the dark.
    private func applyGlass() {
        let glass = UIGlassEffect(style: .regular)
        glass.tintColor = UIColor(white: 1, alpha: traitCollection.userInterfaceStyle == .dark ? 0.025 : 0.1)
        glass.isInteractive = interactive
        effect = glass
    }
}
#endif
