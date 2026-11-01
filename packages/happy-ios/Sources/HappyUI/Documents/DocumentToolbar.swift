#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// What the formatting bar can do.
enum DocumentTool: CaseIterable, Sendable {
    case style, bold, italic, strike, code, link, bullets, numbers, checklist, quote, codeBlock, outdent, indent, divider

    var symbol: String {
        switch self {
        case .style: "textformat.size"
        case .bold: "bold"
        case .italic: "italic"
        case .strike: "strikethrough"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .link: "link"
        case .bullets: "list.bullet"
        case .numbers: "list.number"
        case .checklist: "checklist"
        case .quote: "text.quote"
        case .codeBlock: "curlybraces"
        case .outdent: "decrease.indent"
        case .indent: "increase.indent"
        case .divider: "minus"
        }
    }

    var title: String {
        switch self {
        case .style: Strings.Documents.headings
        case .bold: Strings.Documents.bold
        case .italic: Strings.Documents.italic
        case .strike: Strings.Documents.strike
        case .code: Strings.Documents.code
        case .link: Strings.Documents.link
        case .bullets: Strings.Documents.bullets
        case .numbers: Strings.Documents.numbers
        case .checklist: Strings.Documents.checklist
        case .quote: Strings.Documents.quote
        case .codeBlock: Strings.Documents.codeBlock
        case .outdent: Strings.Documents.outdent
        case .indent: Strings.Documents.indent
        case .divider: Strings.Documents.divider
        }
    }

    var identifier: String { "document.tool.\(self)" }
}

/// The formatting bar over the keyboard, in Liquid Glass: a scrolling
/// strip of the tools and a button that puts the keyboard away. A tool is
/// lit while the selection has it.
final class DocumentToolbar: UIView {
    var onTool: ((DocumentTool) -> Void)?
    /// The text style menu's choice: 0 for text, else a heading level.
    var onStyle: ((Int) -> Void)?
    var onDone: (() -> Void)?

    private let strip = GlassCapsuleView(tinted: false)
    private let scroll = UIScrollView()
    private let doneGlass = GlassCapsuleView(interactive: true, tinted: false)
    private let done = UIButton(type: .system)
    private var buttons: [DocumentTool: UIButton] = [:]
    private(set) var active: Set<DocumentTool> = []

    override init(frame: CGRect) {
        super.init(frame: CGRect(x: 0, y: 0, width: frame.width, height: DocumentToolbarLayout.Metrics.height))
        autoresizingMask = .flexibleWidth
        backgroundColor = .clear
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = true
        addSubview(strip)
        strip.contentView.addSubview(scroll)
        for tool in DocumentTool.allCases {
            let button = UIButton(type: .system)
            var configuration = UIButton.Configuration.plain()
            configuration.image = UIImage(systemName: tool.symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .medium))
            configuration.baseForegroundColor = UIColor(Palette.documentTool)
            configuration.background.cornerRadius = 12
            button.configuration = configuration
            button.accessibilityLabel = tool.title
            button.accessibilityIdentifier = tool.identifier
            button.largeContentTitle = tool.title
            button.showsLargeContentViewer = true
            button.addInteraction(UILargeContentViewerInteraction())
            if tool == .style {
                button.menu = styleMenu()
                button.showsMenuAsPrimaryAction = true
            } else {
                button.addAction(UIAction { [weak self] _ in self?.onTool?(tool) }, for: .primaryActionTriggered)
            }
            buttons[tool] = button
            scroll.addSubview(button)
        }
        addSubview(doneGlass)
        var doneConfiguration = UIButton.Configuration.plain()
        doneConfiguration.image = UIImage(systemName: "keyboard.chevron.compact.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .medium))
        doneConfiguration.baseForegroundColor = UIColor(Palette.documentTool)
        done.configuration = doneConfiguration
        done.accessibilityLabel = Strings.Documents.hideKeyboard
        done.accessibilityIdentifier = "document.tool.done"
        done.addAction(UIAction { [weak self] _ in self?.onDone?() }, for: .primaryActionTriggered)
        doneGlass.contentView.addSubview(done)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: DocumentToolbarLayout.Metrics.height) }

    private func styleMenu() -> UIMenu {
        let choices = [(Strings.Documents.text, 0)] + (1...3).map { (Strings.Documents.heading($0), $0) }
        return UIMenu(title: Strings.Documents.headings, children: choices.map { title, level in
            UIAction(title: title) { [weak self] _ in self?.onStyle?(level) }
        })
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = DocumentToolbarLayout(width: bounds.width, safeArea: LayoutInsets(safeAreaInsets), count: DocumentTool.allCases.count)
        strip.frame = layout.strip
        scroll.frame = strip.bounds
        scroll.contentSize = layout.content
        for (tool, frame) in zip(DocumentTool.allCases, layout.buttons) { buttons[tool]?.frame = frame }
        doneGlass.frame = layout.done
        done.frame = doneGlass.bounds
    }

    func setActive(_ tools: Set<DocumentTool>) {
        guard tools != active else { return }
        active = tools
        for (tool, button) in buttons {
            var configuration = button.configuration
            let lit = tools.contains(tool)
            configuration?.baseForegroundColor = UIColor(lit ? Palette.documentToolActive : Palette.documentTool)
            configuration?.background.backgroundColor = lit ? UIColor(Palette.documentToolActiveFill) : .clear
            button.configuration = configuration
            button.accessibilityTraits = lit ? [.button, .selected] : .button
        }
    }
}
#endif
