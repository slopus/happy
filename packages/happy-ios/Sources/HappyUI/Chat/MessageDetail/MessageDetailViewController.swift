#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import UIKit

/// session/[id]/message/[messageId].tsx: one message on its own screen. A
/// tool shows all of ToolFullView, output included and nothing collapsed;
/// a text message shows its whole text. Titled by ToolHeader.
///
/// A spinner until the session and its messages have loaded; once they
/// have, a message that isn't there sends the reader back.
final class MessageDetailViewController: UIViewController, UIScrollViewDelegate {
    private let context: AppContext
    private let sessionId: String
    private let messageId: String
    private let services: ChatServices
    private let scrollView = UIScrollView()
    private let canvas = MessageDetailCanvas()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let titleLabel = UILabel()
    private let measurer = MessageDetailMeasurer()
    private var feedTask: Task<Void, Never>?
    private var observation: StoreObservation?

    private var session = ChatSessionState(record: nil, settings: AccountSettings())
    private var snapshot: ChatSnapshot?
    private var message: ChatMessage?
    /// The files the reader opened past "Show N more lines", by diff.
    private var diffExpanded: [Int: Set<Int>] = [:]
    private var measuring = false
    private var needsMeasure = false
    private var lastLayoutWidth: CGFloat = 0
    private var leaving = false

    init(context: AppContext, session account: AccountSession, sessionId: String, messageId: String) {
        self.context = context
        self.sessionId = sessionId
        self.messageId = messageId
        services = ChatServices.make(account: account, sessionId: sessionId)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        feedTask?.cancel()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        showsBackTitle()
        navigationItem.largeTitleDisplayMode = .never
        // ToolHeader: one line, cut in the middle, so both ends of a long
        // path or command stay readable.
        titleLabel.numberOfLines = 1
        titleLabel.accessibilityTraits = .header
        navigationItem.titleView = titleLabel

        scrollView.alwaysBounceVertical = true
        scrollView.delegate = self
        scrollView.isHidden = true
        canvas.onAction = { [weak self] action in self?.perform(action) }
        scrollView.addSubview(canvas)
        view.addSubview(scrollView)
        spinner.color = UIColor(Palette.textSecondary)
        spinner.hidesWhenStopped = true
        spinner.startAnimating()
        view.addSubview(spinner)
        updateTitle()

        observation = services.observeSession { [weak self] state in
            self?.sessionChanged(state)
        }
        let stream = services.feed.snapshots(sessionId: sessionId)
        feedTask = Task { [weak self] in
            for await snapshot in stream {
                guard let self else { return }
                self.receive(snapshot)
            }
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // sync.ts `onSessionVisible`, which this screen calls on mount too.
        SpawnRequests.shared.release(sessionId: sessionId)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        leaveIfGone()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scrollView.frame = view.bounds
        let safe = view.safeAreaLayoutGuide.layoutFrame
        spinner.center = CGPoint(x: safe.midX, y: safe.midY)
        if view.bounds.width != lastLayoutWidth {
            lastLayoutWidth = view.bounds.width
            scheduleMeasure()
        }
    }

    // MARK: Data

    private func sessionChanged(_ state: ChatSessionState) {
        let before = session
        session = state
        if state.metadata?["path"] != before.metadata?["path"] { updateTitle() }
        updateState()
        scheduleMeasure()
    }

    private func receive(_ snapshot: ChatSnapshot) {
        guard snapshot != self.snapshot else { return }
        self.snapshot = snapshot
        let message = snapshot.messages.first { $0.id == messageId }
        let changed = message != self.message
        self.message = message
        if changed {
            updateTitle()
            scheduleMeasure()
        }
        updateState()
        leaveIfGone()
    }

    /// Messages have loaded and this one isn't among them (router.back()).
    private func leaveIfGone() {
        guard !leaving, snapshot?.isLoaded == true, message == nil,
              let navigation = navigationController, navigation.topViewController === self else { return }
        leaving = true
        // Not in the middle of the push that is bringing this screen in.
        if let coordinator = transitionCoordinator {
            coordinator.animate(alongsideTransition: nil) { [weak navigation] _ in
                navigation?.popViewController(animated: true)
            }
        } else {
            navigation.popViewController(animated: true)
        }
    }

    /// ToolHeader: the tool's title, or "Message", including while loading.
    private func updateTitle() {
        var title = Strings.Tools.message
        if case .toolCall(let call)? = message {
            let root = session.metadata?["path"]?.stringValue
            title = Strings.Tools.text(ToolFullPresentation.title(call.tool, root: root, words: Strings.ToolGroup.words))
        }
        titleLabel.attributedText = NSAttributedString(
            string: title,
            attributes: TextStyles.headerTitle.attributes(color: UIColor(Palette.headerTint), alignment: .center, lineBreakMode: .byTruncatingMiddle)
        )
        titleLabel.sizeToFit()
    }

    /// The spinner until there is something to show.
    private var loaded: Bool {
        session.record != nil && snapshot?.isLoaded == true && message != nil
    }

    private func updateState() {
        if loaded, canvas.plan != nil {
            spinner.stopAnimating()
            scrollView.isHidden = false
        } else if !loaded {
            spinner.startAnimating()
            scrollView.isHidden = true
        }
    }

    // MARK: Measuring

    private var maxContentWidth: CGFloat {
        traitCollection.horizontalSizeClass == .regular ? ChatScreenLayout.Metrics.regularMaxContentWidth : .greatestFiniteMagnitude
    }

    private var devMode: Bool {
        #if DEBUG
        true
        #else
        context.account.localSettings.devModeEnabled
        #endif
    }

    private func scheduleMeasure() {
        guard isViewLoaded, view.bounds.width > 0, let message else { return }
        guard !measuring else {
            needsMeasure = true
            return
        }
        measuring = true
        let input = MessageDetailInput(
            message: message,
            root: session.metadata?["path"]?.stringValue,
            showLineNumbers: session.settings.bool("showLineNumbersInToolViews"),
            devMode: devMode,
            diffExpanded: diffExpanded,
            maxContentWidth: maxContentWidth
        )
        let width = view.bounds.width
        let measurer = self.measurer
        Task { [weak self] in
            let plan = await measurer.plan(input, width: width)
            guard let self else { return }
            self.measuring = false
            if self.needsMeasure {
                self.needsMeasure = false
                self.scheduleMeasure()
            }
            // A newer input is on its way; this one may still be the right
            // message at the right width, so show it meanwhile.
            guard plan.id == self.message?.id, width == self.view.bounds.width else { return }
            self.show(plan)
        }
    }

    private func show(_ plan: ChatRowPlan) {
        canvas.frame = CGRect(origin: .zero, size: plan.size)
        canvas.apply(plan)
        scrollView.contentSize = plan.size
        canvas.visibleRect = scrollView.bounds
        updateState()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        canvas.visibleRect = scrollView.bounds
    }

    private func perform(_ action: ChatRowAction) {
        switch action {
        case .diffShowMore(_, let chunk, let file):
            diffExpanded[chunk, default: []].insert(file)
            scheduleMeasure()
        default:
            break
        }
    }
}

/// Draws a message screen's plan, which can run to thousands of lines.
/// Boxes, icons and diffs are all placed at once (a box draws nothing of
/// its own, and a diff draws only its visible rows); text is drawn only
/// for the pieces within a screen of what is visible, each piece keeping
/// its view while it stays near.
final class MessageDetailCanvas: UIView {
    var onAction: ((ChatRowAction) -> Void)? {
        get { background.onAction }
        set { background.onAction = newValue }
    }

    /// The part of the canvas on screen, in its own coordinates.
    var visibleRect: CGRect = .zero {
        didSet { if visibleRect != oldValue { updateTexts() } }
    }

    private(set) var plan: ChatRowPlan?
    private let background = ChatPlanView()
    private var texts: [(layout: ChatTextLayout, frame: CGRect)] = []
    private var shown: [Int: ChatTextView] = [:]
    private var spare: [ChatTextView] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        addSubview(background)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        background.frame = bounds
    }

    func apply(_ plan: ChatRowPlan) {
        guard plan !== self.plan else { return }
        self.plan = plan
        var rest: [ChatDrawItem] = []
        texts = []
        for item in plan.items {
            if case .text(let layout, let frame) = item {
                texts.append((layout, frame))
            } else {
                rest.append(item)
            }
        }
        background.frame = CGRect(origin: .zero, size: plan.size)
        background.apply(ChatRowPlan(id: plan.id, size: plan.size, items: rest, hits: plan.hits))
        updateTexts()
    }

    private func updateTexts() {
        // A screen ahead each way, so text is drawn before it scrolls in.
        let margin = max(visibleRect.height, 400)
        let near = visibleRect.insetBy(dx: 0, dy: -margin)
        for (index, view) in shown where index >= texts.count || !texts[index].frame.intersects(near) {
            shown[index] = nil
            view.layout = nil
            view.isHidden = true
            spare.append(view)
        }
        for (index, text) in texts.enumerated() where text.frame.intersects(near) {
            let view = shown[index] ?? {
                let view = spare.popLast() ?? {
                    let view = ChatTextView()
                    addSubview(view)
                    return view
                }()
                view.isHidden = false
                shown[index] = view
                return view
            }()
            view.setLayoutFrame(text.frame)
            view.layout = text.layout
        }
    }
}
#endif
