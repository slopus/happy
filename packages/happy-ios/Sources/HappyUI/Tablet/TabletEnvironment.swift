#if canImport(UIKit)
import HappyLayout
import UIKit

/// The screen is the iPad's sidebar (`ShellViewController`): home leaves
/// its ground clear, so the system's sidebar material shows through.
public struct SidebarColumnTrait: UITraitDefinition {
    public static let defaultValue = false
    public static let name = "HappySidebarColumn"
}

extension UITraitCollection {
    public var isSidebarColumn: Bool { self[SidebarColumnTrait.self] }
}

extension UIMutableTraits {
    public var isSidebarColumn: Bool {
        get { self[SidebarColumnTrait.self] }
        set { self[SidebarColumnTrait.self] = newValue }
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
        if let chat = controller as? LegacyChatViewController { return .session(id: chat.sessionId) }
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
    /// The branches of happy-app's layout this screen's window gets
    /// (`TabletBranches`): the screen's orientation and the device's header
    /// height. Never happy-app's tablet: the iPad's main panel keeps the
    /// phone's screens (docs/IPAD.md).
    var tabletBranches: TabletBranches {
        let size = view.window?.bounds.size ?? view.bounds.size
        return TabletBranches(
            isTablet: false,
            isLandscape: TabletBreakpoint.isLandscape(size),
            headerHeight: DeviceCalculations.headerHeight(isPad: traitCollection.userInterfaceIdiom == .pad)
        )
    }
}

/// How wide content may grow (`ContentWidthLimit`): 800 on an iPad,
/// unlimited on a phone.
@MainActor
public enum ContentWidth {
    /// `layout.maxWidth`: messages, the composer, item groups, settings.
    public static var maxWidth: CGFloat { ContentWidthLimit.maxWidth(isPad: isPad) }
    /// `layout.headerMaxWidth`: header rows.
    public static var headerMaxWidth: CGFloat { maxWidth }

    private static let isPad = UIDevice.current.userInterfaceIdiom == .pad
}

extension UIScrollView {
    /// Holds a scrolling page to the readable column (`ContentWidth`),
    /// centred: the page lays itself out at the width this returns, and the
    /// margins either side are the scroll view's insets, so the page is
    /// still the window's to scroll. The whole width on a phone.
    func readableColumn(width: CGFloat) -> CGFloat {
        let column = ChatColumn(rowWidth: width, maxContentWidth: ContentWidth.maxWidth)
        if contentInset.left != column.x || contentInset.right != column.x {
            contentInset.left = column.x
            contentInset.right = column.x
        }
        let x = -adjustedContentInset.left
        if contentOffset.x != x { contentOffset.x = x }
        return column.width
    }
}
#endif
