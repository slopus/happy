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
        /// A story no longer there: its mark, middle of the canvas, the
        /// words 10 under it, 16 in from the sides; as Telegram marks an
        /// expired story, the mark beside the words, here above them.
        public static let notice: CGFloat = 36
        public static let noticeGap: CGFloat = 10
        public static let noticeInset: CGFloat = 16
        /// "Posted" follows a story ring as the row draws one, 14 across.
        public static let ring: CGFloat = 14
        public static let ringGap: CGFloat = 6
    }

    public var size: CGSize
    public var canvas: CGRect
    public var bar: CGRect
    public var post: CGRect
    public var edit: CGRect
    /// "Draft" or "Posted": the bar's width, after the ring when posted.
    public var label: CGRect
    public var ring: CGRect
    public var postedLabel: CGRect
    /// A story no longer there: its mark, and where its words start.
    public var notice: CGRect
    public var noticeText: CGRect

    public init(width: CGFloat) {
        typealias M = Metrics
        let canvasWidth = min(M.maxWidth, max(0, width)).rounded(.down)
        canvas = CGRect(x: 0, y: 0, width: canvasWidth, height: (canvasWidth / StoryCanvasLayout.aspect).rounded(.down))
        bar = CGRect(x: 0, y: canvas.maxY + M.barGap, width: canvasWidth, height: M.bar)
        post = CGRect(origin: bar.origin, size: M.button)
        edit = post.offsetBy(dx: M.button.width + M.buttonGap, dy: 0)
        label = bar
        ring = CGRect(x: 0, y: bar.midY - M.ring / 2, width: M.ring, height: M.ring)
        postedLabel = CGRect(x: ring.maxX + M.ringGap, y: bar.minY, width: max(0, canvasWidth - ring.maxX - M.ringGap), height: M.bar)
        notice = CGRect(x: ((canvasWidth - M.notice) / 2).rounded(.down), y: (canvas.midY - M.notice).rounded(.down), width: M.notice, height: M.notice)
        noticeText = CGRect(x: M.noticeInset, y: notice.maxY + M.noticeGap, width: max(0, canvasWidth - 2 * M.noticeInset), height: max(0, canvas.maxY - notice.maxY - M.noticeGap - M.noticeInset))
        size = CGSize(width: canvasWidth, height: bar.maxY)
    }

    public static func size(width: CGFloat) -> CGSize { StoryCardLayout(width: width).size }
}
