#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import UIKit

/// What one FileSection shows, as its owner decided it, with its words
/// read on the main thread: the plan is made off it, where the screens'
/// strings are not read, and other words are another input.
struct DiffSectionInput: Equatable, Sendable {
    var item: DiffFileItem
    var collapsed: Bool
    /// A collapsed big file's "N changed lines — tap to expand"; nil for none.
    var sizeHint: String?
    var canExpandContext: Bool
    /// Built files the reader opened with "show more", by index.
    var expandedFiles: Set<Int>
    var words: DiffSectionWords
}

/// What a section's body says in place of a diff (DiffFilesList.tsx,
/// DiffImageView.tsx), in the screens' language when it was taken.
struct DiffSectionWords: Equatable, Sendable {
    var noChanges: String
    var binaryFile: String
    var imageBefore: String
    var imageAfter: String

    @MainActor
    init() {
        noChanges = Strings.DiffDetail.noChanges
        binaryFile = Strings.DiffDetail.binaryFile
        imageBefore = Strings.DiffDetail.imageBefore
        imageAfter = Strings.DiffDetail.imageAfter
    }

    init(noChanges: String, binaryFile: String, imageBefore: String, imageAfter: String) {
        self.noChanges = noChanges
        self.binaryFile = binaryFile
        self.imageBefore = imageBefore
        self.imageAfter = imageAfter
    }
}

/// DiffFilesList.tsx's FileSection, built and measured off the main thread:
/// the header, then the size hint, a message, a spinner, the image panes or
/// each built file's plan.
final class DiffSectionPlan: @unchecked Sendable {
    enum Body {
        case none
        case hint(NSAttributedString)
        case message(NSAttributedString)
        case spinner
        case image([(String, ColorToken, UIImage?)], DiffImageLayout)
        case files([DiffFilePlan])
    }

    /// FileSection's DiffFileView: 600 rows before "show more".
    static let collapseAfter = 600
    static let spinnerSize = CGSize(width: 20, height: 20)

    let input: DiffSectionInput
    let width: CGFloat
    /// The text size it was measured at; nil is the designed size.
    let text: TextEnvironment?
    let header: DiffHeaderPlan
    let body: Body
    let layout: DiffSectionLayout

    var id: String { input.item.id }

    /// The file's diff is built through the account's documents and
    /// coloured by its syntax (`render`). Once they are closed (the account
    /// stopped) an open file shows nothing rather than "No changes".
    /// `text` is the text size the list draws at (nil, the designed size):
    /// every text in the section is measured at it.
    init(_ input: DiffSectionInput, width: CGFloat, scale: CGFloat, render: RenderServices, syntaxDeadline: ContinuousClock.Instant? = DiffFilePlan.syntaxDeadline(), text: TextEnvironment? = nil) {
        self.input = input
        self.width = width
        self.text = text
        let item = input.item
        let textScale = DiffStyle.textScale(text)
        header = DiffHeaderPlan(path: item.path, kind: item.kind, additions: item.additions, deletions: item.deletions, collapsed: input.collapsed, width: width, scale: scale, text: text)
        let style = DiffTextStyles.sectionMessage.scaled(textScale)
        func secondary(_ string: String) -> NSAttributedString {
            style.attributedString(string, color: UIColor(DiffStyle.textSecondary))
        }
        var sized: DiffSectionLayout.Body
        if input.collapsed {
            if let sizeHint = input.sizeHint {
                let hint = secondary(sizeHint)
                body = .hint(hint)
                sized = .hint(DiffStyle.size(hint, width: width))
            } else {
                body = .none
                sized = .none
            }
        } else {
            let builds = item.error == nil && item.message == nil && item.image == nil
            let document = builds ? DiffFileItem.document(item.source, cache: render.diffDocuments) : .empty
            func message(_ string: String) -> (Body, DiffSectionLayout.Body) {
                let attributed = secondary(string)
                return (.message(attributed), .message(DiffStyle.size(attributed, width: width)))
            }
            switch builds && render.diffDocuments.isClosed ? nil : item.body(document) {
            case nil:
                body = .none
                sized = .none
            case .error(let string), .message(let string):
                (body, sized) = message(string)
            case .noChanges:
                (body, sized) = message(input.words.noChanges)
            case .loading:
                body = .spinner
                sized = .spinner(Self.spinnerSize)
            case .image(let image):
                var sides: [(String, ColorToken, UIImage?)] = []
                if let before = image.before { sides.append((input.words.imageBefore, DiffPalette.markerRemoved, UIImage(data: before))) }
                if let after = image.after { sides.append((input.words.imageAfter, DiffPalette.markerAdded, UIImage(data: after))) }
                if sides.isEmpty {
                    (body, sized) = message(input.words.binaryFile)
                } else {
                    let layout = DiffImageLayout(width: width, count: sides.count, labelHeight: DiffStyle.lineHeight(DiffTextStyles.imageLabel.scaled(textScale)))
                    body = .image(sides, layout)
                    sized = .image(height: layout.size.height)
                }
            case .files(let files):
                // DiffFilesList: `selectable={Platform.OS !== 'android'}`.
                let options = DiffViewOptions(collapseAfter: Self.collapseAfter, canExpandContext: input.canExpandContext, selectable: true)
                let plans = files.enumerated().map { index, file in
                    DiffFilePlan(file: file, width: width, syntax: render.diffSyntax, options: options, expanded: input.expandedFiles.contains(index), syntaxDeadline: syntaxDeadline, text: text)
                }
                body = .files(plans)
                sized = .files(plans.map(\.height))
            }
        }
        layout = DiffSectionLayout(width: width, headerHeight: header.layout.size.height, body: sized)
    }
}

extension DiffSectionPlan {
    /// Its frames, to find the reader's place in it.
    var readingSection: DiffReadingPlace.Section {
        if case .files(let files) = body {
            return DiffReadingPlace.Section(layout: layout, files: files.map(\.layout))
        }
        return DiffReadingPlace.Section(layout: layout)
    }
}

/// What the list draws around its sections, measured with them: the
/// notices' frames and height, and the empty text's size.
struct DiffListChrome: @unchecked Sendable {
    var notices: (frames: [CGRect], height: CGFloat)?
    var emptySize: CGSize

    /// `notices` and `empty` are words, read on the main thread.
    init(notices: [String], empty: String, width: CGFloat, text: TextEnvironment?) {
        let style = DiffTextStyles.body.scaled(DiffStyle.textScale(text))
        func attributed(_ string: String) -> NSAttributedString {
            style.attributedString(string, color: UIColor(DiffStyle.textSecondary))
        }
        self.notices = notices.isEmpty ? nil : DiffFilesListLayout.notices(width: width, texts: notices.map { notice in
            let text = attributed(notice)
            return Measurable { DiffStyle.size(text, width: $0) }
        })
        emptySize = DiffStyle.size(attributed(empty), width: max(0, width - DiffFilesListLayout.Metrics.emptyPadding * 2))
    }
}

/// Builds section plans away from the main thread and keeps the last ones,
/// so a list update rebuilds only the sections that changed. A plan is
/// kept for one width and one text size: either changing measures every
/// section again.
actor DiffSectionMeasurer {
    private let render: RenderServices
    private var cache: [String: DiffSectionPlan] = [:]
    #if DEBUG
    /// Sections planned, not taken from the cache (tests).
    private(set) var planned = 0
    #endif

    init(render: RenderServices) {
        self.render = render
    }

    func plans(_ inputs: [DiffSectionInput], width: CGFloat, scale: CGFloat, text: TextEnvironment? = nil) -> [DiffSectionPlan] {
        // The sections of one pass wait for colour together.
        let deadline = DiffFilePlan.syntaxDeadline()
        var next: [String: DiffSectionPlan] = [:]
        let plans = inputs.map { input in
            if let cached = cache[input.item.id], cached.width == width, cached.text == text, cached.input == input {
                next[input.item.id] = cached
                return cached
            }
            #if DEBUG
            planned += 1
            #endif
            let plan = DiffSectionPlan(input, width: width, scale: scale, render: render, syntaxDeadline: deadline, text: text)
            next[input.item.id] = plan
            return plan
        }
        cache = next
        return plans
    }

    /// The sections and what is around them, all measured here.
    func measure(_ inputs: [DiffSectionInput], notices: [String], empty: String, width: CGFloat, scale: CGFloat, text: TextEnvironment?) -> ([DiffSectionPlan], DiffListChrome) {
        (plans(inputs, width: width, scale: scale, text: text), DiffListChrome(notices: notices, empty: empty, width: width, text: text))
    }
}

/// One FileSection on screen.
final class DiffSectionView: UIView {
    var onToggle: (() -> Void)?
    var onShowMore: ((Int) -> Void)?
    var onExpandContext: (() -> Void)?

    private let header = DiffFileHeaderView()
    private let hint = UIControl()
    private let hintLabel = UILabel()
    private let message = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let images = DiffImagePanesView()
    private var fileViews: [DiffFileView] = []
    private let border = UIView()
    private(set) var plan: DiffSectionPlan?

    override init(frame: CGRect) {
        super.init(frame: frame)
        header.addTarget(self, action: #selector(toggle), for: .touchUpInside)
        hint.addTarget(self, action: #selector(toggle), for: .touchUpInside)
        hintLabel.numberOfLines = 0
        hintLabel.isUserInteractionEnabled = false
        message.numberOfLines = 0
        spinner.color = UIColor(DiffStyle.textSecondary)
        border.backgroundColor = UIColor(DiffStyle.divider)
        addSubview(header)
        addSubview(hint)
        addSubview(hintLabel)
        addSubview(message)
        addSubview(spinner)
        addSubview(images)
        addSubview(border)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func apply(_ plan: DiffSectionPlan) {
        guard plan !== self.plan else { return }
        self.plan = plan
        header.apply(plan.header, path: plan.input.item.path)
        hint.isHidden = true
        hintLabel.isHidden = true
        message.isHidden = true
        images.isHidden = true
        spinner.stopAnimating()
        spinner.isHidden = true
        var files: [DiffFilePlan] = []
        switch plan.body {
        case .none:
            break
        case .hint(let text):
            hint.isHidden = false
            hintLabel.isHidden = false
            hintLabel.attributedText = text
        case .message(let text):
            message.isHidden = false
            message.attributedText = text
        case .spinner:
            spinner.isHidden = false
            spinner.startAnimating()
        case .image(let sides, let layout):
            images.isHidden = false
            images.apply(sides: sides, layout: layout, textScale: DiffStyle.textScale(plan.text))
        case .files(let plans):
            files = plans
        }
        while fileViews.count < files.count {
            let view = DiffFileView()
            let index = fileViews.count
            view.onShowMore = { [weak self] in self?.onShowMore?(index) }
            view.onExpandContext = { [weak self] in self?.onExpandContext?() }
            insertSubview(view, belowSubview: border)
            fileViews.append(view)
        }
        while fileViews.count > files.count {
            fileViews.removeLast().removeFromSuperview()
        }
        for (view, file) in zip(fileViews, files) { view.apply(file) }
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let layout = plan?.layout else { return }
        let origin = layout.frame.origin
        func place(_ view: UIView, _ frame: CGRect?) {
            if let frame { view.setLayoutFrame(frame.offsetBy(dx: origin.x, dy: origin.y)) }
        }
        place(header, layout.header)
        place(hint, layout.hintRow)
        place(hintLabel, layout.content)
        place(message, layout.content)
        place(spinner, layout.content)
        place(images, layout.image)
        for (view, frame) in zip(fileViews, layout.files) { place(view, frame) }
        place(border, layout.border)
    }

    @objc private func toggle() {
        onToggle?()
    }
}

private final class DiffSectionCell: UICollectionViewCell {
    let section = DiffSectionView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.addSubview(section)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        section.frame = contentView.bounds
    }
}

/// HappyAgentDiffView's notices, as the list's header.
private final class DiffNoticesCell: UICollectionViewCell {
    private var labels: [StyledLabel] = []
    var frames: [CGRect] = [] {
        didSet { setNeedsLayout() }
    }

    /// `textScale` is the size the frames were measured at, which the
    /// labels draw at rather than their traits'.
    func apply(_ notices: [String], frames: [CGRect], textScale: TextScale) {
        while labels.count < notices.count {
            let label = StyledLabel(style: DiffTextStyles.body, color: DiffStyle.textSecondary)
            label.traitOverrides.followsTextSize = false
            contentView.addSubview(label)
            labels.append(label)
        }
        for (index, label) in labels.enumerated() {
            label.isHidden = index >= notices.count
            label.style = DiffTextStyles.body.scaled(textScale)
            if index < notices.count { label.string = notices[index] }
        }
        self.frames = frames
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        for (label, frame) in zip(labels, frames) { label.setLayoutFrame(frame) }
    }
}

private final class DiffEmptyCell: UICollectionViewCell {
    /// Drawn at the size it was measured at (`style`), not its traits'.
    let label = StyledLabel(style: DiffTextStyles.body, color: DiffStyle.textSecondary)
    var textFrame: CGRect = .zero {
        didSet { setNeedsLayout() }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        label.traitOverrides.followsTextSize = false
        contentView.addSubview(label)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        label.setLayoutFrame(textFrame)
    }
}

/// Exact frames for the list, from `DiffFilesListLayout`.
private final class DiffFilesCollectionLayout: UICollectionViewLayout {
    var model = DiffFilesListLayout(width: 0, headerHeight: nil, sections: [], empty: .zero)
    var width: CGFloat = 0

    /// Item frames in order: the header, then sections, or the empty text's row.
    var frames: [CGRect] {
        var frames: [CGRect] = []
        if let header = model.header { frames.append(header) }
        frames.append(contentsOf: model.sections)
        if let empty = model.empty {
            frames.append(CGRect(x: 0, y: empty.minY - DiffFilesListLayout.Metrics.emptyPadding, width: width, height: empty.height + DiffFilesListLayout.Metrics.emptyPadding * 2))
        }
        return frames
    }

    private var cached: [CGRect] = []

    override func prepare() {
        super.prepare()
        cached = frames
    }

    override var collectionViewContentSize: CGSize {
        CGSize(width: width, height: model.contentHeight)
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        cached.enumerated().compactMap { index, frame in
            frame.intersects(rect) ? attributes(index, frame) : nil
        }
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        guard indexPath.item < cached.count else { return nil }
        return attributes(indexPath.item, cached[indexPath.item])
    }

    private func attributes(_ index: Int, _ frame: CGRect) -> UICollectionViewLayoutAttributes {
        let attributes = UICollectionViewLayoutAttributes(forCellWith: IndexPath(item: index, section: 0))
        attributes.frame = frame
        return attributes
    }

    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
        false
    }
}

/// components/diff/DiffFilesList.tsx: every changed file, one after
/// another, each a FileSection. Sections, the notices and the empty text
/// are measured off the main thread (`DiffSectionMeasurer`), at the text
/// size the list draws at; a file's diff is built only once it is open. A
/// new text size measures everything again there, and the line at the top
/// of the screen stays there (`DiffReadingPlace`).
final class DiffFilesListView: UIView, UICollectionViewDataSource {
    /// Asks for the body of an opened file that has none yet.
    var onRequestContent: ((String) -> Void)?
    /// An "N unchanged" separator was tapped in this file.
    var onExpandContext: ((String) -> Void)?

    private let layout = DiffFilesCollectionLayout()
    private(set) lazy var collectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)
    private let render: RenderServices
    private let measurer: DiffSectionMeasurer

    private var items: [DiffFileItem] = []
    private var notices: [String] = []
    private var emptyText = Strings.DiffDetail.noChanges
    private var defaultCollapsed = false
    private var autoCollapseAbove = DiffFilesCollapse.autoCollapseAbove

    /// The reader's open/close toggles, by path.
    private var overrides: [String: Bool] = [:]
    /// Built files opened with "show more", by item.
    private var expandedFiles: [String: Set<Int>] = [:]
    /// Paths whose body was asked for during this opening.
    private var requested: Set<String> = []

    private(set) var plans: [DiffSectionPlan] = []
    /// The last measurement asked for; it applies when it lands (tests
    /// wait for it).
    private(set) var measureTask: Task<Void, Never>?
    private var noticeFrames: [CGRect] = []
    private var emptyFrame: CGRect = .zero
    private var measuredWidth: CGFloat = -1
    /// The text size last measured for, and the one the plans on screen
    /// were measured at.
    private var measuredText: TextEnvironment?
    private var appliedText: TextEnvironment?
    /// The place last kept through a text size, while the reader is still there.
    private var keptPlace = KeptPlace<DiffReadingPlace>()
    private var generation = 0

    /// `render`: the account's diff documents and syntax colour.
    init(render: RenderServices) {
        self.render = render
        measurer = DiffSectionMeasurer(render: render)
        super.init(frame: .zero)
        backgroundColor = UIColor(DiffStyle.surface)
        collectionView.backgroundColor = .clear
        collectionView.dataSource = self
        collectionView.alwaysBounceVertical = true
        // A prepared cell would keep a stale plan through an in-place update.
        collectionView.isPrefetchingEnabled = false
        collectionView.register(DiffSectionCell.self, forCellWithReuseIdentifier: "section")
        collectionView.register(DiffNoticesCell.self, forCellWithReuseIdentifier: "notices")
        collectionView.register(DiffEmptyCell.self, forCellWithReuseIdentifier: "empty")
        addSubview(collectionView)
        registerForTraitChanges(UIView.textSizeTraits) { (self: Self, _) in
            self.setNeedsLayout()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// DiffFilesList's props. `canExpandContext` says whether
    /// `onExpandContext` is wanted.
    func update(items: [DiffFileItem], notices: [String] = [], emptyText: String? = nil, defaultCollapsed: Bool, autoCollapseAbove: Int = DiffFilesCollapse.autoCollapseAbove) {
        self.items = items
        self.notices = notices
        self.emptyText = emptyText ?? Strings.DiffDetail.noChanges
        self.defaultCollapsed = defaultCollapsed
        self.autoCollapseAbove = autoCollapseAbove
        requestMissingContent()
        remeasure()
    }

    /// A fresh list, as a remount is in happy-app: every file back to its
    /// default, scrolled to the top.
    func reset() {
        overrides = [:]
        expandedFiles = [:]
        requested = []
        plans = []
        generation += 1
        layout.model = DiffFilesListLayout(width: layout.width, headerHeight: nil, sections: [], empty: .zero)
        layout.invalidateLayout()
        collectionView.reloadData()
        collectionView.contentOffset = CGPoint(x: 0, y: -collectionView.adjustedContentInset.top)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        collectionView.frame = bounds
        if bounds.width != measuredWidth || traitCollection.textEnvironment != measuredText { remeasure() }
    }

    private func collapsed(_ item: DiffFileItem) -> Bool {
        DiffFilesCollapse.isCollapsed(item, override: overrides[item.path], defaultCollapsed: defaultCollapsed, autoCollapseAbove: autoCollapseAbove)
    }

    /// FileSection's effect: an opened file with no body asks for it once
    /// per opening; closing it, or a body arriving, resets that.
    private func requestMissingContent() {
        for item in items {
            let collapsed = collapsed(item)
            guard !collapsed, DiffFilesCollapse.needsContent(item, collapsed: false) else {
                requested.remove(item.path)
                continue
            }
            guard let onRequestContent, !requested.contains(item.path) else { continue }
            requested.insert(item.path)
            onRequestContent(item.path)
        }
    }

    private func remeasure() {
        let width = bounds.width
        guard width > 0 else { return }
        let text = traitCollection.textEnvironment
        measuredWidth = width
        measuredText = text
        generation += 1
        let current = generation
        let words = DiffSectionWords()
        let inputs = items.map { item in
            let collapsed = collapsed(item)
            let showsSizeHint = DiffFilesCollapse.showsSizeHint(item, collapsed: collapsed, autoCollapseAbove: autoCollapseAbove)
            return DiffSectionInput(
                item: item,
                collapsed: collapsed,
                sizeHint: showsSizeHint ? Strings.DiffDetail.tapToExpand(item.additions + item.deletions) : nil,
                canExpandContext: onExpandContext != nil,
                expandedFiles: expandedFiles[item.id] ?? [],
                words: words
            )
        }
        let scale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 3
        let measurer = measurer
        let notices = notices
        let empty = emptyText
        measureTask = Task { [weak self] in
            let (plans, chrome) = await measurer.measure(inputs, notices: notices, empty: empty, width: width, scale: scale, text: text)
            // Plans made while the account stopped have empty or plain
            // bodies; the ones on screen stay until the screen goes.
            guard let self, current == self.generation, !self.render.isClosed else { return }
            self.apply(plans, width: width, text: text, chrome: chrome)
        }
    }

    private func apply(_ plans: [DiffSectionPlan], width: CGFloat, text: TextEnvironment?, chrome: DiffListChrome) {
        // The same files in the same order update in place, so open
        // sections keep their cells (and their sideways scroll).
        let inPlace = plans.map(\.id) == self.plans.map(\.id) && !plans.isEmpty
            && (chrome.notices != nil) == hasHeader && width == layout.width
        // A new text size moves every height: keep the line at the top.
        let top = collectionView.contentOffset.y + collectionView.adjustedContentInset.top
        let model = layout.model
        let sections = self.plans.map(\.readingSection)
        let place = inPlace && text != appliedText
            ? keptPlace.place(at: top) { DiffReadingPlace(y: $0, list: model, sections: sections) }
            : nil
        keptPlace.forget()
        self.plans = plans
        appliedText = text
        noticeFrames = chrome.notices?.frames ?? []
        layout.width = width
        layout.model = DiffFilesListLayout(width: width, headerHeight: chrome.notices?.height, sections: plans.map(\.layout.height), empty: chrome.emptySize)
        if let empty = layout.model.empty {
            emptyFrame = empty.offsetBy(dx: 0, dy: -(empty.minY - DiffFilesListLayout.Metrics.emptyPadding))
        }
        layout.invalidateLayout()
        if inPlace {
            if let place, let y = place.y(list: layout.model, sections: plans.map(\.readingSection)) {
                let inset = collectionView.adjustedContentInset
                collectionView.contentOffset.y = ScrollPlace.offset(
                    top: y, insetTop: inset.top, insetBottom: inset.bottom, viewport: collectionView.bounds.height,
                    contentHeight: layout.model.contentHeight, scale: traitCollection.displayScale
                )
                keptPlace.put(place, at: collectionView.contentOffset.y + inset.top)
            }
            for indexPath in collectionView.indexPathsForVisibleItems {
                guard let cell = collectionView.cellForItem(at: indexPath) else { continue }
                configure(cell, at: indexPath)
            }
        } else {
            collectionView.reloadData()
        }
    }

    // MARK: Data source

    private var hasHeader: Bool { layout.model.header != nil }

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        (hasHeader ? 1 : 0) + (plans.isEmpty ? (layout.model.empty == nil ? 0 : 1) : plans.count)
    }

    private func identifier(_ indexPath: IndexPath) -> String {
        if hasHeader, indexPath.item == 0 { return "notices" }
        return indexPath.item - (hasHeader ? 1 : 0) < plans.count ? "section" : "empty"
    }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: identifier(indexPath), for: indexPath)
        configure(cell, at: indexPath)
        return cell
    }

    private func configure(_ cell: UICollectionViewCell, at indexPath: IndexPath) {
        switch cell {
        case let cell as DiffNoticesCell:
            cell.apply(notices, frames: noticeFrames, textScale: DiffStyle.textScale(appliedText))
        case let cell as DiffEmptyCell:
            cell.label.style = DiffTextStyles.body.scaled(DiffStyle.textScale(appliedText))
            cell.label.string = emptyText
            cell.textFrame = emptyFrame
        case let cell as DiffSectionCell:
            let index = indexPath.item - (hasHeader ? 1 : 0)
            guard index < plans.count else { return }
            let plan = plans[index]
            let item = plan.input.item
            cell.section.apply(plan)
            cell.section.onToggle = { [weak self] in self?.toggle(item.path) }
            cell.section.onShowMore = { [weak self] file in self?.showMore(item.id, file: file) }
            cell.section.onExpandContext = onExpandContext.map { expand in { expand(item.path) } }
        default:
            break
        }
    }

    private func toggle(_ path: String) {
        guard let item = items.first(where: { $0.path == path }) else { return }
        overrides[path] = !collapsed(item)
        requestMissingContent()
        remeasure()
    }

    private func showMore(_ id: String, file: Int) {
        expandedFiles[id, default: []].insert(file)
        remeasure()
    }
}
#endif
