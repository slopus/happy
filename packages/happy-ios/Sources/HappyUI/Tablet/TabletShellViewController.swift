#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import UltraView

/// The window's root: SidebarNavigator.tsx. It holds the app's one
/// navigation stack (AppCoordinator's) and, on a tablet-wide window, the
/// sidebar beside it with the persistent header over both.
///
/// A custom container rather than `UISplitViewController`, because happy-app's
/// shell doesn't follow size classes or the system sidebar:
///   - it switches at a window 768 wide (`TabletBreakpoint`), where a split
///     view collapses by horizontal size class (a half-screen 13-inch iPad
///     is regular, but under 768);
///   - the sidebar is 30% of the window held to 250…360, framed by its own
///     hairline on all four sides, with no column separator, material or
///     floating inset;
///   - zen mode snaps it to nothing, with the header's controls staying put
///     over the stack;
///   - the stack is one stack: the sidebar pushes onto it, and switching
///     layouts keeps everything on it, which a split view's separate
///     primary and secondary stacks don't.
///
/// The stack's root is home. Beside the sidebar home draws nothing
/// (MainView.tsx `isTablet`); home reads that from `TabletLayoutTrait`,
/// which this container sets from the window's width for everything under
/// it. Without the shell (a phone, a narrow window, signed out, the
/// first-run screens) the stack takes the whole window as before.
///
/// This container is the stack's delegate: it keeps the sidebar's
/// selection and the back control in step with the stack.
public final class TabletShellViewController: UIViewController, UINavigationControllerDelegate {
    let context: AppContext
    /// The app's navigation stack, owned by AppCoordinator.
    let detail: UINavigationController
    private let header = TabletPersistentHeaderView()
    private var sidebar: TabletSidebarViewController?
    /// The signed-in account whose home is the stack's root.
    private var session: AccountSession?
    /// The language the sidebar was built in.
    private var language = AppLocalization.language
    private var isTablet = false
    private var showsShell = false
    private var zenMode = false
    private var popGesture: PopGestureDelegate?

    public init(context: AppContext, detail: UINavigationController) {
        self.context = context
        self.detail = detail
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override var childForStatusBarStyle: UIViewController? { detail }
    public override var childForStatusBarHidden: UIViewController? { detail }
    public override var childForHomeIndicatorAutoHidden: UIViewController? { detail }

    public override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        addChild(detail)
        view.addSubview(detail.view)
        detail.didMove(toParent: self)
        detail.delegate = self
        popGesture = PopGestureDelegate(navigation: detail)
        header.isHidden = true
        header.zenButton.addAction(UIAction { [weak self] _ in self?.toggleZen() }, for: .touchUpInside)
        header.backButton.addAction(UIAction { [weak self] _ in self?.goBack() }, for: .touchUpInside)
        view.addSubview(header)
    }

    /// AppCoordinator calls this after it replaces the stack's root: sign
    /// in, sign out, an account switch, the server confirmation.
    func rootDidChange() {
        let session = detail.viewControllers.first is LegacyHomeViewController ? context.account.session : nil
        // A new language builds the sidebar again too, as the root was.
        if session !== self.session || language != AppLocalization.language {
            self.session = session
            language = AppLocalization.language
            removeSidebar()
            // Each account keeps its own local settings.
            zenMode = session != nil && context.account.localSettings.zenMode
            traitOverrides.isZenMode = zenMode
            header.isZenMode = zenMode
            view.setNeedsLayout()
        }
        update()
    }

    // MARK: Layout

    public override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        update()
    }

    public override func viewWillTransition(to size: CGSize, with coordinator: any UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        // Split View, Slide Over and Stage Manager resizes, and rotation.
        update(windowWidth: size.width)
    }

    public override func viewWillLayoutSubviews() {
        super.viewWillLayoutSubviews()
        update()
    }

    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let layout = TabletShellLayout(.init(
            size: view.bounds.size,
            safeArea: LayoutInsets(view.safeAreaInsets),
            showsShell: showsShell,
            zenMode: zenMode,
            headerHeight: headerHeight
        ))
        detail.view.setLayoutFrame(layout.detail)
        if let sidebar {
            sidebar.view.isHidden = layout.sidebar == nil
            if let frame = layout.sidebar { sidebar.view.setLayoutFrame(frame) }
            sidebar.headerHeight = headerHeight
        }
        if let frame = layout.header, let zen = layout.zenButton, let icon = layout.zenIcon, let back = layout.backButton {
            header.setLayoutFrame(frame)
            header.apply(
                zenButton: zen.offsetBy(dx: -frame.minX, dy: -frame.minY),
                zenIcon: icon.offsetBy(dx: -frame.minX, dy: -frame.minY),
                backButton: back.offsetBy(dx: -frame.minX, dy: -frame.minY)
            )
        }
    }

    /// `useHeaderHeight`: the device's, not the window's.
    private var headerHeight: CGFloat {
        DeviceCalculations.headerHeight(isPad: traitCollection.userInterfaceIdiom == .pad)
    }

    /// Decides the layout for a window `windowWidth` wide: the tablet
    /// trait, the sidebar, and whether the shell shows.
    private func update(windowWidth: CGFloat? = nil) {
        guard isViewLoaded else { return }
        let width = windowWidth ?? view.bounds.width
        let isTablet = TabletBreakpoint.isTablet(windowWidth: width)
        if isTablet != self.isTablet {
            self.isTablet = isTablet
            traitOverrides.isTabletLayout = isTablet
        }
        if isTablet, sidebar == nil, let session {
            installSidebar(for: session)
        }
        let showsShell = TabletShellRule.showsShell(
            isAuthenticated: session != nil,
            isTablet: isTablet,
            showsInstallStep: sidebar?.state?.showsInstallStep ?? false,
            isOnboardingRoute: false
        )
        if showsShell != self.showsShell {
            self.showsShell = showsShell
            header.isHidden = !showsShell
            view.setNeedsLayout()
        }
        updateStackState()
    }

    // MARK: Sidebar

    private func installSidebar(for session: AccountSession) {
        let sidebar = TabletSidebarViewController(context: context, session: session)
        sidebar.onStateChange = { [weak self] _ in self?.update() }
        addChild(sidebar)
        view.insertSubview(sidebar.view, belowSubview: header)
        sidebar.didMove(toParent: self)
        sidebar.view.isHidden = true
        self.sidebar = sidebar
    }

    private func removeSidebar() {
        guard let sidebar else { return }
        sidebar.willMove(toParent: nil)
        sidebar.view.removeFromSuperview()
        sidebar.removeFromParent()
        self.sidebar = nil
    }

    // MARK: Stack

    /// The selected row and the back control follow the stack's top.
    private func updateStackState() {
        sidebar?.selectedSessionId = detail.topViewController.flatMap(TabletRoutes.route(of:))?.sessionId
        header.canGoBack = detail.viewControllers.count > 1
    }

    public func navigationController(_ navigationController: UINavigationController, willShow viewController: UIViewController, animated: Bool) {
        update()
    }

    public func navigationController(_ navigationController: UINavigationController, didShow viewController: UIViewController, animated: Bool) {
        // An interactive pop that was cancelled ends here on the screen it
        // started from.
        update()
    }

    /// A screen with its own way in and out (new work from home's dock)
    /// brings it; every other one slides as UIKit's does. A pop the
    /// system's swipe is driving is UIKit's own: a screen's animator there
    /// would leave the swipe with nothing to drive, and it would not start.
    public func navigationController(
        _ navigationController: UINavigationController, animationControllerFor operation: UINavigationController.Operation,
        from fromVC: UIViewController, to toVC: UIViewController
    ) -> (any UIViewControllerAnimatedTransitioning)? {
        if operation == .pop, popGesture?.isSwiping == true { return nil }
        switch operation {
        case .push: return (toVC as? NavigationTransitionProviding)?.navigationTransition(.push, other: fromVC)
        case .pop: return (fromVC as? NavigationTransitionProviding)?.navigationTransition(.pop, other: toVC)
        default: return nil
        }
    }

    // MARK: Header

    private func toggleZen() {
        zenMode.toggle()
        context.account.localSettings.zenMode = zenMode
        traitOverrides.isZenMode = zenMode
        header.isZenMode = zenMode
        // Native React Native snaps the drawer's width; so does this.
        view.setNeedsLayout()
    }

    private func goBack() {
        guard detail.viewControllers.count > 1 else { return }
        detail.popViewController(animated: true)
    }
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
