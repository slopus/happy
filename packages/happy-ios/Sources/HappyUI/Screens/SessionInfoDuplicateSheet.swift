#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import UIKit

extension UIViewController {
    /// Presents happy-app's duplicate sheet for `sessionId` over self.
    func presentDuplicateSheet(sessionId: String, context: AppContext) {
        guard let session = context.account.session else { return }
        let sheet = DuplicateSheetViewController(context: context, session: session, sessionId: sessionId, presenter: self)
        present(sheet, animated: true)
    }
}

/// components/DuplicateSheet.tsx in BaseModal: the session's rewind points,
/// newest first; Duplicate forks the session cut after the chosen one and
/// replaces the presenter's screen with the new session.
final class DuplicateSheetViewController: UIViewController {
    private let context: AppContext
    private let session: AccountSession
    private let sessionId: String
    private weak var presenter: UIViewController?
    private var record: SessionRecord?
    private var points: DuplicateSheetModel.Points?
    private var selectedId: String?
    private var duplicating = false
    private var loadTask: Task<Void, Never>?

    private let backdrop = MaterialBlurView(fraction: DuplicateSheetMaterial.backdropBlurFraction, light: .systemMaterialLight, dark: .systemMaterialDark)
    private let dim = UIView()
    private let card = DuplicateSheetCard()
    private let titleLabel = SheetLabel(SheetText.title, color: Palette.text)
    private let subtitleLabel = SheetLabel(SheetText.subtitle, color: Palette.textSecondary)
    private let headerDivider = UIView()
    private let list = UIScrollView()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let messageLabel = SheetLabel(SheetText.empty, color: Palette.textSecondary, alignment: .center)
    private var rows: [DuplicateSheetRow] = []
    private let actionsDivider = UIView()
    private let cancelButton = DuplicateSheetButton(primary: false)
    private let confirmButton = DuplicateSheetButton(primary: true)

    init(context: AppContext, session: AccountSession, sessionId: String, presenter: UIViewController) {
        self.context = context
        self.session = session
        self.sessionId = sessionId
        self.presenter = presenter
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        loadTask?.cancel()
    }

    override func loadView() {
        view = UIView()
        view.backgroundColor = .clear
        dim.backgroundColor = UIColor(SecondaryPalette.backdropDim)
        dim.isUserInteractionEnabled = false
        backdrop.isUserInteractionEnabled = false
        view.addSubview(backdrop)
        view.addSubview(dim)
        let tap = UITapGestureRecognizer(target: self, action: #selector(close))
        tap.delegate = self
        view.addGestureRecognizer(tap)

        titleLabel.text(Strings.SessionDetail.duplicateSheetTitle)
        subtitleLabel.text(Strings.SessionDetail.duplicateSheetSubtitle)
        for divider in [headerDivider, actionsDivider] {
            divider.backgroundColor = UIColor(Palette.divider)
        }
        list.alwaysBounceVertical = false
        list.addSubview(spinner)
        list.addSubview(messageLabel)
        cancelButton.title = Strings.Common.cancel
        cancelButton.addTarget(self, action: #selector(close), for: .touchUpInside)
        confirmButton.addTarget(self, action: #selector(confirmDuplicate), for: .touchUpInside)
        for subview in [titleLabel, subtitleLabel, headerDivider, list, actionsDivider, cancelButton, confirmButton] {
            card.content.addSubview(subview)
        }
        view.addSubview(card)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Every height on the sheet is measured from its labels as drawn.
        followsTextSize()
        // The spinner shows until the session is read and its points listed.
        render()
        load()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        guard animated, !UIAccessibility.isReduceMotionEnabled else { return }
        let scale = DuplicateSheetMaterial.appearScale
        card.transform = CGAffineTransform(scaleX: scale, y: scale)
        UIView.animate(withDuration: DuplicateSheetMaterial.appearDuration, delay: 0, options: [.curveEaseOut]) {
            self.card.transform = .identity
        }
    }

    // MARK: Loading

    private var source: ForkSource? {
        record.flatMap(SessionDetails.forkSource)
    }

    /// Reads the session off the main thread, then lists its points. A
    /// read finished after another account took over shows nothing.
    private func load() {
        let missingMetadata = Strings.SessionDetail.forkErrorMissingMetadata
        let store = session.store
        let id = sessionId
        let machines = session.detailMachineActions
        loadTask = Task { @MainActor [weak self] in
            let read = await Task.detached(priority: .userInitiated) { try? store.session(id: id) }.value
            guard !Task.isCancelled, let record = self?.received(read) else { return }
            let points = await DuplicateSheetModel.loadPoints(record, machines: machines, missingMetadata: missingMetadata)
            guard let self, !Task.isCancelled, self.context.account.session === self.session else { return }
            self.points = points
            // A selection that isn't among the points is dropped.
            if case .loaded(let loaded) = points, let selectedId = self.selectedId, !loaded.contains(where: { $0.id == selectedId }) {
                self.selectedId = nil
            }
            self.render()
        }
    }

    /// Takes the session as read; it is returned when its points can be
    /// listed. Without a forkable session the sheet says why.
    private func received(_ read: SessionRecord?) -> SessionRecord? {
        guard context.account.session === session else { return nil }
        record = read
        guard let read, source != nil else {
            points = .failed(Strings.SessionDetail.forkErrorMissingMetadata)
            render()
            return nil
        }
        return read
    }

    private var loadedPoints: [DuplicateSheetModel.Point] {
        if case .loaded(let points) = points { return points }
        return []
    }

    private var selected: DuplicateSheetModel.Point? {
        guard let selectedId else { return nil }
        return loadedPoints.first { $0.id == selectedId }
    }

    // MARK: Rendering

    private func render() {
        switch points {
        case nil:
            spinner.startAnimating()
            spinner.isHidden = false
            messageLabel.isHidden = true
        case .failed(let message):
            spinner.stopAnimating()
            spinner.isHidden = true
            messageLabel.isHidden = false
            messageLabel.text(message)
        case .loaded(let points):
            spinner.stopAnimating()
            spinner.isHidden = true
            messageLabel.isHidden = !points.isEmpty
            messageLabel.text(Strings.SessionDetail.duplicateSheetEmpty)
        }
        renderRows()
        let canFork = source != nil
        confirmButton.title = duplicating ? Strings.SessionDetail.loading : Strings.SessionDetail.duplicateSheetConfirm
        confirmButton.isEnabled = !duplicating && selected != nil && canFork
        view.setNeedsLayout()
    }

    private func renderRows() {
        let points = loadedPoints
        while rows.count > points.count { rows.removeLast().removeFromSuperview() }
        while rows.count < points.count {
            let row = DuplicateSheetRow()
            row.addTarget(self, action: #selector(selectRow(_:)), for: .touchUpInside)
            list.addSubview(row)
            rows.append(row)
        }
        let now = Date().timeIntervalSince1970 * 1000
        for (row, point) in zip(rows, points) {
            row.pointId = point.id
            row.textLabel.text(DuplicateSheetModel.preview(point.text))
            row.metaLabel.text(Self.age(DuplicateSheetModel.age(of: point.timestamp, now: now)))
            row.isChosen = point.id == selectedId
        }
    }

    private static func age(_ age: DuplicateSheetModel.Age) -> String {
        typealias S = Strings.SessionDetail
        switch age {
        case .justNow: return S.justNow
        case .minutes(let count): return S.minutesAgo(count)
        case .hours(let count): return S.hoursAgo(count)
        case .days(let count): return S.daysAgo(count)
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        backdrop.frame = view.bounds
        dim.frame = view.bounds
        let body: DuplicateSheetLayout.Body
        if points == nil {
            body = .loading(spinner.intrinsicContentSize)
        } else if rows.isEmpty {
            body = .message(messageLabel.measurable)
        } else {
            body = .rows(rows.map { (text: $0.textLabel.measurable, meta: $0.metaLabel.measurable) })
        }
        let layout = DuplicateSheetLayout(DuplicateSheetLayout.Input(
            window: view.bounds.size,
            title: titleLabel.measurable,
            subtitle: subtitleLabel.measurable,
            body: body,
            buttonTextHeight: confirmButton.textHeight,
            hairline: view.hairline
        ))
        // The card may be mid-scale, so place it by bounds and centre.
        card.bounds = CGRect(origin: .zero, size: layout.card.size)
        card.center = CGPoint(x: layout.card.midX, y: layout.card.midY)
        titleLabel.setLayoutFrame(layout.title)
        subtitleLabel.setLayoutFrame(layout.subtitle)
        headerDivider.frame = layout.headerDivider
        list.frame = layout.list
        list.contentSize = layout.listContentSize
        if let body = layout.body {
            spinner.frame = body
            messageLabel.setLayoutFrame(body)
        }
        for (row, frame) in zip(rows, layout.rows) {
            row.apply(frame)
        }
        actionsDivider.frame = layout.actionsDivider
        cancelButton.setLayoutFrame(layout.cancel)
        confirmButton.setLayoutFrame(layout.confirm)
    }

    // MARK: Actions

    @objc private func close() {
        presentingViewController?.dismiss(animated: true)
    }

    @objc private func selectRow(_ row: DuplicateSheetRow) {
        selectedId = row.pointId
        render()
    }

    @objc private func confirmDuplicate() {
        // Nothing to pick until the session has been read.
        guard !duplicating, points != nil else { return }
        guard let record, source != nil else {
            Alerts.show(Strings.Common.error, Strings.SessionDetail.forkErrorMissingMetadata, on: self)
            return
        }
        guard let point = selected else {
            Alerts.show(Strings.Common.error, Strings.SessionDetail.duplicateRowDisabled, on: self)
            return
        }
        let machines = session.detailMachineActions
        let messages = SessionDetailActions.ForkMessages(
            missingMetadata: Strings.SessionDetail.forkErrorMissingMetadata,
            generic: Strings.SessionDetail.forkErrorGeneric
        )
        duplicating = true
        render()
        Task { @MainActor [weak self] in
            do {
                let sessionId = try await DuplicateSheetModel.duplicate(record, after: point, machines: machines, messages: messages)
                guard let self else { return }
                self.duplicating = false
                self.openSession(sessionId)
            } catch {
                guard let self else { return }
                self.duplicating = false
                self.render()
                let message = (error as? SessionDetailActions.Failure)?.message ?? Strings.SessionDetail.unknownError
                Alerts.show(Strings.Common.error, message, on: self)
            }
        }
    }

    /// onClose, then replaceToSession: the presenter's screen gives way to
    /// the new session. Over a stack's root it is pushed instead, so the
    /// root stays.
    private func openSession(_ id: String) {
        let navigation = (presenter as? UINavigationController) ?? presenter?.navigationController
        presentingViewController?.dismiss(animated: true)
        guard let navigation else { return }
        let screen = Screens.make(.session(id: id), context: context, session: session)
        if navigation.viewControllers.count > 1 {
            navigation.setViewControllers(Array(navigation.viewControllers.dropLast()) + [screen], animated: true)
        } else {
            navigation.pushViewController(screen, animated: true)
        }
    }
}

extension DuplicateSheetViewController: UIGestureRecognizerDelegate {
    /// Only taps on the backdrop close the sheet.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        !(touch.view?.isDescendant(of: card) ?? false)
    }
}

// MARK: - Views

/// DuplicateSheet.tsx sets bare font sizes, so its text is in the system
/// font, not Plex. RN scales it as any Text: the size and a fixed line by
/// the text size's multiplier, unrounded (docs/DYNAMIC-TYPE.md).
enum SheetText {
    struct Style: Equatable {
        var size: CGFloat
        var weight: UIFont.Weight = .regular
        var lineHeight: CGFloat?

        /// The system font at `scale` (nil: as designed).
        func font(_ scale: TextScale?) -> UIFont {
            .systemFont(ofSize: size * (scale?.multiplier ?? 1), weight: weight)
        }

        func line(_ scale: TextScale?) -> CGFloat? {
            lineHeight.map { $0 * (scale?.multiplier ?? 1) }
        }
    }

    static let title = Style(size: 17, weight: .semibold)
    static let subtitle = Style(size: 13)
    static let empty = Style(size: 14)
    static let row = Style(size: 14, lineHeight: 19)
    static let meta = Style(size: 12)
    static let primaryButton = Style(size: 15, weight: .semibold)
    static let secondaryButton = Style(size: 15, weight: .medium)
}

/// A line of the sheet's text, at the person's text size where the sheet
/// follows it, drawn again when the size changes.
final class SheetLabel: UILabel {
    private let style: SheetText.Style
    private let color: ColorToken
    private let alignment: NSTextAlignment
    private var string = ""
    /// The text size it draws at; nil as designed.
    private(set) var textScale: TextScale?

    init(_ style: SheetText.Style, color: ColorToken, lines: Int = 0, alignment: NSTextAlignment = .natural) {
        self.style = style
        self.color = color
        self.alignment = alignment
        super.init(frame: .zero)
        numberOfLines = lines
        registerForTraitChanges(UIView.textSizeTraits) { (self: Self, _) in
            self.syncTextSize()
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        syncTextSize()
    }

    private func syncTextSize() {
        let scale = traitCollection.textEnvironment?.scale
        guard scale != textScale else { return }
        textScale = scale
        render()
        setNeedsLayoutUpTheTree()
    }

    /// Measured before its first trait update: measure what it will draw.
    /// Its traits are brought up to date first; until then
    /// `traitCollection` still holds the ones before its overrides
    /// changed (Mac run: Large and no `FollowsTextSize` past an override
    /// to AX-XXXL).
    override func sizeThatFits(_ size: CGSize) -> CGSize {
        updateTraitsIfNeeded()
        syncTextSize()
        return super.sizeThatFits(size)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func text(_ string: String) {
        guard string != self.string || attributedText == nil else { return }
        self.string = string
        render()
    }

    private func render() {
        let font = style.font(textScale)
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = alignment
        paragraph.lineBreakMode = numberOfLines == 0 ? .byWordWrapping : .byTruncatingTail
        var attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: UIColor(color),
            .paragraphStyle: paragraph,
        ]
        if let lineHeight = style.line(textScale) {
            paragraph.minimumLineHeight = lineHeight
            paragraph.maximumLineHeight = lineHeight
            // As TextStyle does: the slack centred the way React Native does.
            attributes[.baselineOffset] = (lineHeight - font.lineHeight) / 4
        }
        attributedText = NSAttributedString(string: string, attributes: attributes)
        accessibilityLabel = string
    }
}

/// The sheet's MobileGlassSurface (`nativeEffect`, `glassEffectStyle`
/// "regular", tinted `glass.overlayTint`): Liquid Glass on iOS 26, the
/// ultra-thin blur at intensity 36 below it. Under either, the `glass.overlay`
/// colour; over it, the diagonal sheen; all clipped to 16pt corners inside a
/// hairline glass rim. Home's LiquidGlassView draws exactly that.
private final class DuplicateSheetCard: UIView {
    private let glass = LiquidGlassView(
        regular: true,
        tint: Palette.glassOverlayTint,
        fill: SecondaryPalette.sheetOverlay,
        border: Palette.glassBorder,
        shadow: nil
    )

    /// Put the sheet's views here: they sit over the sheen.
    var content: UIView { glass.contentView }

    override init(frame: CGRect) {
        super.init(frame: frame)
        glass.cornerRadius = DuplicateSheetLayout.Metrics.cornerRadius
        addSubview(glass)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        glass.frame = bounds
    }
}

/// A rewind point: its preview (three lines at most) over its age. Chosen
/// or pressed, it takes the high surface.
private final class DuplicateSheetRow: UIControl {
    let textLabel = SheetLabel(SheetText.row, color: Palette.text, lines: 3)
    let metaLabel = SheetLabel(SheetText.meta, color: Palette.textSecondary)
    private let divider = UIView()
    var pointId = ""
    var isChosen = false {
        didSet { applyBackground() }
    }

    override var isHighlighted: Bool {
        didSet { applyBackground() }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        divider.backgroundColor = UIColor(Palette.divider)
        for subview in [textLabel, metaLabel, divider] {
            subview.isUserInteractionEnabled = false
            addSubview(subview)
        }
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func apply(_ row: DuplicateSheetLayout.Row) {
        setLayoutFrame(row.frame)
        let origin = row.frame.origin
        textLabel.setLayoutFrame(row.text.offsetBy(dx: -origin.x, dy: -origin.y))
        metaLabel.setLayoutFrame(row.meta.offsetBy(dx: -origin.x, dy: -origin.y))
        divider.frame = row.divider.offsetBy(dx: -origin.x, dy: -origin.y)
        accessibilityLabel = [textLabel.accessibilityLabel, metaLabel.accessibilityLabel].compactMap { $0 }.joined(separator: ", ")
    }

    private func applyBackground() {
        backgroundColor = isChosen || isHighlighted ? UIColor(Palette.surfaceHigh) : .clear
        accessibilityTraits = isChosen ? [.button, .selected] : .button
    }
}

/// Cancel (the high surface) and Duplicate (the primary button): 15pt text
/// with 11pt above and below, 10pt corners; 0.7 pressed, 0.4 disabled.
private final class DuplicateSheetButton: UIControl {
    private let label: SheetLabel

    var title = "" {
        didSet { label.text(title); accessibilityLabel = title; setNeedsLayout() }
    }

    override var isHighlighted: Bool {
        didSet { applyOpacity() }
    }

    override var isEnabled: Bool {
        didSet { applyOpacity() }
    }

    init(primary: Bool) {
        label = SheetLabel(
            primary ? SheetText.primaryButton : SheetText.secondaryButton,
            color: primary ? SecondaryPalette.buttonPrimaryTint : Palette.text,
            lines: 1,
            alignment: .center
        )
        super.init(frame: .zero)
        backgroundColor = UIColor(primary ? SecondaryPalette.buttonPrimary : Palette.surfaceHigh)
        layer.cornerRadius = DuplicateSheetLayout.Metrics.buttonCornerRadius
        label.isUserInteractionEnabled = false
        addSubview(label)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// One line of the button's text.
    var textHeight: CGFloat {
        label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)).height
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let inset = DuplicateSheetLayout.Metrics.buttonPaddingVertical
        label.setLayoutFrame(bounds.insetBy(dx: 0, dy: inset))
    }

    private func applyOpacity() {
        alpha = !isEnabled ? DuplicateSheetMaterial.disabledOpacity : isHighlighted ? DuplicateSheetMaterial.pressedOpacity : 1
        accessibilityTraits = isEnabled ? .button : [.button, .notEnabled]
    }
}

/// A blur held part-way, as expo-blur's `intensity` holds it, in the
/// material the app's theme names.
private final class MaterialBlurView: UIVisualEffectView {
    private let fraction: CGFloat
    private let light: UIBlurEffect.Style
    private let dark: UIBlurEffect.Style
    private var animator: UIViewPropertyAnimator?

    init(fraction: CGFloat, light: UIBlurEffect.Style, dark: UIBlurEffect.Style) {
        self.fraction = fraction
        self.light = light
        self.dark = dark
        super.init(effect: nil)
        isUserInteractionEnabled = false
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.rebuild()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// A paused animator must be stopped before it is released, so it only
    /// lives while the view is in a window.
    override func didMoveToWindow() {
        super.didMoveToWindow()
        rebuild()
    }

    private func rebuild() {
        animator?.stopAnimation(true)
        animator = nil
        effect = nil
        guard window != nil else { return }
        let style = traitCollection.userInterfaceStyle == .dark ? dark : light
        let animator = UIViewPropertyAnimator(duration: 1, curve: .linear) { [weak self] in
            self?.effect = UIBlurEffect(style: style)
        }
        animator.pausesOnCompletion = true
        animator.fractionComplete = fraction
        self.animator = animator
    }
}
#endif
