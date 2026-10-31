#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Rich tasks where Home's tasks were (`TaskListLayout`): section headers
/// that fold, 3-line cards with corner B, the sub-rows under each and
/// "+N more", which opens a card out for the screen's lifetime. Views and
/// measurements are kept by item: an unchanged one is not touched, a changed
/// one is reconfigured and measured again on its own. What is folded or
/// opened out is this screen's own.
final class TaskListView: UIView {
    var onOpen: ((TaskList.Item) -> Void)?
    /// The list grew or shrank, or what the reader is on moved in it (`drift`).
    var onResize: (() -> Void)?
    /// Its part of a scrolling list on screen, in its own space; nil for all of it. Braille off it stands still.
    var viewport: CGRect? { didSet { if viewport != oldValue { showOnScreen() } } }
    /// How far the first item on screen moved since the list around last kept the reader's place.
    var drift: CGFloat = 0
    var images: Images?
    /// A face's or a mark's picture at hand, by user id or path (the Harness's).
    var picture: ((String) -> UIImage?)?
    /// Tasks whose disc wears a story's ring; Stories fill it in.
    var rings: Set<String> = [] { didSet { if rings != oldValue { refresh() } } }
    /// What faces are ringed in: the ground under the list.
    var ground = UIColor(Palette.groupedCard) { didSet { views.values.forEach { $0.ground = ground } } }
    var selectedId: String? { didSet { for (id, view) in views { view.selected = id == selectedId } } }
    /// Lit under a finger.
    var pressedId: String? { didSet { for (id, view) in views { view.pressed = id == pressedId } } }

    private var model: RichTasks?
    private var expanded = Set<String>()
    private var folded: [String: Bool] = [:]
    private(set) var items: [TaskList.Item] = []
    private var views: [String: TaskRowView] = [:]
    /// Each item as measured, until it or its time changes; and how many measurements were made.
    private var measured: [String: TaskListLayout.Item] = [:]
    private(set) var measures = 0
    /// The width `result` is for; nil once the items changed.
    private var laidOut: CGFloat?
    private(set) var result = TaskListLayout.Result(frames: [], height: 0)

    override init(frame: CGRect) {
        super.init(frame: frame)
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped(_:))))
        let press = PressRecognizer(target: self, action: #selector(pressed(_:)))
        press.delegate = PressRecognizer.simultaneous
        addGestureRecognizer(press)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Shows `model`, touching only the items that changed.
    func apply(_ model: RichTasks?) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard model != self.model else { return }
        self.model = model
        refresh()
    }

    var contentHeight: CGFloat { layout().height }

    private func refresh() {
        let old = layout()
        // The first item on screen, to keep under the reader's eye.
        let anchor = viewport.flatMap { rect in zip(items, old.frames).first { $0.1.box.maxY > rect.minY } }.map { (id: $0.0.id, y: $0.1.box.minY) }
        let previous = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        items = (model.map { TaskList.items($0, expanded: expanded, folded: folded) } ?? []).map { item in
            guard case .card(var card) = item, rings.contains(card.taskId) else { return item }
            card.story = true
            return .card(card)
        }
        for item in items {
            if let view = views[item.id] {
                if previous[item.id] != item {
                    view.configure(item)
                    measured[item.id] = nil
                }
                continue
            }
            let view = TaskRowView()
            view.images = images
            view.picture = picture
            view.ground = ground
            view.selected = item.id == selectedId
            addSubview(view)
            views[item.id] = view
            view.configure(item)
        }
        let live = Set(items.map(\.id))
        for (id, view) in views where !live.contains(id) {
            view.removeFromSuperview()
            views.removeValue(forKey: id)
            measured[id] = nil
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
        var input: [TaskListLayout.Item] = []
        for item in items {
            if measured[item.id] == nil {
                measured[item.id] = TaskListText.input(item)
                measures += 1
            }
            input.append(measured[item.id]!)
        }
        result = TaskListLayout.layout(input, width: bounds.width, text: TaskListText.text)
        laidOut = bounds.width
        return result
    }

    /// The cards' times as the clock reads them now; one that changed is measured again.
    func tick() {
        var changed = false
        for (id, view) in views where view.refreshTime() {
            measured[id] = nil
            changed = true
        }
        guard changed else { return }
        laidOut = nil
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        for (item, frame) in zip(items, layout().frames) { views[item.id]?.apply(frame) }
        showOnScreen()
    }

    private func showOnScreen() {
        for view in views.values { view.onScreen = viewport.map(view.frame.intersects) ?? true }
    }

    private func index(at point: CGPoint) -> Int? {
        layout().frames.firstIndex { $0.box.contains(point) }
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        let point = gesture.location(in: self)
        guard let index = index(at: point) else { return }
        let item = items[index]
        switch item {
        case .header(let id, _, let collapsed):
            folded[id] = !collapsed
            refresh()
        case .more(let taskId, _):
            toggle(taskId)
        case .card(let card):
            // The corner's "+N more", with a finger's room around it.
            if card.more != nil, let more = result.frames[index].more, more.insetBy(dx: -8, dy: -8).contains(point) {
                toggle(card.taskId)
            } else {
                onOpen?(item)
            }
        case .subRow:
            onOpen?(item)
        }
    }

    /// Opens a card out, or closes it again.
    func toggle(_ taskId: String) {
        if expanded.remove(taskId) == nil { expanded.insert(taskId) }
        refresh()
    }

    @objc private func pressed(_ gesture: PressRecognizer) {
        let index = index(at: gesture.location(in: self))
        let opens = index.map { if case .card = items[$0] { true } else if case .subRow = items[$0] { true } else { false } } ?? false
        pressedId = opens && (gesture.state == .began || gesture.state == .changed) ? index.map { items[$0].id } : nil
    }
}

/// One item of the list: a header, a card, a sub-row or "+N more".
final class TaskRowView: UIView {
    typealias M = TaskListMetrics
    var images: Images?
    var picture: ((String) -> UIImage?)?
    var ground = UIColor.clear { didSet { applyColors() } }
    var selected = false { didSet { if selected != oldValue { applyColors() } } }
    var pressed = false { didSet { if pressed != oldValue { applyColors() } } }
    /// Off screen, its braille stands still.
    var onScreen = true { didSet { if onScreen != oldValue, corner == .braille { braille.running = onScreen } } }
    private(set) var item: TaskList.Item?
    private var frames: TaskListLayout.Frame?
    private var corner = Row.Corner.none
    private var job: Task<Void, Never>?

    private let highlight = UIView()
    private let label = UILabel()
    private lazy var ring = add(UIView())
    private lazy var disc = add(UIView())
    private lazy var icon = add(UIImageView())
    private lazy var time = add(UILabel())
    private lazy var status = add(StatusTextView())
    private lazy var more = add(UILabel())
    private lazy var dot = add(UIView())
    private lazy var braille = add(BrailleView())
    private lazy var tile = add(UIView())
    private lazy var mark = add(UIImageView())
    private lazy var meta = add(UILabel())
    private lazy var chevron = add(UILabel())
    private var faces: [FaceView] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        highlight.isUserInteractionEnabled = false
        addSubview(highlight)
        addSubview(label)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func add<V: UIView>(_ view: V) -> V {
        view.isUserInteractionEnabled = false
        addSubview(view)
        return view
    }

    func configure(_ item: TaskList.Item) {
        self.item = item
        let muted = UIColor(Palette.taskMuted), ink = UIColor(Palette.taskText)
        switch item {
        case .header(_, let name, let collapsed):
            label.attributedText = NSAttributedString(string: name.uppercased(), attributes: [.font: TaskListText.headerFont, .foregroundColor: muted, .kern: M.headerTracking * M.headerSize])
            chevron.attributedText = NSAttributedString(string: collapsed ? "›" : "⌄", attributes: [.font: TaskListText.headerFont, .foregroundColor: muted])
            chevron.textAlignment = .right
        case .card(let card):
            label.font = TaskListText.titleFont
            label.textColor = ink
            label.text = card.title
            let clay = card.iconSlug.flatMap(ClayIconImages.image)
            icon.image = clay ?? Glyphs.image("tasks", size: 26)
            icon.contentMode = clay == nil ? .center : .scaleAspectFit
            icon.tintColor = muted
            ring.isHidden = !card.story
            ring.layer.borderWidth = M.storyRing
            time.font = TaskListText.timeFont
            time.textColor = muted
            time.textAlignment = .right
            time.text = card.time.map { RowTime.text($0) }
            status.text = TaskListText.status(card.status ?? "")
            more.isHidden = card.more == nil
            more.textAlignment = .right
            more.attributedText = card.more.map { NSAttributedString(string: Strings.TaskList.more($0), attributes: [.font: TaskListText.moreFont, .foregroundColor: UIColor(Palette.taskAccent)]) }
            let ids = Array(card.faces.prefix(M.faces))
            while faces.count > ids.count { faces.removeLast().removeFromSuperview() }
            while faces.count < ids.count { faces.append(add(FaceView())) }
            for (face, id) in zip(faces, ids) { face.show(id, picture: picture?(id), images: images) }
            signal(card.signal)
        case .subRow(let row):
            let text = NSMutableAttributedString(string: row.title, attributes: [.font: TaskListText.rowFont, .foregroundColor: ink])
            if let detail = row.detail { text.append(NSAttributedString(string: " · \(detail)", attributes: [.font: TaskListText.rowFont, .foregroundColor: muted])) }
            label.attributedText = text
            label.lineBreakMode = .byTruncatingTail
            showMark(row.mark)
            meta.textAlignment = .right
            meta.attributedText = row.changes.map(TaskListText.meta)
            signal(row.working ? .braille : .none)
            alpha = row.dimmed ? M.dimmed : 1
        case .more(_, let count):
            label.font = TaskListText.moreFont
            label.textColor = UIColor(Palette.taskAccent)
            label.text = count.map(Strings.TaskList.more) ?? Strings.TaskList.hide
        }
        isAccessibilityElement = true
        accessibilityLabel = [label.text, time.text].compactMap { $0 }.joined(separator: ", ")
        accessibilityTraits = if case .header = item { .header } else { .button }
        applyColors()
        setNeedsLayout()
    }

    private func signal(_ signal: Row.Corner) {
        corner = signal
        if case .card = item {
            dot.isHidden = signal != .dot
            dot.backgroundColor = UIColor(Palette.taskMuted)
        }
        braille.isHidden = signal != .braille
        braille.tintColor = UIColor(Palette.taskMuted)
        braille.running = onScreen && signal == .braille
    }

    /// The card's time as the clock reads it now; true when it changed.
    func refreshTime() -> Bool {
        guard case .card(let card) = item else { return false }
        let text = card.time.map { RowTime.text($0) }
        guard text != time.text else { return false }
        time.text = text
        return true
    }

    private func showMark(_ shown: TaskList.Mark) {
        job?.cancel()
        switch shown {
        case .glyph(let name):
            tile.isHidden = false
            mark.contentMode = .center
            mark.image = Glyphs.image(name, size: M.markGlyph)
            mark.tintColor = UIColor(Palette.taskMuted)
        case .picture(let path):
            tile.isHidden = true
            mark.contentMode = .scaleAspectFill
            mark.clipsToBounds = true
            mark.image = picture?(path)
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
        switch item {
        case .card:
            disc.backgroundColor = ink.withAlphaComponent(M.discInk)
            ring.layer.borderColor = accent.cgColor
            let around = selected ? TaskListText.blend(accent, M.selectedAlpha, over: ground.resolvedColor(with: traitCollection)) : ground
            for face in faces {
                face.ringColor = around
                face.fill = ink.withAlphaComponent(M.discInk)
            }
        case .subRow(let row):
            if case .glyph = row.mark { tile.backgroundColor = ink.withAlphaComponent(M.markInk) }
        default: break
        }
    }

    func apply(_ frames: TaskListLayout.Frame) {
        guard frames != self.frames else { return }
        self.frames = frames
        frame = frames.box
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let f = frames, let item else { return }
        func local(_ rect: CGRect) -> CGRect { rect.offsetBy(dx: -f.box.minX, dy: -f.box.minY) }
        highlight.frame = local(f.highlight)
        highlight.layer.cornerRadius = f.radius
        highlight.layer.cornerCurve = .continuous
        label.frame = local(f.label)
        switch item {
        case .header:
            chevron.frame = f.chevron.map(local) ?? .zero
        case .card:
            for (view, rect) in [(ring, f.ring), (disc, f.disc)] {
                view.frame = rect.map(local) ?? .zero
                view.layer.cornerRadius = view.bounds.width / 2
            }
            icon.frame = f.icon.map(local) ?? .zero
            time.frame = f.time.map(local) ?? .zero
            status.frame = f.status.map(local) ?? .zero
            status.lineEnd = f.statusEnd.map { $0 - (f.status?.minX ?? 0) }
            more.frame = f.more.map(local) ?? .zero
            for (face, rect) in zip(faces, f.faces) { face.frame = local(rect) }
            dot.frame = f.signal.map(local) ?? .zero
            dot.layer.cornerRadius = dot.bounds.height / 2
            braille.frame = dot.frame
        case .subRow(let row):
            tile.frame = f.mark.map(local) ?? .zero
            tile.layer.cornerRadius = M.markRadius
            mark.frame = tile.frame
            mark.layer.cornerRadius = if case .picture = row.mark { M.pictureRadius } else { 0 }
            meta.frame = f.meta.map(local) ?? .zero
            braille.frame = f.signal.map(local) ?? .zero
        case .more: break
        }
    }
}

/// A face on a card, ringed in the ground as a box shadow rings it: the
/// person's picture (`/v0/users/:id/photo`, as their stories show them), a
/// plain disc until it comes or when they have none.
final class FaceView: UIView {
    /// People with no picture, not asked again.
    private static var missing = Set<String>()
    private let ring = CALayer()
    private let image = UIImageView()
    private var job: Task<Void, Never>?
    var ringColor = UIColor.clear { didSet { ring.backgroundColor = ringColor.resolvedColor(with: traitCollection).cgColor } }
    var fill = UIColor.clear { didSet { image.backgroundColor = fill } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        layer.addSublayer(ring)
        image.contentMode = .scaleAspectFill
        image.clipsToBounds = true
        addSubview(image)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// `userId`'s face: `picture` when at hand, else theirs as read.
    func show(_ userId: String, picture: UIImage?, images: Images?) {
        job?.cancel()
        let path = "/v0/users/\(userId)/photo", pixels = Int(TaskListMetrics.chip * 3)
        image.image = picture ?? images?.cachedPicture(path, thumbhash: nil, pixels: pixels)
        guard image.image == nil, let images, !Self.missing.contains(userId) else { return }
        job = Task { [weak self] in
            let read = await images.picture(path, thumbhash: nil, pixels: pixels)
            guard !Task.isCancelled else { return }
            if read == nil { Self.missing.insert(userId) }
            self?.image.image = read
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        ring.frame = bounds.insetBy(dx: -TaskListMetrics.faceRing, dy: -TaskListMetrics.faceRing)
        ring.cornerRadius = ring.bounds.width / 2
        CATransaction.commit()
        image.frame = bounds
        image.layer.cornerRadius = bounds.width / 2
    }
}

/// A card's status: two 16 lines, the second ending short of the corner (`lineEnd`).
final class StatusTextView: UIView {
    private let storage = NSTextStorage()
    private let manager = NSLayoutManager()
    private let container = NSTextContainer(size: .zero)
    var text = NSAttributedString() { didSet { storage.setAttributedString(text); setNeedsDisplay() } }
    var lineEnd: CGFloat? { didSet { if lineEnd != oldValue { setNeedsLayout() } } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
        container.lineFragmentPadding = 0
        container.maximumNumberOfLines = 2
        container.lineBreakMode = .byWordWrapping
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        container.size = bounds.size
        let line = TaskListMetrics.statusLine
        container.exclusionPaths = lineEnd.map { [UIBezierPath(rect: CGRect(x: $0, y: line, width: bounds.width + line, height: line))] } ?? []
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        manager.drawGlyphs(forGlyphRange: manager.glyphRange(for: container), at: .zero)
    }
}

/// The list's faces as drawn and measured.
@MainActor
enum TaskListText {
    typealias M = TaskListMetrics
    static let titleFont = Fonts.ui(.semiBold, size: M.titleSize)
    static let timeFont = Fonts.tabular(Fonts.ui(.regular, size: M.timeSize))
    static let statusFont = Fonts.ui(.regular, size: M.statusSize)
    static let rowFont = Fonts.ui(.regular, size: M.subRowSize)
    static let moreFont = Fonts.ui(.semiBold, size: M.moreSize)
    static let headerFont = Fonts.ui(.semiBold, size: M.headerSize)

    static func face(_ font: UIFont) -> TaskListLayout.Face {
        .init(ascender: font.ascender, descender: -font.descender, capHeight: font.capHeight, xHeight: font.xHeight, lineHeight: font.lineHeight)
    }

    /// The status's baseline in its 16 line as TextKit sets it: the story rows' own, the same face on the same line.
    static let text = TaskListLayout.Text(title: face(titleFont), time: face(timeFont), status: face(statusFont), row: face(rowFont),
                                          more: face(moreFont), header: face(headerFont), statusBaseline: StoryRowText.text(1).statusBaseline)

    static func status(_ text: String) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = M.statusLine
        paragraph.maximumLineHeight = M.statusLine
        return NSAttributedString(string: text, attributes: [.font: statusFont, .foregroundColor: UIColor(Palette.taskMuted), .paragraphStyle: paragraph])
    }

    /// "+2.8k −453" in the diff's colours, or "merged".
    static func meta(_ changes: Row.LineChanges) -> NSAttributedString {
        guard !changes.isEmpty else { return NSAttributedString(string: Strings.TaskList.merged, attributes: [.font: timeFont, .foregroundColor: UIColor(Palette.taskMuted)]) }
        let text = NSMutableAttributedString(string: "+\(StoryRowText.compactCount(changes.added))", attributes: [.font: timeFont, .foregroundColor: UIColor(Palette.taskAdded)])
        text.append(NSAttributedString(string: " \u{2212}\(StoryRowText.compactCount(changes.deleted))", attributes: [.font: timeFont, .foregroundColor: UIColor(Palette.taskRemoved)]))
        return text
    }

    static func width(_ text: NSAttributedString) -> CGFloat { ceil(text.size().width) }

    /// What the layout needs to know of an item, measured.
    static func input(_ item: TaskList.Item) -> TaskListLayout.Item {
        switch item {
        case .header(_, _, let collapsed): return .header(collapsed: collapsed)
        case .more: return .more
        case .subRow(let row): return .subRow(metaWidth: row.changes.map { width(meta($0)) } ?? 0, working: row.working)
        case .card(let card):
            let time = card.time.map { width(NSAttributedString(string: RowTime.text($0), attributes: [.font: timeFont])) } ?? 0
            let more = card.more.map { width(NSAttributedString(string: Strings.TaskList.more($0), attributes: [.font: moreFont])) }
            return .card(.init(timeWidth: time, moreWidth: more, faces: card.faces.count, signal: SidebarLayout.Corner(card.signal), story: card.story))
        }
    }

    /// `top` at `alpha` over `base`, as one opaque colour.
    static func blend(_ top: UIColor, _ alpha: CGFloat, over base: UIColor) -> UIColor {
        var (r1, g1, b1, a1, r2, g2, b2, a2) = (CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0), CGFloat(0))
        top.getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        base.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
        return UIColor(red: r2 + (r1 - r2) * alpha, green: g2 + (g1 - g2) * alpha, blue: b2 + (b1 - b2) * alpha, alpha: a2)
    }
}
#endif
