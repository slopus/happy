import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// One of the composer's model control panels (desktop's
/// `composer-model-control.css`): the model list or the effort list over its
/// chip, or a service's accounts stacked over the model list in place.
///
/// Lines run down the panel `inset` in from its sides; a block (a service,
/// a hairline, the footer) keeps `gap` from the one before it. The lines
/// scroll in the panel's viewport when they don't fit; the footer stays
/// under them. The picked line is in view from the panel's first frame:
/// centred when the list is long, the offset clamped to the list.
public struct StemCellPickerPanelLayout: Equatable, Sendable {
    public typealias Metrics = StemCellPickerMetrics

    /// A line: its height, and whether it starts a block.
    public struct Item: Equatable, Sendable {
        public var height: CGFloat
        public var startsBlock: Bool

        public init(height: CGFloat, startsBlock: Bool = false) {
            self.height = height
            self.startsBlock = startsBlock
        }

        public static let row = Item(height: Metrics.row)
        public static let heading = Item(height: Metrics.heading, startsBlock: true)
        public static let separator = Item(height: 1, startsBlock: true)
        /// The line after a hairline, or the first of a new block.
        public static func block(_ height: CGFloat) -> Item { Item(height: height, startsBlock: true) }
    }

    /// The panel, in the space it was placed in.
    public var frame: CGRect
    /// Where the lines scroll, in the panel.
    public var viewport: CGRect
    /// The lines, in the viewport's content.
    public var items: [CGRect]
    public var contentHeight: CGFloat
    /// The footer's lines, in the panel.
    public var footer: [CGRect]
    /// Where the lines stand scrolled when the panel first shows.
    public var initialOffset: CGFloat

    /// A list over its chip: its trailing edge on the chip's (kept `margin`
    /// inside `bounds`), its bottom `anchorGap` above it, as tall as its lines
    /// or as `bounds` leaves above the chip, at most `maxHeight`.
    public init(items: [Item], footer: [Item] = [], width: CGFloat, over anchor: CGRect, in bounds: CGRect, selected: Int? = nil) {
        self.init(items: items, footer: footer, width: width, trailing: anchor.maxX, bottom: anchor.minY - Metrics.anchorGap, in: bounds, selected: selected)
    }

    /// A panel stacked over another in place: the same trailing edge and
    /// bottom, so it covers the panel under it from where that stands.
    public init(items: [Item], footer: [Item] = [], width: CGFloat, stackedOver base: CGRect, in bounds: CGRect, selected: Int? = nil) {
        self.init(items: items, footer: footer, width: width, trailing: base.maxX, bottom: base.maxY, in: bounds, selected: selected)
    }

    private init(items: [Item], footer: [Item], width: CGFloat, trailing: CGFloat, bottom: CGFloat, in bounds: CGRect, selected: Int?) {
        let width = max(0, min(width, bounds.width - 2 * Metrics.margin))
        let x = max(bounds.minX + Metrics.margin, min(trailing, bounds.maxX - Metrics.margin) - width)
        let lineWidth = max(0, width - 2 * Metrics.inset)

        func stack(_ items: [Item], from top: CGFloat) -> (frames: [CGRect], bottom: CGFloat) {
            var y = top
            var frames: [CGRect] = []
            for (index, item) in items.enumerated() {
                if index > 0, item.startsBlock { y += Metrics.gap }
                frames.append(CGRect(x: Metrics.inset, y: y, width: lineWidth, height: item.height))
                y += item.height
            }
            return (frames, y)
        }

        let lines = stack(items, from: 0)
        let footerHeight = stack(footer, from: 0).bottom
        let chrome = 2 * Metrics.inset + (footer.isEmpty ? 0 : Metrics.gap + footerHeight)
        let room = min(Metrics.maxHeight, bottom - (bounds.minY + Metrics.margin))
        let viewportHeight = max(0, min(lines.bottom, room - chrome))
        let height = viewportHeight + chrome

        frame = CGRect(x: x, y: bottom - height, width: width, height: height)
        viewport = CGRect(x: 0, y: Metrics.inset, width: width, height: viewportHeight)
        self.items = lines.frames
        contentHeight = lines.bottom
        self.footer = stack(footer, from: viewport.maxY + Metrics.gap).frames

        let scrolls = max(0, lines.bottom - viewportHeight)
        if let selected, lines.frames.indices.contains(selected) {
            initialOffset = min(scrolls, max(0, (lines.frames[selected].midY - viewportHeight / 2).rounded()))
        } else {
            initialOffset = 0
        }
    }

    /// The account's windows under its list: a week line, then the rest,
    /// `gap` apart, `detailsInsetY` above and below.
    public static func detailsHeight(lines: Int, primary: Bool) -> CGFloat {
        guard lines > 0 else { return 0 }
        let first = primary ? Metrics.detailsPrimaryLine : Metrics.detailsLine
        return 2 * Metrics.detailsInsetY + first + CGFloat(lines - 1) * (Metrics.detailsLine + Metrics.gap)
    }
}

/// One line's parts, desktop's flex row: pieces from its leading edge,
/// `padding` in, each `gapBefore` after the last, and pieces from its
/// trailing edge back. A piece that `shrinks` gives up what doesn't fit, so
/// a long name ends early and what follows it (a gauge) stays whole; with
/// more than one, the last gives way first.
public struct StemCellPickerLineLayout: Equatable, Sendable {
    public struct Piece: Equatable, Sendable {
        public var size: CGSize
        public var maxWidth: CGFloat?
        public var shrinks: Bool
        public var gapBefore: CGFloat

        public init(_ size: CGSize, maxWidth: CGFloat? = nil, shrinks: Bool = false, gapBefore: CGFloat = 0) {
            self.size = size
            self.maxWidth = maxWidth
            self.shrinks = shrinks
            self.gapBefore = gapBefore
        }
    }

    public var leading: [CGRect]
    public var trailing: [CGRect]

    /// `trailingGap` keeps the leading pieces off the trailing ones.
    public init(line: CGRect, padding: CGFloat = StemCellPickerMetrics.padding, leading: [Piece], trailing: [Piece] = [], trailingGap: CGFloat = StemCellPickerMetrics.checkGap) {
        func centred(_ x: CGFloat, _ size: CGSize, width: CGFloat) -> CGRect {
            CGRect(x: x, y: line.midY - size.height / 2, width: width, height: size.height)
        }
        var right = line.maxX - padding
        var placed: [CGRect] = []
        for (index, piece) in trailing.enumerated() {
            if index > 0 { right -= piece.gapBefore }
            let width = min(piece.size.width, piece.maxWidth ?? .greatestFiniteMagnitude)
            placed.append(centred(right - width, piece.size, width: width))
            right -= width
        }
        self.trailing = placed
        let end = trailing.isEmpty ? line.maxX - padding : right - trailingGap
        var widths = leading.map { min($0.size.width, $0.maxWidth ?? .greatestFiniteMagnitude) }
        let gaps = leading.dropFirst().reduce(0) { $0 + $1.gapBefore }
        var over = widths.reduce(0, +) + gaps - (end - (line.minX + padding))
        for index in leading.indices.reversed() where over > 0 && leading[index].shrinks {
            let given = min(over, widths[index])
            widths[index] -= given
            over -= given
        }
        var x = line.minX + padding
        var frames: [CGRect] = []
        for (index, piece) in leading.enumerated() {
            if index > 0 { x += piece.gapBefore }
            frames.append(centred(x, piece.size, width: widths[index]))
            x += widths[index]
        }
        self.leading = frames
    }
}

/// A usage gauge as desktop's: what is left, then a ring that drains as the
/// window is spent.
public struct StemCellUsageGaugeLayout: Equatable, Sendable {
    public var size: CGSize
    public var text: CGRect
    public var ring: CGRect

    public init(text: CGSize) {
        let ringSize = StemCellPickerMetrics.ring
        let height = max(text.height, ringSize)
        self.text = CGRect(x: 0, y: (height - text.height) / 2, width: text.width, height: text.height)
        ring = CGRect(x: text.width + StemCellPickerMetrics.ringGap, y: (height - ringSize) / 2, width: ringSize, height: ringSize)
        size = CGSize(width: ring.maxX, height: height)
    }
}
