#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The stories row above the Stem Cells sidebar, as Telegram's chat list
/// draws its expanded stories row: My Story first with its blue "+", then
/// each author in the daemon's order, a gradient ring on unseen stories, a
/// thin grey one on seen. Circles are reused by author, so a change redraws
/// only what changed and nothing jumps.
final class StoriesRowView: UIScrollView {
    var onOpen: ((StoriesRowItem) -> Void)?
    /// My Story's "+", or My Story itself with no story yet.
    var onAdd: (() -> Void)?
    var images: StemCellsImages?

    private(set) var items: [StoriesRowItem] = []
    private var circles: [String: StoriesCircleView] = [:]

    override init(frame: CGRect) {
        super.init(frame: frame)
        showsHorizontalScrollIndicator = false
        alwaysBounceHorizontal = true
        contentInsetAdjustmentBehavior = .never
        scrollsToTop = false
        delaysContentTouches = false
        clipsToBounds = false
        accessibilityIdentifier = "stories-row"
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// A drag that starts on a circle scrolls the row.
    override func touchesShouldCancel(in view: UIView) -> Bool { true }

    /// Shows `items`; returns how many circles it touched.
    @discardableResult
    func apply(_ items: [StoriesRowItem]) -> Int {
        dispatchPrecondition(condition: .onQueue(.main))
        guard items != self.items else { return 0 }
        let previous = Dictionary(self.items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let reordered = self.items.map(\.id) != items.map(\.id)
        self.items = items
        var touched = 0
        var live = Set<String>()
        for item in items {
            live.insert(item.id)
            if let circle = circles[item.id] {
                if previous[item.id] == item { continue }
                circle.configure(item, images: images)
            } else {
                let circle = StoriesCircleView()
                circle.addTarget(self, action: #selector(tapped(_:)), for: .touchUpInside)
                circle.onPlus = { [weak self] in self?.onAdd?() }
                circle.configure(item, images: images)
                circles[item.id] = circle
                addSubview(circle)
                if let index = items.firstIndex(where: { $0.id == item.id }) {
                    circle.frame = StoriesRowLayout(width: bounds.width, count: items.count).items[index]
                }
                if !previous.isEmpty {
                    // Arrives where it belongs, faded in rather than sliding.
                    circle.alpha = 0
                    UIView.animate(withDuration: 0.2) { circle.alpha = 1 }
                }
            }
            touched += 1
        }
        for (id, circle) in circles where !live.contains(id) {
            circles.removeValue(forKey: id)
            circle.leave()
            UIView.animate(withDuration: 0.2, animations: { circle.alpha = 0 }, completion: { _ in circle.removeFromSuperview() })
            touched += 1
        }
        if reordered {
            if previous.isEmpty || window == nil { setNeedsLayout() }
            else { UIView.animate(withDuration: 0.25, delay: 0, options: [.beginFromCurrentState, .curveEaseInOut]) { self.layoutIfNeeded(); self.place() } }
        }
        return touched
    }

    /// The circle's frame in this view, for the viewer to open from.
    func circleFrame(_ id: String) -> CGRect? {
        circles[id].map { $0.convert(StoriesRowLayout.item.avatar, to: self) }
    }

    func circle(_ id: String) -> StoriesCircleView? { circles[id] }

    override func layoutSubviews() {
        super.layoutSubviews()
        place()
    }

    private func place() {
        let layout = StoriesRowLayout(width: bounds.width, count: items.count)
        if contentSize != layout.contentSize { contentSize = layout.contentSize }
        for (item, frame) in zip(items, layout.items) {
            guard let circle = circles[item.id], circle.frame != frame else { continue }
            circle.frame = frame
        }
    }

    @objc private func tapped(_ circle: StoriesCircleView) {
        guard let item = circle.item else { return }
        if item.isSelf, item.segments == 0 || circle.takeEndedOnPlus() { onAdd?() } else { onOpen?(item) }
    }
}

/// One circle: the avatar, its ring, the name under it, and on My Story the "+".
final class StoriesCircleView: UIControl {
    private(set) var item: StoriesRowItem?
    var onPlus: (() -> Void)?
    private let avatar = UIImageView()
    private let initials = UILabel()
    private let avatarMask = CAShapeLayer()
    private let seenRing = CAShapeLayer()
    private let unseenRing = CAShapeLayer()
    private let unseenGradient = CAGradientLayer()
    private let plus = StoriesPlusView()
    private let title = UILabel()
    private var photoKey: String?
    private var loading: Task<Void, Never>?
    /// The touch ended on My Story's "+": the tap that follows is the "+"'s.
    private var endedOnPlus = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        let geometry = StoriesRowLayout.item
        avatar.frame = geometry.avatar
        avatar.contentMode = .scaleAspectFill
        avatar.clipsToBounds = true
        avatar.layer.cornerRadius = geometry.avatar.width / 2
        avatar.backgroundColor = UIColor(Palette.storiesAvatarFill)
        avatar.layer.mask = avatarMask
        avatar.isUserInteractionEnabled = false
        initials.font = .systemFont(ofSize: 20, weight: .semibold)
        initials.textColor = UIColor(Palette.storiesAvatarText)
        initials.textAlignment = .center
        initials.frame = avatar.bounds
        avatar.addSubview(initials)
        addSubview(avatar)
        for ring in [seenRing, unseenRing] {
            ring.fillColor = nil
            ring.lineCap = .round
            ring.frame = geometry.ring
        }
        seenRing.lineWidth = StoriesRowLayout.Metrics.ringSeenWidth
        unseenRing.lineWidth = StoriesRowLayout.Metrics.ringUnseenWidth
        unseenRing.strokeColor = UIColor.white.cgColor
        unseenGradient.frame = geometry.ring
        unseenGradient.startPoint = CGPoint(x: 0.5, y: 0)
        unseenGradient.endPoint = CGPoint(x: 0.5, y: 1)
        unseenRing.frame = unseenGradient.bounds
        unseenGradient.mask = unseenRing
        layer.addSublayer(seenRing)
        layer.addSublayer(unseenGradient)
        plus.frame = geometry.plus.insetBy(dx: -(StoriesRowLayout.Metrics.plusCutout - StoriesRowLayout.Metrics.plus) / 2, dy: -(StoriesRowLayout.Metrics.plusCutout - StoriesRowLayout.Metrics.plus) / 2)
        plus.isUserInteractionEnabled = false
        addSubview(plus)
        title.font = .systemFont(ofSize: StoriesRowLayout.Metrics.titleSize)
        title.textAlignment = .center
        title.lineBreakMode = .byTruncatingTail
        addSubview(title)
        isAccessibilityElement = true
        accessibilityTraits = .button
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyColors() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func applyColors() {
        let traits = traitCollection
        seenRing.strokeColor = UIColor(Palette.storiesSeen).resolvedColor(with: traits).cgColor
        unseenGradient.colors = [UIColor(Palette.storiesUnseenTop), UIColor(Palette.storiesUnseenBottom)].map { $0.resolvedColor(with: traits).cgColor }
        if let item { title.textColor = titleColor(item) }
    }

    private func titleColor(_ item: StoriesRowItem) -> UIColor {
        let color = UIColor(Palette.text)
        return item.isSelf || !item.allSeen ? color : color.withAlphaComponent(0.5)
    }

    func configure(_ item: StoriesRowItem, images: StemCellsImages?) {
        let previous = self.item
        self.item = item
        title.text = item.title
        title.textColor = titleColor(item)
        initials.text = item.initials
        accessibilityIdentifier = "story-circle:\(item.isSelf ? "self" : item.title)"
        accessibilityLabel = Strings.Stories.author(item.title, unseen: item.unseen)
        accessibilityCustomActions = item.isSelf ? [UIAccessibilityCustomAction(name: Strings.Stories.addStory) { [weak self] _ in self?.onPlus?(); return true }] : nil
        plus.isHidden = !item.showsPlus
        if previous?.segments != item.segments || previous?.unseen != item.unseen || previous?.showsPlus != item.showsPlus {
            drawRing(item)
        }
        loadPhoto(item, images: images)
        setNeedsLayout()
    }

    /// Seen segments first, unseen last, as Telegram orders them.
    private func drawRing(_ item: StoriesRowItem) {
        let geometry = StoriesRowLayout.item
        let center = CGPoint(x: geometry.ring.width / 2, y: geometry.ring.height / 2)
        let radius = StoriesRowLayout.Metrics.ringRadius - StoriesRowLayout.Metrics.ringUnseenWidth / 2
        let seen = CGMutablePath()
        let unseen = CGMutablePath()
        let segments = StoriesRowLayout.segments(count: item.segments, radius: radius)
        let firstUnseen = segments.count - min(item.unseen, segments.count)
        if item.segments > 0 {
            for (index, segment) in segments.enumerated() {
                let path = index >= firstUnseen ? unseen : seen
                path.move(to: CGPoint(x: center.x + cos(segment.start) * radius, y: center.y + sin(segment.start) * radius))
                path.addArc(center: center, radius: radius, startAngle: segment.start, endAngle: segment.end, clockwise: false)
            }
        }
        seenRing.path = seen
        unseenRing.path = unseen
        // Without a ring, the avatar is cut around the "+".
        let mask = CGMutablePath()
        mask.addEllipse(in: CGRect(origin: .zero, size: geometry.avatar.size))
        if item.showsPlus {
            let cutout = geometry.cutout.offsetBy(dx: -geometry.avatar.minX, dy: -geometry.avatar.minY)
            mask.addEllipse(in: cutout)
            avatarMask.fillRule = .evenOdd
        }
        avatarMask.path = mask
        plus.cutsRing = item.segments > 0
    }

    private func loadPhoto(_ item: StoriesRowItem, images: StemCellsImages?) {
        // Without a way to read it, the photo waits for the next configure.
        let key = images == nil ? nil : item.photo.map { "\($0)#\(item.thumbhash ?? "")" }
        guard key != photoKey else { return }
        photoKey = key
        loading?.cancel()
        guard let path = item.photo, let images else {
            initials.isHidden = false
            avatar.image = nil
            return
        }
        initials.isHidden = true
        let pixels = Int(StoriesRowLayout.Metrics.avatar * (window?.screen.scale ?? 3))
        if let cached = images.cachedPicture(path, thumbhash: item.thumbhash, pixels: pixels) {
            avatar.image = cached
            return
        }
        avatar.image = StemCellsImages.placeholder(item.thumbhash)
        loading = Task { [weak self] in
            let image = await images.picture(path, thumbhash: item.thumbhash, pixels: pixels)
            guard let self, !Task.isCancelled, photoKey == key else { return }
            if let image { avatar.image = image } else if avatar.image == nil { initials.isHidden = false }
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let size = title.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        title.frame = StoriesRowLayout.item.title(width: size.width, height: size.height)
    }

    override var isHighlighted: Bool {
        didSet {
            guard isHighlighted != oldValue else { return }
            let scale: CGFloat = isHighlighted ? 0.92 : 1
            UIView.animate(withDuration: isHighlighted ? 0.12 : 0.2, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
                for view in [self.avatar, self.plus] { view.transform = CGAffineTransform(scaleX: scale, y: scale) }
            }
            for ring in [seenRing, unseenGradient] { ring.setAffineTransform(CGAffineTransform(scaleX: scale, y: scale)) }
        }
    }

    /// My Story's "+" is its own target once there is a story to open:
    /// the cutout and a little around it.
    override func endTracking(_ touch: UITouch?, with event: UIEvent?) {
        endedOnPlus = false
        if let item, item.isSelf, item.segments > 0, let point = touch?.location(in: self) {
            endedOnPlus = StoriesRowLayout.item.cutout.insetBy(dx: -6, dy: -6).contains(point)
        }
        super.endTracking(touch, with: event)
    }

    /// Whether the tap now being sent was on the "+"; asked once.
    func takeEndedOnPlus() -> Bool {
        defer { endedOnPlus = false }
        return endedOnPlus
    }

    /// Leaves the row: no more loading, and no taps while it fades.
    func leave() {
        loading?.cancel()
        isUserInteractionEnabled = false
    }
}

/// The blue "+": a 16 pt disc with a white cross, ringed by the row's ground
/// so it reads cut out of the avatar and the ring.
final class StoriesPlusView: UIView {
    var cutsRing = false { didSet { setNeedsDisplay() } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        contentMode = .redraw
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.setNeedsDisplay() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        let traits = traitCollection
        let disc = StoriesRowLayout.Metrics.plus
        let inner = CGRect(x: (bounds.width - disc) / 2, y: (bounds.height - disc) / 2, width: disc, height: disc)
        if cutsRing {
            context.setFillColor(UIColor(Palette.groupedBackground).resolvedColor(with: traits).cgColor)
            context.fillEllipse(in: bounds)
        }
        context.setFillColor(UIColor(Palette.storiesPlus).resolvedColor(with: traits).cgColor)
        context.fillEllipse(in: inner)
        let scale = window?.screen.scale ?? 3
        context.setStrokeColor(UIColor(Palette.storiesPlusGlyph).resolvedColor(with: traits).cgColor)
        context.setLineWidth(3 / scale)
        context.setLineCap(.round)
        let line = 9 + 1 / scale
        context.move(to: CGPoint(x: inner.midX, y: inner.midY - line / 2)); context.addLine(to: CGPoint(x: inner.midX, y: inner.midY + line / 2))
        context.move(to: CGPoint(x: inner.midX - line / 2, y: inner.midY)); context.addLine(to: CGPoint(x: inner.midX + line / 2, y: inner.midY))
        context.strokePath()
    }
}
#endif
