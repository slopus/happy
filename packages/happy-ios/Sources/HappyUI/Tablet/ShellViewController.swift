#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import UltraView

/// The window's root (docs/IPAD.md). On an iPhone it holds the app's one
/// navigation stack, `phone`. On an iPad it holds a `UISplitViewController`
/// with the system sidebar:
///
///     sidebar (primary)        main panel (secondary)
///     [home]                   [chat, profile, …] or the placeholder
///
///     compact column: `phone`, [home, chat, profile, …]
///
/// Home is the sidebar and never pushes: what it opens becomes the main
/// panel's root (`SidebarNavigationController`), and everything opened
/// from there is pushed in the main panel. The system's sidebar button and
/// ⌃⌘S hide the sidebar, giving the main panel the whole window; the choice
/// is kept per window.
///
/// The split view collapses by size class, and this shell also collapses
/// it below `SplitRule.minWidth` and whenever the root isn't a home
/// (onboarding, sign-in) by giving it a compact size class. Collapsing
/// moves the columns' screens onto `phone` as one stack, home first;
/// expanding moves them back (`SplitStack`). The same screens move, so
/// drafts, scroll positions and the selection survive a resize.
///
/// AppCoordinator sees one stack either way (`stack`, `setStack`), and this
/// shell is the delegate of every stack in it.
public final class ShellViewController: UIViewController {
    let context: AppContext
    /// The phone's stack: the only one on an iPhone, and the split's compact
    /// column on an iPad.
    let phone: UINavigationController
    let split: UISplitViewController?
    let sidebar: SidebarNavigationController
    let main: BrowserNavigationController
    /// The secondary column: the main panel's stack held to the column's
    /// safe area (`MainPanelLayout`), under a navigation controller whose
    /// own bar never shows.
    private let column: MainColumnViewController
    private let secondary: UINavigationController
    /// The root that wears the sidebar's button.
    private weak var toggleOwner: UIViewController?
    /// The sidebar's button: the system's symbol and the system's
    /// `toggleSidebar(_:)`, as ⌃⌘S sends it. The split's own
    /// `displayModeButtonItem` is a new object at every change, and shows
    /// nothing outside the bars it places it in itself.
    private lazy var toggle: UIBarButtonItem = {
        let item = UIBarButtonItem(image: UIImage(systemName: "sidebar.left"), primaryAction: UIAction { [weak self] _ in
            self?.split?.toggleSidebar(nil)
        })
        item.accessibilityIdentifier = "sidebar-toggle"
        return item
    }()
    /// The main panel with nothing open.
    let placeholder = MainPanelPlaceholderViewController()
    /// The columns hold the screens; otherwise `phone` holds them all.
    private(set) var isExpanded = false
    private var gestures: [PopGestureDelegate] = []
    /// Moving screens between the stacks: display-mode changes meanwhile
    /// aren't the person's.
    private var rewriting = false
    /// The window is being resized or the split collapsing or expanding:
    /// display-mode changes until it settles are the split's, not the
    /// person's.
    private var resizing = false

    /// `splits`: hold the split view, as an iPad does. A test can ask for
    /// it on any device.
    public init(context: AppContext, phone: UINavigationController, splits: Bool = UIDevice.current.userInterfaceIdiom == .pad) {
        self.context = context
        self.phone = phone
        sidebar = SidebarNavigationController(context: context)
        main = BrowserNavigationController(context: context)
        column = MainColumnViewController(main: main)
        secondary = UINavigationController(rootViewController: column)
        split = splits ? UISplitViewController(style: .doubleColumn) : nil
        super.init(nibName: nil, bundle: nil)
        sidebar.shell = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override var childForStatusBarStyle: UIViewController? { isExpanded ? main : phone }
    public override var childForStatusBarHidden: UIViewController? { isExpanded ? main : phone }
    public override var childForHomeIndicatorAutoHidden: UIViewController? { isExpanded ? main : phone }

    public override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        for navigation in [phone, sidebar, main] {
            AppCoordinator.applyAppearance(to: navigation.navigationBar)
            navigation.delegate = self
        }
        // UIKit makes a stack's swipe recognizers with its view, and takes
        // them back as their delegate when it does: load both first, or the
        // swipes stay UIKit's own (`PopGestureDelegate`).
        phone.loadViewIfNeeded()
        main.loadViewIfNeeded()
        gestures = [PopGestureDelegate(navigation: phone), PopGestureDelegate(navigation: main)]
        main.setViewControllers([placeholder], animated: false)
        guard let split else {
            embed(phone)
            return
        }
        split.delegate = self
        registerForTraitChanges([UITraitHorizontalSizeClass.self]) { (self: Self, _) in self.updateMode() }
        split.preferredSplitBehavior = .tile
        split.presentsWithGesture = true
        // The button is put in the main panel's bar, at its root's leading
        // edge (`placeToggle`), not over the sidebar.
        split.displayModeButtonVisibility = .never
        // Home's ground goes there, so the system's sidebar shows.
        sidebar.traitOverrides.isSidebarColumn = true
        secondary.setNavigationBarHidden(true, animated: false)
        split.setViewController(sidebar, for: .primary)
        split.setViewController(secondary, for: .secondary)
        split.setViewController(phone, for: .compact)
        // Collapsed until a home is the root on a window wide enough.
        split.traitOverrides.horizontalSizeClass = .compact
        embed(split)
    }

    private func embed(_ child: UIViewController) {
        addChild(child)
        child.view.frame = view.bounds
        child.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(child.view)
        child.didMove(toParent: self)
    }

    // MARK: The one stack

    /// The window's navigation as one stack, root first: home, then what
    /// the main panel shows. The placeholder is never in it.
    var stack: [UIViewController] {
        isExpanded ? SplitStack.collapsed(sidebar: sidebar.viewControllers, main: main.viewControllers, placeholder: placeholder) : phone.viewControllers
    }

    /// Puts `stack` where it belongs: all on the phone's stack, or its root
    /// in the sidebar and the rest in the main panel.
    func setStack(_ stack: [UIViewController], animated: Bool) {
        if isExpanded {
            let columns = SplitStack.expanded(stack, placeholder: placeholder)
            let sameRoot = sidebar.viewControllers.first === columns.sidebar.first
            if !sameRoot { sidebar.setViewControllers(columns.sidebar, animated: false) }
            main.setViewControllers(columns.main, animated: animated && sameRoot)
        } else {
            phone.setViewControllers(stack, animated: animated)
        }
        updateMode()
        followMainPanel()
    }

    /// The screen on top: the main panel's (its placeholder, with nothing
    /// open) beside the sidebar, the phone's otherwise.
    var topViewController: UIViewController? {
        isExpanded ? main.topViewController : phone.topViewController
    }

    /// A push or pop under way on any of the stacks.
    var stackTransition: (any UIViewControllerTransitionCoordinator)? {
        phone.transitionCoordinator ?? main.transitionCoordinator ?? sidebar.transitionCoordinator
    }

    /// What an account switch dissolves: the whole split beside the
    /// sidebar, the phone's stack otherwise.
    var crossfadeView: UIView {
        isExpanded ? (split?.view ?? phone.view) : phone.view
    }

    /// The sidebar is beside the main panel, rather than hidden.
    var showsSidebar: Bool {
        guard isExpanded, let split else { return false }
        return split.displayMode != .secondaryOnly
    }

    /// Hides or shows the sidebar, as its button and ⌃⌘S do.
    func setSidebarHidden(_ hidden: Bool) {
        guard isExpanded, let split else { return }
        if hidden { split.hide(.primary) } else { split.show(.primary) }
    }

    // MARK: Opening from the sidebar

    /// What the sidebar opens: the main panel's new root. The same thing
    /// again goes back to its root rather than open a second copy.
    func showInMain(_ controller: UIViewController, animated: Bool) {
        let current = main.viewControllers.first.flatMap { $0 === placeholder ? nil : $0 }
        switch SplitStack.opening(MainPanelKey.of(controller), current: current.flatMap(MainPanelKey.of)) {
        case .backToRoot:
            main.popToRootViewController(animated: animated)
        case .replace:
            main.setViewControllers([controller], animated: false)
        }
        followMainPanel()
    }

    /// The sidebar's button, first at the leading edge of the main panel's
    /// root while the window is split; it says hide or show as the
    /// sidebar is.
    private func placeToggle() {
        guard let split else { return }
        toggle.accessibilityLabel = split.displayMode == .secondaryOnly ? Strings.Tablet.showSidebar : Strings.Tablet.hideSidebar
        let owner = isExpanded ? main.viewControllers.first : nil
        if let old = toggleOwner, old !== owner {
            old.navigationItem.leftBarButtonItems = old.navigationItem.leftBarButtonItems?.filter { $0 !== toggle }
        }
        toggleOwner = owner
        guard let item = owner?.navigationItem else { return }
        let others = (item.leftBarButtonItems ?? []).filter { $0 !== toggle }
        if item.leftBarButtonItems?.first !== toggle { item.leftBarButtonItems = [toggle] + others }
        item.leftItemsSupplementBackButton = true
    }

    /// `controller`'s bar starts with the sidebar's button.
    func wearsToggle(_ controller: UIViewController) -> Bool {
        controller.navigationItem.leftBarButtonItems?.first === toggle
    }

    /// The sidebar's selection follows the main panel's root.
    private func followMainPanel() {
        placeToggle()
        let root = isExpanded ? main.viewControllers.first.flatMap { $0 === placeholder ? nil : $0 } : nil
        let home = isExpanded ? sidebar.viewControllers.first : phone.viewControllers.first
        (home as? MainPanelFollowing)?.mainPanelDidShow(root)
    }

    // MARK: Mode

    public override func viewWillTransition(to size: CGSize, with coordinator: any UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        // Split View, Slide Over and Stage Manager resizes, and rotation.
        resizing = true
        updateMode(width: size.width)
        coordinator.animate(alongsideTransition: nil) { [weak self] _ in self?.settle() }
    }

    /// After the layout pass that collapsed or expanded the split.
    private func settle() {
        DispatchQueue.main.async { [weak self] in self?.resizing = false }
    }

    public override func viewWillLayoutSubviews() {
        super.viewWillLayoutSubviews()
        updateMode()
    }

    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        syncStacks()
    }

    /// Collapses or expands the split for a window `width` wide (the
    /// current one by default) and the stack's root.
    func updateMode(width: CGFloat? = nil) {
        guard let split, isViewLoaded else { return }
        let width = width ?? view.bounds.width
        let sidebarWidth = SplitRule.sidebarWidth(windowWidth: width)
        if split.preferredPrimaryColumnWidth != sidebarWidth {
            split.minimumPrimaryColumnWidth = sidebarWidth
            split.maximumPrimaryColumnWidth = sidebarWidth
            split.preferredPrimaryColumnWidth = sidebarWidth
        }
        let wanted = SplitRule.showsSplit(
            width: width,
            isRegularWidth: traitCollection.horizontalSizeClass == .regular,
            showsHome: Self.isHome(stack.first)
        )
        let forcedCompact = split.traitOverrides.contains(UITraitHorizontalSizeClass.self)
        if wanted == forcedCompact {
            resizing = true
            settle()
            if wanted {
                split.traitOverrides.remove(UITraitHorizontalSizeClass.self)
            } else {
                split.traitOverrides.horizontalSizeClass = .compact
            }
        }
    }

    /// The screens follow the split: in the columns while it is expanded,
    /// on the phone's stack while collapsed. The delegate moves them just
    /// before the split changes; this catches the first layout, which
    /// asks no delegate.
    private func syncStacks() {
        guard let split else { return }
        if split.isCollapsed, isExpanded { collapseStacks() }
        if !split.isCollapsed, !isExpanded { expandStacks() }
    }

    static func isHome(_ controller: UIViewController?) -> Bool {
        controller is LegacyHomeViewController || controller is AgentHomeViewController
    }

    private func collapseStacks() {
        guard isExpanded else { return }
        rewriting = true
        defer { rewriting = false }
        let stack = SplitStack.collapsed(sidebar: sidebar.viewControllers, main: main.viewControllers, placeholder: placeholder)
        isExpanded = false
        sidebar.setViewControllers([], animated: false)
        main.setViewControllers([placeholder], animated: false)
        leave(sidebar, main)
        phone.setViewControllers(stack, animated: false)
        placeToggle()
        (stack.first as? MainPanelFollowing)?.mainPanelDidShow(nil)
        setNeedsStatusBarAppearanceUpdate()
    }

    private func expandStacks() {
        guard !isExpanded else { return }
        rewriting = true
        defer { rewriting = false }
        let columns = SplitStack.expanded(phone.viewControllers, placeholder: placeholder)
        isExpanded = true
        phone.setViewControllers([], animated: false)
        leave(phone)
        sidebar.setViewControllers(columns.sidebar, animated: false)
        main.setViewControllers(columns.main, animated: false)
        followMainPanel()
        setNeedsStatusBarAppearanceUpdate()
        // The window's choice: the split comes back as it was left, the
        // sidebar hidden if the person hid it.
        DispatchQueue.main.async { [weak self] in
            guard let self, let split, isExpanded, sidebarHidden, split.displayMode != .secondaryOnly else { return }
            UIView.performWithoutAnimation { split.hide(.primary) }
        }
    }

    /// The screens just taken off `stacks` hear they disappeared now, before
    /// the stack they move to tells them they appeared: a stack set without
    /// animation says so at its next layout, which may come after the other
    /// stack's.
    private func leave(_ stacks: UINavigationController...) {
        for stack in stacks where stack.isViewLoaded {
            stack.view.setNeedsLayout()
            stack.view.layoutIfNeeded()
        }
    }

    // MARK: The window's choice

    private static let sidebarHiddenKey = "happy.sidebarHidden"

    /// Whether the person hid the sidebar in this window. Kept with the
    /// window's scene session, so it survives a relaunch.
    private var sidebarHidden: Bool {
        get { view.window?.windowScene?.session.userInfo?[Self.sidebarHiddenKey] as? Bool ?? false }
        set {
            guard let session = view.window?.windowScene?.session else { return }
            var info = session.userInfo ?? [:]
            info[Self.sidebarHiddenKey] = newValue
            session.userInfo = info
        }
    }

    private var preferredMode: UISplitViewController.DisplayMode {
        sidebarHidden ? .secondaryOnly : .oneBesideSecondary
    }

    public override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        split?.preferredDisplayMode = preferredMode
        updateMode()
    }
}

extension ShellViewController: UISplitViewControllerDelegate {
    public func splitViewController(_ svc: UISplitViewController, topColumnForCollapsingToProposedTopColumn proposedTopColumn: UISplitViewController.Column) -> UISplitViewController.Column {
        collapseStacks()
        return .compact
    }

    public func splitViewController(_ svc: UISplitViewController, displayModeForExpandingToProposedDisplayMode proposedDisplayMode: UISplitViewController.DisplayMode) -> UISplitViewController.DisplayMode {
        expandStacks()
        return preferredMode
    }

    public func splitViewController(_ svc: UISplitViewController, willChangeTo displayMode: UISplitViewController.DisplayMode) {
        guard isExpanded, !rewriting, !resizing, !svc.isCollapsed else { return }
        // The sidebar's button, ⌃⌘S or the swipe: the person's choice.
        switch displayMode {
        case .secondaryOnly: sidebarHidden = true
        case .oneBesideSecondary: sidebarHidden = false
        default: return
        }
        // Kept through rotation and resizing, which go back to the
        // preferred mode.
        if svc.preferredDisplayMode != displayMode { svc.preferredDisplayMode = displayMode }
        DispatchQueue.main.async { [weak self] in self?.placeToggle() }
    }
}

extension ShellViewController: UINavigationControllerDelegate {
    public func navigationController(_ navigationController: UINavigationController, willShow viewController: UIViewController, animated: Bool) {
        Self.minimalBackButtons(in: navigationController)
    }

    public func navigationController(_ navigationController: UINavigationController, didShow viewController: UIViewController, animated: Bool) {
        // An interactive pop that was cancelled ends here on the screen it
        // started from.
        if navigationController === main { followMainPanel() }
    }

    /// Every screen in the stack, legacy and agent alike, is gone back to
    /// with the chevron alone in its glass circle: never "Back" nor the
    /// screen's title. Said before the bar draws the screen coming in.
    static func minimalBackButtons(in navigation: UINavigationController) {
        for controller in navigation.viewControllers where controller.navigationItem.backButtonDisplayMode != .minimal {
            controller.navigationItem.backButtonDisplayMode = .minimal
            controller.navigationItem.backButtonTitle = nil
        }
    }

    /// A screen with its own way in and out (new work from home's dock)
    /// brings it; every other one slides as UIKit's does. A pop the
    /// system's swipe is driving is UIKit's own: a screen's animator there
    /// would leave the swipe with nothing to drive, and it would not start.
    public func navigationController(
        _ navigationController: UINavigationController, animationControllerFor operation: UINavigationController.Operation,
        from fromVC: UIViewController, to toVC: UIViewController
    ) -> (any UIViewControllerAnimatedTransitioning)? {
        if operation == .pop, gestures.contains(where: { $0.isSwiping }) { return nil }
        switch operation {
        case .push: return (toVC as? NavigationTransitionProviding)?.navigationTransition(.push, other: fromVC)
        case .pop: return (fromVC as? NavigationTransitionProviding)?.navigationTransition(.pop, other: toVC)
        default: return nil
        }
    }
}

/// The secondary column's content: the main panel's stack, held to the
/// column's horizontal safe area, outside which the floating sidebar is.
final class MainColumnViewController: UIViewController {
    let main: UINavigationController

    init(main: UINavigationController) {
        self.main = main
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override var childForStatusBarStyle: UIViewController? { main }
    override var childForStatusBarHidden: UIViewController? { main }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.surface)
        addChild(main)
        view.addSubview(main.view)
        main.didMove(toParent: self)
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        // The sidebar coming or going: the panel follows, in its animation.
        view.setNeedsLayout()
        view.layoutIfNeeded()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        main.view.setLayoutFrame(MainPanelLayout(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets)).panel)
    }
}

/// A home that keeps the row of what the main panel shows selected.
@MainActor
protocol MainPanelFollowing: AnyObject {
    /// The main panel's root beside the sidebar; nil with nothing open, or
    /// when the window is a phone, where nothing stays selected.
    func mainPanelDidShow(_ root: UIViewController?)
}

/// The sidebar's stack: home alone. A push onto it (every way home opens
/// something) becomes the main panel's new root instead.
final class SidebarNavigationController: BrowserNavigationController {
    weak var shell: ShellViewController?

    override func pushViewController(_ viewController: UIViewController, animated: Bool) {
        guard let shell, shell.isExpanded, !viewControllers.isEmpty else {
            super.pushViewController(viewController, animated: animated)
            return
        }
        shell.showInMain(viewController, animated: animated)
    }
}

/// What a main panel's root stands for, so opening the same thing from the
/// sidebar again goes back to it rather than open a second copy.
@MainActor
enum MainPanelKey {
    private final class Box {
        let key: String
        init(_ key: String) { self.key = key }
    }

    private static let keys = NSMapTable<UIViewController, Box>.weakToStrongObjects()

    /// Names what `controller` shows, for a screen the type doesn't tell.
    static func record(_ key: String, for controller: UIViewController) {
        keys.setObject(Box(key), forKey: controller)
    }

    static func of(_ controller: UIViewController) -> String? {
        if let box = keys.object(forKey: controller) { return box.key }
        if let route = TabletRoutes.route(of: controller) { return "route:\(route)" }
        if let chat = controller as? ChatViewController, !chat.shownAgentId.isEmpty { return "agent:\(chat.shownAgentId)" }
        if controller is SettingsViewController { return "settings" }
        if controller is ArtifactsViewController { return "artifacts" }
        return nil
    }
}

/// A screen whose own content takes the back swipe while it has somewhere
/// to go back to: the browser, with history. UIKit's pop doesn't begin
/// then, so the swipe goes back a page; on the first page it closes the
/// screen as everywhere else.
@MainActor
protocol TakesBackSwipe: AnyObject {
    var takesBackSwipe: Bool { get }
}

/// UIKit's own swipe back, kept wherever there is something to go back
/// to. UIKit stops its edge swipe on a screen whose back button is hidden
/// or replaced (happy-app's plain headers, a bar item at the left);
/// react-native-screens' stack keeps it, and so does this. The swipe is
/// the system's: its gesture, its animation, iOS 26's swipe from anywhere
/// on the screen included. Only when it may begin is decided here.
final class PopGestureDelegate: NSObject, UIGestureRecognizerDelegate {
    private weak var navigation: UINavigationController?
    private weak var edgeSystem: (any UIGestureRecognizerDelegate)?
    private weak var contentSystem: (any UIGestureRecognizerDelegate)?

    init(navigation: UINavigationController) {
        self.navigation = navigation
        edgeSystem = navigation.interactivePopGestureRecognizer?.delegate
        if #available(iOS 26.0, *) { contentSystem = navigation.interactiveContentPopGestureRecognizer?.delegate }
        super.init()
        navigation.interactivePopGestureRecognizer?.delegate = self
        if #available(iOS 26.0, *) { navigation.interactiveContentPopGestureRecognizer?.delegate = self }
    }

    /// The edge or content swipe is under the finger now.
    var isSwiping: Bool {
        guard let navigation else { return false }
        var gestures = [navigation.interactivePopGestureRecognizer]
        if #available(iOS 26.0, *) { gestures.append(navigation.interactiveContentPopGestureRecognizer) }
        return gestures.contains { $0?.state == .began || $0?.state == .changed }
    }

    func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        guard let navigation else { return false }
        var begins = navigation.viewControllers.count > 1 && navigation.transitionCoordinator == nil
            && !(navigation.topViewController.map(Self.takesBackSwipe) ?? false)
        if #available(iOS 26.0, *), gesture === navigation.interactiveContentPopGestureRecognizer {
            // Unlike the edge recognizer, the content pan can begin anywhere.
            // Leave vertical scrolling and the opposite direction to content.
            let velocity = (gesture as? UIPanGestureRecognizer)?.velocity(in: navigation.view) ?? .zero
            let leading = navigation.view.effectiveUserInterfaceLayoutDirection == .rightToLeft ? -velocity.x : velocity.x
            begins = begins && leading > abs(velocity.y)
        }
        return begins
    }

    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        if isContent(gesture), Self.hasHorizontalContent(above: touch.view) { return false }
        let result = system(for: gesture)?.gestureRecognizer?(gesture, shouldReceive: touch) ?? true
        return result
    }

    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldReceive event: UIEvent) -> Bool {
        let result = system(for: gesture)?.gestureRecognizer?(gesture, shouldReceive: event) ?? true
        return result
    }

    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
        // UIKit knows its scroll-view pans, but UltraList's physics pan is a
        // regular pan that also begins for horizontal motion. It must wait
        // for the native pop rather than race it.
        if let navigation, navigation.viewControllers.count > 1,
           other is UIPanGestureRecognizer, let view = other.view,
           let top = navigation.topViewController?.viewIfLoaded, view.isDescendant(of: top) {
            if gesture === navigation.interactivePopGestureRecognizer { return true }
            if isContent(gesture), !Self.hasHorizontalContent(above: view), Self.isScrollPan(other) { return true }
        }
        let result = system(for: gesture)?.gestureRecognizer?(gesture, shouldBeRequiredToFailBy: other) ?? false
        return result
    }

    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldRequireFailureOf other: UIGestureRecognizer) -> Bool {
        let result = system(for: gesture)?.gestureRecognizer?(gesture, shouldRequireFailureOf: other) ?? false
        return result
    }

    private func isContent(_ gesture: UIGestureRecognizer) -> Bool {
        if #available(iOS 26.0, *) { return gesture === navigation?.interactiveContentPopGestureRecognizer }
        return false
    }

    /// Forward only UIKit's public delegate decisions. Advertising all of
    /// its private selectors makes the replacement delegate look like the
    /// internal transition object, and the native swipes stop receiving touches.
    private func system(for gesture: UIGestureRecognizer) -> (any UIGestureRecognizerDelegate)? {
        isContent(gesture) ? contentSystem : edgeSystem
    }

    /// Whether `controller`, or a screen inside it, goes back on its own.
    private static func takesBackSwipe(_ controller: UIViewController) -> Bool {
        if let owner = controller as? TakesBackSwipe, owner.takesBackSwipe { return true }
        return controller.children.contains(where: takesBackSwipe)
    }

    private static func isScrollPan(_ gesture: UIGestureRecognizer) -> Bool {
        if let scroll = gesture.view as? UIScrollView { return gesture === scroll.panGestureRecognizer }
        return (gesture.view?.superview as? UltraScrollView)?.contentView === gesture.view
    }

    static func hasHorizontalContent(above view: UIView?) -> Bool {
        var ancestor = view
        while let current = ancestor {
            if current is HorizontalListView { return true }
            if let scroll = current as? UIScrollView,
               scroll.isScrollEnabled, scroll.contentSize.width > scroll.bounds.width + 1 {
                return true
            }
            ancestor = current.superview
        }
        return false
    }
}
#endif
