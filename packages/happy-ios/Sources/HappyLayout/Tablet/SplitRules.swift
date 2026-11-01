import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// When an iPad window is wide enough for the sidebar beside the main
/// panel (docs/IPAD.md). Below it the window is a phone: one stack, home
/// at its root.
///
/// The system's own answer is the horizontal size class, but a regular
/// window can still be too thin: a 13-inch iPad's half of the screen in
/// landscape is regular at 683, and an iPad mini is regular at 744 in
/// portrait. A sidebar (about 320) beside a 363 main panel is narrower
/// than any iPhone. So the window also has to be 768 wide: what is left
/// beside the sidebar is then at least an iPhone Pro Max's 440.
public enum SplitRule {
    /// The narrowest window that gets the sidebar.
    public static let minWidth: CGFloat = 768

    /// Sidebar and main panel side by side: a regular window at least
    /// `minWidth` wide, showing an account's home. Onboarding, sign-in and
    /// the server confirmation own the whole window, as on a phone. Width
    /// alone, never height, so the keyboard never collapses it.
    public static func showsSplit(width: CGFloat, isRegularWidth: Bool, showsHome: Bool) -> Bool {
        showsHome && isRegularWidth && width >= minWidth
    }

    /// The sidebar's width: 30% of the window, as happy-app's sidebar, held
    /// between 340 and 360. 340 is the least that keeps the account's pill
    /// whole beside its two buttons while it says "Connecting…"; the
    /// system's own 320 cut it.
    public static func sidebarWidth(windowWidth: CGFloat) -> CGFloat {
        min(360, max(340, (windowWidth * 0.3).rounded()))
    }
}

/// The main panel inside its column. iOS 26's sidebar floats over the
/// secondary column, which runs under it with the sidebar as its leading
/// safe area. The screens ported from the phone lay out from their bounds,
/// so the main panel's stack is held to the column's horizontal safe area:
/// every screen gets a rectangle as a phone does, its bar and title
/// centred over what is visible.
public struct MainPanelLayout: Equatable, Sendable {
    public var panel: CGRect

    public init(size: CGSize, safeArea: LayoutInsets) {
        let left = max(0, safeArea.left)
        let right = max(0, safeArea.right)
        panel = CGRect(x: left, y: 0, width: max(0, size.width - left - right), height: size.height)
    }
}

/// How the window's navigation is rewritten between the phone's one stack
/// and the split's two columns. The same screens move; none is made again
/// or dropped, so a chat keeps its draft and its place.
///
///     phone:    [home, chat, profile]
///     split:    sidebar [home]   main [chat, profile]
///
/// The main panel with nothing open shows its placeholder, which never
/// goes onto the phone's stack.
public enum SplitStack {
    /// The phone's stack from the two columns: home, then what the main
    /// panel shows.
    public static func collapsed<Screen: AnyObject>(sidebar: [Screen], main: [Screen], placeholder: Screen) -> [Screen] {
        sidebar + main.filter { $0 !== placeholder }
    }

    /// The two columns from the phone's stack: its root in the sidebar,
    /// the rest in the main panel, or the placeholder when there is no rest.
    public static func expanded<Screen: AnyObject>(_ stack: [Screen], placeholder: Screen) -> (sidebar: [Screen], main: [Screen]) {
        let rest = stack.dropFirst().filter { $0 !== placeholder }
        return (Array(stack.prefix(1)), rest.isEmpty ? [placeholder] : Array(rest))
    }

    /// What opening `key` from the sidebar does to a main panel whose
    /// root is `current`: the same thing again goes back to its root,
    /// anything else becomes the new root. A nil key is never the same.
    public enum Opening: Equatable, Sendable {
        case backToRoot
        case replace
    }

    public static func opening<Key: Equatable>(_ key: Key?, current: Key?) -> Opening {
        if let key, key == current { return .backToRoot }
        return .replace
    }
}
