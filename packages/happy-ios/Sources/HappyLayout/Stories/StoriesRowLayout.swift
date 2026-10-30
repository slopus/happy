import Foundation

/// The stories row above the V2 sidebar, measured as Telegram's
/// chat list draws its expanded stories row (`StoryPeerListComponent`,
/// `StoryPeerListItemComponent`): 60 × 77 items 14 apart, a 52 avatar 4 in
/// from the item's top, its ring on a 30.66 radius (2.33 wide unseen, 1.33
/// seen), and the name in 11 pt 2 under the ring.
public struct StoriesRowLayout: Equatable, Sendable {
    public enum Metrics {
        public static let height: CGFloat = 98
        public static let top: CGFloat = 12
        public static let leading: CGFloat = 12
        public static let item = CGSize(width: 60, height: 77)
        public static let spacing: CGFloat = 14
        public static let avatar: CGFloat = 52
        public static let avatarTop: CGFloat = 4
        public static let ringRadius: CGFloat = 30.66
        public static let ringUnseenWidth: CGFloat = 2.33
        public static let ringSeenWidth: CGFloat = 1.33
        /// The gap between ring segments, along the ring.
        public static let segmentGap: CGFloat = 4
        public static let titleSize: CGFloat = 11
        public static let titleGap: CGFloat = 2
        public static let titleOverhang: CGFloat = 10
        /// The ring's indicator square (Telegram's avatar inset by 8).
        public static let indicator: CGFloat = 68
        /// Telegram widens the spacing so the edge never shows a sliver of a ring.
        public static let ringOutset: CGFloat = 0.66
        public static let maximumSliver: CGFloat = 4
    }

    /// One item, in the item's own space.
    public struct Item: Equatable, Sendable {
        public var avatar: CGRect
        /// The ring's square: the avatar grown to the ring's outer radius.
        public var ring: CGRect
        /// The title's line, centred 2 under the ring's 68 pt square, at
        /// most 10 wider than the item.
        public func title(width: CGFloat, height: CGFloat) -> CGRect {
            let w = min(Metrics.item.width + Metrics.titleOverhang, ceil(width))
            return CGRect(x: floor((Metrics.item.width - w) / 2), y: avatar.midY + Metrics.indicator / 2 + Metrics.titleGap, width: w, height: ceil(height))
        }
    }

    public var size: CGSize
    public var contentSize: CGSize
    public var spacing: CGFloat
    /// Each item's frame in the row's content.
    public var items: [CGRect]

    public static let item: Item = {
        typealias M = Metrics
        let avatar = CGRect(x: floor((M.item.width - M.avatar) / 2), y: M.avatarTop, width: M.avatar, height: M.avatar)
        let ring = avatar.insetBy(dx: -(M.ringRadius - M.avatar / 2), dy: -(M.ringRadius - M.avatar / 2))
        return Item(avatar: avatar, ring: ring)
    }()

    public init(width: CGFloat, count: Int) {
        typealias M = Metrics
        size = CGSize(width: width, height: M.height)
        spacing = Self.spacing(containerWidth: width, count: count)
        let pitch = M.item.width + spacing
        items = (0..<count).map { CGRect(x: M.leading + CGFloat($0) * pitch, y: M.top, width: M.item.width, height: M.item.height) }
        let contentWidth = count == 0 ? width : M.leading * 2 + CGFloat(count) * M.item.width + CGFloat(count - 1) * spacing
        contentSize = CGSize(width: max(width, contentWidth), height: M.height)
    }

    /// Telegram's `StoryPeerListRowLayout.itemSpacing`: when the row
    /// overflows and the edge would show only a sliver of a ring, the
    /// spacing grows until the avatar before it is cut at its centre.
    static func spacing(containerWidth: CGFloat, count: Int) -> CGFloat {
        typealias M = Metrics
        let base = M.spacing
        let total = M.leading * 2 + CGFloat(count) * M.item.width + CGFloat(max(0, count - 1)) * base
        guard total > containerWidth else { return base }
        let pitch = M.item.width + base
        var cut = 0
        while M.leading + CGFloat(cut) * pitch + M.item.width <= containerWidth { cut += 1 }
        if cut < 2 || cut >= count { return base }
        let visible = containerWidth - (M.leading + CGFloat(cut) * pitch)
        let peek = visible + M.ringOutset
        if peek <= 0 || peek >= M.maximumSliver { return base }
        return base + floor((visible + pitch - M.item.width * 0.5) / CGFloat(cut - 1))
    }

    /// Ring segments as angle ranges, clockwise from the top: one per
    /// story with a 4 pt gap between, or the whole circle for one.
    public static func segments(count: Int, radius: CGFloat = Metrics.ringRadius) -> [(start: CGFloat, end: CGFloat)] {
        guard count > 1 else { return [(-.pi / 2, 3 * .pi / 2)] }
        let n = min(count, 30)
        let gap = Metrics.segmentGap / radius
        let arc = (2 * .pi - gap * CGFloat(n)) / CGFloat(n)
        return (0..<n).map { i in
            let start = gap / 2 - .pi / 2 + CGFloat(i) * (gap + arc)
            return (start, start + arc)
        }
    }
}
