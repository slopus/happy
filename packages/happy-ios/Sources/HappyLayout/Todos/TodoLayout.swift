import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// A todo list as cards (`CardListLayout`):
//
//     |16| card: |16| ( ) |12| Pick up groceries ……………… (SK) |16| |16|
//                             a second line wraps under the first
//
//          Groceries                                  <- `# Groceries`
//     |16| card: |16| ( ) |12| Milk …………………………………………………… |16| |16|
//
//          > Show 3 completed

/// One todo as a row of its card: its checkbox, its text wrapped, who
/// added it at the end of the first line. `hit` is where a tap checks it:
/// the card's edge to the text, the row's height.
public struct TodoRowLayout: Equatable, Sendable {
    public var row: CardRowLayout
    public var check: CGRect
    public var hit: CGRect
    public var face: CGRect?

    public var size: CGSize { row.size }
    public var card: CGRect { row.card }
    public var text: CGRect { row.title }
    public var separator: CGRect? { row.separator }

    public init(width: CGFloat, maxWidth: CGFloat = .greatestFiniteMagnitude, place: CardPlace, text: Measurable, textLine: CGFloat, face: Bool, hairline: CGFloat, scale: CGFloat = 1) {
        typealias M = TodoMetrics
        let square = CGSize(width: M.check, height: M.check)
        row = CardRowLayout(
            width: width, maxWidth: maxWidth, place: place, leading: square, title: text,
            trailing: face ? CGSize(width: M.face, height: M.face) : nil, titleLine: textLine,
            minHeight: CardListMetrics.plainRow, hairline: hairline, scale: scale
        )
        // On the first line, not the middle of a tall row.
        let pixels = max(1, scale)
        let line = min(textLine, row.title.height)
        let y = ((row.title.minY + (line - M.check) / 2) * pixels).rounded() / pixels
        check = CGRect(x: row.leading?.minX ?? 0, y: max(0, y), width: M.check, height: M.check)
        hit = CGRect(x: row.card.minX, y: 0, width: max(0, row.title.minX - row.card.minX), height: row.size.height)
        self.face = row.trailing
    }
}

/// A section heading (`# Groceries`) over the card of the todos under it:
/// its label from where the rows' content starts, wrapped, a little above
/// the card; `afterCard` adds the gap down from the card before it.
public struct TodoHeadingLayout: Equatable, Sendable {
    public var size: CGSize
    public var label: CGRect

    public init(width: CGFloat, maxWidth: CGFloat = .greatestFiniteMagnitude, label: Measurable, afterCard: Bool) {
        typealias M = TodoMetrics
        let column = CardColumn(width: width, maxWidth: maxWidth)
        let x = column.x + CardListMetrics.inset
        let measured = label.size(fitting: max(0, column.maxX - CardListMetrics.inset - x))
        let top = afterCard ? M.headingTop : M.headingBottom
        self.label = CGRect(x: x, y: top, width: max(0, column.maxX - CardListMetrics.inset - x), height: measured.height)
        size = CGSize(width: max(0, width), height: top + measured.height + M.headingBottom)
    }
}

/// "Show 3 completed" under the active card: a chevron and its words,
/// a heading's gap down from the card.
public struct TodoToggleLayout: Equatable, Sendable {
    public var size: CGSize
    public var chevron: CGRect
    public var label: CGRect

    public init(width: CGFloat, maxWidth: CGFloat = .greatestFiniteMagnitude, label: CGSize, afterCard: Bool) {
        typealias M = TodoMetrics
        let heading = CardHeadingLayout(width: width, maxWidth: maxWidth, afterCard: afterCard)
        size = heading.size
        let line = heading.label
        chevron = CGRect(x: line.minX, y: line.midY - M.toggleChevron / 2, width: M.toggleChevron, height: M.toggleChevron)
        let x = chevron.maxX + M.toggleGap
        self.label = CGRect(x: x, y: line.midY - label.height / 2, width: min(label.width, max(0, line.maxX - x)), height: label.height)
    }
}

/// The undo bar: a capsule over the bottom of the list, centred in the
/// readable column, its words then its button.
public struct TodoToastLayout: Equatable, Sendable {
    public var frame: CGRect
    public var label: CGRect
    public var button: CGRect

    /// `bottom` is the list's bottom inset (the safe area and keyboard).
    public init(width: CGFloat, height: CGFloat, bottom: CGFloat, label: CGSize, button: CGSize) {
        typealias M = TodoMetrics
        let wide = min(max(0, width - 2 * M.toastSide), M.toastMaxWidth)
        frame = CGRect(x: ((width - wide) / 2).rounded(.down), y: height - bottom - M.toastBottom - M.toastHeight, width: wide, height: M.toastHeight)
        let buttonX = wide - M.toastPadding - button.width
        self.button = CGRect(x: buttonX, y: (M.toastHeight - button.height) / 2, width: button.width, height: button.height)
        let labelWidth = max(0, min(label.width, buttonX - M.toastGap - M.toastPadding))
        self.label = CGRect(x: M.toastPadding, y: (M.toastHeight - label.height) / 2, width: labelWidth, height: label.height)
    }
}
