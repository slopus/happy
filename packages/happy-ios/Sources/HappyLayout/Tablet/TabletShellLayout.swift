import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// When the window gets the tablet shell: SidebarNavigator.tsx
/// `isDesktopLayout`, with firstRunOnboarding.ts `shouldSuppressTabletShell`
/// on native iOS (never web, never Mac).
public enum TabletShellRule {
    /// `shouldSuppressTabletShell`: the first-run screens own the whole
    /// canvas, so the sidebar and its header stay out of them, including
    /// the moment between a computer arriving and the onboarding route
    /// closing.
    public static func suppressesShell(isAuthenticated: Bool, isTablet: Bool, showsInstallStep: Bool, isOnboardingRoute: Bool) -> Bool {
        isAuthenticated && isTablet && (showsInstallStep || isOnboardingRoute)
    }

    /// `isDesktopLayout`: signed in, a tablet-wide window, and not on the
    /// first-run screens.
    public static func showsShell(isAuthenticated: Bool, isTablet: Bool, showsInstallStep: Bool, isOnboardingRoute: Bool) -> Bool {
        isAuthenticated && isTablet && !suppressesShell(
            isAuthenticated: isAuthenticated,
            isTablet: isTablet,
            showsInstallStep: showsInstallStep,
            isOnboardingRoute: isOnboardingRoute
        )
    }
}

/// The window with the tablet shell (SidebarNavigator.tsx): a permanent
/// drawer holding the sidebar, the navigation stack beside it, and the
/// persistent header floating over both.
///
///     |16|(zen)|4|(‹)            …
///     +-----------+---------------------------
///     |  sidebar  |  detail stack
///     | 30% of the|
///     | window,   |
///     | 250…360   |
///
///   - The sidebar is 30% of the window, floored, then held between 250 and
///     360. Zen mode collapses it to nothing, without animating, as native
///     React Native snaps the drawer's width.
///   - The header row is the navigation header's height under the status
///     bar. Its two 28pt controls sit 16 from the shell's left edge, 4
///     apart, centred in the row; they stay put in zen mode, over the
///     stack.
///   - Without the shell the stack takes the whole window.
///
/// `app/_layout.tsx` wraps the navigator in the window's left and right
/// safe-area insets (`HorizontalSafeAreaWrapper`). The shell keeps that;
/// an iPad has none.
public struct TabletShellLayout: Equatable, Sendable {
    public enum Metrics {
        public static let sidebarFraction: CGFloat = 0.3
        public static let sidebarMinWidth: CGFloat = 250
        public static let sidebarMaxWidth: CGFloat = 360
        /// PersistentHeader's `paddingLeft`.
        public static let headerPaddingLeft: CGFloat = 16
        public static let controlSize: CGFloat = 28
        public static let controlGap: CGFloat = 4
        /// zen-icon.png's 18pt box inside the zen control.
        public static let zenIconSize: CGFloat = 18
        /// The back chevron's Ionicons size.
        public static let backIconSize: CGFloat = 20
        /// Both controls' `hitSlop`.
        public static let hitSlop: CGFloat = 10
        /// The back control's opacity while there is nothing to go back to.
        public static let disabledOpacity: CGFloat = 0.3
    }

    public struct Input: Equatable, Sendable {
        /// The window (`useLayoutDimensions`).
        public var size: CGSize
        public var safeArea: LayoutInsets
        /// `TabletShellRule.showsShell`.
        public var showsShell: Bool
        /// `localSettings.zenMode`.
        public var zenMode: Bool
        /// `DeviceCalculations.headerHeight`.
        public var headerHeight: CGFloat

        public init(size: CGSize, safeArea: LayoutInsets, showsShell: Bool, zenMode: Bool, headerHeight: CGFloat) {
            self.size = size
            self.safeArea = safeArea
            self.showsShell = showsShell
            self.zenMode = zenMode
            self.headerHeight = headerHeight
        }
    }

    /// The drawer; nil without the shell and in zen mode.
    public var sidebar: CGRect?
    /// The navigation stack.
    public var detail: CGRect
    /// The persistent header's box; nil without the shell.
    public var header: CGRect?
    public var zenButton: CGRect?
    public var zenIcon: CGRect?
    public var backButton: CGRect?

    /// `fullDrawerWidth` on a tablet-wide window.
    public static func sidebarWidth(windowWidth: CGFloat) -> CGFloat {
        min(max((windowWidth * Metrics.sidebarFraction).rounded(.down), Metrics.sidebarMinWidth), Metrics.sidebarMaxWidth)
    }

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.size.width)
        let height = max(0, input.size.height)
        guard input.showsShell else {
            sidebar = nil
            detail = CGRect(x: 0, y: 0, width: width, height: height)
            header = nil
            zenButton = nil
            zenIcon = nil
            backButton = nil
            return
        }
        let left = input.safeArea.left
        let inner = max(0, width - input.safeArea.horizontal)
        let drawer = input.zenMode ? 0 : min(inner, Self.sidebarWidth(windowWidth: width))
        sidebar = drawer > 0 ? CGRect(x: left, y: 0, width: drawer, height: height) : nil
        detail = CGRect(x: left + drawer, y: 0, width: inner - drawer, height: height)

        let top = input.safeArea.top
        header = CGRect(x: left, y: 0, width: inner, height: top + input.headerHeight)
        let controlY = top + (input.headerHeight - M.controlSize) / 2
        let zen = CGRect(x: left + M.headerPaddingLeft, y: controlY, width: M.controlSize, height: M.controlSize)
        zenButton = zen
        let iconInset = (M.controlSize - M.zenIconSize) / 2
        zenIcon = CGRect(x: zen.minX + iconInset, y: zen.minY + iconInset, width: M.zenIconSize, height: M.zenIconSize)
        backButton = CGRect(x: zen.maxX + M.controlGap, y: controlY, width: M.controlSize, height: M.controlSize)
    }
}
