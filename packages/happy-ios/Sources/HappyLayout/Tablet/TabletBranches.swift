import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The tablet branches inside screens other workstreams own: every
/// `useIsTablet()` / `useHeaderHeight()` decision in happy-app's native iOS
/// code paths, as values the owning screen reads. Built from the window
/// (`TabletLayoutTrait` in HappyUI carries `isTablet`) and the device's
/// header height; each answer names the line it ports.
///
/// Web, Mac Catalyst and Android branches are left out, as is anything
/// gated by `experiments` (SessionView.tsx's file viewer) or voice.
public struct TabletBranches: Equatable, Sendable {
    /// `useIsTablet()`: the window is at least 768 wide.
    public var isTablet: Bool
    /// `useIsLandscape()`.
    public var isLandscape: Bool
    /// `useHeaderHeight()`: 50 on an iPad, 44 on an iPhone.
    public var headerHeight: CGFloat

    public enum Metrics {
        /// MOBILE_GLASS_HEADER_HEIGHT: the phone's glass header row.
        public static let glassHeaderHeight: CGFloat = 52
        /// SessionView.tsx `sessionInputHorizontalPadding`.
        public static let tabletInputPaddingH: CGFloat = 12
        public static let phoneInputPaddingH: CGFloat = 8
        /// ChatList.tsx `OlderEnd`: past the header when no inset is given.
        public static let olderEndExtra: CGFloat = 32
    }

    public init(isTablet: Bool, isLandscape: Bool, headerHeight: CGFloat) {
        self.isTablet = isTablet
        self.isLandscape = isLandscape
        self.headerHeight = headerHeight
    }

    // MARK: Chat header (ChatHeaderView.tsx)

    /// :59 `showBackButton`: the persistent header's back serves a tablet.
    public var chatShowsBackButton: Bool { !isTablet }

    /// :61 `glassEnabled`. Without glass the header is an opaque bar
    /// (`header.background`), the title and subtitle sit at its start
    /// (`titleContainer`, `alignItems: 'flex-start'`) rather than in a
    /// centred capsule, the subtitle is `textSecondary`, and there is no
    /// scrim.
    public var chatHeaderGlass: Bool { !isTablet }

    /// :62 `contentHeight`: the glass row is at least 52.
    public var chatHeaderContentHeight: CGFloat {
        chatHeaderGlass ? max(headerHeight, Metrics.glassHeaderHeight) : headerHeight
    }

    // MARK: Session screen (-session/SessionView.tsx)

    /// :426 `headerRight`: the avatar that opens session info. Tablets
    /// reach info through the title.
    public var chatShowsAvatar: Bool { !isTablet }

    /// :449 `MobileGlassBackdrop`.
    public var chatGlassBackdrop: Bool { !isTablet }

    /// :131 `hidesLandscapeHeader`: an iPhone on its side drops the header
    /// for a floating back button (:1327) and a status-bar shadow; an iPad
    /// window that is a phone layout does too, a tablet never.
    public var chatHidesHeaderInLandscape: Bool { isLandscape && !isTablet }

    /// :1327 the floating back button that stands in for the header.
    public var chatShowsLandscapeBackButton: Bool { chatHidesHeaderInLandscape }

    /// :132 `contentRunsUnderHeader`. When false the content starts under
    /// the header: `safeArea.top + headerHeight + tabStrip` (:478).
    public var chatContentRunsUnderHeader: Bool { !isTablet && !isLandscape }

    /// The content's top padding when it does not run under the header and
    /// the header shows (:474-478, voice left out).
    public func chatContentTop(safeTop: CGFloat, tabStrip: CGFloat) -> CGFloat {
        if chatHidesHeaderInLandscape || chatContentRunsUnderHeader { return 0 }
        let header = isTablet ? headerHeight : max(headerHeight, Metrics.glassHeaderHeight)
        return safeTop + header + tabStrip
    }

    /// :781 `usesFloatingMobileDock`: only the portrait phone floats the
    /// composer over the list; a tablet stacks the list above it and pads
    /// the bottom by the safe area (:1301).
    public var chatFloatingDock: Bool { !isTablet && !isLandscape }

    /// :833 `sessionInputHorizontalPadding`.
    public var chatInputPaddingH: CGFloat {
        isTablet ? Metrics.tabletInputPaddingH : Metrics.phoneInputPaddingH
    }

    /// :834 `chatListTopContentInset`, as the list's oldest-end spacer.
    /// A tablet passes none, so ChatList.tsx's `OlderEnd` falls back to
    /// `headerHeight + safeArea.top + 32` (:224), on top of the content
    /// already starting under the header.
    public func chatOldestEndSpacer(safeTop: CGFloat, headerAccessory: CGFloat) -> CGFloat {
        if isLandscape && !isTablet { return 12 }
        if !isTablet { return safeTop + Metrics.glassHeaderHeight + headerAccessory + 12 }
        return headerHeight + safeTop + Metrics.olderEndExtra
    }

    /// :1272 the CLI-outdated pill, hidden only on a landscape phone.
    public var chatShowsCliWarning: Bool { !(isLandscape && !isTablet) }

    // MARK: Tools (tools/PermissionFooter.tsx)

    /// :308 `alignItems`: a tablet hugs each button to its label and pushes
    /// it to the trailing edge; a phone stretches them
    /// (`PermissionFooterLayout.tablet`).
    public var permissionButtonsTrailing: Bool { isTablet }

    // MARK: Worktree tabs (WorktreeTabStrip.tsx)

    /// :95 `glassEnabled`: the strip's chips are glass on a phone only.
    public var worktreeStripGlass: Bool { !isTablet }

    // MARK: Navigation header (navigation/Header.tsx)

    /// :80 `isNativePhone`: glass controls, a scrim, the 52pt row and a
    /// centred title (`mobileTitleAlignment`) are phone-only. A tablet's
    /// title follows the route's `headerTitleAlign`, which on iOS defaults
    /// to centre (:323).
    public var headerGlassControls: Bool { !isTablet }

    /// :322 `shouldHideBackButton`: the custom headers (`createPlainHeader`:
    /// settings, session info, machine, message) drop their back button on
    /// a tablet, except on the onboarding routes, which have no shell.
    /// Screens with UIKit's own header keep its back button.
    public func plainHeaderShowsBackButton(isOnboardingRoute: Bool) -> Bool {
        !isTablet || isOnboardingRoute
    }
}

extension PermissionFooterLayout {
    /// PermissionFooter.tsx on a tablet (:308, `alignItems: 'flex-end'`):
    /// each button as wide as its label and padding, never wider than the
    /// card, against the trailing edge; heights as on a phone.
    public static func tablet(width: CGFloat, labels input: [Measurable], maxListHeight: CGFloat = .greatestFiniteMagnitude) -> PermissionFooterLayout {
        typealias M = Metrics
        var layout = PermissionFooterLayout(width: width, labels: input, maxListHeight: maxListHeight)
        let right = max(0, width) - M.paddingH
        let inset = M.buttonPaddingH + M.buttonBorder
        for index in layout.buttons.indices {
            let label = layout.labels[index]
            let button = layout.buttons[index]
            let hugged = min(button.width, label.width + 2 * inset)
            layout.buttons[index] = CGRect(x: right - hugged, y: button.minY, width: hugged, height: button.height)
            layout.labels[index] = CGRect(x: right - hugged + (hugged - label.width) / 2, y: label.minY, width: label.width, height: label.height)
        }
        return layout
    }
}
