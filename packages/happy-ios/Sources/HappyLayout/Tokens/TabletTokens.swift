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

// The sidebar's list grouped by project: SessionsList.tsx, ProjectGroup.tsx
// and ActiveSessionsGroupCompact.tsx (iOS values). Headings reuse
// `sessionDayHeader` (SessionsList.tsx `headerText`).
extension TextStyles {
    /// SessionsList.tsx `machineHeaderText`: 11, regular, the font's own
    /// line.
    public static let tabletMachineName = TextStyle(.regular, size: 11)
    /// ProjectGroup.tsx `title`: 13 on 18, -0.08, regular.
    public static let tabletWorkspaceTitle = TextStyle(.regular, size: 13, lineHeight: 18, letterSpacing: -0.08)
    /// ProjectGroup.tsx `branchText`: 12 on 16, regular.
    public static let tabletWorkspaceBranch = TextStyle(.regular, size: 12, lineHeight: 16)
    /// ActiveSessionsGroupCompact.tsx `sessionTitle`: 15, regular, the
    /// font's own line, at most two lines.
    public static let tabletChatTitle = TextStyle(.regular, size: 15)
    /// SessionsList.tsx `sessionTitle`: 15, weight 500, semiBold.
    public static let tabletArchivedTitle = TextStyle(.semiBold, size: 15)
    /// SessionsList.tsx `sessionSubtitle`: 13, regular.
    public static let tabletArchivedSubtitle = TextStyle(.regular, size: 13)
    /// SessionsList.tsx `statusText`: 12 on 16, weight 500 over the regular
    /// face, which resolves to SemiBold (see `sidebarSettings`).
    public static let tabletArchivedStatus = TextStyle(.semiBold, size: 12, lineHeight: 16)
}

/// STATUS_CONFIG's colours, written as literals in SessionsList.tsx and
/// ActiveSessionsGroupCompact.tsx, so the same in both themes.
public enum TabletPalette {
    /// `disconnected`: #999.
    public static let statusOffline = ColorToken("#999999")
    /// `thinking`, and an unread turn: #007AFF.
    public static let statusWorking = ColorToken("#007AFF")
    /// `waiting`: #34C759.
    public static let statusOnline = ColorToken("#34C759")
    /// `permission_required`, `input_required`: #FF9500.
    public static let statusAttention = ColorToken("#FF9500")
}
