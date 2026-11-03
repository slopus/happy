#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit

/// One Happy Agent tool call on its own screen (desktop's
/// `ToolCallPreview`, opened): what kind of call it was and how it stands,
/// then what it did as `ToolDetail` reads it from the call's presentation,
/// or from its arguments and result when it has none. A file edit's diff
/// has line numbers; a header opens its file alone on another of these.
///
/// The chat keeps it current (`update`) while the call runs. A call whose
/// raw data the transcript left out or cut is read whole from its run once
/// it has finished (`Conversation.fullToolCall`).
///
/// Its text follows the person's text size, the plan measured off main
/// (`AgentToolMeasurer`).
final class AgentToolViewController: UIViewController, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    private let session: Session
    private let conversation: Conversation
    private let agentId: String
    private let focusFile: String?
    private let render: RenderServices
    private let scrollView = UIScrollView()
    private let canvas = MessageDetailCanvas()
    private let titleView = NavigationTitleView()
    private let measurer = AgentToolMeasurer()
    private let holdRecognizer = UILongPressGestureRecognizer()
    private let copyCallout = ChatCopyCallout()
    /// The file screen opened from this one, kept current with it.
    private weak var fileScreen: AgentToolViewController?

    private(set) var tool: ChatItem.Tool
    private var full: (arguments: JSONValue?, result: JSONValue?)?
    private var reading: Task<Void, Never>?
    /// The status the whole call was read at, once.
    private var readAt: String?
    private var diffExpanded: [Int: Set<Int>] = [:]
    private var measuring = false
    private var needsMeasure = false
    private var lastLayoutWidth: CGFloat = 0
    private var lastLayoutText: TextEnvironment?

    init(session: Session, conversation: Conversation, agentId: String, tool: ChatItem.Tool, focusFile: String? = nil) {
        self.session = session
        self.conversation = conversation
        self.agentId = agentId
        self.tool = tool
        self.focusFile = focusFile
        render = RenderServices(session)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        reading?.cancel()
    }

    var callId: String { tool.callId }

    override func viewDidLoad() {
        super.viewDidLoad()
        followsTextSize()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        view.accessibilityIdentifier = "agent-tool"
        minimalBackButton()
        navigationItem.largeTitleDisplayMode = .never
        titleView.titleLabel.decoration = MessageDetailViewController.truncatingMiddle
        titleView.titleLabel.accessibilityTraits = .header
        titleView.traitOverrides.followsTextSize = true
        navigationItem.titleView = titleView
        updateTitleTextSize()
        registerForTraitChanges(UIView.textSizeTraits + [UITraitDisplayScale.self]) { (self: Self, _) in
            self.updateTitleTextSize()
            self.view.setNeedsLayout()
        }

        scrollView.alwaysBounceVertical = true
        scrollView.delegate = self
        canvas.onAction = { [weak self] action in self?.perform(action) }
        scrollView.addSubview(canvas)
        holdRecognizer.addTarget(self, action: #selector(held(_:)))
        holdRecognizer.delegate = self
        scrollView.addGestureRecognizer(holdRecognizer)
        view.addSubview(scrollView)
        updateTitle()
        readWholeIfNeeded()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scrollView.frame = view.bounds
        let text = view.traitCollection.textEnvironment
        if view.bounds.width != lastLayoutWidth || text != lastLayoutText {
            lastLayoutWidth = view.bounds.width
            lastLayoutText = text
            scheduleMeasure()
        }
    }

    // MARK: Data

    /// The call as the chat holds it now.
    func update(_ tool: ChatItem.Tool) {
        guard tool != self.tool else { return }
        self.tool = tool
        fileScreen?.update(tool)
        updateTitle()
        readWholeIfNeeded()
        scheduleMeasure()
    }

    private var detail: ToolDetail { ToolDetail(tool, full: full) }

    /// Once the call has finished, read it whole when the transcript
    /// left its data out or cut it.
    private func readWholeIfNeeded() {
        guard reading == nil, readAt == nil, ToolDetail(tool).wantsFullData else { return }
        readAt = tool.status
        let conversation = conversation
        let callId = tool.callId
        reading = Task { [weak self] in
            let whole = await conversation.fullToolCall(callId)
            guard let self, !Task.isCancelled else { return }
            reading = nil
            if let whole { full = whole }
            scheduleMeasure()
        }
        scheduleMeasure()
    }

    /// The call's subject, as its line in the chat says it, or its name.
    private func updateTitle() {
        let words = ToolWords(tool)
        titleView.title = words.subject.isEmpty ? ToolDetail.humanize(tool.name) : focusFile.map(ToolWords.fileName) ?? words.subject
        titleView.frame.size = titleView.intrinsicContentSize
    }

    private func updateTitleTextSize() {
        titleView.traitOverrides.preferredContentSizeCategory = traitCollection.preferredContentSizeCategory
    }

    // MARK: Measuring

    private var maxContentWidth: CGFloat {
        traitCollection.horizontalSizeClass == .regular ? LegacyChatScreenLayout.Metrics.regularMaxContentWidth : .greatestFiniteMagnitude
    }

    private func scheduleMeasure() {
        guard isViewLoaded, view.bounds.width > 0 else { return }
        guard !measuring else {
            needsMeasure = true
            return
        }
        measuring = true
        let input = AgentToolInput(
            callId: tool.callId, detail: detail, loading: reading != nil, focusFile: focusFile, diffExpanded: diffExpanded,
            maxContentWidth: maxContentWidth, text: ChatRowText(environment: view.traitCollection.textEnvironment, words: .english), render: render
        )
        let width = view.bounds.width
        let measurer = self.measurer
        Task { [weak self] in
            let plan = await measurer.plan(input, width: width)
            guard let self else { return }
            measuring = false
            if needsMeasure {
                needsMeasure = false
                scheduleMeasure()
            }
            guard width == view.bounds.width, input.text.environment == view.traitCollection.textEnvironment, !input.render.isClosed else { return }
            show(plan)
        }
    }

    private func show(_ plan: ChatRowPlan) {
        canvas.frame = CGRect(origin: .zero, size: plan.size)
        canvas.apply(plan)
        scrollView.contentSize = plan.size
        canvas.visibleRect = scrollView.bounds
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        canvas.visibleRect = scrollView.bounds
    }

    // MARK: Touches

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === holdRecognizer else { return true }
        return canvas.hold(at: gestureRecognizer.location(in: canvas)) != nil
    }

    /// A control inside the content (a diff's "Show N more lines") handles
    /// its own touches.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        var view = touch.view
        while let current = view, current !== scrollView {
            if current is UIControl { return false }
            view = current.superview
        }
        return true
    }

    @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began, case .selectable(let text)? = canvas.hold(at: recognizer.location(in: canvas))?.action else { return }
        copyCallout.present(copying: text, at: recognizer.location(in: scrollView), in: scrollView)
    }

    func perform(_ action: ChatRowAction) {
        switch action {
        case .diffShowMore(_, let chunk, let file):
            diffExpanded[chunk, default: []].insert(file)
            scheduleMeasure()
        case .openMessageFile(_, let file):
            let screen = AgentToolViewController(session: session, conversation: conversation, agentId: agentId, tool: tool, focusFile: file)
            fileScreen = screen
            navigationController?.pushViewController(screen, animated: true)
        case .openURL(let link):
            guard let url = URL(string: link), url.scheme == "http" || url.scheme == "https" else { return }
            openBrowser(url, session: session, agentID: agentId)
        default:
            break
        }
    }
}
#endif
