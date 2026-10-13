#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import UIKit

/// app/(app)/session/[id]/file.tsx: one file of the session, as its
/// uncommitted diff or its syntax-coloured text. A revisit draws the last
/// read at once and reads again behind it.
///
/// The session's root is read off the main thread. Until it is, the file
/// is resolved against the root it had when one of its files was last
/// shown, which is where its cached copy is. A copy kept on disk (after a
/// relaunch) is read off the main thread too, before the computer is
/// asked; offline, it stays on screen under the error alert.
final class SessionFileViewController: UIViewController {
    private let context: AppContext
    private let session: AccountSession
    private let sessionId: String
    private let rawPath: String
    private var target: FileViewer.Target
    private var sessionPath: String?
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
        rawPath = path
        requestedLine = line
        requestedColumn = column
        // This account's cache, which holds no SQL: the root it last saw.
        let root = session.fileCache.root(sessionId: sessionId)
        sessionPath = root?.path
        target = FileViewer.Target(rawPath: path, sessionPath: root?.path)
        let cached = root == nil ? nil : session.fileCache.get(sessionId: sessionId, path: target.filePath)
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
        showTarget()
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

    private func showTarget() {
        icon.fileName = target.fileName
        pathLabel.string = FileViewer.headerPath(target.filePath, line: requestedLine, column: requestedColumn)
    }

    // MARK: Loading

    /// file.tsx's loadFile: the spinner only without a cached copy. The
    /// session's root is read off the main thread first; a read that ends
    /// after another account took over shows and caches nothing.
    private func load() {
        error = nil
        let store = session.store
        let id = sessionId
        loadTask = Task { [weak self] in
            let root = await Task.detached(priority: .userInitiated) {
                (try? store.session(id: id))?.metadata?["path"]?.stringValue
            }.value
            guard !Task.isCancelled, let read = self?.resolve(root) else { return }
            if read.needsCopy, let kept = await read.cache.snapshot(sessionId: id, path: read.target.filePath) {
                guard !Task.isCancelled else { return }
                self?.showKept(kept, for: read.target)
            }
            let result = await FileViewer.load(read.target, sessionPath: read.sessionPath, transport: read.transport,
                                               cache: read.cache, sessionId: id)
            guard let self, !Task.isCancelled, self.context.account.session === self.session else { return }
            self.apply(result)
        }
    }

    /// Takes the session's root as stored and says what to read. A root
    /// other than the one the screen opened with resolves the file again,
    /// with that file's cached copy, if any.
    private func resolve(_ root: String?) -> (
        target: FileViewer.Target, sessionPath: String?, transport: SessionShellTransport, cache: SessionFileCache, needsCopy: Bool
    )? {
        guard context.account.session === session else { return nil }
        let cache = session.fileCache
        cache.setRoot(sessionId: sessionId, SessionFileCache.Root(path: root))
        if root != sessionPath {
            let resolved = FileViewer.Target(rawPath: rawPath, sessionPath: root)
            sessionPath = root
            if resolved != target {
                target = resolved
                let cached = cache.get(sessionId: sessionId, path: resolved.filePath)
                content = cached?.content
                diff = cached?.diff
                isLoading = cached == nil
                plans = []
                cancelPlan()
                showTarget()
                updateMode()
                render()
            }
        }
        return (target, sessionPath, SessionShellTransport(actions: session.actions, sessionId: sessionId), cache, content == nil)
    }

    /// The copy kept on disk, while nothing else shows.
    private func showKept(_ kept: FileViewer.Snapshot, for read: FileViewer.Target) {
        guard context.account.session === session, read == target, content == nil, error == nil else { return }
        content = kept.content
        if let keptDiff = kept.diff, diff == nil { diff = keptDiff }
        isLoading = false
        scrollsToLine = true
        updateMode()
        render()
    }

    private func apply(_ result: FileViewer.LoadResult) {
        switch result {
        case .loaded(let snapshot):
            // A diff that has gone stays until the next visit, as in file.tsx.
            if let newDiff = snapshot.diff { diff = newDiff }
            content = snapshot.content
            scrollsToLine = true
        case .failed(let failure, let newDiff):
            if let newDiff { diff = newDiff }
            let message = switch failure {
            case .read(let message?): message
            case .read(nil): Strings.FilesDetail.failedToRead
            case .load: Strings.FilesDetail.failedToLoad
            }
            // A kept copy stays on screen under the alert; file.tsx, which
            // keeps nothing across launches, shows the error instead.
            if content == nil { error = message }
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
