#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The phone's drawer (Steve, iPhone and Android alike): a panel from the
/// leading edge over the dimmed screen. At its top the account's switcher
/// (its picture and name; a tap opens the accounts' menu), then Home, the
/// places (Activity, Artifacts, Documents, TODOs, a server's Plugins and
/// Pipelines) and the other Surfaces the person is in, and Settings at its
/// foot (`Drawer`).
///
/// It opens from home's own face in the bar (`AccountSwitcher.onTap`), a
/// section's ☰, and a swipe in from the edge on either; only ever over a
/// root, so a pushed screen keeps its back swipe. Picking a place makes
/// its screen the stack's root in home's place (no push) and closes the
/// drawer; what that screen opens is pushed over it, and back returns to
/// it. Home is kept the while, so going back to it finds it as it was.
/// Settings is pushed over whatever is the root.
///
/// One per navigation stack (`attach`), holding the home it serves; a
/// root that is neither (another account's home, Start) lets it go
/// (`follow`). The iPad keeps its sidebar and has none.
///
/// Plugins is a place here and on the iPad's sidebar, and a row of
/// Settings too (Steve: desktop has it in Settings alone).
@MainActor
final class PhoneDrawer: NSObject {
    let home: AgentHomeViewController
    private let context: AppContext
    private let id: String
    private weak var navigation: UINavigationController?
    private let container = UIView()
    private let dim = UIView()
    private let panel = UIView()
    let list = SidebarList()
    let foot = SidebarList()
    private let switcher: AccountSwitcher
    private lazy var edge = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(swiped(_:)))
    private lazy var pan = UIPanGestureRecognizer(target: self, action: #selector(swiped(_:)))
    /// 0 shut, 1 open.
    private(set) var progress: CGFloat = 0
    private var swipeStart: CGFloat = 0
    private var layout: DrawerLayout?
    /// The row whose screen is the root: Home's, or a place's.
    private(set) var shownId = Drawer.homeId
    private weak var shownRoot: UIViewController?

    /// Where a stack keeps its drawer: it goes with the stack.
    private static var key: UInt8 = 0

    /// The drawer serving `navigation`, if any.
    static func of(_ navigation: UINavigationController) -> PhoneDrawer? {
        objc_getAssociatedObject(navigation, &key) as? PhoneDrawer
    }

    private static func keep(_ drawer: PhoneDrawer?, on navigation: UINavigationController) {
        objc_setAssociatedObject(navigation, &key, drawer, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    }

    /// `home`'s drawer on its stack: the one there if it is home's, else a
    /// new one in the place of any other.
    @discardableResult
    static func attach(home: AgentHomeViewController, context: AppContext, id: String, to navigation: UINavigationController) -> PhoneDrawer {
        if let drawer = of(navigation), drawer.home === home { return drawer }
        of(navigation)?.detach()
        let drawer = PhoneDrawer(home: home, context: context, id: id, navigation: navigation)
        keep(drawer, on: navigation)
        return drawer
    }

    /// The stack's root is now `root`: a drawer that serves neither it nor
    /// its home goes.
    static func follow(_ navigation: UINavigationController, root: UIViewController?) {
        guard let drawer = of(navigation), let root, root !== drawer.home, root !== drawer.shownRoot else { return }
        drawer.detach()
        keep(nil, on: navigation)
    }

    /// The home the stack serves: its root, or the one behind a place the
    /// drawer put there.
    static func home(of navigation: UINavigationController) -> AgentHomeViewController? {
        if let home = navigation.viewControllers.first as? AgentHomeViewController { return home }
        guard let drawer = of(navigation), navigation.viewControllers.first === drawer.shownRoot else { return nil }
        return drawer.home
    }

    private init(home: AgentHomeViewController, context: AppContext, id: String, navigation: UINavigationController) {
        self.home = home
        self.context = context
        self.id = id
        self.navigation = navigation
        switcher = AccountSwitcher(context: context, controller: navigation)
        super.init()
        container.isHidden = true
        container.accessibilityViewIsModal = true
        container.accessibilityIdentifier = "drawer"
        container.frame = navigation.view.bounds
        container.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        dim.backgroundColor = .black
        dim.alpha = 0
        dim.isAccessibilityElement = true
        dim.accessibilityLabel = Strings.Drawer.close
        dim.accessibilityTraits = .button
        dim.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(dimTapped)))
        container.addSubview(dim)
        panel.backgroundColor = UIColor(Palette.groupedGround)
        panel.layer.cornerRadius = DrawerLayout.Metrics.radius
        panel.layer.cornerCurve = .continuous
        panel.layer.maskedCorners = navigation.view.effectiveUserInterfaceLayoutDirection == .rightToLeft
            ? [.layerMinXMinYCorner, .layerMinXMaxYCorner] : [.layerMaxXMinYCorner, .layerMaxXMaxYCorner]
        panel.clipsToBounds = true
        container.addSubview(panel)
        let images = Session.session(for: id, context: context)?.images
        list.images = images
        list.accessibilityIdentifier = "drawer-list"
        list.onSelect = { [weak self] row in self?.select(row) }
        foot.images = images
        foot.accessibilityIdentifier = "drawer-foot"
        foot.onSelect = { [weak self] row in self?.select(row) }
        foot.panGestureRecognizer?.isEnabled = false
        panel.addSubview(list)
        panel.addSubview(foot)
        panel.addSubview(switcher.view)
        foot.apply([Drawer.settingsRow(label: Strings.Drawer.settings)])
        navigation.view.addSubview(container)
        edge.edges = navigation.view.effectiveUserInterfaceLayoutDirection == .rightToLeft ? .right : .left
        edge.delegate = self
        navigation.view.addGestureRecognizer(edge)
        pan.delegate = self
        container.addGestureRecognizer(pan)
        home.onRows = { [weak self] rows in self?.show(rows) }
        show(home.rows)
        list.selectedRowId = shownId
    }

    private func detach() {
        container.removeFromSuperview()
        edge.view?.removeGestureRecognizer(edge)
        home.onRows = nil
    }

    private var rightToLeft: Bool { navigation?.view.effectiveUserInterfaceLayoutDirection == .rightToLeft }

    private func show(_ rows: [Row]) {
        list.apply(Drawer.items(rows, home: Drawer.homeRow(label: Strings.Drawer.home)))
    }

    /// A place's root wears this where a pushed screen has back.
    func menuItem() -> UIBarButtonItem {
        let item = UIBarButtonItem(image: UIImage(systemName: "line.3.horizontal"), primaryAction: UIAction { [weak self] _ in self?.open() })
        item.accessibilityLabel = Strings.Drawer.open
        item.accessibilityIdentifier = "drawer-menu"
        return item
    }

    // MARK: Opening and closing

    /// Over a root only, with nothing presented and nothing moving.
    var canOpen: Bool {
        guard let navigation, navigation.viewControllers.count == 1, navigation.presentedViewController == nil,
              navigation.transitionCoordinator == nil, let root = navigation.viewControllers.first else { return false }
        if root === home { return !home.isSearching }
        return root === shownRoot
    }

    func open(animated: Bool = true) {
        guard canOpen else { return }
        prepare()
        settle(open: true, animated: animated, velocity: 0)
    }

    func close(animated: Bool = true) {
        guard !container.isHidden else { return }
        settle(open: false, animated: animated, velocity: 0)
    }

    /// Shown and laid out for the screen as it is now, still shut. Over
    /// the window, so iOS 26's floating toolbar, drawn above the stack's
    /// own views, stays under it too.
    private func prepare() {
        guard let navigation, container.isHidden else { return }
        let host: UIView = navigation.view.window ?? navigation.view
        if container.superview !== host { host.addSubview(container) }
        container.frame = host.bounds
        host.bringSubviewToFront(container)
        container.isHidden = false
        layOut()
        list.selectedRowId = shownId
        set(progress: progress)
    }

    private func layOut() {
        guard let host = container.superview else { return }
        let bounds = container.bounds
        let safe = LayoutInsets(host.safeAreaInsets)
        let width = DrawerLayout.width(for: bounds.width)
        switcher.maximumWidth = max(0, width - 2 * DrawerLayout.Metrics.side)
        let header = switcher.view.sizeThatFits(.zero)
        let layout = DrawerLayout(size: bounds.size, safeArea: safe, header: header, footerHeight: DrawerLayout.footerHeight(width: width), rightToLeft: rightToLeft)
        self.layout = layout
        dim.frame = bounds
        // The panel's own coordinates: everything in it moves with it.
        panel.transform = .identity
        panel.frame = layout.panel
        let origin = layout.panel.origin
        switcher.view.frame = layout.header.offsetBy(dx: -origin.x, dy: -origin.y)
        list.frame = layout.list.offsetBy(dx: -origin.x, dy: -origin.y)
        foot.frame = layout.footer.offsetBy(dx: -origin.x, dy: -origin.y)
        list.setInsets(.zero, indicator: .zero, keepsTop: true)
        foot.setInsets(.zero, indicator: .zero, keepsTop: true)
    }

    private func set(progress: CGFloat) {
        self.progress = progress
        let width = layout?.panel.width ?? 0
        panel.transform = CGAffineTransform(translationX: DrawerLayout.offset(progress: progress, width: width, rightToLeft: rightToLeft), y: 0)
        dim.alpha = progress * DrawerLayout.Metrics.dim
    }

    private func settle(open: Bool, animated: Bool, velocity: CGFloat) {
        let target: CGFloat = open ? 1 : 0
        let done = { [weak self] (_: Bool) in
            guard let self, progress == target else { return }
            if !open { container.isHidden = true }
            UIAccessibility.post(notification: .screenChanged, argument: open ? switcher.view : nil)
        }
        guard animated, !UIAccessibility.isReduceMotionEnabled else {
            set(progress: target)
            return done(true)
        }
        let width = max(1, layout?.panel.width ?? 1)
        let distance = abs(target - progress) * width
        let spring = distance > 0 ? min(30, abs(velocity) / distance) : 0
        UIView.animate(withDuration: DrawerLayout.Metrics.duration, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: spring,
                       options: [.allowUserInteraction, .beginFromCurrentState]) {
            self.set(progress: target)
        } completion: { finished in done(finished) }
    }

    @objc private func dimTapped() { close() }

    /// A swipe in from the edge opens it, one across the open panel shuts
    /// it; either follows the finger and settles where it is let go.
    @objc private func swiped(_ gesture: UIPanGestureRecognizer) {
        guard let view = navigation?.view else { return }
        let width = layout?.panel.width ?? DrawerLayout.width(for: view.bounds.width)
        let translation = gesture.translation(in: view).x
        switch gesture.state {
        case .began:
            prepare()
            swipeStart = progress
        case .changed:
            set(progress: DrawerLayout.progress(from: swipeStart, translation: translation, width: width, rightToLeft: rightToLeft))
        case .ended:
            let velocity = gesture.velocity(in: view).x
            settle(open: DrawerLayout.settlesOpen(progress: progress, velocity: velocity, rightToLeft: rightToLeft), animated: true, velocity: velocity)
        case .cancelled, .failed:
            settle(open: swipeStart > 0.5, animated: true, velocity: 0)
        default:
            break
        }
    }

    // MARK: Picking

    func select(_ row: Row) {
        guard let navigation else { return }
        switch row.id {
        case Drawer.settingsId:
            close()
            navigation.pushViewController(SettingsViewController(context: context, computer: id), animated: true)
        case Drawer.homeId:
            show(home, rowId: row.id)
        case shownId:
            close()
        default:
            guard let screen = home.place(row) else { return }
            screen.navigationItem.leftBarButtonItem = menuItem()
            show(screen, rowId: row.id)
        }
    }

    /// `root` in the stack's place, without a push, as the drawer closes over it.
    private func show(_ root: UIViewController, rowId: String) {
        guard let navigation else { return }
        // A stack set while it moves is dropped: after the move, then.
        if let transition = navigation.transitionCoordinator {
            transition.animate(alongsideTransition: nil) { [weak self] _ in self?.show(root, rowId: rowId) }
            return
        }
        shownId = rowId
        shownRoot = root === home ? nil : root
        list.selectedRowId = rowId
        if navigation.viewControllers != [root] {
            UIView.performWithoutAnimation {
                if let shell = navigation.parent as? ShellViewController {
                    shell.setStack([root], animated: false)
                } else {
                    navigation.setViewControllers([root], animated: false)
                }
                navigation.view.layoutIfNeeded()
            }
            container.superview?.bringSubviewToFront(container)
        }
        close()
    }

    /// Home made the root again from elsewhere (a link, the call's
    /// `navigate`), so the drawer says Home.
    func showHome() {
        show(home, rowId: Drawer.homeId)
    }
}

extension PhoneDrawer: UIGestureRecognizerDelegate {
    func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        if gesture === edge { return container.isHidden && canOpen }
        guard gesture === pan, !container.isHidden, let view = navigation?.view else { return false }
        // Only a swipe toward the closed side; the list scrolls up and down.
        let velocity = pan.velocity(in: view)
        let closing = rightToLeft ? velocity.x > 0 : velocity.x < 0
        return closing && abs(velocity.x) > abs(velocity.y)
    }
}
#endif
