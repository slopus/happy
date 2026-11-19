import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// When a window is roomy enough for the sidebar beside the main panel
/// (docs/IPAD.md). Otherwise the window is a phone: one stack, home at its
/// root. The rule is the window's, on any device, never the idiom's: an
/// iPhone Duo open in landscape (951 × 669) splits, folded (466 × 678) or
/// open in portrait (669 × 951) it is the phone, and a fold mid-session
/// moves the same screens between the two.
///
/// The system's own answer is the size classes, and both have to be
/// regular. A compact height is a phone on its side: an iPhone Pro Max in
/// landscape is regular at 956 wide but 440 tall, where the sidebar's foot
/// covers its rows and the keyboard leaves the chat a sliver. And a
/// regular window can still be too thin: a 13-inch iPad's half of the
/// screen in landscape is regular at 683, an iPad mini is regular at 744
/// in portrait, and an iPhone Duo open in portrait is regular at 669. A
/// sidebar (340 at least) beside a 343, 404 or 329 main panel is narrower
/// than any iPhone. So the window also has to be 768 wide: what is left
/// beside the sidebar is then at least an iPhone Pro Max's 440.
public enum SplitRule {
    /// The narrowest window that gets the sidebar.
    public static let minWidth: CGFloat = 768

    /// Sidebar and main panel side by side: a window regular both ways and
    /// at least `minWidth` wide, showing an account's home. Onboarding,
    /// sign-in and the server confirmation own the whole window, as on a
    /// phone. The height counts only by its size class, which turning the
    /// device changes and the keyboard doesn't, so the keyboard never
    /// collapses it. Every iPad window is regular in height, so the iPad's
    /// rule is unchanged.
    public static func showsSplit(width: CGFloat, isRegularWidth: Bool, isRegularHeight: Bool = true, showsHome: Bool) -> Bool {
        showsHome && isRegularWidth && isRegularHeight && width >= minWidth
    }

    /// The sidebar's width: 30% of the window, as happy-app's sidebar, held
    /// between 340 and 360. 340 is the least that keeps the account's pill
    /// whole beside its two buttons while it says "Connecting…"; the
    /// system's own 320 cut it.
    public static func sidebarWidth(windowWidth: CGFloat) -> CGFloat {
        min(360, max(340, (windowWidth * 0.3).rounded()))
    }

    /// The sidebar's width on a display folded partway (iOS 27.1's
    /// division regions, `UIView.reservedRegions(kind: .division)`): its
    /// edge on the crease, as the system's own apps put it, so the sidebar
    /// is one half of the fold and the main panel the other. `divisions`
    /// are the active regions in the window, each a band round its crease;
    /// one that runs top to bottom is a crease the sidebar can meet. It
    /// does only where both halves keep the least sidebar's width (340);
    /// anywhere else, or with no crease, the width is the usual one. On
    /// the display's pixels (`scale`).
    public static func sidebarWidth(window: CGSize, divisions: [CGRect], sidebarOnLeft: Bool = true, scale: CGFloat = 1) -> CGFloat {
        let usual = sidebarWidth(windowWidth: window.width)
        guard let band = divisions.first(where: { $0.minY <= 0 && $0.maxY >= window.height && $0.width < window.width }) else { return usual }
        let pixels = max(1, scale)
        let crease = (band.midX * pixels).rounded() / pixels
        let width = sidebarOnLeft ? crease : window.width - crease
        guard width >= 340, window.width - width >= 340 else { return usual }
        return width
    }
}

/// The main panel inside its column. iOS 26's sidebar floats over the
/// secondary column, which runs under it with the sidebar as its leading
/// safe area. The screens ported from the phone lay out from their bounds,
/// so the main panel's stack is held clear of the sidebar's side of the
/// column's safe area: every screen gets a rectangle as a phone does, its
/// bar and title centred over what is visible.
///
/// The other side runs to the window's edge, and its safe area is the
/// screens' own to keep, as on a phone. On an iPhone Duo it is the status
/// bar's column (iOS 27.1's vertical bar), where the main panel's own
/// navigation puts its bar items as the phone's does; held short of it,
/// the panel grew a second, empty column beside the status bar's.
public struct MainPanelLayout: Equatable, Sendable {
    public var panel: CGRect

    /// - sidebarOnLeft: the sidebar is at the left, the leading edge in a
    ///   left-to-right language; at the right in a right-to-left one.
    public init(size: CGSize, safeArea: LayoutInsets, sidebarOnLeft: Bool = true) {
        let left = sidebarOnLeft ? max(0, safeArea.left) : 0
        let right = sidebarOnLeft ? 0 : max(0, safeArea.right)
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
