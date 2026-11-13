#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

/// The composer's "+" menu, Telegram's attachment menu ported to UIKit
/// (`AttachmentController`, `AttachmentContainer`, `AttachmentPanel`,
/// `MediaPickerScreen`): a sheet that grows out of the "+" over the dimmed
/// chat and rests a quarter of the way down, drags up to fill the screen
/// and down to go. Its Gallery tab is the library newest first under a
/// glass header, the camera live and two cells tall at the top left,
/// picked in order with numbered circles; the glass tab bar at its foot
/// turns into the caption with send while anything is picked, and the
/// picked count at the top right takes them to the composer instead, to
/// send from there. Its File
/// tab offers Files and the system's photo picker.
///
/// The gestures are Telegram's, number for number (`AttachSheetPan`,
/// `AttachSelectionDrag`, `AttachTabLens`): the sheet and the grid share
/// the finger, a sideways drag over the grid picks, the tab bar's lens
/// follows the finger, a pull that would drop picks asks first.
///
/// The library is asked for the moment the gallery needs it. Limited
/// access shows what was allowed with a note to manage it; without access
/// the gallery explains, with the system's picker (which needs no access)
/// right under the explanation.
///
/// It only says what was chosen: the menu goes first, then `onAction`
/// hears it. On an iPad it is a card over the "+" instead.
@MainActor
final class AttachSheetViewController: UIViewController, UICollectionViewDelegate, UIGestureRecognizerDelegate {
    enum Action: Equatable {
        /// The camera, where the menu can't open its own (no room left).
        case camera
        /// Taken with the menu's camera.
        case photo(CameraPhoto)
        /// The system's photo picker, which needs no access.
        case photos
        case files
        /// Picked in the grid, by the library's ids, in order, sent now
        /// with the caption.
        case send([String], caption: String)
        /// The same, to wait in the composer with the caption as its text,
        /// nothing sent.
        case stage([String], caption: String)
    }

    enum Tab: Int {
        case gallery
        case files
    }

    var onAction: ((Action) -> Void)?
    /// Closed, tapped outside or dragged away with nothing chosen.
    var onGone: (() -> Void)?
    /// The caption as it is typed, for the composer's draft.
    var onCaption: ((String) -> Void)?
    /// The "+" in this view's space, for the iPad's card.
    var source: (() -> CGRect?)?
    /// The "+" itself: the sheet grows out of it and goes back into it
    /// (Telegram's glass style); without it the sheet slides.
    var button: (() -> UIView?)?

    /// The library as the menu shows it: edited pictures, its camera's shots.
    let library: AttachLibrary
    let edits: AttachEditingLibrary
    private let limit: Int
    private let hasCamera: Bool
    private(set) var page: Tab = .gallery
    /// Picked, in order, by the library's ids.
    private(set) var picked: [String] = []
    private(set) var expanded = false
    private(set) var access: AttachLibraryAccess
    /// The sheet's top edge, and how far the whole sheet is pulled below it.
    private(set) var top: CGFloat = 0
    private(set) var drop: CGFloat = 0
    /// The dip a tab switch gives the sheet.
    private var dip: CGFloat = 0
    /// The keyboard over the view, while the caption has it.
    private(set) var keyboard: CGFloat = 0
    private var shown = false
    private(set) var closing = false
    private var asked = false
    private var asking = false
    private(set) var sheet: AttachMenuSheetLayout?
    private var content: AttachMenuContentLayout?
    private var settling: UIViewPropertyAnimator?
    private var dropping: UIViewPropertyAnimator?
    private var morphing = false
    /// The "+" while the sheet stands in for it.
    private weak var hiddenButton: UIView?

    private let dim = UIView()
    /// Telegram's `AttachmentContainer`: the sheet and its panel, whose
    /// bounds drop it below where its top rests.
    private let host = UIView()
    private let shadow = UIView()
    private let clip = UIView()
    private let ground = UIView()
    private let body = UIView()
    /// The page under the header: what fades over the growing glass. The
    /// header's glass controls sit beside it, so no glass is ever under a
    /// fading alpha (it draws wrong there and pops when the alpha reaches 1).
    private let pageFade = UIView()
    /// The morph's glass: it materializes and dematerializes, it never fades.
    private let morphGlass = UIVisualEffectView(effect: nil)
    /// The "+" as it is drawn, so the morph starts and ends on its exact pixels.
    private let morphGlyph = UIImageView()
    private let edge = AttachMenuTopEdge()
    private static func closeEffect() -> UIGlassEffect {
        let effect = UIGlassEffect(style: .regular)
        effect.isInteractive = true
        return effect
    }
    private let closeGlass = UIVisualEffectView(effect: AttachSheetViewController.closeEffect())
    private let closeButton = UIButton(type: .custom)
    /// Close's twin at the other side: its glass, its ink, its weight.
    private let countGlass = UIVisualEffectView(effect: AttachSheetViewController.closeEffect())
    /// The count's touch: the picks go to the composer.
    private let countButton = UIButton(type: .custom)
    private let countIcon = UIImageView(image: UIImage(systemName: "checkmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)))
    private let countLabel = UILabel()
    private let titleLabel = UILabel()
    private var titleDark = false
    private let gallery = UIView()
    private let gridLayout = AttachGridCollectionLayout()
    private(set) lazy var grid = UICollectionView(frame: .zero, collectionViewLayout: gridLayout)
    private(set) lazy var feed = AttachGridFeed(library: library, grid: grid)
    let cameraTile = AttachCameraTile()
    private let note = UIView()
    private let noteText = UILabel()
    private let noteButton = UIButton(type: .custom)
    private let placeholder = AttachMenuPlaceholderView()
    private let files = AttachMenuFilesView()
    let panel = AttachMenuPanel()
    private let pan = UIPanGestureRecognizer()
    let picking = AttachSelectionRecognizer()
    private weak var preview: AttachPreviewViewController?
    private weak var camera: CameraViewController?

    init(limit: Int, caption: String = "", library: AttachLibrary = AttachMenuEnvironment.library(), camera: Bool = AttachMenuEnvironment.camera()) {
        self.limit = limit
        let editing = AttachEditingLibrary(library)
        self.edits = editing
        self.library = editing
        hasCamera = camera
        access = library.access
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        panel.caption = caption
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
        view.addSubview(host)

        shadow.backgroundColor = UIColor(Palette.attachMenuGround)
        shadow.layer.shadowColor = UIColor.black.cgColor
        shadow.layer.shadowOpacity = 0.3
        shadow.layer.shadowRadius = 40
        shadow.layer.shadowOffset = .zero
        shadow.layer.cornerCurve = .continuous
        shadow.isUserInteractionEnabled = false
        host.addSubview(shadow)

        clip.clipsToBounds = true
        clip.layer.cornerCurve = .continuous
        clip.accessibilityIdentifier = "attach-sheet"
        host.addSubview(clip)
        morphGlass.isHidden = true
        morphGlyph.contentMode = .center
        morphGlyph.accessibilityIdentifier = "attach-morph-glyph"
        morphGlass.contentView.addSubview(morphGlyph)
        morphGlass.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        morphGlyph.autoresizingMask = [.flexibleLeftMargin, .flexibleRightMargin, .flexibleTopMargin, .flexibleBottomMargin]
        clip.addSubview(morphGlass)
        ground.backgroundColor = UIColor(Palette.attachMenuGround)
        ground.isUserInteractionEnabled = false
        ground.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        clip.addSubview(ground)
        clip.addSubview(body)

        grid.backgroundColor = .clear
        grid.delegate = self
        grid.alwaysBounceVertical = true
        grid.contentInsetAdjustmentBehavior = .never
        grid.accessibilityIdentifier = "attach-grid"
        cameraTile.addAction(UIAction { [weak self] _ in self?.openCamera() }, for: .touchUpInside)
        grid.addSubview(cameraTile)
        feed.number = { [weak self] id in self?.number(id) }
        feed.onCheck = { [weak self] index in self?.check(index) }
        feed.onOpen = { [weak self] index in self?.open(index) }

        noteText.text = Strings.Library.limited
        noteText.font = UIFontMetrics(forTextStyle: .subheadline).scaledFont(for: .systemFont(ofSize: 15))
        noteText.adjustsFontForContentSizeCategory = true
        noteText.textColor = UIColor(Palette.attachMenuNote)
        noteText.numberOfLines = 0
        var manage = AttributedString(Strings.Library.manage.uppercased())
        manage.font = .systemFont(ofSize: 15, weight: .semibold)
        manage.foregroundColor = UIColor(Palette.attachMenuOnAccent)
        noteButton.setAttributedTitle(NSAttributedString(manage), for: .normal)
        noteButton.backgroundColor = UIColor(Palette.attachMenuAccent)
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
        placeholder.onCamera = { [weak self] in self?.openCamera() }
        gallery.addSubview(placeholder)

        files.isHidden = true
        files.onFiles = { [weak self] in self?.finish(.files) }
        files.onPhotos = { [weak self] in self?.finish(.photos) }

        // Telegram's glass header: close at the top left, the picked count
        // at the top right, the title in the middle; the fade under them
        // once the grid scrolls.
        edge.alpha = 0
        closeButton.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)), for: .normal)
        closeButton.tintColor = UIColor(Palette.attachMenuControl)
        closeButton.accessibilityLabel = Strings.close
        closeButton.accessibilityIdentifier = "attach-close"
        closeButton.addAction(UIAction { [weak self] _ in self?.requestClose() }, for: .touchUpInside)
        closeGlass.cornerConfiguration = .capsule()
        closeGlass.contentView.addSubview(closeButton)
        countGlass.cornerConfiguration = .capsule()
        countIcon.tintColor = UIColor(Palette.attachMenuControl)
        countIcon.contentMode = .center
        countLabel.font = .monospacedDigitSystemFont(ofSize: 17, weight: .semibold)
        countLabel.textColor = UIColor(Palette.attachMenuControl)
        countGlass.contentView.addSubview(countIcon)
        countGlass.contentView.addSubview(countLabel)
        countButton.isAccessibilityElement = true
        countButton.accessibilityIdentifier = "attach-count"
        countButton.accessibilityHint = Strings.AttachMenu.confirmHint
        countButton.addAction(UIAction { [weak self] _ in self?.stagePicked() }, for: .touchUpInside)
        countGlass.contentView.addSubview(countButton)
        countGlass.alpha = 0
        countGlass.transform = CGAffineTransform(scaleX: 0.01, y: 0.01)
        titleLabel.font = .monospacedDigitSystemFont(ofSize: 17, weight: .semibold)
        titleLabel.textColor = UIColor(Palette.attachMenuTitle)
        titleLabel.textAlignment = .center
        titleLabel.accessibilityTraits = .header
        titleLabel.accessibilityIdentifier = "attach-title"

        pageFade.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        for view in [gallery, files, edge] as [UIView] { pageFade.addSubview(view) }
        for view in [pageFade, closeGlass, countGlass, titleLabel] as [UIView] { body.addSubview(view) }

        panel.setTabs([
            (Strings.AttachMenu.gallery, AttachMenuPanel.glyph("photo.fill.on.rectangle.fill"), "attach-tab-gallery"),
            (Strings.AttachMenu.files, AttachMenuPanel.glyph("doc.fill"), "attach-tab-files"),
        ])
        panel.onTab = { [weak self] index in self?.switchTo(Tab(rawValue: index) ?? .gallery) }
        panel.onSend = { [weak self] in self?.sendPicked() }
        panel.onCaption = { [weak self] text in self?.onCaption?(text) }
        panel.onFocus = { [weak self] focused in self?.captionFocused(focused) }
        panel.onResize = { [weak self] in self?.view.setNeedsLayout() }
        edits.onEdited = { [weak self] id in self?.edited(id) }
        host.addSubview(panel)

        pan.addTarget(self, action: #selector(panned(_:)))
        pan.delegate = self
        host.addGestureRecognizer(pan)
        picking.delegate = self
        picking.sheet = self
        grid.addGestureRecognizer(picking)

        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self, UITraitHorizontalSizeClass.self, UITraitVerticalSizeClass.self]) { (self: Self, _) in
            self.view.setNeedsLayout()
        }
        library.onChange = { [weak self] in self?.feed.changed() }
        feed.onApplied = { [weak self] change in self?.libraryApplied(change) }
        showTab()
        showAccess(animated: false)
        updateCount(animated: false)
        if access.reads { library.load { [weak self] in self?.loaded() } }
    }

    // The way in starts once the sheet is measured in its window: here, or
    // at the first layout after (a presentation without animation can
    // reach here before its view has ever been laid out).
    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        view.setNeedsLayout()
        view.layoutIfNeeded()
        animateIn()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        askIfNeeded()
    }

    override func accessibilityPerformEscape() -> Bool {
        requestClose()
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
            if answer.reads { library.load { [weak self] in self?.loaded() } }
        }
    }

    private func loaded() {
        access = library.access
        if feed.loaded {
            feed.changed()
        } else {
            feed.load()
        }
        showAccess(animated: false)
        view.setNeedsLayout()
    }

    /// A change landed in the grid: picks the library no longer shows go.
    private func libraryApplied(_ change: AttachLibraryChange) {
        let before = access
        access = library.access
        switch change {
        case .none, .update(removed: [], _, _, _):
            break
        default:
            let kept = picked.filter(library.contains)
            if kept != picked {
                picked = kept
                feed.refreshNumbers(animating: nil)
                updateCount(animated: true)
            }
        }
        if before != access { showAccess(animated: true) }
        view.setNeedsLayout()
    }

    /// The grid, or (without access) the explanation; the limited note.
    private func showAccess(animated: Bool) {
        let denied = access == .denied
        let wasHidden = placeholder.isHidden
        grid.isHidden = denied
        placeholder.isHidden = !denied
        note.isHidden = access != .limited
        if denied, wasHidden, animated {
            placeholder.alpha = 0
            UIView.animate(withDuration: 0.3) { self.placeholder.alpha = 1 }
        }
        updateEdge(animated: false)
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
        if !shown, view.window != nil { return animateIn() }
        guard !morphing else { return }
        place()
        layoutBody()
    }

    /// Where the sheet is: cheap enough for every frame of a drag.
    private func place() {
        placeSheet()
        placeDrop()
    }

    /// The sheet's top: its clip, scaled 5 in from the sides at rest.
    private func placeSheet() {
        guard let sheet else { return }
        let placement = sheet.placement(top: top)
        clip.transform = .identity
        clip.bounds = CGRect(origin: .zero, size: placement.clip.size)
        clip.center = CGPoint(x: placement.clip.midX, y: placement.clip.midY)
        clip.transform = CGAffineTransform(scaleX: placement.scale, y: placement.scale)
        clip.cornerConfiguration = corners(sheet)
        ground.frame = clip.bounds
        morphGlass.frame = clip.bounds
        morphGlyph.center = CGPoint(x: morphGlass.bounds.midX, y: morphGlass.bounds.midY)
        body.frame = placement.content
        pageFade.frame = body.bounds
        shadow.isHidden = sheet.style != .card
        shadow.frame = placement.clip
        shadow.layer.cornerRadius = sheet.cornerRadius
        placePanel()
    }

    /// Telegram's container offset: the whole sheet, its panel too, below
    /// where its top rests.
    private func placeDrop() {
        host.frame = view.bounds
        host.bounds.origin.y = -(drop + dip)
    }

    /// The panel at the sheet's foot, or on the keyboard while the caption has it.
    private func placePanel() {
        guard let sheet else { return }
        let placement = sheet.placement(top: top)
        let bottom = keyboard > 0 ? view.bounds.height - keyboard : placement.barBottom
        let maxHeight = max(AttachMenuMetrics.captionHeight, floor((view.bounds.height - keyboard - sheet.expandedTop) / 3))
        panel.place(minX: placement.clip.minX, width: placement.clip.width, bottom: bottom, sides: sheet.sides, pixel: view.hairline, maxHeight: maxHeight)
    }

    /// The top corners 38; the bottom ones the screen's, less 2, when the
    /// sheet stands on the screen's foot.
    private func corners(_ sheet: AttachMenuSheetLayout) -> UICornerConfiguration {
        switch sheet.style {
        case .card: return .uniformCorners(radius: .fixed(sheet.cornerRadius))
        case .fullScreen: return .uniformCorners(radius: .fixed(0))
        case .sheet:
            let screen: CGFloat = view.safeAreaInsets.bottom > 0 ? 55 : 0
            return .uniformEdges(topRadius: .fixed(sheet.cornerRadius), bottomRadius: .fixed(AttachMenuMotion.Morph.bottomRadius(screen: screen)))
        }
    }

    /// The header and the page, for the sheet's content size and how much
    /// of it is below the screen.
    private func layoutBody() {
        guard let sheet else { return }
        let placement = sheet.placement(top: top)
        let showsNote = access == .limited
        let layout = AttachMenuContentLayout(.init(
            width: placement.content.width, height: placement.content.height, sides: sheet.sides,
            wide: sheet.style == .fullScreen, pixel: view.hairline,
            count: access.reads ? feed.count : 0, camera: hasCamera && access != .denied,
            note: showsNote ? noteText.measurable : nil,
            noteButton: showsNote ? noteButton.titleLabel?.intrinsicContentSize : nil,
            hidden: placement.hidden
        ))
        content = layout
        gallery.frame = layout.gridFrame
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
        let inset = UIEdgeInsets(top: layout.topInset, left: 0, bottom: gridBottomInset(layout), right: 0)
        if grid.contentInset != inset {
            let atTop = grid.contentOffset.y <= -grid.adjustedContentInset.top + AttachSheetPan.topSlop
            grid.contentInset = inset
            grid.verticalScrollIndicatorInsets = inset
            if atTop { grid.contentOffset.y = -inset.top }
        }
        placeholder.frame = layout.page
        placeholder.place(visibleHeight: layout.visibleHeight, bottomInset: layout.bottomInset, upright: sheet.style != .fullScreen)
        files.place(sides: sheet.sides, bottomInset: layout.bottomInset, pixel: view.hairline)
        layoutHeader()
        feed.scrolled()
    }

    /// Room under the grid's last row: the bar's, or what the caption and
    /// the keyboard cover once they stand higher, so every picture can be
    /// scrolled clear of them.
    private func gridBottomInset(_ layout: AttachMenuContentLayout) -> CGFloat {
        guard panel.picking, gallery.bounds.height > 0 else { return layout.bottomInset }
        let caption = gallery.convert(panel.frame, from: host)
        return max(layout.bottomInset, gallery.bounds.height - caption.minY + AttachMenuMetrics.captionFocusedBottom)
    }

    private func layoutHeader() {
        guard let sheet else { return }
        let unbounded = CGSize(width: CGFloat.greatestFiniteMagnitude, height: 44)
        let header = AttachMenuHeaderLayout(width: body.bounds.width, sides: sheet.sides, title: titleLabel.sizeThatFits(unbounded), arrow: false, countText: countLabel.sizeThatFits(unbounded), pixel: view.hairline)
        closeGlass.frame = header.close
        closeButton.frame = closeGlass.bounds
        countGlass.bounds = CGRect(origin: .zero, size: header.count.size)
        countGlass.center = CGPoint(x: header.count.midX, y: header.count.midY)
        countIcon.frame = header.countIcon
        countLabel.frame = header.countLabel
        countButton.frame = countGlass.bounds
        titleLabel.setLayoutFrame(header.title)
        edge.frame = header.edge
    }

    /// The fade under the header once the grid scrolls 5, the title white from 30.
    private func updateEdge(animated: Bool) {
        let scrolled = page == .gallery && !grid.isHidden ? grid.contentOffset.y + grid.adjustedContentInset.top : 0
        let shows = scrolled >= AttachMenuMetrics.topEdgeFrom
        let dark = scrolled >= AttachMenuMetrics.darkTitleFrom
        if (edge.alpha > 0) != shows {
            let apply = { self.edge.alpha = shows ? 1 : 0 }
            animated ? UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: apply) : apply()
        }
        if dark != titleDark {
            titleDark = dark
            let apply = { self.titleLabel.textColor = dark ? .white : UIColor(Palette.attachMenuTitle) }
            animated ? UIView.transition(with: titleLabel, duration: 0.2, options: [.transitionCrossDissolve, .allowUserInteraction], animations: apply) : apply()
        }
    }

    /// The picked count at the top right (`SelectedButtonNode`): it grows from
    /// nothing with the first pick and shrinks away with the last; the
    /// panel turns into the caption with it.
    private func updateCount(animated: Bool) {
        let count = picked.count
        if count > 0 {
            countLabel.text = "\(count)"
            countButton.accessibilityLabel = Strings.AttachMenu.picked(count)
        }
        layoutHeader()
        panel.setPicking(count > 0, animated: animated && shown)
        let visible = count > 0
        // Gone at once with the last pick, while the glass shrinks away.
        countButton.isHidden = !visible
        let apply = {
            self.countGlass.alpha = visible ? 1 : 0
            self.countGlass.transform = visible ? .identity : CGAffineTransform(scaleX: 0.01, y: 0.01)
        }
        if animated, shown {
            UIView.animate(withDuration: 0.4, delay: 0, usingSpringWithDamping: 0.78, initialSpringVelocity: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: apply)
        } else {
            apply()
        }
        view.setNeedsLayout()
    }

    // MARK: Motion

    /// How the menu goes.
    private enum Leaving {
        /// Back into the "+" (glass), or down past the screen.
        case closed
        /// Dragged away at this speed.
        case dragged(CGFloat)
    }

    /// Telegram's in: out of the "+" on glass where there is one, else up
    /// from below the screen over 0.4 s; the dim fades in over 0.3, linear;
    /// an iPad's card the same, its dim a tenth as dark.
    private func animateIn() {
        guard !shown, let sheet, view.window != nil, view.bounds.width > 0 else { return }
        shown = true
        expanded = !sheet.canCollapse
        top = sheet.top(expanded: expanded)
        drop = 0
        place()
        layoutBody()
        dim.alpha = 0
        let dimTarget = sheet.style == .card ? AttachMenuMotion.cardDimShare : 1
        UIView.animate(withDuration: AttachMenuMotion.dimDuration, delay: 0, options: [.curveLinear, .allowUserInteraction]) {
            self.dim.alpha = dimTarget
        }
        if sheet.style == .sheet, let button = button?(), button.window === view.window, !AttachMenuEnvironment.reduceMotion() {
            morphIn(from: button)
            return
        }
        drop = view.bounds.height
        placeDrop()
        let animator = UIViewPropertyAnimator(duration: AttachMenuMotion.openDuration, timingParameters: AttachMenuSprings.openCurve())
        animator.addAnimations {
            self.drop = 0
            self.placeDrop()
        }
        animator.isUserInteractionEnabled = true
        animator.startAnimation()
    }

    /// `AttachmentController.animateIn`, glass: the sheet's clip grows out
    /// of the "+" circle, its centre on one spring and its size on another,
    /// its corners from round to the sheet's; the page fades in over the
    /// growing glass as the "+" on it fades.
    private func morphIn(from button: UIView) {
        guard let sheet else { return }
        typealias M = AttachMenuMotion.Morph
        let source = button.convert(button.bounds, to: host)
        let target = (center: clip.center, bounds: clip.bounds, transform: clip.transform)
        morphing = true
        // One frame: the "+" goes as its exact picture takes its place.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        take(button)
        clip.transform = .identity
        clip.bounds = CGRect(origin: .zero, size: source.size)
        clip.center = CGPoint(x: source.midX, y: source.midY)
        clip.cornerConfiguration = .uniformCorners(radius: .fixed(source.height / 2))
        morphGlass.isHidden = false
        morphGlass.frame = clip.bounds
        morphGlass.effect = nil
        morphGlyph.alpha = 1
        ground.alpha = 0
        setContent(shown: false)
        CATransaction.commit()
        // The motion starts once that frame is on screen: the sheet's first
        // commit (its grid, its glass) is the heaviest, and a spring started
        // before it would show its first frame already far along.
        AttachMenuFrame.next { [weak self] in
            guard let self, !closing else { return }
            let position = UIViewPropertyAnimator(duration: M.positionDuration, timingParameters: AttachMenuSprings.custom(damping: M.positionDamping, duration: M.positionDuration, velocity: M.positionVelocity))
            position.addAnimations { self.clip.center = target.center }
            let size = UIViewPropertyAnimator(duration: M.scaleDuration, timingParameters: AttachMenuSprings.custom(damping: M.scaleDamping, duration: M.scaleDuration, velocity: 0))
            size.addAnimations {
                self.clip.bounds = target.bounds
                self.clip.transform = target.transform
            }
            size.addCompletion { [weak self] _ in
                guard let self, !closing else { return }
                morphing = false
                // Under the opaque ground by now: going makes no difference on screen.
                morphGlass.effect = nil
                morphGlass.isHidden = true
                view.setNeedsLayout()
            }
            for animator in [position, size] {
                animator.isUserInteractionEnabled = true
                animator.startAnimation()
            }
            UIView.animate(withDuration: M.cornersDuration, delay: 0, options: [.curveEaseInOut, .allowUserInteraction]) {
                self.clip.cornerConfiguration = self.corners(sheet)
            }
            UIView.animate(withDuration: M.contentFadeIn, delay: 0, options: [.curveEaseInOut, .allowUserInteraction]) {
                self.morphGlass.effect = UIGlassEffect(style: .regular)
                self.ground.alpha = 1
                self.setContent(shown: true)
            }
            UIView.animate(withDuration: M.glyphFade, delay: 0, options: [.curveEaseInOut, .allowUserInteraction]) {
                self.morphGlyph.alpha = 0
            }
        }
    }

    /// Closes as Telegram does: with picks, asks first (`requestDismiss`).
    func requestClose() {
        guard !closing else { return }
        guard !picked.isEmpty else { return close() }
        let alert = UIAlertController(title: nil, message: Strings.AttachMenu.cancelSelection, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.AttachMenu.cancelSelectionNo, style: .cancel))
        alert.addAction(UIAlertAction(title: Strings.AttachMenu.cancelSelectionYes, style: .default) { [weak self] _ in self?.close() })
        present(alert, animated: true)
    }

    func close() {
        let onGone = onGone
        leave(.closed) { onGone?() }
    }

    /// The menu goes, then the choice is heard over what it covered.
    private func finish(_ action: Action) {
        let onAction = onAction
        leave(.closed) { onAction?(action) }
    }

    /// The full camera over the menu, grown out of the tile and taking its
    /// running camera; closed, it goes back into the tile. Each shot lands
    /// at the grid's start, picked; the first opens in the preview with
    /// the caption and send, and back from there the camera shoots on.
    private func openCamera() {
        guard limit > 0 else { return finish(.camera) }
        guard presentedViewController == nil, !closing else { return }
        let fromTile = page == .gallery && !cameraTile.isHidden && cameraTile.window != nil
        let camera = CameraViewController(camera: cameraTile.lend())
        camera.tile = { [weak self] in
            guard let self, fromTile, cameraTile.window != nil else { return nil }
            return cameraTile.convert(cameraTile.bounds, to: nil)
        }
        camera.onShot = { [weak self] photo in self?.shot(photo) }
        camera.onOpenShot = { [weak self] index in self?.openShots(at: index) }
        camera.onFinish = { [weak self, weak camera] _ in
            guard let self else { return }
            cameraTile.takeBack()
            camera?.dismiss(animated: false)
        }
        self.camera = camera
        present(camera, animated: false)
    }

    /// A shot in: picked, and the first one opened.
    private func shot(_ photo: CameraPhoto) {
        edits.add(shot: photo) { [weak self] id in
            guard let self, let id else { return }
            setPicked(id, true)
            showShots()
            if edits.shotsTaken.count == 1 { openShots(at: 0) }
        }
    }

    private func showShots() {
        camera?.showShots(edits.shotsTaken.compactMap { edits.shotPicture($0) })
    }

    /// The camera's shots in the preview, over the camera (Telegram's
    /// result gallery): back goes back to shooting.
    private func openShots(at start: Int) {
        guard let camera, camera.presentedViewController == nil, !closing else { return }
        let ids = edits.shotsTaken
        guard ids.indices.contains(start) else { return }
        let preview = AttachPreviewViewController(
            count: ids.count, start: start,
            item: { ids.indices.contains($0) ? AttachLibraryItem(id: ids[$0], duration: nil) : nil },
            image: { [weak self] index, _, deliver in
                if ids.indices.contains(index), let picture = self?.edits.shotPicture(ids[index]) { deliver(picture) }
                return nil
            },
            cancel: { _ in },
            selectionNumber: { [weak self] id in self?.number(id) },
            toggle: { [weak self] id in self?.toggle(id) ?? false },
            sourceView: { [weak camera] index in camera?.shotView(index) },
            composer: previewComposer()
        )
        self.preview = preview
        camera.present(preview, animated: true)
    }

    /// The preview's foot speaking for the menu: its caption, its send,
    /// its picks.
    private func previewComposer() -> AttachPreviewComposer {
        AttachPreviewComposer(
            library: edits,
            caption: { [weak self] in self?.panel.caption ?? "" },
            setCaption: { [weak self] text in
                self?.panel.caption = text
                self?.onCaption?(text)
            },
            send: { [weak self] id in self?.sendFromPreview(id) },
            edited: { [weak self] id in self?.setPicked(id, true) }
        )
    }

    /// Send in the preview: the picks, or the picture in view with none;
    /// what is over the menu goes at once, then the menu as it does.
    private func sendFromPreview(_ id: String) {
        guard !closing else { return }
        if picked.isEmpty, !setPicked(id, true) { return }
        let fromCamera = camera != nil
        dismiss(animated: false) { [weak self] in
            guard let self else { return }
            if fromCamera { cameraTile.takeBack() }
            sendPicked()
        }
    }

    /// An edit came or went: the picture shows anew wherever it is.
    private func edited(_ id: String) {
        feed.redraw(id)
        preview?.reload(id)
        if id.hasPrefix("shot:") { showShots() }
    }

    /// Telegram's out: back into the "+" on glass, else down past the
    /// screen in 0.25 s with the dim; dragged away, on a spring with the
    /// finger's speed; an iPad's card fades over 0.3.
    private func leave(_ how: Leaving, completion: @escaping () -> Void) {
        guard !closing else { return }
        closing = true
        settling?.stopAnimation(true)
        settling = nil
        dropping?.stopAnimation(true)
        dropping = nil
        view.endEditing(true)
        view.isUserInteractionEnabled = false
        let gone = { [weak self] in
            self?.hiddenButton?.alpha = 1
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
            self.dim.alpha = 0
        }
        let glassButton = sheet.style == .sheet && !AttachMenuEnvironment.reduceMotion() ? (hiddenButton ?? button?()).flatMap { $0.window === view.window ? $0 : nil } : nil
        switch how {
        case let .dragged(velocity):
            // Glass: from where the finger left it, into the "+", carrying
            // the finger's speed (`animateOut` after `interactivelyDismissed`).
            if let glassButton {
                morphOut(into: glassButton, velocity: velocity, completion: gone)
                return
            }
            // Else `interactivelyDismissed`: on down with damping 180, the
            // finger's speed over the screen left under the sheet.
            let distance = max(1, view.bounds.height - (top + drop))
            let animator = UIViewPropertyAnimator(duration: AttachMenuMotion.settleDuration, timingParameters: AttachMenuSprings.custom(damping: AttachMenuMotion.dismissDamping, duration: AttachMenuMotion.settleDuration, velocity: max(0, velocity) / distance))
            drop = view.bounds.height - top
            animator.addAnimations { self.placeDrop() }
            animator.addCompletion { _ in gone() }
            animator.startAnimation()
        case .closed:
            if let glassButton {
                morphOut(into: glassButton, velocity: 0, completion: gone)
                return
            }
            UIView.animate(withDuration: AttachMenuMotion.closeDuration, delay: 0, options: [.curveEaseInOut, .beginFromCurrentState]) {
                self.drop = self.view.bounds.height
                self.placeDrop()
            } completion: { _ in gone() }
        }
    }

    /// `AttachmentController.animateOut`, glass: the clip shrinks back into
    /// the "+" as the page fades off its glass and the "+" comes back on it.
    /// `velocity` is a drag's, down positive.
    private func morphOut(into button: UIView, velocity: CGFloat, completion: @escaping () -> Void) {
        typealias M = AttachMenuMotion.Morph
        let target = button.convert(button.bounds, to: host)
        morphing = true
        take(button)
        morphGlass.isHidden = false
        // Under the opaque ground still: it shows as the page fades off it.
        morphGlass.effect = UIGlassEffect(style: .regular)
        morphGlyph.alpha = 0
        // The button comes back only once the clip is on it, in one frame.
        var pending = 3
        let landed = { [weak self] in
            pending -= 1
            guard pending == 0, let self else { return }
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            button.alpha = 1
            view.isHidden = true
            CATransaction.commit()
            completion()
        }
        let center = CGPoint(x: target.midX, y: target.midY)
        let distance = center.y - clip.center.y
        let relative = abs(distance) > 1 ? max(0, velocity / distance) : 0
        let position = UIViewPropertyAnimator(duration: M.positionDuration, timingParameters: AttachMenuSprings.custom(damping: M.positionDamping, duration: M.positionDuration, velocity: relative))
        position.addAnimations { self.clip.center = center }
        let size = UIViewPropertyAnimator(duration: M.outScaleDuration, timingParameters: AttachMenuSprings.custom(damping: M.outDamping, duration: M.outScaleDuration, velocity: 0))
        size.addAnimations {
            self.clip.bounds = CGRect(origin: .zero, size: target.size)
            self.clip.transform = .identity
        }
        for animator in [position, size] {
            animator.addCompletion { _ in landed() }
            animator.startAnimation()
        }
        UIView.animate(withDuration: M.cornersDuration, delay: 0, options: [.curveEaseInOut]) {
            self.clip.cornerConfiguration = .uniformCorners(radius: .fixed(target.height / 2))
        }
        UIView.animate(withDuration: M.contentFadeOut, delay: 0, options: [.curveEaseInOut]) {
            self.ground.alpha = 0
            self.setContent(shown: false)
        }
        UIView.animate(withDuration: M.outGlyphFade, delay: 0, options: [.curveEaseInOut]) {
            self.morphGlyph.alpha = 1
        }
        UIView.animate(withDuration: M.glassFade, delay: M.glassFadeDelay, options: [.curveEaseInOut]) {
            self.morphGlass.effect = nil
        } completion: { _ in landed() }
    }

    /// The "+" taken over by the morph: drawn as it is at rest into the
    /// morph's glyph, then hidden. Its press's spring is stopped first, or
    /// it would bring the button back over the morph a moment later.
    private func take(_ button: UIView) {
        if let control = button as? UIControl, control.isHighlighted { control.isHighlighted = false }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        button.layer.removeAllAnimations()
        button.transform = .identity
        button.alpha = 1
        let format = UIGraphicsImageRendererFormat(for: button.traitCollection)
        morphGlyph.image = UIGraphicsImageRenderer(bounds: button.bounds, format: format).image { context in
            button.layer.render(in: context.cgContext)
        }
        morphGlyph.bounds = CGRect(origin: .zero, size: button.bounds.size)
        morphGlyph.center = CGPoint(x: morphGlass.bounds.midX, y: morphGlass.bounds.midY)
        button.alpha = 0
        CATransaction.commit()
        hiddenButton = button
    }

    /// The page and the panel over the morph: what is drawn fades, the
    /// glass materializes. Inside an animation, animates.
    private func setContent(shown: Bool) {
        pageFade.alpha = shown ? 1 : 0
        titleLabel.alpha = shown ? 1 : 0
        for (glass, effect) in [(closeGlass, Self.closeEffect()), (countGlass, Self.closeEffect())] {
            glass.effect = shown ? effect : nil
            glass.contentView.alpha = shown ? 1 : 0
        }
        panel.setShown(shown)
    }

    @objc private func dimTapped() { requestClose() }

    /// Pulled up to its full height, or back to rest, on Telegram's spring:
    /// what a drag that far does, for VoiceOver's scroll and for tests.
    func setExpanded(_ value: Bool) {
        guard let sheet, sheet.style == .sheet, value != expanded, value || sheet.canCollapse, !closing else { return }
        expanded = value
        settle(to: sheet.top(expanded: value), springVelocity: 0)
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
        var pan: AttachSheetPan
        weak var scroll: UIScrollView?
    }

    private var drag: Drag?

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === pan {
            // Telegram's panel isn't in the container the drag is on, and
            // the drag stops while the keyboard is up.
            guard sheet?.style != .card, !closing, keyboard == 0, preview == nil else { return false }
            return !panel.frame.contains(pan.location(in: host))
        }
        return true
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === pan { return other is UIPanGestureRecognizer || other is UILongPressGestureRecognizer }
        if gestureRecognizer === picking { return other is UIPanGestureRecognizer }
        return false
    }

    private func scrollView(at point: CGPoint) -> UIScrollView? {
        var view = self.view.hitTest(point, with: nil)
        while let current = view, current !== clip {
            if let scroll = current as? UIScrollView, !(scroll is UITextView) { return scroll }
            view = current.superview
        }
        return nil
    }

    private func scrolled(_ scroll: UIScrollView?) -> CGFloat? {
        scroll.map { $0.contentOffset.y + $0.adjustedContentInset.top }
    }

    private func pin(_ scroll: UIScrollView) {
        scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: -scroll.adjustedContentInset.top), animated: false)
    }

    @objc func panned(_ recognizer: UIPanGestureRecognizer) {
        guard let sheet else { return }
        switch recognizer.state {
        case .began:
            settling?.stopAnimation(true)
            settling = nil
            dropping?.stopAnimation(true)
            dropping = nil
            drag = Drag(pan: AttachSheetPan(expanded: expanded, fullSize: !sheet.canCollapse, edge: sheet.travel), scroll: scrollView(at: recognizer.location(in: view)))
        case .changed:
            guard var current = drag else { return }
            let step = current.pan.changed(translation: recognizer.translation(in: view).y, scrolled: scrolled(current.scroll), guarded: !picked.isEmpty)
            drag = current
            if let scroll = current.scroll {
                if step.stopBounce { scroll.bounces = false }
                if step.pin { pin(scroll) }
                if step.resetScrollTranslation { scroll.panGestureRecognizer.setTranslation(.zero, in: scroll) }
            }
            if step.resetTranslation { recognizer.setTranslation(.zero, in: view) }
            if step.ask {
                // `shouldCancelPanGesture`: the pull stops and asks.
                drag = nil
                current.scroll?.bounces = true
                recognizer.isEnabled = false
                recognizer.isEnabled = true
                expanded = current.pan.expanded
                settle(to: sheet.top(expanded: expanded), springVelocity: nil)
                requestClose()
                return
            }
            top = sheet.expandedTop + step.inset
            drop = step.drop
            place()
        case .ended, .cancelled, .failed:
            guard let current = drag else { return }
            drag = nil
            current.scroll?.bounces = true
            let velocity = recognizer.state == .ended ? recognizer.velocity(in: view).y : 0
            let end = current.pan.ended(translation: current.pan.offset, velocity: velocity, scrolled: scrolled(current.scroll), guarded: !picked.isEmpty)
            switch end.outcome {
            case let .dismiss(velocity):
                let onGone = onGone
                leave(.dragged(velocity)) { onGone?() }
            case let .settle(to, springVelocity):
                if end.pin, let scroll = current.scroll { pin(scroll) }
                expanded = to
                settle(to: sheet.top(expanded: to), springVelocity: springVelocity)
            }
        default:
            break
        }
    }

    /// To `target` on Telegram's spring with this relative velocity, or
    /// with nil over 0.3 s ease in-out; any drop goes back over 0.3 s ease
    /// in-out beside it.
    private func settle(to target: CGFloat, springVelocity: CGFloat?, duration: TimeInterval? = nil) {
        settling?.stopAnimation(true)
        let animator: UIViewPropertyAnimator
        if let duration {
            animator = UIViewPropertyAnimator(duration: duration, timingParameters: AttachMenuSprings.openCurve())
        } else if let springVelocity {
            animator = UIViewPropertyAnimator(duration: AttachMenuMotion.settleDuration, timingParameters: AttachMenuSprings.settle(initialVelocity: springVelocity))
        } else {
            animator = UIViewPropertyAnimator(duration: AttachMenuMotion.returnDuration, curve: .easeInOut)
        }
        top = target
        animator.addAnimations {
            self.placeSheet()
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
        guard drop != 0 else { return }
        drop = 0
        let back = UIViewPropertyAnimator(duration: AttachMenuMotion.dropReturnDuration, curve: .easeInOut) { self.placeDrop() }
        back.addCompletion { [weak self] _ in
            guard let self, dropping === back else { return }
            dropping = nil
        }
        back.isUserInteractionEnabled = true
        dropping = back
        back.startAnimation()
    }

    // MARK: Caption

    /// `beganTextEditing`: the caption expands the sheet over 0.5 s.
    private func captionFocused(_ focused: Bool) {
        guard focused, let sheet, !expanded, sheet.canCollapse, !closing else { return }
        expanded = true
        settle(to: sheet.expandedTop, springVelocity: nil, duration: AttachMenuMotion.captionExpandDuration)
    }

    /// The panel rides the keyboard, with its own curve.
    @objc private func keyboardChanged(_ note: Notification) {
        guard let info = note.userInfo, let end = (info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue, let window = view.window else { return }
        let frame = view.convert(window.convert(end, from: window.screen.coordinateSpace), from: window)
        let hiding = note.name == UIResponder.keyboardWillHideNotification
        let overlap = hiding || !panel.field.isFirstResponder ? 0 : max(0, view.bounds.maxY - frame.minY)
        guard overlap != keyboard else { return }
        keyboard = overlap
        let duration = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25
        let curve = (info[UIResponder.keyboardAnimationCurveUserInfoKey] as? Int).flatMap(UIView.AnimationCurve.init(rawValue:)) ?? .easeInOut
        let animator = UIViewPropertyAnimator(duration: duration, curve: curve) {
            self.placePanel()
            self.layoutBody()
        }
        animator.isUserInteractionEnabled = true
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
        panel.select(next.rawValue, animated: true)
        view.setNeedsLayout()
        view.layoutIfNeeded()
        guard sheet?.style == .sheet else { return }
        UIView.animate(withDuration: AttachMenuMotion.switchDipDuration, delay: 0, options: [.curveEaseInOut, .allowUserInteraction]) {
            self.dip = AttachMenuMotion.switchDip
            self.placeDrop()
        } completion: { _ in
            let back = UIViewPropertyAnimator(duration: AttachMenuMotion.switchReturnDuration, timingParameters: AttachMenuSprings.dipReturn())
            back.addAnimations {
                self.dip = 0
                self.placeDrop()
            }
            back.isUserInteractionEnabled = true
            back.startAnimation()
        }
    }

    private func showTab() {
        gallery.isHidden = page != .gallery
        files.isHidden = page != .files
        titleLabel.text = page == .files ? Strings.AttachMenu.files : Strings.AttachMenu.recents
        cameraTile.isHidden = page != .gallery || content?.grid.camera == nil
        updateEdge(animated: false)
    }

    // MARK: Grid

    private func number(_ id: String) -> Int? { picked.firstIndex(of: id).map { $0 + 1 } }

    /// The circle on picture `index`: picks it or not; past the limit, the
    /// error buzz (`CheckNode`).
    private func check(_ index: Int) {
        guard let item = library.item(at: index) else { return }
        if !toggle(item.id) { UINotificationFeedbackGenerator().notificationOccurred(.error) }
    }

    /// Picks or unpicks; the numbers after it close up. False at the limit.
    @discardableResult
    func toggle(_ id: String) -> Bool {
        setPicked(id, picked.firstIndex(of: id) == nil)
    }

    @discardableResult
    func setPicked(_ id: String, _ value: Bool) -> Bool {
        let index = picked.firstIndex(of: id)
        if value {
            guard index == nil else { return true }
            guard picked.count < limit else { return false }
            picked.append(id)
        } else {
            guard let index else { return true }
            picked.remove(at: index)
        }
        feed.refreshNumbers(animating: id)
        updateCount(animated: true)
        preview?.showSelection(animated: true)
        return true
    }

    /// The drag-select's view of the grid: the picture under a point.
    fileprivate func pickable(at point: CGPoint) -> (index: Int, picked: Bool)? {
        guard let index = feed.index(at: point), let item = library.item(at: index) else { return nil }
        return (index, picked.contains(item.id))
    }

    fileprivate func setPicked(at index: Int, _ value: Bool) {
        guard let item = library.item(at: index) else { return }
        if !setPicked(item.id, value) { UINotificationFeedbackGenerator().notificationOccurred(.error) }
    }

    /// The drag-select took the finger: the grid stops and the sheet lets go.
    fileprivate func pickingBegan() {
        grid.isScrollEnabled = false
        pan.isEnabled = false
        pan.isEnabled = true
    }

    fileprivate func pickingEnded() {
        grid.isScrollEnabled = true
    }

    /// Telegram's preview over the grid, from the tapped picture.
    private func open(_ index: Int) {
        guard preview?.presentingViewController == nil, !closing, presentedViewController == nil else { return }
        view.endEditing(true)
        let preview = AttachPreviewViewController(
            library: library, start: index,
            selectionNumber: { [weak self] id in self?.number(id) },
            toggle: { [weak self] id in self?.toggle(id) ?? false },
            sourceView: { [weak self] index in self?.cell(index) },
            composer: previewComposer()
        )
        preview.onHide = { [weak self] id in self?.feed.hidden = id }
        preview.onFocus = { [weak self] index in self?.reveal(index) }
        self.preview = preview
        present(preview, animated: true)
    }

    private func cell(_ index: Int) -> UIView? {
        grid.cellForItem(at: IndexPath(item: index, section: 0))
    }

    /// Keeps the preview's picture in the grid's view, for its way back.
    private func reveal(_ index: Int) {
        guard index < feed.count, let frame = gridLayout.grid?.frame(at: index) else { return }
        let visible = grid.bounds.inset(by: grid.adjustedContentInset)
        guard !visible.contains(frame) else { return }
        let y = frame.minY < visible.minY ? frame.minY - grid.adjustedContentInset.top : frame.maxY - grid.bounds.height + grid.adjustedContentInset.bottom
        let maxY = max(-grid.adjustedContentInset.top, grid.contentSize.height - grid.bounds.height + grid.adjustedContentInset.bottom)
        grid.setContentOffset(CGPoint(x: 0, y: min(max(y, -grid.adjustedContentInset.top), maxY)), animated: false)
        grid.layoutIfNeeded()
    }

    private func sendPicked() {
        guard !picked.isEmpty else { return }
        finish(.send(picked, caption: panel.caption))
    }

    /// The count at the top right: the menu goes and the picks wait in
    /// the composer, nothing sent yet.
    private func stagePicked() {
        guard !picked.isEmpty, !closing else { return }
        finish(.stage(picked, caption: panel.caption))
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView === grid else { return }
        feed.scrolled()
        updateEdge(animated: true)
    }
}

/// Telegram's drag across the grid to pick (`MediaPickerGridSelectionGesture`),
/// run by `AttachSelectionDrag`: it takes the finger from the grid and the
/// sheet once it goes sideways, and picks what it passes over.
final class AttachSelectionRecognizer: UIGestureRecognizer {
    weak var sheet: AttachSheetViewController?
    private var drag: AttachSelectionDrag?

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        guard touches.count == 1, drag == nil, let touch = touches.first else {
            if state == .possible { state = .failed }
            return
        }
        touched(at: touch.location(in: view))
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesMoved(touches, with: event)
        guard let touch = touches.first else { return }
        moved(to: touch.location(in: view))
    }

    /// The finger down, in the grid's space.
    func touched(at location: CGPoint) {
        drag = AttachSelectionDrag(start: location)
        if drag?.phase == .failed { state = .failed }
    }

    /// The finger moved, in the grid's space.
    func moved(to location: CGPoint) {
        guard var drag, let sheet else { return }
        let event = drag.moved(to: location, item: { sheet.pickable(at: $0) }, set: { sheet.setPicked(at: $0, $1) })
        self.drag = drag
        switch event {
        case .failed:
            if state == .possible { state = .failed }
        case .began:
            sheet.pickingBegan()
            state = .began
        case .none:
            if state == .began || state == .changed { state = .changed }
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesEnded(touches, with: event)
        state = state == .began || state == .changed ? .ended : .failed
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesCancelled(touches, with: event)
        state = state == .began || state == .changed ? .cancelled : .failed
    }

    override func reset() {
        super.reset()
        if drag.map({ if case .picking = $0.phase { true } else { false } }) == true { sheet?.pickingEnded() }
        drag = nil
    }
}

/// The fade under the glass header over a scrolled grid: black 0.45 to
/// clear, 80 tall.
final class AttachMenuTopEdge: UIView {
    override class var layerClass: AnyClass { CAGradientLayer.self }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        let gradient = layer as! CAGradientLayer
        gradient.colors = [UIColor(Palette.attachMenuTopEdge).cgColor, UIColor(Palette.attachMenuTopEdge).withAlphaComponent(0).cgColor]
        gradient.startPoint = CGPoint(x: 0.5, y: 0)
        gradient.endPoint = CGPoint(x: 0.5, y: 1)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
}

/// Runs once on the next display frame, after what is set now has been drawn.
@MainActor
final class AttachMenuFrame: NSObject {
    private var link: CADisplayLink?
    private let work: () -> Void

    private init(_ work: @escaping () -> Void) {
        self.work = work
    }

    static func next(_ work: @escaping () -> Void) {
        let frame = AttachMenuFrame(work)
        let link = CADisplayLink(target: frame, selector: #selector(tick))
        frame.link = link
        link.add(to: .main, forMode: .common)
    }

    @objc private func tick() {
        link?.invalidate()
        link = nil
        work()
    }
}

/// Telegram's springs as UIKit's, sped up to their durations as Display
/// speeds up its `CASpringAnimation`s.
@MainActor
enum AttachMenuSprings {
    static func settle(initialVelocity: CGFloat) -> UISpringTimingParameters {
        spring(mass: AttachMenuMotion.springMass, stiffness: AttachMenuMotion.springStiffness, damping: AttachMenuMotion.springDamping, duration: AttachMenuMotion.settleDuration, velocity: initialVelocity)
    }

    /// Display's `.customSpring(damping:initialVelocity:)`: mass 5,
    /// stiffness 900, sped up to `duration`.
    static func custom(damping: CGFloat, duration: TimeInterval, velocity: CGFloat) -> UISpringTimingParameters {
        spring(mass: AttachMenuMotion.springMass, stiffness: AttachMenuMotion.springStiffness, damping: damping, duration: duration, velocity: velocity)
    }

    static func dipReturn() -> UISpringTimingParameters {
        spring(mass: 1, stiffness: 900, damping: AttachMenuMotion.switchReturnDamping, duration: AttachMenuMotion.switchReturnDuration, velocity: 0)
    }

    /// Display's `.spring` curve.
    static func openCurve() -> UICubicTimingParameters {
        let curve = AttachMenuMotion.openCurve
        return UICubicTimingParameters(controlPoint1: CGPoint(x: CGFloat(curve.x1), y: CGFloat(curve.y1)), controlPoint2: CGPoint(x: CGFloat(curve.x2), y: CGFloat(curve.y2)))
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
        primary.tintColor = UIColor(Palette.attachMenuAccent)
        primary.configuration?.title = Strings.AttachMenu.choosePhotos
        primary.configuration?.baseForegroundColor = UIColor(Palette.attachMenuOnAccent)
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
            button.tintColor = UIColor(Palette.attachMenuControl)
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
        self.icon = IconView(icon, size: AttachMenuFilesLayout.Metrics.icon, tint: Palette.attachMenuControl)
        super.init(frame: .zero)
        self.icon.isUserInteractionEnabled = false
        title.text = text
        title.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 17))
        title.adjustsFontForContentSizeCategory = true
        title.textColor = UIColor(Palette.attachMenuControl)
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
