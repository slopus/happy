import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// New work's empty conversation, on both homes: what it will be, as one
/// block centred between the bar and the composer. The composer moves with
/// the keyboard, and the block, laid out against it, moves with it. With
/// less room than it takes (the keyboard up, the composer grown) it stands
/// on the composer and runs up under the bar, picture and all: it never
/// shrinks or drops the picture.
///
/// Happy Agent's asks Task or Bot over an optional name; a legacy account's
/// asks the computer (when it has more than one), folder and harness. Either is
/// an optional control over field-high rows and a line saying what it is,
/// under the kind's picture when it is a bot or a task.
///
///     bar ─────────────────────────
///                  (robot)              art, optional: always 128
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
        /// doesn't fit, and stands this far over the composer.
        public static let margin: CGFloat = 12
        /// The kind's picture, an empty state's (`CardListMetrics.noteScene`),
        /// and its gap, as a note's scene stands over its words. Its size
        /// never changes with the room.
        public static let art: CGFloat = 128
        public static let artToKind: CGFloat = 16
    }

    /// The block, in the screen.
    public var block: CGRect
    /// In the block. `art` is nil when it was not asked for.
    public var art: CGRect?
    public var kind: CGRect?
    public var rows: [CGRect]
    public var note: CGRect?
    /// There is room for the block between the bar and the composer. When
    /// there isn't, it stands `margin` over the composer, its top under the
    /// bar.
    public var fits: Bool

    /// `top` is the bar's foot and `bottom` the composer's top, in the
    /// screen; `kindHeight` is the control's, nil for none; `note` wraps,
    /// centred, at the block's width. The block stands centred in what the
    /// safe area's `sides` leave of the screen's `width`. With `art`, the
    /// kind's picture stands over it.
    public init(width: CGFloat, sides: LayoutInsets = .zero, top: CGFloat, bottom: CGFloat, kindHeight: CGFloat?, rows count: Int, note: Measurable?, art: Bool = false) {
        typealias M = Metrics
        let band = sides.sides(of: CGSize(width: width, height: 0))
        let blockWidth = max(0, min(M.maxWidth, band.width - 2 * M.side))
        var y: CGFloat = 0
        if let kindHeight {
            let kindWidth = min(M.kindWidth, blockWidth)
            kind = CGRect(x: (blockWidth - kindWidth) / 2, y: 0, width: kindWidth, height: kindHeight)
            // With no rows the block ends at the kind.
            y = kindHeight + (count > 0 ? M.kindToRows : 0)
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
        if art {
            let shift = M.art + M.artToKind
            self.art = CGRect(x: (blockWidth - M.art) / 2, y: 0, width: M.art, height: M.art)
            kind = kind?.offsetBy(dx: 0, dy: shift)
            self.rows = rows.map { $0.offsetBy(dx: 0, dy: shift) }
            self.note = self.note?.offsetBy(dx: 0, dy: shift)
            y += shift
        }
        fits = room >= y + 2 * M.margin
        showsNote = note != nil
        let origin = fits ? top + (room - y) / 2 : bottom - M.margin - y
        block = CGRect(x: band.minX + (band.width - blockWidth) / 2, y: origin, width: blockWidth, height: y)
    }

    /// Whether `note` is laid out: with little room it goes first.
    public var showsNote: Bool

    /// A legacy account's block, which gives way rather than go: what it
    /// asks (the kind, the computer, a bot's name) is what the first send
    /// makes, so with the keyboard up on a small phone the note goes, then
    /// the gaps close, and only when even that has no room (a phone held
    /// sideways) does it not fit: then it stands on the composer and runs up
    /// under the bar. The picture stays, at its size, throughout. Nothing a row
    /// says (a computer offline, a name refused) adds to it: that is said
    /// inside the row.
    ///
    ///     bar ─────────────────────────
    ///                  (robot)                 art, always 128
    ///               [ Session | Bot | Task ]
    ///               [ computer          ]
    ///               [ Name your bot     ]
    ///               what a bot is              note, dropped first
    ///     composer ────────────────────
    public init(width: CGFloat, sides: LayoutInsets = .zero, top: CGFloat, bottom: CGFloat, kindHeight: CGFloat?, givingWay count: Int, note: Measurable?, art: Bool = false) {
        typealias M = Metrics
        let band = sides.sides(of: CGSize(width: width, height: 0))
        let blockWidth = max(0, min(M.maxWidth, band.width - 2 * M.side))
        let room = bottom - top
        let noteHeight = note.map { ceil($0.size(fitting: blockWidth).height) }
        func stack(art side: CGFloat? = nil, kindGap: CGFloat, rowGap: CGFloat, withNote: Bool) -> (art: CGRect?, kind: CGRect?, rows: [CGRect], note: CGRect?, height: CGFloat) {
            var y: CGFloat = 0
            let art = side.map { CGRect(x: (blockWidth - $0) / 2, y: 0, width: $0, height: $0) }
            if let side { y = side + M.artToKind }
            var kind: CGRect?
            if let kindHeight {
                let kindWidth = min(M.kindWidth, blockWidth)
                kind = CGRect(x: (blockWidth - kindWidth) / 2, y: y, width: kindWidth, height: kindHeight)
                y += kindHeight + kindGap
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
            return (art, kind, frames, noteFrame, y)
        }
        let side = art ? M.art : nil
        let attempts = [
            stack(art: side, kindGap: M.kindToRows, rowGap: M.rowGap, withNote: true),
            stack(art: side, kindGap: M.kindToRows, rowGap: M.rowGap, withNote: false),
            stack(art: side, kindGap: M.tightKindToRows, rowGap: M.tightRowGap, withNote: false),
        ]
        let chosen = attempts.first { room >= $0.height + 2 * M.margin } ?? attempts[attempts.count - 1]
        self.art = chosen.art
        kind = chosen.kind
        self.rows = chosen.rows
        self.note = chosen.note
        showsNote = chosen.note != nil
        fits = room >= chosen.height + 2 * M.margin
        let origin = fits ? top + (room - chosen.height) / 2 : bottom - M.margin - chosen.height
        block = CGRect(x: band.minX + (band.width - blockWidth) / 2, y: origin, width: blockWidth, height: chosen.height)
    }
}

extension NewWorkLayout.Metrics {
    /// The gaps once the room is short; under the kind the computer's
    /// status chip still clears it (`NewWorkStatusLayout.overhang`).
    public static let tightKindToRows: CGFloat = NewWorkStatusLayout.overhang + 5
    public static let tightRowGap: CGFloat = 6
}

/// The computer row's status: a small chip pinned to the row's top-right
/// corner, straddling its top edge like a badge, as wide as what it says.
/// It is laid over the row and takes no part in its layout: the icon and
/// the name are centred as in any row, and the chip's text changing, or
/// the chip going, moves nothing. Its top half rises into the gap over the
/// row, which is always deeper than `overhang`.
///
///                            ( ● Online )   chip: on the top edge
///     (   [icon] MacBook-Pro-7.local    )   name: centred, as any row's
public enum NewWorkStatusLayout {
    public static let fontSize: CGFloat = 11
    public static let height: CGFloat = 18
    /// Either side of the text.
    public static let padding: CGFloat = 7
    /// From the row's trailing edge to the chip's, as the icon is from the
    /// leading one.
    public static let trailing: CGFloat = 16
    public static let maxWidth: CGFloat = 150
    /// How far the chip rises over the row's top.
    public static let overhang: CGFloat = height / 2

    /// The chip, in a row of `rowWidth`, for a text `textWidth` wide: its
    /// trailing end and its middle are the same for any text.
    public static func chip(rowWidth: CGFloat, textWidth: CGFloat) -> CGRect {
        let width = min(maxWidth, ceil(textWidth) + 2 * padding)
        return CGRect(x: rowWidth - trailing - width, y: -overhang, width: width, height: height)
    }
}
