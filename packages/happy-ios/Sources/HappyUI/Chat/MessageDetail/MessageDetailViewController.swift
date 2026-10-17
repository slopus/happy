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
///
/// Its text follows the person's text size: the plan is measured off main
/// at the screen's (`ChatRowText`), and a new size plans it again, keeping
/// the text at the top of the screen there (`MessageDetailReadingPlace`).
final class MessageDetailViewController: UIViewController, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    private let context: AppContext
    private let sessionId: String
    private let messageId: String
    /// Of a patch's files, the one the reader tapped in the chat.
    private let focusFile: String?
    private let services: ChatServices
    /// The account's diff documents and syntax colour, for the plan.
    private let render: RenderServices
    private let scrollView = UIScrollView()
    private let canvas = MessageDetailCanvas()
    private let spinner = UIActivityIndicatorView(style: .medium)
    /// ToolHeader's title. Its RN Text scales with the person's text size
    /// in a header that keeps its height.
    private let titleView = NavigationTitleView()
    /// The screen's words, in the language the screens spoke when it was
    /// built.
    private let words = ChatWords(catalog: AppLocalization.screens)
    private let measurer = MessageDetailMeasurer()
    private let holdRecognizer = UILongPressGestureRecognizer()
    private let copyCallout = ChatCopyCallout()
    private var feedTask: Task<Void, Never>?
    private var observation: ApplyObservation?
    /// The account's own, for `onSessionVisible`.
    private let spawnRequests: SpawnRequests

    private var session = ChatSessionState(record: nil, settings: AccountSettings())
    private var snapshot: ChatSnapshot?
    private var message: ChatMessage?
    /// The files the reader opened past "Show N more lines", by diff.
    private var diffExpanded: [Int: Set<Int>] = [:]
    private var measuring = false
    private var needsMeasure = false
    private var lastLayoutWidth: CGFloat = 0
    private var lastLayoutText: TextEnvironment?
    /// The text size the plan on screen was measured at.
    private var shownText: TextEnvironment?
    private var leaving = false

    init(context: AppContext, session account: AccountSession, sessionId: String, messageId: String, file: String? = nil) {
        self.context = context
        self.sessionId = sessionId
        self.messageId = messageId
        focusFile = file
        spawnRequests = account.spawnRequests
        services = ChatServices.make(account: account, sessionId: sessionId, isCurrent: { [weak context, weak account] in account != nil && context?.account.session === account })
        render = RenderServices(account)
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
        followsTextSize()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        showsBackTitle()
        navigationItem.largeTitleDisplayMode = .never
        // ToolHeader: one line, cut in the middle, so both ends of a long
        // path or command stay readable.
        titleView.titleLabel.decoration = Self.truncatingMiddle
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
        scrollView.isHidden = true
        canvas.onAction = { [weak self] action in self?.perform(action) }
        scrollView.addSubview(canvas)
        // UILongPressGestureRecognizer's own half second, as React Native's
        // selectable text uses it.
        holdRecognizer.addTarget(self, action: #selector(held(_:)))
        holdRecognizer.delegate = self
        scrollView.addGestureRecognizer(holdRecognizer)
        view.addSubview(scrollView)
        spinner.color = UIColor(Palette.textSecondary)
        spinner.hidesWhenStopped = true
        spinner.startAnimating()
        view.addSubview(spinner)
        updateTitle()

        observation = services.observeSession(nil) { [weak self] state in
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
        spawnRequests.release(sessionId: sessionId)
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
        let text = view.traitCollection.textEnvironment
        if view.bounds.width != lastLayoutWidth || text != lastLayoutText {
            lastLayoutWidth = view.bounds.width
            lastLayoutText = text
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
        var title = words.message
        if case .toolCall(let call)? = message {
            let root = session.metadata?["path"]?.stringValue
            title = words.text(ToolFullPresentation.title(call.tool, root: root, words: words.toolActions))
        }
        titleView.title = title
        // Not `sizeToFit`, which would hold a longer title to the width of
        // the one before it.
        titleView.frame.size = titleView.intrinsicContentSize
    }

    /// The navigation bar holds the text size its title view inherits to
    /// XXL; ToolHeader's RN Text has the screen's, past XXL too. The
    /// controller's own traits: in its trait change its view's are still
    /// the old ones.
    private func updateTitleTextSize() {
        titleView.traitOverrides.preferredContentSizeCategory = traitCollection.preferredContentSizeCategory
    }

    /// The title's style cuts a line at its tail; ToolHeader cuts it in the
    /// middle. Applied each time the label draws, at any text size.
    nonisolated private static func truncatingMiddle(_ text: NSMutableAttributedString) {
        var styles: [(NSParagraphStyle, NSRange)] = []
        text.enumerateAttribute(.paragraphStyle, in: NSRange(location: 0, length: text.length)) { value, range, _ in
            if let style = value as? NSParagraphStyle { styles.append((style, range)) }
        }
        for (style, range) in styles {
            guard let middle = style.mutableCopy() as? NSMutableParagraphStyle else { continue }
            middle.lineBreakMode = .byTruncatingMiddle
            text.addAttribute(.paragraphStyle, value: middle, range: range)
        }
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
            maxContentWidth: maxContentWidth,
            focusFile: focusFile,
            text: ChatRowText(environment: view.traitCollection.textEnvironment, words: words),
            render: render
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
            // message at the right width and text size, so show it
            // meanwhile. One planned while the account stopped is plain or
            // empty, and one in a language the screens no longer speak is
            // another screen's: never shown.
            guard plan.id == self.message?.id, width == self.view.bounds.width,
                  input.text.environment == self.view.traitCollection.textEnvironment, !input.render.isClosed,
                  self.words.language == AppLocalization.language else { return }
            self.show(plan, text: input.text.environment)
        }
    }

    private func show(_ plan: ChatRowPlan, text: TextEnvironment?) {
        // A new text size moves every piece: the one at the top of the
        // screen stays there.
        let inset = scrollView.adjustedContentInset.top
        let place = text != shownText ? MessageDetailReadingPlace(top: scrollView.contentOffset.y + inset, pieces: canvas.textFrames) : nil
        shownText = text
        canvas.frame = CGRect(origin: .zero, size: plan.size)
        canvas.apply(plan)
        scrollView.contentSize = plan.size
        if let top = place?.top(in: canvas.textFrames) {
            let bottom = scrollView.adjustedContentInset.bottom
            let maxY = max(-inset, plan.size.height + bottom - scrollView.bounds.height)
            scrollView.contentOffset.y = min(max(-inset, top - inset), maxY)
        }
        canvas.visibleRect = scrollView.bounds
        updateState()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        canvas.visibleRect = scrollView.bounds
    }

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

    /// Where the plan's text pieces are, in order.
    var textFrames: [CGRect] { texts.map(\.frame) }
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

    /// The long-press target under `point`, if any.
    func hold(at point: CGPoint) -> ChatHit? {
        background.hold(at: point)
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
