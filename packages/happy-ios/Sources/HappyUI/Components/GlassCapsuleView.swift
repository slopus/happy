#if canImport(UIKit)
import UIKit

/// The system's Liquid Glass (`UIGlassEffect`) as a capsule, its ends round
/// at any size: what a chat's title sits on, as Telegram's does on iOS 26
/// (its `GlassBackgroundView` with the `.panel` tint): the regular glass,
/// a faint white over it, fainter in the dark. What it carries goes in
/// `contentView`. Interactive, it answers a finger as the bar's own
/// buttons do. Untinted, it is the bar's own buttons' glass. Reduce
/// Transparency and the like are the system's to apply.
final class GlassCapsuleView: UIVisualEffectView {
    private let interactive: Bool
    private let tinted: Bool

    init(interactive: Bool = false, tinted: Bool = true) {
        self.interactive = interactive
        self.tinted = tinted
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

    /// Whether the glass is there; what it carries stays either way. Set
    /// inside an animation, the glass materializes or dissolves as the
    /// system's own does.
    var showsGlass = true {
        didSet { if showsGlass != oldValue { applyGlass() } }
    }

    /// Telegram's panel tint: white at 10% in the light, 2.5% in the dark.
    private func applyGlass() {
        guard showsGlass else { effect = nil; return }
        let glass = UIGlassEffect(style: .regular)
        if tinted { glass.tintColor = UIColor(white: 1, alpha: traitCollection.userInterfaceStyle == .dark ? 0.025 : 0.1) }
        glass.isInteractive = interactive
        effect = glass
    }
}
#endif
