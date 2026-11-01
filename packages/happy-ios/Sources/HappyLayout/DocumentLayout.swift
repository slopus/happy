import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The kinds of line a document draws something beside.
public enum DocumentLineKind: Equatable, Sendable {
    case text
    case heading(Int)
    case bullet
    /// Its number's measured width.
    case numbered(width: CGFloat)
    case check
    case quote
    case code
    /// A divider, a picture, a table: a block with no text.
    case object
}

/// How a line is indented: the paragraph style's head indents, the same at
/// every width so text never moves when only its marker changes.
public struct DocumentIndent: Equatable, Sendable {
    public enum Metrics {
        /// Each level of nesting.
        public static let level: CGFloat = 24
        /// A list item's marker column.
        public static let marker: CGFloat = 26
        /// A quote's bar and the gap after it.
        public static let quote: CGFloat = 16
        /// A code block's padding inside its fill.
        public static let code: CGFloat = 12
    }

    public var firstLine: CGFloat
    public var head: CGFloat
    /// Inset from the right (a code block's padding).
    public var tail: CGFloat

    public init(kind: DocumentLineKind, depth: Int) {
        typealias M = Metrics
        let base = CGFloat(max(0, depth)) * M.level
        let lead: CGFloat
        switch kind {
        case .bullet, .numbered, .check: lead = M.marker
        case .quote: lead = M.quote
        case .code: lead = M.code
        case .text, .heading, .object: lead = 0
        }
        firstLine = base + lead
        head = base + lead
        tail = kind == .code ? M.code : 0
    }
}

/// What a line draws beside its text, in the coordinates of its laid-out
/// fragment: a bullet, a number, a task's box, a quote's bar or a code
/// block's fill. The text view's layout fragments draw these frames.
public struct DocumentMarkerLayout: Equatable, Sendable {
    public enum Metrics {
        public static let bullet: CGFloat = 6
        public static let check: CGFloat = 18
        public static let checkCorner: CGFloat = 5
        public static let quoteBar: CGFloat = 3
        public static let codeCorner: CGFloat = 8
        /// A code block's fill above and below its text.
        public static let codeVertical: CGFloat = 8
        /// The gap between a number and its text.
        public static let numberGap: CGFloat = 6
        /// The finger's target around a task's box.
        public static let checkTarget: CGFloat = 44
    }

    /// The bullet, number or box.
    public var marker: CGRect?
    /// A quote's bar, or a code block's fill.
    public var decoration: CGRect?
    /// Where a tap toggles a task.
    public var target: CGRect?

    /// - Parameters:
    ///   - firstLine: the first line's typographic frame within the fragment.
    ///   - lastLine: the last line's; the same as `firstLine` for one line.
    ///   - origin: where the fragment starts in the text container. TextKit
    ///     starts an indented paragraph's fragment at its indent, and the
    ///     markers sit left of that, so they come out negative.
    ///   - width: the text container's width.
    public init(kind: DocumentLineKind, depth: Int, firstLine: CGRect, lastLine: CGRect, origin: CGFloat, width: CGFloat) {
        typealias M = Metrics
        let base = CGFloat(max(0, depth)) * DocumentIndent.Metrics.level - origin
        let column = DocumentIndent.Metrics.marker
        let midY = firstLine.midY
        let top = firstLine.minY
        let bottom = max(firstLine.maxY, lastLine.maxY)
        switch kind {
        case .bullet:
            marker = CGRect(x: base + (column - M.bullet) / 2 - 4, y: midY - M.bullet / 2, width: M.bullet, height: M.bullet)
        case .numbered(let numberWidth):
            let x = base + column - M.numberGap - numberWidth
            marker = CGRect(x: max(base, x), y: firstLine.minY, width: numberWidth, height: firstLine.height)
        case .check:
            let box = CGRect(x: base + (column - M.check) / 2 - 4, y: midY - M.check / 2, width: M.check, height: M.check)
            marker = box
            target = box.insetBy(dx: (M.check - M.checkTarget) / 2, dy: (M.check - M.checkTarget) / 2)
        case .quote:
            decoration = CGRect(x: base, y: top, width: M.quoteBar, height: bottom - top)
        case .code:
            decoration = CGRect(x: base, y: top - M.codeVertical, width: max(0, width - origin - base), height: bottom - top + M.codeVertical * 2)
        case .text, .heading, .object:
            break
        }
    }

    public init(marker: CGRect? = nil, decoration: CGRect? = nil, target: CGRect? = nil) {
        self.marker = marker
        self.decoration = decoration
        self.target = target
    }
}

/// The editor screen: the text view fills it under the bar and over the
/// keyboard; its text keeps to a readable column, centred on an iPad.
public struct DocumentScreenLayout: Equatable, Sendable {
    public enum Metrics {
        /// The column's side padding on a phone, and at least this on an iPad.
        public static let padding: CGFloat = 20
        public static let top: CGFloat = 16
        public static let bottom: CGFloat = 96
        /// A status ("Loading…", an error) in place of the text.
        public static let statusWidth: CGFloat = 280
    }

    public var text: CGRect
    /// The text container's inset inside `text`.
    public var inset: LayoutInsets
    /// What the keyboard covers past the safe area: scrolled past, not padded.
    public var scrollBottom: CGFloat
    public var status: CGRect

    public init(size: CGSize, safeArea: LayoutInsets, keyboard: CGFloat, maxWidth: CGFloat, status: Measurable) {
        typealias M = Metrics
        text = CGRect(origin: .zero, size: size)
        let usable = size.width - safeArea.horizontal
        let column = min(max(0, usable - M.padding * 2), maxWidth)
        let side = max(M.padding, (usable - column) / 2)
        inset = LayoutInsets(top: M.top, left: safeArea.left + side, bottom: M.bottom, right: safeArea.right + side)
        scrollBottom = max(0, keyboard - safeArea.bottom)
        let statusWidth = min(M.statusWidth, max(0, usable - M.padding * 2))
        let statusHeight = status.height(fitting: statusWidth)
        let visible = size.height - safeArea.top - max(safeArea.bottom, keyboard)
        self.status = CGRect(x: safeArea.left + (usable - statusWidth) / 2, y: safeArea.top + max(0, (visible - statusHeight) / 2), width: statusWidth, height: statusHeight)
    }
}

/// The formatting bar over the keyboard: glass buttons in a row that
/// scrolls when they don't fit, and a done button held at the end.
public struct DocumentToolbarLayout: Equatable, Sendable {
    public enum Metrics {
        public static let height: CGFloat = 56
        public static let button: CGFloat = 44
        public static let spacing: CGFloat = 2
        /// Between the screen's edge and the glass, and the glass and its buttons.
        public static let margin: CGFloat = 8
        public static let padding: CGFloat = 4
        /// Between the scrolling glass and the done button's.
        public static let gap: CGFloat = 8
    }

    /// The glass behind the scrolling buttons, and its content size.
    public var strip: CGRect
    public var content: CGSize
    /// Each button within the strip's content.
    public var buttons: [CGRect]
    public var done: CGRect

    public init(width: CGFloat, safeArea: LayoutInsets, count: Int) {
        typealias M = Metrics
        let y = (M.height - M.button - M.padding * 2) / 2
        done = CGRect(x: width - safeArea.right - M.margin - M.button - M.padding * 2, y: y, width: M.button + M.padding * 2, height: M.button + M.padding * 2)
        let left = safeArea.left + M.margin
        strip = CGRect(x: left, y: y, width: max(0, done.minX - M.gap - left), height: M.button + M.padding * 2)
        var frames: [CGRect] = []
        var x = M.padding
        for _ in 0..<max(0, count) {
            frames.append(CGRect(x: x, y: M.padding, width: M.button, height: M.button))
            x += M.button + M.spacing
        }
        buttons = frames
        content = CGSize(width: max(strip.width, x - M.spacing + M.padding), height: strip.height)
    }
}

/// One change in a document's history: who made it, when, and how big.
public struct DocumentHistoryRowLayout: Equatable, Sendable {
    public enum Metrics {
        public static let avatar: CGFloat = 36
        public static let padding: CGFloat = 16
        public static let vertical: CGFloat = 10
        public static let gap: CGFloat = 12
        public static let lineGap: CGFloat = 2
    }

    public var avatar: CGRect
    public var title: CGRect
    public var detail: CGRect
    public var height: CGFloat

    public init(width: CGFloat, safeArea: LayoutInsets, title: Measurable, detail: Measurable) {
        typealias M = Metrics
        let x = safeArea.left + M.padding + M.avatar + M.gap
        let textWidth = max(0, width - x - safeArea.right - M.padding)
        let titleHeight = title.height(fitting: textWidth)
        let detailHeight = detail.height(fitting: textWidth)
        let textHeight = titleHeight + M.lineGap + detailHeight
        height = max(M.avatar, textHeight) + M.vertical * 2
        avatar = CGRect(x: safeArea.left + M.padding, y: (height - M.avatar) / 2, width: M.avatar, height: M.avatar)
        let top = (height - textHeight) / 2
        self.title = CGRect(x: x, y: top, width: textWidth, height: titleHeight)
        self.detail = CGRect(x: x, y: top + titleHeight + M.lineGap, width: textWidth, height: detailHeight)
    }
}

/// The people in the document beside its title: overlapping faces, the
/// newest last, and a count once there are more than fit.
public struct DocumentPeersLayout: Equatable, Sendable {
    public enum Metrics {
        public static let face: CGFloat = 28
        public static let overlap: CGFloat = 8
        public static let most = 3
    }

    public var faces: [CGRect]
    /// The "+2" after them.
    public var more: CGRect?
    public var size: CGSize

    public init(count: Int, more moreWidth: CGFloat) {
        typealias M = Metrics
        let shown = min(count, M.most)
        var frames: [CGRect] = []
        for i in 0..<shown { frames.append(CGRect(x: CGFloat(i) * (M.face - M.overlap), y: 0, width: M.face, height: M.face)) }
        faces = frames
        var width = frames.last?.maxX ?? 0
        if count > M.most {
            more = CGRect(x: width + 4, y: 0, width: moreWidth, height: M.face)
            width += 4 + moreWidth
        }
        size = CGSize(width: width, height: shown > 0 ? M.face : 0)
    }

    /// Where a measured initial goes in its face: centred.
    public static func initial(_ size: CGSize, in face: CGRect) -> CGRect {
        CGRect(x: face.midX - size.width / 2, y: face.midY - size.height / 2, width: size.width, height: size.height)
    }

    /// Where the "+2" goes in its frame: at its start, centred down.
    public static func more(_ size: CGSize, in frame: CGRect) -> CGRect {
        CGRect(x: frame.minX, y: frame.midY - size.height / 2, width: size.width, height: size.height)
    }
}

/// A block without text, drawn in its line's U+FFFC: its size at a width,
/// and where its parts go inside that.
public enum DocumentObjectLayout {
    public enum Metrics {
        public static let corner: CGFloat = 8
        public static let tableCorner: CGFloat = 6
        public static let cellPadding: CGFloat = 8
        public static let notePadding: CGFloat = 12
    }

    public enum Kind: Equatable, Sendable {
        /// `line`: one line of body text, the rule centred in it.
        case divider(line: CGFloat)
        /// `picture`: the picture's own size once read.
        case picture(CGSize?)
        case table(rows: Int, row: CGFloat)
        /// Something this editor can't show: a note of `height`.
        case unsupported(height: CGFloat)
    }

    /// The width it gets: the line less its indent (and a point, so
    /// TextKit never wraps it).
    public static func size(_ kind: Kind, width: CGFloat, depth: Int) -> CGSize {
        let width = max(1, width - DocumentIndent(kind: .object, depth: depth).head - 1)
        switch kind {
        case .divider(let line): return CGSize(width: width, height: line)
        case .picture(let picture):
            if let picture, picture.width > 0 {
                let shown = min(width, picture.width)
                return CGSize(width: shown, height: (shown * picture.height / picture.width).rounded())
            }
            return CGSize(width: width, height: (width * 9 / 16).rounded())
        case let .table(rows, row): return CGSize(width: width, height: CGFloat(max(1, rows)) * row)
        case .unsupported(let height): return CGSize(width: width, height: height)
        }
    }

    /// A divider's one-point rule, across the middle.
    public static func rule(in size: CGSize) -> CGRect {
        CGRect(x: 0, y: (size.height / 2 - 0.5).rounded(), width: size.width, height: 1)
    }

    /// A label in the middle (a picture not read yet).
    public static func centered(_ label: CGSize, in size: CGSize) -> CGRect {
        CGRect(x: (size.width - label.width) / 2, y: (size.height - label.height) / 2, width: label.width, height: label.height)
    }

    /// A label at the start, centred down (the note for what can't be shown).
    public static func note(_ label: CGSize, in size: CGSize) -> CGRect {
        CGRect(x: Metrics.notePadding, y: (size.height - label.height) / 2, width: label.width, height: label.height)
    }

    /// A table's grid: the lines between rows and columns, and each cell's
    /// text frame for text `textHeight` tall.
    public struct Table: Equatable, Sendable {
        public var rowLines: [CGFloat]
        public var columnLines: [CGFloat]
        /// By row, then column.
        public var cells: [[CGRect]]

        public init(rows: Int, columns: Int, size: CGSize, textHeight: CGFloat) {
            let rows = max(1, rows)
            let columns = max(1, columns)
            let cellWidth = size.width / CGFloat(columns)
            let rowHeight = size.height / CGFloat(rows)
            rowLines = (1..<max(1, rows)).map { CGFloat($0) * rowHeight }
            columnLines = (1..<max(1, columns)).map { CGFloat($0) * cellWidth }
            cells = (0..<rows).map { r in
                (0..<columns).map { c in
                    CGRect(x: CGFloat(c) * cellWidth + Metrics.cellPadding, y: CGFloat(r) * rowHeight + (rowHeight - textHeight) / 2,
                           width: max(0, cellWidth - Metrics.cellPadding * 2), height: textHeight)
                }
            }
        }
    }
}

extension DocumentMarkerLayout {
    /// Where a measured number goes in its marker: right-aligned, centred down.
    public static func number(_ size: CGSize, in marker: CGRect) -> CGRect {
        CGRect(x: marker.maxX - size.width, y: marker.midY - size.height / 2, width: size.width, height: size.height)
    }
}

/// Another editor's cursor over the text: a bar on their caret and their
/// name on a tab above it, kept inside the text's width.
public struct DocumentCursorLayout: Equatable, Sendable {
    public enum Metrics {
        public static let bar: CGFloat = 2
        public static let label: CGFloat = 16
        public static let labelPadding: CGFloat = 4
    }

    public var bar: CGRect
    public var label: CGRect

    public init(caret: CGRect, name: CGSize, width: CGFloat) {
        typealias M = Metrics
        bar = CGRect(x: caret.minX - M.bar / 2, y: caret.minY, width: M.bar, height: caret.height)
        let labelWidth = min(name.width + M.labelPadding * 2, max(0, width))
        let x = min(bar.minX, max(0, width - labelWidth))
        label = CGRect(x: x, y: caret.minY - M.label, width: labelWidth, height: M.label)
    }
}
