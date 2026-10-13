import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// Tablet: SidebarNavigator.tsx's persistent header, SidebarView.tsx and
// EmptySessionsTablet.tsx (iOS values). The colours they use are the
// shared ones: groupped.background, divider, surface, surfacePressed,
// surfaceSelected, header.tint, textLink, textSecondary and
// button.primary.

extension TextStyles {
    /// SidebarView.tsx `newSessionText`: 14, weight 500, semiBold.
    public static let sidebarNewSession = TextStyle(.semiBold, size: 14)
    /// SidebarView.tsx `settingsText`: 14, weight 500 over the regular
    /// face. React Native resolves weight 500 within IBM Plex Sans to the
    /// nearest face the app bundles, SemiBold (see `homeHeaderStatus`).
    public static let sidebarSettings = TextStyle(.semiBold, size: 14)
    /// EmptySessionsTablet.tsx `titleText`: 20, regular.
    public static let tabletEmptyTitle = TextStyle(.regular, size: 20)
    /// EmptySessionsTablet.tsx `descriptionText`: 16, regular.
    public static let tabletEmptyDescription = TextStyle(.regular, size: 16)
    /// EmptySessionsTablet.tsx `buttonText`: 16, weight 600, semiBold.
    public static let tabletEmptyButton = TextStyle(.semiBold, size: 16)
}
