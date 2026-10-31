import CoreGraphics
import Foundation

/// An image, image series or video artifact on its own screen. One item
/// shows large, fitted inside the safe area less the padding, never past
/// its own size, centred. Several stand under a line that counts them, in
/// the conversation's media flow (`MediaLayout`, justified rows) across
/// the width; a recording's duration sits in a pill at its tile's bottom
/// left. Frames are in the screen's coordinates; the grid scrolls.
public struct ArtifactMediaLayout: Equatable, Sendable {
    public enum Metrics {
        public static let padding: CGFloat = 16
        public static let countGap: CGFloat = 12
        public static let badgeInset: CGFloat = 6
        public static let badgeHeight: CGFloat = 20
        public static let badgePadding: CGFloat = 6
    }

    /// The count line; nil for a single item.
    public var count: CGRect?
    /// One frame per item, in the items' order.
    public var tiles: [CGRect]
    /// The duration pill over each item that has one.
    public var badges: [CGRect?]
    public var contentSize: CGSize

    /// `count` is the count line's size, `badges` each pill's text width
    /// (nil: none).
    public init(size: CGSize, safeArea: LayoutInsets, items: [MediaLayout.Item], count: CGSize?, badges: [CGFloat?]) {
        typealias M = Metrics
        let area = CGRect(
            x: safeArea.left + M.padding, y: safeArea.top + M.padding,
            width: max(0, size.width - safeArea.horizontal - 2 * M.padding),
            height: max(0, size.height - safeArea.top - safeArea.bottom - 2 * M.padding)
        )
        if items.count == 1 {
            self.count = nil
            tiles = [Self.fitted(items[0], in: area)]
            contentSize = size
        } else {
            var top = area.minY
            if let count {
                let frame = CGRect(x: area.minX, y: top, width: min(count.width, area.width), height: count.height)
                self.count = frame
                top = frame.maxY + M.countGap
            } else {
                self.count = nil
            }
            let flow = MediaLayout(width: area.width, items: items, columns: 0)
            tiles = flow.frames.map { $0.offsetBy(dx: area.minX, dy: top) }
            contentSize = CGSize(width: size.width, height: top + flow.size.height + M.padding + safeArea.bottom)
        }
        let tiles = tiles
        self.badges = tiles.indices.map { index in
            guard index < badges.count, let text = badges[index] else { return nil }
            let tile = tiles[index]
            let width = min(text + 2 * M.badgePadding, max(0, tile.width - 2 * M.badgeInset))
            return CGRect(x: tile.minX + M.badgeInset, y: tile.maxY - M.badgeInset - M.badgeHeight, width: width, height: M.badgeHeight)
        }
    }

    /// The screen's spinner while the artifact loads: 20 square in the
    /// middle of the safe area.
    public static func spinner(size: CGSize, safeArea: LayoutInsets) -> CGRect {
        let side: CGFloat = 20
        let x = safeArea.left + (size.width - safeArea.horizontal - side) / 2
        let y = safeArea.top + (size.height - safeArea.top - safeArea.bottom - side) / 2
        return CGRect(x: x.rounded(), y: y.rounded(), width: side, height: side)
    }

    /// The item as large as `area` lets it be in its own shape, never past
    /// its size in points; a shape not known yet is 4:3, a recording's 16:9.
    static func fitted(_ item: MediaLayout.Item, in area: CGRect) -> CGRect {
        let natural: CGSize
        if let point = MediaFlow.pointSize(item.image) {
            natural = point
        } else {
            let ratio = item.isVideo && item.image.hashedRatio == nil ? 16.0 / 9 : MediaFlow.ratio(item.image)
            natural = CGSize(width: area.width, height: area.width / ratio)
        }
        guard natural.width > 0, natural.height > 0, area.width > 0, area.height > 0 else { return CGRect(x: area.midX, y: area.midY, width: 0, height: 0) }
        let scale = min(1, area.width / natural.width, area.height / natural.height)
        let fitted = CGSize(width: (natural.width * scale).rounded(), height: (natural.height * scale).rounded())
        return CGRect(x: (area.midX - fitted.width / 2).rounded(), y: (area.midY - fitted.height / 2).rounded(), width: fitted.width, height: fitted.height)
    }
}
