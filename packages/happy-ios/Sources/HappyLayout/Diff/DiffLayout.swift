import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// components/diff/DiffMetrics.tsx: the mono font's size, line and advance.
/// IBM Plex Mono is 0.6 em wide, the first-frame estimate; views pass the
/// measured advance once they have it.
///
/// At a text size the font and its line grow by React Native's multiplier,
/// as RN scales a Text's `fontSize` and `lineHeight`, and the advance is
/// measured at the size drawn, so the gutter and code widths grow with the
/// text; the gutter's padding and the code's inset stay fixed. A row is the
/// text's line, up to the screen's next pixel, as RN measures a one-line
/// Text. That differs from DiffFileView.tsx on purpose: its rows also set
/// `height: metrics.lineHeight`, a Yoga size RN never scales, so above the
/// default size its text is cut to an 18pt strip (docs/DYNAMIC-TYPE.md).
public struct DiffMetrics: Equatable, Sendable {
    /// `DEFAULT_DIFF_FONT_SIZE` on a phone.
    public static let defaultFontSize: CGFloat = 12
    public static let nominalRatio: CGFloat = 0.6

    /// The designed font size (DiffFileView's `fontSize`).
    public var fontSize: CGFloat
    /// The text size the rows are drawn at.
    public var scale: TextScale
    /// The rows' text line: `Math.round(fontSize * 1.5)`, times the
    /// multiplier, unrounded, as RN scales a `lineHeight`.
    public var textLineHeight: CGFloat
    /// One row: the text's line, up to the screen's next pixel.
    public var lineHeight: CGFloat
    public var charWidth: CGFloat

    /// `displayScale` is the screen's pixels per point, which a row's
    /// height is rounded up to; 0 leaves it unrounded. Without a measured
    /// `charWidth`, the advance is 0.6 em of the size drawn.
    public init(fontSize: CGFloat = DiffMetrics.defaultFontSize, scale: TextScale = .standard, displayScale: CGFloat = 0, charWidth: CGFloat? = nil) {
        self.fontSize = fontSize
        self.scale = scale
        textLineHeight = (fontSize * 1.5).rounded() * scale.multiplier
        lineHeight = displayScale > 0 ? (textLineHeight * displayScale).rounded(.up) / displayScale : textLineHeight
        self.charWidth = charWidth ?? fontSize * scale.multiplier * Self.nominalRatio
    }

    /// The font size drawn.
    public var drawnFontSize: CGFloat {
        fontSize * scale.multiplier
    }

    /// MonoProbe's check on a measured advance: a font that hasn't loaded
    /// measures outside 0.35 to 1.2 em, and keeps the estimate. Here the em
    /// is the size drawn. MonoProbe compares the scaled width with its
    /// designed `fontSize`, so from the multiplier 2 up (1.2 / 0.6) it
    /// refuses every measurement and keeps 0.6 em of the designed size,
    /// with the gutter and code too narrow for their text; and it keeps
    /// the first measurement per designed size for good, through a text
    /// size change. Neither is ported.
    public static func acceptsAdvance(_ advance: CGFloat, drawnFontSize: CGFloat) -> Bool {
        advance >= drawnFontSize * 0.35 && advance <= drawnFontSize * 1.2
    }

    /// layout.ts `gutterWidthFor`: the +/- column always, line numbers sized
    /// by the widest one (two digits at least).
    public static func gutterWidth(charWidth: CGFloat, maxLineNo: Int, showLineNumbers: Bool) -> CGFloat {
        let markerColumns: CGFloat = 2
        let digits = showLineNumbers ? CGFloat(max(2, String(max(1, maxLineNo)).count)) : 0
        return ((digits + markerColumns) * charWidth).rounded(.up) + (showLineNumbers ? 12 : 4)
    }

    public func gutterWidth(maxLineNo: Int, showLineNumbers: Bool) -> CGFloat {
        Self.gutterWidth(charWidth: charWidth, maxLineNo: maxLineNo, showLineNumbers: showLineNumbers)
    }

    /// The marker column: `ceil(charWidth * 2)`.
    public var markerWidth: CGFloat {
        (charWidth * 2).rounded(.up)
    }
}

/// DiffFileView.tsx's scroll layout: code under a horizontal scroll, the
/// line numbers and markers in a gutter pinned over its left edge, every row
/// one line tall. Then the "Show N more lines" bar when rows are held back.
///
/// Frames for the code are in the code canvas's coordinates (its x = 0 is
/// the gutter's right edge); the rest are in the view's.
public struct DiffFileLayout: Equatable, Sendable {
    public enum Metrics {
        /// Code text starts this far into its row.
        public static let codePaddingLeft: CGFloat = 6
        /// The gutter's hunk dots.
        public static let hunkDotsPaddingLeft: CGFloat = 6
        /// Columns of slack past the longest line, plus a little more.
        public static let slackColumns: CGFloat = 2
        public static let slackWidth: CGFloat = 8
        /// The "show more" bar: a 1pt rule, 10 above and below its text.
        public static let showMoreBorder: CGFloat = 1
        public static let showMorePadding: CGFloat = 10
        /// While "show more" waits for colour: a small spinner, 8 before
        /// the text.
        public static let showMoreSpinner: CGFloat = 20
        public static let showMoreGap: CGFloat = 8
    }

    public struct Input: Equatable, Sendable {
        public var width: CGFloat
        public var metrics: DiffMetrics
        /// Rows shown (after the collapse).
        public var rowCount: Int
        /// Rows held back for "show more".
        public var hiddenCount: Int
        public var maxColumns: Int
        public var maxLineNo: Int
        public var showLineNumbers: Bool
        public var paddingVertical: CGFloat
        /// One line of the bar's semibold 13.
        public var showMoreTextHeight: CGFloat

        public init(width: CGFloat, metrics: DiffMetrics = DiffMetrics(), rowCount: Int, hiddenCount: Int = 0, maxColumns: Int, maxLineNo: Int, showLineNumbers: Bool = true, paddingVertical: CGFloat = 0, showMoreTextHeight: CGFloat) {
            self.width = width
            self.metrics = metrics
            self.rowCount = rowCount
            self.hiddenCount = hiddenCount
            self.maxColumns = maxColumns
            self.maxLineNo = maxLineNo
            self.showLineNumbers = showLineNumbers
            self.paddingVertical = paddingVertical
            self.showMoreTextHeight = showMoreTextHeight
        }
    }

    public var input: Input
    public var gutterWidth: CGFloat
    /// What the longest line needs.
    public var codeWidth: CGFloat
    /// The code canvas: at least the room right of the gutter.
    public var contentWidth: CGFloat
    /// Whether the code is wider than its room and scrolls.
    public var scrollable: Bool
    /// The horizontal scroll view, with `scrollContentSize` inside.
    public var scroll: CGRect
    public var scrollContentSize: CGSize
    /// The canvas inside the scroll content, after the gutter's room.
    public var canvas: CGRect
    /// The pinned gutter, over the rows.
    public var gutter: CGRect
    public var showMore: CGRect?
    public var height: CGFloat

    public init(_ input: Input) {
        typealias M = Metrics
        self.input = input
        let metrics = input.metrics
        let width = max(0, input.width)
        gutterWidth = metrics.gutterWidth(maxLineNo: input.maxLineNo, showLineNumbers: input.showLineNumbers)
        codeWidth = ((CGFloat(input.maxColumns) + M.slackColumns) * metrics.charWidth).rounded(.up) + M.slackWidth
        let room = max(0, width - gutterWidth)
        contentWidth = max(codeWidth, room)
        scrollable = codeWidth > room

        let rowsHeight = CGFloat(max(0, input.rowCount)) * metrics.lineHeight
        let bodyHeight = rowsHeight + input.paddingVertical * 2
        scroll = CGRect(x: 0, y: 0, width: width, height: bodyHeight)
        scrollContentSize = CGSize(width: gutterWidth + contentWidth, height: bodyHeight)
        canvas = CGRect(x: gutterWidth, y: input.paddingVertical, width: contentWidth, height: rowsHeight)
        gutter = CGRect(x: 0, y: input.paddingVertical, width: gutterWidth, height: rowsHeight)

        if input.hiddenCount > 0 {
            let bar = CGRect(x: 0, y: bodyHeight, width: width, height: M.showMoreBorder + M.showMorePadding * 2 + input.showMoreTextHeight)
            showMore = bar
            height = bar.maxY
        } else {
            showMore = nil
            height = bodyHeight
        }
    }

    public var lineHeight: CGFloat { input.metrics.lineHeight }

    /// Row `index` in the canvas (and, at the gutter's width, the gutter).
    public func row(_ index: Int) -> CGRect {
        CGRect(x: 0, y: CGFloat(index) * lineHeight, width: contentWidth, height: lineHeight)
    }

    public func gutterRow(_ index: Int) -> CGRect {
        CGRect(x: 0, y: CGFloat(index) * lineHeight, width: gutterWidth, height: lineHeight)
    }

    /// Rows that meet `minY..<maxY`, in the canvas's coordinates.
    public func rows(from minY: CGFloat, to maxY: CGFloat) -> Range<Int> {
        let count = max(0, input.rowCount)
        guard count > 0, maxY > minY, lineHeight > 0 else { return 0..<0 }
        let first = min(count, max(0, Int((minY / lineHeight).rounded(.down))))
        let last = min(count, max(first, Int((maxY / lineHeight).rounded(.up))))
        return first..<last
    }

    /// The row at `y` in the canvas, if any.
    public func rowIndex(at y: CGFloat) -> Int? {
        guard y >= 0, lineHeight > 0 else { return nil }
        let index = Int((y / lineHeight).rounded(.down))
        return index < input.rowCount ? index : nil
    }

    // In-row frames, relative to the row.

    /// A line's code text, past the 6pt padding, as wide as it needs.
    public func codeText(width: CGFloat) -> CGRect {
        CGRect(x: Metrics.codePaddingLeft, y: 0, width: width, height: lineHeight)
    }

    /// The gutter's number: the room left of the marker, right-aligned.
    public var lineNumber: CGRect? {
        guard input.showLineNumbers else { return nil }
        return CGRect(x: 0, y: 0, width: max(0, gutterWidth - input.metrics.markerWidth), height: lineHeight)
    }

    /// The gutter's +/−, centred in two columns, after the number.
    public var marker: CGRect {
        let width = input.metrics.markerWidth
        let x = input.showLineNumbers ? max(0, gutterWidth - width) : 0
        return CGRect(x: x, y: 0, width: width, height: lineHeight)
    }

    /// The gutter's `···` on a hunk row.
    public var hunkDots: CGRect {
        CGRect(x: Metrics.hunkDotsPaddingLeft, y: 0, width: max(0, gutterWidth - Metrics.hunkDotsPaddingLeft), height: lineHeight)
    }

    /// The bar's text, centred, in the bar's coordinates.
    public func showMoreText(width textWidth: CGFloat) -> CGRect? {
        showMoreContent(textWidth: textWidth, busy: false)?.text
    }

    /// The bar's text and, while it is busy, the spinner before it: the
    /// pair centred, the spinner on the text's middle. The bar keeps its
    /// height; the spinner's extra 3pt overhang its padding.
    public func showMoreContent(textWidth: CGFloat, busy: Bool) -> (text: CGRect, spinner: CGRect?)? {
        guard let bar = showMore else { return nil }
        let lead = busy ? Metrics.showMoreSpinner + Metrics.showMoreGap : 0
        let width = min(textWidth, max(0, bar.width - lead))
        let x = (bar.width - width - lead) / 2
        let text = CGRect(x: x + lead, y: Metrics.showMoreBorder + Metrics.showMorePadding, width: width, height: input.showMoreTextHeight)
        let spinner = busy
            ? CGRect(x: x, y: text.midY - Metrics.showMoreSpinner / 2, width: Metrics.showMoreSpinner, height: Metrics.showMoreSpinner)
            : nil
        return (text, spinner)
    }
}

/// The horizontal window of a long code line worth drawing: the visible
/// part of the canvas plus a screen on each side, snapped to `step` so
/// small scrolls don't redraw.
public enum DiffTextWindow {
    public static let step: CGFloat = 512

    /// The span of `0..<textWidth` (the text's own coordinates) to draw when
    /// `visible` of it shows.
    public static func span(textWidth: CGFloat, visible: ClosedRange<CGFloat>, margin: CGFloat) -> ClosedRange<CGFloat>? {
        guard textWidth > 0 else { return nil }
        let lower = max(0, ((visible.lowerBound - margin) / step).rounded(.down) * step)
        let upper = min(textWidth, ((visible.upperBound + margin) / step).rounded(.up) * step)
        guard upper > lower else { return nil }
        return lower...upper
    }
}
