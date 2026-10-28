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
    /// What search is typed into: the pill grows into it, after the glyph.
    let searchField = UITextField()
    /// The glass circle at the right that ends the search.
    let searchCancel = HeaderGlassView()
    let searchCancelButton = HeaderIconButton(.ionicons("close-outline"), size: 26, label: Strings.Common.cancel)
    /// A computer's search is open in the header: the pill is its field,
    /// the logo and title give way. Set inside an animation to grow it.
    var isSearching = false {
        didSet {
            guard isSearching != oldValue else { return }
            applySearching()
            setNeedsLayout()
        }
    }
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
        searchField.font = StemCellsFonts.ui(.regular, size: 17)
        searchField.textColor = UIColor(Palette.text)
        searchField.tintColor = UIColor(Palette.stemCellsSettingsPrimary)
        searchField.placeholder = Strings.StemCells.search
        searchField.returnKeyType = .search
        searchField.enablesReturnKeyAutomatically = false
        searchField.clearButtonMode = .whileEditing
        searchField.autocorrectionType = .no
        searchField.autocapitalizationType = .none
        searchField.spellCheckingType = .no
        searchField.accessibilityIdentifier = "stem-search-field"
        actions.addSubview(searchField)
        searchCancel.addSubview(searchCancelButton)
        searchCancelButton.accessibilityIdentifier = "stem-search-cancel"
        titleLabel.string = Strings.Home.sessionsTitle
        titleLabel.accessibilityTraits = .header
        // The title sits under the pill, which grows over it into the field.
        for view in [scrim, logoControl, titleLabel, statusDot, statusLabel, actions, searchCancel] {
            addSubview(view)
        }
        applyStatus()
        applySearching()
    }

    /// What shows for the search's state. In an animation the circle
    /// grows with the pill, while the logo and title are gone before the
    /// glass reaches them (it's clear enough to show them through) and the
    /// field comes in after; closing, the other way round.
    private func applySearching() {
        let searching = isSearching
        let quiet: [UIView] = [logoControl, titleLabel, statusDot, statusLabel]
        // What goes, then what comes.
        let going = { for view in (searching ? quiet : [self.searchField]) { view.alpha = 0 } }
        let coming = { for view in (searching ? [self.searchField] : quiet) { view.alpha = 1 } }
        if UIView.inheritedAnimationDuration > 0 {
            UIView.animate(withDuration: 0.08, delay: 0, options: [.beginFromCurrentState, .curveEaseOut, .overrideInheritedDuration, .overrideInheritedCurve], animations: going)
            UIView.animate(withDuration: 0.2, delay: 0.1, options: [.beginFromCurrentState, .curveEaseIn, .overrideInheritedDuration, .overrideInheritedCurve], animations: coming)
        } else {
            going()
            coming()
        }
        searchCancel.alpha = searching ? 1 : 0
        searchCancel.transform = searching ? .identity : CGAffineTransform(scaleX: 0.6, y: 0.6)
        // The glyph stays as the field's own; the field takes its touches.
        searchButton.isUserInteractionEnabled = !isSearching
        searchButton.isAccessibilityElement = !isSearching
        logoControl.isUserInteractionEnabled = !isSearching && logoInteractive
        for view in [logoControl, titleLabel] as [UIView] { view.accessibilityElementsHidden = isSearching }
        searchCancel.isUserInteractionEnabled = isSearching
        searchCancel.accessibilityElementsHidden = !isSearching
        searchField.isUserInteractionEnabled = isSearching
        searchField.accessibilityElementsHidden = !isSearching
    }

    /// Whether the logo takes taps when search isn't open over it.
    var logoInteractive = false {
        didSet { logoControl.isUserInteractionEnabled = logoInteractive && !isSearching }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Only the controls and what the accessory takes; the rest lets the
    /// list scroll.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        if logoControl.frame.contains(point) || actions.frame.contains(point) { return true }
        if isSearching, searchCancel.frame.contains(point) { return true }
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
        input.searching = isSearching
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
        searchField.setLayoutFrame(layout.searchField.offsetBy(dx: -origin.x, dy: -origin.y))
        // Its transform scales it in: the frame goes through its bounds and centre.
        searchCancel.bounds = CGRect(origin: .zero, size: layout.searchCancel.size)
        searchCancel.center = CGPoint(x: layout.searchCancel.midX, y: layout.searchCancel.midY)
        searchCancelButton.frame = searchCancel.bounds
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
