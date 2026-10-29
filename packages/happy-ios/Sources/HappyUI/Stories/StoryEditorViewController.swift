#if canImport(UIKit)
import AVFoundation
import HappyCore
import HappyLayout
import UIKit

/// The story editor, laid out and handled as Telegram's story editor: the
/// frame full width on a 9:16 canvas with round corners, the caption over
/// its foot, and under it back, the text and sticker tools in one glass
/// pill, and Post. Overlays are placed by finger (drag, pinch, turn, the
/// handles of the selected one), snap to the centre lines, the edges and
/// 45° with the line shown, and go when dropped on the bin that replaces
/// the controls while one is dragged. The frames button opens the frames.
/// Device media is uploaded once, on save; nothing is posted until Post.
final class StoryEditorViewController: UIViewController, UIGestureRecognizerDelegate, UITextFieldDelegate {
    private let session: StoriesSession
    private(set) var draft: StoryDraft
    private var local: [String: StoryLocalMedia]
    let canvas = StoryCanvasView()
    private let closeButton = UIButton(configuration: .glass())
    private let tools = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
    private let textTool = UIButton(type: .custom)
    private let stickerTool = UIButton(type: .custom)
    private let postButton = UIButton(configuration: .prominentGlass())
    private let captionPanel = UIView()
    /// Telegram's editor field: regular glass with its dark panel tint.
    private let captionField = UIVisualEffectView(effect: StoryEditorViewController.fieldGlass)
    private static var fieldGlass: UIGlassEffect {
        let glass = UIGlassEffect(style: .regular)
        // Telegram's field renders as a deep shade of the frame under it.
        glass.tintColor = UIColor(white: 0, alpha: 0.2)
        return glass
    }
    private let caption = UITextField()
    private let captionDim = UIControl()
    /// Telegram's round video, at the caption's far right, where the
    /// computer takes them: hold to record, tap to lock.
    private let roundVideoButton = UIButton(configuration: .glass())
    private var recorder: StoryRoundVideoRecorder?
    private let framesButton = UIButton(configuration: .glass())
    private let framesPanel = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterialDark))
    private let framesScroll = UIScrollView()
    private var cards: [UIButton] = []
    private let addCard = UIButton(type: .custom)
    private var framesShown = false
    private let guides = UIView()
    private var guideViews: [StorySnapper.Guide: UIView] = [:]
    private let angleGuide = CAShapeLayer()
    private let selection = StorySelectionView()
    private let bin = StoryBinView()
    private let busy = UIView()
    private let busyLabel = UILabel()
    private let busySpinner = UIActivityIndicatorView(style: .large)
    private var textEntry: StoryTextEntryView?
    private var keyboard: CGFloat = 0
    private var layout: StoryEditorLayout?

    private enum Target: Equatable { case overlay(String), media }
    private var target: Target?
    /// The overlay last touched, shown in its dashed frame.
    private var selected: String?
    /// The touched thing's place as the fingers have it, before snapping.
    private var raw = (center: CGPoint.zero, scale: CGFloat(1), rotation: CGFloat(0))
    private var snapper = StorySnapper()
    private var overBin = false
    private var active: Set<UIGestureRecognizer> = []
    private var pan: UIPanGestureRecognizer?

    private var saving = false
    /// Device files sent, by frame, until a save places them.
    private var uploaded: [String: String] = [:]
    /// Every device file this editor was given, removed when it closes.
    private var files: [URL] = []
    private var thumbLoads: [String: Task<Void, Never>] = [:]
    private var thumbImages: [String: UIImage] = [:]

    /// Closed, with the story saved (or posted), or nil.
    var onFinish: ((Story?) -> Void)?
    /// What happened, for the harness's probe.
    private(set) var trail: [String] = []

    init(session: StoriesSession, draft: StoryDraft, local: [String: StoryLocalMedia] = [:]) {
        self.session = session
        self.draft = draft
        self.local = local
        files = draft.uploads.map(\.file)
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
        modalPresentationCapturesStatusBarAppearance = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit {
        for task in thumbLoads.values { task.cancel() }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        overrideUserInterfaceStyle = .dark
        view.backgroundColor = .black
        view.accessibilityIdentifier = "story-editor"
        canvas.layer.cornerRadius = StoryEditorLayout.Metrics.cornerRadius
        canvas.layer.cornerCurve = .continuous
        canvas.isUserInteractionEnabled = true
        canvas.accessibilityIdentifier = "story-editor-canvas"
        canvas.onVideoEnd = { [weak self] in
            self?.canvas.restart()
            self?.canvas.play()
        }
        view.addSubview(canvas)

        // The snap lines and the angle line, over the canvas and clipped to it.
        guides.isUserInteractionEnabled = false
        guides.clipsToBounds = true
        guides.layer.cornerRadius = StoryEditorLayout.Metrics.cornerRadius
        guides.layer.cornerCurve = .continuous
        for guide in [StorySnapper.Guide.centerX, .centerY, .left, .right, .top, .bottom] {
            let line = UIView()
            line.backgroundColor = UIColor(Palette.storiesEditorGuide)
            line.alpha = 0
            guides.addSubview(line)
            guideViews[guide] = line
        }
        angleGuide.strokeColor = UIColor(Palette.storiesEditorAngle).cgColor
        angleGuide.lineWidth = 1
        angleGuide.lineDashPattern = [4, 4]
        angleGuide.opacity = 0
        guides.layer.addSublayer(angleGuide)
        view.addSubview(guides)

        selection.onHandle = { [weak self] state, scale, turn in self?.handled(state, scale: scale, turn: turn) }
        view.addSubview(selection)
        bin.alpha = 0
        view.addSubview(bin)

        captionDim.backgroundColor = UIColor(white: 0, alpha: 0.4)
        captionDim.alpha = 0
        captionDim.layer.cornerRadius = StoryEditorLayout.Metrics.cornerRadius
        captionDim.layer.cornerCurve = .continuous
        captionDim.addAction(UIAction { [weak self] _ in self?.caption.resignFirstResponder() }, for: .touchUpInside)
        view.addSubview(captionDim)

        closeButton.configuration?.image = StoryEditorIcons.back
        closeButton.tintColor = .white
        closeButton.accessibilityIdentifier = "story-editor-close"
        closeButton.accessibilityLabel = Strings.Stories.close
        closeButton.addAction(UIAction { [weak self] _ in self?.close() }, for: .touchUpInside)
        view.addSubview(closeButton)

        tools.cornerConfiguration = .capsule()
        for (button, icon, id, label) in [(textTool, StoryEditorIcons.addText, "story-tool-text", Strings.Stories.text), (stickerTool, StoryEditorIcons.addSticker, "story-tool-sticker", Strings.Stories.stickers)] {
            button.setImage(icon, for: .normal)
            button.accessibilityIdentifier = id
            button.accessibilityLabel = label
            tools.contentView.addSubview(button)
        }
        textTool.addAction(UIAction { [weak self] _ in self?.beginText(nil) }, for: .touchUpInside)
        stickerTool.addAction(UIAction { [weak self] _ in self?.pick(.all) }, for: .touchUpInside)
        view.addSubview(tools)

        var post = UIButton.Configuration.prominentGlass()
        post.attributedTitle = AttributedString(Strings.Stories.post.uppercased(), attributes: AttributeContainer([.font: Self.postFont]))
        post.image = StoryEditorIcons.next
        post.imagePlacement = .trailing
        post.imagePadding = 5
        post.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: StoryEditorLayout.Metrics.postPadding, bottom: 0, trailing: StoryEditorLayout.Metrics.postPadding)
        postButton.configuration = post
        postButton.tintColor = UIColor(Palette.storiesEditorPost)
        postButton.accessibilityIdentifier = "story-editor-post"
        postButton.accessibilityLabel = Strings.Stories.post
        postButton.addAction(UIAction { [weak self] _ in self?.commit(post: true) }, for: .touchUpInside)
        view.addSubview(postButton)

        captionField.cornerConfiguration = .capsule()
        captionField.overrideUserInterfaceStyle = .dark
        captionField.isUserInteractionEnabled = false
        captionPanel.addSubview(captionField)
        caption.text = draft.caption
        caption.attributedPlaceholder = NSAttributedString(string: Strings.Stories.caption, attributes: [.foregroundColor: UIColor(white: 1, alpha: 0.8)])
        caption.textColor = .white
        caption.tintColor = .white
        caption.font = .systemFont(ofSize: 17)
        caption.returnKeyType = .done
        caption.keyboardAppearance = .dark
        caption.delegate = self
        caption.accessibilityIdentifier = "story-editor-caption"
        caption.addAction(UIAction { [weak self] _ in self?.captionChanged() }, for: .editingChanged)
        captionPanel.addSubview(caption)
        roundVideoButton.configuration?.image = UIImage.icon(.ionicons("radio-button-on"), size: 22).withRenderingMode(.alwaysTemplate)
        roundVideoButton.configuration?.contentInsets = .zero
        roundVideoButton.tintColor = .white
        roundVideoButton.accessibilityIdentifier = "story-editor-round-video"
        roundVideoButton.accessibilityLabel = Strings.Stories.roundVideo
        roundVideoButton.accessibilityHint = Strings.Stories.roundVideoHint
        roundVideoButton.isHidden = !session.snapshot.agentStories
        roundVideoButton.addAction(UIAction { [weak self] _ in self?.recordRoundVideo(locked: true) }, for: .primaryActionTriggered)
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(roundVideoHeld(_:)))
        hold.minimumPressDuration = 0.25
        roundVideoButton.addGestureRecognizer(hold)
        captionPanel.addSubview(roundVideoButton)
        view.addSubview(captionPanel)

        framesButton.configuration?.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
            var outgoing = incoming
            outgoing.font = .systemFont(ofSize: 14, weight: .semibold)
            return outgoing
        }
        framesButton.configuration?.contentInsets = .zero
        framesButton.tintColor = .white
        framesButton.accessibilityIdentifier = "story-editor-frames"
        framesButton.accessibilityLabel = Strings.Stories.frames
        framesButton.addAction(UIAction { [weak self] _ in self?.toggleFrames() }, for: .touchUpInside)
        view.addSubview(framesButton)
        framesPanel.clipsToBounds = true
        framesPanel.layer.cornerRadius = 10
        framesPanel.layer.cornerCurve = .continuous
        framesPanel.alpha = 0
        framesPanel.isHidden = true
        framesScroll.showsHorizontalScrollIndicator = false
        framesPanel.contentView.addSubview(framesScroll)
        addCard.setImage(StoryEditorIcons.plus, for: .normal)
        addCard.backgroundColor = UIColor(white: 1, alpha: 0.1)
        addCard.layer.cornerRadius = 8
        addCard.layer.cornerCurve = .continuous
        addCard.accessibilityIdentifier = "story-editor-add"
        addCard.accessibilityLabel = Strings.Stories.addFrame
        addCard.addAction(UIAction { [weak self] _ in self?.addFrames() }, for: .touchUpInside)
        framesScroll.addSubview(addCard)
        view.addSubview(framesPanel)

        busy.backgroundColor = UIColor(white: 0, alpha: 0.6)
        busy.isHidden = true
        busyLabel.textColor = .white
        busyLabel.textAlignment = .center
        busyLabel.font = .systemFont(ofSize: 15, weight: .medium)
        busySpinner.color = .white
        busy.addSubview(busySpinner)
        busy.addSubview(busyLabel)
        view.addSubview(busy)

        let pan = UIPanGestureRecognizer(target: self, action: #selector(gestured(_:)))
        pan.maximumNumberOfTouches = 2
        self.pan = pan
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(gestured(_:)))
        let rotation = UIRotationGestureRecognizer(target: self, action: #selector(gestured(_:)))
        for recognizer in [pan, pinch, rotation] as [UIGestureRecognizer] {
            recognizer.delegate = self
            canvas.addGestureRecognizer(recognizer)
        }
        canvas.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped(_:))))

        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        center.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
        render()
    }

    private static let postFont = UIFont.systemFont(ofSize: 16, weight: .semibold).rounded

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let title = (Strings.Stories.post.uppercased() as NSString).size(withAttributes: [.font: Self.postFont]).width
        let statusBar = view.window?.windowScene?.statusBarManager?.statusBarFrame.height ?? view.safeAreaInsets.top
        let layout = StoryEditorLayout(
            bounds: view.bounds, statusBar: statusBar, homeIndicator: view.safeAreaInsets.bottom,
            postContent: title + 5 + StoryEditorIcons.next.size.width, tablet: traitCollection.userInterfaceIdiom == .pad,
            roundVideo: !roundVideoButton.isHidden
        )
        let resized = self.layout?.canvas.size != layout.canvas.size
        self.layout = layout
        canvas.frame = layout.canvas
        guides.frame = layout.canvas
        captionDim.frame = layout.canvas
        closeButton.frame = layout.close
        tools.frame = layout.tools
        for (button, frame) in zip([textTool, stickerTool], layout.toolButtons) { button.frame = frame }
        postButton.frame = layout.post
        var panel = layout.captionPanel
        if caption.isFirstResponder, keyboard > 0 {
            panel.origin.y = view.bounds.height - keyboard - panel.height
        }
        captionPanel.frame = panel
        canvas.footInset = max(0, layout.canvas.maxY - layout.captionPanel.minY)
        let field = layout.caption.offsetBy(dx: -layout.captionPanel.minX, dy: -layout.captionPanel.minY)
        captionField.frame = field
        caption.frame = field.insetBy(dx: 16, dy: 0)
        roundVideoButton.frame = layout.roundVideo.map { $0.offsetBy(dx: -layout.captionPanel.minX, dy: -layout.captionPanel.minY) } ?? .zero
        recorder?.frame = view.bounds
        framesButton.frame = layout.framesButton
        layoutFrames(layout)
        bin.frame = layout.bin
        bin.circle = layout.binCircle.offsetBy(dx: -layout.bin.minX, dy: -layout.bin.minY)
        let c = CGRect(origin: .zero, size: layout.canvas.size)
        let inset = c.width * StorySnapper.inset
        let pixel = 1 / max(1, traitCollection.displayScale)
        let line = max(1, pixel)
        guideViews[.centerX]?.frame = CGRect(x: c.midX - line / 2, y: 0, width: line, height: c.height)
        guideViews[.centerY]?.frame = CGRect(x: 0, y: c.midY - line / 2, width: c.width, height: line)
        guideViews[.left]?.frame = CGRect(x: inset, y: 0, width: line, height: c.height)
        guideViews[.right]?.frame = CGRect(x: c.maxX - inset - line, y: 0, width: line, height: c.height)
        guideViews[.top]?.frame = CGRect(x: 0, y: inset, width: c.width, height: line)
        guideViews[.bottom]?.frame = CGRect(x: 0, y: c.maxY - inset - line, width: c.width, height: line)
        busy.frame = view.bounds
        busySpinner.center = CGPoint(x: view.bounds.midX, y: view.bounds.midY - 16)
        busyLabel.frame = CGRect(x: 16, y: busySpinner.frame.maxY + 12, width: view.bounds.width - 32, height: 22)
        textEntry?.frame = view.bounds
        if resized { render() } else { placeSelection() }
    }

    private func note(_ step: String) {
        trail.append(step)
        if trail.count > 24 { trail.removeFirst() }
    }

    // MARK: Drawing

    private func render() {
        guard isViewLoaded else { return }
        if let frame = draft.current {
            var (story, shown) = draft.preview(frame)
            // The editor's own field shows the caption.
            story.caption = nil
            canvas.local = local
            canvas.localRoundVideos = draft.roundVideoFiles
            canvas.show(story, frame: shown, media: session.media, playsVideo: true)
            if shown.kind == .video { canvas.play() }
        }
        if let selected, draft.overlay(selected) == nil { self.selected = nil }
        renderFrames()
        let idle = !saving && !draft.frames.isEmpty
        postButton.isEnabled = idle
        for button in [textTool, stickerTool] { button.isEnabled = draft.current != nil }
        canvas.layoutIfNeeded()
        placeSelection()
        view.setNeedsLayout()
    }

    /// The dashed frame around the selected overlay, unless it is being moved.
    private func placeSelection() {
        guard let selected, target == nil, textEntry == nil, let overlayView = canvas.overlayView(selected), let overlay = draft.overlay(selected),
              let t = overlay.transform else {
            selection.isHidden = true
            return
        }
        let scale = overlayView.scalesWithTransform ? CGFloat(t.scale) : 1
        let unit = canvas.bounds.width / 1080
        let oval: Bool = switch overlay { case .sticker, .emoji, .reaction: true; default: false }
        selection.show(
            size: CGSize(width: overlayView.bounds.width * scale, height: overlayView.bounds.height * scale),
            center: canvas.convert(overlayView.center, to: view), rotation: CGFloat(t.rotation),
            outset: 10 * unit, oval: oval
        )
        selection.accessibilityValue = selected
        selection.isHidden = false
    }

    private func select(_ id: String?) {
        selected = id
        placeSelection()
    }

    // MARK: Frames

    private func renderFrames() {
        framesButton.configuration?.title = "\(draft.frames.count)"
        framesButton.accessibilityValue = "\(draft.frames.count)"
        while cards.count < draft.frames.count {
            let card = UIButton(type: .custom)
            card.imageView?.contentMode = .scaleAspectFill
            card.clipsToBounds = true
            card.layer.cornerRadius = 8
            card.layer.cornerCurve = .continuous
            card.backgroundColor = UIColor(white: 1, alpha: 0.1)
            let index = cards.count
            card.addAction(UIAction { [weak self] _ in self?.selectFrame(index) }, for: .touchUpInside)
            framesScroll.addSubview(card)
            cards.append(card)
        }
        while cards.count > draft.frames.count { cards.removeLast().removeFromSuperview() }
        for (index, frame) in draft.frames.enumerated() {
            let card = cards[index]
            card.accessibilityIdentifier = "story-editor-frame:\(index)"
            card.accessibilityValue = index == draft.selected ? "selected" : nil
            card.layer.borderWidth = index == draft.selected ? 2 : 0
            card.layer.borderColor = UIColor.white.cgColor
            card.setImage(thumbnail(frame), for: .normal)
            card.menu = draft.frames.count > 1 ? UIMenu(children: [
                UIAction(title: Strings.Stories.deleteFrame, image: nil, attributes: .destructive) { [weak self] _ in self?.removeFrame(frame.id) },
            ]) : nil
        }
        addCard.isHidden = !draft.canAddFrame
        if let layout { layoutFrames(layout) }
    }

    private func layoutFrames(_ layout: StoryEditorLayout) {
        let panel = layout.panel(width: view.bounds.width, frames: draft.frames.count, canAdd: draft.canAddFrame)
        framesPanel.frame = panel.frame
        framesScroll.frame = framesPanel.bounds
        framesScroll.contentSize = panel.content
        for (card, frame) in zip(cards, panel.items) { card.frame = frame }
        if let add = panel.add { addCard.frame = add }
    }

    private func toggleFrames() {
        framesShown.toggle()
        if framesShown { framesPanel.isHidden = false }
        UIView.animate(withDuration: 0.2) {
            self.framesPanel.alpha = self.framesShown ? 1 : 0
        } completion: { _ in
            self.framesPanel.isHidden = !self.framesShown
        }
    }

    private func thumbnail(_ frame: StoryDraft.Frame) -> UIImage? {
        if let poster = local[frame.id]?.poster { return poster }
        if let image = thumbImages[frame.id] { return image }
        guard thumbLoads[frame.id] == nil, case .kept = frame.media else { return nil }
        let (_, shown) = draft.preview(frame)
        let media = session.media
        let storyId = draft.storyId
        thumbLoads[frame.id] = Task { [weak self] in
            let image = await media.frame(storyId, shown, pixels: 240)
            guard let self, let image else { return }
            thumbImages[frame.id] = image
            renderFrames()
        }
        return nil
    }

    private func selectFrame(_ index: Int) {
        draft.select(index)
        select(nil)
        render()
    }

    private func removeFrame(_ id: String) {
        draft.removeFrame(id)
        // Its device file stays for the editor to remove on close.
        local.removeValue(forKey: id)
        uploaded.removeValue(forKey: id)
        thumbImages.removeValue(forKey: id)
        render()
    }

    private func addFrames() {
        StoriesMediaChooser.choose(from: self, limit: StoryCanvas.maxFrames - draft.frames.count) { [weak self] picked in
            guard let self else {
                // The editor closed while they were readied: nobody owns the files.
                for one in picked {
                    if case .local(let file, _) = one.frame.media { try? FileManager.default.removeItem(at: file) }
                }
                return
            }
            for one in picked {
                if case .local(let file, _) = one.frame.media { files.append(file) }
                guard draft.add(one.frame) else { continue }
                if let media = one.local { local[one.frame.id] = media }
            }
            note("frames:\(draft.frames.count)")
            select(nil)
            render()
        }
    }

    // MARK: Fingers

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        true
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        textEntry == nil && !saving && !caption.isFirstResponder
    }

    @objc private func gestured(_ recognizer: UIGestureRecognizer) {
        switch recognizer.state {
        case .began:
            active.insert(recognizer)
            // A pinch or turn joining a drag that began on the media takes the selected overlay.
            let joins = target == .media && !(recognizer is UIPanGestureRecognizer) && selected != nil
            if target == nil || joins { begin(at: recognizer.location(in: canvas), by: recognizer) }
        case .changed:
            break
        case .ended, .cancelled, .failed:
            active.remove(recognizer)
            if active.isEmpty { finishGesture() }
            return
        default:
            return
        }
        guard target != nil else { return }
        switch recognizer {
        case let pan as UIPanGestureRecognizer:
            let moved = pan.translation(in: canvas)
            raw.center.x += moved.x
            raw.center.y += moved.y
            pan.setTranslation(.zero, in: canvas)
        case let pinch as UIPinchGestureRecognizer:
            raw.scale *= pinch.scale
            pinch.scale = 1
        case let rotation as UIRotationGestureRecognizer:
            raw.rotation += rotation.rotation
            rotation.rotation = 0
        default:
            break
        }
        follow()
    }

    /// What the fingers took: the overlay under them, or for two fingers
    /// the selected one, or else the frame's media.
    private func begin(at point: CGPoint, by recognizer: UIGestureRecognizer) {
        let size = canvas.bounds.size
        var id = canvas.overlayView(at: point)?.id
        // Two fingers anywhere take the selected overlay, as Telegram's do.
        if id == nil, recognizer.numberOfTouches > 1 || !(recognizer is UIPanGestureRecognizer), let selected, draft.overlay(selected) != nil { id = selected }
        if let id, let overlay = draft.overlay(id), let t = overlay.transform {
            target = .overlay(id)
            selected = id
            draft.bringToFront(id)
            raw = (CGPoint(x: CGFloat(t.x) * size.width, y: CGFloat(t.y) * size.height), CGFloat(t.scale), CGFloat(t.rotation))
            if let view = canvas.overlayView(id) {
                snapper.begin(center: raw.center, half: StorySnapper.half(box(view, scale: raw.scale), rotation: raw.rotation), rotation: raw.rotation, canvas: size, edges: Self.edges(overlay))
            }
            StoriesHaptics.prepare(.snap, .trash)
            render()
        } else if let frame = draft.current {
            // The selection stays; only a tap lets go of it.
            target = .media
            let t = frame.placement
            raw = (CGPoint(x: CGFloat(t.x) * size.width, y: CGFloat(t.y) * size.height), CGFloat(t.scale), CGFloat(t.rotation))
        }
    }

    private static func edges(_ overlay: StoryOverlay) -> Bool {
        switch overlay { case .sticker, .emoji: true; default: false }
    }

    /// An overlay's box on the canvas at `scale`.
    private func box(_ view: StoryOverlayView, scale: CGFloat) -> CGSize {
        let t = CGFloat(max(0.05, view.overlay.transform?.scale ?? 1))
        let grows = view.scalesWithTransform ? scale : scale / t
        return CGSize(width: view.bounds.width * grows, height: view.bounds.height * grows)
    }

    /// Puts the touched thing where the fingers have it, snapped.
    private func follow() {
        let size = canvas.bounds.size
        guard size.width > 0, size.height > 0 else { return }
        let scale = min(10, max(0.05, raw.scale))
        let turned = CGFloat(atan2(sin(Double(raw.rotation)), cos(Double(raw.rotation))))
        switch target {
        case .overlay(let id):
            guard let overlay = draft.overlay(id), let view = canvas.overlayView(id) else { return }
            var result = snapper.snap(center: raw.center, half: StorySnapper.half(box(view, scale: scale), rotation: raw.rotation), rotation: raw.rotation, canvas: size, edges: Self.edges(overlay) && !handling)
            // A handle grows and turns it about its centre; only the angle snaps.
            if handling {
                result.center = raw.center
                result.guides = []
            }
            if result.snapped {
                StoriesHaptics.play(.snap)
                note("snap")
            }
            showGuides(result.guides, angle: result.turned ? result.rotation : nil, through: result.center)
            let rotation = Double(atan2(sin(result.rotation), cos(result.rotation)))
            draft.move(id, to: StoryTransform(x: Double(result.center.x / size.width), y: Double(result.center.y / size.height), scale: Double(scale), rotation: rotation))
            let dragging = !handling && active.count == 1 && pan.map { active.contains($0) && $0.numberOfTouches == 1 } ?? false
            binShown(dragging)
            let over = dragging && pan.map { finger in layout.map { $0.bin.insetBy(dx: -20, dy: -20).contains(finger.location(in: self.view)) } ?? false } ?? false
            if over != overBin {
                overBin = over
                bin.open = over
                if over {
                    StoriesHaptics.play(.trash)
                    note("trash-over")
                } else {
                    // Pulled back out: it comes back to the finger.
                    UIView.animate(withDuration: 0.15) { view.alpha = 1 }
                }
            }
            render()
            if over { suck(view) }
        case .media:
            draft.place(media: StoryTransform(x: Double(raw.center.x / size.width), y: Double(raw.center.y / size.height), scale: Double(scale), rotation: Double(turned)))
            render()
        case nil:
            break
        }
    }

    /// Over the bin, the overlay shrinks into it.
    private func suck(_ view: StoryOverlayView) {
        guard let layout else { return }
        let center = canvas.convert(CGPoint(x: layout.binCircle.midX, y: layout.binCircle.midY), from: self.view)
        let width = max(1, view.bounds.width)
        let shrink = layout.binCircle.width * 0.5 / width
        UIView.animate(withDuration: 0.15) {
            view.center = center
            view.transform = CGAffineTransform(rotationAngle: CGFloat(view.overlay.transform?.rotation ?? 0)).scaledBy(x: shrink, y: shrink)
            view.alpha = 0.6
        }
    }

    private func finishGesture() {
        let wasOverBin = overBin
        if case .overlay(let id) = target {
            if wasOverBin {
                trash(id)
            } else if let t = draft.overlay(id)?.transform {
                note("moved:\(String(format: "%.3f,%.3f,%.2f,%.3f", t.x, t.y, t.scale, t.rotation))")
            }
        }
        target = nil
        overBin = false
        bin.open = false
        snapper.reset()
        showGuides([], angle: nil, through: .zero)
        binShown(false)
        if !wasOverBin { render() }
    }

    /// Dropped on the bin: it falls in and goes.
    private func trash(_ id: String) {
        selected = nil
        draft.remove(id)
        note("trashed")
        guard let view = canvas.overlayView(id) else { return render() }
        UIView.animate(withDuration: 0.2) {
            view.alpha = 0
            view.transform = view.transform.scaledBy(x: 0.01, y: 0.01)
        } completion: { _ in
            self.render()
        }
    }

    private func showGuides(_ shown: Set<StorySnapper.Guide>, angle: CGFloat?, through center: CGPoint) {
        for (guide, line) in guideViews {
            let alpha: CGFloat = shown.contains(guide) ? 1 : 0
            if line.alpha != alpha { UIView.animate(withDuration: 0.1) { line.alpha = alpha } }
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let angle {
            let path = UIBezierPath()
            path.move(to: CGPoint(x: -3000, y: 0))
            path.addLine(to: CGPoint(x: 3000, y: 0))
            path.apply(CGAffineTransform(rotationAngle: angle))
            path.apply(CGAffineTransform(translationX: center.x, y: center.y))
            angleGuide.path = path.cgPath
            angleGuide.opacity = 1
        } else {
            angleGuide.opacity = 0
        }
        CATransaction.commit()
    }

    /// While an overlay is dragged the controls step aside for the bin.
    private func binShown(_ shown: Bool) {
        guard (bin.alpha == 1) != shown else { return }
        UIView.animate(withDuration: 0.2) {
            self.bin.alpha = shown ? 1 : 0
            for view in self.controls { view.alpha = shown ? 0 : 1 }
            if shown { self.framesPanel.alpha = 0 }
        } completion: { _ in
            if !shown, self.framesShown { self.framesPanel.alpha = 1 }
        }
    }

    private var controls: [UIView] { [closeButton, tools, postButton, captionPanel, framesButton] }

    /// The selected overlay's handles, dragged: it grows and turns about its centre.
    private func handled(_ state: UIGestureRecognizer.State, scale: CGFloat, turn: CGFloat) {
        guard let selected, let t = draft.overlay(selected)?.transform else { return }
        let size = canvas.bounds.size
        switch state {
        case .began:
            handling = true
            raw = (CGPoint(x: CGFloat(t.x) * size.width, y: CGFloat(t.y) * size.height), CGFloat(t.scale), CGFloat(t.rotation))
            handleStart = (raw.scale, raw.rotation)
            if let view = canvas.overlayView(selected), let overlay = draft.overlay(selected) {
                snapper.begin(center: raw.center, half: StorySnapper.half(box(view, scale: raw.scale), rotation: raw.rotation), rotation: raw.rotation, canvas: size, edges: Self.edges(overlay))
            }
            target = .overlay(selected)
        case .changed:
            raw.scale = handleStart.scale * scale
            raw.rotation = handleStart.rotation + turn
            follow()
        default:
            handling = false
            finishGesture()
        }
    }

    /// A handle, not the canvas, is moving the selected overlay.
    private var handling = false
    private var handleStart = (scale: CGFloat(1), rotation: CGFloat(0))

    @objc private func tapped(_ tap: UITapGestureRecognizer) {
        guard textEntry == nil, !saving else { return }
        if caption.isFirstResponder {
            caption.resignFirstResponder()
            return
        }
        if framesShown { return toggleFrames() }
        let point = tap.location(in: canvas)
        guard let view = canvas.overlayView(at: point) else {
            // Telegram's canvas: a tap lets go of the selection, or starts text.
            if selected != nil { select(nil) } else { beginText(nil) }
            return
        }
        // The first tap selects; another on the selected one changes it.
        guard view.id == selected else {
            select(view.id)
            return
        }
        switch view.overlay {
        case .text(let id, _, _, _):
            beginText(id)
        case .link(let id, let url, let label, let style, _, let t):
            // Tapping a link turns it through its looks; only `custom` has a colour.
            let looks: [StoryLinkStyle] = [.white, .black, .transparent, .blur]
            let next = looks[((looks.firstIndex(of: style) ?? -1) + 1) % looks.count]
            draft.replace(.link(id: id, url: url, label: label, style: next, color: nil, transform: t))
            note("link:\(next.rawValue)")
        case .reaction(let id, let emoji, let dark, let flipped, let t):
            // Light, dark, then each with its tail on the right.
            let isDark = dark == true, isFlipped = flipped == true
            let next = (dark: !isDark, flipped: isDark ? !isFlipped : isFlipped)
            draft.replace(.reaction(id: id, emoji: emoji, dark: next.dark ? true : nil, flipped: next.flipped ? true : nil, transform: t))
            note("reaction:\(next.dark ? "dark" : "light"),\(next.flipped ? "right" : "left")")
        default:
            break
        }
        render()
    }

    // MARK: Adding

    private func add(_ overlay: StoryOverlay, _ kind: String) {
        guard draft.add(overlay) else {
            StoriesHaptics.play(.refused)
            return
        }
        note("added:\(kind)")
        selected = overlay.id
        render()
    }

    private func pick(_ mode: StickerPickerViewController.Mode) {
        let picker = StickerPickerViewController(session: session, mode: mode)
        picker.onPick = { [weak self, weak picker] pick in
            picker?.dismiss(animated: true) {
                // The link and the reaction ask for more first.
                switch pick {
                case .link: self?.askLink()
                case .reaction: self?.pick(.emojiOnly)
                default: break
                }
            }
            self?.place(pick, reaction: mode == .emojiOnly)
        }
        if let sheet = picker.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = 10
        }
        present(picker, animated: true)
    }

    private func place(_ pick: StickerPick, reaction: Bool) {
        let id = ClientID.make()
        let middle = { (scale: Double) in StoryTransform(x: 0.5, y: 0.5, scale: scale, rotation: 0) }
        switch pick {
        case .emoji(let emoji) where reaction:
            add(.reaction(id: id, emoji: emoji, dark: nil, flipped: nil, transform: middle(0.3)), "reaction")
        case .emoji(let emoji):
            add(.emoji(id: id, emoji: emoji, transform: middle(0.25)), "emoji")
        case .sticker(let sticker):
            add(.sticker(id: id, packId: sticker.packId, stickerId: sticker.id, transform: middle(0.4)), "sticker")
        case .link, .reaction:
            return
        }
        if draft.overlay(id) != nil { StoriesHaptics.play(.stickerDrop) }
    }

    /// Text typed on the canvas: new, or the overlay `id` again.
    private func beginText(_ id: String?) {
        guard textEntry == nil, draft.current != nil, let layout else { return }
        if framesShown { toggleFrames() }
        var initial = ""
        var style = StoryTextStyle(fill: .filled, width: StoryTextEntryView.width(scale: Double(StoryTextEntryLayout.scale(slider: StoryTextEntryLayout.Metrics.newSize))))
        var scale = Double(StoryTextEntryLayout.scale(slider: StoryTextEntryLayout.Metrics.newSize))
        if let id, case .text(_, let text, let was, let t) = draft.overlay(id) {
            initial = text
            style = was
            scale = t.scale
        }
        let entry = StoryTextEntryView(text: initial, style: style, scale: scale, canvas: layout.canvas, cornerRadius: StoryEditorLayout.Metrics.cornerRadius)
        entry.frame = view.bounds
        entry.present = { [weak self] picker in self?.present(picker, animated: true) }
        view.insertSubview(entry, belowSubview: busy)
        textEntry = entry
        chromeShown(false)
        if let id { canvas.overlayView(id)?.isHidden = true }
        let end = { [weak self, weak entry] in
            guard let self else { return }
            entry?.removeFromSuperview()
            textEntry = nil
            chromeShown(true)
            if let id { canvas.overlayView(id)?.isHidden = false }
        }
        entry.onCancel = { [weak self] in
            end()
            self?.render()
        }
        entry.onDone = { [weak self] text, style, scale in
            guard let self else { return }
            end()
            let typed = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            if let id, case .text(_, _, _, var t) = draft.overlay(id) {
                t.scale = scale
                if typed { draft.replace(.text(id: id, text: text, style: style, transform: t)) } else { draft.remove(id) }
                note("text:\(style.fill.rawValue),\(style.font.rawValue),\(style.color)")
                render()
            } else if typed {
                add(.text(id: ClientID.make(), text: text, style: style, transform: StoryTransform(x: 0.5, y: 0.5, scale: scale, rotation: 0)), "text")
                note("text:\(style.fill.rawValue),\(style.font.rawValue),\(style.color)")
            } else {
                render()
            }
        }
        entry.layoutIfNeeded()
        entry.begin()
        placeSelection()
    }

    /// The tools, caption and frames step aside while text is typed.
    private func chromeShown(_ shown: Bool) {
        UIView.animate(withDuration: 0.2) {
            for view in self.controls { view.alpha = shown ? 1 : 0 }
        }
    }

    private func askLink() {
        let alert = UIAlertController(title: Strings.Stories.link, message: nil, preferredStyle: .alert)
        alert.addTextField { field in
            field.placeholder = Strings.Stories.linkURL
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
            field.accessibilityIdentifier = "story-link-url"
        }
        alert.addTextField { field in
            field.placeholder = Strings.Stories.linkLabel
            field.accessibilityIdentifier = "story-link-label"
        }
        alert.addAction(UIAlertAction(title: Strings.Stories.cancel, style: .cancel))
        alert.addAction(UIAlertAction(title: Strings.Stories.done, style: .default) { [weak self, weak alert] _ in
            guard let self else { return }
            let typed = alert?.textFields?.first?.text ?? ""
            let label = (alert?.textFields?.last?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard let url = Self.link(typed) else {
                let refusal = UIAlertController(title: Strings.Stories.invalidLink, message: nil, preferredStyle: .alert)
                refusal.addAction(UIAlertAction(title: Strings.Stories.done, style: .default))
                present(refusal, animated: true)
                return
            }
            add(.link(id: ClientID.make(), url: url, label: label.isEmpty ? nil : String(label.prefix(64)), style: .white, color: nil, transform: StoryTransform(x: 0.5, y: 0.5, scale: 1, rotation: 0)), "link")
            StoriesHaptics.play(.stickerDrop)
        })
        present(alert, animated: true)
    }

    /// An absolute http or https URL without a user or password, as the
    /// API keeps links; a bare host is taken as https.
    static func link(_ typed: String) -> String? {
        var text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.contains("://") { text = "https://" + text }
        guard text.count <= 2_048, let parts = URLComponents(string: text), let scheme = parts.scheme?.lowercased(),
              scheme == "http" || scheme == "https", let host = parts.host, !host.isEmpty, host.contains("."),
              parts.user == nil, parts.password == nil else { return nil }
        return text
    }

    // MARK: Caption

    private func captionChanged() {
        if caption.markedTextRange == nil, let text = caption.text, text.count > StoryCanvas.maxCaption {
            caption.text = String(text.prefix(StoryCanvas.maxCaption))
        }
        draft.caption = caption.text ?? ""
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return true
    }

    /// Typing a caption dims the canvas and lifts the field over the keyboard.
    func textFieldDidBeginEditing(_ textField: UITextField) {
        if framesShown { toggleFrames() }
        select(nil)
        UIView.animate(withDuration: 0.25) {
            self.captionDim.alpha = 1
            for view in [self.closeButton, self.tools, self.postButton, self.framesButton] as [UIView] { view.alpha = 0 }
        }
    }

    func textFieldDidEndEditing(_ textField: UITextField) {
        UIView.animate(withDuration: 0.25) {
            self.captionDim.alpha = 0
            for view in [self.closeButton, self.tools, self.postButton, self.framesButton] as [UIView] { view.alpha = 1 }
        }
    }

    @objc private func keyboardChanged(_ note: Notification) {
        guard let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let local = view.convert(end, from: nil)
        keyboard = note.name == UIResponder.keyboardWillHideNotification ? 0 : max(0, view.bounds.maxY - local.minY)
        view.setNeedsLayout()
        UIView.animate(withDuration: 0.25) { self.view.layoutIfNeeded() }
    }

    // MARK: Round video

    @objc private func roundVideoHeld(_ hold: UILongPressGestureRecognizer) {
        switch hold.state {
        case .began: recordRoundVideo(locked: false)
        case .ended:
            // Let go: what was held is the recording, unless it was locked.
            if let recorder, !recorder.locked { recorder.finish() }
        case .cancelled, .failed: recorder?.cancel()
        default: break
        }
    }

    /// Opens the round camera over the editor, recording at once; a tap
    /// locks it, a hold records while held.
    private func recordRoundVideo(locked: Bool) {
        guard recorder == nil, draft.current != nil, !saving else { return }
        caption.resignFirstResponder()
        select(nil)
        note("round:record")
        let recorder = StoryRoundVideoRecorder(frame: view.bounds)
        recorder.onFinish = { [weak self] recording in self?.recorded(recording) }
        view.addSubview(recorder)
        self.recorder = recorder
        recorder.start()
        if locked { recorder.lock() }
    }

    /// The recording lands on the frame as a circle, low on the left, to be
    /// dragged and pinched like any overlay; it replaces the frame's last one.
    private func recorded(_ recording: StoryRoundVideoRecorder.Recording?) {
        recorder?.removeFromSuperview()
        recorder = nil
        guard let recording else { return note("round:none") }
        files.append(recording.file)
        let id = ClientID.make()
        guard draft.setRoundVideo(id: id, file: recording.file, durationMs: recording.durationMs, mirrored: recording.mirrored, transform: StoryTransform(x: 0.26, y: 0.7, scale: 0.34, rotation: 0)) else { return }
        note("round:\(recording.durationMs)")
        selected = id
        render()
        canvas.play()
    }

    // MARK: Saving

    /// Sends the device's files once, makes or edits the draft, and with
    /// `post` posts the version just saved.
    private func commit(post: Bool, closes: Bool = false) {
        guard !saving, !draft.frames.isEmpty else { return }
        caption.resignFirstResponder()
        select(nil)
        saving = true
        busyShown(true, draft.uploads.contains { uploaded[$0.frameId] == nil } ? Strings.Stories.uploading : Strings.Stories.saving)
        render()
        let store = session.store
        let client = session.client
        StoriesHaptics.prepare(.post, .refused)
        Task { [weak self] in
            guard let self else { return }
            var stage = "save"
            do {
                for upload in draft.uploads where uploaded[upload.frameId] == nil {
                    let file = upload.file
                    let data = try await Task.detached(priority: .userInitiated) { try Data(contentsOf: file) }.value
                    uploaded[upload.frameId] = try await client.upload(data)
                }
                busyShown(true, Strings.Stories.saving)
                var story: Story
                let inputs = try draft.inputs(uploaded: uploaded)
                if draft.isNew {
                    story = try await store.create(id: draft.storyId, caption: draft.sentCaption, frames: inputs)
                } else if draft.hasChanges {
                    // The version this editor began from: a newer one is a conflict, not overwritten.
                    story = try await store.update(draft.storyId, version: draft.original?.version, caption: .some(draft.sentCaption), frames: inputs)
                } else {
                    story = draft.original!
                }
                note("saved:\(story.artifactVersion)")
                // From here it is an edit of what was saved; the files are its own.
                adopt(story, ours: true)
                if post, story.status == .draft {
                    stage = "post"
                    story = try await store.post(story.id, artifactVersion: story.artifactVersion)
                    StoriesHaptics.play(.post)
                    note("posted")
                }
                saving = false
                busyShown(false, nil)
                if post || closes { finish(story) } else { render() }
            } catch {
                saving = false
                busyShown(false, nil)
                render()
                StoriesHaptics.play(.refused)
                note("refused:\(stage)")
                let refusal = StoryRefusal(error)
                if refusal?.isConflict == true, !draft.isNew {
                    conflicted(post: post, closes: closes, stage: stage, message: refusal?.message)
                    return
                }
                let alert = UIAlertController(title: stage == "post" ? Strings.Stories.postFailed : Strings.Stories.saveFailed, message: refusal?.message, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: Strings.Stories.done, style: .default))
                present(alert, animated: true)
            }
        }
    }

    /// A 409. When the story was saved elsewhere since this editor read it,
    /// a save offers the newer version or these edits kept over it; a post
    /// shows the newer version, to be posted only once seen. A deleted story
    /// or one with nothing to show is refused as the daemon says.
    private func conflicted(post: Bool, closes: Bool, stage: String, message: String?) {
        let client = session.client
        let storyId = draft.storyId
        let base = draft.original
        Task { [weak self] in
            let latest = try? await client.story(storyId)
            guard let self else { return }
            guard let latest, latest.status != .deleted, latest.version != base?.version || latest.artifactVersion != base?.artifactVersion else {
                let alert = UIAlertController(title: stage == "post" ? Strings.Stories.postFailed : Strings.Stories.saveFailed, message: message, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: Strings.Stories.done, style: .default))
                present(alert, animated: true)
                return
            }
            if stage == "post" {
                adopt(latest, ours: false)
                note("conflict:latest")
                render()
                let alert = UIAlertController(title: Strings.Stories.newerVersion, message: Strings.Stories.newerVersionDetail, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: Strings.Stories.done, style: .default))
                present(alert, animated: true)
                return
            }
            let alert = UIAlertController(title: Strings.Stories.newerVersion, message: Strings.Stories.newerVersionDetail, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: Strings.Stories.useLatest, style: .default) { [weak self] _ in
                self?.adopt(latest, ours: false)
                self?.note("conflict:latest")
                self?.render()
            })
            alert.addAction(UIAlertAction(title: Strings.Stories.overwrite, style: .default) { [weak self] _ in
                guard let self else { return }
                draft.rebase(on: latest)
                note("conflict:mine")
                render()
                commit(post: post, closes: closes)
            })
            alert.addAction(UIAlertAction(title: Strings.Stories.cancel, style: .cancel))
            present(alert, animated: true)
        }
    }

    /// Edits `story` from here on: the frames are the story's own now.
    /// `ours` (this editor's own save) keeps drawing its frames from the
    /// device; another's version is read afresh.
    private func adopt(_ story: Story, ours: Bool) {
        let selectedId = draft.current?.id
        draft = StoryDraft(editing: story)
        if let index = draft.frames.firstIndex(where: { $0.id == selectedId }) { draft.select(index) }
        caption.text = draft.caption
        uploaded = [:]
        if ours {
            let kept = Set(draft.frames.map(\.id))
            local = local.filter { kept.contains($0.key) }
        } else {
            local = [:]
            thumbImages = [:]
        }
        selected = nil
    }

    private func busyShown(_ shown: Bool, _ text: String?) {
        busy.isHidden = !shown
        busyLabel.text = text
        if shown { busySpinner.startAnimating() } else { busySpinner.stopAnimating() }
        view.bringSubviewToFront(busy)
    }

    // MARK: Closing

    private func close() {
        guard !saving else { return }
        guard draft.hasChanges else { return finish(draft.original) }
        let sheet = UIAlertController(title: Strings.Stories.discardChanges, message: Strings.Stories.discardDetail, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: Strings.Stories.discard, style: .destructive) { [weak self] _ in self?.finish(nil) })
        sheet.addAction(UIAlertAction(title: Strings.Stories.saveDraft, style: .default) { [weak self] _ in self?.commit(post: false, closes: true) })
        sheet.addAction(UIAlertAction(title: Strings.Stories.keepEditing, style: .cancel))
        sheet.popoverPresentationController?.sourceView = closeButton
        sheet.popoverPresentationController?.sourceRect = closeButton.bounds
        present(sheet, animated: true)
    }

    private func finish(_ story: Story?) {
        canvas.stop()
        let files = files
        Task.detached { for file in files { try? FileManager.default.removeItem(at: file) } }
        let done = onFinish
        dismiss(animated: true) { done?(story) }
    }
}

/// The selected overlay's dashed frame, as Telegram draws it: white dashes
/// around it (a ring around a sticker), and a handle at either side that
/// grows and turns it.
final class StorySelectionView: UIView {
    /// A handle dragged: how much larger, and how far turned, since it began.
    var onHandle: ((UIGestureRecognizer.State, CGFloat, CGFloat) -> Void)?
    private let border = CAShapeLayer()
    private let handles = [CAShapeLayer(), CAShapeLayer()]
    private var start: CGVector = .zero
    private var outset: CGFloat = 4

    override init(frame: CGRect) {
        super.init(frame: frame)
        isHidden = true
        border.fillColor = nil
        border.strokeColor = UIColor(white: 1, alpha: 0.75).cgColor
        border.lineWidth = 2
        border.lineCap = .round
        layer.addSublayer(border)
        for handle in handles {
            handle.fillColor = UIColor(Palette.storiesEditorHandle).cgColor
            handle.strokeColor = UIColor.white.cgColor
            handle.lineWidth = 1.33
            handle.path = UIBezierPath(ovalIn: CGRect(x: -4.5, y: -4.5, width: 9, height: 9)).cgPath
            layer.addSublayer(handle)
        }
        let pan = UIPanGestureRecognizer(target: self, action: #selector(dragged(_:)))
        addGestureRecognizer(pan)
        accessibilityIdentifier = "story-editor-selection"
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Frames a box of `size` at `center`, turned by `rotation`.
    func show(size: CGSize, center: CGPoint, rotation: CGFloat, outset: CGFloat, oval: Bool) {
        self.outset = outset
        transform = .identity
        bounds = CGRect(origin: .zero, size: CGSize(width: size.width + 2 * outset, height: size.height + 2 * outset))
        self.center = center
        transform = CGAffineTransform(rotationAngle: rotation)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let box = bounds
        let path: UIBezierPath
        let perimeter: CGFloat
        let count: CGFloat
        if oval {
            let side = max(box.width, box.height)
            let ring = CGRect(x: box.midX - side / 2, y: box.midY - side / 2, width: side, height: side)
            path = UIBezierPath(ovalIn: ring)
            perimeter = .pi * side
            count = 10
            handles[0].position = CGPoint(x: ring.minX, y: box.midY)
            handles[1].position = CGPoint(x: ring.maxX, y: box.midY)
        } else {
            let radius = min(11, box.height / 2)
            path = UIBezierPath(roundedRect: box, cornerRadius: radius)
            perimeter = 2 * (box.width + box.height - radius * (4 - .pi))
            count = 12
            handles[0].position = CGPoint(x: box.minX, y: box.midY)
            handles[1].position = CGPoint(x: box.maxX, y: box.midY)
        }
        let dash = perimeter / count * 0.25
        border.lineDashPattern = [NSNumber(value: Double(dash)), NSNumber(value: Double(dash))]
        border.path = path.cgPath
        CATransaction.commit()
    }

    /// Only the handles take touches, and only their outer halves on a
    /// small overlay: the rest falls through to the canvas.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let reach = min(22, max(10, bounds.width / 4))
        return handles.contains { handle in
            let outward = handle.position.x < bounds.midX ? point.x <= handle.position.x + reach / 2 : point.x >= handle.position.x - reach / 2
            return outward && hypot(point.x - handle.position.x, point.y - handle.position.y) <= reach
        }
    }

    @objc private func dragged(_ pan: UIPanGestureRecognizer) {
        guard let parent = superview else { return }
        let finger = pan.location(in: parent)
        let vector = CGVector(dx: finger.x - center.x, dy: finger.y - center.y)
        switch pan.state {
        case .began:
            start = vector
            onHandle?(.began, 1, 0)
        case .changed:
            let length = hypot(start.dx, start.dy)
            guard length > 1 else { return }
            let scale = hypot(vector.dx, vector.dy) / length
            // The angle between the two, never across atan2's ±π seam.
            let turn = atan2(start.dx * vector.dy - start.dy * vector.dx, start.dx * vector.dx + start.dy * vector.dy)
            onHandle?(.changed, scale, turn)
        default:
            onHandle?(pan.state, 1, 0)
        }
    }
}

/// Telegram's bin: a ring at the canvas's foot with a can in it, whose lid
/// lifts as an overlay comes over it.
final class StoryBinView: UIView {
    var circle: CGRect = .zero { didSet { setNeedsLayout() } }
    var open = false {
        didSet {
            guard open != oldValue else { return }
            UIView.animate(withDuration: 0.2, delay: 0, usingSpringWithDamping: 0.6, initialSpringVelocity: 0) {
                self.ring.transform = self.open ? CGAffineTransform(scaleX: 1.15, y: 1.15) : .identity
                self.lid.transform = self.open ? CGAffineTransform(translationX: -2, y: -3).rotated(by: -0.45) : .identity
            }
            accessibilityValue = open ? "open" : nil
        }
    }

    private let ring = UIView()
    private let can = UIImageView(image: StoryEditorIcons.binCan)
    private let lid = UIImageView(image: StoryEditorIcons.binLid)

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        ring.layer.borderColor = UIColor.white.cgColor
        ring.backgroundColor = UIColor(white: 0, alpha: 0.2)
        addSubview(ring)
        ring.addSubview(can)
        ring.addSubview(lid)
        accessibilityIdentifier = "story-editor-trash"
        isAccessibilityElement = true
        accessibilityLabel = Strings.Stories.trash
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let transform = ring.transform
        ring.transform = .identity
        ring.frame = circle
        ring.layer.cornerRadius = circle.width / 2
        // A stroke 5 of the ring's 160.
        ring.layer.borderWidth = max(1.5, circle.width * 5 / 160)
        ring.transform = transform
        let icon = CGRect(x: (circle.width - 30) / 2, y: (circle.height - 30) / 2, width: 30, height: 30)
        can.frame = icon
        lid.transform = .identity
        lid.frame = icon
        if open { lid.transform = CGAffineTransform(translationX: -2, y: -3).rotated(by: -0.45) }
    }
}

private extension UIFont {
    /// The same font in SF Rounded, as Telegram's buttons use.
    var rounded: UIFont {
        guard let descriptor = fontDescriptor.withDesign(.rounded) else { return self }
        return UIFont(descriptor: descriptor, size: pointSize)
    }
}
#endif
