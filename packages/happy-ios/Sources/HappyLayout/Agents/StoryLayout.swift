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
        public static let chip: CGFloat = 34
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

    public static func replies(size: CGSize, bar: CGRect, measured: CGFloat, pull: CGFloat) -> (panel: CGRect, text: CGRect, header: CGRect, grabber: CGRect, expanded: CGFloat) {
        let width = size.width - 24, expanded = min(stage(in: size).height * 0.6, max(44, measured + 52), max(44, bar.minY - 100))
        let height = 44 + (expanded - 44) * min(1, max(0, pull))
        return (CGRect(x: 12, y: bar.minY - height - 8, width: width, height: height),
                CGRect(x: 12, y: 44, width: width - 24, height: max(0, height - 52)), CGRect(x: 12, y: 10, width: width - 24, height: 30),
                CGRect(x: (width - 36) / 2, y: 5, width: 36, height: 4), expanded)
    }

    /// Layer centers use the full media frame, as the wire contract specifies.
    public static func stage(in size: CGSize) -> CGRect {
        let width = max(size.width, size.height * 9 / 16), height = max(size.height, size.width * 16 / 9)
        return CGRect(x: (size.width - width) / 2, y: (size.height - height) / 2, width: width, height: height)
    }
    public static func textWidth(in size: CGSize) -> CGFloat { min(size.width, stage(in: size).width) * 0.85 }
    public static func textFrame(size: CGSize, center: CGPoint, measured: CGSize) -> CGRect {
        let frame = layer(size: size, center: center, measured: CGSize(width: min(textWidth(in: size), max(40, measured.width + 20)), height: max(40, measured.height + 12)))
        let stage = stage(in: size).intersection(CGRect(origin: .zero, size: size))
        return CGRect(x: min(stage.maxX - frame.width - 12, max(stage.minX + 12, frame.minX)), y: min(stage.maxY - frame.height - 12, max(stage.minY + 12, frame.minY)), width: frame.width, height: frame.height)
    }
    public static func attribution(in frame: CGRect) -> (mark: CGRect, name: CGRect) {
        (CGRect(x: frame.minX + 6, y: frame.minY + 5, width: 24, height: 24), CGRect(x: frame.minX + 38, y: frame.minY, width: max(0, frame.width - 48), height: frame.height))
    }
    public static func layer(size: CGSize, center: CGPoint, measured: CGSize) -> CGRect {
        let stage = stage(in: size)
        return CGRect(x: stage.minX + center.x * stage.width - measured.width / 2, y: stage.minY + center.y * stage.height - measured.height / 2, width: measured.width, height: measured.height)
    }
    public static func normalized(_ center: CGPoint, in size: CGSize) -> CGPoint {
        let stage = stage(in: size)
        return CGPoint(x: min(1, max(0, (center.x - stage.minX) / max(1, stage.width))), y: min(1, max(0, (center.y - stage.minY) / max(1, stage.height))))
    }

    public struct Viewer: Equatable, Sendable {
        public var media: CGRect
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
        return Viewer(media: stage(in: size), segments: segments, mark: mark, name: name, mute: mute, more: more, close: close, chip: chip, round: roundFrame,
                      caption: caption, replies: replies, bar: bar, topShade: CGRect(x: 0, y: 0, width: size.width, height: mark.maxY + 40), bottomShade: bottomShade)
    }

    public struct Composer {
        public var media, cancel, post, round, record, text, addText, camera, remove, caption, placeholder: CGRect
    }
    public static func composer(size: CGSize, safeArea: LayoutInsets, text: CGPoint, round: CGPoint, keyboard: CGFloat, measuredText: CGSize, captionHeight: CGFloat = 44) -> Composer {
        let top = safeArea.top + Metrics.inset, bottom = size.height - max(safeArea.bottom, keyboard) - 12
        let post = CGRect(x: size.width - 56, y: bottom - 44, width: 44, height: 44), camera = post.offsetBy(dx: -48, dy: 0), addText = camera.offsetBy(dx: -48, dy: 0)
        let circle = layer(size: size, center: round, measured: CGSize(width: Metrics.round, height: Metrics.round))
        var text = textFrame(size: size, center: text, measured: measuredText)
        if keyboard > 0 { text.origin.y = min(text.minY, post.minY - text.height - 12) }
        let caption = CGRect(x: 12, y: bottom - min(84, max(44, captionHeight)), width: max(0, addText.minX - 20), height: min(84, max(44, captionHeight)))
        return Composer(media: stage(in: size), cancel: CGRect(x: 12, y: top, width: 44, height: 44), post: post, round: circle,
                        record: CGRect(x: (size.width - 44) / 2, y: post.minY, width: 44, height: 44), text: text, addText: addText, camera: camera,
                        remove: CGRect(x: circle.maxX - 30, y: circle.minY - 8, width: 36, height: 36), caption: caption, placeholder: caption.insetBy(dx: 13, dy: 0))
    }

    public struct Tile: Equatable, Sendable {
        public var ring: CGRect
        public var mark: CGRect
        public var name: CGRect
        public var add: CGRect { CGRect(x: mark.maxX - 18, y: mark.maxY - 18, width: 22, height: 22) }
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
