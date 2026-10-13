#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import UIKit

/// app/(app)/session/[id]/file.tsx: one file of the session, as its
/// uncommitted diff or its syntax-coloured text. A revisit draws the last
/// read at once and reads again behind it.
final class SessionFileViewController: UIViewController {
    /// The store's sessionFileCache. It lives as long as the app, as
    /// happy-app's in-memory store does.
    private static let cache = SessionFileCache()

    private let context: AppContext
    private let session: AccountSession
    private let sessionId: String
    private let target: FileViewer.Target
    private let sessionPath: String?
    private let requestedLine: Int?
    private let requestedColumn: Int?

    private var content: FileViewer.Content?
    private var diff: String?
    private var mode = FileViewer.DisplayMode.diff
    private var isLoading: Bool
    private var error: String?
    private var loadTask: Task<Void, Never>?
    private var pendingAlert: String?
    /// A requested line scrolls into view when text first shows, cached or
    /// read, and again each time a read brings new text.
    private var scrollsToLine = true

    private let header = UIView()
    private let icon = FileIconView()
    private let pathLabel = StyledLabel(style: FileViewerTextStyles.path, color: Palette.textSecondary)
    private let headerBorder = UIView()
    private let toggleBar = UIView()
    private let diffButton = FileModeButton(title: Strings.FilesDetail.diff)
    private let fileButton = FileModeButton(title: Strings.FilesDetail.file)
    private let toggleBorder = UIView()
    private let lines = FileLinesView()
    private var stateView: UIView?

    private var planTask: Task<Void, Never>?
    /// What the pending plan is being made from.
    private var planned: (source: FileLinesPlan.Source, width: CGFloat, maxWidth: CGFloat)?
    /// The last diff and file plans, so the toggle flips between them at once.
    private var plans: [FileLinesPlan] = []

    init(context: AppContext, session: AccountSession, sessionId: String, path: String, line: Int? = nil, column: Int? = nil) {
        self.context = context
        self.session = session
        self.sessionId = sessionId
        requestedLine = line
        requestedColumn = column
        // file.tsx reads the session from the store as it renders.
        let record = try? session.store.session(id: sessionId)
        sessionPath = record?.metadata?["path"]?.stringValue
        target = FileViewer.Target(rawPath: path, sessionPath: sessionPath)
        let cached = Self.cache.get(sessionId: sessionId, path: target.filePath)
        content = cached?.content
        diff = cached?.diff
        isLoading = cached == nil
        super.init(nibName: nil, bundle: nil)
        title = Strings.FileViewerDetail.title
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        loadTask?.cancel()
        planTask?.cancel()
    }

    override func loadView() {
        view = UIView()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        icon.fileName = target.fileName
        pathLabel.string = FileViewer.headerPath(target.filePath, line: requestedLine, column: requestedColumn)
        headerBorder.backgroundColor = UIColor(Palette.glassBorder)
        toggleBorder.backgroundColor = UIColor(Palette.glassBorder)
        header.addSubview(icon)
        header.addSubview(pathLabel)
        header.addSubview(headerBorder)
        toggleBar.addSubview(diffButton)
        toggleBar.addSubview(fileButton)
        toggleBar.addSubview(toggleBorder)
        diffButton.addTarget(self, action: #selector(showDiff), for: .touchUpInside)
        fileButton.addTarget(self, action: #selector(showFile), for: .touchUpInside)
        view.addSubview(lines)
        view.addSubview(header)
        view.addSubview(toggleBar)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        registerForTraitChanges([UITraitHorizontalSizeClass.self]) { (self: Self, _) in
            self.view.setNeedsLayout()
        }
        updateMode()
        render()
        load()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let top = view.safeAreaInsets.top
        stateView?.setLayoutFrame(CGRect(x: 0, y: top, width: view.bounds.width, height: max(0, view.bounds.height - top)))
        let showsToggle = diff != nil
        let layout = FileViewerLayout(.init(
            size: view.bounds.size,
            top: top,
            path: pathLabel.measurable,
            toggle: showsToggle ? (diffButton.labelSize, fileButton.labelSize) : nil
        ))
        header.frame = layout.header
        func local(_ rect: CGRect, in parent: CGRect) -> CGRect { rect.offsetBy(dx: -parent.minX, dy: -parent.minY) }
        icon.setLayoutFrame(local(layout.icon, in: layout.header))
        pathLabel.setLayoutFrame(local(layout.path, in: layout.header))
        headerBorder.setLayoutFrame(local(layout.headerBorder, in: layout.header))
        toggleBar.isHidden = !showsToggle || stateView != nil
        if let bar = layout.toggleBar, let diffFrame = layout.diffButton, let fileFrame = layout.fileButton,
           let diffLabel = layout.diffLabel, let fileLabel = layout.fileLabel, let border = layout.toggleBorder {
            toggleBar.frame = bar
            diffButton.setLayoutFrame(local(diffFrame, in: bar))
            diffButton.labelFrame = local(diffLabel, in: diffFrame)
            fileButton.setLayoutFrame(local(fileFrame, in: bar))
            fileButton.labelFrame = local(fileLabel, in: fileFrame)
            toggleBorder.setLayoutFrame(local(border, in: bar))
        }
        lines.frame = layout.content
        updateBody()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if let pendingAlert {
            self.pendingAlert = nil
            Alerts.show(Strings.Common.error, pendingAlert, on: self)
        }
    }

    /// layout.maxWidth: 800 off a phone, unlimited on one.
    private var maxWidth: CGFloat {
        traitCollection.horizontalSizeClass == .regular ? ChatScreenLayout.Metrics.regularMaxContentWidth : .greatestFiniteMagnitude
    }

    // MARK: Loading

    /// file.tsx's loadFile: the spinner only without a cached copy.
    private func load() {
        error = nil
        let target = target
        let sessionPath = sessionPath
        let transport = SessionShellTransport(actions: session.actions, sessionId: sessionId)
        loadTask = Task { [weak self] in
            let result = await FileViewer.load(target, sessionPath: sessionPath, transport: transport)
            guard let self, !Task.isCancelled else { return }
            self.apply(result)
        }
    }

    private func apply(_ result: FileViewer.LoadResult) {
        switch result {
        case .loaded(let snapshot):
            // A diff that has gone stays until the next visit, as in file.tsx.
            if let newDiff = snapshot.diff { diff = newDiff }
            content = snapshot.content
            scrollsToLine = true
            Self.cache.set(sessionId: sessionId, path: target.filePath, snapshot)
        case .failed(let failure, let newDiff):
            if let newDiff { diff = newDiff }
            let message = switch failure {
            case .read(let message?): message
            case .read(nil): Strings.FilesDetail.failedToRead
            case .load: Strings.FilesDetail.failedToLoad
            }
            error = message
            // Modal.alert: shown once the screen is on screen.
            if view.window != nil {
                Alerts.show(Strings.Common.error, message, on: self)
            } else {
                pendingAlert = message
            }
        }
        isLoading = false
        updateMode()
        render()
    }

    private func updateMode() {
        mode = FileViewer.displayMode(requestedLine: requestedLine, hasDiff: diff != nil, hasContent: content != nil, current: mode)
    }

    // MARK: Drawing

    private func render() {
        if isLoading {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.color = UIColor(Palette.textSecondary)
            spinner.startAnimating()
            show(state: DetailMessageView(lead: spinner, lines: [
                .init(text: Strings.FilesDetail.loadingFile(target.fileName), style: FileViewerTextStyles.body, color: Palette.textSecondary, spacingBefore: 16),
            ]))
        } else if let error {
            show(state: DetailMessageView(lead: nil, lines: [
                .init(text: Strings.Common.error, style: FileViewerTextStyles.stateTitle, color: Palette.textDestructive),
                .init(text: error, style: FileViewerTextStyles.body, color: Palette.textSecondary, spacingBefore: 8, centered: true),
            ], padding: Self.statePadding))
        } else if content?.isBinary == true {
            show(state: DetailMessageView(lead: nil, lines: [
                .init(text: Strings.FilesDetail.binaryFile, style: FileViewerTextStyles.stateTitle, color: Palette.textSecondary),
                .init(text: Strings.FilesDetail.cannotDisplayBinary, style: FileViewerTextStyles.body, color: Palette.textSecondary, spacingBefore: 8, centered: true),
                .init(text: target.fileName, style: FileViewerTextStyles.fileName, color: SecondaryPalette.fileName, spacingBefore: 8, centered: true),
            ], padding: Self.statePadding))
        } else {
            stateView?.removeFromSuperview()
            stateView = nil
            header.isHidden = false
            lines.isHidden = false
            diffButton.isSelected = mode == .diff
            fileButton.isSelected = mode == .file
        }
        view.setNeedsLayout()
    }

    /// The error and binary states' `padding: 20`.
    private static let statePadding: CGFloat = 20

    private func show(state: UIView) {
        stateView?.removeFromSuperview()
        stateView = state
        header.isHidden = true
        toggleBar.isHidden = true
        lines.isHidden = true
        view.addSubview(state)
    }

    /// Puts the body for the current mode in the scroll view, planning
    /// the rows away from the main thread when they are new.
    private func updateBody() {
        guard stateView == nil else { return }
        let width = lines.bounds.width
        guard width > 0 else { return }
        let maxWidth = maxWidth
        let source: FileLinesPlan.Source
        switch FileViewer.Body(mode: mode, diff: diff, content: content) {
        case .diff:
            source = .diff(diff ?? "")
        case .code:
            source = .code(content?.content ?? "", language: FileViewer.language(target.filePath))
        case .fileEmpty:
            cancelPlan()
            lines.copyText = nil
            lines.show(message: Strings.FilesDetail.fileEmpty, maxWidth: maxWidth)
            return
        case .noChanges:
            cancelPlan()
            lines.copyText = nil
            lines.show(message: Strings.FilesDetail.noChanges, maxWidth: maxWidth)
            return
        case .none:
            cancelPlan()
            lines.copyText = nil
            lines.clear()
            return
        }
        if let plan = plans.first(where: { $0.source == source && $0.width == width && $0.maxWidth == maxWidth }) {
            cancelPlan()
            show(plan)
            return
        }
        if let planned, planned.source == source, planned.width == width, planned.maxWidth == maxWidth { return }
        planTask?.cancel()
        planned = (source, width, maxWidth)
        planTask = Task { [weak self] in
            let plan = await Task.detached(priority: .userInitiated) {
                FileLinesPlan(source: source, width: width, maxWidth: maxWidth)
            }.value
            guard let self, !Task.isCancelled else { return }
            self.planned = nil
            // One plan of each kind, at the newest size.
            self.plans = [plan] + self.plans.filter { kept in
                kept.width == width && kept.maxWidth == maxWidth && Self.isDiff(kept.source) != Self.isDiff(source)
            }
            self.show(plan)
        }
    }

    private static func isDiff(_ source: FileLinesPlan.Source) -> Bool {
        if case .diff = source { return true }
        return false
    }

    private func cancelPlan() {
        planTask?.cancel()
        planTask = nil
        planned = nil
    }

    private func show(_ plan: FileLinesPlan) {
        if case .code(let text, _) = plan.source {
            lines.copyText = text
        } else {
            lines.copyText = nil
        }
        let isNew = plan !== lines.plan
        lines.show(plan)
        guard isNew else { return }
        // The scroll view keeps its offset across content, inside the new end.
        lines.layoutIfNeeded()
        let maxOffset = max(0, lines.contentSize.height - lines.bounds.height)
        if lines.contentOffset.y > maxOffset { lines.contentOffset.y = maxOffset }
        guard case .code = plan.source else { return }
        // file.tsx scrolls two lines above a requested line, at 20 a line.
        if scrollsToLine, let requestedLine, requestedLine > 0 {
            scrollsToLine = false
            lines.contentOffset = CGPoint(x: 0, y: min(maxOffset, FileViewer.scrollOffset(line: requestedLine)))
        }
    }

    // MARK: Toggle

    @objc private func showDiff() {
        guard mode != .diff else { return }
        mode = .diff
        render()
    }

    @objc private func showFile() {
        guard mode != .file else { return }
        mode = .file
        render()
    }
}

/// file.tsx's Diff / File buttons: semibold 14 on a rounded fill, white on
/// `textLink` at 40% when chosen, secondary text on the subtle glass when
/// not. Pressing draws nothing extra.
private final class FileModeButton: UIControl {
    private let label = StyledLabel(style: FileViewerTextStyles.toggle, color: Palette.textSecondary, lines: 1)

    var labelFrame: CGRect = .zero {
        didSet { label.setLayoutFrame(labelFrame) }
    }

    var labelSize: CGSize {
        label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
    }

    override var isSelected: Bool {
        didSet { restyle() }
    }

    init(title: String) {
        super.init(frame: .zero)
        label.string = title
        label.isUserInteractionEnabled = false
        addSubview(label)
        layer.cornerRadius = FileViewerLayout.Metrics.buttonRadius
        isAccessibilityElement = true
        accessibilityLabel = title
        restyle()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func restyle() {
        backgroundColor = UIColor(isSelected ? FileViewerPalette.toggleSelected : Palette.optionSelected)
        label.color = isSelected ? FileViewerPalette.toggleSelectedText : Palette.textSecondary
        accessibilityTraits = isSelected ? [.button, .selected] : .button
    }
}
#endif
