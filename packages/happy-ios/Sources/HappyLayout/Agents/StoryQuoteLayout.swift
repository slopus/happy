import Foundation

/// Desktop's story-reply quote, a card of its own right above the person's
/// bubble: the story's first frame at 9:16, and beside it, centred, "Story",
/// the author's avatar and name, and the caption, each on one line.
public struct StoryQuoteLayout: Equatable, Sendable {
    public enum Metrics {
        public static let frame = CGSize(width: 36, height: 64)
        public static let frameRadius: CGFloat = 6
        public static let radius: CGFloat = 10
        public static let padding: CGFloat = 6
        public static let gap: CGFloat = 8
        public static let rowGap: CGFloat = 2
        public static let avatar: CGFloat = 16
        public static let avatarGap: CGFloat = 6
        public static let maxWidth: CGFloat = 280
        public static let bubbleGap: CGFloat = 4
    }

    public var card, frame, label, avatar, name: CGRect
    public var caption: CGRect?

    /// Its top at `top`, its end at `trailing`, no wider than `width`; the
    /// lines measure as wide as they are unwrapped, and a longer one is cut.
    public init(width: CGFloat, trailing: CGFloat, top: CGFloat, label: Measurable, name: Measurable, caption: Measurable?) {
        typealias M = Metrics
        let room = max(0, min(width, M.maxWidth) - 2 * M.padding - M.frame.width - M.gap)
        let label = label.size(fitting: room)
        let name = name.size(fitting: max(0, room - M.avatar - M.avatarGap))
        let caption = caption?.size(fitting: room)
        let row = max(M.avatar, name.height)
        let stack = label.height + M.rowGap + row + (caption.map { M.rowGap + $0.height } ?? 0)
        let column = max(label.width, M.avatar + M.avatarGap + name.width, caption?.width ?? 0)
        let size = CGSize(width: 2 * M.padding + M.frame.width + M.gap + column, height: 2 * M.padding + max(M.frame.height, stack))
        card = CGRect(origin: CGPoint(x: trailing - size.width, y: top), size: size)
        frame = CGRect(origin: CGPoint(x: card.minX + M.padding, y: card.midY - M.frame.height / 2), size: M.frame)
        let x = frame.maxX + M.gap
        let rowTop = card.midY - stack / 2 + label.height + M.rowGap
        self.label = CGRect(origin: CGPoint(x: x, y: card.midY - stack / 2), size: label)
        avatar = CGRect(x: x, y: rowTop + (row - M.avatar) / 2, width: M.avatar, height: M.avatar)
        self.name = CGRect(x: avatar.maxX + M.avatarGap, y: rowTop + (row - name.height) / 2, width: name.width, height: name.height)
        self.caption = caption.map { CGRect(origin: CGPoint(x: x, y: rowTop + row + M.rowGap), size: $0) }
    }
}
