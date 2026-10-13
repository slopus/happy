#if canImport(UIKit)
import HappyLayout
import UIKit

/// `useIsTablet()` as a trait: the window is at least 768 wide
/// (`TabletBreakpoint`). The shell sets it on everything under it and
/// flips it live as Split View, Slide Over or Stage Manager resize the
/// window. A screen with a tablet branch reads `traitCollection.isTabletLayout`
/// and re-lays out on `registerForTraitChanges([TabletLayoutTrait.self])`.
///
/// It is the width rule alone, as happy-app's screens use it: true on the
/// first-run screens too, where the shell itself steps aside.
public struct TabletLayoutTrait: UITraitDefinition {
    public static let defaultValue = false
    public static let name = "HappyTabletLayout"
}

/// `localSettings.zenMode`, which the persistent header's zen control
/// toggles. Besides collapsing the sidebar it trims the composer
/// (AgentInput.tsx `zenMode`), so the composer can read it here.
public struct ZenModeTrait: UITraitDefinition {
    public static let defaultValue = false
    public static let name = "HappyZenMode"
}

extension UITraitCollection {
    public var isTabletLayout: Bool { self[TabletLayoutTrait.self] }
    public var isZenMode: Bool { self[ZenModeTrait.self] }
}

extension UIMutableTraits {
    public var isTabletLayout: Bool {
        get { self[TabletLayoutTrait.self] }
        set { self[TabletLayoutTrait.self] = newValue }
    }

    public var isZenMode: Bool {
        get { self[ZenModeTrait.self] }
        set { self[ZenModeTrait.self] = newValue }
    }
}

extension Route {
    /// The session a route belongs to: every `/session/<id>/…` path, which
    /// is what SessionsList.tsx reads its selected row from.
    var sessionId: String? {
        switch self {
        case .session(let id), .sessionInfo(let id), .sessionFiles(let id), .sessionChanges(let id):
            id
        case .sessionFile(let id, _), .sessionMessage(let id, _, _):
            id
        default:
            nil
        }
    }
}

/// Which route each pushed screen stands for, so the shell can tell the
/// sidebar which row to keep selected. `push(_:context:)` records it.
@MainActor
enum TabletRoutes {
    private final class Box {
        let route: Route
        init(_ route: Route) { self.route = route }
    }

    private static let routes = NSMapTable<UIViewController, Box>.weakToStrongObjects()

    static func record(_ route: Route, for controller: UIViewController) {
        routes.setObject(Box(route), forKey: controller)
    }

    /// The route a screen was pushed for. A chat opened without `push`
    /// (from a notification) is still known by its type.
    static func route(of controller: UIViewController) -> Route? {
        if let box = routes.object(forKey: controller) { return box.route }
        if let chat = controller as? ChatViewController { return .session(id: chat.sessionId) }
        return nil
    }

    /// The stack already shows this route on top. The sidebar doesn't push
    /// a second copy of the chat that is open, where happy-app's `router.push`
    /// does; AppCoordinator's notification path makes the same choice.
    static func isShowing(_ route: Route, in stack: UINavigationController) -> Bool {
        stack.topViewController.flatMap(self.route(of:)) == route
    }
}

extension UIViewController {
    /// The branches of happy-app's tablet layout this screen's window gets
    /// (`TabletBranches`): the shell's width rule, the screen's
    /// orientation, the device's header height.
    var tabletBranches: TabletBranches {
        let size = view.window?.bounds.size ?? view.bounds.size
        return TabletBranches(
            isTablet: traitCollection.isTabletLayout,
            isLandscape: TabletBreakpoint.isLandscape(size),
            headerHeight: DeviceCalculations.headerHeight(isPad: traitCollection.userInterfaceIdiom == .pad)
        )
    }

    /// navigation/Header.tsx :322. The screens with happy-app's plain header
    /// (settings, session info, machine, changes, message, What's New) and
    /// the chat (ChatHeaderView.tsx :59) have no back button on a tablet:
    /// the persistent header's back serves instead. Call once from
    /// `viewDidLoad`; it follows the window as it resizes.
    func dropsBackButtonOnTablet() {
        applyTabletBackButton()
        registerForTraitChanges([TabletLayoutTrait.self], action: #selector(applyTabletBackButton))
    }

    @objc private func applyTabletBackButton() {
        navigationItem.hidesBackButton = !tabletBranches.plainHeaderShowsBackButton(isOnboardingRoute: false)
    }

    /// The tablet shell's stack, for a screen beside it rather than in it
    /// (the sidebar and the list it hosts).
    var tabletDetailNavigation: UINavigationController? {
        var current: UIViewController? = self
        while let controller = current {
            if let shell = controller as? TabletShellViewController { return shell.detail }
            current = controller.parent
        }
        return nil
    }
}

/// components/layout.ts: how wide content may grow. happy-app works it out
/// once, when the module loads, from the screen and the window of that
/// moment; so does this, the first time it is read. Only a 13-inch iPad is
/// a tablet there (800); every other iPad and every iPhone is unlimited.
@MainActor
public enum ContentWidth {
    /// `layout.maxWidth`: messages, item groups, the session list.
    public static var maxWidth: CGFloat { limits.maxWidth }
    /// `layout.headerMaxWidth`: header rows.
    public static var headerMaxWidth: CGFloat { limits.headerMaxWidth }

    private static var cached: (maxWidth: CGFloat, headerMaxWidth: CGFloat)?

    private static var limits: (maxWidth: CGFloat, headerMaxWidth: CGFloat) {
        if let cached { return cached }
        // Before the scene connects there is nothing to measure yet: no
        // limit, and nothing kept.
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else {
            return (.greatestFiniteMagnitude, .greatestFiniteMagnitude)
        }
        let screen = scene.screen.bounds.size
        // The scene's own size, which is the window's even before one is key.
        let window = scene.coordinateSpace.bounds.size
        let type = DeviceCalculations.deviceType(screen: screen, isPad: UIDevice.current.userInterfaceIdiom == .pad)
        let limits = (
            maxWidth: ContentWidthLimit.maxWidth(deviceType: type, window: window),
            headerMaxWidth: ContentWidthLimit.headerMaxWidth(deviceType: type, window: window)
        )
        cached = limits
        return limits
    }
}
#endif
