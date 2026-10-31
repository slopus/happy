#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Rich task cards (`TaskListLayout`) in one row of Home's grouped list, the
/// unsectioned ones or a section's; "+N more" opens a card out for the
/// screen's lifetime. Only an item that changed is reconfigured and measured.
final class TaskListView: UIView {
    private typealias M = TaskListMetrics
    /// The row it draws (`TaskList.cards(_:block:)`); nil for every card.
    var block: String?
    var onOpen: ((TaskList.Item) -> Void)?
    /// The list grew or shrank, or what the reader is on moved in it (`drift`).
    var onResize: (() -> Void)?
    /// Its part of a scrolling list on screen, in its own space; nil for all of it. Braille off it stands still.
    var viewport: CGRect? { didSet { if viewport != oldValue { showOnScreen() } } }
    /// How far the first item on screen moved since the list around last kept the reader's place.
    var drift: CGFloat = 0, images: Images?
    /// A face's or a mark's picture at hand, by user id or path (the Harness's).
    var picture: ((String) -> UIImage?)?
    /// The story rings cards' discs wear, by agent; Stories fill it in.
    var rings: [String: StoryRing] = [:] { didSet { if rings != oldValue { refresh() } } }
    /// A ringed disc was tapped: the card, and the ring to grow the viewer out of.
    var onOpenStory: ((TaskList.Card, UIView) -> Void)?
    /// Who the cards' faces are (`HomeSnapshot.people`).
    var people: [String: Person] = [:] { didSet { if people != oldValue { refresh() } } }
    /// What faces are ringed in: the ground under the list.
    var ground = UIColor(Palette.groupedCard) { didSet { views.values.forEach { $0.ground = ground } } }
    var selectedId: String? { didSet { for (id, view) in views { view.selected = id == selectedId } } }
    /// Lit under a finger.
    var pressedId: String? { didSet { for (id, view) in views { view.pressed = id == pressedId } } }

    private var model: RichTasks? { didSet { if model != oldValue { refresh() } } }
    private var expanded = Set<String>()
    private(set) var items: [TaskList.Item] = []
    private var views: [String: TaskRowView] = [:]
    /// Each item as measured, until it or its time changes; how many measurements were made; the width `result` is for.
    private var measured: [String: TaskListLayout.Item] = [:]
    private(set) var measures = 0
    private var laidOut: CGFloat?
    /// The type at the reader's text size; a new size measures and lays out everything again.
    private lazy var text = TaskListText(traitCollection)
    private(set) lazy var result = TaskListLayout.layout([], width: 0, text: text.text)

    override init(frame: CGRect) {
        super.init(frame: frame)
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (self: Self, _) in
            (self.text, self.measured, self.laidOut) = (TaskListText(self.traitCollection), [:], nil)
            for item in self.items { self.views[item.id]?.configure(item, self.text) }
            self.setNeedsLayout()
            self.onResize?()
        }
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped(_:))))
        let press = PressRecognizer(target: self, action: #selector(pressed(_:)))
        press.delegate = PressRecognizer.simultaneous
        addGestureRecognizer(press)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Shows `model`, touching only the items that changed.
    func apply(_ model: RichTasks?) {
        dispatchPrecondition(condition: .onQueue(.main))
        self.model = model
    }

    var contentHeight: CGFloat { layout().height }

    private func refresh() {
        let old = layout()
        // The first item on screen, to keep under the reader's eye.
        let anchor = viewport.flatMap { rect in zip(items, old.frames).first { $0.1.box.maxY > rect.minY } }.map { (id: $0.0.id, y: $0.1.box.minY) }
        let previous = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        items = TaskList.items(model.map { TaskList.cards($0, block: block) } ?? [], expanded: expanded).map { item in
            guard case .card(var card) = item else { return item }
            card.people = card.faces.map { people[$0] }
            if let ring = rings[card.agentId] { (card.story, card.ring) = (true, ring) }
            return .card(card)
        }
        for item in items where previous[item.id] != item || views[item.id] == nil {
            if views[item.id] == nil {
                let view = TaskRowView()
                (view.images, view.picture, view.ground, view.selected) = (images, picture, ground, item.id == selectedId)
                addSubview(view)
                views[item.id] = view
            }
            views[item.id]?.configure(item, text)
            measured[item.id] = nil
        }
        let live = Set(items.map(\.id))
        for (id, view) in views where !live.contains(id) {
            view.removeFromSuperview()
            (views[id], measured[id]) = (nil, nil)
        }
        laidOut = nil
        setNeedsLayout()
        let new = layout()
        if let anchor, let index = items.firstIndex(where: { $0.id == anchor.id }) { drift += new.frames[index].box.minY - anchor.y }
        if new.height != old.height || drift != 0 { onResize?() }
    }

    /// The frames, from each item as last measured: only what changed is measured.
    private func layout() -> TaskListLayout.Result {
        if laidOut == bounds.width { return result }
        let input = items.map { item in
            if let known = measured[item.id] { return known }
            measures += 1
            measured[item.id] = text.input(item)
            return measured[item.id]!
        }
        result = TaskListLayout.layout(input, width: bounds.width, text: text.text, hairline: 1 / max(1, traitCollection.displayScale))
        laidOut = bounds.width
        return result
    }

    /// The cards' times as the clock reads them now; one that changed is measured again.
    func tick() {
        let changed = views.filter { $0.value.refreshTime() }.keys
        guard !changed.isEmpty else { return }
        changed.forEach { measured[$0] = nil }
        laidOut = nil
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        for (item, frame) in zip(items, layout().frames) { views[item.id]?.frames = frame }
        showOnScreen()
    }

    private func showOnScreen() {
        for view in views.values { view.onScreen = viewport.map(view.frame.intersects) ?? true }
    }

    /// The item under `point`; "+N more" takes the gutters around it, so its target is 44 tall.
    private func index(at point: CGPoint) -> Int? {
        let frames = layout().frames
        return frames.indices.first { if case .more = items[$0] { hit(frames[$0].box).contains(point) } else { false } } ?? frames.firstIndex { $0.box.contains(point) }
    }

    /// `rect` grown to a finger's 44 each way.
    private func hit(_ rect: CGRect) -> CGRect { rect.insetBy(dx: min(0, (rect.width - M.hit) / 2), dy: min(0, (rect.height - M.hit) / 2)) }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        let point = gesture.location(in: self)
        guard let index = index(at: point) else { return }
        let item = items[index], frame = result.frames[index]
        switch item {
        case .more(let taskId, _):
            toggle(taskId)
        case .card(let card) where card.more != nil && frame.more.map(hit)?.contains(point) == true:
            // The corner's "+N more", with a finger's room around it.
            toggle(card.taskId)
        case .card(let card) where card.story && frame.ring?.contains(point) == true:
            // The ring is its stories; the rest of the card, its chat.
            if let view = views[item.id] { onOpenStory?(card, view.ringView) }
        default:
            onOpen?(item)
        }
    }

    /// Opens a card out, or closes it again.
    func toggle(_ taskId: String) {
        if expanded.remove(taskId) == nil { expanded.insert(taskId) }
        refresh()
    }

    @objc private func pressed(_ gesture: PressRecognizer) {
        let index = index(at: gesture.location(in: self)).flatMap { (index: Int) -> Int? in if case .more = items[index] { nil } else { index } }
        pressedId = gesture.state == .began || gesture.state == .changed ? index.map { items[$0].id } : nil
    }
}

/// One item of the list: a card, a sub-row or "+N more".
final class TaskRowView: UIView {
    typealias M = TaskListMetrics
    var images: Images?
    var picture: ((String) -> UIImage?)?
    var ground = UIColor.clear { didSet { applyColors() } }
    var selected = false { didSet { if selected != oldValue { applyColors() } } }
    var pressed = false { didSet { if pressed != oldValue { applyColors() } } }
    /// Off screen, its braille stands still.
    var onScreen = true { didSet { braille.running = onScreen && !braille.isHidden } }
    private(set) var item: TaskList.Item?
    var frames: TaskListLayout.Frame? { didSet { if let frames, frames != oldValue { frame = frames.box; setNeedsLayout() } } }
    private var job: Task<Void, Never>?
    private let highlight = UIView(), label = UILabel(), time = UILabel(), more = UILabel(), meta = UILabel()
    /// The story ring round the disc, which the viewer grows out of, and its arcs, seen and new.
    let ringView = UIView()
    private let seenArc = CAShapeLayer(), newArc = CAShapeLayer()
    private let letter = UILabel(), dot = UIView(), tile = UIView(), icon = UIImageView(), mark = UIImageView(), separator = UIView()
    private let status = StatusTextView(), braille = BrailleView()
    private var faces: [FaceView] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        // The tile under its mark; none takes a touch, as the row takes none.
        [separator, highlight, label, letter, icon, ringView, time, status, more, dot, braille, tile, mark, meta].forEach(addSubview)
        (letter.textColor, letter.textAlignment, letter.layer.masksToBounds) = (.white, .center, true)
        for arc in [seenArc, newArc] { (arc.fillColor, arc.lineWidth) = (nil, M.storyRing); ringView.layer.addSublayer(arc) }
        (highlight.layer.cornerCurve, braille.tintColor, dot.backgroundColor) = (.continuous, UIColor(Palette.taskMuted), UIColor(Palette.taskMuted))
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func configure(_ item: TaskList.Item, _ text: TaskListText) {
        self.item = item
        let muted = UIColor(Palette.taskMuted), ink = UIColor(Palette.taskText), s = text.text.scale
        switch item {
        case .card(let card):
            (label.font, label.textColor, label.text) = (text.title, ink, card.title)
            showIcon(card)
            ringView.isHidden = !card.story
            (time.font, time.textColor, time.textAlignment) = (text.time, muted, .right)
            time.text = card.time.map { RowTime.text($0) }
            (status.text, status.line) = (text.status(card.status ?? ""), M.statusLine * s)
            (more.isHidden, more.textAlignment) = (card.more == nil, .right)
            more.attributedText = card.more.map { NSAttributedString(string: Strings.TaskList.more($0), attributes: [.font: text.more, .foregroundColor: UIColor(Palette.taskAccent)]) }
            let ids = Array(card.faces.prefix(M.faces))
            while faces.count > ids.count { faces.removeLast().removeFromSuperview() }
            while faces.count < ids.count { faces.append(FaceView()); addSubview(faces.last!) }
            for (index, (face, id)) in zip(faces, ids).enumerated() { face.show(id, person: card.people[index], picture: picture?(id), images: images) }
            dot.isHidden = card.signal != .dot
            (braille.isHidden, braille.running) = (card.signal != .braille, onScreen && card.signal == .braille)
        case .subRow(let row):
            // A hidden row, shown faded: its name in the muted ink, its mark at half.
            let name = NSMutableAttributedString(string: row.title, attributes: [.font: text.status, .foregroundColor: row.dimmed ? muted : ink])
            if let detail = row.detail { name.append(NSAttributedString(string: " · \(detail)", attributes: [.font: text.status, .foregroundColor: muted])) }
            (label.attributedText, label.lineBreakMode) = (name, .byTruncatingTail)
            showMark(row.mark, glyph: M.markGlyph * s)
            (tile.alpha, mark.alpha) = row.dimmed ? (M.dimmed, M.dimmed) : (1, 1)
            (meta.textAlignment, meta.attributedText) = (.right, row.changes.map(text.meta))
            (dot.isHidden, braille.isHidden, braille.running) = (true, !row.working, onScreen && row.working)
        case .more(_, let count):
            (label.font, label.textColor) = (text.more, UIColor(Palette.taskAccent))
            label.text = count.map(Strings.TaskList.more) ?? Strings.TaskList.hide
        }
        (isAccessibilityElement, accessibilityTraits) = (true, .button)
        accessibilityLabel = [label.text, time.text].compactMap { $0 }.joined(separator: ", ")
        applyColors()
        setNeedsLayout()
    }

    /// The card's time as the clock reads it now; true when it changed.
    func refreshTime() -> Bool {
        guard case .card(let card) = item, case let text = card.time.map({ RowTime.text($0) }), text != time.text else { return false }
        time.text = text
        return true
    }

    /// The daemon's icon by slug and hash, else an older daemon's clay one; its letter's tile until one comes, or with none.
    private func showIcon(_ card: TaskList.Card) {
        job?.cancel()
        let pixels = Int(M.disc * traitCollection.displayScale)
        if let path = card.iconPath { icon.image = picture?(path) ?? images?.cachedPicture(path, thumbhash: nil, pixels: pixels) }
        else { icon.image = card.iconSlug.flatMap(ClayIconImages.image) }
        (letter.text, letter.isHidden) = (card.letter, icon.image != nil)
        letter.backgroundColor = UIColor(FaceView.colors[TaskList.tint(card.taskId, among: FaceView.colors.count)])
        guard icon.image == nil, let path = card.iconPath, let images else { return }
        job = Task { [weak self] in
            guard let image = await images.picture(path, thumbhash: nil, pixels: pixels), !Task.isCancelled, let self else { return }
            (icon.image, letter.isHidden) = (image, true)
        }
    }

    private func showMark(_ shown: TaskList.Mark, glyph: CGFloat) {
        job?.cancel()
        switch shown {
        case .glyph(let name):
            (tile.isHidden, mark.contentMode, mark.image, mark.tintColor) = (false, .center, Glyphs.image(name, size: glyph), UIColor(Palette.taskMuted))
        case .picture(let path):
            (tile.isHidden, mark.contentMode, mark.clipsToBounds, mark.image) = (true, .scaleAspectFill, true, picture?(path))
            guard mark.image == nil, let images else { return }
            let pixels = Int(M.mark * traitCollection.displayScale)
            job = Task { [weak self] in
                guard let image = await images.picture(path, thumbhash: nil, pixels: pixels), !Task.isCancelled else { return }
                self?.mark.image = image
            }
        }
    }

    private func applyColors() {
        let accent = UIColor(Palette.taskAccent).resolvedColor(with: traitCollection)
        let ink = UIColor(Palette.taskText).resolvedColor(with: traitCollection)
        highlight.backgroundColor = selected ? accent.withAlphaComponent(M.selectedAlpha) : pressed ? ink.withAlphaComponent(M.pressedAlpha) : nil
        tile.backgroundColor = ink.withAlphaComponent(M.markInk)
        separator.backgroundColor = UIColor(Palette.groupedSeparator)
        newArc.strokeColor = accent.cgColor
        seenArc.strokeColor = UIColor(Palette.storiesSeen).resolvedColor(with: traitCollection).cgColor
        let around = selected ? ground.resolvedColor(with: traitCollection).mixed(with: accent, M.selectedAlpha) : ground
        for face in faces { (face.ringColor, face.fill) = (around, ink.withAlphaComponent(M.discInk)) }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let f = frames, let item else { return }
        func local(_ rect: CGRect?) -> CGRect { rect?.offsetBy(dx: -f.box.minX, dy: -f.box.minY) ?? .zero }
        highlight.layer.cornerRadius = f.radius
        for (view, rect) in [(highlight, f.highlight), (label, f.label), (ringView, f.ring), (letter, f.icon), (icon, f.icon), (time, f.time), (status, f.status), (more, f.more), (dot, f.signal), (braille, f.signal), (tile, f.mark), (mark, f.mark), (meta, f.meta), (separator, f.separator)] as [(UIView, CGRect?)] {
            view.frame = local(rect)
        }
        for view in [ringView, letter, dot] { view.layer.cornerRadius = view.bounds.width / 2 }
        letter.font = Fonts.ui(.semiBold, size: letter.bounds.height * M.letterScale)
        status.lineEnd = f.statusEnd.map { $0 - (f.status?.minX ?? 0) }
        for (face, rect) in zip(faces, f.faces) { face.frame = local(rect) }
        (tile.layer.cornerRadius, mark.layer.cornerRadius) = (M.markRadius * tile.bounds.width / M.mark, M.markRadius * tile.bounds.width / M.mark)
        if case .card(let card) = item {
            let arcs = StoriesCircleView.ring(card.ring?.storyIds.count ?? 0, new: card.ring?.unseenCount ?? 0, center: CGPoint(x: ringView.bounds.midX, y: ringView.bounds.midY), radius: (ringView.bounds.width - M.storyRing) / 2)
            (seenArc.path, newArc.path) = (arcs.seen, arcs.unseen)
        }
    }
}

/// A person's face, ringed in the ground: their picture (`/v0/users/:id/photo`),
/// its thumbhash until it comes, else their initial on a colour of their own,
/// a plain disc when there is no name either.
final class FaceView: UIView {
    private let ring = CALayer(), image = UIImageView(), initial = UILabel()
    private var job: Task<Void, Never>?
    private var tint: ColorToken? { didSet { image.backgroundColor = tint.map { UIColor($0) } ?? fill } }
    var ringColor = UIColor.clear { didSet { ring.backgroundColor = ringColor.resolvedColor(with: traitCollection).cgColor } }
    var fill = UIColor.clear { didSet { image.backgroundColor = tint.map { UIColor($0) } ?? fill } }
    /// An initial's colours: main's tile inks, one picked by the person's id.
    static let colors = [Palette.tileBlue, Palette.tileGreen, Palette.tileOrange, Palette.tileIndigo, Palette.tilePurple, Palette.tileRed, Palette.tileTeal]

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        layer.addSublayer(ring)
        (image.contentMode, image.clipsToBounds) = (.scaleAspectFill, true)
        (initial.textColor, initial.textAlignment) = (.white, .center)
        [image, initial].forEach(addSubview)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// `userId`'s face: `picture` when at hand, else theirs as read, its thumbhash or their initial first.
    func show(_ userId: String, person: Person?, picture: UIImage?, images: Images?) {
        job?.cancel()
        let path = Person.photoPath(userId), pixels = Int(TaskListMetrics.chip * 3), thumbhash = person?.thumbhash
        let cached = picture ?? images?.cachedPicture(path, thumbhash: thumbhash, pixels: pixels)
        image.image = cached ?? ThumbHashImages.image(thumbhash)
        let letter = image.image == nil ? person?.name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } : nil
        initial.text = letter
        tint = letter.map { _ in Self.colors[TaskList.tint(userId, among: Self.colors.count)] }
        guard cached == nil, person?.hasPhoto == true, let images else { return }
        job = Task { [weak self] in
            let read = await images.picture(path, thumbhash: thumbhash, pixels: pixels)
            guard !Task.isCancelled, let read, let self else { return }
            (image.image, initial.text, tint) = (read, nil, nil)
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        ring.frame = bounds.insetBy(dx: -TaskListMetrics.faceRing, dy: -TaskListMetrics.faceRing)
        ring.cornerRadius = ring.bounds.width / 2
        CATransaction.commit()
        (image.frame, initial.frame) = (bounds, bounds)
        image.layer.cornerRadius = bounds.width / 2
        initial.font = Fonts.ui(.semiBold, size: bounds.height * TaskListMetrics.initialScale)
    }
}

/// A card's status: two lines `line` apart, the second ending short of the corner (`lineEnd`).
final class StatusTextView: UIView {
    private let storage = NSTextStorage(), manager = NSLayoutManager(), container = NSTextContainer(size: .zero)
    var text = NSAttributedString() { didSet { storage.setAttributedString(text); setNeedsDisplay() } }
    var line: CGFloat = 0
    var lineEnd: CGFloat? { didSet { setNeedsLayout() } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        (isOpaque, backgroundColor, contentMode) = (false, .clear, .redraw)
        (container.lineFragmentPadding, container.maximumNumberOfLines, container.lineBreakMode) = (0, 2, .byWordWrapping)
        (manager.addTextContainer(container), storage.addLayoutManager(manager))
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        container.size = bounds.size
        container.exclusionPaths = lineEnd.map { [UIBezierPath(rect: CGRect(x: $0, y: line, width: bounds.width + line, height: line))] } ?? []
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        manager.drawGlyphs(forGlyphRange: manager.glyphRange(for: container), at: .zero)
    }
}

/// The list's type at the reader's text size: Figtree in Apple's text styles
/// (`UIFontMetrics`), and what the layout needs to know of it.
@MainActor
struct TaskListText {
    typealias M = TaskListMetrics
    let title, time, status, more: UIFont
    let text: TaskListLayout.Text

    init(_ traits: UITraitCollection) {
        func styled(_ style: UIFont.TextStyle, _ font: UIFont) -> UIFont { UIFontMetrics(forTextStyle: style).scaledFont(for: font, compatibleWith: traits) }
        func face(_ font: UIFont) -> TaskListLayout.Face { .init(ascender: font.ascender, capHeight: font.capHeight, xHeight: font.xHeight, lineHeight: font.lineHeight) }
        (title, status) = (styled(.callout, Fonts.ui(.semiBold, size: M.titleSize)), styled(.subheadline, Fonts.ui(.regular, size: M.textSize)))
        (time, more) = (Fonts.tabular(status), styled(.subheadline, Fonts.ui(.semiBold, size: M.textSize)))
        let s = UIFontMetrics(forTextStyle: .subheadline).scaledValue(for: M.textSize, compatibleWith: traits) / M.textSize
        // Telegram's: the disc shrinks with Body below Large and never grows past 60.
        let disc = min(M.disc, (M.disc * UIFontMetrics(forTextStyle: .body).scaledValue(for: M.bodySize, compatibleWith: traits) / M.bodySize).rounded())
        // TextKit puts a held line's extra room over its text: the baseline stands the descender over the line's foot.
        text = .init(title: face(title), time: face(time), status: face(status), row: face(status), more: face(more), scale: s, disc: disc, statusBaseline: M.statusLine * s + status.descender)
    }

    func status(_ text: String) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        (paragraph.minimumLineHeight, paragraph.maximumLineHeight) = (M.statusLine * self.text.scale, M.statusLine * self.text.scale)
        return NSAttributedString(string: text, attributes: [.font: status, .foregroundColor: UIColor(Palette.taskMuted), .paragraphStyle: paragraph])
    }

    /// "+2.8k −453" in the diff's colours, or "merged".
    func meta(_ changes: Row.LineChanges) -> NSAttributedString {
        guard !changes.isEmpty else { return NSAttributedString(string: Strings.TaskList.merged, attributes: [.font: time, .foregroundColor: UIColor(Palette.taskMuted)]) }
        let text = NSMutableAttributedString(string: "+\(StoryRowText.compactCount(changes.added))", attributes: [.font: time, .foregroundColor: UIColor(Palette.taskAdded)])
        text.append(NSAttributedString(string: " \u{2212}\(StoryRowText.compactCount(changes.deleted))", attributes: [.font: time, .foregroundColor: UIColor(Palette.taskRemoved)]))
        return text
    }

    static func width(_ text: String, _ font: UIFont) -> CGFloat { ceil((text as NSString).size(withAttributes: [.font: font]).width) }

    /// What the layout needs to know of an item, measured.
    func input(_ item: TaskList.Item) -> TaskListLayout.Item {
        switch item {
        case .more: return .more
        case .subRow(let row): return .subRow(metaWidth: row.changes.map { ceil(meta($0).size().width) } ?? 0, working: row.working)
        case .card(let card):
            return .card(.init(timeWidth: card.time.map { Self.width(RowTime.text($0), time) } ?? 0, moreWidth: card.more.map { Self.width(Strings.TaskList.more($0), more) },
                               faces: card.faces.count, signal: card.signal == .dot ? .dot : card.signal == .braille ? .braille : .none, story: card.story))
        }
    }
}
#endif
