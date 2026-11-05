import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The Feed's rows (`FeedRowLayout`): the card lists' rows, with desktop's
/// feed row on them (`HappyAgentFeedRow`): the subject's avatar, the
/// title with a short time and the unread dot, and under them up to three
/// overlapping faces of who changed it before what they did.
public enum FeedMetrics {
    /// The subject's avatar: a card row's tile.
    public static let avatar: CGFloat = CardListMetrics.tile
    /// A row is never shorter than desktop's 64.
    public static let minHeight: CGFloat = 64
    /// Between the title's line and the faces' line.
    public static let lineGap: CGFloat = 4
    /// One actor's face, and how much of the face before it it covers.
    public static let face: CGFloat = 18
    public static let faceOverlap: CGFloat = 6
    /// The card-coloured ring that parts overlapping faces.
    public static let faceRing: CGFloat = 1.5
    /// At most this many faces; the rest are "+N".
    public static let maxFaces = 3
    /// From the faces to "+N", and from either to the words.
    public static let moreGap: CGFloat = 4
    public static let summaryGap: CGFloat = 6
    /// The unread dot, in a lane every row keeps, so reading an entry
    /// recolours it and moves nothing.
    public static let dot: CGFloat = 8
    public static let dotGap: CGFloat = 6
    /// The title, set heavier while unread, and the quieter line and time.
    public static let titleSize: CGFloat = CardListMetrics.titleSize
    public static let summarySize: CGFloat = CardListMetrics.subtitleSize

    /// An artifact's post under its row: its summary, cut at this many
    /// lines until it is opened in full, then its cover across the card,
    /// `postGap` apart, with `postBottom` under the last as at its sides.
    /// On an iPad the two are never wider than desktop's feed column.
    public static let captionLines = 4
    public static let captionSize: CGFloat = 15
    public static let postMaxWidth: CGFloat = 640
    /// The summary's Show more or Show less takes a tap this tall at
    /// least, and this much either side of its words.
    public static let toggleTarget: CGFloat = 44
    public static let toggleSlop: CGFloat = 8
    public static let postGap: CGFloat = 8
    public static let postBottom: CGFloat = CardListMetrics.inset
    /// The cover's corners, the card's own inset by its margin, so the
    /// two curves run parallel.
    public static let coverRadius: CGFloat = CardListMetrics.radius - CardListMetrics.inset

    /// A place's avatar in Following, and its row.
    public static let clusterAvatar: CGFloat = 32
    public static let clusterRow: CGFloat = 52
}
