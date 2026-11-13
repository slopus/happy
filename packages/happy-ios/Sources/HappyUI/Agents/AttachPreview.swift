#if canImport(UIKit)
import AVFoundation
import HappyIcons
import HappyLayout
import UIKit

/// A view the preview zooms out of and back into, such as a grid cell,
/// that hands over the picture it shows so the zoom starts from it; any
/// other view is zoomed from a snapshot of itself.
@MainActor
protocol AttachPreviewSource: UIView {
    var previewImage: UIImage? { get }
}

/// What the preview's foot does for the menu over it (Telegram's caption
/// panel and editing toolbar): the caption, shared with the menu's;
/// send; the editor's edits, kept in the menu's library.
@MainActor
struct AttachPreviewComposer {
    let library: AttachEditingLibrary
    var caption: () -> String
    var setCaption: (String) -> Void
    /// Sends the picks; the picture in view when none is picked.
    var send: (String) -> Void
    /// An edit was applied to picture `id`: it is picked, as Telegram's are.
    var edited: (String) -> Void
}

/// Telegram's media picker gallery for the "+" menu
/// (`MediaPickerScreen.openMedia`, `presentLegacyMediaPickerGallery`,
/// `TGMediaPickerGallery*`): a tapped picture zooms out of its cell to the
/// whole screen on black; the library pages left and right in the grid's
/// order; the number circle at the top right picks the one in view, as the
/// grid's does; a picture pinches or double-taps to zoom, a video plays
/// where it is; dragged up or down it follows the finger as the black
/// fades and, let go, zooms back into its cell (or leaves the screen when
/// that cell isn't showing).
final class AttachPreviewViewController: UIViewController, UIScrollViewDelegate, UIGestureRecognizerDelegate, UIViewControllerTransitioningDelegate {
    private let count: Int
    private let item: @MainActor (Int) -> AttachLibraryItem?
    private let image: @MainActor (Int, CGSize, @escaping @MainActor (UIImage) -> Void) -> Int?
    private let cancel: @MainActor (Int) -> Void
    private let video: (@MainActor (String) async -> URL?)?
    private let selectionNumber: @MainActor (String) -> Int?
    private let toggle: @MainActor (String) -> Bool
    private let sourceView: @MainActor (Int) -> UIView?
    /// Closed, once it is gone from the screen.
    var onClose: (() -> Void)?
    /// The picture the preview stands for, so its cell can hide while it
    /// shows; nil once it's closed (Telegram's `updateHiddenMedia`).
    var onHide: ((String?) -> Void)?
    /// The page in view changed.
    var onFocus: ((Int) -> Void)?
    private(set) var index: Int

    private let ground = UIView()
    private let pager = UIScrollView()
    private var pages: [Int: AttachPreviewPage] = [:]
    private let chrome = AttachPreviewChrome()
    private let back = UIButton(type: .custom)
    private let backIcon = IconView(.ionicons("chevron-back"), size: AttachPreviewLayout.Metrics.backIcon, tint: Palette.viewerControl)
    private let checkButton = UIControl()
    private let check = LibraryCheckView()
    private let drag = UIPanGestureRecognizer()
    private let composer: AttachPreviewComposer?
    /// The caption: the menu's own card, its send beside the text.
    private let card = AgentInputCardView(configuration: AgentInputCardConfiguration(
        placeholder: Strings.Composer.inputPlaceholder,
        primaryAction: .send,
        primaryAccessibilityLabel: Strings.AttachMenu.send,
        compact: true,
        compactLines: 5
    ))
    private let cropButton = PhotoEditorButton.plain("crop.rotate", identifier: "attach-preview-crop", label: Strings.PhotoEditor.crop)
    private let drawButton = PhotoEditorButton.plain("pencil.tip.crop.circle", identifier: "attach-preview-draw", label: Strings.PhotoEditor.draw)
    private lazy var tools = PhotoEditorGroup([cropButton, drawButton])
    /// The keyboard over the view, while the caption has it.
    private var keyboard: CGFloat = 0
    /// Set while the pager is placed for a new size, so its offset moving
    /// doesn't turn the page.
    private var placing = false
    /// In, after its zoom, and not yet going.
    private(set) var shown = false
    private var chromeHidden = false
    /// The speed the last drag let go with, for the way out.
    private var leaving: CGFloat = 0
    private var playing: Task<Void, Never>?

    init(count: Int, start: Int,
         item: @escaping @MainActor (Int) -> AttachLibraryItem?,
         image: @escaping @MainActor (Int, CGSize, @escaping @MainActor (UIImage) -> Void) -> Int?,
         cancel: @escaping @MainActor (Int) -> Void,
         video: (@MainActor (String) async -> URL?)? = nil,
         selectionNumber: @escaping @MainActor (String) -> Int?,
         toggle: @escaping @MainActor (String) -> Bool,
         sourceView: @escaping @MainActor (Int) -> UIView?,
         composer: AttachPreviewComposer? = nil) {
        self.composer = composer
        self.count = max(0, count)
        self.item = item
        self.image = image
        self.cancel = cancel
        self.video = video
        self.selectionNumber = selectionNumber
        self.toggle = toggle
        self.sourceView = sourceView
        index = min(max(0, start), max(0, count - 1))
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalPresentationCapturesStatusBarAppearance = true
        transitioningDelegate = self
    }

    /// Over the library itself: its pictures, and a video read whole to play
    /// (the copy is removed when the preview goes).
    convenience init(library: AttachLibrary, start: Int, selectionNumber: @escaping @MainActor (String) -> Int?, toggle: @escaping @MainActor (String) -> Bool, sourceView: @escaping @MainActor (Int) -> UIView?, composer: AttachPreviewComposer? = nil) {
        let copies = AttachPreviewCopies()
        self.init(count: library.count, start: start,
            item: { [weak library] in library?.item(at: $0) },
            image: { [weak library] index, pixels, deliver in library?.thumbnail(at: index, pixels: pixels, deliver) },
            cancel: { [weak library] in library?.cancelThumbnail($0) },
            video: { [weak library] id in
                guard let pick = await library?.read([id]).first, case .video(let url) = pick.media else { return nil }
                copies.urls.append(url)
                return url
            },
            selectionNumber: selectionNumber, toggle: toggle, sourceView: sourceView, composer: composer)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit {
        playing?.cancel()
    }

    override var prefersStatusBarHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "attach-preview"
        view.backgroundColor = .clear
        ground.backgroundColor = UIColor(Palette.viewerGround)
        view.addSubview(ground)
        pager.delegate = self
        pager.isPagingEnabled = true
        pager.showsHorizontalScrollIndicator = false
        pager.showsVerticalScrollIndicator = false
        pager.contentInsetAdjustmentBehavior = .never
        pager.alwaysBounceVertical = false
        pager.scrollsToTop = false
        view.addSubview(pager)

        view.addSubview(chrome)
        backIcon.layer.shadowColor = UIColor(Palette.attachPreviewShadow).cgColor
        backIcon.layer.shadowOpacity = 1
        backIcon.layer.shadowRadius = 2.5
        backIcon.layer.shadowOffset = .zero
        back.addSubview(backIcon)
        back.accessibilityIdentifier = "attach-preview-back"
        back.accessibilityLabel = Strings.Library.back
        back.addTarget(self, action: #selector(close), for: .touchUpInside)
        chrome.addSubview(back)
        chrome.addSubview(check)
        checkButton.accessibilityIdentifier = "attach-preview-check"
        checkButton.isAccessibilityElement = true
        checkButton.addTarget(self, action: #selector(checkTapped), for: .touchUpInside)
        chrome.addSubview(checkButton)

        drag.addTarget(self, action: #selector(dragged(_:)))
        drag.delegate = self
        drag.maximumNumberOfTouches = 1
        view.addGestureRecognizer(drag)
        // A swipe to the side turns the page only once it's no drag to close.
        pager.panGestureRecognizer.require(toFail: drag)
        if let composer {
            card.overrideUserInterfaceStyle = .dark
            card.delegate = self
            card.textView.accessibilityIdentifier = "attach-preview-caption"
            card.primaryControl.accessibilityIdentifier = "attach-preview-send"
            card.setText(composer.caption(), selection: NSRange(location: (composer.caption() as NSString).length, length: 0), animatesHeight: false)
            chrome.addSubview(card)
            cropButton.addTarget(self, action: #selector(cropTapped), for: .touchUpInside)
            drawButton.addTarget(self, action: #selector(drawTapped), for: .touchUpInside)
            chrome.addSubview(tools)
            NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        }
        showSelection(animated: false)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let layout = AttachPreviewLayout(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets), count: count)
        ground.frame = view.bounds
        chrome.frame = view.bounds
        back.setLayoutFrame(layout.back)
        backIcon.frame = back.bounds
        check.setLayoutFrame(layout.check)
        checkButton.setLayoutFrame(layout.checkButton)
        placeFoot()
        guard pager.bounds.size != layout.pager.pager.size || pager.contentSize != layout.pager.contentSize else { return }
        placing = true
        pager.frame = layout.pager.pager
        pager.contentSize = layout.pager.contentSize
        pager.contentOffset = CGPoint(x: layout.pager.offset(index), y: 0)
        placing = false
        for (number, page) in pages {
            page.frame = layout.pager.page(number)
            page.reset()
        }
        showPages()
    }

    private var pagerLayout: PicturePagerLayout { PicturePagerLayout(size: view.bounds.size, count: count) }

    /// The page in view and its neighbours, made as they come near and let
    /// go as they leave.
    private func showPages() {
        guard count > 0, view.bounds.width > 0 else { return }
        let layout = pagerLayout
        let wanted = Set(max(0, index - 1)...min(count - 1, index + 1))
        for (number, page) in pages where !wanted.contains(number) {
            page.stop()
            page.removeFromSuperview()
            pages[number] = nil
        }
        let scale = view.window?.screen.scale ?? traitCollection.displayScale
        for number in wanted where pages[number] == nil {
            guard let shown = item(number) else { continue }
            let page = AttachPreviewPage(item: shown, index: number)
            page.frame = layout.page(number)
            page.onTap = { [weak self] in self?.toggleChrome() }
            page.onPlay = { [weak self, weak page] in
                guard let self, let page else { return }
                play(page)
            }
            page.panGestureRecognizer.require(toFail: drag)
            // The cell's picture at once, the screen's own as it comes.
            if let placeholder = (sourceView(number) as? AttachPreviewSource)?.previewImage { page.show(placeholder) }
            let pixels = CGSize(width: view.bounds.width * scale, height: view.bounds.height * scale)
            page.request = image(number, pixels) { [weak page] picture in page?.show(picture) }
            let cancel = cancel
            page.onRelease = { token in cancel(token) }
            pager.addSubview(page)
            pages[number] = page
        }
        for (number, page) in pages where number != index { page.stop() }
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView === pager, !placing, view.bounds.width > 0 else { return }
        let next = pagerLayout.index(at: scrollView.contentOffset.x, count: count)
        guard next != index else { return }
        index = next
        showPages()
        showSelection(animated: false)
        if shown { onHide?(item(index)?.id) }
        onFocus?(index)
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        guard scrollView === pager else { return }
        // Turned away from, a page is whole again when it comes back.
        for (number, page) in pages where number != index { page.reset() }
    }

    /// Turns to page `index`, as a swipe would.
    func show(_ index: Int, animated: Bool) {
        guard count > 0 else { return }
        let target = min(max(0, index), count - 1)
        pager.setContentOffset(CGPoint(x: pagerLayout.offset(target), y: 0), animated: animated)
        if !animated { scrollViewDidEndDecelerating(pager) }
    }

    /// Telegram's foot: the editing tools on one capsule in a 49 bar over
    /// the safe area, the caption 10 over it, or 8 over the keyboard.
    private func placeFoot() {
        guard composer != nil else { return }
        let bounds = view.bounds, safe = view.safeAreaInsets
        let bar = PhotoCropScreenLayout.Metrics.toolbar
        let width: CGFloat = 44 * 2 + 10
        tools.frame = CGRect(x: (bounds.width - width) / 2, y: bounds.height - safe.bottom - bar / 2 - 22, width: width, height: 44)
        tools.place([CGRect(x: 0, y: 0, width: 44, height: 44), CGRect(x: 54, y: 0, width: 44, height: 44)])
        let inset = MobileComposerMetrics.mobile.shellInset
        let cardWidth = max(0, bounds.width - safe.left - safe.right - 2 * inset)
        let height = min(card.height(fitting: cardWidth), max(44, (bounds.height - keyboard) / 3))
        let bottom = keyboard > 0 ? bounds.height - keyboard - 8 : bounds.height - safe.bottom - bar - 10
        card.frame = CGRect(x: safe.left + inset, y: bottom - height, width: cardWidth, height: height)
        tools.alpha = keyboard > 0 ? 0 : 1
    }

    @objc private func keyboardChanged(_ note: Notification) {
        guard let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let local = view.convert(frame, from: nil)
        let overlap = card.textView.isFirstResponder ? max(0, view.bounds.maxY - local.minY) : 0
        guard overlap != keyboard else { return }
        keyboard = overlap
        let duration = note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
        UIView.animate(withDuration: duration, delay: 0, options: [.beginFromCurrentState]) {
            self.placeFoot()
            self.card.layoutIfNeeded()
        }
    }

    var currentPage: AttachPreviewPage? { pages[index] }
    var groundAlpha: CGFloat { ground.alpha }
    var picturesOffset: CGFloat { pager.transform.ty }
    var chromeAlpha: CGFloat { chrome.alpha }

    // MARK: Selection

    /// The number circle as the picks are now; call when they change elsewhere.
    func showSelection(animated: Bool) {
        guard let shown = item(index) else { return }
        let number = selectionNumber(shown.id)
        check.set(number, animated: animated)
        checkButton.accessibilityLabel = shown.duration.map { Strings.Library.video(LibraryPickerLayout.duration(seconds: $0), index: number) } ?? Strings.Library.photo(number)
        checkButton.accessibilityTraits = number == nil ? .button : [.button, .selected]
        showTools()
    }

    /// Crop and Draw for a photo, yellow where its edit is applied.
    private func showTools() {
        guard let composer, let shown = item(index) else { return }
        let photo = shown.duration == nil
        tools.alpha = keyboard > 0 ? 0 : photo ? 1 : 0.2
        tools.isUserInteractionEnabled = photo
        let edit = composer.library.edit(shown.id)
        cropButton.applied = edit.map { !$0.crop.isWhole($0.canvas) } ?? false
        drawButton.applied = !(edit?.strokes.isEmpty ?? true)
    }

    var shownNumber: Int? { check.number }

    @objc func checkTapped() {
        guard let shown = item(index) else { return }
        // Past the limit: Telegram's `selectionLimitExceeded`.
        guard toggle(shown.id) else { return Haptics.player.play(.notification(.error)) }
        showSelection(animated: true)
    }

    // MARK: Chrome

    private func toggleChrome() {
        setChrome(hidden: !chromeHidden)
    }

    private func setChrome(hidden: Bool) {
        guard hidden != chromeHidden else { return }
        chromeHidden = hidden
        chrome.isUserInteractionEnabled = !hidden
        UIView.animate(withDuration: AttachPreviewMotion.chrome, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
            self.chrome.alpha = hidden ? 0 : 1
        }
    }

    // MARK: Video

    private func play(_ page: AttachPreviewPage) {
        guard let video else { return }
        if let url = page.url { return page.play(url) }
        page.loading = true
        let id = page.item.id
        playing?.cancel()
        playing = Task { [weak self, weak page] in
            let url = await video(id)
            guard !Task.isCancelled, let self, let page else { return }
            page.loading = false
            guard let url, pages[index] === page else { return }
            page.url = url
            page.play(url)
        }
    }

    // MARK: Closing

    func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
        guard recognizer === drag else { return true }
        if composer != nil, !chromeHidden {
            let point = recognizer.location(in: view)
            if card.frame.contains(point) || tools.frame.contains(point) { return false }
        }
        guard let page = currentPage, !page.isZoomed, !pager.isDragging, !pager.isDecelerating else { return false }
        let velocity = drag.velocity(in: view)
        return abs(velocity.y) > abs(velocity.x)
    }

    @objc private func dragged(_ recognizer: UIPanGestureRecognizer) {
        let distance = recognizer.translation(in: view).y
        switch recognizer.state {
        case .changed: dragChanged(distance)
        case .ended: dragEnded(distance, velocity: recognizer.velocity(in: view).y)
        case .cancelled, .failed: dragEnded(0, velocity: 0)
        default: break
        }
    }

    /// The pictures follow the finger `distance` down; the black fades.
    func dragChanged(_ distance: CGFloat) {
        let dismissal = AttachPreviewDismissal(distance: distance, velocity: 0)
        pager.transform = CGAffineTransform(translationX: 0, y: distance)
        ground.alpha = dismissal.groundAlpha
        if dismissal.chromeHidden { setChrome(hidden: true) }
    }

    /// Let go far or fast enough it closes, else it goes back.
    func dragEnded(_ distance: CGFloat, velocity: CGFloat) {
        let dismissal = AttachPreviewDismissal(distance: distance, velocity: velocity)
        if distance != 0, dismissal.closes {
            leaving = dismissal.velocity
            close()
            return
        }
        let back = Self.motion()
        back.addAnimations {
            self.pager.transform = .identity
            self.ground.alpha = 1
        }
        back.isUserInteractionEnabled = true
        back.startAnimation()
        setChrome(hidden: false)
    }

    @objc func close() {
        guard presentingViewController != nil, !isBeingDismissed else { return }
        dismiss(animated: true)
    }

    // MARK: Editing

    private enum Editor { case crop, draw }

    @objc private func cropTapped() { openEditor(.crop) }
    @objc private func drawTapped() { openEditor(.draw) }

    /// The picture with no edit at the screen's size, then the editor
    /// over the preview with it.
    private func openEditor(_ editor: Editor) {
        guard let composer, let shown = item(index), shown.duration == nil, presentedViewController == nil else { return }
        card.textView.resignFirstResponder()
        let id = shown.id
        let scale = view.window?.screen.scale ?? traitCollection.displayScale
        let pixels = CGSize(width: view.bounds.width * scale, height: view.bounds.height * scale)
        var opened = false
        var token: Int?
        token = composer.library.original(id, index: index, pixels: pixels) { [weak self] image in
            guard let self, !opened else { return }
            // PhotoKit may hand a rough one first; the editor wants the sharp one.
            let longer = max(image.size.width * image.scale, image.size.height * image.scale)
            guard longer >= min(max(pixels.width, pixels.height), 1200) * 0.6 else { return }
            opened = true
            if let token { composer.library.cancelThumbnail(token) }
            present(editor, id: id, picture: image)
        }
    }

    private func present(_ editor: Editor, id: String, picture: UIImage) {
        guard let composer, item(index)?.id == id, presentedViewController == nil, shown else { return }
        let edit = composer.library.edit(id) ?? PhotoEdit(canvas: PhotoEdit.canvas(for: picture))
        let controller: UIViewController
        switch editor {
        case .crop:
            let crop = PhotoCropViewController(picture: picture, edit: edit)
            crop.onDone = { [weak self, weak crop] next in
                var changed = edit
                changed.crop = next
                self?.apply(changed, to: id, was: edit)
                crop?.dismiss(animated: true)
            }
            crop.onCancel = { [weak crop] in crop?.dismiss(animated: true) }
            controller = crop
        case .draw:
            let draw = PhotoDrawViewController(picture: picture, edit: edit)
            draw.onDone = { [weak self, weak draw] strokes in
                var changed = edit
                changed.strokes = strokes
                self?.apply(changed, to: id, was: edit)
                draw?.dismiss(animated: true)
            }
            draw.onCancel = { [weak draw] in draw?.dismiss(animated: true) }
            controller = draw
        }
        present(controller, animated: true)
    }

    /// Kept for picture `id`; changed, the picture is picked (Telegram's
    /// gallery selects an item its editor applied adjustments to).
    private func apply(_ edit: PhotoEdit, to id: String, was before: PhotoEdit) {
        guard let composer else { return }
        composer.library.setEdit(id, edit)
        if edit != before, !edit.isEmpty { composer.edited(id) }
        showTools()
    }

    /// Picture `id` was edited: its page shows it anew.
    func reload(_ id: String) {
        let scale = view.window?.screen.scale ?? traitCollection.displayScale
        let pixels = CGSize(width: view.bounds.width * scale, height: view.bounds.height * scale)
        for (number, page) in pages where page.item.id == id {
            if let request = page.request { cancel(request) }
            page.request = image(number, pixels) { [weak page] picture in page?.show(picture) }
        }
        showTools()
    }

    // MARK: Transitions

    func animationController(forPresented presented: UIViewController, presenting: UIViewController, source: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        AttachPreviewTransition(opening: true)
    }

    func animationController(forDismissed dismissed: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        AttachPreviewTransition(opening: false)
    }

    /// The preview's one motion (`AttachPreviewMotion`), over `duration`.
    private static func motion(_ duration: TimeInterval = AttachPreviewMotion.duration) -> UIViewPropertyAnimator {
        let curve = AttachPreviewMotion.curve
        return UIViewPropertyAnimator(duration: duration, controlPoint1: CGPoint(x: curve.x1, y: curve.y1), controlPoint2: CGPoint(x: curve.x2, y: curve.y2))
    }

    /// Where `index`'s cell is in the preview, if it is on the screen.
    private func cell(_ index: Int) -> (view: UIView, frame: CGRect)? {
        // The cell may be hidden for the preview (`onHide`); it still counts.
        guard let source = sourceView(index), source.window != nil else { return nil }
        let frame = source.convert(source.bounds, to: view)
        guard frame.width > 0, frame.height > 0, frame.intersects(view.bounds) else { return nil }
        return (source, frame)
    }

    /// The clip that flies between the cell and the page: the picture cut
    /// to it as the cell cuts it; a snapshot when there is no picture.
    private func flier(_ zoom: AttachPreviewLayout.Zoom, image: UIImage?, source: UIView) -> (clip: UIView, picture: UIView) {
        let clip = UIView(frame: zoom.cell)
        clip.clipsToBounds = true
        clip.isUserInteractionEnabled = false
        let picture: UIView
        if let image {
            let imageView = UIImageView(image: image)
            imageView.contentMode = .scaleAspectFill
            picture = imageView
            picture.frame = zoom.cellPicture
        } else {
            picture = source.snapshotView(afterScreenUpdates: false) ?? UIView()
            picture.frame = clip.bounds
        }
        clip.addSubview(picture)
        view.addSubview(clip)
        return (clip, picture)
    }

    /// Out of the tapped cell (`animateTransitionInFromView`), or up from
    /// below with none (`simpleTransitionIn`).
    fileprivate func animateIn(_ done: @escaping () -> Void) {
        view.layoutIfNeeded()
        let id = item(index)?.id
        ground.alpha = 0
        chrome.alpha = 0
        view.isUserInteractionEnabled = false
        let finish = { [weak self] in
            guard let self else { return done() }
            shown = true
            view.isUserInteractionEnabled = true
            done()
        }
        let fade = Self.motion()
        fade.addAnimations {
            self.ground.alpha = 1
            self.chrome.alpha = 1
        }
        fade.startAnimation()
        guard let page = currentPage, let source = cell(index) else {
            let leave = AttachPreviewDismissal.leave(velocity: 0, height: view.bounds.height)
            onHide?(id)
            pager.transform = CGAffineTransform(translationX: 0, y: leave.offset)
            let slide = Self.motion(leave.duration)
            slide.addAnimations { self.pager.transform = .identity }
            slide.addCompletion { _ in finish() }
            slide.startAnimation()
            return
        }
        let image = Self.larger((source.view as? AttachPreviewSource)?.previewImage, page.shownImage)
        let shownFrame = page.pictureFrame(in: view, natural: image?.size)
        let zoom = AttachPreviewLayout.Zoom(cell: source.frame, page: shownFrame, natural: image?.size ?? source.frame.size)
        let (clip, picture) = flier(zoom, image: image, source: source.view)
        onHide?(id)
        page.alpha = 0
        let animator = Self.motion()
        animator.addAnimations {
            clip.frame = zoom.page
            picture.frame = image == nil ? CGRect(origin: .zero, size: zoom.page.size) : zoom.pagePicture
        }
        animator.addCompletion { _ in
            page.alpha = 1
            UIView.animate(withDuration: AttachPreviewMotion.pageFadeIn) { clip.alpha = 0 } completion: { _ in clip.removeFromSuperview() }
            finish()
        }
        animator.startAnimation()
    }

    /// Back into the cell of the picture in view (`animateTransitionOutFromView`),
    /// or off the screen the way it was going with that cell not showing
    /// (`simpleTransitionOutWithVelocity`).
    fileprivate func animateOut(_ done: @escaping () -> Void) {
        shown = false
        playing?.cancel()
        for page in pages.values { page.stop() }
        view.isUserInteractionEnabled = false
        let velocity = leaving
        let finish = { [weak self] in
            self?.onHide?(nil)
            done()
            self?.onClose?()
        }
        UIView.animate(withDuration: AttachPreviewMotion.fadeOut) {
            self.chrome.alpha = 0
        }
        guard let page = currentPage, let source = cell(index) else {
            let leave = AttachPreviewDismissal.leave(velocity: velocity, height: view.bounds.height)
            let slide = Self.motion(leave.duration)
            slide.addAnimations {
                self.ground.alpha = 0
                self.pager.transform = CGAffineTransform(translationX: 0, y: leave.offset)
            }
            slide.addCompletion { _ in finish() }
            slide.startAnimation()
            return
        }
        UIView.animate(withDuration: AttachPreviewMotion.fadeOut) { self.ground.alpha = 0 }
        let image = Self.larger(page.shownImage, (source.view as? AttachPreviewSource)?.previewImage)
        let zoom = AttachPreviewLayout.Zoom(cell: source.frame, page: page.pictureFrame(in: view, natural: image?.size), natural: image?.size ?? source.frame.size)
        let (clip, picture) = flier(zoom, image: image, source: source.view)
        clip.frame = zoom.page
        picture.frame = image == nil ? clip.bounds : zoom.pagePicture
        page.alpha = 0
        let animator = Self.motion()
        animator.addAnimations {
            clip.frame = zoom.cell
            picture.frame = image == nil ? CGRect(origin: .zero, size: zoom.cell.size) : zoom.cellPicture
        }
        animator.addCompletion { _ in finish() }
        animator.startAnimation()
    }

    private static func larger(_ a: UIImage?, _ b: UIImage?) -> UIImage? {
        guard let a else { return b }
        guard let b else { return a }
        return a.size.width * a.scale >= b.size.width * b.scale ? a : b
    }
}

extension AttachPreviewViewController: AgentInputCardDelegate {
    func agentInputCardDidChangeText(_ card: AgentInputCardView) {
        composer?.setCaption(card.text)
    }

    func agentInputCardDidChangeFocus(_ card: AgentInputCardView) {
        view.setNeedsLayout()
    }

    func agentInputCardDidInvalidateHeight(_ card: AgentInputCardView) {
        UIView.animate(withDuration: 0.2) {
            self.placeFoot()
            self.card.layoutIfNeeded()
        }
    }

    func agentInputCardDidPressPrimary(_ card: AgentInputCardView) {
        guard let composer, let shown = item(index) else { return }
        card.textView.resignFirstResponder()
        composer.send(shown.id)
    }
}

/// Presents and dismisses the preview with its own zoom.
private final class AttachPreviewTransition: NSObject, UIViewControllerAnimatedTransitioning {
    let opening: Bool

    init(opening: Bool) {
        self.opening = opening
    }

    func transitionDuration(using context: UIViewControllerContextTransitioning?) -> TimeInterval { AttachPreviewMotion.duration }

    func animateTransition(using context: UIViewControllerContextTransitioning) {
        if opening {
            guard let preview = context.viewController(forKey: .to) as? AttachPreviewViewController else { return context.completeTransition(false) }
            preview.view.frame = context.finalFrame(for: preview)
            context.containerView.addSubview(preview.view)
            preview.animateIn { context.completeTransition(!context.transitionWasCancelled) }
        } else {
            guard let preview = context.viewController(forKey: .from) as? AttachPreviewViewController else { return context.completeTransition(false) }
            preview.animateOut {
                preview.view.removeFromSuperview()
                context.completeTransition(!context.transitionWasCancelled)
            }
        }
    }
}

/// Holds what the buttons sit in; touches anywhere else go to the pages.
private final class AttachPreviewChrome: UIView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self ? nil : hit
    }
}

/// Video copies read for playing, removed with the preview.
private final class AttachPreviewCopies {
    var urls: [URL] = []

    deinit {
        for url in urls { try? FileManager.default.removeItem(at: url) }
    }
}

/// One picture of the library, fitted to the page and enlarged as
/// Telegram's are, pinched or double-tapped to zoom
/// (`TGModernGalleryZoomableItemView`); a video shows its first frame with
/// a play button and plays where it is.
final class AttachPreviewPage: UIScrollView, UIScrollViewDelegate {
    let item: AttachLibraryItem
    let index: Int
    private let imageView = UIImageView()
    private let playButton = UIButton(type: .custom)
    private let playIcon = IconView(.ionicons("play"), size: AttachPreviewLayout.Metrics.playIcon, tint: Palette.viewerControl)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var player: AVPlayer?
    private var playerView: AttachPreviewPlayerView?
    var onTap: (() -> Void)?
    var onPlay: (() -> Void)?
    var onRelease: ((Int) -> Void)?
    /// The library's request for its picture.
    var request: Int?
    /// The video, once read.
    var url: URL?
    var loading = false {
        didSet {
            if loading { spinner.startAnimating() } else { spinner.stopAnimating() }
            playIcon.isHidden = loading
        }
    }

    init(item: AttachLibraryItem, index: Int) {
        self.item = item
        self.index = index
        super.init(frame: .zero)
        accessibilityIdentifier = "attach-preview-page:\(index)"
        delegate = self
        minimumZoomScale = 1
        maximumZoomScale = 1
        showsVerticalScrollIndicator = false
        showsHorizontalScrollIndicator = false
        contentInsetAdjustmentBehavior = .never
        scrollsToTop = false
        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        addSubview(imageView)
        if item.duration != nil {
            playButton.backgroundColor = UIColor(Palette.attachPreviewPlay)
            playButton.accessibilityIdentifier = "attach-preview-play"
            playButton.accessibilityLabel = Strings.playVideo
            playButton.addTarget(self, action: #selector(playTapped), for: .touchUpInside)
            playButton.addSubview(playIcon)
            spinner.color = UIColor(Palette.viewerControl)
            spinner.isUserInteractionEnabled = false
            playButton.addSubview(spinner)
            addSubview(playButton)
        }
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(zoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
        tap.require(toFail: doubleTap)
        addGestureRecognizer(tap)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func removeFromSuperview() {
        super.removeFromSuperview()
        if let request { onRelease?(request) }
        request = nil
    }

    var shownImage: UIImage? { imageView.image }
    var isZoomed: Bool { zoomScale > minimumZoomScale + 0.01 }
    var isPlaying: Bool { player?.rate ?? 0 > 0 }
    /// The play button shows (a video, not playing).
    var showsPlay: Bool { item.duration != nil && !playButton.isHidden }

    /// A picture for the page; a sharper one of the same shape replaces it
    /// where it is.
    func show(_ image: UIImage) {
        let natural = imageView.image?.size
        imageView.image = image
        if natural.map({ !Self.sameShape($0, image.size) }) ?? true { reset() }
    }

    private static func sameShape(_ a: CGSize, _ b: CGSize) -> Bool {
        guard a.height > 0, b.height > 0 else { return false }
        return abs(a.width / a.height - b.width / b.height) < 0.01
    }

    /// Whole again, fitted to the page as it is now.
    func reset() {
        if zoomScale != 1 { setZoomScale(1, animated: false) }
        let natural = imageView.image?.size ?? .zero
        let fitted = AttachPreviewLayout.fit(natural, in: bounds.size)
        imageView.frame = fitted
        contentSize = fitted.size
        // Videos play where they are; only photos zoom.
        maximumZoomScale = item.duration == nil ? AttachPreviewLayout.maximumZoom(natural, in: bounds.size) : 1
        setNeedsLayout()
    }

    /// Where the picture shows, in `view`'s coordinates; before it is
    /// known, where one of `natural` would.
    func pictureFrame(in view: UIView, natural: CGSize?) -> CGRect {
        if imageView.image == nil, let natural {
            return convert(AttachPreviewLayout.fit(natural, in: bounds.size), to: view)
        }
        return imageView.convert(imageView.bounds, to: view)
    }

    override var frame: CGRect {
        didSet { if frame.size != oldValue.size { reset() } }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        imageView.frame = AttachPreviewLayout.zoomed(imageView.frame.size, in: bounds.size)
        playerView?.frame = imageView.frame
        guard item.duration != nil else { return }
        playButton.frame = AttachPreviewLayout.play(in: imageView.frame)
        playButton.layer.cornerRadius = playButton.bounds.height / 2
        playIcon.frame = playButton.bounds
        spinner.frame = playButton.bounds
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { item.duration == nil ? imageView : nil }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        setNeedsLayout()
    }

    @objc private func zoom(_ recognizer: UITapGestureRecognizer) {
        guard item.duration == nil else { return }
        if isZoomed {
            setZoomScale(minimumZoomScale, animated: true)
        } else {
            let point = recognizer.location(in: imageView)
            zoom(to: AttachPreviewLayout.zoomRect(at: point, bounds: bounds.size, scale: maximumZoomScale), animated: true)
        }
    }

    @objc private func tapped() {
        // A playing video pauses where it is.
        if isPlaying {
            player?.pause()
            playButton.isHidden = false
            return
        }
        onTap?()
    }

    @objc private func playTapped() { onPlay?() }

    // MARK: Video

    func play(_ url: URL) {
        if player == nil {
            let player = AVPlayer(url: url)
            let view = AttachPreviewPlayerView()
            view.isUserInteractionEnabled = false
            view.playerLayer.player = player
            view.playerLayer.videoGravity = .resizeAspect
            insertSubview(view, aboveSubview: imageView)
            playerView = view
            self.player = player
            NotificationCenter.default.addObserver(self, selector: #selector(playedToEnd), name: AVPlayerItem.didPlayToEndTimeNotification, object: player.currentItem)
            setNeedsLayout()
        }
        playButton.isHidden = true
        player?.play()
    }

    /// AVFoundation says so on a queue of its own.
    @objc nonisolated private func playedToEnd() {
        Task { @MainActor [weak self] in self?.rewind() }
    }

    /// Played to the end: back to the first frame with the play button.
    private func rewind() {
        player?.pause()
        player?.seek(to: .zero)
        playButton.isHidden = false
    }

    /// Stops a video; turned away from, it starts over.
    func stop() {
        guard let player else { return }
        player.pause()
        player.seek(to: .zero)
        playButton.isHidden = false
    }
}

private final class AttachPreviewPlayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}
#endif
