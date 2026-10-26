import Foundation

/// A message another agent sent this one, as desktop's
/// `AgentMessageActivity` sets it (`agent-activity-row.css`): one line in
/// the reading column, 6 above and below, 20 tall. A 14 glyph lane, then
/// 6 apart the sender (at most 45% of the line, giving way first), what
/// it said it is, and the chevron with them, not at the line's end. Opened,
/// the message sits 4 under the line, 16 in.
public struct StemCellAgentMessageLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingV: CGFloat = 6
        public static let lineHeight: CGFloat = 20
        public static let glyph: CGFloat = 14
        public static let gap: CGFloat = 6
        public static let chevron: CGFloat = 14
        public static let verbMaxFraction: CGFloat = 0.45
        /// Between the line and the message under it (`.happy-agent-activity` gap).
        public static let bodyGap: CGFloat = 4
        /// `.happy-agent-activity__body` padding-left.
        public static let bodyIndent: CGFloat = 16
        /// Between the message's paragraphs: the agent text's 8 at its 12/18.
        public static let bodyBlockGap: CGFloat = 6
    }

    public var size: CGSize
    /// The whole line, which opens and closes the message.
    public var header: CGRect
    public var glyph: CGRect
    public var verb: CGRect?
    public var text: CGRect
    public var chevron: CGRect?
    /// The message, when open.
    public var body: MarkdownLayout?
    public var bodyOrigin: CGPoint

    /// `verbWidth` and `textWidth` are the words' widths on one line; nil
    /// `verbWidth` draws no sender word. `body` is the open message's
    /// blocks; nil while closed. `opens` draws the chevron.
    public init(width: CGFloat, maxContentWidth: CGFloat = .greatestFiniteMagnitude, verbWidth: CGFloat?, textWidth: CGFloat, opens: Bool, body: [MarkdownLayout.Block]?) {
        typealias M = Metrics
        typealias Message = StemCellMessageLayout.Metrics
        let column = ChatColumn(rowWidth: width, maxContentWidth: maxContentWidth)
        let left = column.x + Message.marginH
        let right = column.x + column.width - Message.marginH
        let lineWidth = max(0, right - left)
        let top = M.paddingV
        header = CGRect(x: left, y: top, width: lineWidth, height: M.lineHeight)
        glyph = CGRect(x: left, y: top + (M.lineHeight - M.glyph) / 2, width: M.glyph, height: M.glyph)
        var x = glyph.maxX + M.gap
        // What follows the name keeps room for the chevron after it.
        let room = max(0, right - x - (opens ? M.gap + M.chevron : 0))
        if let verbWidth {
            let verbRect = CGRect(x: x, y: top, width: min(ceil(verbWidth), (lineWidth * M.verbMaxFraction).rounded(.down), room), height: M.lineHeight)
            verb = verbRect
            x = verbRect.maxX + M.gap
        }
        let textRoom = max(0, right - x - (opens ? M.gap + M.chevron : 0))
        text = CGRect(x: x, y: top, width: min(ceil(textWidth), textRoom), height: M.lineHeight)
        if opens {
            chevron = CGRect(x: text.maxX + M.gap, y: top + (M.lineHeight - M.chevron) / 2, width: M.chevron, height: M.chevron)
        }
        var bottom = header.maxY
        bodyOrigin = CGPoint(x: left + M.bodyIndent, y: bottom + M.bodyGap)
        if let body {
            let markdown = MarkdownLayout(width: max(0, lineWidth - M.bodyIndent), blocks: body, gap: M.bodyBlockGap)
            self.body = markdown
            bottom = bodyOrigin.y + markdown.size.height
        }
        size = CGSize(width: max(0, width), height: bottom + M.paddingV)
    }
}
