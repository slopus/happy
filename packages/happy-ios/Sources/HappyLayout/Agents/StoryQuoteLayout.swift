import Foundation

/// Instagram's story reply, above the person's bubble on its side: the
/// story's first frame the size one 9:16 photo of a message is, a thin bar
/// beside it at the row's outer edge.
public struct StoryQuoteLayout: Equatable, Sendable {
    public enum Metrics {
        /// The shape alone, as a thumbhash gives it: no stated size caps it.
        public static let shape = MediaFlow.Image(hashedRatio: 9.0 / 16.0)
        public static let bar: CGFloat = 3
        public static let barGap: CGFloat = 8
        public static let bubbleGap: CGFloat = 4
    }

    public var frame: CGRect
    public var bar: CGRect

    /// Its top at `top`, its bar against `edge` (its end there with
    /// `alignEnd`), in a message's measure no wider than `width`.
    public init(width: CGFloat, edge: CGFloat, alignEnd: Bool, top: CGFloat) {
        typealias M = Metrics
        let inset = M.bar + M.barGap
        let measure = max(0, min(width, MediaFlow.messageMaxWidth) - inset)
        let media = MediaLayout(width: measure, items: [.init(isVideo: false, image: M.shape)], columns: 0, limits: MediaFlow.message, alignEnd: alignEnd)
        frame = (media.frames.first ?? .zero).offsetBy(dx: alignEnd ? edge - inset - measure : edge + inset, dy: top)
        bar = CGRect(x: alignEnd ? edge - M.bar : edge, y: frame.minY, width: M.bar, height: frame.height)
    }
}

/// A 16 avatar and a line beside it, from `edge` (or ending there,
/// `alignEnd`): who wrote a person's message, and what they replied to.
public struct AuthorRowLayout: Equatable, Sendable {
    public static let avatar: CGFloat = 16
    public static let gap: CGFloat = 6
    /// Between the line and what comes under it.
    public static let below: CGFloat = 4

    public var avatar, name: CGRect
    public var maxY: CGFloat

    public init(edge: CGFloat, alignEnd: Bool, top: CGFloat, room: CGFloat, name: Measurable) {
        let size = name.size(fitting: max(0, room - Self.avatar - Self.gap))
        let row = max(Self.avatar, size.height)
        let x = alignEnd ? edge - Self.avatar - Self.gap - size.width : edge
        avatar = CGRect(x: x, y: top + (row - Self.avatar) / 2, width: Self.avatar, height: Self.avatar)
        self.name = CGRect(x: avatar.maxX + Self.gap, y: top + (row - size.height) / 2, width: size.width, height: size.height)
        maxY = top + row
    }
}
