#if canImport(UIKit)
import HappyLayout
import UIKit

/// A blur held part-way, as expo-blur's `intensity` holds it: the effect
/// is animated in and the animation is paused at `fraction`.
package final class PartialBlurView: UIVisualEffectView {
    package let fraction: CGFloat
    private var animator: UIViewPropertyAnimator?

    /// How much of the blur shows, 0 to 1, as a share of `fraction`: a
    /// blur fades in by strength, as an ancestor's alpha below 1 would turn
    /// it off (HomeDock.tsx:166).
    package var presence: CGFloat = 1 {
        didSet {
            guard presence != oldValue else { return }
            animator?.fractionComplete = fraction * presence
        }
    }

    package init(fraction: CGFloat) {
        self.fraction = fraction
        super.init(effect: nil)
        isUserInteractionEnabled = false
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.rebuild()
        }
    }

    @available(*, unavailable)
    package required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// A paused animator must be stopped before it is released. It only
    /// exists while the view is in a window, so leaving the window stops it.
    package override func didMoveToWindow() {
        super.didMoveToWindow()
        rebuild()
    }

    private func rebuild() {
        animator?.stopAnimation(true)
        animator = nil
        effect = nil
        guard window != nil else { return }
        // expo-blur names the material for the app's theme, not the system's.
        let style: UIBlurEffect.Style = traitCollection.userInterfaceStyle == .dark
            ? .systemUltraThinMaterialDark
            : .systemUltraThinMaterialLight
        let animator = UIViewPropertyAnimator(duration: 1, curve: .linear) { [weak self] in
            self?.effect = UIBlurEffect(style: style)
        }
        animator.pausesOnCompletion = true
        animator.fractionComplete = fraction * presence
        self.animator = animator
    }
}

/// MobileGlass.tsx's static material, as the header's controls use it: a
/// clipped blur with a faint tint inside a 1pt rim, on an unclipped shell
/// that carries the drop shadow.
package final class HeaderGlassView: UIView {
    package let blur = PartialBlurView(fraction: HeaderGlassShadow.materialFraction)
    private let overlay = UIView()

    package override init(frame: CGRect) {
        super.init(frame: frame)
        blur.clipsToBounds = true
        overlay.backgroundColor = UIColor(Palette.headerGlassOverlay)
        overlay.isUserInteractionEnabled = false
        blur.contentView.addSubview(overlay)
        addSubview(blur)
        layer.borderWidth = HomeHeaderLayout.Metrics.controlBorder
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOffset = CGSize(width: 0, height: HeaderGlassShadow.offsetY)
        layer.shadowRadius = HeaderGlassShadow.radius
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.applyColors()
        }
    }

    @available(*, unavailable)
    package required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    package override func layoutSubviews() {
        super.layoutSubviews()
        let radius = bounds.height / 2
        layer.cornerRadius = radius
        layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: radius).cgPath
        // `staticMaterialClip` fills the padding box, inside the rim.
        let inner = bounds.insetBy(dx: HomeHeaderLayout.Metrics.controlBorder, dy: HomeHeaderLayout.Metrics.controlBorder)
        blur.frame = inner
        blur.layer.cornerRadius = inner.height / 2
        overlay.frame = blur.contentView.bounds
        // Controls go above the material.
        sendSubviewToBack(blur)
    }

    private func applyColors() {
        let dark = traitCollection.userInterfaceStyle == .dark
        layer.borderColor = UIColor(Palette.headerGlassBorder).resolvedColor(with: traitCollection).cgColor
        layer.shadowOpacity = dark ? HeaderGlassShadow.darkOpacity : HeaderGlassShadow.lightOpacity
    }
}

/// StatusDot.tsx: a dot that breathes between full and 0.3 opacity while
/// pulsing.
package final class StatusDotView: UIView {
    package var isPulsing = false {
        didSet { if isPulsing != oldValue { updateAnimation() } }
    }

    package override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = bounds.width / 2
    }

    package override func didMoveToWindow() {
        super.didMoveToWindow()
        updateAnimation()
    }

    private func updateAnimation() {
        layer.removeAnimation(forKey: "pulse")
        guard isPulsing, window != nil else { return }
        let pulse = CABasicAnimation(keyPath: "opacity")
        pulse.fromValue = 1
        pulse.toValue = 0.3
        pulse.duration = 1
        pulse.autoreverses = true
        pulse.repeatCount = .infinity
        layer.add(pulse, forKey: "pulse")
    }
}
#endif
