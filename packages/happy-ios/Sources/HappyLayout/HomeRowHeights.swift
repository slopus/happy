import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Home list rows whose height never depends on their text: a flat session
/// row at the designed text size, a project card, a worktree row, a bot
/// or archived chat row and the gap between two cards are one fixed height
/// at any width. The list takes these numbers instead of measuring a cell,
/// so a changed row costs no text measurement on the main thread. Each
/// comes from its own layout, fed empty content; `HomeRowHeightTests`
/// checks that real content gives the same height. A flat session at
/// another text size is its lines' height (`HomeRowKind.flatSession`).
public enum HomeRowHeights {
    private static var empty: Measurable { .fixed(.zero) }

    /// With a card's avatar (`HomeCardLayout.Metrics.sessionAvatar`).
    public static func flatSession(width: CGFloat) -> CGFloat {
        FlatSessionRowLayout(.init(
            width: width, title: empty, timestamp: empty, project: empty, workspace: nil, showsDivider: false,
            avatarSize: HomeCardLayout.Metrics.sessionAvatar
        )).size.height
    }

    /// A section's or a day's place between two cards: only the gap.
    public static let gap = HomeCardLayout.Metrics.gap

    public static func projectCard(width: CGFloat) -> CGFloat {
        ProjectCardLayout(.init(
            width: width, hairline: 0, name: empty, showsDot: false, changes: nil, showsAdd: false, showsTree: false
        )).size.height
    }

    public static func worktree(width: CGFloat) -> CGFloat {
        WorktreeRowLayout(.init(width: width, hairline: 0, label: empty, showsDot: false, changes: nil, last: false)).size.height
    }

    public static func projectChat(width: CGFloat) -> CGFloat {
        ProjectChatRowLayout(width: width, name: empty, corner: empty).size.height
    }
}
