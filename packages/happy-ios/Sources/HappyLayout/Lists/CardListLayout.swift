import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// The agent home's inset grouped cards (`GroupedSidebarMetrics`) as a
// list of their own, for the screens home opens: the artifacts, the
// Surfaces, a todo list. Each item of the list is one slot as wide as the
// list: a heading over a card, a row of a card, or the room above the
// first card. On an iPad the cards hold to the readable column, centred.
//
//     |16| heading ………………………………………………………………… |16|
//     |16| card: |16| tile |12| title ……………… trailing |16| |16|
//                            subtitle ………………………………………
//                            ……… hairline to the card's edge

/// Where the cards stand in a list `width` wide: the readable column,
/// centred, `side` in from its edges.
public struct CardColumn: Equatable, Sendable {
    public var x: CGFloat
    public var width: CGFloat
    public var maxX: CGFloat { x + width }

    public init(width: CGFloat, maxWidth: CGFloat) {
        let column = min(max(0, width), max(0, maxWidth))
        x = ((max(0, width) - column) / 2).rounded(.down) + CardListMetrics.side
        self.width = max(0, column - 2 * CardListMetrics.side)
    }
}

/// A row's place in its card: the first rounds its top corners, the last
/// its bottom ones and has no hairline under it.
public struct CardPlace: Equatable, Hashable, Sendable {
    public var first: Bool
    public var last: Bool

    public init(first: Bool, last: Bool) {
        self.first = first
        self.last = last
    }

    public static let alone = CardPlace(first: true, last: true)

    /// The places of `count` rows in one card, in order.
    public static func run(_ count: Int) -> [CardPlace] {
        (0..<max(0, count)).map { CardPlace(first: $0 == 0, last: $0 == count - 1) }
    }
}

/// One row of a card, in its slot's coordinates (the slot is the list's
/// width and the row's height).
public struct CardRowLayout: Equatable, Sendable {
    public var size: CGSize
    /// The row's part of its card.
    public var card: CGRect
    public var leading: CGRect?
    public var title: CGRect
    public var subtitle: CGRect?
    public var trailing: CGRect?
    public var separator: CGRect?

    /// `leading` is a tile's or checkbox's size, `trailing` what stands at
    /// the end of the title's line (a time, a face). The title and the
    /// subtitle are measured at the width left them; the row is as tall as
    /// they are with its padding, and never less than `minHeight`, the
    /// text centred in it. The trailing size is centred on the title's
    /// first line, `titleLine` tall (the whole title when not given).
    public init(width: CGFloat, maxWidth: CGFloat = .greatestFiniteMagnitude, place: CardPlace, leading: CGSize? = nil, title: Measurable, subtitle: Measurable? = nil, trailing: CGSize? = nil, titleLine: CGFloat? = nil, minHeight: CGFloat? = nil, hairline: CGFloat, scale: CGFloat = 1) {
        typealias M = CardListMetrics
        func pixel(_ value: CGFloat) -> CGFloat { (value * max(1, scale)).rounded() / max(1, scale) }
        let column = CardColumn(width: width, maxWidth: maxWidth)
        let right = column.maxX - M.inset
        var textX = column.x + M.inset
        if let leading { textX += leading.width + M.tileGap }
        let titleRight = trailing.map { right - $0.width - M.trailingGap } ?? right
        let titleSize = title.size(fitting: max(0, titleRight - textX))
        let subtitleSize = subtitle?.size(fitting: max(0, right - textX))
        let textHeight = titleSize.height + (subtitleSize.map { M.lineGap + $0.height } ?? 0)
        let floor = minHeight ?? (leading == nil ? M.plainRow : M.tiledRow)
        let height = max(floor, pixel(textHeight + 2 * M.padding))
        let top = pixel((height - textHeight) / 2)
        size = CGSize(width: max(0, width), height: height)
        card = CGRect(x: column.x, y: 0, width: column.width, height: height)
        self.leading = leading.map { CGRect(x: column.x + M.inset, y: pixel((height - $0.height) / 2), width: $0.width, height: $0.height) }
        self.title = CGRect(x: textX, y: top, width: max(0, titleRight - textX), height: titleSize.height)
        self.subtitle = subtitleSize.map { CGRect(x: textX, y: top + titleSize.height + M.lineGap, width: max(0, right - textX), height: $0.height) }
        let line = min(titleLine ?? titleSize.height, titleSize.height)
        self.trailing = trailing.map { CGRect(x: right - $0.width, y: pixel(top + (line - $0.height) / 2), width: $0.width, height: $0.height) }
        separator = place.last ? nil : CGRect(x: textX, y: height - hairline, width: max(0, column.maxX - textX), height: hairline)
    }
}

/// A section's heading over its card: its title from where the rows'
/// content starts, `headingBottom` above the card; `afterCard` adds the
/// gap down from the card before it.
public struct CardHeadingLayout: Equatable, Sendable {
    public var size: CGSize
    public var label: CGRect
    /// Where a control on the heading's line goes (a fold, "Show all"),
    /// its right edge on the cards' content edge.
    public var trailingEdge: CGFloat

    public init(width: CGFloat, maxWidth: CGFloat = .greatestFiniteMagnitude, afterCard: Bool) {
        typealias M = CardListMetrics
        let column = CardColumn(width: width, maxWidth: maxWidth)
        let top = afterCard ? M.headingGap : 0
        let height = top + M.headingHeight
        size = CGSize(width: max(0, width), height: height)
        let x = column.x + M.inset
        trailingEdge = column.maxX - M.inset
        label = CGRect(x: x, y: height - M.headingBottom - M.headingLine, width: max(0, trailingEdge - x), height: M.headingLine)
    }
}

/// A note in place of a list's rows ("Nothing here yet."), or under its
/// heading: centred in the readable column, `padding` above and below.
public struct CardNoteLayout: Equatable, Sendable {
    public var size: CGSize
    public var text: CGRect

    public init(width: CGFloat, maxWidth: CGFloat = .greatestFiniteMagnitude, text: Measurable, padding: CGFloat = 24) {
        let column = CardColumn(width: width, maxWidth: maxWidth)
        let inner = max(0, column.width - 2 * CardListMetrics.inset)
        let measured = text.size(fitting: inner)
        let x = column.x + CardListMetrics.inset + ((inner - measured.width) / 2).rounded(.down)
        self.text = CGRect(x: x, y: padding, width: measured.width, height: measured.height)
        size = CGSize(width: max(0, width), height: measured.height + 2 * padding)
    }
}
