#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

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
    private var popGesture: TabletPopGestureDelegate?

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
        popGesture = TabletPopGestureDelegate(navigation: detail)
        header.isHidden = true
        header.zenButton.addAction(UIAction { [weak self] _ in self?.toggleZen() }, for: .touchUpInside)
        header.backButton.addAction(UIAction { [weak self] _ in self?.goBack() }, for: .touchUpInside)
        view.addSubview(header)
    }

    /// AppCoordinator calls this after it replaces the stack's root: sign
    /// in, sign out, an account switch, the server confirmation.
    func rootDidChange() {
        let session = detail.viewControllers.first is HomeViewController ? context.account.session : nil
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
            popGesture?.isTablet = isTablet
        }
        if isTablet, sidebar == nil, let session {
            installSidebar(for: session)
        }
        let showsShell = TabletShellRule.showsShell(
            isAuthenticated: session != nil,
            isTablet: isTablet,
            showsInstallStep: sidebar?.state?.showsInstallStep ?? false,
            isOnboardingRoute: detail.topViewController is OnboardingSettingsViewController
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
    /// brings it; every other one slides as UIKit's does.
    public func navigationController(
        _ navigationController: UINavigationController, animationControllerFor operation: UINavigationController.Operation,
        from fromVC: UIViewController, to toVC: UIViewController
    ) -> (any UIViewControllerAnimatedTransitioning)? {
        switch operation {
        case .push: (toVC as? NavigationTransitionProviding)?.navigationTransition(.push, other: fromVC)
        case .pop: (fromVC as? NavigationTransitionProviding)?.navigationTransition(.pop, other: toVC)
        default: nil
        }
    }

    public func navigationController(
        _ navigationController: UINavigationController, interactionControllerFor animationController: any UIViewControllerAnimatedTransitioning
    ) -> (any UIViewControllerInteractiveTransitioning)? {
        (animationController as? InteractiveNavigationTransition)?.interaction
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

/// Keeps the edge swipe back on a tablet. Screens with happy-app's plain
/// header hide their back button there (`dropsBackButtonOnTablet`), and
/// UIKit stops the swipe for a screen without one; react-native-screens'
/// stack keeps it. On a tablet the swipe may begin whenever there is
/// something to go back to and no transition is running. Everything else,
/// and every decision off a tablet, is UIKit's own delegate's.
final class TabletPopGestureDelegate: NSObject, UIGestureRecognizerDelegate {
    var isTablet = false
    private weak var navigation: UINavigationController?
    nonisolated(unsafe) private weak var system: (any UIGestureRecognizerDelegate)?

    init(navigation: UINavigationController) {
        self.navigation = navigation
        system = navigation.interactivePopGestureRecognizer?.delegate
        super.init()
        navigation.interactivePopGestureRecognizer?.delegate = self
    }

    func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        if isTablet, let navigation {
            return navigation.viewControllers.count > 1 && navigation.transitionCoordinator == nil
        }
        return system?.gestureRecognizerShouldBegin?(gesture) ?? true
    }

    nonisolated override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || system?.responds(to: selector) == true
    }

    nonisolated override func forwardingTarget(for selector: Selector!) -> Any? {
        system?.responds(to: selector) == true ? system : super.forwardingTarget(for: selector)
    }
}
#endif
