#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import UIKit

/// The file viewer's content measured for one width and text size: each
/// line's text, colours and wrapped height. Built away from the main
/// thread.
final class FileLinesPlan: @unchecked Sendable {
    enum Source: Equatable, Sendable {
        /// DiffDisplay over `git diff` output.
        case diff(String)
        /// SimpleSyntaxHighlighter over the file.
        case code(String, language: String?)
    }

    struct Row {
        var text: NSAttributedString
        var background: ColorToken?
        var bar: ColorToken?
    }

    let source: Source
    let width: CGFloat
    let maxWidth: CGFloat
    /// The text size it was measured at; nil is the designed size.
    let text: TextEnvironment?
    let rows: [Row]
    let layout: FileLinesLayout
    /// The code is drawn plain while the account's syntax colours it; plan
    /// again after its next signal.
    let syntaxPending: Bool

    /// `syntax`: the account's code colour. A file past its limits stays
    /// plain. `text` is the text size the screen draws at (nil, the
    /// designed size): the mono 14 on its 20 line grow with it, the
    /// paddings and the diff's bar keep their size.
    init(source: Source, width: CGFloat, maxWidth: CGFloat, syntax: CodeSyntaxService, text: TextEnvironment? = nil) {
        self.source = source
        self.width = width
        self.maxWidth = maxWidth
        self.text = text
        let styles = Styles(text)
        let insets: FileLinesLayout.RowInsets
        switch source {
        case .diff(let diff):
            insets = .diff
            rows = FileViewer.diffLines(diff).map { Self.diffRow($0.text, $0.kind, styles: styles) }
            syntaxPending = false
        case .code(let content, let language):
            insets = .code
            let outcome = syntax.tokens(content, language: language)
            let tokens: [SyntaxToken]
            if case .highlighted(let coloured) = outcome {
                tokens = coloured
            } else {
                tokens = [SyntaxToken(content, .plain)]
            }
            rows = FileViewer.codeLines(tokens).map { Row(text: Self.codeText($0, styles: styles)) }
            syntaxPending = outcome == .pending
        }
        let plain = FileLinesLayout.textWidth(width: width, maxWidth: maxWidth, insets: insets, bar: false)
        let barred = FileLinesLayout.textWidth(width: width, maxWidth: maxWidth, insets: insets, bar: true)
        let heights = rows.map { Self.height($0.text, width: $0.bar == nil ? plain : barred, styles: styles) }
        layout = FileLinesLayout(width: width, maxWidth: maxWidth, insets: insets, textHeights: heights, bars: rows.map { $0.bar != nil })
    }

    // MARK: Rows

    /// The two faces at the plan's text size, their line and their advance.
    private struct Styles {
        let code: TextStyle
        let codeBold: TextStyle
        let line: CGFloat
        let advance: CGFloat?
        let displayScale: CGFloat

        init(_ text: TextEnvironment?) {
            let scale = DiffStyle.textScale(text)
            code = FileViewerTextStyles.code.scaled(scale)
            codeBold = FileViewerTextStyles.codeBold.scaled(scale)
            line = code.lineHeightValue
            advance = FileLinesPlan.advance(code, codeBold)
            displayScale = text?.displayScale ?? 0
        }
    }

    /// DiffDisplay's colours by line.
    private static func diffRow(_ text: String, _ kind: FileViewer.DiffLineKind, styles: Styles) -> Row {
        let color: ColorToken
        var background: ColorToken?
        var bar: ColorToken?
        switch kind {
        case .added:
            color = DiffPalette.addedText
            background = DiffPalette.addedBackground
            bar = DiffPalette.addedBorder
        case .removed:
            color = DiffPalette.removedText
            background = DiffPalette.removedBackground
            bar = DiffPalette.removedBorder
        case .hunk:
            color = DiffPalette.hunkText
            background = DiffPalette.hunkBackground
        case .fileHeader:
            color = Palette.text
        case .context:
            color = DiffPalette.contextText
        }
        let style = kind.isBold ? styles.codeBold : styles.code
        return Row(text: style.attributedString(text, color: UIColor(color)), background: background, bar: bar)
    }

    private static func codeText(_ tokens: [SyntaxToken], styles: Styles) -> NSAttributedString {
        let result = NSMutableAttributedString()
        for token in tokens {
            let style = token.isBold ? styles.codeBold : styles.code
            result.append(style.attributedString(token.text, color: UIColor(FileSyntax.color(token))))
        }
        return result
    }

    // MARK: Measuring

    private static let lock = NSLock()
    nonisolated(unsafe) private static var advances: [CGFloat: CGFloat?] = [:]

    /// The mono advance at a size, when the regular and semibold faces
    /// share it; lines of plain ASCII that clearly fit then skip measuring.
    /// Measured once per size.
    private static func advance(_ code: TextStyle, _ codeBold: TextStyle) -> CGFloat? {
        lock.lock()
        if let advance = advances[code.size] {
            lock.unlock()
            return advance
        }
        lock.unlock()
        let sample = String(repeating: "M", count: 50) as NSString
        let regular = sample.size(withAttributes: [.font: code.font]).width / 50
        let bold = sample.size(withAttributes: [.font: codeBold.font]).width / 50
        let advance: CGFloat? = regular > 0 && abs(regular - bold) < 0.001 ? regular : nil
        lock.lock()
        advances[code.size] = advance
        lock.unlock()
        return advance
    }

    /// A line's height wrapped at `width`: whole lines, one at least, up
    /// to the screen's next pixel.
    private static func height(_ text: NSAttributedString, width: CGFloat, styles: Styles) -> CGFloat {
        func box(_ measured: CGFloat) -> CGFloat {
            FileLinesLayout.textHeight(measured: measured, line: styles.line, displayScale: styles.displayScale)
        }
        guard text.length > 0 else { return box(0) }
        if let advance = styles.advance, FileLinesLayout.fitsOneLine(text.string, advance: advance, width: width) { return box(0) }
        let rect = text.boundingRect(with: CGSize(width: max(1, width), height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin], context: nil)
        return box(rect.height)
    }
}

/// SimpleSyntaxHighlighter.tsx's `getColors`, by token.
enum FileSyntax {
    static func color(_ token: SyntaxToken) -> ColorToken {
        switch token.kind {
        case .keyword, .controlFlow, .type, .modifier, .assignment, .comparison, .logical, .decorator, .import:
            Palette.syntaxKeyword
        case .string, .regex:
            Palette.syntaxString
        case .number, .boolean:
            Palette.syntaxNumber
        case .function, .method:
            Palette.syntaxFunction
        case .comment, .docstring:
            Palette.syntaxComment
        case .bracket:
            // Levels 1-4, then 5, 10, 15 take the fifth colour.
            switch (token.nestLevel ?? 1) % 5 {
            case 2: Palette.syntaxBracket2
            case 3: Palette.syntaxBracket3
            case 4: Palette.syntaxBracket4
            case 0: Palette.syntaxBracket5
            default: Palette.syntaxBracket1
            }
        case .property, .operator, .punctuation, .plain:
            Palette.syntaxDefault
        }
    }
}

/// file.tsx's ScrollView: the plan's rows, made as views only near the
/// visible part, or one message in their place. With `copyText` set, a long
/// press on the text offers Copy for all of it, as a selectable Text does.
final class FileLinesView: UIScrollView, UIEditMenuInteractionDelegate {
    private(set) var plan: FileLinesPlan?
    /// What Copy puts on the pasteboard; nil leaves the text unselectable.
    var copyText: String?

    private let message = StyledLabel(style: FileViewerTextStyles.message, color: Palette.textSecondary)
    private var maxWidth = CGFloat.greatestFiniteMagnitude
    private var visible: [Int: FileLineRowView] = [:]
    private var spare: [FileLineRowView] = []
    private lazy var editMenu = UIEditMenuInteraction(delegate: self)

    /// Rows are made this far past either edge, so a fling meets drawn text.
    static let overscan: CGFloat = 400

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        alwaysBounceVertical = true
        contentInsetAdjustmentBehavior = .never
        message.isHidden = true
        addSubview(message)
        addInteraction(editMenu)
        addGestureRecognizer(UILongPressGestureRecognizer(target: self, action: #selector(longPressed(_:))))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Shows a plan's rows; the same plan keeps the views it has.
    func show(_ plan: FileLinesPlan) {
        message.isHidden = true
        guard plan !== self.plan else { return }
        self.plan = plan
        for row in visible.values { recycle(row) }
        visible = [:]
        contentSize = plan.layout.contentSize
        setNeedsLayout()
    }

    /// Shows "File is empty" / "No changes to display" instead of rows.
    func show(message text: String, maxWidth: CGFloat) {
        plan = nil
        for row in visible.values { recycle(row) }
        visible = [:]
        self.maxWidth = maxWidth
        message.string = text
        message.isHidden = false
        setNeedsLayout()
    }

    /// Nothing at all: the diff was asked for and there is none.
    func clear() {
        plan = nil
        for row in visible.values { recycle(row) }
        visible = [:]
        message.isHidden = true
        contentSize = .zero
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if !message.isHidden {
            let placed = FileLinesLayout.message(width: bounds.width, maxWidth: maxWidth, text: message.measurable)
            message.setLayoutFrame(placed.frame)
            contentSize = placed.contentSize
            return
        }
        guard let plan else { return }
        let layout = plan.layout
        let range = layout.rows(from: bounds.minY - Self.overscan, to: bounds.maxY + Self.overscan)
        for (index, row) in visible where !range.contains(index) {
            recycle(row)
            visible[index] = nil
        }
        for index in range where visible[index] == nil {
            let row = spare.popLast() ?? FileLineRowView()
            row.apply(plan.rows[index], text: layout.text(index), bar: layout.bar(index))
            row.frame = layout.row(index)
            row.isHidden = false
            if row.superview == nil { insertSubview(row, at: 0) }
            visible[index] = row
        }
    }

    private func recycle(_ row: FileLineRowView) {
        row.isHidden = true
        spare.append(row)
    }

    // MARK: Copy

    @objc private func longPressed(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began, copyText != nil, let plan else { return }
        let location = gesture.location(in: self)
        guard plan.layout.block.contains(location) else { return }
        // The menu's Copy comes from the responder chain, which starts here.
        becomeFirstResponder()
        editMenu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: location))
    }

    override var canBecomeFirstResponder: Bool { copyText != nil }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(copy(_:)) { return copyText != nil }
        return super.canPerformAction(action, withSender: sender)
    }

    override func copy(_ sender: Any?) {
        guard let copyText else { return }
        UIPasteboard.general.string = copyText
    }
}

/// One line: its background, the diff bar, and the wrapped text.
private final class FileLineRowView: UIView {
    private let bar = UIView()
    private var text = NSAttributedString()
    private var textFrame = CGRect.zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        isUserInteractionEnabled = false
        contentMode = .redraw
        addSubview(bar)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.setNeedsDisplay()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func apply(_ row: FileLinesPlan.Row, text frame: CGRect, bar barFrame: CGRect?) {
        text = row.text
        textFrame = frame
        backgroundColor = row.background.map { UIColor($0) }
        if let barFrame, let color = row.bar {
            bar.backgroundColor = UIColor(color)
            bar.frame = barFrame
            bar.isHidden = false
        } else {
            bar.isHidden = true
        }
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        text.draw(with: textFrame, options: [.usesLineFragmentOrigin], context: nil)
    }
}
#endif
