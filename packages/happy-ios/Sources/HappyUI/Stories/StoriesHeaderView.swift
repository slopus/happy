#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Home's stories, in the header (Telegram's `StoryPeerListComponent`): the
/// circles open in a row under the header, scrolling sideways, or closed
/// into the title as up to three small overlapping avatars, tapped to open
/// them again. `StoriesHeaderLayout` places everything; this view only
/// draws where it says. Circles are reused by author, so a change redraws
/// only what changed and nothing jumps.
final class StoriesHeaderView: UIView, UIScrollViewDelegate {
    var onOpen: ((StoriesRowItem) -> Void)?
    /// The closed avatars were tapped.
    var onExpand: (() -> Void)?
    /// The open row scrolled sideways.
    var onScroll: (() -> Void)?
    /// The view was laid out at a new size.
    var onLayout: (() -> Void)?
    /// Each frame while `ticking`, for the change between open and closed.
    var onTick: (() -> Void)?
    var images: Images?
    var ticking = false {
        didSet {
            guard ticking != oldValue else { return }
            link?.invalidate()
            link = nil
            guard ticking else { return }
            let link = CADisplayLink(target: StoriesHeaderTicker(self), selector: #selector(StoriesHeaderTicker.tick(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
        }
    }
    private var link: CADisplayLink?

    /// What scrolls sideways; the circles are in it.
    let pager = Pager()
    private let collapsed = UIButton(type: .custom)
    private(set) var items: [StoriesRowItem] = []
    private var circles: [String: StoriesCircleView] = [:]
    private var unlocked = false
    private var laidOutSize: CGSize = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = false
        pager.showsHorizontalScrollIndicator = false
        pager.showsVerticalScrollIndicator = false
        pager.alwaysBounceHorizontal = true
        pager.contentInsetAdjustmentBehavior = .never
        pager.scrollsToTop = false
        pager.delaysContentTouches = false
        pager.clipsToBounds = false
        pager.delegate = self
        pager.accessibilityIdentifier = "stories-row"
        addSubview(pager)
        collapsed.accessibilityIdentifier = "stories-collapsed"
        collapsed.accessibilityTraits = .button
        collapsed.addAction(UIAction { [weak self] _ in self?.onExpand?() }, for: .touchUpInside)
        collapsed.isHidden = true
        addSubview(collapsed)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// A drag that starts on a circle scrolls the row.
    final class Pager: UIScrollView {
        override func touchesShouldCancel(in view: UIView) -> Bool { true }
    }

    /// Shows `items`; returns how many circles it touched.
    @discardableResult
    func apply(_ items: [StoriesRowItem]) -> Int {
        dispatchPrecondition(condition: .onQueue(.main))
        guard items != self.items else { return 0 }
        let previous = Dictionary(self.items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
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
                circle.configure(item, images: images)
                circles[item.id] = circle
                pager.addSubview(circle)
                if !previous.isEmpty {
                    // Arrives where it belongs, faded in rather than sliding.
                    circle.contentAlpha = 0
                    UIView.animate(withDuration: 0.2) { circle.contentAlpha = 1 }
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
        accessibilityElements = [collapsed, pager]
        return touched
    }

    func circle(_ id: String) -> StoriesCircleView? { circles[id] }

    /// Draws `layout`; `unlocked` says whether the row is open, so takes
    /// touches, or closed into the title, where only the avatars' target does.
    func place(_ layout: StoriesHeaderLayout, unlocked: Bool, side: CGFloat) {
        self.unlocked = unlocked
        if pager.frame != layout.row { pager.frame = layout.row }
        let content = CGSize(width: layout.contentWidth, height: layout.row.height)
        if pager.contentSize != content { pager.contentSize = content }
        pager.isScrollEnabled = unlocked
        pager.accessibilityElementsHidden = !unlocked
        let shift = CGPoint(x: pager.contentOffset.x - layout.row.minX, y: pager.contentOffset.y - layout.row.minY)
        for (item, geometry) in zip(items, layout.items) {
            guard let circle = circles[item.id] else { continue }
            circle.isUserInteractionEnabled = unlocked
            circle.place(
                center: CGPoint(x: geometry.center.x + shift.x, y: geometry.center.y + shift.y),
                scale: geometry.scale, alpha: geometry.alpha, zPosition: geometry.zPosition,
                names: side, single: geometry.collapses && side < 0.5, neighbor: geometry.neighbor
            )
        }
        collapsed.frame = layout.button ?? .zero
        collapsed.isHidden = layout.button == nil || unlocked
        let names = zip(items, layout.items).filter { $0.1.collapses }.map(\.0.title)
        let label = Strings.Stories.collapsed(names)
        if collapsed.accessibilityLabel != label { collapsed.accessibilityLabel = label }
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard !isHidden, !items.isEmpty else { return false }
        if unlocked { return pager.frame.contains(point) }
        return !collapsed.isHidden && collapsed.frame.contains(point)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.size != laidOutSize else { return }
        laidOutSize = bounds.size
        onLayout?()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) { onScroll?() }

    fileprivate func tick() { onTick?() }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { ticking = false }
    }

    @objc private func tapped(_ circle: StoriesCircleView) {
        guard unlocked, let item = circle.item else { return }
        onOpen?(item)
    }
}

/// The display link's target, holding the view weakly: a link the view
/// never stopped stops itself once the view is gone.
@MainActor
private final class StoriesHeaderTicker: NSObject {
    private weak var view: StoriesHeaderView?

    init(_ view: StoriesHeaderView) {
        self.view = view
    }

    @objc func tick(_ link: CADisplayLink) {
        guard let view else { return link.invalidate() }
        view.tick()
    }
}

/// One circle: the avatar, its ring and the name under it. It turns about
/// the avatar's middle, so it is placed by that point and scaled whole; the
/// ring keeps about its width at any size, and the name fades with the row.
final class StoriesCircleView: UIControl {
    private(set) var item: StoriesRowItem?
    /// Holds what is cut around the circle before it.
    private let content = UIView()
    private let avatar = UIImageView()
    private let initials = UILabel()
    private let seenRing = CAShapeLayer()
    private let unseenRing = CAShapeLayer()
    private let unseenGradient = CAGradientLayer()
    /// The gradient's mask: the unseen ring, or the dashes going round while
    /// the story it opens on loads.
    private let ringMask = CALayer()
    private let dashes = CAReplicatorLayer()
    private let dash = CAShapeLayer()
    private let cut = CAShapeLayer()
    private let title = UILabel()
    private var photoKey: String?
    private var loading: Task<Void, Never>?
    private var single = false
    private var drawnScale: CGFloat = 1
    private var drawnNeighbor: CGPoint?

    /// The circle's own fade, apart from where the layout puts it.
    var contentAlpha: CGFloat {
        get { content.alpha }
        set { content.alpha = newValue; title.alpha = min(title.alpha, newValue) }
    }

    override init(frame: CGRect) {
        super.init(frame: CGRect(origin: .zero, size: StoriesRowLayout.Metrics.item))
        let geometry = StoriesRowLayout.item
        layer.anchorPoint = CGPoint(x: 0.5, y: geometry.avatar.midY / StoriesRowLayout.Metrics.item.height)
        content.frame = bounds
        content.isUserInteractionEnabled = false
        addSubview(content)
        avatar.frame = geometry.avatar
        avatar.contentMode = .scaleAspectFill
        avatar.clipsToBounds = true
        avatar.layer.cornerRadius = geometry.avatar.width / 2
        avatar.backgroundColor = UIColor(Palette.storiesAvatarFill)
        avatar.isUserInteractionEnabled = false
        initials.font = .systemFont(ofSize: 20, weight: .semibold)
        initials.textColor = UIColor(Palette.storiesAvatarText)
        initials.textAlignment = .center
        initials.frame = avatar.bounds
        avatar.addSubview(initials)
        content.addSubview(avatar)
        for ring in [seenRing, unseenRing] {
            ring.fillColor = nil
            ring.lineCap = .round
            ring.frame = geometry.ring
        }
        unseenRing.strokeColor = UIColor.white.cgColor
        unseenGradient.frame = geometry.ring
        unseenGradient.startPoint = CGPoint(x: 0.5, y: 0)
        unseenGradient.endPoint = CGPoint(x: 0.5, y: 1)
        unseenRing.frame = unseenGradient.bounds
        ringMask.frame = unseenGradient.bounds
        ringMask.addSublayer(unseenRing)
        unseenGradient.mask = ringMask
        // Telegram's story loading ring: thirty short dashes round the
        // avatar, chasing each other, the whole turning once in four seconds.
        dash.fillColor = nil
        dash.strokeColor = UIColor.white.cgColor
        dash.lineCap = .round
        dash.strokeEnd = 1.0 / 30
        dash.frame = unseenGradient.bounds
        dash.path = CGPath(ellipseIn: unseenGradient.bounds.insetBy(dx: StoriesRowLayout.Metrics.ringUnseenWidth / 2 + (geometry.ring.width / 2 - StoriesRowLayout.Metrics.ringRadius), dy: StoriesRowLayout.Metrics.ringUnseenWidth / 2 + (geometry.ring.width / 2 - StoriesRowLayout.Metrics.ringRadius)), transform: nil)
        dashes.frame = unseenGradient.bounds
        dashes.instanceCount = 30
        dashes.instanceTransform = CATransform3DMakeRotation(2 * .pi / 30, 0, 0, 1)
        dashes.instanceDelay = 0.025
        dashes.opacity = 0
        dashes.addSublayer(dash)
        content.layer.addSublayer(seenRing)
        content.layer.addSublayer(unseenGradient)
        cut.fillRule = .evenOdd
        title.font = .systemFont(ofSize: StoriesRowLayout.Metrics.titleSize)
        title.textAlignment = .center
        title.lineBreakMode = .byTruncatingTail
        title.isUserInteractionEnabled = false
        addSubview(title)
        isAccessibilityElement = true
        accessibilityTraits = .button
        applyRingWidths()
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

    func configure(_ item: StoriesRowItem, images: Images?) {
        let previous = self.item
        self.item = item
        title.text = item.title
        initials.text = item.initials
        accessibilityIdentifier = "story-circle:\(item.isSelf ? "self" : item.title)"
        accessibilityLabel = Strings.Stories.author(item.title, unseen: item.unseen)
        if previous?.segments != item.segments || previous?.unseen != item.unseen {
            // Seen since it last showed: the colour gives way to grey.
            if let previous, previous.unseen > item.unseen, window != nil {
                let fade = CATransition()
                fade.type = .fade
                fade.duration = 0.35
                fade.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                for ring in [seenRing, unseenRing, unseenGradient] { ring.add(fade, forKey: "seen") }
                UIView.transition(with: title, duration: 0.35, options: [.transitionCrossDissolve, .allowUserInteraction]) {
                    self.title.textColor = self.titleColor(item)
                }
            }
            drawRing()
        }
        title.textColor = titleColor(item)
        loadPhoto(item, images: images)
        setNeedsLayout()
    }

    /// Where the layout puts it: its avatar's middle in its superview, how
    /// big, how present; `names` is the row's names' presence, `single`
    /// draws the ring whole as the closed avatars show it, and `neighbor`
    /// is where the circle over this one stands, to be cut around.
    func place(center: CGPoint, scale: CGFloat, alpha: CGFloat, zPosition: CGFloat, names: CGFloat, single: Bool, neighbor: CGPoint?) {
        if self.center != center { self.center = center }
        let transform = CGAffineTransform(scaleX: scale, y: scale)
        if self.transform != transform { self.transform = transform }
        if self.alpha != alpha { self.alpha = alpha }
        if layer.zPosition != zPosition { layer.zPosition = zPosition }
        title.alpha = min(names, content.alpha)
        if self.single != single {
            self.single = single
            drawRing()
        }
        let rescaled = drawnScale != scale
        drawnScale = scale
        if rescaled { applyRingWidths() }
        if rescaled || drawnNeighbor != neighbor {
            drawnNeighbor = neighbor
            applyCut(neighbor, scale: scale)
        }
    }

    private func applyRingWidths() {
        seenRing.lineWidth = StoriesHeaderLayout.ringWidth(StoriesRowLayout.Metrics.ringSeenWidth, scale: drawnScale)
        unseenRing.lineWidth = StoriesHeaderLayout.ringWidth(StoriesRowLayout.Metrics.ringUnseenWidth, scale: drawnScale)
        dash.lineWidth = unseenRing.lineWidth
    }

    /// The story it opens on is loading: the ring gives way to the dashes,
    /// as Telegram's does, and comes back once it's done.
    var isLoadingStory = false {
        didSet {
            guard isLoadingStory != oldValue else { return }
            accessibilityValue = isLoadingStory ? "loading" : nil
            CATransaction.begin()
            CATransaction.setAnimationDuration(0.2)
            if isLoadingStory {
                if dashes.superlayer == nil {
                    CATransaction.begin()
                    CATransaction.setDisableActions(true)
                    dashes.opacity = 0
                    ringMask.addSublayer(dashes)
                    CATransaction.commit()
                }
                let turn = CABasicAnimation(keyPath: "transform.rotation.z")
                turn.fromValue = -Double.pi / 2
                turn.toValue = -Double.pi / 2 + 2 * Double.pi
                turn.duration = 4
                turn.repeatCount = .infinity
                dashes.add(turn, forKey: "turn")
                let chase = CAKeyframeAnimation(keyPath: "strokeStart")
                chase.values = [0, 1.0 / 30, 1.0 / 30, 0]
                chase.keyTimes = [0, 0.45, 0.55, 1]
                chase.duration = 2.5
                chase.repeatCount = .infinity
                dash.add(chase, forKey: "chase")
                dashes.opacity = 1
                unseenRing.opacity = 0
                seenRing.opacity = 0
            } else {
                dashes.opacity = 0
                unseenRing.opacity = 1
                seenRing.opacity = 1
                CATransaction.setCompletionBlock { [weak self] in
                    guard let self, !self.isLoadingStory else { return }
                    self.dashes.removeAllAnimations()
                    self.dash.removeAllAnimations()
                    self.dashes.removeFromSuperlayer()
                }
            }
            CATransaction.commit()
        }
    }

    /// Cuts this circle around the one before it, which overlaps it: a
    /// circle about that one's avatar, its ring's width and a half out.
    private func applyCut(_ neighbor: CGPoint?, scale: CGFloat) {
        guard let neighbor, scale > 0 else {
            content.layer.mask = nil
            return
        }
        let geometry = StoriesRowLayout.item
        let middle = CGPoint(x: geometry.avatar.midX + neighbor.x / scale, y: geometry.avatar.midY + neighbor.y / scale)
        let radius = geometry.avatar.width / 2 + StoriesHeaderLayout.ringWidth(StoriesRowLayout.Metrics.ringSeenWidth, scale: scale) * 1.4
        let path = CGMutablePath()
        path.addRect(content.bounds.insetBy(dx: -40, dy: -40))
        path.addEllipse(in: CGRect(x: middle.x - radius, y: middle.y - radius, width: 2 * radius, height: 2 * radius))
        cut.frame = content.bounds
        cut.path = path
        content.layer.mask = cut
    }

    /// Seen segments first, unseen last, as Telegram orders them; closed
    /// into the title, one whole ring, coloured if anything is unseen.
    private func drawRing() {
        guard let item else { return }
        let geometry = StoriesRowLayout.item
        let center = CGPoint(x: geometry.ring.width / 2, y: geometry.ring.height / 2)
        let radius = StoriesRowLayout.Metrics.ringRadius - StoriesRowLayout.Metrics.ringUnseenWidth / 2
        let seen = CGMutablePath()
        let unseen = CGMutablePath()
        let count = single ? 1 : item.segments
        let segments = StoriesRowLayout.segments(count: count, radius: radius)
        let firstUnseen = single ? (item.unseen > 0 ? 0 : 1) : segments.count - min(item.unseen, segments.count)
        if item.segments > 0 {
            for (index, segment) in segments.enumerated() {
                let path = index >= firstUnseen ? unseen : seen
                path.move(to: CGPoint(x: center.x + cos(segment.start) * radius, y: center.y + sin(segment.start) * radius))
                path.addArc(center: center, radius: radius, startAngle: segment.start, endAngle: segment.end, clockwise: false)
            }
        }
        seenRing.path = seen
        unseenRing.path = unseen
    }

    private func loadPhoto(_ item: StoriesRowItem, images: Images?) {
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
        avatar.image = Images.placeholder(item.thumbhash)
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
                self.avatar.transform = CGAffineTransform(scaleX: scale, y: scale)
            }
            for ring in [seenRing, unseenGradient] { ring.setAffineTransform(CGAffineTransform(scaleX: scale, y: scale)) }
        }
    }

    /// Leaves the row: no more loading, and no taps while it fades.
    func leave() {
        loading?.cancel()
        isLoadingStory = false
        isUserInteractionEnabled = false
    }
}
#endif
