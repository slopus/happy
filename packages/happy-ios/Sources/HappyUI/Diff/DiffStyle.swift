#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import UIKit

/// components/diff/DiffPalette.ts and the rows' type: the theme's diff
/// colours by line type and span kind, and the mono styles at a view's
/// font size. Everything here is safe off the main thread, so plans are
/// measured and their text built there.
enum DiffStyle {
    // MARK: Colours

    static let surface = Palette.surface
    static let divider = Palette.divider
    static let text = Palette.text
    static let textSecondary = Palette.textSecondary
    static let hunkBackground = DiffPalette.hunkBackground
    static let hunkText = DiffPalette.hunkText
    static let sectionText = DiffPalette.sectionText
    static let lineNumber = DiffPalette.lineNumber

    static func rowBackground(_ type: DiffLineType) -> ColorToken {
        switch type {
        case .add: DiffPalette.rowAdded
        case .del: DiffPalette.rowRemoved
        case .ctx: DiffPalette.rowContext
        }
    }

    static func gutterBackground(_ type: DiffLineType) -> ColorToken {
        switch type {
        case .add: DiffPalette.gutterAdded
        case .del: DiffPalette.gutterRemoved
        case .ctx: DiffPalette.gutterContext
        }
    }

    /// The +/− colour; a context line's (empty) marker takes the number's.
    static func marker(_ type: DiffLineType) -> ColorToken {
        switch type {
        case .add: DiffPalette.markerAdded
        case .del: DiffPalette.markerRemoved
        case .ctx: DiffPalette.lineNumber
        }
    }

    static func syntax(_ kind: DiffSpanKind) -> ColorToken {
        switch kind {
        case .plain: DiffPalette.Syntax.plain
        case .keyword: DiffPalette.Syntax.keyword
        case .string: DiffPalette.Syntax.string
        case .comment: DiffPalette.Syntax.comment
        case .number: DiffPalette.Syntax.number
        case .function: DiffPalette.Syntax.function
        case .operator: DiffPalette.Syntax.operator
        case .punctuation: DiffPalette.Syntax.punctuation
        case .type: DiffPalette.Syntax.type
        case .variable: DiffPalette.Syntax.variable
        case .tag: DiffPalette.Syntax.tag
        case .attr: DiffPalette.Syntax.attr
        }
    }

    static func wordBackground(_ emphasis: DiffEmphasis) -> ColorToken? {
        switch emphasis {
        case .none: nil
        case .inserted: DiffPalette.wordAdded
        case .deleted: DiffPalette.wordRemoved
        }
    }

    // MARK: Type

    /// The text size a plan draws at: its environment's, or the designed
    /// size where the view doesn't follow the person's (nil).
    static func textScale(_ text: TextEnvironment?) -> TextScale {
        text?.scale ?? .standard
    }

    /// A code row: mono at the font size on the row's line, both scaled.
    static func code(_ metrics: DiffMetrics) -> TextStyle {
        TextStyle(.mono, size: metrics.fontSize, lineHeight: designedLine(metrics)).scaled(metrics.scale)
    }

    /// Line numbers and hunk rows: a point smaller on the same line.
    static func small(_ metrics: DiffMetrics) -> TextStyle {
        TextStyle(.mono, size: metrics.fontSize - 1, lineHeight: designedLine(metrics)).scaled(metrics.scale)
    }

    /// The gutter's hunk dots: a point smaller, the font's own line,
    /// centred in the row.
    static func dots(_ metrics: DiffMetrics) -> TextStyle {
        TextStyle(.mono, size: metrics.fontSize - 1).scaled(metrics.scale)
    }

    /// "Binary file not shown" / "No changes" rows: Typography.default().
    static func message(_ metrics: DiffMetrics) -> TextStyle {
        TextStyle(.regular, size: metrics.fontSize, lineHeight: designedLine(metrics)).scaled(metrics.scale)
    }

    /// `Math.round(fontSize * 1.5)`, which the styles scale.
    private static func designedLine(_ metrics: DiffMetrics) -> CGFloat {
        (metrics.fontSize * 1.5).rounded()
    }

    // MARK: Metrics

    private static let lock = NSLock()
    nonisolated(unsafe) private static var advances: [CGFloat: CGFloat] = [:]

    /// DiffMetrics.tsx's MonoProbe: the mono font's real advance at the
    /// size drawn, measured once per drawn size over 50 "M"s and kept, so
    /// a new text size measures again. `text` nil is the designed size.
    static func metrics(fontSize: CGFloat = DiffMetrics.defaultFontSize, text: TextEnvironment? = nil) -> DiffMetrics {
        let scale = textScale(text)
        let displayScale = text?.displayScale ?? 0
        let drawn = DiffMetrics(fontSize: fontSize, scale: scale).drawnFontSize
        lock.lock()
        if let advance = advances[drawn] {
            lock.unlock()
            return DiffMetrics(fontSize: fontSize, scale: scale, displayScale: displayScale, charWidth: advance)
        }
        lock.unlock()
        let sample = String(repeating: "M", count: 50)
        let width = (sample as NSString).size(withAttributes: [.font: Fonts.font(.mono, size: drawn)]).width / 50
        // A broken measurement (font not loaded) keeps the 0.6 em estimate.
        let advance: CGFloat? = DiffMetrics.acceptsAdvance(width, drawnFontSize: drawn) ? width : nil
        if let advance {
            lock.lock()
            advances[drawn] = advance
            lock.unlock()
        }
        return DiffMetrics(fontSize: fontSize, scale: scale, displayScale: displayScale, charWidth: advance)
    }

    /// One line of `style` as RN measures it: the font's line rounded up,
    /// or the fixed line.
    static func lineHeight(_ style: TextStyle) -> CGFloat {
        style.lineHeightValue
    }

    /// A single line of text's size, rounded up to whole points.
    static func size(_ string: NSAttributedString) -> CGSize {
        let rect = string.boundingRect(with: CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin], context: nil)
        return CGSize(width: ceil(rect.width), height: ceil(rect.height))
    }

    /// Wrapped text's size at `width`, rounded up.
    static func size(_ string: NSAttributedString, width: CGFloat) -> CGSize {
        let rect = string.boundingRect(with: CGSize(width: max(0, width), height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin], context: nil)
        return CGSize(width: min(ceil(rect.width), max(0, width)), height: ceil(rect.height))
    }

    /// A single line of `style`, measured with its baseline.
    static func box(_ string: String, _ style: TextStyle) -> DiffTextBox {
        let attributed = style.attributedString(string, color: .black, lineBreakMode: .byClipping)
        let measured = size(attributed)
        let font = style.font
        let height = max(measured.height, lineHeight(style))
        return DiffTextBox(size: CGSize(width: string.isEmpty ? 0 : measured.width, height: height), baseline: font.ascender)
    }

    // MARK: Row text

    /// A line's spans as one attributed string: syntax colour per span,
    /// word emphasis as a background. An empty line draws a space.
    static func lineText(_ spans: [DiffSpan], metrics: DiffMetrics) -> NSAttributedString {
        let style = code(metrics)
        guard !spans.isEmpty else {
            return style.attributedString(" ", color: UIColor(DiffPalette.Syntax.plain), lineBreakMode: .byClipping)
        }
        let base = style.attributes(color: UIColor(DiffPalette.Syntax.plain), lineBreakMode: .byClipping)
        let result = NSMutableAttributedString()
        for span in spans {
            var attributes = base
            if span.kind != .plain { attributes[.foregroundColor] = UIColor(syntax(span.kind)) }
            if let background = wordBackground(span.emphasis) { attributes[.backgroundColor] = UIColor(background) }
            result.append(NSAttributedString(string: span.text, attributes: attributes))
        }
        return result
    }

    /// A hunk row's text: the header (or "⤢ N unchanged" / "⋯ N unchanged"
    /// when lines were skipped), then the section three spaces on. Drawn by
    /// the row when it is configured, on the main thread, where its words
    /// are read; plans don't draw it.
    @MainActor
    static func hunkText(_ hunk: DiffHunk, canExpand: Bool, metrics: DiffMetrics) -> NSAttributedString {
        let style = small(metrics)
        let head = hunk.hidden.map { "\(canExpand ? "⤢" : "⋯") \(Strings.DiffDetail.unchangedLines($0))" } ?? hunk.text
        let result = NSMutableAttributedString(attributedString: style.attributedString(head, color: UIColor(hunkText), lineBreakMode: .byTruncatingTail))
        if !hunk.section.isEmpty {
            result.append(style.attributedString("   \(hunk.section)", color: UIColor(sectionText), lineBreakMode: .byTruncatingTail))
        }
        return result
    }

    /// A file with no lines' message, drawn as `hunkText` is.
    @MainActor
    static func messageText(_ code: DiffMessageCode, metrics: DiffMetrics) -> NSAttributedString {
        let text = code == .binary ? Strings.DiffDetail.binaryFile : Strings.DiffDetail.noChanges
        return message(metrics).attributedString(text, color: UIColor(textSecondary), lineBreakMode: .byTruncatingTail)
    }
}
#endif
