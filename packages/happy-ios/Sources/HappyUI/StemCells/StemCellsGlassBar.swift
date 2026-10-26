#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// The glass bar of settings, the link sheet and every screen pushed from
/// them, as a conversation's header is (`StemCellChatHeaderView`): a glass
/// circle to go back or close where home's picture is, the title centred in
/// a glass capsule, and the actions in one glass capsule at the right, as
/// home's are, floating over the screen, which scrolls under them and a
/// scrim. Searching, a field in a glass capsule takes the row, beside a
/// circle that ends the search. Frames are `StemCellsGlassBarLayout`'s.
/// It covers its screen; touches anywhere but on its glass go through. A
/// `StemCellsGlassChrome` puts it on a screen.
@MainActor
final class StemCellsGlassBar: UIView {
    enum Leading {
        case back
    }

    struct Action {
        var image: UIImage?
        var label: String
        var id: String?
        var run: () -> Void
    }

    var leading: Leading? {
        didSet { if leading != oldValue { applyLeading() } }
    }

    var onLeading: (() -> Void)?
    /// A sheet's first screen: a close circle at the right, the row
    /// dropped to put it as far from the sheet's top as from its side.
    var closes = false {
        didSet {
            guard closes != oldValue else { return }
            owner?.additionalSafeAreaInsets.top = StemCellsGlassBarLayout.Metrics.span(closes: closes)
            setNeedsLayout()
        }
    }
    var onClose: (() -> Void)?
    var title: String? {
        didSet {
            guard title != oldValue else { return }
            titleLabel.text = title
            setNeedsLayout()
        }
    }

    /// Left to right.
    var actions: [Action] = [] {
        didSet { applyActions() }
    }

    var isSearching = false {
        didSet {
            guard isSearching != oldValue else { return }
            setNeedsLayout()
            layoutIfNeeded()
        }
    }

    let searchField = UITextField()
    var onEndSearch: (() -> Void)?
    /// The screen it is on: its own safe area is the screen's less the row
    /// the bar adds to it.
    weak var owner: UIViewController?

    private let scrim = HeaderScrimView()
    private let leadingGlass = StemCellsGlassBar.glass()
    private let leadingButton = UIButton(type: .system)
    private let closeGlass = StemCellsGlassBar.glass()
    private let closeButton = UIButton(type: .system)
    private let pillGlass = StemCellsGlassBar.glass()
    private let titleLabel = UILabel()
    private let actionsGlass = StemCellsGlassBar.glass()
    private var buttons: [UIButton] = []
    private var dividers: [UIView] = []
    private let searchGlass = StemCellsGlassBar.glass()
    private let endSearchGlass = StemCellsGlassBar.glass()
    private let endSearchButton = UIButton(type: .system)

    override init(frame: CGRect) {
        super.init(frame: frame)
        addSubview(scrim)
        leadingButton.tintColor = UIColor(Palette.headerTint)
        leadingButton.addAction(UIAction { [weak self] _ in self?.onLeading?() }, for: .touchUpInside)
        leadingGlass.contentView.addSubview(leadingButton)
        addSubview(leadingGlass)
        closeButton.tintColor = UIColor(Palette.headerTint)
        closeButton.setImage(Self.icon("close-outline", size: 28), for: .normal)
        closeButton.accessibilityLabel = Strings.StemCells.close
        closeButton.accessibilityIdentifier = "stem-glass-close"
        closeButton.addAction(UIAction { [weak self] _ in self?.onClose?() }, for: .touchUpInside)
        closeGlass.contentView.addSubview(closeButton)
        addSubview(closeGlass)
        let attributes = AppCoordinator.nativeTitleAttributes
        titleLabel.font = attributes[.font] as? UIFont
        titleLabel.textColor = attributes[.foregroundColor] as? UIColor
        titleLabel.textAlignment = .center
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.accessibilityTraits = .header
        pillGlass.contentView.addSubview(titleLabel)
        addSubview(pillGlass)
        addSubview(actionsGlass)
        searchField.font = StemCellsFonts.ui(.regular, size: 17)
        searchField.textColor = UIColor(Palette.text)
        searchField.tintColor = UIColor(Palette.stemCellsSettingsPrimary)
        searchField.returnKeyType = .search
        searchField.clearButtonMode = .whileEditing
        searchField.leftView = UIImageView(image: StemCellsGlyphs.image("search", size: 18).withRenderingMode(.alwaysTemplate))
        searchField.leftView?.tintColor = UIColor(Palette.textSecondary)
        searchField.leftViewMode = .always
        searchGlass.contentView.addSubview(searchField)
        addSubview(searchGlass)
        endSearchButton.setImage(Self.icon("close-outline", size: 28), for: .normal)
        endSearchButton.tintColor = UIColor(Palette.headerTint)
        endSearchButton.accessibilityLabel = Strings.Common.cancel
        endSearchButton.addAction(UIAction { [weak self] _ in self?.onEndSearch?() }, for: .touchUpInside)
        endSearchGlass.contentView.addSubview(endSearchButton)
        addSubview(endSearchGlass)
        applyLeading()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private static func glass() -> UIVisualEffectView {
        let effect = UIGlassEffect(style: .regular)
        effect.isInteractive = true
        return UIVisualEffectView(effect: effect)
    }

    private static func icon(_ name: String, size: CGFloat) -> UIImage {
        UIImage.icon(.ionicons(name), size: size).withRenderingMode(.alwaysTemplate)
    }

    private func applyLeading() {
        switch leading {
        case .back:
            leadingButton.setImage(Self.icon("chevron-back", size: 28), for: .normal)
            leadingButton.accessibilityLabel = Strings.StemCells.back
            leadingButton.accessibilityIdentifier = "stem-glass-back"
        case nil:
            break
        }
        setNeedsLayout()
    }

    private func applyActions() {
        for view in buttons + dividers { view.removeFromSuperview() }
        buttons = actions.map { action in
            let button = UIButton(type: .system)
            button.setImage(action.image?.withRenderingMode(.alwaysTemplate), for: .normal)
            button.tintColor = UIColor(Palette.headerTint)
            button.accessibilityLabel = action.label
            button.accessibilityIdentifier = action.id
            button.addAction(UIAction { _ in action.run() }, for: .touchUpInside)
            actionsGlass.contentView.addSubview(button)
            return button
        }
        dividers = actions.dropFirst().map { _ in
            let divider = UIView()
            divider.backgroundColor = UIColor(Palette.divider)
            divider.isUserInteractionEnabled = false
            actionsGlass.contentView.addSubview(divider)
            return divider
        }
        setNeedsLayout()
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        setNeedsLayout()
    }

    private var scrollWatches: [NSKeyValueObservation] = []

    /// On a screen that is itself a scroll view, the bar stays where the
    /// screen is, not where its content is, and over what it adds later.
    override func didMoveToSuperview() {
        super.didMoveToSuperview()
        scrollWatches = []
        layer.zPosition = 0
        guard let scroll = superview as? UIScrollView else {
            autoresizingMask = [.flexibleWidth, .flexibleHeight]
            return
        }
        autoresizingMask = []
        // Drawn over sections the screen adds after it, and brought in
        // front of them, for touches, whenever its content or size changes.
        layer.zPosition = 1000
        let pin = { [weak self] (scroll: UIScrollView) in MainActor.assumeIsolated { self?.pin(to: scroll) } }
        scrollWatches = [
            scroll.observe(\.contentOffset, options: [.initial, .new]) { scroll, _ in pin(scroll) },
            scroll.observe(\.contentSize, options: [.new]) { scroll, _ in pin(scroll) },
            scroll.observe(\.bounds, options: [.new]) { scroll, _ in pin(scroll) },
        ]
    }

    fileprivate func pin(to scroll: UIScrollView) {
        let frame = CGRect(origin: scroll.contentOffset, size: scroll.bounds.size)
        if self.frame.size != frame.size { setNeedsLayout() }
        if self.frame != frame { self.frame = frame }
        if scroll.subviews.last !== self { scroll.bringSubviewToFront(self) }
    }

    var layout: StemCellsGlassBarLayout {
        // The screen's safe area, which a scroll view's content doesn't share.
        let safeTop = (owner?.view ?? self).safeAreaInsets.top - (owner?.additionalSafeAreaInsets.top ?? 0)
        let titleWidth = title.map { _ in titleLabel.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: 22)).width }
        return StemCellsGlassBarLayout(width: bounds.width, safeTop: max(0, safeTop), hairline: 1 / traitCollection.displayScale.clamped(min: 1), hasLeading: leading != nil, actions: actions.count, titleWidth: titleWidth, searching: isSearching, closes: closes)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout
        scrim.frame = layout.backdrop
        // Nothing on the row, nothing to keep legible.
        scrim.isHidden = leading == nil && !closes && title == nil && actions.isEmpty && !isSearching
        place(leadingGlass, layout.leading)
        leadingButton.frame = leadingGlass.bounds
        place(closeGlass, layout.close)
        closeButton.frame = closeGlass.bounds
        place(pillGlass, layout.pill)
        if let pill = layout.pill, let title = layout.title {
            titleLabel.frame = title.offsetBy(dx: -pill.minX, dy: -pill.minY)
        }
        place(actionsGlass, layout.actions)
        if let actions = layout.actions {
            for (button, frame) in zip(buttons, layout.buttons) { button.frame = frame.offsetBy(dx: -actions.minX, dy: -actions.minY) }
            for (divider, frame) in zip(dividers, layout.dividers) { divider.frame = frame.offsetBy(dx: -actions.minX, dy: -actions.minY) }
        }
        place(searchGlass, layout.searchPill)
        if let pill = layout.searchPill, let field = layout.field {
            searchField.frame = field.offsetBy(dx: -pill.minX, dy: -pill.minY)
        }
        place(endSearchGlass, layout.cancel)
        endSearchButton.frame = endSearchGlass.bounds
    }

    private func place(_ glass: UIVisualEffectView, _ frame: CGRect?) {
        glass.isHidden = frame == nil
        guard let frame else { return }
        glass.frame = frame
        glass.cornerConfiguration = .corners(radius: .fixed(Double(frame.height / 2)))
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        guard let hit, hit !== self, hit !== scrim else { return nil }
        // On a screen that is a scroll view still gliding, the touch would
        // only stop it: it stops now, and the touch is the button's, as
        // over a bar of the system's.
        if let scroll = superview as? UIScrollView, scroll.isDecelerating {
            scroll.setContentOffset(scroll.contentOffset, animated: false)
        }
        return hit
    }
}

private extension CGFloat {
    func clamped(min lower: CGFloat) -> CGFloat { Swift.max(lower, self) }
}

/// The glass bar on a screen, as a child of it, so it follows the screen's
/// own comings and goings: appearing, the system bar goes and the edge
/// swipe goes back as the hidden bar's would (`StemCellsSwipeBack`);
/// covered by a screen of the system bar's, the bar comes back for it.
/// Settings and the link sheet make their own bars; the screens pushed
/// from them, at any depth, get one made from their navigation item: back
/// (a sheet's first screen closes at the right instead), the title, and the bar buttons that are
/// pictures. A screen searching in the system bar, or a conversation,
/// keeps its own; so does everything on a tablet, beside the sidebar's
/// header.
@MainActor
final class StemCellsGlassChrome: UIViewController {
    let bar: StemCellsGlassBar
    /// Made here from the screen's navigation item, and kept up with it.
    private let made: Bool
    private let swipeBack = StemCellsSwipeBack()
    /// The stack as it was with this screen on top.
    private var stackShown: [ObjectIdentifier] = []

    private init(bar: StemCellsGlassBar, made: Bool) {
        self.bar = bar
        self.made = made
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func loadView() { view = bar }

    /// `bar` on `controller`'s screen, over everything on it, with the row
    /// it takes added to the screen's safe area, so the screen starts under
    /// it and scrolls under it.
    static func install(_ bar: StemCellsGlassBar, on controller: UIViewController) {
        guard chrome(of: controller) == nil else { return }
        attach(StemCellsGlassChrome(bar: bar, made: false), to: controller)
    }

    /// A bar made for `controller`, unless it keeps the system's. Dressed
    /// before it's pushed, `over` is the screen it goes over, whose traits
    /// it will have.
    static func dress(_ controller: UIViewController, over: UIViewController? = nil) {
        let host = over ?? controller
        guard chrome(of: controller) == nil, wearsGlass(controller, inShell: inShell(host.navigationController, traits: host.traitCollection)) else { return }
        let chrome = StemCellsGlassChrome(bar: StemCellsGlassBar(), made: true)
        attach(chrome, to: controller)
        chrome.refresh()
    }

    static func chrome(of controller: UIViewController) -> StemCellsGlassChrome? {
        controller.children.lazy.compactMap { $0 as? StemCellsGlassChrome }.first
    }

    /// Under a tablet's shell, whose header stands in for the bar. A sheet
    /// presented over it has no such header, though it shares the trait.
    static func inShell(_ navigation: UINavigationController?, traits: UITraitCollection) -> Bool {
        traits.isTabletLayout && navigation?.presentingViewController == nil
    }

    private static func wearsGlass(_ controller: UIViewController, inShell: Bool) -> Bool {
        // Loaded, so a search controller set up with the view counts.
        controller.loadViewIfNeeded()
        return !inShell
            && controller.navigationItem.searchController == nil
            && !(controller is StemCellChatViewController)
            && !(controller is ChatViewController)
    }

    private static func attach(_ chrome: StemCellsGlassChrome, to controller: UIViewController) {
        controller.addChild(chrome)
        let view = controller.view!
        chrome.bar.owner = controller
        // Through `chrome.view`, loaded, so the screen's comings and goings
        // reach it.
        chrome.view.frame = view.bounds
        view.addSubview(chrome.view)
        chrome.didMove(toParent: controller)
        let row = StemCellsGlassBarLayout.Metrics.span(closes: chrome.bar.closes)
        if controller.additionalSafeAreaInsets.top != row { controller.additionalSafeAreaInsets.top = row }
        (view as? OnboardingScreenView)?.usesGlass = true
    }

    /// A made bar: what the screen's navigation item says now.
    private func refresh() {
        guard made, let screen = parent else { return }
        let navigation = screen.navigationController
        let first = navigation?.viewControllers.first === screen
        let tablet = Self.inShell(navigation, traits: screen.traitCollection)
        bar.leading = tablet || first ? nil : .back
        bar.closes = !tablet && first && navigation?.presentingViewController != nil
        bar.onLeading = { [weak screen] in screen?.navigationController?.popViewController(animated: true) }
        bar.onClose = { [weak screen] in screen?.navigationController?.dismiss(animated: true) }
        bar.title = screen.navigationItem.title ?? screen.title
        let items = (screen.navigationItem.rightBarButtonItems ?? []).reversed().filter { $0.image != nil }
        bar.actions = items.map { item in
            StemCellsGlassBar.Action(image: item.image, label: item.accessibilityLabel ?? item.title ?? "", id: item.accessibilityIdentifier) { [weak item] in
                guard let item else { return }
                if let action = item.primaryAction {
                    action.performWithSender(nil, target: nil)
                } else if let selector = item.action {
                    UIApplication.shared.sendAction(selector, to: item.target, from: item, for: nil)
                }
            }
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        refresh()
        if let navigation = parent?.navigationController, !navigation.isNavigationBarHidden {
            navigation.setNavigationBarHidden(true, animated: animated)
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard let navigation = parent?.navigationController else { return }
        // A tablet's stack keeps its shell's own swipe.
        if !Self.inShell(navigation, traits: traitCollection) { swipeBack.attach(to: navigation) }
        stackShown = navigation.viewControllers.map(ObjectIdentifier.init)
        // A swipe back let go of halfway gives the bar back to the screen
        // under this one after it appeared: hidden again.
        if !navigation.isNavigationBarHidden { navigation.setNavigationBarHidden(true, animated: false) }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        swipeBack.detach()
        guard let screen = parent, let navigation = screen.navigationController,
              let top = navigation.topViewController, top !== screen else { return }
        // Pushed over this one, the stack under it kept: it wears glass too,
        // where it can. Not a stack replaced, which lists the leaving
        // screen under the new one while it goes.
        let stack = navigation.viewControllers.map(ObjectIdentifier.init)
        if !stackShown.isEmpty, stack.count > stackShown.count, Array(stack.prefix(stackShown.count)) == stackShown { Self.dress(top, over: screen) }
        // Otherwise it has the bar it expects (home hides it again itself);
        // a chat has its own header.
        if Self.chrome(of: top) == nil, !(top is StemCellChatViewController) { navigation.setNavigationBarHidden(false, animated: animated) }
    }
}
#endif
