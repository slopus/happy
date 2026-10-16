#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import UIKit

/// DiffFileView.tsx's props, less the callbacks.
struct DiffViewOptions: Equatable, Sendable {
    var fontSize: CGFloat = DiffMetrics.defaultFontSize
    var showLineNumbers = true
    /// Draw the `@@` separators between hunks.
    var showHunkHeaders = true
    /// Rows drawn before "Show N more lines".
    var collapseAfter = 400
    var paddingVertical: CGFloat = 0
    /// Whether "N unchanged" separators can be tapped: only owners that can
    /// fetch a wider diff (`onExpandContext`) say yes.
    var canExpandContext = false
    /// RN's `selectable` on the code lines: a long press offers Copy for
    /// that line. Off by default, as in DiffFileView.tsx.
    var selectable = false
}

/// One file's diff, measured and ready to draw: the rows on show after the
/// collapse, syntax-coloured, and every frame. Built off the main thread;
/// immutable, so it crosses to the view as is.
final class DiffFilePlan: @unchecked Sendable {
    let file: DiffFile
    let rows: [DiffRow]
    let hiddenCount: Int
    let options: DiffViewOptions
    /// The text size it was measured at; nil is the designed size.
    let text: TextEnvironment?
    let metrics: DiffMetrics
    let layout: DiffFileLayout
    let expanded: Bool
    /// "Show more" would tokenize hunks first: its bar shows a spinner
    /// while the owner plans again (useSyntaxExpansion).
    let expansionNeedsSyntax: Bool

    /// When a plan made now stops starting colour work: the first paint's
    /// second (`SYNTAX_REVEAL_MS`), or the deadline of the pass it is made
    /// in (`SyntaxPass`), so the chat's rows share one second. The budget
    /// is cooperative: it is checked between hunks, and a hunk already
    /// tokenizing runs to its end.
    static func syntaxDeadline() -> ContinuousClock.Instant {
        SyntaxPass.deadline()
    }

    /// `expanded` is the reader's "show more" (DiffFileView's own state).
    /// The shown rows take their hunks' syntax colour (usePreparedSyntax):
    /// cached hunks at once, missing ones tokenized here while
    /// `syntaxDeadline` hasn't passed, the rest left plain and tokenized in
    /// the background for the next plan. The deadline is only checked
    /// before each hunk, so a plan can run past it by one hunk's tokenize.
    /// Plans for one screen share a deadline, as happy-app's rows reveal
    /// together; nil plans no colour, as a measurement pass does.
    /// `syntax` is the account's: its cache, its background queue.
    /// `text` is the text size the view draws at (its traits'
    /// `textEnvironment`); nil, the designed size.
    init(
        file: DiffFile,
        width: CGFloat,
        syntax: DiffSyntaxService,
        options: DiffViewOptions = DiffViewOptions(),
        expanded: Bool = false,
        syntaxDeadline: ContinuousClock.Instant? = DiffFilePlan.syntaxDeadline(),
        text: TextEnvironment? = nil
    ) {
        let selection = DiffRowSelection.select(file.rows, showHunkHeaders: options.showHunkHeaders, expanded: expanded, collapseAfter: options.collapseAfter)
        let metrics = DiffStyle.metrics(fontSize: options.fontSize, text: text)
        self.file = file
        rows = syntaxDeadline.map { syntax.colour(file, displayed: selection.rows, until: $0) } ?? selection.rows
        hiddenCount = selection.hiddenCount
        expansionNeedsSyntax = syntaxDeadline != nil && selection.hiddenCount > 0 && syntax.isMissing(file, rows: file.rows)
        self.options = options
        self.text = text
        self.metrics = metrics
        self.expanded = expanded
        layout = DiffFileLayout(.init(
            width: width,
            metrics: metrics,
            rowCount: selection.rows.count,
            hiddenCount: selection.hiddenCount,
            maxColumns: file.maxColumns,
            maxLineNo: file.maxLineNo,
            showLineNumbers: options.showLineNumbers,
            paddingVertical: options.paddingVertical,
            showMoreTextHeight: DiffStyle.lineHeight(DiffTextStyles.showMore.scaled(metrics.scale))
        ))
    }

    var height: CGFloat { layout.height }
}

/// components/diff/DiffFileView.tsx's scroll layout: code under a
/// horizontal scroll, line numbers and markers in a gutter pinned over its
/// left edge, then "Show N more lines" when rows are held back.
///
/// Rows are views only while they are near the screen: the view watches the
/// scroll view it sits in and keeps a screen of rows either side, so a
/// file of thousands of lines costs what a screenful does. A long line
/// draws only the stretch of it near the visible part of the scroll.
///
/// Its owner measures (`DiffFilePlan`), so the owner also answers "show
/// more" and context taps, by planning again.
final class DiffFileView: UIView, UIScrollViewDelegate, UIGestureRecognizerDelegate, UIEditMenuInteractionDelegate {
    /// "Show N more lines": plan again with `expanded`.
    var onShowMore: (() -> Void)?
    /// An "N unchanged" separator was tapped (`canExpandContext`).
    var onExpandContext: (() -> Void)?

    private(set) var plan: DiffFilePlan?

    private let scrollView = UIScrollView()
    private let canvas = UIView()
    private let gutter = UIView()
    private let showMore = DiffShowMoreBar()
    private var codeRows: [Int: DiffCodeRowView] = [:]
    private var gutterRows: [Int: DiffGutterRowView] = [:]
    private var spareCode: [DiffCodeRowView] = []
    private var spareGutter: [DiffGutterRowView] = []
    private var shownRows: Range<Int> = 0..<0
    private var offsetObservation: NSKeyValueObservation?
    private weak var observedScrollView: UIScrollView?
    private let longPress = UILongPressGestureRecognizer()
    private lazy var editMenu = UIEditMenuInteraction(delegate: self)
    /// The line a long press offered Copy for.
    private var copyText: String?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(DiffStyle.surface)
        clipsToBounds = true
        scrollView.delegate = self
        scrollView.alwaysBounceVertical = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.scrollsToTop = false
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.addSubview(canvas)
        addSubview(scrollView)
        gutter.backgroundColor = UIColor(DiffStyle.surface)
        gutter.isUserInteractionEnabled = false
        addSubview(gutter)
        showMore.addTarget(self, action: #selector(showMoreTapped), for: .touchUpInside)
        addSubview(showMore)
        canvas.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(canvasTapped(_:))))
        longPress.addTarget(self, action: #selector(canvasLongPressed(_:)))
        longPress.delegate = self
        longPress.isEnabled = false
        canvas.addGestureRecognizer(longPress)
        addInteraction(editMenu)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.redrawRows()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func apply(_ plan: DiffFilePlan) {
        guard plan !== self.plan else { return }
        let keepOffset = self.plan?.file.path == plan.file.path
        self.plan = plan
        showMore.isBusy = false
        longPress.isEnabled = plan.options.selectable
        copyText = nil
        for index in Array(codeRows.keys) { recycle(index) }
        shownRows = 0..<0
        if !keepOffset { scrollView.contentOffset = .zero }
        showMore.text = Strings.DiffDetail.showMoreLines(plan.hiddenCount)
        showMore.textStyle = DiffTextStyles.showMore.scaled(plan.metrics.scale)
        setNeedsLayout()
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        CGSize(width: size.width, height: plan?.height ?? 0)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let plan else { return }
        let layout = plan.layout
        scrollView.setLayoutFrame(layout.scroll)
        scrollView.contentSize = layout.scrollContentSize
        scrollView.isScrollEnabled = layout.scrollable
        scrollView.showsHorizontalScrollIndicator = layout.scrollable
        let maxOffset = max(0, layout.scrollContentSize.width - layout.scroll.width)
        if scrollView.contentOffset.x > maxOffset { scrollView.contentOffset.x = maxOffset }
        canvas.frame = layout.canvas
        gutter.frame = layout.gutter
        if let bar = layout.showMore, let content = layout.showMoreContent(textWidth: showMore.textWidth, busy: showMore.isBusy) {
            showMore.isHidden = false
            showMore.frame = bar
            showMore.textFrame = content.text
            showMore.spinnerFrame = content.spinner ?? .zero
        } else {
            showMore.isHidden = true
        }
        updateRows()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        observeEnclosingScrollView()
        setNeedsLayout()
    }

    override func didMoveToSuperview() {
        super.didMoveToSuperview()
        observeEnclosingScrollView()
    }

    /// Recomputes which rows are near the screen. The view does this itself
    /// when the scroll view it sits in moves; owners that move it some other
    /// way call it.
    func updateRows() {
        guard let plan, window != nil else { return }
        let layout = plan.layout
        let visible = visibleBounds()
        let margin = window?.bounds.height ?? 800
        let wanted = visible.isEmpty
            ? 0..<0
            : layout.rows(from: visible.minY - margin - layout.canvas.minY, to: visible.maxY + margin - layout.canvas.minY)
        if wanted != shownRows {
            for index in Array(codeRows.keys) where !wanted.contains(index) { recycle(index) }
            for index in wanted where codeRows[index] == nil { show(index, plan: plan) }
            shownRows = wanted
        }
        updateTextWindows()
    }

    /// This view's bounds that the window shows.
    private func visibleBounds() -> CGRect {
        guard let window else { return .zero }
        return bounds.intersection(convert(window.bounds, from: window))
    }

    private func show(_ index: Int, plan: DiffFilePlan) {
        let layout = plan.layout
        let row = plan.rows[index]
        let code = spareCode.popLast() ?? DiffCodeRowView()
        code.configure(row, plan: plan)
        code.frame = layout.row(index)
        canvas.addSubview(code)
        codeRows[index] = code

        let gutterRow = spareGutter.popLast() ?? DiffGutterRowView()
        gutterRow.configure(row, plan: plan)
        gutterRow.frame = layout.gutterRow(index)
        gutter.addSubview(gutterRow)
        gutterRows[index] = gutterRow
    }

    private func recycle(_ index: Int) {
        if let code = codeRows.removeValue(forKey: index) {
            code.removeFromSuperview()
            spareCode.append(code)
        }
        if let gutterRow = gutterRows.removeValue(forKey: index) {
            gutterRow.removeFromSuperview()
            spareGutter.append(gutterRow)
        }
    }

    private func redrawRows() {
        for row in codeRows.values { row.redraw() }
        for row in gutterRows.values { row.setNeedsDisplay() }
    }

    /// The part of the canvas the horizontal scroll shows, for long lines.
    private func updateTextWindows() {
        guard let plan else { return }
        let left = scrollView.contentOffset.x - plan.layout.gutterWidth
        let visible = left...(left + bounds.width)
        for row in codeRows.values { row.updateWindow(visible: visible, margin: bounds.width) }
    }

    // MARK: Scrolling

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        updateTextWindows()
    }

    private func observeEnclosingScrollView() {
        var ancestor = superview
        while let view = ancestor, !(view is UIScrollView) { ancestor = view.superview }
        let enclosing = ancestor as? UIScrollView
        guard enclosing !== observedScrollView else { return }
        offsetObservation = nil
        observedScrollView = enclosing
        offsetObservation = enclosing?.observe(\.contentOffset, options: []) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.updateRows() }
        }
    }

    // MARK: Taps

    @objc private func showMoreTapped() {
        guard let plan, !showMore.isBusy else { return }
        // Rows already painted stay while the expansion is coloured; the
        // owner's next plan clears the spinner.
        if plan.expansionNeedsSyntax {
            showMore.isBusy = true
            setNeedsLayout()
        }
        onShowMore?()
    }

    @objc private func canvasTapped(_ recognizer: UITapGestureRecognizer) {
        guard let plan, plan.options.canExpandContext, let onExpandContext,
              let index = plan.layout.rowIndex(at: recognizer.location(in: canvas).y),
              case .hunk(let hunk) = plan.rows[index], hunk.hidden != nil else { return }
        onExpandContext()
    }

    // MARK: Copy

    /// The selectable line under a press in the canvas, if any.
    private func selectableText(at point: CGPoint) -> String? {
        guard let plan, plan.options.selectable, let index = plan.layout.rowIndex(at: point.y) else { return nil }
        return plan.rows[index].selectableText
    }

    /// Only a press on a code line starts, so hunk taps are unaffected.
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === longPress else { return super.gestureRecognizerShouldBegin(gestureRecognizer) }
        return selectableText(at: longPress.location(in: canvas)) != nil
    }

    /// RCTParagraphComponentView's long press: the edit menu at the touch,
    /// whose Copy takes the whole line.
    @objc private func canvasLongPressed(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began, let text = selectableText(at: recognizer.location(in: canvas)) else { return }
        copyText = text
        // Copy is found through the responder chain, which starts here.
        becomeFirstResponder()
        editMenu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: recognizer.location(in: self)))
    }

    override var canBecomeFirstResponder: Bool { plan?.options.selectable == true }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(copy(_:)) { return copyText != nil && plan?.options.selectable == true }
        return super.canPerformAction(action, withSender: sender)
    }

    override func copy(_ sender: Any?) {
        guard let copyText else { return }
        UIPasteboard.general.string = copyText
    }
}

/// The scrolling half of a row: its background across the canvas, and its
/// text. Short text is drawn whole; a long line draws only a window of it.
private final class DiffCodeRowView: UIView {
    private let textView = DiffTextDrawingView()
    private var text = NSAttributedString()
    private var textWidth: CGFloat = 0
    /// Where the text starts in the row.
    private var textX: CGFloat = 0
    /// Lines longer than this draw in windows.
    private var windowed = false
    private var charWidth: CGFloat = 0
    private var drawnWindow: ClosedRange<CGFloat>?

    /// Past this, a line is drawn a window at a time.
    static let wholeLineLimit: CGFloat = 2048

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        addSubview(textView)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func configure(_ row: DiffRow, plan: DiffFilePlan) {
        let metrics = plan.metrics
        let layout = plan.layout
        charWidth = metrics.charWidth
        drawnWindow = nil
        switch row {
        case .line(let line):
            backgroundColor = UIColor(DiffStyle.rowBackground(line.type))
            text = DiffStyle.lineText(line.spans, metrics: metrics)
            textX = DiffFileLayout.Metrics.codePaddingLeft
            let estimate = CGFloat(line.text.utf16.count + 1) * metrics.charWidth
            windowed = estimate > Self.wholeLineLimit
            textWidth = windowed ? estimate : DiffStyle.size(text).width
        case .hunk(let hunk):
            backgroundColor = UIColor(DiffStyle.hunkBackground)
            text = DiffStyle.hunkText(hunk, canExpand: plan.options.canExpandContext, metrics: metrics)
            textX = 0
            windowed = false
            textWidth = min(DiffStyle.size(text).width, layout.contentWidth)
        case .message(_, let code):
            backgroundColor = nil
            text = DiffStyle.messageText(code, metrics: metrics)
            textX = 0
            windowed = false
            textWidth = min(DiffStyle.size(text).width, layout.contentWidth)
        }
        if windowed {
            textView.isHidden = true
        } else {
            textView.isHidden = false
            textView.text = text
            textView.frame = CGRect(x: textX, y: 0, width: textWidth, height: metrics.lineHeight)
        }
    }

    func redraw() {
        textView.setNeedsDisplay()
    }

    /// `visible` is in canvas coordinates.
    func updateWindow(visible: ClosedRange<CGFloat>, margin: CGFloat) {
        guard windowed, charWidth > 0 else { return }
        let local = (visible.lowerBound - textX)...(visible.upperBound - textX)
        guard let span = DiffTextWindow.span(textWidth: textWidth, visible: local, margin: margin) else {
            textView.isHidden = true
            drawnWindow = nil
            return
        }
        guard span != drawnWindow else { return }
        drawnWindow = span
        let units = text.length
        var start = min(units, Int((span.lowerBound / charWidth).rounded(.down)))
        var end = min(units, Int((span.upperBound / charWidth).rounded(.up)))
        let string = text.string as NSString
        if start > 0, start < units { start = string.rangeOfComposedCharacterSequence(at: start).location }
        if end > 0, end < units {
            let range = string.rangeOfComposedCharacterSequence(at: end)
            if range.location < end { end = range.location + range.length }
        }
        guard end > start else {
            textView.isHidden = true
            return
        }
        textView.isHidden = false
        textView.text = text.attributedSubstring(from: NSRange(location: start, length: end - start))
        textView.frame = CGRect(x: textX + CGFloat(start) * charWidth, y: 0, width: CGFloat(end - start + 1) * charWidth, height: bounds.height)
    }
}

/// The pinned half of a row: the line number, right-aligned, and the
/// change marker centred after it; or a hunk's dots.
private final class DiffGutterRowView: UIView {
    private var number: NSAttributedString?
    private var marker: NSAttributedString?
    private var dots: NSAttributedString?
    private var numberFrame: CGRect = .zero
    private var markerFrame: CGRect = .zero
    private var dotsFrame: CGRect = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        isUserInteractionEnabled = false
        contentMode = .redraw
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func configure(_ row: DiffRow, plan: DiffFilePlan) {
        let metrics = plan.metrics
        let layout = plan.layout
        number = nil
        marker = nil
        dots = nil
        switch row {
        case .line(let line):
            backgroundColor = UIColor(DiffStyle.gutterBackground(line.type))
            if let frame = layout.lineNumber, let value = line.type == .del ? line.oldNo : line.newNo {
                number = DiffStyle.small(metrics).attributedString(String(value), color: UIColor(DiffStyle.lineNumber), alignment: .right, lineBreakMode: .byClipping)
                numberFrame = frame
            }
            let symbol = line.type == .add ? "+" : line.type == .del ? "−" : ""
            if !symbol.isEmpty {
                marker = DiffStyle.code(metrics).attributedString(symbol, color: UIColor(DiffStyle.marker(line.type)), alignment: .center, lineBreakMode: .byClipping)
                markerFrame = layout.marker
            }
        case .hunk:
            backgroundColor = UIColor(DiffStyle.hunkBackground)
            let style = DiffStyle.dots(metrics)
            dots = style.attributedString("···", color: UIColor(DiffStyle.hunkText), lineBreakMode: .byClipping)
            // Centred in the row at the font's own line height.
            let height = DiffStyle.lineHeight(style)
            let frame = layout.hunkDots
            dotsFrame = CGRect(x: frame.minX, y: (frame.height - height) / 2, width: frame.width, height: height)
        case .message:
            backgroundColor = nil
        }
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        number?.draw(with: numberFrame, options: [.usesLineFragmentOrigin], context: nil)
        marker?.draw(with: markerFrame, options: [.usesLineFragmentOrigin], context: nil)
        dots?.draw(with: dotsFrame, options: [.usesLineFragmentOrigin], context: nil)
    }
}

/// Draws one attributed line at its top-left.
private final class DiffTextDrawingView: UIView {
    var text = NSAttributedString() {
        didSet { setNeedsDisplay() }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        isUserInteractionEnabled = false
        contentMode = .redraw
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func draw(_ rect: CGRect) {
        text.draw(with: bounds, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
    }
}

/// DiffFileView.tsx's "Show N more lines": a 1pt divider over a `hunkBg`
/// bar, semibold 13 centred. It draws at its plan's text size, not its
/// traits', so a size change redraws it with the plan that measured it.
final class DiffShowMoreBar: UIControl {
    var text = "" {
        didSet {
            label.string = text
            setNeedsLayout()
        }
    }

    /// The plan's style, already scaled.
    var textStyle = DiffTextStyles.showMore {
        didSet {
            label.style = textStyle
            setNeedsLayout()
        }
    }

    var textFrame: CGRect = .zero {
        didSet { setNeedsLayout() }
    }

    var spinnerFrame: CGRect = .zero {
        didSet { setNeedsLayout() }
    }

    /// Waiting for the expansion's colour: a spinner before the text, and
    /// taps ignored.
    var isBusy = false {
        didSet {
            guard isBusy != oldValue else { return }
            isEnabled = !isBusy
            spinner.isHidden = !isBusy
            if isBusy { spinner.startAnimating() } else { spinner.stopAnimating() }
            accessibilityTraits = isBusy ? [.button, .notEnabled, .updatesFrequently] : .button
        }
    }

    private let border = UIView()
    private let label = StyledLabel(style: DiffTextStyles.showMore, color: DiffStyle.hunkText, lines: 1)
    private let spinner = UIActivityIndicatorView(style: .medium)

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(DiffStyle.hunkBackground)
        border.backgroundColor = UIColor(DiffStyle.divider)
        border.isUserInteractionEnabled = false
        label.isUserInteractionEnabled = false
        label.traitOverrides.followsTextSize = false
        spinner.color = UIColor(DiffStyle.hunkText)
        spinner.isHidden = true
        spinner.isUserInteractionEnabled = false
        addSubview(border)
        addSubview(label)
        addSubview(spinner)
        accessibilityTraits = .button
        isAccessibilityElement = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// The label's unconstrained width.
    var textWidth: CGFloat {
        label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)).width
    }

    override var accessibilityLabel: String? {
        get { text }
        set {}
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        border.setLayoutFrame(CGRect(x: 0, y: 0, width: bounds.width, height: DiffFileLayout.Metrics.showMoreBorder))
        label.setLayoutFrame(textFrame)
        spinner.frame = spinnerFrame
    }
}
#endif
