#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// A blur held part-way, as expo-blur's `intensity` holds it: the effect
/// is animated in and the animation is paused at `fraction`.
final class PartialBlurView: UIVisualEffectView {
    let fraction: CGFloat
    private var animator: UIViewPropertyAnimator?

    /// How much of the blur shows, 0 to 1, as a share of `fraction`: a
    /// blur fades in by strength, as an ancestor's alpha below 1 would turn
    /// it off (HomeDock.tsx:166).
    var presence: CGFloat = 1 {
        didSet {
            guard presence != oldValue else { return }
            // A paused animator made at 0 draws the whole material, not
            // none, whatever it is moved to after: none is no animator.
            isHidden = presence <= 0
            if animator == nil || presence <= 0 {
                rebuild()
            } else {
                animator?.fractionComplete = fraction * presence
            }
        }
    }

    init(fraction: CGFloat) {
        self.fraction = fraction
        super.init(effect: nil)
        isUserInteractionEnabled = false
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.rebuild()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// A paused animator must be stopped before it is released. It only
    /// exists while the view is in a window, so leaving the window stops it.
    override func didMoveToWindow() {
        super.didMoveToWindow()
        rebuild()
    }

    private func rebuild() {
        animator?.stopAnimation(true)
        animator = nil
        effect = nil
        let target = fraction * presence
        isHidden = target <= 0
        guard window != nil, target > 0 else { return }
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
final class HeaderGlassView: UIView {
    let blur = PartialBlurView(fraction: HeaderGlassShadow.materialFraction)
    private let overlay = UIView()

    override init(frame: CGRect) {
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
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let radius = bounds.height / 2
        layer.cornerRadius = radius
        let path = UIBezierPath(roundedRect: bounds, cornerRadius: radius).cgPath
        // Inside an animation the shadow goes with the shape, not ahead of it.
        let duration = UIView.inheritedAnimationDuration
        if duration > 0, let from = layer.presentation()?.shadowPath ?? layer.shadowPath, from != path {
            let animation = CABasicAnimation(keyPath: "shadowPath")
            animation.fromValue = from
            animation.toValue = path
            animation.duration = duration
            animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            layer.add(animation, forKey: "shadowPath")
        }
        layer.shadowPath = path
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

/// A blur and nothing else: the system's blur with its material's tint,
/// saturation and brightness taken out, so over a plain ground it draws
/// that ground exactly and only what is under it softens. Were UIKit ever
/// to build its blur another way, it draws nothing rather than a tinted
/// material.
final class EdgeBlurView: UIVisualEffectView {
    /// The blur's radius, in points.
    var radius: CGFloat {
        didSet { if radius != oldValue { strip() } }
    }

    init(radius: CGFloat) {
        self.radius = radius
        super.init(effect: UIBlurEffect(style: .regular))
        isUserInteractionEnabled = false
        // A new style rebuilds the material, hidden or not.
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.strip()
            self.setNeedsLayout()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        strip()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        strip()
    }

    /// UIKit sets its effect up again as it sees fit: each time, only the
    /// backdrop's gaussian blur is kept, at `radius`, and the material's
    /// overlays go.
    private func strip() {
        for view in subviews where view !== contentView {
            let filters = (view.layer.filters as? [NSObject]) ?? []
            let named = filters.first { $0.responds(to: Selector(("name"))) && ($0.value(forKey: "name") as? String) == "gaussianBlur" }
            guard let found = named, let blur = found.copy() as? NSObject else {
                view.isHidden = true
                continue
            }
            // A fresh filter, so the backdrop redraws at the new radius.
            blur.setValue(radius, forKey: "inputRadius")
            view.layer.filters = [blur]
            view.isHidden = false
        }
    }
}

/// An edge where content scrolls under chrome, as Telegram treats its
/// two (`HeaderScrim`): a fade into the screen's own `ground`, so with
/// nothing under it the edge is that ground. The header's (`.top`) runs
/// down from the top, nearly whole with a light blur, and feathers out
/// over its last 36pt; the dock's and the composer's (`.bottom`) are a
/// light fade at the screen's foot and no blur.
final class HeaderScrimView: UIView {
    enum Edge {
        case top
        case bottom
    }

    let edge: Edge
    /// The screen's ground the edge fades into.
    var ground: UIColor = UIColor(Palette.surface) {
        didSet { setNeedsLayout() }
    }

    private let blur: EdgeBlurView?
    private let feather = HeaderScrimFeatherView()
    private let fade = CAGradientLayer()

    init(edge: Edge = .top) {
        self.edge = edge
        blur = edge == .top ? EdgeBlurView(radius: HeaderScrim.topBlurRadius) : nil
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        for gradient in [feather.gradient, fade] {
            gradient.startPoint = CGPoint(x: 0.5, y: edge == .top ? 0 : 1)
            gradient.endPoint = CGPoint(x: 0.5, y: edge == .top ? 1 : 0)
        }
        if let blur {
            // A visual effect view feathers by a mask view, not its layer's mask.
            blur.mask = feather
            addSubview(blur)
        }
        layer.addSublayer(fade)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.setNeedsLayout()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// How present the edge is, 0 to 1, set a frame at a time: the fade's
    /// opacity and the blur's radius, never this view's alpha, which would
    /// turn the blur off.
    var presence: CGFloat = 1 {
        didSet {
            guard presence != oldValue else { return }
            blur?.radius = HeaderScrim.topBlurRadius * presence
            blur?.isHidden = presence <= 0
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            fade.opacity = Float(presence)
            CATransaction.commit()
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        fade.frame = bounds
        let ground = ground.resolvedColor(with: traitCollection)
        let stops: [HeaderScrim.Stop]
        switch edge {
        case .top:
            stops = HeaderScrim.stops(height: bounds.height)
            fade.colors = stops.map { ground.withAlphaComponent($0.alpha * HeaderScrim.topPeak).cgColor }
        case .bottom:
            stops = HeaderScrim.footStops()
            fade.colors = stops.map { ground.withAlphaComponent($0.alpha).cgColor }
        }
        fade.locations = stops.map { NSNumber(value: $0.location) }
        if let blur {
            blur.frame = bounds
            feather.frame = blur.bounds
            feather.gradient.colors = stops.map { UIColor.white.withAlphaComponent($0.alpha).cgColor }
            feather.gradient.locations = fade.locations
        }
        CATransaction.commit()
    }
}

/// The blur's mask: whole where the edge holds, clear past its feather.
private final class HeaderScrimFeatherView: UIView {
    override class var layerClass: AnyClass { CAGradientLayer.self }
    var gradient: CAGradientLayer { layer as! CAGradientLayer }
}

/// StatusDot.tsx: a dot that breathes between full and 0.3 opacity while
/// pulsing.
final class StatusDotView: UIView {
    var isPulsing = false {
        didSet { if isPulsing != oldValue { updateAnimation() } }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = bounds.width / 2
    }

    override func didMoveToWindow() {
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

/// A 44pt header button holding one Ionicon (Header.tsx
/// `headerActionButton`).
final class HeaderIconButton: UIButton {
    let iconView: IconView

    init(_ icon: Icon, size: CGFloat, label: String) {
        iconView = IconView(icon, size: size, tint: Palette.headerTint)
        super.init(frame: .zero)
        addSubview(iconView)
        accessibilityLabel = label
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        iconView.frame = bounds
    }

    override var isHighlighted: Bool {
        didSet { iconView.alpha = isHighlighted ? 0.5 : 1 }
    }
}

#endif

#if canImport(UIKit)
extension UIEdgeInsets {
    init(_ insets: LayoutInsets) {
        self.init(top: insets.top, left: insets.left, bottom: insets.bottom, right: insets.right)
    }
}
#endif
