import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Stories' frames: the outline around a row's icon, which never moves
/// or resizes the row, and the full-screen viewer.
public enum StoryLayout {
    public enum Metrics {
        /// The outline stands this far outside the icon, and is this thick.
        public static let ringGap: CGFloat = 2.5
        public static let ringWidth: CGFloat = 2
        /// A tap this close to the icon opens its story.
        public static let ringSlop: CGFloat = 8
        public static let segmentHeight: CGFloat = 2
        public static let segmentGap: CGFloat = 4
        public static let inset: CGFloat = 8
        public static let mark: CGFloat = 32
        public static let markRadius: CGFloat = 8
        public static let close: CGFloat = 44
        public static let captionInset: CGFloat = 16
        /// How long a picture shows before the next story.
        public static let imageDuration: Double = 5
        public static let chip: CGFloat = 26
        public static let round: CGFloat = 104
        public static let bar: CGFloat = 44
        /// The stories row: tiles this big, this far apart, and its height under home's bar.
        public static let tile: CGFloat = 60
        public static let tileGap: CGFloat = 12
        public static let tileTop: CGFloat = 4
        public static let rowInset: CGFloat = 16
        public static let rowHeight: CGFloat = 100
    }

    /// The outline's box around `mark` (its border drawn inside), a
    /// rounded square following the icon's corners.
    public static func ring(around mark: CGRect, markRadius: CGFloat) -> (frame: CGRect, radius: CGFloat) {
        let outset = Metrics.ringGap + Metrics.ringWidth
        return (mark.insetBy(dx: -outset, dy: -outset), markRadius + outset)
    }

    /// Where a tap opens the story rather than the chat: around the icon,
    /// stopping where the title (at `labelX`) starts.
    public static func ringTarget(around mark: CGRect, labelX: CGFloat) -> CGRect {
        let outset = Metrics.ringGap + Metrics.ringWidth + Metrics.ringSlop, target = mark.insetBy(dx: -outset, dy: -outset)
        return CGRect(x: target.minX, y: target.minY, width: max(0, min(target.maxX, labelX) - target.minX), height: target.height)
    }

    /// A tap at `x` in the viewer: back a story in its first third, on past it.
    public static func step(atX x: CGFloat, width: CGFloat) -> Int { x < width / 3 ? -1 : 1 }

    public struct Viewer: Equatable, Sendable {
        public var segments: [CGRect]
        public var mark: CGRect
        /// The poster's name and how long ago.
        public var name: CGRect
        public var mute: CGRect
        public var more: CGRect
        public var close: CGRect
        /// "Reposted from", and the reposter's round video, under the header.
        public var chip: CGRect
        public var round: CGRect
        public var caption: CGRect
        /// The last replies, over the media's foot: the media never moves for them.
        public var replies: CGRect
        public var bar: CGRect
        /// The soft shades the header and the foot sit on.
        public var topShade: CGRect
        public var bottomShade: CGRect
    }

    /// `nameHeight`, `captionHeight`, `repliesHeight` and `chipWidth` (0: no
    /// chip) are measured; a caption or the replies are at most
    /// `size.width - 2 × captionInset` wide. `keyboard`: how far the
    /// keyboard rises over the bottom edge.
    public static func viewer(size: CGSize, safeArea: LayoutInsets, count: Int, nameHeight: CGFloat, captionHeight: CGFloat,
                              repliesHeight: CGFloat = 0, chipWidth: CGFloat = 0, round: Bool = false, keyboard: CGFloat = 0) -> Viewer {
        typealias M = Metrics
        let top = safeArea.top + M.inset
        let lane = size.width - 2 * M.inset
        let n = CGFloat(max(count, 1))
        let segment = ((lane - (n - 1) * M.segmentGap) / n).rounded(.down)
        let segments = (0..<max(count, 1)).map { CGRect(x: M.inset + CGFloat($0) * (segment + M.segmentGap), y: top, width: segment, height: M.segmentHeight) }
        let mark = CGRect(x: M.inset + 4, y: top + M.segmentHeight + 10, width: M.mark, height: M.mark)
        let close = CGRect(x: size.width - M.inset - M.close, y: mark.midY - M.close / 2, width: M.close, height: M.close)
        let more = close.offsetBy(dx: -M.close, dy: 0), mute = more.offsetBy(dx: -M.close, dy: 0)
        let name = CGRect(x: mark.maxX + 10, y: (mark.midY - nameHeight / 2).rounded(), width: max(0, mute.minX - 4 - mark.maxX), height: nameHeight)
        let chip = CGRect(x: mark.minX, y: mark.maxY + 10, width: chipWidth, height: chipWidth > 0 ? M.chip : 0)
        let roundFrame = round ? CGRect(x: mark.minX, y: chip.maxY + 10, width: M.round, height: M.round) : .zero
        let bar = CGRect(x: M.inset + 4, y: size.height - max(safeArea.bottom, keyboard) - M.inset - M.bar, width: lane - 8, height: M.bar)
        let width = size.width - 2 * M.captionInset
        let replies = CGRect(x: M.captionInset, y: bar.minY - M.inset - repliesHeight, width: width, height: repliesHeight)
        let caption = CGRect(x: M.captionInset, y: replies.minY - (repliesHeight > 0 ? M.inset : 0) - captionHeight, width: width, height: captionHeight)
        let bottomShade = CGRect(x: 0, y: caption.minY - 60, width: size.width, height: size.height - caption.minY + 60)
        return Viewer(segments: segments, mark: mark, name: name, mute: mute, more: more, close: close, chip: chip, round: roundFrame,
                      caption: caption, replies: replies, bar: bar, topShade: CGRect(x: 0, y: 0, width: size.width, height: mark.maxY + 40), bottomShade: bottomShade)
    }

    /// Reposting: Cancel and Post across the top, the round video in the
    /// middle, Record under it, then the caption.
    public static func repost(size: CGSize, safeArea: LayoutInsets) -> (cancel: CGRect, post: CGRect, round: CGRect, record: CGRect, caption: CGRect) {
        let top = safeArea.top + Metrics.inset, side = min(size.width - 80, 280)
        let round = CGRect(x: ((size.width - side) / 2).rounded(), y: top + 80, width: side, height: side)
        let record = CGRect(x: ((size.width - 140) / 2).rounded(), y: round.maxY + 24, width: 140, height: Metrics.bar)
        return (CGRect(x: Metrics.inset, y: top, width: 88, height: Metrics.bar), CGRect(x: size.width - Metrics.inset - 88, y: top, width: 88, height: Metrics.bar),
                round, record, CGRect(x: 24, y: record.maxY + 24, width: size.width - 48, height: Metrics.bar))
    }

    public struct Tile: Equatable, Sendable {
        public var ring: CGRect
        public var mark: CGRect
        public var name: CGRect
    }

    /// The stories row's tiles, left to right, and how wide they run.
    public static func row(count: Int, nameHeight: CGFloat) -> (tiles: [Tile], width: CGFloat) {
        typealias M = Metrics
        let outset = M.ringGap + M.ringWidth, pitch = M.tile + 2 * outset + M.tileGap
        let tiles = (0..<count).map { index -> Tile in
            let ring = CGRect(x: M.rowInset + CGFloat(index) * pitch, y: M.tileTop, width: M.tile + 2 * outset, height: M.tile + 2 * outset)
            return Tile(ring: ring, mark: ring.insetBy(dx: outset, dy: outset), name: CGRect(x: ring.minX - 4, y: ring.maxY + 4, width: ring.width + 8, height: nameHeight))
        }
        return (tiles, (tiles.last?.ring.maxX ?? 0) + M.rowInset)
    }
}

extension Palette {
    /// A row's outline while one of its stories is unseen, and once all are.
    public static let storyUnseen = ColorToken("#007aff", "#0a84ff")
    public static let storySeen = ColorToken("#c7c7cc", "#48484a")
}
