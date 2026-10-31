#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

/// The composer's "+" menu, after Telegram's attachment menu
/// (`AttachmentController`, `AttachmentContainer`, `AttachmentPanel`,
/// `MediaPickerScreen`): a sheet that slides up over the dimmed chat and
/// rests a quarter of the way down, drags up to fill the screen and down
/// to go. Its Gallery tab is the library newest first, with the camera two
/// cells tall at the top left, picked in order with numbered circles; the
/// glass tab bar at its foot turns into "Add N" while anything is picked.
/// Its Files tab offers Files and the system's photo picker.
///
/// The library is asked for the moment the gallery needs it. Limited
/// access shows what was allowed with a note to manage it; without access
/// the gallery explains, with the system's picker (which needs no access)
/// right under the explanation.
///
/// It only says what was chosen: the menu goes first, then `onAction`
/// hears it. On an iPad it is a card over the "+" instead.
@MainActor
final class AttachSheetViewController: UIViewController, UICollectionViewDataSource, UICollectionViewDelegate, UIGestureRecognizerDelegate {
    enum Action: Equatable {
        case camera
        /// The system's photo picker, which needs no access.
        case photos
        case files
        /// Picked in the grid, by the library's ids, in order.
        case add([String])
    }

    enum Tab: Int {
        case gallery
        case files
    }

    var onAction: ((Action) -> Void)?
    /// Closed, tapped outside or dragged away with nothing chosen.
    var onGone: (() -> Void)?
    /// The "+" in this view's space, for the iPad's card.
    var source: (() -> CGRect?)?

    let library: AttachLibrary
    private let limit: Int
    private let hasCamera: Bool
    private(set) var page: Tab = .gallery
    /// Picked, in order, by the library's ids.
    private(set) var picked: [String] = []
    private(set) var expanded = false
    private(set) var access: AttachLibraryAccess
    /// The sheet's top edge and how far below it is pulled, in the view's space.
    private var top: CGFloat = 0
    private var drop: CGFloat = 0
    /// The dip a tab switch gives the sheet.
    private var dip: CGFloat = 0
    private var shown = false
    private var closing = false
    private var asked = false
    private var sheet: AttachMenuSheetLayout?
    private var content: AttachMenuContentLayout?
    private var settling: UIViewPropertyAnimator?

    private let dim = UIView()
    private let shadow = UIView()
    private let clip = UIView()
    private let body = UIView()
    private let grabber = UIView()
    private let closeGlass: UIVisualEffectView = {
        let effect = UIGlassEffect(style: .regular)
        effect.isInteractive = true
        return UIVisualEffectView(effect: effect)
    }()
    private let closeButton = UIButton(type: .system)
    private let titleLabel = UILabel()
    private let gallery = UIView()
    private let gridLayout = AttachGridCollectionLayout()
    private lazy var grid = UICollectionView(frame: .zero, collectionViewLayout: gridLayout)
    private let cameraTile = AttachCameraTile()
    private let note = UIView()
    private let noteText = UILabel()
    private let noteButton = UIButton(type: .custom)
    private let placeholder = AttachMenuPlaceholderView()
    private let files = AttachMenuFilesView()
    private let bar = AttachMenuBar()
    private let pan = UIPanGestureRecognizer()
    private let haptic = UISelectionFeedbackGenerator()

    init(limit: Int, library: AttachLibrary = AttachMenuEnvironment.library(), camera: Bool = AttachMenuEnvironment.camera()) {
        self.limit = limit
        self.library = library
        hasCamera = camera
        access = library.access
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        view.accessibilityViewIsModal = true

        dim.backgroundColor = UIColor(Palette.attachMenuDim)
        dim.alpha = 0
        dim.accessibilityIdentifier = "attach-dim"
        dim.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(dimTapped)))
        view.addSubview(dim)

        shadow.backgroundColor = UIColor(Palette.libraryGround)
        shadow.layer.shadowColor = UIColor.black.cgColor
        shadow.layer.shadowOpacity = 0.3
        shadow.layer.shadowRadius = 40
        shadow.layer.shadowOffset = .zero
        shadow.layer.cornerCurve = .continuous
        shadow.isUserInteractionEnabled = false
        view.addSubview(shadow)

        clip.backgroundColor = UIColor(Palette.libraryGround)
        clip.clipsToBounds = true
        clip.layer.cornerCurve = .continuous
        clip.accessibilityIdentifier = "attach-sheet"
        view.addSubview(clip)
        clip.addSubview(body)
        grabber.backgroundColor = UIColor(Palette.attachMenuGrabber)
        grabber.layer.cornerRadius = AttachMenuMetrics.grabber.height / 2
        grabber.isUserInteractionEnabled = false
        clip.addSubview(grabber)

        closeButton.setImage(.icon(.ionicons("close"), size: 24), for: .normal)
        closeButton.tintColor = UIColor(Palette.headerTint)
        closeButton.accessibilityLabel = Strings.close
        closeButton.accessibilityIdentifier = "attach-close"
        closeButton.addAction(UIAction { [weak self] _ in self?.close() }, for: .touchUpInside)
        closeGlass.cornerConfiguration = .capsule()
        closeGlass.contentView.addSubview(closeButton)

        titleLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        titleLabel.textColor = UIColor(Palette.text)
        titleLabel.textAlignment = .center
        titleLabel.accessibilityTraits = .header
        titleLabel.accessibilityIdentifier = "attach-title"

        grid.backgroundColor = .clear
        grid.dataSource = self
        grid.delegate = self
        grid.alwaysBounceVertical = true
        grid.contentInsetAdjustmentBehavior = .never
        grid.accessibilityIdentifier = "attach-grid"
        grid.register(AttachGridCell.self, forCellWithReuseIdentifier: AttachGridCell.id)
        cameraTile.addAction(UIAction { [weak self] _ in self?.finish(.camera) }, for: .touchUpInside)
        grid.addSubview(cameraTile)

        noteText.text = Strings.Library.limited
        noteText.font = UIFontMetrics(forTextStyle: .subheadline).scaledFont(for: .systemFont(ofSize: 15))
        noteText.adjustsFontForContentSizeCategory = true
        noteText.textColor = UIColor(Palette.libraryNoteText)
        noteText.numberOfLines = 0
        var manage = AttributedString(Strings.Library.manage.uppercased())
        manage.font = .systemFont(ofSize: 15, weight: .semibold)
        manage.foregroundColor = UIColor(Palette.libraryNoteButtonText)
        noteButton.setAttributedTitle(NSAttributedString(manage), for: .normal)
        noteButton.backgroundColor = UIColor(Palette.libraryNoteButton)
        noteButton.layer.cornerRadius = LibraryPickerLayout.Metrics.noteButtonHeight / 2
        noteButton.accessibilityIdentifier = "attach-manage"
        noteButton.showsMenuAsPrimaryAction = true
        noteButton.menu = UIMenu(children: [
            UIAction(title: Strings.Library.selectMore, image: UIImage(systemName: "photo.badge.plus")) { [weak self] _ in
                guard let self else { return }
                library.manageLimited(from: self)
            },
            UIAction(title: Strings.Library.changeSettings, image: UIImage(systemName: "gear")) { _ in Self.openSettings() },
        ])
        note.addSubview(noteText)
        note.addSubview(noteButton)
        note.accessibilityIdentifier = "attach-limited"
        grid.addSubview(note)
        gallery.addSubview(grid)

        placeholder.isHidden = true
        placeholder.camera = hasCamera
        placeholder.onPhotos = { [weak self] in self?.finish(.photos) }
        placeholder.onSettings = { Self.openSettings() }
        placeholder.onCamera = { [weak self] in self?.finish(.camera) }
        gallery.addSubview(placeholder)

        files.isHidden = true
        files.onFiles = { [weak self] in self?.finish(.files) }
        files.onPhotos = { [weak self] in self?.finish(.photos) }

        for view in [gallery, files, closeGlass, titleLabel] as [UIView] { body.addSubview(view) }

        bar.titles = [Strings.AttachMenu.gallery, Strings.AttachMenu.files]
        bar.icons = [.ionicons("images"), .ionicons("folder")]
        bar.ids = ["attach-tab-gallery", "attach-tab-files"]
        bar.onTab = { [weak self] index in self?.switchTo(Tab(rawValue: index) ?? .gallery) }
        bar.onAdd = { [weak self] in
            guard let self, !picked.isEmpty else { return }
            finish(.add(picked))
        }
        view.addSubview(bar)

        pan.addTarget(self, action: #selector(panned(_:)))
        pan.delegate = self
        clip.addGestureRecognizer(pan)

        registerForTraitChanges([UITraitPreferredContentSizeCategory.self, UITraitHorizontalSizeClass.self, UITraitVerticalSizeClass.self]) { (self: Self, _) in
            self.view.setNeedsLayout()
        }
        library.onChange = { [weak self] in self?.libraryChanged() }
        showTab()
        showAccess(animated: false)
        if access.reads { library.load { [weak self] in self?.libraryChanged() } }
    }

    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        view.layoutIfNeeded()
        animateIn()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        askIfNeeded()
    }

    override func accessibilityPerformEscape() -> Bool {
        close()
        return true
    }

    // MARK: Library

    /// Telegram asks the moment the gallery would show the library.
    private func askIfNeeded() {
        guard access == .notDetermined, !asked else { return }
        asked = true
        library.requestAccess { [weak self] answer in
            guard let self else { return }
            access = answer
            showAccess(animated: true)
            if answer.reads { library.load { [weak self] in self?.libraryChanged() } }
        }
    }

    private func libraryChanged() {
        let before = access
        access = library.access
        // The picks the library no longer shows go.
        let live = Set((0..<library.count).compactMap { library.item(at: $0)?.id })
        let kept = picked.filter(live.contains)
        if kept != picked {
            picked = kept
            bar.setCount(picked.count, animated: true)
        }
        showAccess(animated: before != access)
        grid.reloadData()
        view.setNeedsLayout()
    }

    /// The grid, or (without access) the explanation; the limited note.
    private func showAccess(animated: Bool) {
        let denied = access == .denied
        let wasHidden = placeholder.isHidden
        grid.isHidden = denied
        placeholder.isHidden = !denied
        note.isHidden = access != .limited
        titleLabel.text = page == .files ? Strings.AttachMenu.files : Strings.AttachMenu.recents
        if denied, wasHidden, animated {
            placeholder.alpha = 0
            UIView.animate(withDuration: 0.3) { self.placeholder.alpha = 1 }
        }
        view.setNeedsLayout()
    }

    private static func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    // MARK: Layout

    private var regular: Bool {
        traitCollection.horizontalSizeClass == .regular && traitCollection.verticalSizeClass == .regular
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        dim.frame = view.bounds
        let next = AttachMenuSheetLayout(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets), regular: regular, source: source?())
        if next != sheet {
            sheet = next
            if drag == nil, settling == nil {
                if !next.canCollapse { expanded = true }
                top = next.top(expanded: expanded)
            }
        }
        place()
        layoutBody()
    }

    /// Where the sheet is: cheap enough for every frame of a drag.
    private func place() {
        guard let sheet else { return }
        let placement = sheet.placement(top: top, drop: drop + dip)
        clip.transform = .identity
        clip.bounds = CGRect(origin: .zero, size: placement.clip.size)
        clip.center = CGPoint(x: placement.clip.midX, y: placement.clip.midY)
        clip.transform = CGAffineTransform(scaleX: placement.scale, y: placement.scale)
        clip.layer.cornerRadius = sheet.cornerRadius
        clip.layer.maskedCorners = sheet.style == .sheet && view.safeAreaInsets.bottom == 0
            ? [.layerMinXMinYCorner, .layerMaxXMinYCorner]
            : [.layerMinXMinYCorner, .layerMaxXMinYCorner, .layerMinXMaxYCorner, .layerMaxXMaxYCorner]
        body.frame = placement.content
        grabber.isHidden = sheet.grabber(clipWidth: placement.clip.width) == nil
        grabber.frame = sheet.grabber(clipWidth: placement.clip.width) ?? .zero
        shadow.isHidden = sheet.style != .card
        shadow.frame = placement.clip
        shadow.layer.cornerRadius = sheet.cornerRadius
        bar.place(minX: placement.clip.minX, width: placement.clip.width, bottom: placement.barBottom, pixel: view.hairline)
    }

    /// The header and the page, for the sheet's content size and how much
    /// of it is below the screen.
    private func layoutBody() {
        guard let sheet else { return }
        let placement = sheet.placement(top: top)
        let showsNote = access == .limited
        let layout = AttachMenuContentLayout(.init(
            width: placement.content.width, height: placement.content.height, sides: sheet.sides,
            title: titleLabel.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: 44)),
            wide: sheet.style == .fullScreen, pixel: view.hairline,
            count: access.reads ? library.count : 0, camera: hasCamera && access != .denied,
            note: showsNote ? noteText.measurable : nil,
            noteButton: showsNote ? noteButton.titleLabel?.intrinsicContentSize : nil,
            hidden: placement.hidden
        ))
        content = layout
        closeGlass.frame = layout.close
        closeButton.frame = closeGlass.bounds
        titleLabel.setLayoutFrame(layout.title)
        gallery.frame = layout.page
        files.frame = layout.page
        grid.frame = gallery.bounds
        gridLayout.grid = layout.grid
        cameraTile.isHidden = layout.grid.camera == nil
        cameraTile.frame = layout.grid.camera ?? .zero
        if let frame = layout.note {
            note.frame = frame
            noteText.setLayoutFrame(layout.noteText ?? .zero)
            noteButton.setLayoutFrame(layout.noteButton ?? .zero)
        }
        let inset = UIEdgeInsets(top: 0, left: 0, bottom: layout.bottomInset, right: 0)
        if grid.contentInset != inset {
            grid.contentInset = inset
            grid.verticalScrollIndicatorInsets = inset
        }
        placeholder.frame = gallery.bounds
        placeholder.place(visibleHeight: layout.visibleHeight, bottomInset: layout.bottomInset, upright: sheet.style != .fullScreen)
        files.place(sides: sheet.sides, bottomInset: layout.bottomInset, pixel: view.hairline)
        prepareThumbnails()
    }

    // MARK: Motion

    /// Telegram's in: up from below the screen over 0.4 s while the dim
    /// fades in over 0.3; an iPad's card the same, its dim a tenth as dark.
    private func animateIn() {
        guard !shown, let sheet else { return }
        shown = true
        expanded = !sheet.canCollapse
        top = sheet.top(expanded: expanded)
        drop = view.bounds.height
        place()
        layoutBody()
        dim.alpha = 0
        let curve = AttachMenuMotion.openCurve
        let animator = UIViewPropertyAnimator(duration: AttachMenuMotion.openDuration, controlPoint1: CGPoint(x: CGFloat(curve.x1), y: CGFloat(curve.y1)), controlPoint2: CGPoint(x: CGFloat(curve.x2), y: CGFloat(curve.y2))) {
            self.drop = 0
            self.place()
        }
        animator.isUserInteractionEnabled = true
        animator.startAnimation()
        let dimTarget = sheet.style == .card ? AttachMenuMotion.cardDimShare : 1
        UIView.animate(withDuration: AttachMenuMotion.dimDuration, delay: 0, options: [.curveLinear, .allowUserInteraction]) {
            self.dim.alpha = dimTarget
        }
    }

    func close() {
        let onGone = onGone
        leave { onGone?() }
    }

    /// The menu goes, then the choice is heard over what it covered.
    private func finish(_ action: Action) {
        let onAction = onAction
        leave { onAction?(action) }
    }

    /// Telegram's out: down past the screen in 0.25 s with the dim; an
    /// iPad's card fades over 0.3.
    private func leave(completion: @escaping () -> Void) {
        guard !closing else { return }
        closing = true
        settling?.stopAnimation(true)
        settling = nil
        view.isUserInteractionEnabled = false
        let gone = { [weak self] in
            guard let self, presentingViewController != nil else { return completion() }
            dismiss(animated: false, completion: completion)
        }
        guard shown, let sheet else { return gone() }
        if sheet.style == .card {
            UIView.animate(withDuration: AttachMenuMotion.cardCloseDuration, delay: 0, options: [.curveEaseInOut, .beginFromCurrentState]) {
                self.view.alpha = 0
            } completion: { _ in gone() }
            return
        }
        UIView.animate(withDuration: AttachMenuMotion.closeDuration, delay: 0, options: [.curveEaseInOut, .beginFromCurrentState]) {
            self.drop = self.view.bounds.height
            self.dim.alpha = 0
            self.place()
        } completion: { _ in gone() }
    }

    @objc private func dimTapped() { close() }

    /// Pulled up to its full height, or back to rest, on Telegram's spring:
    /// what a drag that far does, for VoiceOver's scroll and for tests.
    func setExpanded(_ value: Bool) {
        guard let sheet, sheet.style == .sheet, value != expanded, value || sheet.canCollapse, !closing else { return }
        settling?.stopAnimation(true)
        settling = nil
        expanded = value
        settle(to: sheet.top(expanded: value), velocity: 0, spring: true)
    }

    override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
        switch direction {
        case .up where !expanded: setExpanded(true); return true
        case .down where expanded: setExpanded(false); return true
        default: return false
        }
    }

    // MARK: Dragging (AttachmentContainer.panGesture)

    private struct Drag {
        var startExpanded: Bool
        /// The translation the sheet last followed; frozen while the grid scrolls.
        var translation: CGFloat
        weak var scroll: UIScrollView?
    }

    private var drag: Drag?

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === pan else { return true }
        return sheet?.style != .card && !closing
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        gestureRecognizer === pan && other is UIPanGestureRecognizer
    }

    private func scrollView(at point: CGPoint) -> UIScrollView? {
        var view = self.view.hitTest(point, with: nil)
        while let current = view, current !== clip {
            if let scroll = current as? UIScrollView, !(scroll is UITextView) { return scroll }
            view = current.superview
        }
        return nil
    }

    private func atTop(_ scroll: UIScrollView) -> Bool {
        scroll.contentOffset.y <= -scroll.adjustedContentInset.top + 1
    }

    private func pin(_ scroll: UIScrollView) {
        scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: -scroll.adjustedContentInset.top), animated: false)
    }

    @objc private func panned(_ recognizer: UIPanGestureRecognizer) {
        guard let sheet else { return }
        switch recognizer.state {
        case .began:
            settling?.stopAnimation(true)
            settling = nil
            drag = Drag(startExpanded: expanded, translation: 0, scroll: scrollView(at: recognizer.location(in: view)))
        case .changed:
            guard var current = drag else { return }
            var translation = recognizer.translation(in: view).y
            let base = current.startExpanded ? 0 : sheet.travel
            if let scroll = current.scroll {
                if atTop(scroll) {
                    scroll.bounces = false
                    pin(scroll)
                } else {
                    translation = current.translation
                    if current.startExpanded {
                        recognizer.setTranslation(.zero, in: view)
                    } else if base + translation > 0 {
                        pin(scroll)
                    }
                }
                if !current.startExpanded, base + translation > 0 {
                    scroll.panGestureRecognizer.setTranslation(.zero, in: scroll)
                }
            }
            current.translation = translation
            drag = current
            let moved = AttachMenuMotion.drag(expanded: current.startExpanded, canCollapse: sheet.canCollapse, travel: sheet.travel, translation: translation)
            top = sheet.expandedTop + moved.offset
            drop = moved.drop
            place()
        case .ended, .cancelled, .failed:
            guard let current = drag else { return }
            drag = nil
            current.scroll?.bounces = true
            let velocity = recognizer.state == .ended ? recognizer.velocity(in: view).y : 0
            let scrolled = current.scroll.map { $0.contentOffset.y > -$0.adjustedContentInset.top + 0.1 } ?? false
            let outcome = recognizer.state == .ended
                ? AttachMenuMotion.settle(expanded: current.startExpanded, canCollapse: sheet.canCollapse, travel: sheet.travel, offset: top - sheet.expandedTop, drop: drop, velocity: velocity, scrolled: scrolled)
                : .stay
            switch outcome {
            case .dismiss:
                close()
            case .expand:
                expanded = true
                settle(to: sheet.expandedTop, velocity: velocity, spring: true)
            case .collapse:
                expanded = false
                if let scroll = current.scroll { pin(scroll) }
                settle(to: sheet.restTop, velocity: velocity, spring: true)
            case .stay:
                expanded = current.startExpanded
                settle(to: sheet.top(expanded: expanded), velocity: 0, spring: false)
            }
        default:
            break
        }
    }

    /// To `target`, the drop gone: on Telegram's spring after a flick or a
    /// change of state, else 0.3 s ease in-out.
    private func settle(to target: CGFloat, velocity: CGFloat, spring: Bool) {
        let distance = target - top
        let animator: UIViewPropertyAnimator
        if spring {
            let relative = distance == 0 ? 0 : velocity / distance
            animator = UIViewPropertyAnimator(duration: AttachMenuMotion.settleDuration, timingParameters: AttachMenuSprings.settle(initialVelocity: relative))
        } else {
            animator = UIViewPropertyAnimator(duration: AttachMenuMotion.returnDuration, curve: .easeInOut)
        }
        top = target
        drop = 0
        animator.addAnimations {
            self.place()
            self.layoutBody()
        }
        animator.addCompletion { [weak self] _ in
            guard let self, settling === animator else { return }
            settling = nil
            view.setNeedsLayout()
        }
        animator.isUserInteractionEnabled = true
        settling = animator
        animator.startAnimation()
    }

    // MARK: Tabs

    /// Telegram's tab switch: the old page fades out over the new one while
    /// the sheet dips and springs back.
    private func switchTo(_ next: Tab) {
        guard next != page, !closing else { return }
        if let snapshot = body.snapshotView(afterScreenUpdates: false) {
            snapshot.frame = body.frame
            snapshot.isUserInteractionEnabled = false
            clip.insertSubview(snapshot, aboveSubview: body)
            UIView.animate(withDuration: AttachMenuMotion.switchFade, delay: 0, options: [.curveEaseInOut]) {
                snapshot.alpha = 0
            } completion: { _ in snapshot.removeFromSuperview() }
        }
        page = next
        showTab()
        bar.select(next.rawValue, animated: true)
        view.setNeedsLayout()
        view.layoutIfNeeded()
        guard sheet?.style == .sheet else { return }
        UIView.animate(withDuration: AttachMenuMotion.switchDipDuration, delay: 0, options: [.curveEaseInOut, .allowUserInteraction]) {
            self.dip = AttachMenuMotion.switchDip
            self.place()
        } completion: { _ in
            let back = UIViewPropertyAnimator(duration: AttachMenuMotion.switchReturnDuration, timingParameters: AttachMenuSprings.dipReturn())
            back.addAnimations {
                self.dip = 0
                self.place()
            }
            back.isUserInteractionEnabled = true
            back.startAnimation()
        }
    }

    private func showTab() {
        gallery.isHidden = page != .gallery
        files.isHidden = page != .files
        titleLabel.text = page == .files ? Strings.AttachMenu.files : Strings.AttachMenu.recents
    }

    // MARK: Grid

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        access.reads ? library.count : 0
    }

    private var thumbnailPixels: CGSize {
        let scale = view.window?.screen.scale ?? view.traitCollection.displayScale
        let cell = gridLayout.grid?.cell ?? .zero
        return CGSize(width: cell.width * scale, height: cell.height * scale)
    }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: AttachGridCell.id, for: indexPath) as! AttachGridCell
        guard let item = library.item(at: indexPath.item) else { return cell }
        cell.show(item, index: indexPath.item, library: library, pixels: thumbnailPixels)
        cell.setNumber(number(item.id), animated: false)
        cell.dimmed = cell.number == nil && picked.count >= limit
        return cell
    }

    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        collectionView.deselectItem(at: indexPath, animated: false)
        guard let item = library.item(at: indexPath.item) else { return }
        toggle(item.id)
    }

    private func number(_ id: String) -> Int? { picked.firstIndex(of: id).map { $0 + 1 } }

    /// Picks or unpicks; the numbers after it close up.
    func toggle(_ id: String) {
        if let index = picked.firstIndex(of: id) {
            picked.remove(at: index)
        } else {
            guard picked.count < limit else { return }
            picked.append(id)
        }
        haptic.selectionChanged()
        let full = picked.count >= limit
        for cell in grid.visibleCells.compactMap({ $0 as? AttachGridCell }) {
            guard let cellID = cell.itemID else { continue }
            let next = number(cellID)
            cell.setNumber(next, animated: cellID == id)
            cell.dimmed = next == nil && full
        }
        bar.setCount(picked.count, animated: true)
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView === grid else { return }
        prepareThumbnails()
    }

    /// Thumbnails a screen ahead and behind are made before they show.
    private func prepareThumbnails() {
        guard access.reads, let layout = gridLayout.grid, view.window != nil else { return }
        let bounds = grid.bounds
        library.prepare(layout.visible(minY: bounds.minY - bounds.height, maxY: bounds.maxY + bounds.height), pixels: thumbnailPixels)
    }
}

/// Telegram's springs as UIKit's, sped up to their durations as Display
/// speeds up its `CASpringAnimation`s.
@MainActor
enum AttachMenuSprings {
    static func settle(initialVelocity: CGFloat) -> UISpringTimingParameters {
        spring(mass: AttachMenuMotion.springMass, stiffness: AttachMenuMotion.springStiffness, damping: AttachMenuMotion.springDamping, duration: AttachMenuMotion.settleDuration, velocity: initialVelocity)
    }

    static func dipReturn() -> UISpringTimingParameters {
        spring(mass: 1, stiffness: 900, damping: AttachMenuMotion.switchReturnDamping, duration: AttachMenuMotion.switchReturnDuration, velocity: 0)
    }

    /// A spring settling in `duration`: time scaled by f takes damping
    /// c·f and stiffness k·f², and the start velocity with it.
    private static func spring(mass: CGFloat, stiffness: CGFloat, damping: CGFloat, duration: TimeInterval, velocity: CGFloat) -> UISpringTimingParameters {
        let probe = CASpringAnimation()
        probe.mass = mass
        probe.stiffness = stiffness
        probe.damping = damping
        let factor = duration > 0 ? CGFloat(probe.settlingDuration / duration) : 1
        return UISpringTimingParameters(mass: mass, stiffness: stiffness * factor * factor, damping: damping * factor, initialVelocity: CGVector(dx: 0, dy: velocity * factor))
    }
}

/// The grid's frames, straight from `AttachMenuGridLayout`.
final class AttachGridCollectionLayout: UICollectionViewLayout {
    var grid: AttachMenuGridLayout? {
        didSet { if grid != oldValue { invalidateLayout() } }
    }

    override var collectionViewContentSize: CGSize {
        CGSize(width: collectionView?.bounds.width ?? 0, height: grid?.contentHeight ?? 0)
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        guard let grid, let count = collectionView?.numberOfItems(inSection: 0) else { return nil }
        return grid.visible(minY: rect.minY, maxY: rect.maxY).filter { $0 < count }.map { attributes(grid, $0) }
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        guard let grid else { return nil }
        return attributes(grid, indexPath.item)
    }

    private func attributes(_ grid: AttachMenuGridLayout, _ index: Int) -> UICollectionViewLayoutAttributes {
        let attributes = UICollectionViewLayoutAttributes(forCellWith: IndexPath(item: index, section: 0))
        attributes.frame = grid.frame(at: index)
        return attributes
    }

    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool { false }
}

/// One picture of the grid: the thumbnail filling the square, the number
/// circle at its top right and a video's length at its bottom right.
final class AttachGridCell: UICollectionViewCell {
    static let id = "attach-cell"
    private let picture = UIImageView()
    private let check = LibraryCheckView()
    private let duration = UILabel()
    private weak var library: AttachLibrary?
    private var request: Int?
    private(set) var itemID: String?
    private var length: String?
    var number: Int? { check.number }
    /// Nothing more can be picked: an unpicked picture fades.
    var dimmed = false { didSet { picture.alpha = dimmed ? 0.5 : 1 } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.backgroundColor = UIColor(Palette.libraryPlaceholder)
        picture.contentMode = .scaleAspectFill
        picture.clipsToBounds = true
        contentView.addSubview(picture)
        duration.font = .systemFont(ofSize: 11, weight: .semibold)
        duration.textColor = .white
        duration.layer.shadowColor = UIColor.black.cgColor
        duration.layer.shadowOpacity = 0.4
        duration.layer.shadowRadius = 2
        duration.layer.shadowOffset = .zero
        contentView.addSubview(duration)
        contentView.addSubview(check)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(_ item: AttachLibraryItem, index: Int, library: AttachLibrary, pixels: CGSize) {
        if let request { self.library?.cancelThumbnail(request) }
        self.library = library
        itemID = item.id
        accessibilityIdentifier = "attach-photo:\(index)"
        length = item.duration.map { LibraryPickerLayout.duration(seconds: $0) }
        duration.text = length
        duration.isHidden = length == nil
        picture.image = nil
        let id = item.id
        request = library.thumbnail(at: index, pixels: pixels) { [weak self] image in
            guard let self, itemID == id else { return }
            picture.image = image
        }
        setNeedsLayout()
    }

    func setNumber(_ number: Int?, animated: Bool) {
        check.set(number, animated: animated)
        accessibilityLabel = length.map { Strings.Library.video($0, index: number) } ?? Strings.Library.photo(number)
        accessibilityValue = number.map(String.init)
        if number != nil { accessibilityTraits.insert(.selected) } else { accessibilityTraits.remove(.selected) }
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        if let request { library?.cancelThumbnail(request) }
        request = nil
        itemID = nil
        picture.image = nil
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        picture.frame = contentView.bounds
        check.frame = LibraryPickerLayout.check(in: bounds.size)
        duration.frame = LibraryPickerLayout.duration(duration.intrinsicContentSize, in: bounds.size)
    }
}

/// The camera's cell, two pictures tall: black, with the camera's glyph.
final class AttachCameraTile: UIControl {
    private let icon = IconView(.ionicons("camera"), size: AttachMenuMetrics.cameraIcon, tint: Palette.attachMenuCameraGlyph)

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(Palette.attachMenuCamera)
        icon.isUserInteractionEnabled = false
        addSubview(icon)
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityIdentifier = "attach-camera"
        accessibilityLabel = Strings.AttachMenu.camera
        accessibilityHint = Strings.AttachMenu.cameraHint
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var isHighlighted: Bool {
        didSet { icon.alpha = isHighlighted ? 0.5 : 1 }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // IconView centres its glyph in what it is given.
        icon.frame = bounds
    }
}

/// Telegram's glass tab bar (`AttachmentPanel`, glass): a capsule of tabs
/// with a pill behind the chosen one, which turns into "Add N" while
/// anything is picked.
final class AttachMenuBar: UIView {
    var titles: [String] = [] { didSet { rebuild() } }
    var icons: [Icon] = [] { didSet { rebuild() } }
    var ids: [String] = [] { didSet { rebuild() } }
    var onTab: ((Int) -> Void)?
    var onAdd: (() -> Void)?
    private(set) var selected = 0
    private(set) var count = 0
    private let glass: UIVisualEffectView = {
        let effect = UIGlassEffect(style: .regular)
        effect.isInteractive = true
        return UIVisualEffectView(effect: effect)
    }()
    private let pill = UIView()
    private var tabs: [AttachMenuTabControl] = []
    private let add = UIButton(type: .custom)
    private let addLabel = UILabel()
    private var placed: (minX: CGFloat, width: CGFloat, bottom: CGFloat, pixel: CGFloat)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        glass.cornerConfiguration = .capsule()
        addSubview(glass)
        pill.backgroundColor = UIColor(Palette.attachMenuTabPill)
        pill.isUserInteractionEnabled = false
        glass.contentView.addSubview(pill)
        addLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        addLabel.textColor = .white
        addLabel.textAlignment = .center
        addLabel.isUserInteractionEnabled = false
        add.addSubview(addLabel)
        add.alpha = 0
        add.isHidden = true
        add.accessibilityIdentifier = "attach-add"
        add.addAction(UIAction { [weak self] _ in self?.onAdd?() }, for: .touchUpInside)
        glass.contentView.addSubview(add)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func rebuild() {
        tabs.forEach { $0.removeFromSuperview() }
        tabs = titles.enumerated().map { index, title in
            let tab = AttachMenuTabControl(title: title, icon: icons.indices.contains(index) ? icons[index] : nil)
            tab.accessibilityIdentifier = ids.indices.contains(index) ? ids[index] : nil
            tab.addAction(UIAction { [weak self] _ in
                guard let self else { return }
                select(index, animated: true)
                onTab?(index)
            }, for: .touchUpInside)
            glass.contentView.addSubview(tab)
            return tab
        }
        select(selected, animated: false)
    }

    func select(_ index: Int, animated: Bool) {
        selected = index
        for (offset, tab) in tabs.enumerated() { tab.chosen = offset == index }
        relayout(animated: animated)
    }

    func setCount(_ count: Int, animated: Bool) {
        let was = self.count
        self.count = count
        if count > 0 { addLabel.text = Strings.AttachMenu.add(count) }
        add.accessibilityLabel = addLabel.text
        guard (was > 0) != (count > 0) else { return relayout(animated: false) }
        if count > 0 { add.isHidden = false }
        let picking = count > 0
        let effect = UIGlassEffect(style: .regular)
        effect.isInteractive = true
        if picking { effect.tintColor = UIColor(Palette.libraryCheckFill) }
        let changes = {
            self.glass.effect = effect
            self.add.alpha = picking ? 1 : 0
            self.pill.alpha = picking ? 0 : 1
            for tab in self.tabs { tab.alpha = picking ? 0 : 1 }
            self.relayout(animated: false)
        }
        let done = { (_: Bool) in
            if self.count == 0 { self.add.isHidden = true }
            for tab in self.tabs { tab.isHidden = self.count > 0 }
        }
        for tab in tabs { tab.isHidden = false }
        guard animated else { changes(); return done(true) }
        UIView.animate(withDuration: AttachMenuMotion.barDuration, delay: 0, usingSpringWithDamping: 0.86, initialSpringVelocity: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: changes, completion: done)
    }

    func place(minX: CGFloat, width: CGFloat, bottom: CGFloat, pixel: CGFloat) {
        placed = (minX, width, bottom, pixel)
        relayout(animated: false)
    }

    private func relayout(animated: Bool) {
        guard let placed else { return }
        let fits = CGSize(width: CGFloat.greatestFiniteMagnitude, height: 40)
        let layout = AttachMenuBarLayout(
            minX: placed.minX, width: placed.width, bottom: placed.bottom,
            titles: tabs.map(\.titleSize), selected: selected, picking: count > 0,
            addTitle: addLabel.sizeThatFits(fits), pixel: placed.pixel
        )
        let apply = {
            self.frame = layout.capsule
            self.glass.frame = self.bounds
            self.pill.frame = layout.selection
            self.pill.layer.cornerRadius = layout.selection.height / 2
            for (tab, frame) in zip(self.tabs, layout.tabs) { tab.place(frame) }
            self.add.frame = self.bounds
            self.addLabel.frame = layout.add
        }
        guard animated else { return apply() }
        let curve = AttachMenuMotion.openCurve
        UIViewPropertyAnimator(duration: AttachMenuMotion.barDuration, controlPoint1: CGPoint(x: CGFloat(curve.x1), y: CGFloat(curve.y1)), controlPoint2: CGPoint(x: CGFloat(curve.x2), y: CGFloat(curve.y2)), animations: apply).startAnimation()
    }
}

/// One tab: its glyph over its name, accent when chosen.
final class AttachMenuTabControl: UIControl {
    private let icon: IconView
    private let label = UILabel()
    var chosen = false {
        didSet {
            icon.tintColor = UIColor(chosen ? Palette.attachMenuTabSelected : Palette.attachMenuTab)
            label.textColor = UIColor(chosen ? Palette.attachMenuTabSelected : Palette.attachMenuTab)
            accessibilityTraits = chosen ? [.button, .selected] : .button
        }
    }

    init(title: String, icon: Icon?) {
        self.icon = IconView(icon, size: AttachMenuMetrics.tabIcon, tint: Palette.attachMenuTab)
        super.init(frame: .zero)
        self.icon.isUserInteractionEnabled = false
        label.text = title
        label.font = .systemFont(ofSize: 10, weight: .medium)
        label.textColor = UIColor(Palette.attachMenuTab)
        label.textAlignment = .center
        addSubview(self.icon)
        addSubview(label)
        isAccessibilityElement = true
        accessibilityLabel = title
        accessibilityTraits = .button
        showsLargeContentViewer = true
        largeContentTitle = title
        addInteraction(UILargeContentViewerInteraction())
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    var titleSize: CGSize { label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: 20)) }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.6 : 1 }
    }

    /// Placed by the bar's layout, its parts in its own space.
    func place(_ tab: AttachMenuBarLayout.Tab) {
        frame = tab.frame
        icon.frame = tab.icon.offsetBy(dx: -tab.frame.minX, dy: -tab.frame.minY)
        label.frame = tab.title.offsetBy(dx: -tab.frame.minX, dy: -tab.frame.minY)
    }
}

/// No library: Telegram's placeholder, the system's picker under the words.
final class AttachMenuPlaceholderView: UIScrollView {
    var onPhotos: (() -> Void)?
    var onSettings: (() -> Void)?
    var onCamera: (() -> Void)?
    var camera = false { didSet { cameraButton.isHidden = !camera } }
    private let image = IconView(.ionicons("image-outline"), size: AttachMenuPlaceholderLayout.Metrics.image, tint: Palette.attachMenuPlaceholderIcon)
    private let title = UILabel()
    private let text = UILabel()
    private let primary = UIButton(configuration: .prominentGlass())
    private let settings = UIButton(type: .system)
    private let cameraButton = UIButton(type: .system)

    override init(frame: CGRect) {
        super.init(frame: frame)
        alwaysBounceVertical = true
        contentInsetAdjustmentBehavior = .never
        accessibilityIdentifier = "attach-no-access"
        image.isUserInteractionEnabled = false
        image.isAccessibilityElement = false
        title.text = Strings.AttachMenu.accessTitle
        title.font = UIFontMetrics(forTextStyle: .headline).scaledFont(for: .systemFont(ofSize: 17, weight: .medium))
        title.adjustsFontForContentSizeCategory = true
        title.textColor = UIColor(Palette.text)
        title.textAlignment = .center
        title.numberOfLines = 0
        title.accessibilityTraits = .header
        text.text = Strings.AttachMenu.accessText
        text.font = UIFontMetrics(forTextStyle: .subheadline).scaledFont(for: .systemFont(ofSize: 15))
        text.adjustsFontForContentSizeCategory = true
        text.textColor = UIColor(Palette.libraryNoteText)
        text.textAlignment = .center
        text.numberOfLines = 0

        primary.configuration?.cornerStyle = .capsule
        primary.tintColor = UIColor(Palette.libraryCheckFill)
        primary.configuration?.title = Strings.AttachMenu.choosePhotos
        primary.configuration?.baseForegroundColor = UIColor(Palette.libraryCheckText)
        primary.configuration?.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Self.buttonFont
            return attributes
        }
        primary.configuration?.titleLineBreakMode = .byWordWrapping
        primary.accessibilityIdentifier = "attach-photos"
        primary.addAction(UIAction { [weak self] _ in self?.onPhotos?() }, for: .touchUpInside)

        for (button, name, id) in [(settings, Strings.AttachMenu.openSettings, "attach-settings"), (cameraButton, Strings.AttachMenu.openCamera, "attach-open-camera")] {
            button.setTitle(name, for: .normal)
            button.titleLabel?.font = Self.linkFont
            button.titleLabel?.adjustsFontForContentSizeCategory = true
            button.titleLabel?.numberOfLines = 0
            button.titleLabel?.textAlignment = .center
            button.tintColor = UIColor(Palette.libraryCheckFill)
            button.accessibilityIdentifier = id
        }
        settings.addAction(UIAction { [weak self] _ in self?.onSettings?() }, for: .touchUpInside)
        cameraButton.addAction(UIAction { [weak self] _ in self?.onCamera?() }, for: .touchUpInside)
        cameraButton.isHidden = true
        for view in [image, title, text, primary, settings, cameraButton] as [UIView] { addSubview(view) }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private static var buttonFont: UIFont { UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 17, weight: .semibold)) }
    private static var linkFont: UIFont { UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 17)) }

    private func measure(_ string: String, _ font: UIFont, width: CGFloat) -> CGSize {
        let bounds = (string as NSString).boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: font], context: nil)
        return CGSize(width: ceil(bounds.width), height: ceil(bounds.height))
    }

    func place(visibleHeight: CGFloat, bottomInset: CGFloat, upright: Bool) {
        let inner = max(0, bounds.width - 2 * AttachMenuPlaceholderLayout.Metrics.side - 2 * AttachMenuPlaceholderLayout.Metrics.buttonPadding)
        let layout = AttachMenuPlaceholderLayout(
            width: bounds.width, height: visibleHeight, upright: upright,
            title: title.measurable, text: text.measurable,
            primary: measure(Strings.AttachMenu.choosePhotos, Self.buttonFont, width: inner),
            settings: measure(Strings.AttachMenu.openSettings, Self.linkFont, width: inner),
            camera: camera ? measure(Strings.AttachMenu.openCamera, Self.linkFont, width: inner) : nil
        )
        settings.titleLabel?.font = Self.linkFont
        cameraButton.titleLabel?.font = Self.linkFont
        image.isHidden = layout.image == nil
        image.frame = layout.image ?? .zero
        title.setLayoutFrame(layout.title)
        text.setLayoutFrame(layout.text)
        primary.frame = layout.primary
        settings.frame = layout.settings
        cameraButton.frame = layout.camera ?? .zero
        contentSize = CGSize(width: bounds.width, height: layout.contentHeight)
        let inset = UIEdgeInsets(top: 0, left: 0, bottom: bottomInset, right: 0)
        if contentInset != inset {
            contentInset = inset
            verticalScrollIndicatorInsets = inset
        }
    }
}

/// The Files tab: Telegram's "Select from Files" and "Select from Gallery".
final class AttachMenuFilesView: UIScrollView {
    var onFiles: (() -> Void)?
    var onPhotos: (() -> Void)?
    private let group = UIView()
    private let rows: [AttachMenuRow]

    override init(frame: CGRect) {
        rows = [
            AttachMenuRow(icon: .ionicons("folder-open-outline"), title: Strings.AttachMenu.selectFromFiles, id: "attach-files"),
            AttachMenuRow(icon: .ionicons("image-outline"), title: Strings.AttachMenu.selectPhotos, id: "attach-system-photos"),
        ]
        super.init(frame: frame)
        alwaysBounceVertical = true
        contentInsetAdjustmentBehavior = .never
        accessibilityIdentifier = "attach-files-page"
        group.backgroundColor = UIColor(Palette.attachFill)
        group.layer.cornerRadius = AttachMenuFilesLayout.Metrics.radius
        group.layer.cornerCurve = .continuous
        group.clipsToBounds = true
        addSubview(group)
        for row in rows { group.addSubview(row) }
        rows[0].addAction(UIAction { [weak self] _ in self?.onFiles?() }, for: .touchUpInside)
        rows[1].addAction(UIAction { [weak self] _ in self?.onPhotos?() }, for: .touchUpInside)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func place(sides: LayoutInsets, bottomInset: CGFloat, pixel: CGFloat) {
        let layout = AttachMenuFilesLayout(width: bounds.width, sides: sides, titles: rows.map(\.titleMeasurable), pixel: pixel)
        group.frame = layout.group
        for (row, frame) in zip(rows, layout.rows) { row.place(frame) }
        contentSize = CGSize(width: bounds.width, height: layout.contentHeight)
        let inset = UIEdgeInsets(top: 0, left: 0, bottom: max(0, bottomInset - AttachMenuMetrics.barReserve), right: 0)
        if contentInset != inset { contentInset = inset }
    }
}

/// One row of the Files tab: an icon and its words.
final class AttachMenuRow: UIControl {
    private let icon: IconView
    private let title = UILabel()
    private let separator = UIView()

    init(icon: Icon, title text: String, id: String) {
        self.icon = IconView(icon, size: AttachMenuFilesLayout.Metrics.icon, tint: Palette.libraryCheckFill)
        super.init(frame: .zero)
        self.icon.isUserInteractionEnabled = false
        title.text = text
        title.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 17))
        title.adjustsFontForContentSizeCategory = true
        title.textColor = UIColor(Palette.libraryCheckFill)
        title.numberOfLines = 0
        separator.backgroundColor = UIColor(Palette.divider)
        for view in [self.icon, title, separator] as [UIView] { addSubview(view) }
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityIdentifier = id
        accessibilityLabel = text
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    var titleMeasurable: Measurable { title.measurable }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? UIColor(Palette.rowPressed) : .clear }
    }

    func place(_ row: AttachMenuFilesLayout.Row) {
        frame = row.frame
        let origin = row.frame.origin
        icon.frame = row.icon.offsetBy(dx: -origin.x, dy: -origin.y)
        title.frame = row.title.offsetBy(dx: -origin.x, dy: -origin.y)
        separator.isHidden = row.separator == nil
        separator.frame = row.separator?.offsetBy(dx: -origin.x, dy: -origin.y) ?? .zero
    }
}
#endif
