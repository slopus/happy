#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Who else looks at a conversation or Surface, in its header
/// (`ViewersBarItem`): one fixed-width slot, so the header is laid out the
/// same for nobody and for fifty. Up to four faces, then "+N". Someone
/// here wears a breathing ring in their colour and a green dot, and pops
/// in when they arrive; someone gone within ten minutes is in full
/// colour, the one who left last saying how long ago ("4m": two badges
/// side by side would run into each other); someone seen before is
/// smaller, grey and tucked behind. A tap lists everyone, those editing
/// (a document's `editors`) first.
///
/// Every motion is Core Animation on prepared layers (transform,
/// position, opacity), so the render server runs it however busy the
/// main thread is. Faces are placed only when the list or a tier
/// changes, never per frame.
@MainActor
final class ViewersSlotView: UIButton {
    private let session: Session
    private let target: ViewerTarget
    private let ground: UIColor
    private var watching: Task<Void, Never>?
    private var ticking: Task<Void, Never>?
    private var viewers: [Viewer] = []
    private var live = false
    private var faces: [String: ViewerFaceView] = [:]
    private let more = UILabel()
    /// The names a document's awareness has editing it now: marked in the
    /// list and in what VoiceOver says. Awareness names people, not IDs,
    /// so a viewer is matched by name; an editor nobody matches (an agent,
    /// another name) still has a row.
    var editors: [String] = [] {
        didSet { if editors != oldValue { describe() } }
    }

    init(session: Session, target: ViewerTarget, ground: UIColor) {
        self.session = session
        self.target = target
        self.ground = ground
        super.init(frame: CGRect(x: 0, y: 0, width: ViewersSlotLayout.Metrics.width, height: ViewersSlotLayout.Metrics.height))
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: ViewersSlotLayout.Metrics.width),
            heightAnchor.constraint(equalToConstant: ViewersSlotLayout.Metrics.height),
        ])
        accessibilityIdentifier = "viewers"
        more.font = .systemFont(ofSize: 10, weight: .semibold)
        more.textAlignment = .center
        more.textColor = UIColor(Palette.textSecondary)
        more.backgroundColor = UIColor(Palette.divider)
        more.layer.cornerRadius = ViewersSlotLayout.Metrics.face / 2
        more.layer.masksToBounds = true
        more.layer.borderWidth = ViewersSlotLayout.Metrics.ringGap
        more.alpha = 0
        more.isUserInteractionEnabled = false
        addSubview(more)
        showsMenuAsPrimaryAction = true
        menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] done in done(self?.menuItems() ?? []) }])
        session.viewerPeople.watch(self) { [weak self] in self?.peopleChanged() }
        NotificationCenter.default.addObserver(self, selector: #selector(foregrounded), name: UIApplication.willEnterForegroundNotification, object: nil)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            for face in self.faces.values { face.groundChanged() }
            self.more.layer.borderColor = self.ground.resolvedColor(with: self.traitCollection).cgColor
        }
        more.layer.borderColor = ground.resolvedColor(with: traitCollection).cgColor
        render(animated: false)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var intrinsicContentSize: CGSize { CGSize(width: ViewersSlotLayout.Metrics.width, height: ViewersSlotLayout.Metrics.height) }

    /// On screen is looking: the slot watches while it is in a window, so
    /// a screen pushed over this one, or this one popped, stops it.
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil {
            guard watching == nil else { return }
            let store = session.engine.viewers
            let target = target
            watching = Task { [weak self] in
                for await state in await store.view(target) {
                    self?.apply(state)
                }
            }
            for face in faces.values { face.resume() }
        } else {
            watching?.cancel(); watching = nil
            ticking?.cancel(); ticking = nil
        }
    }

    /// Back from away: no tier moved while the app slept, so they are
    /// worked out again now, not at the tick that was due.
    @objc private func foregrounded() {
        guard window != nil else { return }
        render(animated: false)
        for face in faces.values { face.resume() }
    }

    private func apply(_ state: ViewersState) {
        // Unavailable, the item hides (`ViewersBarItem`); empty meanwhile.
        let (list, isLive) = switch state {
        case .unavailable: ([Viewer](), false)
        case .viewers(let list, let live): (list, live)
        }
        // Only news on a live stream arrives; what the first answer says
        // was already so.
        let arrivals = live && isLive
        viewers = list
        live = isLive
        session.viewerPeople.want(list.prefix(ViewersSlotLayout.Metrics.most).map(\.userId))
        render(animated: arrivals)
    }

    private func peopleChanged() {
        for (id, face) in faces { face.person(session.viewerPeople.user(id), images: session.images) }
        describe()
    }

    // MARK: Drawing

    private func render(animated: Bool) {
        let now = Date().timeIntervalSince1970 * 1000
        let shown = Array(viewers.prefix(ViewersSlotLayout.Metrics.most))
        let tiers = shown.map { ViewerTiers.tier($0, now: now) }
        let layout = ViewersSlotLayout(large: tiers.map { $0 != .seen }, total: viewers.count)
        let ids = Set(shown.map(\.userId))
        let badged = tiers.firstIndex { if case .recent = $0 { true } else { false } }
        for (id, face) in faces where !ids.contains(id) {
            faces[id] = nil
            face.leave(animated: animated)
        }
        for (index, (viewer, tier)) in zip(shown, tiers).enumerated() {
            let disc = layout.faces[index]
            let center = CGPoint(x: disc.midX, y: disc.midY)
            if let face = faces[viewer.userId] {
                face.move(to: center, animated: animated)
                face.show(tier, badged: index == badged, animated: animated)
            } else {
                let face = ViewerFaceView(userId: viewer.userId, ground: ground)
                faces[viewer.userId] = face
                addSubview(face)
                face.center = center
                face.person(session.viewerPeople.user(viewer.userId), images: session.images)
                face.show(tier, badged: index == badged, animated: false)
                face.arrive(popping: animated && tier == .here)
            }
        }
        // The first on top: here before recent before seen.
        for viewer in shown.reversed() { if let face = faces[viewer.userId] { bringSubviewToFront(face) } }
        if let chip = layout.more {
            more.text = "+\(viewers.count - shown.count)"
            more.frame = chip
            // Over the last face, so "+" reads whole.
            bringSubviewToFront(more)
        }
        let showsMore = layout.more != nil
        if (more.alpha == 1) != showsMore {
            UIView.animate(withDuration: animated ? 0.25 : 0) { self.more.alpha = showsMore ? 1 : 0 }
        }
        describe()
        scheduleTick(now: now)
    }

    /// What VoiceOver says, and whether there is a list to open.
    private func describe() {
        let some = !viewers.isEmpty || !editors.isEmpty
        isUserInteractionEnabled = some
        isAccessibilityElement = some
        let here = viewers.filter(\.here).count
        let summary = Strings.Viewers.summary(here: here, others: viewers.count - here)
        accessibilityLabel = [viewers.isEmpty && !editors.isEmpty ? "" : summary, Strings.Viewers.editing(editors)].filter { !$0.isEmpty }.joined(separator: ". ")
        accessibilityTraits = .button
    }

    private func name(_ userId: String) -> String {
        session.viewerPeople.user(userId).map { $0.name.isEmpty ? Strings.Viewers.someone : $0.name } ?? Strings.Viewers.someone
    }

    /// Recent decays to seen, and "4m" to "5m", with no news from the
    /// server: drawn again at the next such moment, not before.
    private func scheduleTick(now: Double) {
        ticking?.cancel(); ticking = nil
        guard window != nil, let next = ViewerTiers.nextChange(viewers, now: now) else { return }
        ticking = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(Int(max(0, next - now)) + 20))
            guard !Task.isCancelled, let self else { return }
            render(animated: true)
        }
    }

    // MARK: The list

    private func menuItems() -> [UIMenuElement] {
        let now = Date().timeIntervalSince1970 * 1000
        session.viewerPeople.want(viewers.map(\.userId))
        func row(_ viewer: Viewer, editing: Bool) -> UIAction {
            let user = session.viewerPeople.user(viewer.userId)
            let name = name(viewer.userId)
            let face = faces[viewer.userId]?.menuImage ?? ViewerFaceView.placeholderImage(viewer.userId, thumbhash: user?.photo?.thumbhash)
            let when = editing ? Strings.Viewers.editingNow : Strings.Viewers.when(ViewerTiers.when(viewer, now: now))
            return UIAction(title: Strings.Viewers.row(name, when), image: face) { [weak self] _ in
                self?.openProfile(user ?? TeamUser(id: viewer.userId, name: name))
            }
        }
        var unmatched = editors
        var editing: [UIMenuElement] = []
        var rest: [Viewer] = []
        for viewer in viewers {
            if let index = unmatched.firstIndex(of: name(viewer.userId)) {
                unmatched.remove(at: index)
                editing.append(row(viewer, editing: true))
            } else {
                rest.append(viewer)
            }
        }
        editing += unmatched.map { UIAction(title: Strings.Viewers.row($0, Strings.Viewers.editingNow), attributes: .disabled) { _ in } }
        let groups: [[UIMenuElement]] = [
            editing,
            rest.filter { ViewerTiers.tier($0, now: now) == .here }.map { row($0, editing: false) },
            rest.filter { if case .recent = ViewerTiers.tier($0, now: now) { true } else { false } }.map { row($0, editing: false) },
            rest.filter { ViewerTiers.tier($0, now: now) == .seen }.map { row($0, editing: false) },
        ]
        return groups.filter { !$0.isEmpty }.map { UIMenu(options: .displayInline, children: $0) }
    }

    private func openProfile(_ user: TeamUser) {
        guard UserProfileViewController.offered(session) else { return }
        var responder: UIResponder? = self
        while let next = responder, !(next is UINavigationController) { responder = next.next }
        (responder as? UINavigationController)?.pushViewController(UserProfileViewController(session: session, user: user), animated: true)
    }
}

/// One person's face in the slot: their picture, and what their tier
/// wears over it. Always a face's full size; seen is a smaller transform.
@MainActor
final class ViewerFaceView: UIView {
    private typealias M = ViewersSlotLayout.Metrics
    let userId: String
    private let ground: UIColor
    private let color: UIColor
    private let photo = UIImageView()
    private let halo = CALayer()
    private let ring = CAShapeLayer()
    private let dot = UIView()
    private let badge = UILabel()
    private var tier: ViewerTier?
    private var picture: UIImage?
    private var grey: UIImage?
    private var loading: Task<Void, Never>?
    private var loaded: String?

    init(userId: String, ground: UIColor) {
        self.userId = userId
        self.ground = ground
        color = ViewerFaceView.ringColor(userId)
        super.init(frame: CGRect(x: 0, y: 0, width: M.face, height: M.face))
        isUserInteractionEnabled = false
        let ringFrame = ViewersSlotLayout.ring(bounds)
        ring.frame = ringFrame
        ring.path = UIBezierPath(ovalIn: CGRect(origin: .zero, size: ringFrame.size)).cgPath
        ring.fillColor = nil
        ring.lineWidth = M.ringWidth
        ring.opacity = 0
        layer.addSublayer(ring)
        halo.frame = ViewersSlotLayout.halo(bounds)
        halo.cornerRadius = halo.frame.width / 2
        layer.addSublayer(halo)
        photo.frame = bounds
        photo.contentMode = .scaleAspectFill
        photo.layer.cornerRadius = M.face / 2
        photo.layer.masksToBounds = true
        photo.backgroundColor = UIColor(Palette.divider)
        addSubview(photo)
        dot.frame = ViewersSlotLayout.dot(bounds)
        dot.backgroundColor = .systemGreen
        dot.layer.cornerRadius = M.dot / 2
        dot.layer.borderWidth = 1.5
        dot.alpha = 0
        addSubview(dot)
        badge.font = .systemFont(ofSize: 8, weight: .bold)
        badge.textColor = .white
        badge.textAlignment = .center
        badge.backgroundColor = UIColor(Palette.textSecondary)
        badge.layer.cornerRadius = M.badgeHeight / 2
        badge.layer.masksToBounds = true
        badge.layer.borderWidth = 1
        badge.alpha = 0
        addSubview(badge)
        groundChanged()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func groundChanged() {
        let traits = traitCollection
        ring.strokeColor = color.resolvedColor(with: traits).cgColor
        halo.backgroundColor = ground.resolvedColor(with: traits).cgColor
        dot.layer.borderColor = ground.resolvedColor(with: traits).cgColor
        badge.layer.borderColor = ground.resolvedColor(with: traits).cgColor
    }

    // MARK: Who

    func person(_ user: TeamUser?, images: Images) {
        let key = user.map { "\($0.id)#\($0.photo?.thumbhash ?? "")" } ?? userId
        guard loaded != key else { return }
        loaded = key
        loading?.cancel()
        let scale = window?.screen.scale ?? 3
        if let thumbhash = user?.photo?.thumbhash {
            setPicture(ThumbHashImages.image(thumbhash))
            let path = TeamUser.photoPath(userId)
            loading = Task { [weak self] in
                guard let image = await images.picture(path, thumbhash: thumbhash, pixels: Int(M.face * scale)), !Task.isCancelled else { return }
                self?.setPicture(image)
            }
        } else {
            setPicture(AvatarPlaceholderImages.cached(seed: userId, side: M.face))
            let seed = userId
            loading = Task { [weak self] in
                guard let image = await AvatarPlaceholderImages.image(seed: seed, side: M.face), !Task.isCancelled else { return }
                self?.setPicture(image)
            }
        }
    }

    private func setPicture(_ image: UIImage?) {
        guard let image else { return }
        picture = image
        grey = nil
        photo.image = tier == .seen ? greyPicture() : image
    }

    private func greyPicture() -> UIImage? {
        if let grey { return grey }
        guard let picture else { return nil }
        let made = UIGraphicsImageRenderer(size: picture.size, format: Self.format(picture.scale)).image { context in
            picture.draw(at: .zero)
            UIColor.gray.setFill()
            context.fill(CGRect(origin: .zero, size: picture.size), blendMode: .saturation)
        }
        grey = made
        return made
    }

    private static func format(_ scale: CGFloat) -> UIGraphicsImageRendererFormat {
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        return format
    }

    /// The face as the list shows it: round, in colour.
    var menuImage: UIImage? {
        guard let picture else { return nil }
        return Self.round(picture)
    }

    static func placeholderImage(_ userId: String, thumbhash: String?) -> UIImage? {
        guard let image = ThumbHashImages.image(thumbhash) ?? AvatarPlaceholderImages.cached(seed: userId, side: M.face) else { return nil }
        return round(image)
    }

    private static func round(_ image: UIImage) -> UIImage {
        let side: CGFloat = 28
        let rect = CGRect(x: 0, y: 0, width: side, height: side)
        return UIGraphicsImageRenderer(size: rect.size).image { _ in
            UIBezierPath(ovalIn: rect).addClip()
            image.draw(in: rect)
        }.withRenderingMode(.alwaysOriginal)
    }

    /// Their colour, the hue their cursor has in a document
    /// (`DocumentPeersView.color`), deep enough to read as a ring.
    static func ringColor(_ userId: String) -> UIColor {
        let deep = ["#958DF1": "#6E62E8", "#F98181": "#EF4444", "#FBBC88": "#F97316", "#FAF594": "#EAB308",
                    "#70CFF8": "#0EA5E9", "#94FADB": "#14B8A6", "#B9F18D": "#65A30D"]
        let cursor = DocumentPeersView.color(for: userId)
        return DocumentPeersView.uiColor(deep[cursor] ?? cursor)
    }

    // MARK: Tiers

    func show(_ next: ViewerTier, badged: Bool, animated: Bool) {
        let previous = tier
        tier = next
        let isHere = next == .here
        let isSeen = next == .seen
        var minutes: Int?
        if badged, case .recent(let m) = next { minutes = m }
        if let minutes {
            badge.text = Strings.Viewers.badge(minutes)
            let width = ceil(badge.intrinsicContentSize.width)
            badge.frame = ViewersSlotLayout.badge(bounds, width: width)
        }
        let seenScale = M.seenFace / M.face
        let changes = {
            self.dot.alpha = isHere ? 1 : 0
            self.badge.alpha = minutes == nil ? 0 : 1
            self.transform = isSeen ? CGAffineTransform(scaleX: seenScale, y: seenScale) : .identity
            self.photo.alpha = isSeen ? 0.75 : 1
        }
        if animated, previous != nil {
            UIView.animate(withDuration: 0.45, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: changes)
        } else {
            changes()
        }
        if (previous == .seen) != isSeen, let image = isSeen ? greyPicture() : picture {
            if animated { UIView.transition(with: photo, duration: 0.3, options: .transitionCrossDissolve) { self.photo.image = image } } else { photo.image = image }
        }
        setRing(isHere, animated: animated && previous != nil && (previous == .here) != isHere)
    }

    private func setRing(_ on: Bool, animated: Bool) {
        if on {
            if animated {
                // Became here while shown: the ring springs out around them.
                let pop = CASpringAnimation(keyPath: "transform.scale")
                pop.fromValue = 0.6
                pop.toValue = 1
                pop.damping = 9
                pop.stiffness = 180
                pop.duration = pop.settlingDuration
                ring.add(pop, forKey: "pop")
                let fade = CABasicAnimation(keyPath: "opacity")
                fade.fromValue = 0
                fade.toValue = 1
                fade.duration = 0.2
                ring.add(fade, forKey: "fade")
            }
            ring.opacity = 1
            breathe()
        } else {
            if animated {
                let fade = CABasicAnimation(keyPath: "opacity")
                fade.fromValue = ring.presentation()?.opacity ?? ring.opacity
                fade.toValue = 0
                fade.duration = 0.3
                ring.add(fade, forKey: "fade")
            }
            ring.removeAnimation(forKey: "breathe")
            ring.opacity = 0
        }
    }

    /// The ring breathes while they are here: one repeating animation the
    /// render server plays, nothing asked of the main thread per frame.
    private func breathe() {
        guard tier == .here, ring.animation(forKey: "breathe") == nil, !UIAccessibility.isReduceMotionEnabled else { return }
        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 1
        scale.toValue = 1.14
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1
        fade.toValue = 0.35
        let group = CAAnimationGroup()
        group.animations = [scale, fade]
        group.duration = 1.1
        group.autoreverses = true
        group.repeatCount = .infinity
        group.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        // Out of step with the others here, so the slot doesn't pulse as one.
        group.beginTime = CACurrentMediaTime() + Double(abs(userId.hashValue % 1000)) / 1000
        group.fillMode = .backwards
        ring.add(group, forKey: "breathe")
    }

    /// Back in a window, or the app back in front: UIKit drops a layer's
    /// running animations when it leaves.
    func resume() { breathe() }

    // MARK: Coming and going

    func arrive(popping: Bool) {
        if popping {
            let resting = transform
            transform = resting.scaledBy(x: 0.2, y: 0.2)
            alpha = 0
            UIView.animate(withDuration: 0.6, delay: 0, usingSpringWithDamping: 0.5, initialSpringVelocity: 0.8, options: [.allowUserInteraction]) {
                self.transform = resting
                self.alpha = 1
            }
        } else {
            alpha = 0
            UIView.animate(withDuration: 0.25) { self.alpha = 1 }
        }
    }

    func move(to center: CGPoint, animated: Bool) {
        guard self.center != center else { return }
        if animated {
            UIView.animate(withDuration: 0.45, delay: 0, usingSpringWithDamping: 0.85, initialSpringVelocity: 0, options: [.beginFromCurrentState, .allowUserInteraction]) { self.center = center }
        } else {
            self.center = center
        }
    }

    func leave(animated: Bool) {
        loading?.cancel()
        guard animated else { removeFromSuperview(); return }
        UIView.animate(withDuration: 0.3, delay: 0, options: [.beginFromCurrentState, .curveEaseIn]) {
            self.alpha = 0
            self.transform = self.transform.scaledBy(x: 0.6, y: 0.6)
        } completion: { _ in
            self.removeFromSuperview()
        }
    }
}
#endif
