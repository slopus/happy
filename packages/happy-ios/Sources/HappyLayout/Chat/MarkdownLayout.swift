import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// MarkdownView.tsx: parsed blocks stacked top to bottom. React Native
/// doesn't collapse margins, so each block's own margins simply add up:
///
///     text      8 ┬ text ┬ 10
///     header    h1–h3 16 / 8, h4 8 / 8, h5–h6 0 / 0
///     rule      8 ┬ 1 ┬ 8
///     list      0 ┬ items, 6 apart ┬ 8
///     code      8 ┬ [8 language] 16 code 16 ┬ 8     (scrolls sideways)
///     options   8 ┬ buttons, 8 apart ┬ 8
///     table     8 ┬ bordered grid ┬ 8                (scrolls sideways)
///     image     8 ┬ 240 picture, 8, caption ┬ 8
///     mermaid   8 ┬ diagram, 200 to 600 ┬ 8        (scrolls inside)
///
/// Frames are relative to the markdown view's origin.
public struct MarkdownLayout: Equatable, Sendable {
    public enum Metrics {
        public static let textMarginTop: CGFloat = 8
        public static let textMarginBottom: CGFloat = 10
        public static let ruleMargin: CGFloat = 8
        public static let ruleHeight: CGFloat = 1
        public static let listItemGap: CGFloat = 6
        public static let listMarginBottom: CGFloat = 8
        public static let listIndent: CGFloat = 16
        public static let listMarkerGap: CGFloat = 8
        public static let listMarkerTop: CGFloat = 1
        public static let blockMargin: CGFloat = 8
        public static let codePadding: CGFloat = 16
        public static let codeLanguageTop: CGFloat = 8
        /// The widest a code block's text is drawn; a longer line (minified
        /// code, say) is cut off there rather than drawn into a bitmap
        /// hundreds of screens wide.
        public static let codeMaxWidth: CGFloat = 4096
        public static let codeRadius: CGFloat = 8
        public static let optionGap: CGFloat = 8
        public static let optionPaddingH: CGFloat = 12
        public static let optionPaddingV: CGFloat = 8
        public static let optionRadius: CGFloat = 12
        public static let tableBorder: CGFloat = 1
        public static let tableRadius: CGFloat = 8
        public static let tableCellPaddingH: CGFloat = 12
        public static let tableCellPaddingV: CGFloat = 8
        public static let tableMinColumn: CGFloat = 80
        public static let tableMaxColumn: CGFloat = 360
        public static let tableCharWidth: CGFloat = 8.5
        public static let imageMaxWidth: CGFloat = 520
        public static let imageHeight: CGFloat = 240
        public static let imageCaptionGap: CGFloat = 8
        public static let imageRadius: CGFloat = 12
        /// MermaidRenderer: the diagram's height before its page reports
        /// one, which is also the least it shows, and the most, past which
        /// the page scrolls inside.
        public static let mermaidInitialHeight: CGFloat = 200
        public static let mermaidMaxHeight: CGFloat = 600
        public static let mermaidRadius: CGFloat = 8
        /// The page's own padding around the diagram (its body's).
        public static let mermaidPadding: CGFloat = 16

        public static func headerMargins(_ level: Int) -> (top: CGFloat, bottom: CGFloat) {
            switch level {
            case 1, 2, 3: (16, 8)
            case 4: (8, 8)
            default: (0, 0)
            }
        }
    }

    public struct ListItem {
        public var depth: Int
        /// The bullet or "3." label.
        public var marker: Measurable
        public var text: Measurable

        public init(depth: Int, marker: Measurable, text: Measurable) {
            self.depth = depth
            self.marker = marker
            self.text = text
        }
    }

    public struct Table {
        /// One width per column, from `columnWidths(lengths:)`.
        public var columnWidths: [CGFloat]
        /// Row 0 is the header row. Missing cells are empty.
        public var rows: [[Measurable]]

        public init(columnWidths: [CGFloat], rows: [[Measurable]]) {
            self.columnWidths = columnWidths
            self.rows = rows
        }
    }

    public enum Block {
        case text(Measurable)
        case header(level: Int, Measurable)
        case rule
        case list([ListItem])
        /// `code` is the highlighted text's unwrapped size.
        case code(language: Measurable?, code: CGSize)
        case options([Measurable])
        case table(Table)
        case image(caption: Measurable?)
        /// A diagram, and the height its page reported, if it has yet.
        case mermaid(reported: CGFloat?)
    }

    public struct PlacedListItem: Equatable, Sendable {
        public var marker: CGRect
        public var text: CGRect
    }

    public struct PlacedCode: Equatable, Sendable {
        public var frame: CGRect
        public var language: CGRect?
        /// The horizontal scroll view, in the block's frame.
        public var scroll: CGRect
        public var contentSize: CGSize
        /// The code text, in the scroll view's content.
        public var text: CGRect
    }

    public struct PlacedTable: Equatable, Sendable {
        public var frame: CGRect
        /// Inside the border.
        public var scroll: CGRect
        public var contentSize: CGSize
        /// Cell text frames by row then column, in the scroll content.
        public var cells: [[CGRect]]
        /// Row backgrounds (the header row is shaded), in the scroll content.
        public var rows: [CGRect]
        /// Hairlines between rows and between columns, in the scroll content.
        public var separators: [CGRect]
    }

    public enum Placed: Equatable, Sendable {
        case text(CGRect)
        case header(CGRect)
        case rule(CGRect)
        case list(frame: CGRect, items: [PlacedListItem])
        case code(PlacedCode)
        case options(frame: CGRect, buttons: [CGRect], labels: [CGRect])
        case table(PlacedTable)
        case image(frame: CGRect, picture: CGRect, caption: CGRect?)
        case mermaid(CGRect)

        public var frame: CGRect {
            switch self {
            case .text(let frame), .header(let frame), .rule(let frame): frame
            case .list(let frame, _): frame
            case .code(let code): code.frame
            case .options(let frame, _, _): frame
            case .table(let table): table.frame
            case .image(let frame, _, _): frame
            case .mermaid(let frame): frame
            }
        }
    }

    public var blocks: [Placed]
    public var size: CGSize

    public init(width: CGFloat, blocks input: [Block]) {
        typealias M = Metrics
        let width = max(0, width)
        var y: CGFloat = 0
        var placed: [Placed] = []

        for block in input {
            switch block {
            case .text(let text):
                y += M.textMarginTop
                let size = text.size(fitting: width)
                placed.append(.text(CGRect(x: 0, y: y, width: width, height: size.height)))
                y += size.height + M.textMarginBottom

            case .header(let level, let text):
                let margins = M.headerMargins(level)
                y += margins.top
                let height = text.height(fitting: width)
                placed.append(.header(CGRect(x: 0, y: y, width: width, height: height)))
                y += height + margins.bottom

            case .rule:
                y += M.ruleMargin
                placed.append(.rule(CGRect(x: 0, y: y, width: width, height: M.ruleHeight)))
                y += M.ruleHeight + M.ruleMargin

            case .list(let items):
                let top = y
                var items_: [PlacedListItem] = []
                for (index, item) in items.enumerated() {
                    if index > 0 { y += M.listItemGap }
                    let x = min(width, CGFloat(max(0, item.depth)) * M.listIndent)
                    let marker = item.marker.size(fitting: max(0, width - x))
                    let textX = min(width, x + marker.width + M.listMarkerGap)
                    let textWidth = max(0, width - textX)
                    let textHeight = item.text.height(fitting: textWidth)
                    items_.append(PlacedListItem(
                        marker: CGRect(x: x, y: y + M.listMarkerTop, width: marker.width, height: marker.height),
                        text: CGRect(x: textX, y: y, width: textWidth, height: textHeight)
                    ))
                    y += max(marker.height + M.listMarkerTop, textHeight)
                }
                placed.append(.list(frame: CGRect(x: 0, y: top, width: width, height: y - top), items: items_))
                y += M.listMarginBottom

            case .code(let language, let code):
                y += M.blockMargin
                var inner: CGFloat = 0
                var languageFrame: CGRect?
                if let language {
                    let size = language.size(fitting: max(0, width - 2 * M.codePadding))
                    languageFrame = CGRect(x: M.codePadding, y: M.codeLanguageTop, width: max(0, width - 2 * M.codePadding), height: size.height)
                    inner = M.codeLanguageTop + size.height
                }
                let scrollHeight = code.height + 2 * M.codePadding
                let codeWidth = min(code.width, M.codeMaxWidth)
                let frame = CGRect(x: 0, y: y, width: width, height: inner + scrollHeight)
                placed.append(.code(PlacedCode(
                    frame: frame,
                    language: languageFrame,
                    scroll: CGRect(x: 0, y: inner, width: width, height: scrollHeight),
                    contentSize: CGSize(width: max(width, codeWidth + 2 * M.codePadding), height: scrollHeight),
                    text: CGRect(x: M.codePadding, y: M.codePadding, width: codeWidth, height: code.height)
                )))
                y += frame.height + M.blockMargin

            case .options(let labels):
                y += M.blockMargin
                let top = y
                var buttons: [CGRect] = []
                var labelFrames: [CGRect] = []
                let labelWidth = max(0, width - 2 * M.optionPaddingH)
                for (index, label) in labels.enumerated() {
                    if index > 0 { y += M.optionGap }
                    let height = label.height(fitting: labelWidth)
                    buttons.append(CGRect(x: 0, y: y, width: width, height: height + 2 * M.optionPaddingV))
                    labelFrames.append(CGRect(x: M.optionPaddingH, y: y + M.optionPaddingV, width: labelWidth, height: height))
                    y += height + 2 * M.optionPaddingV
                }
                placed.append(.options(frame: CGRect(x: 0, y: top, width: width, height: y - top), buttons: buttons, labels: labelFrames))
                y += M.blockMargin

            case .table(let table):
                y += M.blockMargin
                let grid = Self.tableGrid(table)
                let scrollWidth = min(grid.contentSize.width, max(0, width - 2 * M.tableBorder))
                let frame = CGRect(x: 0, y: y, width: scrollWidth + 2 * M.tableBorder, height: grid.contentSize.height + 2 * M.tableBorder)
                placed.append(.table(PlacedTable(
                    frame: frame,
                    scroll: CGRect(x: M.tableBorder, y: M.tableBorder, width: scrollWidth, height: grid.contentSize.height),
                    contentSize: grid.contentSize,
                    cells: grid.cells,
                    rows: grid.rows,
                    separators: grid.separators
                )))
                y += frame.height + M.blockMargin

            case .image(let caption):
                y += M.blockMargin
                let imageWidth = min(width, M.imageMaxWidth)
                let picture = CGRect(x: 0, y: 0, width: imageWidth, height: M.imageHeight)
                var height = M.imageHeight
                var captionFrame: CGRect?
                if let caption {
                    let captionHeight = caption.height(fitting: imageWidth)
                    captionFrame = CGRect(x: 0, y: height + M.imageCaptionGap, width: imageWidth, height: captionHeight)
                    height += M.imageCaptionGap + captionHeight
                }
                placed.append(.image(frame: CGRect(x: 0, y: y, width: imageWidth, height: height), picture: picture, caption: captionFrame))
                y += height + M.blockMargin

            case .mermaid(let reported):
                y += M.blockMargin
                let height = Self.mermaidHeight(reported: reported)
                placed.append(.mermaid(CGRect(x: 0, y: y, width: width, height: height)))
                y += height + M.blockMargin
            }
        }

        blocks = placed
        size = CGSize(width: width, height: y)
    }

    /// The narrowest width the blocks fit at, for a bubble that hugs its
    /// text: the widest line, list row, code line, table or option.
    public static func naturalWidth(of blocks: [Block], available: CGFloat) -> CGFloat {
        typealias M = Metrics
        let available = max(0, available)
        var widest: CGFloat = 0
        for block in blocks {
            let width: CGFloat
            switch block {
            case .text(let text), .header(_, let text):
                width = text.size(fitting: available).width
            case .rule:
                width = 0
            case .list(let items):
                width = items.map { item in
                    let x = CGFloat(max(0, item.depth)) * M.listIndent
                    let marker = item.marker.size(fitting: available).width
                    return x + marker + M.listMarkerGap + item.text.size(fitting: max(0, available - x - marker - M.listMarkerGap)).width
                }.max() ?? 0
            case .code(let language, let code):
                width = max(code.width, language?.size(fitting: available).width ?? 0) + 2 * M.codePadding
            case .options(let labels):
                width = (labels.map { $0.size(fitting: max(0, available - 2 * M.optionPaddingH)).width }.max() ?? 0) + 2 * M.optionPaddingH
            case .table(let table):
                width = table.columnWidths.reduce(0, +) + 2 * M.tableBorder
            case .image:
                width = M.imageMaxWidth
            case .mermaid:
                // `width: '100%'`.
                width = available
            }
            widest = max(widest, width)
        }
        return min(widest, available)
    }

    /// MermaidRenderer's box: 200 until the page reports, then the most it
    /// has reported (`Math.max(prev.height, data.height)`, from 200), never
    /// more than 600.
    public static func mermaidHeight(reported: CGFloat?) -> CGFloat {
        typealias M = Metrics
        return min(max(M.mermaidInitialHeight, reported ?? 0), M.mermaidMaxHeight)
    }

    /// What to keep of a height a diagram's page reported, given what is
    /// kept already: rounded up to whole pixels, no more than the box can
    /// show, and only if the box grows by it. Nil keeps what there is, so
    /// a page settling by a fraction of a pixel, or past 600, plans nothing
    /// again.
    public static func mermaidHeightToKeep(reported: CGFloat, kept: CGFloat?, scale: CGFloat) -> CGFloat? {
        typealias M = Metrics
        guard reported.isFinite, scale > 0 else { return nil }
        let height = min((reported * scale).rounded(.up) / scale, M.mermaidMaxHeight)
        guard height > max(kept ?? 0, M.mermaidInitialHeight) else { return nil }
        return height
    }

    /// How many pixels to decode an image block's picture of `size` pixels
    /// to: `resizeMode="contain"` in the largest box it is drawn in
    /// (`imageMaxWidth` by `imageHeight`), on a 3x screen, never more than
    /// it has.
    public static func decodedImageSize(_ size: CGSize) -> CGSize {
        typealias M = Metrics
        guard size.width > 0, size.height > 0 else { return size }
        let scale = min(1, 3 * M.imageMaxWidth / size.width, 3 * M.imageHeight / size.height)
        return CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
    }

    /// RenderTableBlock's column widths: the longest cell's character count
    /// at 8.5 pt a character plus padding, clamped to 80…360.
    public static func columnWidths(lengths: [[Int]]) -> [CGFloat] {
        let columns = lengths.first?.count ?? 0
        return (0..<columns).map { column in
            let longest = lengths.map { column < $0.count ? $0[column] : 0 }.max() ?? 0
            let estimate = CGFloat(longest) * Metrics.tableCharWidth + 2 * Metrics.tableCellPaddingH
            return min(Metrics.tableMaxColumn, max(Metrics.tableMinColumn, estimate))
        }
    }

    private static func tableGrid(_ table: Table) -> (contentSize: CGSize, cells: [[CGRect]], rows: [CGRect], separators: [CGRect]) {
        typealias M = Metrics
        let widths = table.columnWidths
        let columns = widths.count
        var xs: [CGFloat] = []
        var x: CGFloat = 0
        for width in widths {
            xs.append(x)
            x += width
        }
        let totalWidth = x
        var y: CGFloat = 0
        var cells: [[CGRect]] = []
        var rows: [CGRect] = []
        var separators: [CGRect] = []
        for (rowIndex, row) in table.rows.enumerated() {
            let last = rowIndex == table.rows.count - 1
            // The header row always has its rule; data rows have one unless last.
            let bottomBorder: CGFloat = (rowIndex == 0 || !last) ? M.tableBorder : 0
            var textWidths: [CGFloat] = []
            var textHeights: [CGFloat] = []
            for column in 0..<columns {
                let rightBorder: CGFloat = column < columns - 1 ? M.tableBorder : 0
                let textWidth = max(0, widths[column] - 2 * M.tableCellPaddingH - rightBorder)
                textWidths.append(textWidth)
                textHeights.append(column < row.count ? row[column].height(fitting: textWidth) : 0)
            }
            let contentHeight = (textHeights.max() ?? 0) + 2 * M.tableCellPaddingV
            cells.append((0..<columns).map { column in
                CGRect(x: xs[column] + M.tableCellPaddingH, y: y + M.tableCellPaddingV, width: textWidths[column], height: textHeights[column])
            })
            rows.append(CGRect(x: 0, y: y, width: totalWidth, height: contentHeight + bottomBorder))
            for column in 0..<max(0, columns - 1) {
                separators.append(CGRect(x: xs[column] + widths[column] - M.tableBorder, y: y, width: M.tableBorder, height: contentHeight + bottomBorder))
            }
            if bottomBorder > 0 {
                separators.append(CGRect(x: 0, y: y + contentHeight, width: totalWidth, height: bottomBorder))
            }
            y += contentHeight + bottomBorder
        }
        return (CGSize(width: totalWidth, height: y), cells, rows, separators)
    }
}
