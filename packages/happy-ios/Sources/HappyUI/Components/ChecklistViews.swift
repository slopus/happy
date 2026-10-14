#if canImport(UIKit)
import HappyLayout
import UIKit

/// components/onboarding/TerminalBlock.tsx: shell lines in the website's
/// terminal colours, dark in both appearances. Every line can be selected
/// and copied; a command's `$ ` prompt can't (`selectable={false}`).
public final class TerminalBlockView: UIView {
    public enum Line: Equatable {
        /// Drawn after a green `$ ` prompt.
        case command(String)
        case comment(String)
    }

    let lines: [TerminalLineView]

    public init(lines: [Line]) {
        self.lines = lines.map(TerminalLineView.init(line:))
        super.init(frame: .zero)
        backgroundColor = UIColor(Palette.terminalBackground)
        layer.cornerRadius = TerminalBlockLayout.Metrics.cornerRadius
        layer.cornerCurve = .continuous
        // The same colour in both appearances, so a fixed CGColor is fine.
        layer.borderColor = UIColor(Palette.terminalBorder).resolvedColor(with: traitCollection).cgColor
        layer.borderWidth = TerminalBlockLayout.Metrics.borderWidth
        self.lines.forEach(addSubview)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public func layout(width: CGFloat) -> TerminalBlockLayout {
        TerminalBlockLayout(width: width, lines: lines.map(\.measurable))
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        for (line, frame) in zip(lines, layout(width: bounds.width).lines) {
            line.setLayoutFrame(frame)
        }
    }
}

/// One terminal line as selectable text (`<Text selectable>`), laid out as
/// a label would be: no insets, no scrolling, nothing to edit. A command's
/// prompt stays out of every selection, so a copy is the command alone.
final class TerminalLineView: UITextView, UITextViewDelegate {
    private static let prompt = "$ "
    private let line: TerminalBlockView.Line
    /// The `$ ` a selection never reaches into.
    private let promptLength: Int
    /// The person's text size, where this line follows it.
    private var textScale: TextScale?
    /// The TextKit 1 stack the line is laid out in (the text view keeps
    /// only its container).
    private let storage = NSTextStorage()

    init(line: TerminalBlockView.Line) {
        self.line = line
        if case .command = line {
            promptLength = (Self.prompt as NSString).length
        } else {
            promptLength = 0
        }
        // TextKit 1, as the labels and the chat's measurer lay this style
        // out, where a 24pt line is 24pt. Under TextKit 2, a text view's
        // default, the iOS 26 simulator measured it 23: 24 less the style's
        // baseline offset (1.45 for Plex Mono 14), rounded up.
        let manager = NSLayoutManager()
        storage.addLayoutManager(manager)
        let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        manager.addTextContainer(container)
        super.init(frame: .zero, textContainer: container)
        render()
        isEditable = false
        isSelectable = true
        isScrollEnabled = false
        backgroundColor = .clear
        textContainerInset = .zero
        textContainer.lineFragmentPadding = 0
        dataDetectorTypes = []
        delegate = self
        // VoiceOver reads the command, not the prompt.
        if case .command(let command) = line { accessibilityLabel = command }
        registerForTraitChanges(UIView.textSizeTraits, action: #selector(textSizeChanged))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        // Measured before its first trait update: measure what it will draw.
        syncTextSize()
        return super.sizeThatFits(size)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if syncTextSize() { setNeedsLayoutUpTheTree() }
    }

    @objc private func textSizeChanged() {
        if syncTextSize() { setNeedsLayoutUpTheTree() }
    }

    /// Draws again when the text size here changed; true when it did.
    @discardableResult
    private func syncTextSize() -> Bool {
        let scale = traitCollection.textEnvironment?.scale
        guard scale != textScale else { return false }
        textScale = scale
        render()
        return true
    }

    /// TerminalBlock.tsx's `<Text>`, at the size it is drawn at.
    private func render() {
        let style = textScale.map { TextStyles.terminalLine.scaled($0) } ?? TextStyles.terminalLine
        switch line {
        case .comment(let comment):
            attributedText = style.attributedString(comment, color: UIColor(Palette.terminalComment))
        case .command(let command):
            let styled = NSMutableAttributedString(attributedString: style.attributedString(Self.prompt + command, color: UIColor(Palette.terminalText)))
            styled.addAttribute(.foregroundColor, value: UIColor(Palette.terminalPrompt), range: NSRange(location: 0, length: promptLength))
            attributedText = styled
        }
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
        let range = selectedRange
        guard promptLength > 0, range.length > 0, range.location < promptLength else { return }
        let end = range.location + range.length
        selectedRange = end > promptLength
            ? NSRange(location: promptLength, length: end - promptLength)
            : NSRange(location: promptLength, length: 0)
    }
}

/// LinkComputerChecklist from components/onboarding/LinkComputer.tsx: what
/// home shows when every linked computer is offline.
public final class OfflineChecklistView: UIView {
    public let scrollView = UIScrollView()
    public let troubleshoot = RoundButton(title: Strings.Onboarding.offlineTroubleshoot)
    public let linkAnother = RoundButton(title: Strings.Onboarding.linkAnother, size: .normal, display: .inverted)
    /// Shown when the account has archived sessions to look at instead.
    public let showArchived = RoundButton(title: Strings.Sidebar.showArchived, size: .normal, display: .inverted)

    public var showsArchivedButton = false {
        didSet {
            showArchived.isHidden = !showsArchivedButton
            setNeedsLayout()
        }
    }

    /// "MacBook is offline", or the many-computers form.
    public var title: String {
        get { titleLabel.string }
        set { titleLabel.string = newValue; setNeedsLayout() }
    }

    /// "Linked MacBook", or "Linked 2 computers".
    public var linkedTitle: String {
        get { linkedLabel.string }
        set { linkedLabel.string = newValue; setNeedsLayout() }
    }

    let titleLabel = StyledLabel(style: TextStyles.emptyStateTitle, color: Palette.text)
    let linkedBox = IconView(size: ChecklistRowLayout.Metrics.boxSize)
    let linkedLabel = StyledLabel(style: TextStyles.checklistTitle, color: Palette.text)
    let openBox = IconView(size: ChecklistRowLayout.Metrics.boxSize)
    let openLabel = StyledLabel(style: TextStyles.checklistTitle, color: Palette.text)
    let openBody = StyledLabel(style: TextStyles.checklistBody, color: Palette.textSecondary)
    let terminal = TerminalBlockView(lines: [.command(Strings.Onboarding.terminalRun)])

    public override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.groupedBackground)
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.alwaysBounceVertical = true
        addSubview(scrollView)
        titleLabel.accessibilityTraits = .header
        linkedBox.showChecklistBox(checked: true)
        openBox.showChecklistBox(checked: false)
        openLabel.string = Strings.Onboarding.offlineOpenStep
        openBody.string = Strings.Onboarding.offlineOpenBody
        for view in [titleLabel, linkedBox, linkedLabel, openBox, openLabel, openBody, terminal, troubleshoot, linkAnother, showArchived] {
            scrollView.addSubview(view)
        }
        showArchived.isHidden = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public func layout() -> OfflineChecklistLayout {
        OfflineChecklistLayout(.init(
            size: bounds.size,
            safeArea: LayoutInsets(safeAreaInsets),
            title: titleLabel.measurable,
            linkedTitle: linkedLabel.measurable,
            openTitle: openLabel.measurable,
            openBody: openBody.measurable,
            terminal: terminal.measurable,
            buttons: [troubleshoot.measurable, linkAnother.measurable] + (showsArchivedButton ? [showArchived.measurable] : [])
        ))
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout()
        scrollView.frame = bounds
        if scrollView.contentSize != layout.contentSize {
            scrollView.contentSize = layout.contentSize
        }
        titleLabel.setLayoutFrame(layout.title)
        linkedBox.setLayoutFrame(layout.linked.box)
        linkedLabel.setLayoutFrame(layout.linked.title)
        openBox.setLayoutFrame(layout.open.box)
        openLabel.setLayoutFrame(layout.open.title)
        openBody.setLayoutFrame(layout.openBody)
        terminal.setLayoutFrame(layout.terminal)
        troubleshoot.setLayoutFrame(layout.buttons[0])
        linkAnother.setLayoutFrame(layout.buttons[1])
        if showsArchivedButton, layout.buttons.count > 2 {
            showArchived.setLayoutFrame(layout.buttons[2])
        }
    }
}

/// A spinner on the grouped background while the account's machines load.
public final class LoadingView: UIView {
    let spinner = UIActivityIndicatorView(style: .medium)

    public override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.groupedBackground)
        spinner.color = UIColor(Palette.textSecondary)
        spinner.startAnimating()
        addSubview(spinner)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = LoadingLayout(size: bounds.size, safeArea: LayoutInsets(safeAreaInsets), spinner: spinner.intrinsicContentSize)
        spinner.setLayoutFrame(layout.spinner)
    }
}
#endif
