import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// New work's empty conversation, on both homes: what it will be, as one
/// block centred between the bar and the composer. The composer moves with
/// the keyboard, and the block, laid out against it, moves with it.
///
/// Happy Agent's asks Task or Bot over an optional name; a legacy account's
/// asks the computer (when it has more than one), folder and harness. Either is
/// an optional control over field-high rows and a line saying what it is.
///
///     bar ─────────────────────────
///               [ Task | Bot ]          kind, optional
///          |24| [ Name (optional) ] |24|   rows, at most 320 wide
///               what a task is          note, optional
///     composer ────────────────────
public struct NewWorkLayout: Equatable, Sendable {
    public enum Metrics {
        public static let side: CGFloat = 24
        public static let maxWidth: CGFloat = 320
        public static let kindWidth: CGFloat = 220
        public static let kindToRows: CGFloat = 16
        public static let rowHeight: CGFloat = 44
        public static let rowGap: CGFloat = 8
        public static let rowsToNote: CGFloat = 10
        /// The least room kept over and under the block; with less it
        /// doesn't show.
        public static let margin: CGFloat = 12
    }

    /// The block, in the screen.
    public var block: CGRect
    /// In the block.
    public var kind: CGRect?
    public var rows: [CGRect]
    public var note: CGRect?
    /// There is room for the block between the bar and the composer.
    public var fits: Bool

    /// `top` is the bar's foot and `bottom` the composer's top, in the
    /// screen; `kindHeight` is the control's, nil for none; `note` wraps,
    /// centred, at the block's width.
    public init(width: CGFloat, top: CGFloat, bottom: CGFloat, kindHeight: CGFloat?, rows count: Int, note: Measurable?) {
        typealias M = Metrics
        let blockWidth = max(0, min(M.maxWidth, width - 2 * M.side))
        var y: CGFloat = 0
        if let kindHeight {
            let kindWidth = min(M.kindWidth, blockWidth)
            kind = CGRect(x: (blockWidth - kindWidth) / 2, y: 0, width: kindWidth, height: kindHeight)
            y = kindHeight + M.kindToRows
        }
        var rows: [CGRect] = []
        for index in 0..<max(0, count) {
            if index > 0 { y += M.rowGap }
            rows.append(CGRect(x: 0, y: y, width: blockWidth, height: M.rowHeight))
            y += M.rowHeight
        }
        self.rows = rows
        if let note {
            y += M.rowsToNote
            let height = note.size(fitting: blockWidth).height
            self.note = CGRect(x: 0, y: y, width: blockWidth, height: height)
            y += height
        }
        let room = bottom - top
        fits = room >= y + 2 * M.margin
        let origin = fits ? top + (room - y) / 2 : top + M.margin
        block = CGRect(x: (width - blockWidth) / 2, y: origin, width: blockWidth, height: y)
    }
}
