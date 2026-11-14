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
        /// A legacy account's block, snugger than Happy Agent's (Kirill).
        public static let givingWayMaxWidth: CGFloat = 256
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

    /// Whether `note` is laid out.
    public var showsNote: Bool

    /// A legacy account's block, at most `givingWayMaxWidth` wide, top to
    /// bottom: the kind's picture, the kind, what the kind is, then the
    /// rows. As Happy Agent's new work, it never shrinks or drops anything
    /// (Kirill): centred while it fits, short of room (the keyboard up, the
    /// composer grown) it stands `margin` over the composer and slides up
    /// under the bar, picture first. Its first control (the kind, else the
    /// first row) stops at the bar's foot, `top`, so it can always be
    /// tapped: past that the rows rise over what the kind is, which fades
    /// out before they reach it (`noteAlpha`), and only with no room even
    /// then does the block run on up under the bar.
    ///
    /// With `reserveArt` and `reserveRows` it is laid out at its tallest
    /// kind's, a picture's room and that many rows' kept, so the kind
    /// holds still as the kind changes (Kirill): a kind with no picture or
    /// fewer rows leaves that room empty. Nothing a row says (a computer
    /// offline, a name refused) adds to it: that is said inside the row.
    ///
    ///     bar ─────────────────────────
    ///                  (robot)                 art, always 128
    ///               [ Session | Bot | Task ]   stops at the bar's foot
    ///               what a bot is              note, covered last
    ///               [ Machine | computer  ]
    ///               [ Name your bot       ]
    ///     composer ────────────────────
    public init(width: CGFloat, sides: LayoutInsets = .zero, top: CGFloat, bottom: CGFloat, kindHeight: CGFloat?, givingWay count: Int, note: Measurable?, art: Bool = false, reserveArt: Bool = false, reserveRows: Int = 0) {
        typealias M = Metrics
        let band = sides.sides(of: CGSize(width: width, height: 0))
        let blockWidth = max(0, min(M.givingWayMaxWidth, band.width - 2 * M.side))
        let room = bottom - top
        let rowCount = max(count, reserveRows)
        var y: CGFloat = 0
        let side: CGFloat? = art || reserveArt ? M.art : nil
        if let side { y = side + M.artToKind }
        // The kind, the note and the rows, `kindToRows` apart.
        var gap: CGFloat = 0
        var kind: CGRect?
        if let kindHeight {
            let kindWidth = min(M.kindWidth, blockWidth)
            kind = CGRect(x: (blockWidth - kindWidth) / 2, y: y, width: kindWidth, height: kindHeight)
            y += kindHeight
            gap = M.kindToRows
        }
        var noteFrame: CGRect?
        if let note {
            y += gap
            let height = ceil(note.size(fitting: blockWidth).height)
            noteFrame = CGRect(x: 0, y: y, width: blockWidth, height: height)
            y += height
            gap = M.kindToRows
        }
        var rows: [CGRect] = []
        for index in 0..<max(0, rowCount) {
            y += index > 0 ? M.rowGap : gap
            if index < count { rows.append(CGRect(x: 0, y: y, width: blockWidth, height: M.rowHeight)) }
            y += M.rowHeight
        }
        fits = room >= y + 2 * M.margin
        var origin = fits ? top + (room - y) / 2 : bottom - M.margin - y
        // The first control stops at the bar's foot; the rows then rise
        // over the note, as far as its room goes.
        var rise: CGFloat = 0
        if let first = kind?.minY ?? rows.first?.minY, origin + first < top {
            origin = top - first
            let over = origin + y - (bottom - M.margin)
            let noteRoom = noteFrame.map { $0.height + M.kindToRows } ?? 0
            rise = min(max(0, over), noteRoom)
            // Gone by the time the rows reach it: faded across the gap over them.
            noteAlpha = max(0, 1 - rise / M.kindToRows)
            // No room even then: on up under the bar.
            origin -= max(0, over - rise)
        } else {
            noteAlpha = 1
        }
        self.art = art ? side.map { CGRect(x: (blockWidth - $0) / 2, y: 0, width: $0, height: $0) } : nil
        self.kind = kind
        self.rows = rows.map { $0.offsetBy(dx: 0, dy: -rise) }
        self.note = noteFrame
        showsNote = noteFrame != nil && noteAlpha > 0
        block = CGRect(x: band.minX + (band.width - blockWidth) / 2, y: origin, width: blockWidth, height: y - rise)
    }

    /// How much of the note shows: 1, unless the rows have risen over it
    /// (`init(givingWay:)`).
    public var noteAlpha: CGFloat = 1
}

extension NewWorkLayout {
    /// Where a legacy account's room ends so the keyboard coming or going
    /// moves nothing: the bottom it has with the keyboard at `reserve`
    /// (the tallest seen, over the screen's foot), whatever the keyboard is
    /// doing. `bottom` is the room's foot now, with the keyboard's top at
    /// `keyboardTop`, in a screen `height` high. A keyboard taller than the
    /// reserve takes the room's foot up with it.
    public static func heldBottom(bottom: CGFloat, keyboardTop: CGFloat, height: CGFloat, reserve: CGFloat) -> CGFloat {
        bottom - max(0, keyboardTop - (height - reserve))
    }
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

/// A legacy account's row as two columns from its start, lined up across
/// the rows (Kirill): the glyph and what the row picks ("Machine",
/// "Project", "Harness") in a column as wide as the widest label, then the
/// pick in the rest. Each text is a line high, centred, so the computer's
/// status chip on the row's top edge stays clear of it.
///
///     ( [icon] Machine  MacBook-Pro.local )
///     ( [icon] Project  …/packages/app    )
public struct NewWorkRowColumns: Equatable, Sendable {
    public static let inset: CGFloat = 16
    public static let icon: CGFloat = 16
    public static let iconGap: CGFloat = 8
    /// Between the label's column and the pick's.
    public static let gap: CGFloat = 16

    /// In the row.
    public var icon: CGRect
    public var label: CGRect
    public var value: CGRect

    /// In a row `size` big; `labelWidth` is the widest label's, `lineHeight`
    /// a line of the texts'.
    public init(size: CGSize, labelWidth: CGFloat, lineHeight: CGFloat) {
        let content = max(0, size.width - 2 * Self.inset)
        let column = min(content, Self.icon + Self.iconGap + ceil(labelWidth))
        let midY = size.height / 2
        let line = min(size.height, ceil(lineHeight))
        icon = CGRect(x: Self.inset, y: midY - Self.icon / 2, width: Self.icon, height: Self.icon)
        let labelX = icon.maxX + Self.iconGap
        label = CGRect(x: labelX, y: midY - line / 2, width: max(0, Self.inset + column - labelX), height: line)
        let valueX = Self.inset + column + Self.gap
        value = CGRect(x: valueX, y: midY - line / 2, width: max(0, size.width - Self.inset - valueX), height: line)
    }
}
