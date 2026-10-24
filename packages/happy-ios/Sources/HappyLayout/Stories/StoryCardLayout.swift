import Foundation

/// A story drawn inline in a conversation (happy-agent `API.md` "The inline
/// draft"): its first frame on the 9:16 canvas, at most 200 wide, rounded
/// as the viewer's, and a 32 tall bar under it with Post and Edit, or
/// "Draft", "Posted", or why it can't be shown. One size whatever its
/// state, so the conversation never moves when it changes.
public struct StoryCardLayout: Equatable, Sendable {
    public enum Metrics {
        public static let maxWidth: CGFloat = 200
        public static let cornerRadius: CGFloat = 12
        public static let barGap: CGFloat = 6
        public static let bar: CGFloat = 32
        public static let button = CGSize(width: 56, height: 32)
        public static let buttonGap: CGFloat = 4
    }

    public var size: CGSize
    public var canvas: CGRect
    public var bar: CGRect
    public var post: CGRect
    public var edit: CGRect
    /// "Draft", "Posted", or "This story was deleted": the bar's width.
    public var label: CGRect

    public init(width: CGFloat) {
        typealias M = Metrics
        let canvasWidth = min(M.maxWidth, max(0, width)).rounded(.down)
        canvas = CGRect(x: 0, y: 0, width: canvasWidth, height: (canvasWidth / StoryCanvasLayout.aspect).rounded(.down))
        bar = CGRect(x: 0, y: canvas.maxY + M.barGap, width: canvasWidth, height: M.bar)
        post = CGRect(origin: bar.origin, size: M.button)
        edit = post.offsetBy(dx: M.button.width + M.buttonGap, dy: 0)
        label = bar
        size = CGSize(width: canvasWidth, height: bar.maxY)
    }

    public static func size(width: CGFloat) -> CGSize { StoryCardLayout(width: width).size }
}
