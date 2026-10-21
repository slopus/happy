import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// app/(app)/session/[id]/file.tsx: the path header, the Diff / File
/// toggle when there is a diff, then the scrolling content.
///
///     16 [icon 20] 8 [path, wrapping] 16      0.5 rule below
///     12  16 [ 16 Diff 16 ] 8 [ 16 File 16 ]  0.5 rule below
///         (buttons 8 above and below their text, radius 8)
///     content, padded 16
public struct FileViewerLayout: Equatable, Sendable {
    public enum Metrics {
        public static let headerPadding: CGFloat = 16
        public static let iconSize: CGFloat = 20
        public static let iconGap: CGFloat = 8
        /// borderBottomWidth 0.5 on both bars.
        public static let border: CGFloat = 0.5
        public static let togglePaddingH: CGFloat = 16
        public static let togglePaddingV: CGFloat = 12
        public static let buttonPaddingH: CGFloat = 16
        public static let buttonPaddingV: CGFloat = 8
        public static let buttonRadius: CGFloat = 8
        public static let buttonGap: CGFloat = 8
        public static let contentPadding: CGFloat = 16
    }

    public struct Input {
        public var size: CGSize
        /// Where the screen starts below the navigation bar.
        public var top: CGFloat
        public var path: Measurable
        /// The Diff and File labels, when the toggle shows.
        public var toggle: (diff: CGSize, file: CGSize)?

        public init(size: CGSize, top: CGFloat, path: Measurable, toggle: (diff: CGSize, file: CGSize)?) {
            self.size = size
            self.top = top
            self.path = path
            self.toggle = toggle
        }
    }

    public var header: CGRect
    public var icon: CGRect
    public var path: CGRect
    public var headerBorder: CGRect
    public var toggleBar: CGRect?
    public var diffButton: CGRect?
    public var diffLabel: CGRect?
    public var fileButton: CGRect?
    public var fileLabel: CGRect?
    public var toggleBorder: CGRect?
    /// The scrolling content, below the bars.
    public var content: CGRect

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.size.width)
        let pathWidth = max(0, width - M.headerPadding * 2 - M.iconSize - M.iconGap)
        let pathSize = input.path.size(fitting: pathWidth)
        let rowHeight = max(M.iconSize, pathSize.height)
        let headerTop = input.top
        header = CGRect(x: 0, y: headerTop, width: width, height: rowHeight + M.headerPadding * 2 + M.border)
        icon = CGRect(x: M.headerPadding, y: headerTop + M.headerPadding + (rowHeight - M.iconSize) / 2, width: M.iconSize, height: M.iconSize)
        path = CGRect(
            x: M.headerPadding + M.iconSize + M.iconGap,
            y: headerTop + M.headerPadding + (rowHeight - pathSize.height) / 2,
            width: pathWidth,
            height: pathSize.height
        )
        headerBorder = CGRect(x: 0, y: header.maxY - M.border, width: width, height: M.border)
        var y = header.maxY

        if let toggle = input.toggle {
            func button(_ x: CGFloat, _ label: CGSize, buttonHeight: CGFloat) -> (CGRect, CGRect) {
                let box = CGRect(x: x, y: y + M.togglePaddingV, width: label.width + M.buttonPaddingH * 2, height: buttonHeight)
                let text = CGRect(x: box.minX + M.buttonPaddingH, y: box.minY + (buttonHeight - label.height) / 2, width: label.width, height: label.height)
                return (box, text)
            }
            let buttonHeight = max(toggle.diff.height, toggle.file.height) + M.buttonPaddingV * 2
            let diff = button(M.togglePaddingH, toggle.diff, buttonHeight: buttonHeight)
            let file = button(diff.0.maxX + M.buttonGap, toggle.file, buttonHeight: buttonHeight)
            diffButton = diff.0
            diffLabel = diff.1
            fileButton = file.0
            fileLabel = file.1
            let bar = CGRect(x: 0, y: y, width: width, height: buttonHeight + M.togglePaddingV * 2 + M.border)
            toggleBar = bar
            toggleBorder = CGRect(x: 0, y: bar.maxY - M.border, width: width, height: M.border)
            y = bar.maxY
        } else {
            toggleBar = nil
            diffButton = nil
            diffLabel = nil
            fileButton = nil
            fileLabel = nil
            toggleBorder = nil
        }
        content = CGRect(x: 0, y: y, width: width, height: max(0, input.size.height - y))
    }
}

/// file.tsx's scrolling content: a column `layout.maxWidth` wide at most,
/// centred and padded 16, holding one row per line. DiffDisplay rows sit 8
/// in and 1 above and below their wrapped text, added and removed lines
/// with a 3pt bar on the left inside the row; SimpleSyntaxHighlighter's
/// lines are bare, one Text block wrapping each line in turn.
public struct FileLinesLayout: Equatable, Sendable {
    public enum Metrics {
        public static let padding: CGFloat = 16
    }

    public struct RowInsets: Equatable, Sendable {
        public var horizontal: CGFloat
        public var vertical: CGFloat
        /// The left bar's width, on rows that have one.
        public var bar: CGFloat

        public init(horizontal: CGFloat, vertical: CGFloat, bar: CGFloat) {
            self.horizontal = horizontal
            self.vertical = vertical
            self.bar = bar
        }

        /// DiffDisplay's rows.
        public static let diff = RowInsets(horizontal: 8, vertical: 1, bar: 3)
        /// SimpleSyntaxHighlighter's lines.
        public static let code = RowInsets(horizontal: 0, vertical: 0, bar: 0)
    }

    /// The content column's left edge and width.
    public static func column(width: CGFloat, maxWidth: CGFloat) -> (x: CGFloat, width: CGFloat) {
        let outer = max(0, width)
        let inner = min(outer, max(0, maxWidth))
        return ((outer - inner) / 2, inner)
    }

    /// The text width a row offers its line, with or without the bar.
    public static func textWidth(width: CGFloat, maxWidth: CGFloat, insets: RowInsets, bar: Bool) -> CGFloat {
        let column = column(width: width, maxWidth: maxWidth).width
        return max(0, column - Metrics.padding * 2 - insets.horizontal * 2 - (bar ? insets.bar : 0))
    }

    /// "File is empty" / "No changes to display" in place of the rows,
    /// and the content it makes.
    public static func message(width: CGFloat, maxWidth: CGFloat, text: Measurable) -> (frame: CGRect, contentSize: CGSize) {
        let column = column(width: width, maxWidth: maxWidth)
        let textWidth = max(0, column.width - Metrics.padding * 2)
        let size = text.size(fitting: textWidth)
        let frame = CGRect(x: column.x + Metrics.padding, y: Metrics.padding, width: textWidth, height: size.height)
        return (frame, CGSize(width: max(0, width), height: size.height + Metrics.padding * 2))
    }

    public var width: CGFloat
    public var insets: RowInsets
    /// The rows' left edge and width.
    private var rowX: CGFloat
    private var rowWidth: CGFloat
    /// Each row's top, in content coordinates, plus the end.
    private var offsets: [CGFloat]
    private var bars: [Bool]
    public var contentSize: CGSize

    /// `textHeights` are each line's measured height at `textWidth`.
    public init(width: CGFloat, maxWidth: CGFloat, insets: RowInsets, textHeights: [CGFloat], bars: [Bool]) {
        typealias M = Metrics
        self.width = max(0, width)
        self.insets = insets
        let column = Self.column(width: width, maxWidth: maxWidth)
        rowX = column.x + M.padding
        rowWidth = max(0, column.width - M.padding * 2)
        self.bars = bars
        var offsets: [CGFloat] = [M.padding]
        offsets.reserveCapacity(textHeights.count + 1)
        var y = M.padding
        for height in textHeights {
            y += height + insets.vertical * 2
            offsets.append(y)
        }
        self.offsets = offsets
        contentSize = CGSize(width: self.width, height: y + M.padding)
    }

    public var count: Int { offsets.count - 1 }

    /// The rows together: the Text block a long press copies from.
    public var block: CGRect {
        CGRect(x: rowX, y: Metrics.padding, width: rowWidth, height: offsets[count] - Metrics.padding)
    }

    public func row(_ index: Int) -> CGRect {
        CGRect(x: rowX, y: offsets[index], width: rowWidth, height: offsets[index + 1] - offsets[index])
    }

    private func hasBar(_ index: Int) -> Bool {
        index < bars.count && bars[index]
    }

    /// The bar, in the row's coordinates; nil for lines without one.
    public func bar(_ index: Int) -> CGRect? {
        guard hasBar(index) else { return nil }
        return CGRect(x: 0, y: 0, width: insets.bar, height: row(index).height)
    }

    /// The text, in the row's coordinates.
    public func text(_ index: Int) -> CGRect {
        let frame = row(index)
        let bar = hasBar(index) ? insets.bar : 0
        return CGRect(
            x: bar + insets.horizontal,
            y: insets.vertical,
            width: max(0, frame.width - bar - insets.horizontal * 2),
            height: max(0, frame.height - insets.vertical * 2)
        )
    }

    /// One line's text box: its measured height, at least the style's
    /// line, up to the screen's next pixel as RN ceils a Text's box
    /// (`displayScale` 0 rounds up to whole points). A thousandth of a
    /// pixel over is float noise in TextKit's sum of lines, not a pixel.
    public static func textHeight(measured: CGFloat, line: CGFloat, displayScale: CGFloat) -> CGFloat {
        let height = max(line, measured)
        let scale = displayScale > 0 ? displayScale : 1
        return ((height * scale) - 0.001).rounded(.up) / scale
    }

    /// Whether a line can't wrap at `width` without measuring it: printable
    /// ASCII, a character short of the width at the mono advance.
    public static func fitsOneLine(_ string: String, advance: CGFloat, width: CGFloat) -> Bool {
        var count = 0
        for unit in string.utf16 {
            guard unit >= 0x20, unit < 0x7F else { return false }
            count += 1
        }
        return CGFloat(count + 1) * advance <= width
    }

    /// The row at `y` and how far down it (0 to 1), so a layout made again
    /// at another text size or width can put the same line at the top.
    /// Nil with no rows or above the first (the top padding, which keeps
    /// its offset); past the last it is the last's end.
    public func place(at y: CGFloat) -> (row: Int, fraction: CGFloat)? {
        guard count > 0, y >= offsets[0] else { return nil }
        if y >= offsets[count] { return (count - 1, 1) }
        let index = rows(from: y, to: y + 1).lowerBound
        let frame = row(index)
        return (index, frame.height > 0 ? (y - frame.minY) / frame.height : 0)
    }

    /// Where `place` is in this layout; nil when its row is gone.
    public func y(of place: (row: Int, fraction: CGFloat)) -> CGFloat? {
        guard place.row >= 0, place.row < count else { return nil }
        let frame = row(place.row)
        return frame.minY + place.fraction * frame.height
    }

    /// Rows that meet `minY..<maxY`, found by binary search.
    public func rows(from minY: CGFloat, to maxY: CGFloat) -> Range<Int> {
        guard count > 0, maxY > minY else { return 0..<0 }
        func firstRow(endingAfter y: CGFloat) -> Int {
            var low = 0, high = count
            while low < high {
                let mid = (low + high) / 2
                if offsets[mid + 1] <= y { low = mid + 1 } else { high = mid }
            }
            return low
        }
        func firstRow(startingAtOrAfter y: CGFloat) -> Int {
            var low = 0, high = count
            while low < high {
                let mid = (low + high) / 2
                if offsets[mid] < y { low = mid + 1 } else { high = mid }
            }
            return low
        }
        let first = firstRow(endingAfter: minY)
        let end = max(first, firstRow(startingAtOrAfter: maxY))
        return first..<end
    }
}
