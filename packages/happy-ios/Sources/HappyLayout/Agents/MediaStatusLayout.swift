import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Telegram's media status over a photo, video or file
/// (`ChatMessageInteractiveMediaNode`, `ChatMessageInteractiveMediaBadge`):
/// the ring's download arrow, and the badge in the tile's top-left corner
/// with a video's length over its size or how much of it is here
/// ("0:12" / "1.2 / 8.4 MB"). The ring itself is `UploadRingLayout`'s.
public enum MediaStatusLayout {
    /// From the tile's top-left corner to the badge.
    public static let badgeInset: CGFloat = 6
    public static let badgePaddingH: CGFloat = 6
    public static let badgePaddingV: CGFloat = 2
    /// The most its corners round, one line's pill.
    public static let badgeRadius: CGFloat = 9
    /// The badge's text size.
    public static let badgeFont: CGFloat = 12
    /// Where a tap on a video's badge pauses or resumes its download,
    /// sized for a finger whatever the badge says.
    public static let badgeHitSize = CGSize(width: 132, height: 44)

    public struct Badge: Equatable, Sendable {
        public var frame: CGRect
        /// Each line's frame, in the badge's own coordinates.
        public var lines: [CGRect]
        public var radius: CGFloat
    }

    /// The badge for lines measured at `lines`, top to bottom, in a tile of
    /// `tile`; its width never past the tile's less both insets.
    public static func badge(in tile: CGSize, lines: [CGSize]) -> Badge {
        let widest = lines.map(\.width).max() ?? 0
        let room = max(0, tile.width - 2 * badgeInset - 2 * badgePaddingH)
        let width = min(widest, room).rounded(.up)
        var y = badgePaddingV
        var frames: [CGRect] = []
        for line in lines {
            let height = line.height.rounded(.up)
            frames.append(CGRect(x: badgePaddingH, y: y, width: width, height: height))
            y += height
        }
        let height = y + badgePaddingV
        let frame = CGRect(x: badgeInset, y: badgeInset, width: width + 2 * badgePaddingH, height: height)
        return Badge(frame: frame, lines: frames, radius: min(badgeRadius, height / 2))
    }

    /// The tap area of a video's badge, in a tile at `tile`.
    public static func badgeHit(in tile: CGRect) -> CGRect {
        CGRect(x: tile.minX, y: tile.minY, width: min(tile.width, badgeHitSize.width), height: min(tile.height / 2, badgeHitSize.height))
    }

    /// The download arrow in a disc `side` across: its shaft, top to
    /// bottom, and its head, left wing, point, right wing.
    public static func arrow(side: CGFloat) -> (shaft: [CGPoint], head: [CGPoint]) {
        let factor = UploadRingLayout.factor(side)
        let center = side / 2
        let half = 9 * factor
        let wing = 7 * factor
        let point = CGPoint(x: center, y: center + half)
        return (
            [CGPoint(x: center, y: center - half), point],
            [CGPoint(x: center - wing, y: point.y - wing), point, CGPoint(x: center + wing, y: point.y - wing)]
        )
    }

    /// The play glyph's size in a disc `side` across: Telegram's is a
    /// little under half the disc.
    public static func playGlyph(side: CGFloat) -> CGFloat {
        (side * 0.44).rounded()
    }

    /// The radius of the spinner a video shows while its first range
    /// comes, in a disc `side` across: about the play glyph's size.
    public static func spinnerRadius(side: CGFloat) -> CGFloat {
        (side * 0.2).rounded()
    }
}
