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
        showsNote = note != nil
        let origin = fits ? top + (room - y) / 2 : top + M.margin
        block = CGRect(x: (width - blockWidth) / 2, y: origin, width: blockWidth, height: y)
    }

    /// Whether `note` is laid out: with little room it goes first.
    public var showsNote: Bool

    /// A legacy account's block, which gives way rather than go: what it
    /// asks (the kind, the computer, a bot's name) is what the first send
    /// makes, so with the keyboard up on a small phone the note goes, then
    /// the gaps close, and only when even that has no room (a phone held
    /// sideways) does it not fit. Nothing a row says (a computer offline, a
    /// name refused) adds to it: that is said inside the row.
    ///
    ///     bar ─────────────────────────
    ///               [ Session | Bot | Task ]
    ///               [ computer          ]
    ///               [ Name your bot     ]
    ///               what a bot is              note, dropped first
    ///     composer ────────────────────
    public init(width: CGFloat, top: CGFloat, bottom: CGFloat, kindHeight: CGFloat?, givingWay count: Int, note: Measurable?) {
        typealias M = Metrics
        let blockWidth = max(0, min(M.maxWidth, width - 2 * M.side))
        let room = bottom - top
        let noteHeight = note.map { ceil($0.size(fitting: blockWidth).height) }
        func stack(kindGap: CGFloat, rowGap: CGFloat, withNote: Bool) -> (kind: CGRect?, rows: [CGRect], note: CGRect?, height: CGFloat) {
            var y: CGFloat = 0
            var kind: CGRect?
            if let kindHeight {
                let kindWidth = min(M.kindWidth, blockWidth)
                kind = CGRect(x: (blockWidth - kindWidth) / 2, y: 0, width: kindWidth, height: kindHeight)
                y = kindHeight + kindGap
            }
            var frames: [CGRect] = []
            for index in 0..<max(0, count) {
                if index > 0 { y += rowGap }
                frames.append(CGRect(x: 0, y: y, width: blockWidth, height: M.rowHeight))
                y += M.rowHeight
            }
            var noteFrame: CGRect?
            if withNote, let noteHeight {
                y += M.rowsToNote
                noteFrame = CGRect(x: 0, y: y, width: blockWidth, height: noteHeight)
                y += noteHeight
            }
            return (kind, frames, noteFrame, y)
        }
        let attempts = [
            stack(kindGap: M.kindToRows, rowGap: M.rowGap, withNote: true),
            stack(kindGap: M.kindToRows, rowGap: M.rowGap, withNote: false),
            stack(kindGap: M.tightKindToRows, rowGap: M.tightRowGap, withNote: false),
        ]
        let chosen = attempts.first { room >= $0.height + 2 * M.margin } ?? attempts[attempts.count - 1]
        kind = chosen.kind
        self.rows = chosen.rows
        self.note = chosen.note
        showsNote = chosen.note != nil
        fits = room >= chosen.height + 2 * M.margin
        let origin = fits ? top + (room - chosen.height) / 2 : top + M.margin
        block = CGRect(x: (width - blockWidth) / 2, y: origin, width: blockWidth, height: chosen.height)
    }
}

extension NewWorkLayout.Metrics {
    /// The gaps once the room is short.
    public static let tightKindToRows: CGFloat = 8
    public static let tightRowGap: CGFloat = 6
}

/// The computer row's status: a label of one fixed frame pinned to the
/// row's top-right, inside its capsule, over a name set a fixed `titleDrop`
/// below the row's middle so the two never meet and the name keeps the
/// row's width, whether the label says "● Online", "● Offline · 2h ago"
/// or nothing. Nothing else in the row, or in the panel, depends on it, so
/// a status coming, going or changing moves nothing.
///
///     (                              ● Online )   label: top-right
///     ( [icon] MacBook-Pro-7.local            )   name: dropped, full width
public enum NewWorkStatusLayout {
    /// How far below the row's middle the name sits, always.
    public static let titleDrop: CGFloat = 6
    /// From the row's trailing edge; clear of the capsule's curve at `top`.
    public static let inset: CGFloat = 18
    public static let top: CGFloat = 5
    public static let width: CGFloat = 112
    public static let height: CGFloat = 14

    /// The label's frame in a row of `width`: the same for any text, which
    /// is right-aligned in it and cut to it.
    public static func label(rowWidth: CGFloat) -> CGRect {
        CGRect(x: rowWidth - inset - width, y: top, width: width, height: height)
    }
}
