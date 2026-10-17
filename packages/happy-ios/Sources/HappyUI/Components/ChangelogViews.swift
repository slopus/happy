#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// What's New laid out off the main thread (AGENTS.md rule 8): every
/// release's title, summary line, paragraphs and bullets laid out by TextKit
/// at the list's width and text size, and placed by `ChangelogEntryLayout`.
/// The views only draw it.
struct ChangelogPlan: Sendable {
    struct Input: Equatable, Sendable {
        /// The list's content width.
        var width: CGFloat
        var text: TextEnvironment
        /// ItemGroup.tsx's `layout.maxWidth`, read on main.
        var maxWidth: CGFloat?
        /// The first release to plan.
        var from = 0
        /// Stop once the releases planned are this tall: the first screen,
        /// planned ahead of the rest when the screen opens. Nil plans to
        /// the end.
        var enough: CGFloat? = nil

        /// What the plan is laid out for, whichever releases it holds.
        var geometry: Input {
            Input(width: width, text: text, maxWidth: maxWidth)
        }
    }

    /// One release.
    struct Entry: Sendable {
        var layout: ChangelogEntryLayout
        var title: ChatTextLayout
        var summary: ChatTextLayout?
        /// The paragraphs and bullet items, in order.
        var texts: [ChatTextLayout]
        /// The "•" beside a bullet item; nil when the release has none.
        var bullet: ChatTextLayout?
    }

    var input: Input
    /// The releases from `input.from` on.
    var entries: [Entry]

    /// Off the main thread.
    static func make(_ input: Input, entries: [Changelog.Entry]) -> ChangelogPlan {
        var planned: [Entry] = []
        var height: CGFloat = 0
        for entry in entries.dropFirst(input.from) {
            let made = Self.entry(entry, input)
            planned.append(made)
            height += made.layout.size.height
            if let enough = input.enough, height >= enough { break }
        }
        #if DEBUG
        Self.planned.add(planned.count)
        #endif
        return ChangelogPlan(input: input, entries: planned)
    }

    #if DEBUG
    /// Releases planned so far, on any thread (tests and the harness).
    static let planned = Tally()

    final class Tally: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0

        var value: Int {
            lock.withLock { count }
        }

        func add(_ value: Int) {
            lock.withLock { count += value }
        }
    }
    #endif

    private static func entry(_ entry: Changelog.Entry, _ input: Input) -> Entry {
        let text = input.text
        let title = MeasuredText(ChatTextStyle(TextStyles.changelogTitle).string(entry.title, color: Palette.text, in: text))
        let summary = entry.summary.isEmpty ? nil : MeasuredText(summaryText(entry.summary, in: text))
        let blocks = ChangelogMarkdown.parse(entry.markdown)
        var texts: [MeasuredText] = []
        var items: [ChangelogBodyLayout.Item] = []
        for block in blocks {
            let measured: MeasuredText
            switch block {
            case .bullet(let spans):
                measured = MeasuredText(Self.text(spans, in: text))
                items.append(.init(text: measured.measurable, bulleted: true))
            case .paragraph(let spans):
                measured = MeasuredText(Self.text(spans, in: text))
                items.append(.init(text: measured.measurable, bulleted: false))
            }
            texts.append(measured)
        }
        let bullet = items.contains(where: \.bulleted)
            ? ChatTextLayout(unwrapped: ChatTextStyle(TextStyles.changelogBody).string("•", color: Palette.text, in: text))
            : nil
        let layout = ChangelogEntryLayout(
            width: input.width,
            title: title.measurable,
            summary: summary?.measurable,
            items: items,
            bullet: bullet?.size ?? .zero,
            maxWidth: input.maxWidth
        )
        return Entry(
            layout: layout,
            title: title.layout(for: layout.group.header ?? .zero),
            summary: summary.map { $0.layout(for: layout.body.summary ?? .zero) },
            texts: zip(texts, layout.body.texts).map { $0.layout(for: $1) },
            bullet: bullet
        )
    }

    /// MarkdownView's text: regular, bold spans semibold, http(s) links
    /// underlined and opened (`RenderSpans`, `handleLinkPress`).
    static func text(_ spans: [ChangelogMarkdown.Span], in text: TextEnvironment?) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let body = ChatTextStyle(TextStyles.changelogBody)
        let bold = ChatTextStyle(TextStyles.changelogBold)
        for span in spans {
            switch span {
            case .text(let string, let isBold):
                result.append((isBold ? bold : body).string(string, color: Palette.text, in: text))
            case .link(let label, let url):
                // RenderSpans underlines and opens only http(s) links; the
                // rest read as plain text.
                result.append(Markdown.isHTTPLink(url) ? link(label, url: url, style: body, in: text) : body.string(label, color: Palette.text, in: text))
            }
        }
        return result
    }

    /// `SummaryLine`: plain text and underlined links, which all open. The
    /// changelog bundles no images, so an image segment has nothing to show.
    static func summaryText(_ summary: String, in text: TextEnvironment?) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let style = ChatTextStyle(TextStyles.changelogSummary)
        for segment in ChangelogSummary.parse(summary) {
            switch segment {
            case .text(let string):
                result.append(style.string(string, color: Palette.text, in: text))
            case .link(let label, let url):
                result.append(link(label, url: url, style: style, in: text))
            case .image:
                break
            }
        }
        return result
    }

    private static func link(_ label: String, url: String, style: ChatTextStyle, in text: TextEnvironment?) -> NSAttributedString {
        var attributes = style.attributes(color: UIColor(Palette.text), in: text)
        attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
        if URL(string: url) != nil { attributes[.chatLink] = url }
        return NSAttributedString(string: label, attributes: attributes)
    }

    /// The links in `string`, in order, by label and address.
    static func links(in string: NSAttributedString) -> [(label: String, url: URL)] {
        var links: [(label: String, url: URL)] = []
        string.enumerateAttribute(.chatLink, in: NSRange(location: 0, length: string.length)) { value, range, _ in
            guard let value = value as? String, let url = URL(string: value) else { return }
            links.append(((string.string as NSString).substring(with: range), url))
        }
        return links
    }
}

/// What's New's text drawn into bitmaps off the main thread, so a release
/// coming into view costs the main thread only its layers' contents.
/// Drawing it in `draw(_:)` took 8 to 33 ms of the frame it came in on.
enum ChangelogRaster {
    /// One text to draw: its string, wrapped at `width`, into a bitmap the
    /// size of its view's frame.
    struct Item: @unchecked Sendable {
        var string: NSAttributedString
        var width: CGFloat
        var size: CGSize
    }

    /// The screen and appearance the text is drawn for: the view's traits,
    /// taken on main, which dynamic colours resolve against.
    struct Look: @unchecked Sendable {
        var scale: CGFloat
        var traits: UITraitCollection
    }

    /// Bitmaps share one queue, so a fling asks for them in the order the
    /// releases come into view.
    static let queue = DispatchQueue(label: "com.slopus.happy.changelog-raster", qos: .userInitiated)

    /// Off the main thread. The text is laid out again here, so the plan's
    /// layouts are only ever read on main.
    static func draw(_ items: [Item], look: Look) -> [CGImage?] {
        let traits = look.traits
        let format = UIGraphicsImageRendererFormat()
        format.scale = look.scale
        format.opaque = false
        return items.map { item in
            guard item.size.width > 0, item.size.height > 0, item.string.length > 0 else { return nil }
            let layout = ChatTextLayout(item.string, width: item.width)
            var image: UIImage?
            // Dynamic colours resolve against the current traits.
            traits.performAsCurrent {
                image = UIGraphicsImageRenderer(size: item.size, format: format).image { _ in layout.draw(at: .zero) }
            }
            return image?.cgImage
        }
    }
}

/// CGImage is immutable; the SDK just doesn't say it is Sendable.
struct UncheckedImages: @unchecked Sendable {
    var images: [CGImage?]
}

/// Shows a bitmap of text the size of its frame. Nothing is measured or
/// drawn here.
final class ChangelogTextView: UIView {
    /// The text it shows, as planned (tests and hit-testing read the plan).
    var layout: ChatTextLayout?

    var image: CGImage? {
        didSet { layer.contents = image }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        isUserInteractionEnabled = false
        // The entry gives VoiceOver its elements, drawn or not.
        isAccessibilityElement = false
        layer.contentsGravity = .resize
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override var frame: CGRect {
        didSet { layer.contentsScale = window?.screen.scale ?? traitCollection.displayScale }
    }
}

/// One What's New release (changelog.tsx's ItemGroup with `cardContent`):
/// the title over the card holding the summary line, the paragraphs and the
/// bullets, drawn from its `ChangelogPlan.Entry`. Nothing here measures.
///
/// The text is drawn only while the release is near the screen
/// (`drawsText`), into bitmaps made off the main thread
/// (`ChangelogRaster`); the card and VoiceOver's elements are there either
/// way. Until a release's bitmaps are in, its text is blank.
/// A tap on a link opens it; a long press on a paragraph or bullet item
/// offers Copy, as RN's `selectable` Text does (MarkdownView's default).
final class ChangelogEntryView: UIView {
    var plan: ChangelogPlan.Entry? {
        didSet {
            elements = nil
            updateText()
            setNeedsLayout()
            if let list = superview as? GroupedListView {
                list.sectionNeedsMeasure(self)
            } else {
                superview?.setNeedsLayout()
            }
        }
    }

    var drawsText = false {
        didSet { if drawsText != oldValue { updateText() } }
    }

    /// Whether the bitmaps for the text it draws are in (tests).
    private(set) var isRasterized = false
    /// Counts raster requests, so one that lands after another was asked
    /// for, or after the text went, is dropped.
    private var rasterToken = 0
    /// The views each requested bitmap goes to, in order.
    private var rasterViews: [[ChangelogTextView]] = []

    /// Opens a tapped link (tests replace it).
    var openLink: (URL) -> Void = { UIApplication.shared.open($0) }

    let card = GroupCardView()
    private(set) var titleView: ChangelogTextView?
    private(set) var summaryView: ChangelogTextView?
    private(set) var textViews: [ChangelogTextView] = []
    private(set) var bulletViews: [ChangelogTextView] = []
    private let callout = ChatCopyCallout()
    private var elements: [UIAccessibilityElement]?
    private lazy var tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
    private lazy var hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))

    init() {
        super.init(frame: .zero)
        addSubview(card)
        addGestureRecognizer(tap)
        addGestureRecognizer(hold)
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.rasterize()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        plan?.layout.size ?? CGSize(width: size.width, height: 0)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let plan else { return }
        let group = plan.layout.group
        let body = plan.layout.body
        card.setLayoutFrame(group.card)
        if let frame = group.header { titleView?.setLayoutFrame(frame) }
        if let frame = body.summary { summaryView?.setLayoutFrame(frame) }
        for (view, frame) in zip(textViews, body.texts) {
            view.setLayoutFrame(frame)
        }
        for (view, frame) in zip(bulletViews, body.bullets.compactMap { $0 }) {
            view.setLayoutFrame(frame)
        }
    }

    /// Puts in, or takes out, the views that draw the plan's text, reusing
    /// the ones there (a new text size keeps every view), and asks for
    /// their bitmaps.
    private func updateText() {
        guard drawsText, let plan else {
            // The views stay, empty, for when the release comes back.
            for view in [titleView, summaryView].compactMap({ $0 }) + textViews + bulletViews {
                view.image = nil
            }
            rasterToken += 1
            isRasterized = false
            return
        }
        titleView = Self.place(plan.title, in: titleView, on: self)
        summaryView = plan.summary.flatMap { Self.place($0, in: summaryView, on: card) }
        if plan.summary == nil {
            summaryView?.removeFromSuperview()
            summaryView = nil
        }
        textViews = Self.place(plan.texts, in: textViews, on: card)
        let bulletCount = plan.layout.body.bullets.filter { $0 != nil }.count
        bulletViews = Self.place(plan.bullet.map { Array(repeating: $0, count: bulletCount) } ?? [], in: bulletViews, on: card)
        setNeedsLayout()
        rasterize()
    }

    private static func place(_ layout: ChatTextLayout, in view: ChangelogTextView?, on parent: UIView) -> ChangelogTextView {
        let view = view ?? ChangelogTextView()
        if view.superview !== parent { parent.addSubview(view) }
        if view.layout !== layout {
            view.layout = layout
            view.image = nil
        }
        return view
    }

    private static func place(_ layouts: [ChatTextLayout], in views: [ChangelogTextView], on parent: UIView) -> [ChangelogTextView] {
        for view in views.dropFirst(layouts.count) { view.removeFromSuperview() }
        return layouts.enumerated().map { index, layout in
            place(layout, in: index < views.count ? views[index] : nil, on: parent)
        }
    }

    /// Asks for the bitmaps of the text drawn, at its frames snapped to
    /// this screen, in this appearance. The bullets share one.
    private func rasterize() {
        rasterToken += 1
        isRasterized = false
        guard drawsText, let plan, window != nil || superview != nil else { return }
        let scale = window?.screen.scale ?? traitCollection.displayScale
        let look = ChangelogRaster.Look(scale: scale > 0 ? scale : 1, traits: traitCollection)
        let body = plan.layout.body
        var views: [[ChangelogTextView]] = []
        var items: [ChangelogRaster.Item] = []
        func add(_ layout: ChatTextLayout?, _ frame: CGRect?, _ shown: [ChangelogTextView]) {
            guard let layout, let frame, !shown.isEmpty else { return }
            let size = PixelGrid.snap(frame, scale: look.scale).size
            items.append(.init(string: layout.string, width: layout.width, size: size))
            views.append(shown)
        }
        add(plan.title, plan.layout.group.header, titleView.map { [$0] } ?? [])
        add(plan.summary, body.summary, summaryView.map { [$0] } ?? [])
        for (index, (layout, frame)) in zip(plan.texts, body.texts).enumerated() where index < textViews.count {
            add(layout, frame, [textViews[index]])
        }
        add(plan.bullet, body.bullets.compactMap { $0 }.first, bulletViews)
        rasterViews = views
        let token = rasterToken
        ChangelogRaster.queue.async { [weak self, items, look] in
            let images = UncheckedImages(images: ChangelogRaster.draw(items, look: look))
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.take(images.images, token: token) }
            }
        }
    }

    private func take(_ images: [CGImage?], token: Int) {
        guard rasterToken == token else { return }
        ApplyPerf.measure(.screen) {
            for (shown, image) in zip(rasterViews, images) {
                for view in shown { view.image = image }
            }
            return rasterViews.count
        }
        isRasterized = true
    }

    // MARK: Links and copy

    /// A piece of text by where it is in the entry.
    private struct Hit {
        var layout: ChatTextLayout
        /// In the text's own coordinates.
        var point: CGPoint
        /// A paragraph or bullet item, which RN lets you copy.
        var copyable: Bool
    }

    private func hit(at point: CGPoint) -> Hit? {
        guard let plan else { return nil }
        let card = plan.layout.group.card
        let inCard = CGPoint(x: point.x - card.minX, y: point.y - card.minY)
        let body = plan.layout.body
        if let summary = plan.summary, let frame = body.summary, frame.insetBy(dx: -4, dy: -4).contains(inCard) {
            return Hit(layout: summary, point: CGPoint(x: inCard.x - frame.minX, y: inCard.y - frame.minY), copyable: false)
        }
        for (layout, frame) in zip(plan.texts, body.texts) where frame.insetBy(dx: -4, dy: -4).contains(inCard) {
            return Hit(layout: layout, point: CGPoint(x: inCard.x - frame.minX, y: inCard.y - frame.minY), copyable: true)
        }
        return nil
    }

    /// The link under `point`, in this view's coordinates.
    func link(at point: CGPoint) -> URL? {
        guard let hit = hit(at: point), let link = hit.layout.link(at: hit.point) else { return nil }
        return URL(string: link)
    }

    override func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
        let point = recognizer.location(in: self)
        if recognizer === tap { return link(at: point) != nil }
        if recognizer === hold { return hit(at: point)?.copyable == true }
        return super.gestureRecognizerShouldBegin(recognizer)
    }

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        if let url = link(at: recognizer.location(in: self)) { openLink(url) }
    }

    @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began else { return }
        let point = recognizer.location(in: self)
        guard let hit = hit(at: point), hit.copyable else { return }
        callout.present(copying: hit.layout.string.string, at: point, in: self)
    }

    // MARK: VoiceOver

    override var accessibilityElements: [Any]? {
        get {
            if let elements { return elements }
            let made = makeElements()
            elements = made
            return made
        }
        set {}
    }

    /// The title as a heading, then each text, its links as actions;
    /// framed from the plan, so they are there while nothing is drawn.
    private func makeElements() -> [UIAccessibilityElement] {
        guard let plan else { return [] }
        let group = plan.layout.group
        let body = plan.layout.body
        var elements: [UIAccessibilityElement] = []
        func element(_ layout: ChatTextLayout, frame: CGRect, traits: UIAccessibilityTraits) {
            let element = UIAccessibilityElement(accessibilityContainer: self)
            element.accessibilityLabel = layout.string.string
            element.accessibilityTraits = traits
            element.accessibilityFrameInContainerSpace = frame
            element.accessibilityCustomActions = ChangelogPlan.links(in: layout.string).map { link in
                UIAccessibilityCustomAction(name: link.label) { [weak self] _ in
                    self?.openLink(link.url)
                    return true
                }
            }
            elements.append(element)
        }
        if let frame = group.header { element(plan.title, frame: frame, traits: .header) }
        let card = group.card.origin
        func inCard(_ frame: CGRect) -> CGRect { frame.offsetBy(dx: card.x, dy: card.y) }
        if let summary = plan.summary, let frame = body.summary { element(summary, frame: inCard(frame), traits: .staticText) }
        for (layout, frame) in zip(plan.texts, body.texts) {
            element(layout, frame: inCard(frame), traits: .staticText)
        }
        return elements
    }
}
#endif
