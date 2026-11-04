import Foundation

/// Desktop's story-reply quote above the person's bubble, as an attached
/// photo would be: the story's first frame at 9:16, the size one photo of
/// that shape is, and under it who posted it, on the bubble's side.
public struct StoryQuoteLayout: Equatable, Sendable {
    public enum Metrics {
        /// The shape alone, as a thumbhash gives it: no stated size caps it.
        public static let shape = MediaFlow.Image(hashedRatio: 9.0 / 16.0)
        public static let authorGap: CGFloat = 6
        /// An agent's rounded tile; a person's is a circle.
        public static let agentRadius: CGFloat = 6
        public static let bubbleGap: CGFloat = 8
    }

    public var frame: CGRect
    public var author: AuthorRowLayout

    /// Its top at `top`, against `edge` (its end there with `alignEnd`), in
    /// a message's measure no wider than `width`.
    public init(width: CGFloat, edge: CGFloat, alignEnd: Bool, top: CGFloat, name: Measurable) {
        typealias M = Metrics
        let measure = min(width, MediaFlow.messageMaxWidth)
        let media = MediaLayout(width: measure, items: [.init(isVideo: false, image: M.shape)], columns: 0, limits: MediaFlow.message, alignEnd: alignEnd)
        frame = (media.frames.first ?? .zero).offsetBy(dx: alignEnd ? edge - measure : edge, dy: top)
        author = AuthorRowLayout(edge: edge, alignEnd: alignEnd, top: frame.maxY + M.authorGap, room: measure, name: name)
    }
}

/// A 20 avatar and a name beside it on one line, from `edge` (or ending
/// there, `alignEnd`): who posted a story, and who sent another person's
/// message.
public struct AuthorRowLayout: Equatable, Sendable {
    public static let avatar: CGFloat = 20
    public static let gap: CGFloat = 6
    /// Between another person's name and what they sent.
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
