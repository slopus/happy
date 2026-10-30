#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

/// The one cell every row uses: a `ChatPlanView` that draws the row's
/// plan. It measures nothing and lays out nothing of its own.
final class ChatRowCell: UICollectionViewCell {
    static let reuseIdentifier = "ChatRowCell"

    private let canvas = ChatPlanView()

    var plan: ChatRowPlan? { canvas.plan }

    /// Actions from views inside the row that handle their own touches.
    var onAction: ((ChatRowAction) -> Void)? {
        get { canvas.onAction }
        set { canvas.onAction = newValue }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        contentView.backgroundColor = .clear
        contentView.addSubview(canvas)
        isAccessibilityElement = true
        accessibilityTraits = .staticText
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        canvas.frame = contentView.bounds
    }

    func apply(_ plan: ChatRowPlan) {
        canvas.apply(plan)
        accessibilityLabel = plan.accessibilityLabel
    }

    /// What a tap at `point` (in this cell) does, if anything.
    func action(at point: CGPoint) -> ChatRowAction? {
        canvas.action(at: point)
    }

    /// The long-press target under `point` (in this cell), if any.
    func hold(at point: CGPoint) -> ChatHit? {
        canvas.hold(at: point)
    }

    /// The link under `point`, if the tap landed on one.
    func link(at point: CGPoint) -> String? {
        canvas.link(at: point)
    }
}

/// Draws a `ChatRowPlan` with a pool of plain views (boxes, text, icons)
/// it reuses from plan to plan: a list row, the footer past the newest
/// message, or a whole tool on the message screen.
final class ChatPlanView: UIView {
    /// UltraList draws these marks on its display queue; this view retains
    /// only live native content and the plan's hit testing.
    var drawsStaticContent = true {
        didSet { if drawsStaticContent != oldValue { plan = nil } }
    }
    /// Actions from views inside the plan that handle their own touches
    /// (a diff's "Show N more lines").
    var onAction: ((ChatRowAction) -> Void)?
    private(set) var plan: ChatRowPlan?
    /// A tall plan is cut into chunks (`ChatChunks`), each drawn by
    /// a view of its own, and only the chunks near `band` have one: a long
    /// reply costs what shows of it. Off, every mark has its view.
    var cutsTallPlans = false {
        didSet { if cutsTallPlans != oldValue { plan = nil } }
    }
    /// Text coming on screen is drawn off the main thread (`ChatOffMainTextView`).
    var drawsTextOffMain = false
    /// The part of the row on screen, in its coordinates; nil: all of it,
    /// `.null`: none.
    var band: CGRect? {
        didSet { if band != oldValue { placeChunks() } }
    }
    private var chunks: [(plan: ChatRowPlan, frame: CGRect)] = []
    private var chunkViews: [Int: ChatPlanView] = [:]
    private var chunksPlaced: (mount: Range<Int>, keep: Range<Int>)?
    /// Other chunks came or went: what is over them, and what VoiceOver
    /// reads of them, is the owner's to set again.
    var onChunksPlaced: (() -> Void)?
    /// A chunk of a tall plan: touches go through it to the row's other chunks.
    private var passesTouches = false
    /// The pictures, recordings and stories the plan shows now.
    var mediaViews: [UIView] {
        (media as [UIView] + stories as [UIView] + pages as [UIView]).filter { !$0.isHidden }
            + chunkViews.keys.sorted().flatMap { chunkViews[$0]?.mediaViews ?? [] }
    }
    private var boxes: [UIView] = []
    private var texts: [ChatTextView] = []
    private var icons: [UIImageView] = []
    private var spinners: [UIActivityIndicatorView] = []
    private var timers: [ChatElapsedLabel] = []
    private var pulses: [ChatPulseView] = []
    private var diffs: [DiffChunkView] = []
    private var diffHeaders: [DiffFileHeaderView] = []
    private var scrollers: [ChatScrollerView] = []
    private var attachments: [ChatAttachmentView] = []
    private var webImages: [ChatWebImageView] = []
    private var mermaids: [ChatMermaidView] = []
    private var media: [ChatMediaView] = []
    private var stories: [StoryInlineView] = []
    private var pages: [InlinePageView] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        // CGColor borders don't follow the appearance by themselves.
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            guard let plan = self.plan else { return }
            self.plan = nil
            self.apply(plan)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func apply(_ plan: ChatRowPlan) {
        guard plan !== self.plan else { return }
        self.plan = plan
        alpha = plan.alpha
        let cut = cutsTallPlans ? ChatChunks(frames: plan.items.map(\.markFrame), size: plan.size) : nil
        if let cut, cut.chunks.count > 1 {
            chunks = cut.chunks.map { chunk in
                (ChatRowPlan(id: "\(plan.id)#\(chunk.items.lowerBound)", size: plan.size, items: Array(plan.items[chunk.items])), chunk.frame)
            }
            for index in Array(chunkViews.keys) where index >= chunks.count { removeChunk(index) }
            chunksPlaced = nil
            // Those far from the band go before they are drawn again.
            placeChunks()
            for (index, view) in chunkViews {
                // A chunk is the row's size: touches reach what grew in it.
                view.setLayoutFrame(CGRect(origin: .zero, size: chunks[index].plan.size))
                view.apply(chunks[index].plan)
            }
            draw([], id: plan.id)
        } else {
            for index in Array(chunkViews.keys) { removeChunk(index) }
            chunks = []
            draw(plan.items, id: plan.id)
        }
    }

    /// Brings in the chunks of a tall plan near `band` and lets go of
    /// those far from it, as the transcript's rows are (`ChatMountedRows`).
    private func placeChunks() {
        guard !chunks.isEmpty else { return }
        let near = band.map { ChatMountedRows(frames: chunks.map(\.frame), top: $0.minY, height: $0.height) }
        var placed = (mount: near?.mount ?? chunks.indices, keep: near?.keep ?? chunks.indices)
        if band?.isNull == true { placed = (0..<0, 0..<0) }
        if let chunksPlaced, chunksPlaced == placed { return }
        chunksPlaced = placed
        for index in Array(chunkViews.keys) where !placed.keep.contains(index) { removeChunk(index) }
        for index in placed.mount where chunkViews[index] == nil {
            let view = ChatPlanView()
            view.drawsStaticContent = drawsStaticContent
            view.drawsTextOffMain = drawsTextOffMain
            view.passesTouches = true
            view.frame = CGRect(origin: .zero, size: chunks[index].plan.size)
            view.onAction = { [weak self] action in self?.onAction?(action) }
            view.apply(chunks[index].plan)
            chunkViews[index] = view
            addSubview(view)
        }
        // Later chunks draw over earlier ones, as the row's marks do.
        for index in chunkViews.keys.sorted() {
            if let view = chunkViews[index] { bringSubviewToFront(view) }
        }
        onChunksPlaced?()
    }

    private func removeChunk(_ index: Int) {
        chunkViews.removeValue(forKey: index)?.removeFromSuperview()
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return passesTouches && hit === self ? nil : hit
    }

    /// Shows `items`, the views for them taken from the pools in order.
    private func draw(_ items: [ChatDrawItem], id: String) {
        // Views are taken in draw order; keeping them in one subview order
        // means a box always sits under the text that follows it.
        var boxIndex = 0
        var textIndex = 0
        var iconIndex = 0
        var spinnerIndex = 0
        var timerIndex = 0
        var pulseIndex = 0
        var diffIndex = 0
        var diffHeaderIndex = 0
        var scrollerIndex = 0
        var attachmentIndex = 0
        var webImageIndex = 0
        var mermaidIndex = 0
        var mediaIndex = 0
        var storyIndex = 0
        var pageIndex = 0
        var order: [UIView] = []
        for item in items {
            switch item {
            case .box(let box):
                guard drawsStaticContent else { continue }
                let view = take(&boxes, &boxIndex) { UIView() }
                style(view, box)
                order.append(view)
            case .text(let layout, let frame):
                guard drawsStaticContent else { continue }
                let view = take(&texts, &textIndex) { drawsTextOffMain ? ChatOffMainTextView() : ChatTextView() }
                view.isAccessibilityElement = false
                view.setLayoutFrame(frame)
                view.layout = layout
                order.append(view)
            case .icon(let icon, let size, let frame, let tint):
                guard drawsStaticContent else { continue }
                let view = take(&icons, &iconIndex) { UIImageView() }
                view.contentMode = .center
                view.image = .icon(icon, size: size)
                view.tintColor = UIColor(tint)
                view.setLayoutFrame(frame)
                order.append(view)
            case .spinner(let frame, let tint, let scale):
                let view = take(&spinners, &spinnerIndex) { UIActivityIndicatorView(style: .medium) }
                view.bounds = CGRect(origin: .zero, size: frame.size)
                view.center = CGPoint(x: frame.midX, y: frame.midY)
                view.transform = CGAffineTransform(scaleX: scale, y: scale)
                view.color = UIColor(tint)
                view.startAnimating()
                order.append(view)
            case .elapsed(let since, let frame, let text):
                let view = take(&timers, &timerIndex) { ChatElapsedLabel() }
                view.setLayoutFrame(frame)
                view.environment = text
                view.since = since
                order.append(view)
            case .pulse(let box):
                let view = take(&pulses, &pulseIndex) { ChatPulseView() }
                style(view, box)
                view.startPulsing()
                order.append(view)
            case .diff(let diff, let frame, let toolId, let chunk, let radius, let corners):
                let view = take(&diffs, &diffIndex) { DiffChunkView() }
                // Set every time: the view may have ended another card.
                // React Native's corners are circular.
                view.layer.cornerRadius = radius
                view.layer.maskedCorners = corners
                view.layer.cornerCurve = .circular
                view.layer.masksToBounds = radius > 0
                view.onShowMore = { [weak self] file in
                    self?.onAction?(.diffShowMore(toolId: toolId, chunk: chunk, file: file))
                }
                view.setLayoutFrame(frame)
                view.apply(diff)
                order.append(view)
            case .diffHeader(let header, let path, let frame):
                let view = take(&diffHeaders, &diffHeaderIndex) {
                    let view = DiffFileHeaderView()
                    // The plan draws hunkBg behind it, shaped as it must be.
                    view.backgroundColor = .clear
                    // Its taps are the plan's hits.
                    view.isUserInteractionEnabled = false
                    return view
                }
                view.setLayoutFrame(frame)
                view.apply(header, path: path)
                order.append(view)
            case .scroller(let content, let frame, let radius, let vertical):
                // The same strip of the same row keeps where it was scrolled to.
                let key = "\(id)#\(scrollerIndex)"
                let view = take(&scrollers, &scrollerIndex) { ChatScrollerView() }
                // A code block's or table's words, like the row's.
                view.content.drawsTextOffMain = drawsTextOffMain
                view.setLayoutFrame(frame)
                view.layer.cornerRadius = radius
                view.layer.cornerCurve = .continuous
                view.vertical = vertical
                view.apply(content, key: key)
                order.append(view)
            case .attachment(let attachment, let frame):
                let view = take(&attachments, &attachmentIndex) { ChatAttachmentView() }
                view.setLayoutFrame(frame)
                view.apply(attachment)
                order.append(view)
            case .webImage(let url, let frame, let label):
                let view = take(&webImages, &webImageIndex) { ChatWebImageView(frame: .zero) }
                view.setLayoutFrame(frame)
                view.apply(url, label: label)
                order.append(view)
            case .mermaid(let diagram, let frame):
                // Taken in order, so a row planned again keeps its pages.
                let view = take(&mermaids, &mermaidIndex) { ChatMermaidView() }
                view.onHeight = { [weak self] diagram, height in
                    self?.onAction?(.mermaidHeight(row: diagram.row, index: diagram.index, height: height))
                }
                // Before the page measures: it reports at least its box.
                view.setLayoutFrame(frame)
                view.apply(diagram)
                order.append(view)
            case .media(let item, let frame):
                let view = take(&media, &mediaIndex) { ChatMediaView() }
                view.setLayoutFrame(frame)
                view.apply(item)
                order.append(view)
            case .embed(.story(let id), let frame):
                let view = take(&stories, &storyIndex) { StoryInlineView() }
                view.setLayoutFrame(frame)
                view.apply(id)
                order.append(view)
            case .embed(.page(let page), let frame):
                let view = take(&pages, &pageIndex) { InlinePageView() }
                view.setLayoutFrame(frame)
                view.apply(page)
                order.append(view)
            }
        }
        for view in boxes[boxIndex...] { view.isHidden = true }
        for view in texts[textIndex...] { view.isHidden = true }
        for view in icons[iconIndex...] { view.isHidden = true }
        for view in spinners[spinnerIndex...] {
            view.stopAnimating()
            view.isHidden = true
        }
        for view in timers[timerIndex...] {
            view.since = nil
            view.isHidden = true
        }
        for view in pulses[pulseIndex...] {
            view.stopPulsing()
            view.isHidden = true
        }
        for view in diffs[diffIndex...] {
            view.onShowMore = nil
            view.isHidden = true
        }
        for view in diffHeaders[diffHeaderIndex...] { view.isHidden = true }
        for view in scrollers[scrollerIndex...] { view.isHidden = true }
        for view in attachments[attachmentIndex...] {
            view.apply(nil)
            view.isHidden = true
        }
        for view in webImages[webImageIndex...] {
            view.apply(nil, label: nil)
            view.isHidden = true
        }
        for view in mermaids[mermaidIndex...] {
            view.onHeight = nil
            view.isHidden = true
        }
        for view in media[mediaIndex...] {
            view.apply(nil)
            view.isHidden = true
        }
        for view in stories[storyIndex...] {
            view.apply(nil)
            view.isHidden = true
        }
        for view in pages[pageIndex...] {
            view.apply(nil)
            view.isHidden = true
        }
        for view in order {
            view.isHidden = false
            bringSubviewToFront(view)
        }
    }

    private func style(_ view: UIView, _ box: ChatBox) {
        view.setLayoutFrame(box.frame)
        view.backgroundColor = box.fill.map { UIColor($0) } ?? .clear
        view.alpha = box.alpha
        view.layer.cornerRadius = box.radius
        view.layer.maskedCorners = box.corners
        view.layer.cornerCurve = .continuous
        view.layer.borderWidth = box.borderWidth
        view.layer.borderColor = box.border.map { UIColor($0).resolvedColor(with: traitCollection).cgColor }
    }

    private func take<View: UIView>(_ pool: inout [View], _ index: inout Int, make: () -> View) -> View {
        if index == pool.count {
            let view = make()
            pool.append(view)
            addSubview(view)
        }
        defer { index += 1 }
        return pool[index]
    }

    /// What a tap at `point` (in this view) does, if anything.
    func action(at point: CGPoint) -> ChatRowAction? {
        guard let plan else { return nil }
        if let scroller = scroller(at: point), let action = scroller.content.action(at: scroller.content.convert(point, from: self)) {
            return action
        }
        return plan.hits.first { !$0.hold && $0.frame.contains(point) }?.action
    }

    /// The long-press target under `point` (in this view), if any, with
    /// its frame in this view.
    func hold(at point: CGPoint) -> ChatHit? {
        if let scroller = scroller(at: point), var hit = scroller.content.hold(at: scroller.content.convert(point, from: self)) {
            hit.frame = scroller.content.convert(hit.frame, to: self)
            return hit
        }
        return plan?.hits.first { $0.hold && $0.frame.contains(point) }
    }

    /// The sideways strip under `point`; what it shows is in front.
    private func scroller(at point: CGPoint) -> ChatScrollerView? {
        // A chunk lies over the whole row: its points are the row's.
        scrollers.first { !$0.isHidden && $0.frame.contains(point) } ?? chunkViews.values.lazy.compactMap { $0.scroller(at: point) }.first
    }

    /// The link under `point`, if the tap landed on one.
    func link(at point: CGPoint) -> String? {
        if let scroller = scroller(at: point), let link = scroller.content.link(at: scroller.content.convert(point, from: self)) {
            return link
        }
        for view in texts where !view.isHidden && view.frame.contains(point) {
            if let link = view.link(at: CGPoint(x: point.x - view.frame.minX, y: point.y - view.frame.minY)) {
                return link
            }
        }
        if !drawsStaticContent, let plan {
            for case .text(let layout, let frame) in plan.items where frame.contains(point) {
                if let link = layout.link(at: CGPoint(x: point.x - frame.minX, y: point.y - frame.minY)) { return link }
            }
        }
        for view in chunkViews.values {
            if let link = view.link(at: point) { return link }
        }
        return nil
    }
}

extension ChatDrawItem {
    /// Where the mark is drawn in its row.
    var markFrame: CGRect {
        switch self {
        case .box(let box), .pulse(let box): box.frame
        case .text(_, let frame), .icon(_, _, let frame, _), .spinner(let frame, _, _), .elapsed(_, let frame, _),
             .diff(_, let frame, _, _, _, _), .diffHeader(_, _, let frame), .scroller(_, let frame, _, _), .attachment(_, let frame),
             .webImage(_, let frame, _), .mermaid(_, let frame), .media(_, let frame), .embed(_, let frame): frame
        }
    }
}

/// HorizontalScrollView inside a row: a plan of its own, wider than the
/// strip that shows it, scrolled sideways. Like React Native's horizontal
/// ScrollView it shows its indicator and always bounces sideways.
/// `vertical` makes it PermissionFooter's ScrollView instead: taller than
/// its frame, scrolled up and down, with no indicator.
final class ChatScrollerView: UIScrollView {
    let content = ChatPlanView()
    private var key: String?

    var vertical = false {
        didSet {
            guard vertical != oldValue else { return }
            showsHorizontalScrollIndicator = !vertical
            alwaysBounceHorizontal = !vertical
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        showsHorizontalScrollIndicator = true
        showsVerticalScrollIndicator = false
        alwaysBounceHorizontal = true
        alwaysBounceVertical = false
        scrollsToTop = false
        contentInsetAdjustmentBehavior = .never
        addSubview(content)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Shows `plan`; `key` names the strip, and a new one starts scrolled
    /// to the start.
    func apply(_ plan: ChatRowPlan, key: String) {
        if key != self.key {
            self.key = key
            contentOffset = .zero
        }
        contentSize = plan.size
        content.frame = CGRect(origin: .zero, size: plan.size)
        content.apply(plan)
        let maxX = max(0, plan.size.width - bounds.width)
        if contentOffset.x > maxX { contentOffset.x = maxX }
        let maxY = max(0, plan.size.height - bounds.height)
        if contentOffset.y > maxY { contentOffset.y = maxY }
    }
}

/// ToolView's ElapsedView: whole seconds since the tool started, ticking
/// once a second while on screen ("12.0s", useElapsedTime + toFixed(1)).
/// Drawn at the text size its row was planned at, in the room the plan
/// measured for it, not at its traits'.
final class ChatElapsedLabel: UILabel {
    var environment: TextEnvironment? {
        didSet { if environment != oldValue { font = ChatTextStyles.toolElapsed.font(in: environment) } }
    }

    var since: Int64? {
        didSet {
            guard since != oldValue else { return }
            tick()
            updateTimer()
        }
    }

    private var timer: Timer?

    override init(frame: CGRect) {
        super.init(frame: frame)
        font = ChatTextStyles.toolElapsed.font
        textColor = UIColor(Palette.textSecondary)
        textAlignment = .right
        isAccessibilityElement = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        updateTimer()
    }

    private func updateTimer() {
        let running = since != nil && window != nil
        if running && timer == nil {
            let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
            RunLoop.main.add(timer, forMode: .common)
            self.timer = timer
            tick()
        } else if !running {
            timer?.invalidate()
            timer = nil
        }
    }

    private func tick() {
        guard let since else {
            text = nil
            return
        }
        let seconds = max(0, (Int64(Date().timeIntervalSince1970 * 1000) - since) / 1000)
        text = "\(seconds).0s"
    }
}

/// PermissionFooter's loading ring: its opacity runs 0.18 → 0.52 → 0.18,
/// 720 ms each way.
final class ChatPulseView: UIView {
    private static let key = "pulse"

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func startPulsing() {
        guard layer.animation(forKey: Self.key) == nil else { return }
        let animation = CABasicAnimation(keyPath: "opacity")
        animation.fromValue = 0.18
        animation.toValue = 0.52
        animation.duration = 0.72
        animation.autoreverses = true
        animation.repeatCount = .infinity
        animation.timingFunction = CAMediaTimingFunction(controlPoints: 0.455, 0.03, 0.515, 0.955)
        animation.isRemovedOnCompletion = false
        layer.add(animation, forKey: Self.key)
    }

    func stopPulsing() {
        layer.removeAnimation(forKey: Self.key)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // Core Animation drops an animation when its layer leaves the window.
        if window != nil && !isHidden {
            stopPulsing()
            startPulsing()
        }
    }
}
#endif
