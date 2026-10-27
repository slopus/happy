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
            animator?.fractionComplete = fraction * presence
            // A paused animator at 0 draws the whole material, not none.
            isHidden = presence <= 0
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

/// MobileHeaderScrim.tsx, home variant: a light blur and a dim wash, both
/// at full strength at the screen's edge and feathered out over the last
/// 36pt towards the content. The header's runs down from the top; the
/// dock's (`edge="bottom"`) runs up from the foot.
final class HeaderScrimView: UIView {
    enum Edge {
        case top
        case bottom
    }

    private let blur = PartialBlurView(fraction: HeaderScrim.edgeBlurFraction)
    private let blurMask = CAGradientLayer()
    private let tint = CAGradientLayer()

    init(edge: Edge = .top) {
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        blur.layer.mask = blurMask
        addSubview(blur)
        layer.addSublayer(tint)
        for gradient in [blurMask, tint] {
            gradient.startPoint = CGPoint(x: 0.5, y: edge == .top ? 0 : 1)
            gradient.endPoint = CGPoint(x: 0.5, y: edge == .top ? 1 : 0)
        }
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.setNeedsLayout()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// MobileHeaderScrim's `overlayOpacity`: scales the wash, never the
    /// blur. The chat's header strengthens it once content is under it,
    /// animating it in a transaction of its own.
    var overlayOpacity: Float = 1 {
        didSet { tint.opacity = overlayOpacity * Float(presence) }
    }

    /// How present the scrim is, 0 to 1, set a frame at a time: the wash's
    /// opacity and the blur's strength, never this view's alpha, which
    /// would turn the blur off.
    var presence: CGFloat = 1 {
        didSet {
            guard presence != oldValue else { return }
            blur.presence = presence
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            tint.opacity = overlayOpacity * Float(presence)
            CATransaction.commit()
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        blur.frame = bounds
        blurMask.frame = blur.bounds
        tint.frame = bounds
        let dark = traitCollection.userInterfaceStyle == .dark
        let base = UIColor(Palette.headerScrimTint).resolvedColor(with: traitCollection)
        let tintStops = HeaderScrim.stops(height: bounds.height, peak: dark ? HeaderScrim.strongPeakDark : HeaderScrim.strongPeakLight)
        tint.colors = tintStops.map { base.withAlphaComponent($0.alpha).cgColor }
        tint.locations = tintStops.map { NSNumber(value: $0.location) }
        let maskStops = HeaderScrim.stops(height: bounds.height, peak: 1)
        blurMask.colors = maskStops.map { UIColor.white.withAlphaComponent($0.alpha).cgColor }
        blurMask.locations = maskStops.map { NSNumber(value: $0.location) }
        CATransaction.commit()
    }
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

/// The iPhone home header (MainView.tsx's phone header): the logo in a
/// glass circle, "Sessions" with the socket status under it, and the
/// filter menu and settings in a glass pill. It floats over home's content
/// on the home scrim; `HomeHeaderLayout` places everything.
final class HomeHeaderView: UIView {
    let scrim = HeaderScrimView()
    let logoControl = HeaderGlassView()
    let logo = UIImageView()
    let actions = HeaderGlassView()
    let filterButton = HeaderIconButton(.ionicons("filter"), size: 22, label: Strings.Home.filterTitle)
    let actionDivider = UIView()
    let settingsButton = HeaderIconButton(.ionicons("settings-outline"), size: 22, label: Strings.Settings.title)
    /// Stem Cells' search, in the pill's first slot.
    let searchButton = HeaderIconButton(.ionicons("search-outline"), size: 22, label: Strings.StemCells.search)
    /// A computer's home: the pill is search alone, and the picture is the
    /// way to settings, so there is no gear (and no filter: a computer's
    /// home has nothing to group).
    var stemCellsActions = false {
        didSet {
            guard stemCellsActions != oldValue else { return }
            searchButton.isHidden = !stemCellsActions
            settingsButton.isHidden = stemCellsActions
            filterButton.isHidden = stemCellsActions
            actionDivider.isHidden = stemCellsActions
            setNeedsLayout()
        }
    }
    let titleLabel = StyledLabel(style: TextStyles.headerTitle, color: Palette.headerTint, lines: 1, alignment: .center)
    let statusDot = StatusDotView()
    let statusLabel = StyledLabel(style: TextStyles.homeHeaderStatus, color: Palette.textSecondary, lines: 1, alignment: .center)
    var showsAccountAvatar = false { didSet { setNeedsLayout() } }
    /// Drawn over the scrim and under the controls, as big as the header
    /// and free to hang below it: the stories, which close into the title
    /// and open under the header. It takes the touches its own
    /// `point(inside:with:)` takes.
    var accessory: UIView? {
        didSet {
            guard accessory !== oldValue else { return }
            oldValue?.removeFromSuperview()
            if let accessory { insertSubview(accessory, aboveSubview: scrim) }
            setNeedsLayout()
        }
    }
    /// Where the title starts while the accessory places it; nil centres it.
    var titleX: CGFloat? { didSet { if titleX != oldValue { setNeedsLayout() } } }
    /// How much deeper the scrim reaches, under the accessory's open row.
    var backdropExtension: CGFloat = 0 { didSet { if backdropExtension != oldValue { setNeedsLayout() } } }

    var status: RealtimeStatus = HomeConnectionStatus.initial {
        didSet { if status != oldValue { applyStatus() } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        logo.image = UIImage.happy("logo-black")?.withRenderingMode(.alwaysTemplate)
        logo.tintColor = UIColor(Palette.headerTint)
        logo.contentMode = .scaleAspectFit
        logo.isAccessibilityElement = false
        logoControl.isUserInteractionEnabled = false
        logoControl.addSubview(logo)
        actionDivider.backgroundColor = UIColor(Palette.divider)
        for view in [searchButton, filterButton, actionDivider, settingsButton] {
            actions.addSubview(view)
        }
        searchButton.isHidden = true
        titleLabel.string = Strings.Home.sessionsTitle
        titleLabel.accessibilityTraits = .header
        for view in [scrim, logoControl, actions, titleLabel, statusDot, statusLabel] {
            addSubview(view)
        }
        applyStatus()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Only the controls and what the accessory takes; the rest lets the
    /// list scroll.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        if logoControl.frame.contains(point) || actions.frame.contains(point) { return true }
        guard let accessory, !accessory.isHidden else { return false }
        return accessory.point(inside: convert(point, to: accessory), with: event)
    }

    private var showsStatus: Bool {
        HomeConnectionStatus.shows(status)
    }

    private func applyStatus() {
        let color: ColorToken = switch status {
        case .connected: Palette.statusConnected
        case .connecting: Palette.statusConnecting
        case .disconnected: Palette.statusDisconnected
        case .error: Palette.statusError
        }
        statusLabel.string = Strings.Home.connectionStatus(status)
        statusLabel.color = color
        statusDot.backgroundColor = UIColor(color)
        statusDot.isPulsing = HomeConnectionStatus.pulses(status)
        statusLabel.isHidden = !showsStatus
        statusDot.isHidden = !showsStatus
        titleLabel.accessibilityValue = showsStatus ? statusLabel.string : nil
        setNeedsLayout()
    }

    func layout(width: CGFloat) -> HomeHeaderLayout {
        var input = HomeHeaderLayout.Input(
            width: width,
            safeTop: safeAreaInsets.top,
            hairline: hairline,
            title: titleLabel.measurable,
            status: showsStatus ? statusLabel.measurable : nil
        )
        input.showsAccountAvatar = showsAccountAvatar
        input.titleX = titleX
        input.backdropExtension = backdropExtension
        input.singleAction = stemCellsActions
        return HomeHeaderLayout(input)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        scrim.setLayoutFrame(layout.backdrop)
        accessory?.frame = bounds
        logoControl.setLayoutFrame(layout.logoControl)
        logo.setLayoutFrame(layout.logo.offsetBy(dx: -layout.logoControl.minX, dy: -layout.logoControl.minY))
        logo.clipsToBounds = showsAccountAvatar
        logo.layer.cornerRadius = showsAccountAvatar ? layout.logo.width / 2 : 0
        actions.setLayoutFrame(layout.actions)
        let origin = layout.actions.origin
        // The pill's slots: filter and settings, or a computer's search alone.
        let first = layout.filterButton.offsetBy(dx: -origin.x, dy: -origin.y)
        let second = layout.settingsButton.offsetBy(dx: -origin.x, dy: -origin.y)
        searchButton.setLayoutFrame(first)
        filterButton.setLayoutFrame(first)
        actionDivider.setLayoutFrame(layout.actionDivider.offsetBy(dx: -origin.x, dy: -origin.y))
        settingsButton.setLayoutFrame(second)
        titleLabel.setLayoutFrame(layout.title)
        if let frame = layout.statusDot { statusDot.setLayoutFrame(frame) }
        if let frame = layout.status { statusLabel.setLayoutFrame(frame) }
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
