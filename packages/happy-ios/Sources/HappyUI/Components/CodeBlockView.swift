#if canImport(UIKit)
import HappyLayout
import UIKit

/// components/CodeView.tsx as info.tsx places it in a group: Menlo 12/18 on
/// `surfaceHigh`, radius 6, padding 12, inset 16 with 12 below.
///
/// A raw JSON block runs to megabytes in a long session (its agent state
/// keeps every request), so the code is cut into pieces (`TextChunks`) and
/// laid out off the main thread (AGENTS.md rule 8); only the pieces near
/// the screen are drawn. A new `code` lays out again only the pieces whose
/// text changed. Until the first layout is in, the box is empty.
final class CodeBlockView: UIView {
    var code: String {
        didSet { if code != oldValue { requestPlan() } }
    }

    private let box = UIView()
    private let measure = OffMainPlan<CodeBlockInput, CodeBlockPlan>(reusing: CodeBlockPlan.init)
    /// The width the list measured it at last.
    private var width: CGFloat?
    private var shownPieces: [Int: ChatTextView] = [:]
    private var sparePieces: [ChatTextView] = []
    private weak var observedScrollView: UIScrollView?
    private var offsetObservation: NSKeyValueObservation?

    init(code: String) {
        self.code = code
        super.init(frame: .zero)
        box.backgroundColor = UIColor(Palette.surfaceHigh)
        box.layer.cornerRadius = CodeBlockLayout.Metrics.cornerRadius
        addSubview(box)
        measure.onApply = { [weak self] in self?.planApplied() }
        registerForTraitChanges(UIView.textSizeTraits + [UITraitDisplayScale.self]) { (self: Self, _) in
            self.requestPlan()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Asks for the code laid out at `width` and returns the layout taken
    /// last; before the first, an empty box.
    func layout(width: CGFloat) -> CodeBlockLayout {
        if self.width != width {
            self.width = width
            requestPlan()
        }
        return currentLayout(width: width)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // Placed where it was measured: a frame snapped to the screen's
        // pixels asks for nothing new.
        if width == nil { _ = layout(width: bounds.width) }
        box.setLayoutFrame(currentLayout(width: bounds.width).box)
        updatePieces()
    }

    private func currentLayout(width: CGFloat) -> CodeBlockLayout {
        measure.plan?.layout(width: width) ?? CodeBlockLayout(width: width, pieces: [])
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        observeEnclosingScrollView()
        updatePieces()
    }

    /// Returns once the layout for the code, width and text size asked for
    /// last is in (tests).
    func measured() async {
        await measure.measured()
    }

    /// The pieces drawn now, by index (tests).
    var drawnPieces: [Int] { shownPieces.keys.sorted() }

    // MARK: Measuring

    private func requestPlan() {
        guard let width else { return }
        measure.request(CodeBlockInput(code: code, width: width, text: traitCollection.measuredTextEnvironment))
    }

    private func planApplied() {
        setNeedsLayoutUpTheTree()
    }

    // MARK: Drawing near the screen

    /// Draws the pieces within a screen's height of what the window shows,
    /// and lets go of the rest.
    private func updatePieces() {
        guard let plan = measure.plan, plan.fits(bounds.width), let window else {
            for view in shownPieces.values { recycle(view) }
            shownPieces = [:]
            return
        }
        let visible = bounds.intersection(convert(window.bounds, from: window))
        let margin = window.bounds.height
        let wanted = visible.isNull ? 0..<0 : plan.layout.pieces(from: visible.minY - margin, to: visible.maxY + margin)
        for (index, view) in shownPieces where !wanted.contains(index) {
            recycle(view)
            shownPieces[index] = nil
        }
        for index in wanted {
            let view = shownPieces[index] ?? sparePieces.popLast() ?? ChatTextView()
            if view.superview !== self { addSubview(view) }
            shownPieces[index] = view
            // A piece kept from the last plan is neither moved nor redrawn.
            view.setLayoutFrame(plan.layout.pieces[index])
            view.layout = plan.pieces[index].layout
        }
    }

    private func recycle(_ view: ChatTextView) {
        view.removeFromSuperview()
        view.layout = nil
        sparePieces.append(view)
    }

    private func observeEnclosingScrollView() {
        var ancestor = superview
        while let view = ancestor, !(view is UIScrollView) { ancestor = view.superview }
        let enclosing = ancestor as? UIScrollView
        guard enclosing !== observedScrollView else { return }
        offsetObservation = nil
        observedScrollView = enclosing
        offsetObservation = enclosing?.observe(\.contentOffset, options: []) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.updatePieces() }
        }
    }
}

/// What a code block is laid out for.
struct CodeBlockInput: Equatable, Sendable {
    var code: String
    var width: CGFloat
    var text: TextEnvironment
}

/// A code block laid out at one width, piece by piece.
struct CodeBlockPlan: Sendable {
    struct Piece: Sendable {
        /// What the piece draws (`TextChunks.drawn`).
        let text: String
        let layout: ChatTextLayout
    }

    let width: CGFloat
    let text: TextEnvironment
    let pieces: [Piece]
    let layout: CodeBlockLayout

    /// Off the main thread. A piece whose text is in `taken`, made at the
    /// same width and text size, keeps its layout.
    init(_ input: CodeBlockInput, reusing taken: CodeBlockPlan?) {
        let textWidth = CodeBlockLayout.textWidth(input.width)
        var kept: [String: ChatTextLayout] = [:]
        if let taken, taken.text == input.text, CodeBlockLayout.textWidth(taken.width) == textWidth {
            for piece in taken.pieces { kept[piece.text] = piece.layout }
        }
        let chunks = TextChunks.split(input.code)
        pieces = chunks.enumerated().map { index, chunk in
            let drawn = index == chunks.count - 1 ? chunk : TextChunks.drawn(chunk)
            let layout = kept[drawn] ?? ChatTextLayout(ChatTextStyles.codeView.string(drawn, color: Palette.text, in: input.text), width: textWidth)
            return Piece(text: drawn, layout: layout)
        }
        width = input.width
        text = input.text
        layout = CodeBlockLayout(width: input.width, pieces: pieces.map(\.layout.size.height))
    }

    /// Whether it is laid out for a frame `width` wide, to the pixel.
    func fits(_ width: CGFloat) -> Bool {
        abs(width - self.width) < 0.5
    }

    /// The layout at `width`: this plan's, or while one for a new width is
    /// on its way, a box as tall as this one's.
    func layout(width: CGFloat) -> CodeBlockLayout {
        fits(width) ? layout : CodeBlockLayout(width: width, pieces: [layout.text.height])
    }
}
#endif
