#if canImport(UIKit)
import HappyLayout
import UIKit

/// components/onboarding/TerminalBlock.tsx: shell lines in the website's
/// terminal colours, dark in both appearances.
public final class TerminalBlockView: UIView {
    public enum Line: Equatable {
        /// Drawn after a green `$ ` prompt.
        case command(String)
        case comment(String)
    }

    let labels: [StyledLabel]

    public init(lines: [Line]) {
        labels = lines.map(Self.label(for:))
        super.init(frame: .zero)
        backgroundColor = UIColor(Palette.terminalBackground)
        layer.cornerRadius = TerminalBlockLayout.Metrics.cornerRadius
        layer.cornerCurve = .continuous
        // The same colour in both appearances, so a fixed CGColor is fine.
        layer.borderColor = UIColor(Palette.terminalBorder).resolvedColor(with: traitCollection).cgColor
        layer.borderWidth = TerminalBlockLayout.Metrics.borderWidth
        labels.forEach(addSubview)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public func layout(width: CGFloat) -> TerminalBlockLayout {
        TerminalBlockLayout(width: width, lines: labels.map(\.measurable))
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        for (label, frame) in zip(labels, layout(width: bounds.width).lines) {
            label.setLayoutFrame(frame)
        }
    }

    private static func label(for line: Line) -> StyledLabel {
        switch line {
        case .comment(let text):
            let label = StyledLabel(style: TextStyles.terminalLine, color: Palette.terminalComment)
            label.string = text
            return label
        case .command(let text):
            let label = StyledLabel(style: TextStyles.terminalLine, color: Palette.terminalText)
            let prompt = "$ "
            label.string = prompt + text
            if let styled = label.attributedText?.mutableCopy() as? NSMutableAttributedString {
                styled.addAttribute(
                    .foregroundColor,
                    value: UIColor(Palette.terminalPrompt),
                    range: NSRange(location: 0, length: (prompt as NSString).length)
                )
                label.attributedText = styled
            }
            // VoiceOver reads the command, not the prompt.
            label.accessibilityLabel = text
            return label
        }
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
