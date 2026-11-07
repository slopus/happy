import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The card lists' sizes (`CardRowLayout`): the agent home's inset grouped
/// cards (`GroupedSidebarMetrics`), for the screens home opens.
public enum CardListMetrics {
    public static let side: CGFloat = GroupedSidebarMetrics.side
    public static let radius: CGFloat = GroupedSidebarMetrics.radius
    /// The tile's, a checkbox's and the text's start without either,
    /// from the card's left; the trailing text's end from its right.
    public static let inset: CGFloat = GroupedSidebarMetrics.markInset
    public static let headingHeight: CGFloat = GroupedSidebarMetrics.headingHeight
    public static let headingLine: CGFloat = GroupedSidebarMetrics.headingLine
    public static let headingBottom: CGFloat = GroupedSidebarMetrics.headingBottom
    public static let headingSize: CGFloat = GroupedSidebarMetrics.headingSize
    /// From a card down to the next heading.
    public static let headingGap: CGFloat = GroupedSidebarMetrics.headingGap
    public static let contentTop: CGFloat = GroupedSidebarMetrics.contentTop
    public static let contentBottom: CGFloat = GroupedSidebarMetrics.contentBottom
    /// A thumbnail's or a glyph tile's square.
    public static let tile: CGFloat = 40
    public static let tileRadius: CGFloat = GroupedSidebarMetrics.tileRadius
    public static let tileGlyph: CGFloat = 20
    public static let tileGap: CGFloat = 12
    /// Above the first line and below the last.
    public static let padding: CGFloat = 10
    /// Between the title and the subtitle.
    public static let lineGap: CGFloat = 2
    /// Between the title and what trails it.
    public static let trailingGap: CGFloat = 8
    /// A row with a tile is never shorter than the tile and its padding;
    /// a plain row than iOS's 44.
    public static let tiledRow: CGFloat = 60
    public static let plainRow: CGFloat = 44
    /// A row's title, and the quieter line under it and the time beside it.
    public static let titleSize: CGFloat = 16
    public static let subtitleSize: CGFloat = 13
    /// A note in place of the rows.
    public static let noteSize: CGFloat = 15
    /// A state scene over a note in place of the rows: the square desktop
    /// gives an empty state's scene in a panel (happy-desktop
    /// `EmptyState.tsx` `sceneSize.panel`, as `MainPanelPlaceholderLayout`),
    /// and its gap down to the words.
    public static let noteScene: CGFloat = 128
    public static let noteSceneGap: CGFloat = 16
}
