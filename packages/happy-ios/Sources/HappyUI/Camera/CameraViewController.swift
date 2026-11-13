#if canImport(UIKit)
import AVKit
import HappyCore
import HappyIcons
import HappyLayout
import ImageIO
import UIKit

/// The full camera, for photos: Telegram's camera (`CameraScreen`,
/// `CaptureControlsComponent`, the legacy `TGCameraController`) laid out
/// and moving as it does, doing what the system camera does.
///
/// - The picture is the engine's (`CameraEngine`), the same session the
///   attach menu's tile was showing: it grows out of the tile and goes
///   back into it, and nothing restarts.
/// - Lenses: the system camera's buttons (.5, 1×, 2, 3, 5 as the device
///   has them) that glide to their zoom, and a pinch between them; the
///   virtual camera switches lenses and to macro by itself.
/// - A tap focuses and exposes there, a long press locks both ("AE/AF
///   Lock"), a drag beside the square moves the exposure two stops either
///   way.
/// - Flash auto, on or off; on the front camera the screen is the flash,
///   the system's where it lights it, Telegram's white screen where not.
/// - The timer (3 s, 10 s), the grid, the shapes 4:3, 16:9 and square.
/// - The volume buttons take the photo, as in the Camera app.
/// - On a phone the screen stays upright and its buttons turn to read
///   upright; photos are upright as the device is held.
///
/// After the shot, the system camera's review: Retake or Use Photo. In
/// the attach menu (`onShot`) it keeps shooting instead, as Telegram's
/// does: each shot goes to the menu, a counter at the bottom left shows
/// how many and opens their strip.
@MainActor
final class CameraViewController: UIViewController, UIGestureRecognizerDelegate {
    /// Called once the camera's own views have gone, still presented: the
    /// photo to use, or nil when closed. The owner dismisses it.
    var onFinish: ((CameraPhoto?) -> Void)?
    /// Each photo as it is taken, the camera running on; no review.
    var onShot: ((CameraPhoto) -> Void)?
    /// A shot in the strip tapped, by its place (oldest first).
    var onOpenShot: ((Int) -> Void)?
    /// Just before the camera leaves with a photo, so what is under it
    /// (the attach menu) can go first.
    var onWillUse: (() -> Void)?
    /// The attach menu's tile in this view's space: the picture grows out
    /// of it and goes back into it. Nil slides the camera up and down.
    var tile: (() -> CGRect?)?

    let camera: CameraEngine
    /// What the buttons chose, kept while the app runs as the system
    /// camera keeps its own; the timer and the lens start over each time.
    private static var kept = CameraSettings()
    private(set) var settings: CameraSettings {
        didSet {
            var kept = settings
            kept.timer = .off
            kept.front = false
            Self.kept = kept
        }
    }

    enum Phase: Equatable {
        case opening
        case live
        /// The timer runs, this many seconds left.
        case counting(Int)
        case capturing
        case review(CameraPhoto)
        case leaving
    }

    private(set) var phase: Phase = .opening
    private var observation: CameraObservation?
    private(set) var state = CameraState()
    private(set) var locked = false
    private var focusPoint: CGPoint?
    private var biasAtDrag: Double = 0
    private var zoomAtPinch: Double = 1
    private var lastFlip: CFTimeInterval = 0
    private var flippingTo: CameraPosition?
    private var countdown: Timer?
    private var brightness: ScreenBrightness?
    private var layout: CameraScreenLayout?
    private var reviewImage: UIImage?

    private let ground = UIView()
    private let previewClip = UIView()
    private let cropTop = UIView()
    private let cropBottom = UIView()
    private let gridLines = (0..<4).map { _ in UIView() }
    private let flipBlur = UIVisualEffectView(effect: nil)
    let focusView = CameraFocusView()
    private let banner = UIView()
    private let bannerLabel = StyledLabel(style: TextStyles.cameraBanner, color: Palette.cameraBannerText, lines: 1, alignment: .center)
    private let countdownLabel = StyledLabel(style: TextStyles.cameraCountdown, color: Palette.cameraControl, lines: 1, alignment: .center)
    private let messageLabel = StyledLabel(style: TextStyles.cameraMessage, color: Palette.cameraControl, alignment: .center)
    private let settingsButton = RoundButton(title: Strings.Camera.openSettings)
    /// Everything but the picture, which fades in as the picture grows.
    private let controls = UIView()
    let closeButton = CameraIconButton(identifier: "camera-close")
    let timerButton = CameraIconButton(identifier: "camera-timer")
    let aspectButton = CameraIconButton(identifier: "camera-aspect")
    let gridButton = CameraIconButton(identifier: "camera-grid")
    let flashButton = CameraIconButton(identifier: "camera-flash")
    let zoomBar = CameraZoomBar()
    let shutter = CameraShutterButton()
    let flipButton = CameraIconButton(identifier: "camera-flip", glyphSize: 28)
    /// The front camera's flash where the system has none: the screen.
    let screenFlash = UIView()
    let review = UIView()
    private let reviewPhoto = UIImageView()
    private let reviewBar = UIView()
    let retakeButton = UIButton(type: .system)
    let useButton = UIButton(type: .system)
    private var events: AVCaptureEventInteraction?
    /// The shots taken, their counter and strip (`TGMediaPickerPhotoCounterButton`,
    /// `TGMediaPickerPhotoStripView`).
    let shotsButton = CameraShotsButton()
    private let strip = UIScrollView()
    private var stripViews: [UIImageView] = []
    private var stripOpen = false

    init(camera: CameraEngine) {
        self.camera = camera
        settings = Self.kept
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalPresentationCapturesStatusBarAppearance = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        traitCollection.userInterfaceIdiom == .pad ? .all : .portrait
    }

    /// An iPad's full window: the controls in a column, the flash first.
    private var regular: Bool {
        traitCollection.horizontalSizeClass == .regular && traitCollection.verticalSizeClass == .regular
    }

    private var topButtons: [CameraIconButton] {
        regular ? [flashButton, timerButton, aspectButton, gridButton] : [timerButton, aspectButton, gridButton, flashButton]
    }

    // MARK: Building

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        view.accessibilityViewIsModal = true
        overrideUserInterfaceStyle = .dark
        ground.backgroundColor = UIColor(Palette.cameraGround)
        ground.alpha = 0
        view.addSubview(ground)

        previewClip.clipsToBounds = true
        previewClip.isAccessibilityElement = true
        previewClip.accessibilityLabel = Strings.Camera.preview
        previewClip.accessibilityHint = Strings.Camera.previewHint
        previewClip.accessibilityIdentifier = "camera-preview"
        view.addSubview(previewClip)
        previewClip.addSubview(camera.preview)
        for view in [cropTop, cropBottom] {
            view.backgroundColor = UIColor(Palette.cameraOutsideCrop)
            view.isUserInteractionEnabled = false
            previewClip.addSubview(view)
        }
        for line in gridLines {
            line.backgroundColor = UIColor(Palette.cameraGrid)
            line.isUserInteractionEnabled = false
            previewClip.addSubview(line)
        }
        flipBlur.isUserInteractionEnabled = false
        previewClip.addSubview(focusView)
        banner.backgroundColor = UIColor(Palette.cameraFocus)
        banner.layer.cornerRadius = 4
        banner.alpha = 0
        banner.isUserInteractionEnabled = false
        bannerLabel.string = Strings.Camera.locked
        banner.addSubview(bannerLabel)
        previewClip.addSubview(banner)
        countdownLabel.alpha = 0
        countdownLabel.isUserInteractionEnabled = false
        previewClip.addSubview(countdownLabel)
        messageLabel.isHidden = true
        previewClip.addSubview(messageLabel)
        settingsButton.isHidden = true
        settingsButton.onTap = {
            guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
            UIApplication.shared.open(url)
        }
        previewClip.addSubview(settingsButton)

        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
        hold.minimumPressDuration = 0.5
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:)))
        let drag = UIPanGestureRecognizer(target: self, action: #selector(dragged(_:)))
        drag.maximumNumberOfTouches = 1
        for recognizer in [tap, hold, pinch, drag] as [UIGestureRecognizer] {
            recognizer.delegate = self
            previewClip.addGestureRecognizer(recognizer)
        }

        controls.alpha = 0
        view.addSubview(controls)
        closeButton.show(icon: .ionicons("close"))
        closeButton.accessibilityLabel = Strings.Camera.close
        closeButton.addAction(UIAction { [weak self] _ in self?.close() }, for: .touchUpInside)
        timerButton.accessibilityLabel = Strings.Camera.timer
        timerButton.addAction(UIAction { [weak self] _ in self?.settings.timer = self?.settings.timer.next ?? .off; self?.showSettings() }, for: .touchUpInside)
        aspectButton.accessibilityLabel = Strings.Camera.aspect
        aspectButton.addAction(UIAction { [weak self] _ in self?.switchAspect() }, for: .touchUpInside)
        gridButton.accessibilityLabel = Strings.Camera.grid
        gridButton.addAction(UIAction { [weak self] _ in self?.settings.grid.toggle(); self?.showSettings() }, for: .touchUpInside)
        flashButton.accessibilityLabel = Strings.Camera.flash
        flashButton.addAction(UIAction { [weak self] _ in self?.settings.flash = self?.settings.flash.next ?? .auto; self?.showSettings() }, for: .touchUpInside)
        flipButton.show(icon: .ionicons("camera-reverse"))
        flipButton.backgroundColor = UIColor(Palette.cameraLens)
        flipButton.accessibilityLabel = Strings.Camera.flip
        flipButton.addAction(UIAction { [weak self] _ in self?.flip() }, for: .touchUpInside)
        zoomBar.onSelect = { [weak self] index in self?.selectLens(index) }
        shutter.addAction(UIAction { [weak self] _ in self?.shutterPressed() }, for: .touchUpInside)
        for view in [closeButton, timerButton, aspectButton, gridButton, flashButton, zoomBar, shutter, flipButton] as [UIView] {
            controls.addSubview(view)
        }
        shotsButton.isHidden = true
        shotsButton.addAction(UIAction { [weak self] _ in self?.toggleStrip() }, for: .touchUpInside)
        controls.addSubview(shotsButton)
        strip.showsHorizontalScrollIndicator = false
        strip.alpha = 0
        strip.isHidden = true
        strip.accessibilityIdentifier = "camera-shots"
        controls.addSubview(strip)

        review.isHidden = true
        review.backgroundColor = UIColor(Palette.cameraGround)
        reviewPhoto.contentMode = .scaleAspectFit
        reviewPhoto.accessibilityIgnoresInvertColors = true
        reviewPhoto.isAccessibilityElement = true
        reviewPhoto.accessibilityLabel = Strings.Camera.photo
        review.addSubview(reviewPhoto)
        reviewBar.backgroundColor = UIColor(Palette.cameraGround)
        review.addSubview(reviewBar)
        for (button, title, id) in [(retakeButton, Strings.Camera.retake, "camera-retake"), (useButton, Strings.Camera.usePhoto, "camera-use")] {
            button.setAttributedTitle(TextStyles.cameraReview.attributedString(title, color: UIColor(Palette.cameraControl)), for: .normal)
            button.accessibilityIdentifier = id
            review.addSubview(button)
        }
        retakeButton.addAction(UIAction { [weak self] _ in self?.retake() }, for: .touchUpInside)
        useButton.addAction(UIAction { [weak self] _ in self?.use() }, for: .touchUpInside)
        view.addSubview(review)

        screenFlash.backgroundColor = UIColor(Palette.cameraScreenFlash)
        screenFlash.alpha = 0
        screenFlash.isUserInteractionEnabled = false
        view.addSubview(screenFlash)

        // The volume buttons and Camera Control take the photo, as in the
        // Camera app: a press begins the shutter's press, its release shoots.
        let events = AVCaptureEventInteraction { [weak self] event in
            guard let self else { return }
            switch event.phase {
            case .began: shutter.isHighlighted = true
            case .ended: shutter.isHighlighted = false; shutterPressed()
            case .cancelled: shutter.isHighlighted = false
            @unknown default: break
            }
        }
        view.addInteraction(events)
        self.events = events

        showSettings()
        observation = camera.observe { [weak self] state in self?.apply(state) }
        // The tile's own run when it came from there: nothing reconfigures.
        camera.run(CameraConfiguration(mode: .photo, position: settings.front ? .front : .back), asking: true)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        CameraPerf.watch("camera-open")
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard phase == .opening else { return }
        open()
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let aspect = settings.effectiveAspect
        let labels = lensLabels()
        let layout = CameraScreenLayout(.init(
            size: view.bounds.size,
            safeArea: LayoutInsets(view.safeAreaInsets),
            previewRatio: aspect == .wide ? 16.0 / 9.0 : 4.0 / 3.0,
            cropRatio: CGFloat(aspect.ratio),
            regular: regular,
            topButtons: topButtons.count,
            lenses: labels.count > 1 ? labels.count : 0
        ))
        self.layout = layout
        ground.frame = view.bounds
        controls.frame = view.bounds
        screenFlash.frame = view.bounds
        if phase != .opening, phase != .leaving { placePreview(at: layout.preview, layout: layout) }
        let local = CGRect(origin: .zero, size: layout.preview.size)
        let crop = layout.cropInPreview
        for (band, frame) in zip([cropTop, cropBottom], layout.outside) { band.frame = frame }
        for (line, frame) in zip(gridLines, CameraScreenLayout.grid(in: crop)) { line.frame = frame }
        flipBlur.frame = local
        focusView.frame = local
        placeFocus(in: local)
        let placedBanner = CameraScreenLayout.banner(bannerLabel.sizeThatFits(.zero), in: crop)
        banner.frame = placedBanner.box
        bannerLabel.frame = placedBanner.label
        countdownLabel.frame = CameraScreenLayout.centred(countdownLabel.sizeThatFits(.zero), in: crop)
        let width = CameraScreenLayout.messageWidth(in: local)
        let text = messageLabel.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let message = CameraScreenLayout.message(text: text, button: settingsButton.isHidden ? nil : settingsButton.sizeThatFits(.zero), in: local)
        messageLabel.setLayoutFrame(message.text)
        if let button = message.button { settingsButton.setLayoutFrame(button) }

        closeButton.frame = layout.close
        for (button, frame) in zip(topButtons, layout.topButtons) { button.frame = frame }
        shutter.frame = layout.shutter
        flipButton.frame = layout.flip
        flipButton.layer.cornerRadius = layout.flip.width / 2
        // The counter mirrors the flip across the shutter, where the
        // system camera keeps its last photo.
        shotsButton.frame = CGRect(x: view.bounds.width - layout.flip.midX - 32, y: layout.flip.midY - 19, width: 64, height: 38)
        placeStrip(layout)
        zoomBar.frame = layout.zoomBar
        zoomBar.isHidden = labels.count < 2
        zoomBar.update(labels: labels.count > 1 ? labels : [], selected: state.lenses.stop(for: state.zoom), frames: layout.zoomItems, animated: false)

        review.frame = view.bounds
        if let image = reviewImage {
            let placed = CameraReviewLayout(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets), photo: image.size, retake: retakeButton.sizeThatFits(.zero), use: useButton.sizeThatFits(.zero))
            reviewPhoto.frame = placed.photo
            reviewBar.frame = placed.bar
            retakeButton.frame = placed.retake
            useButton.frame = placed.use
        }
    }

    /// The picture at `frame`, filled; mid-growth, in the clip at `frame`
    /// scaled to fill it from its full size.
    private func placePreview(at frame: CGRect, layout: CameraScreenLayout) {
        previewClip.frame = frame
        let full = layout.preview.size
        let scale = CameraScreenLayout.fillScale(full, into: frame.size)
        camera.preview.transform = .identity
        camera.preview.frame = CameraScreenLayout.centred(full, in: CGRect(origin: .zero, size: frame.size))
        camera.preview.transform = scale == 1 ? .identity : CGAffineTransform(scaleX: scale, y: scale)
    }

    private func placeFocus(in preview: CGRect) {
        let point = focusPoint ?? CGPoint(x: preview.midX, y: preview.midY)
        let square = CameraScreenLayout.focus(at: point, in: preview)
        let exposure = CameraScreenLayout.exposure(beside: square, in: preview, bias: CGFloat(state.exposureBias))
        focusView.place(square: square, track: exposure.track, sun: exposure.sun)
    }

    private func lensLabels() -> [String] {
        let lenses = state.lenses
        let selected = lenses.stop(for: state.zoom)
        return lenses.displayStops.enumerated().map { index, stop in
            index == selected ? CameraLenses.label(lenses.display(state.zoom), selected: true) : CameraLenses.label(stop, selected: false)
        }
    }

    // MARK: Opening and leaving

    /// Telegram's: out of the tile, the picture growing to its place on a
    /// spring while black comes up behind it and the buttons fade in; from
    /// below without one.
    private func open() {
        view.layoutIfNeeded()
        guard let layout else { return }
        let start = tile?().flatMap { $0.width > 0 ? $0 : nil }
        if let start {
            placePreview(at: start, layout: layout)
        } else {
            placePreview(at: layout.preview, layout: layout)
            view.transform = CGAffineTransform(translationX: 0, y: view.bounds.height)
            ground.alpha = 1
            controls.alpha = 1
        }
        let animator = UIViewPropertyAnimator(duration: 0.4, dampingRatio: start == nil ? 1 : 0.86) {
            self.view.transform = .identity
            self.placePreview(at: layout.preview, layout: layout)
            self.ground.alpha = 1
        }
        animator.addAnimations({ self.controls.alpha = 1 }, delayFactor: start == nil ? 0 : 0.25)
        animator.addCompletion { [weak self] _ in
            guard let self, phase == .opening else { return }
            phase = .live
            view.setNeedsLayout()
            updateControls()
        }
        animator.startAnimation()
    }

    /// Closed: back into the tile (still running, the tile shows it on), or
    /// down past the screen.
    func close() {
        guard phase != .leaving else { return }
        cancelCountdown()
        phase = .leaving
        events?.isEnabled = false
        let target = tile?().flatMap { $0.width > 0 ? $0 : nil }
        guard let layout, let target, review.isHidden else {
            camera.stop()
            UIView.animate(withDuration: 0.3, delay: 0, options: [.curveEaseIn]) {
                self.view.transform = CGAffineTransform(translationX: 0, y: self.view.bounds.height)
            } completion: { _ in self.finish(nil) }
            return
        }
        // Back to the tile's picture: the back camera, as wide as it was.
        if state.activePosition == .front || state.zoom != state.lenses.wideZoom {
            camera.setZoom(state.lenses.wideZoom, ramp: false)
        }
        focusView.hide()
        UIView.animate(withDuration: 0.15) { self.controls.alpha = 0 }
        let animator = UIViewPropertyAnimator(duration: 0.35, dampingRatio: 1) {
            self.placePreview(at: target, layout: layout)
            self.ground.alpha = 0
            self.cropTop.alpha = 0
            self.cropBottom.alpha = 0
        }
        animator.addCompletion { [weak self] _ in self?.finish(nil) }
        animator.startAnimation()
    }

    private func use() {
        guard case .review(let photo) = phase else { return }
        phase = .leaving
        events?.isEnabled = false
        onWillUse?()
        UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseInOut]) {
            self.view.alpha = 0
        } completion: { _ in self.finish(photo) }
    }

    private func finish(_ photo: CameraPhoto?) {
        restoreBrightness(animated: false)
        let onFinish = onFinish
        self.onFinish = nil
        onFinish?(photo)
    }

    // MARK: The camera's state

    private func apply(_ state: CameraState) {
        let old = self.state
        self.state = state
        if let flippingTo, state.activePosition == flippingTo, state.running {
            self.flippingTo = nil
            UIView.animate(withDuration: 0.4, delay: 0.1, options: [.beginFromCurrentState]) {
                self.flipBlur.effect = nil
            } completion: { _ in
                if self.flippingTo == nil { self.flipBlur.removeFromSuperview() }
            }
        }
        if state.lenses != old.lenses || state.zoom != old.zoom || state.availability != old.availability || state.interruption != old.interruption {
            view.setNeedsLayout()
        }
        if state.captureRotation != old.captureRotation { turnButtons(animated: true) }
        if state.flashScene != old.flashScene || state.hasFlash != old.hasFlash || state.activePosition != old.activePosition { showSettings() }
        if state.exposureBias != old.exposureBias, let layout { placeFocus(in: CGRect(origin: .zero, size: layout.preview.size)) }
        updateControls()
    }

    /// Why there is no picture, if there is none; the buttons that need
    /// one off without it.
    private func updateControls() {
        let message: String? = switch state.availability {
        case .denied: Strings.Camera.denied
        case .restricted: Strings.Camera.restricted
        case .noCamera: Strings.Camera.noCamera
        default: switch state.interruption {
            case .inUse: Strings.Camera.inUse
            case .multitasking: Strings.Camera.multitasking
            case .systemPressure: Strings.Camera.systemPressure
            case .audio: Strings.Camera.audio
            case .background, nil: nil
            }
        }
        messageLabel.string = message ?? ""
        let hidden = message == nil
        if messageLabel.isHidden != hidden || settingsButton.isHidden != (state.availability != .denied) {
            messageLabel.isHidden = hidden
            settingsButton.isHidden = state.availability != .denied
            view.setNeedsLayout()
        }
        let live = state.running && state.availability == .ready && state.interruption == nil
        shutter.isEnabled = live
        shutter.alpha = live ? 1 : 0.5
        flipButton.isEnabled = live && state.canFlip
        flipButton.isHidden = !state.canFlip
        events?.isEnabled = phase == .live || isCounting
    }

    private var isCounting: Bool {
        if case .counting = phase { return true }
        return false
    }

    /// The top buttons as the settings stand.
    private func showSettings() {
        switch settings.timer {
        case .off: timerButton.show(icon: .ionicons("timer-outline"))
        case .three, .ten: timerButton.show(icon: nil, text: Strings.Camera.timerSeconds(settings.timer.seconds), active: true)
        }
        timerButton.accessibilityValue = settings.timer == .off ? Strings.Camera.off : Strings.Camera.timerSeconds(settings.timer.seconds)
        let shape = switch settings.aspect {
        case .standard: "4:3"
        case .wide: "16:9"
        case .square: "1:1"
        }
        aspectButton.show(icon: nil, text: shape)
        aspectButton.accessibilityValue = shape
        gridButton.show(icon: .ionicons("grid-outline"), active: settings.grid)
        gridButton.accessibilityValue = settings.grid ? Strings.Camera.on : Strings.Camera.off
        switch settings.flash {
        case .auto: flashButton.show(icon: .ionicons("flash-outline"), active: state.flashScene)
        case .on: flashButton.show(icon: .ionicons("flash"), active: true)
        case .off: flashButton.show(icon: .ionicons("flash-off"))
        }
        flashButton.accessibilityValue = switch settings.flash {
        case .auto: Strings.Camera.flashAuto
        case .on: Strings.Camera.on
        case .off: Strings.Camera.off
        }
        // The back camera without a flash (some iPads) has nothing to offer.
        flashButton.isHidden = !state.hasFlash && !settings.front
        for line in gridLines { line.isHidden = !settings.grid }
    }

    /// The buttons turned to read upright as the device is held.
    private func turnButtons(animated: Bool) {
        guard traitCollection.userInterfaceIdiom != .pad else { return }
        let orientation: CameraScreenLayout.DeviceOrientation = switch Int(state.captureRotation.rounded()) {
        case 0: .landscapeLeft
        case 180: .landscapeRight
        case 270: .portraitUpsideDown
        default: .portrait
        }
        let angle = CameraScreenLayout.iconRotation(orientation)
        let turn = {
            for button in [self.closeButton, self.flipButton] + self.topButtons { button.rotation = angle }
            self.zoomBar.rotation = angle
            self.countdownLabel.transform = CGAffineTransform(rotationAngle: angle)
        }
        if animated { UIView.animate(withDuration: 0.3, delay: 0, options: [.beginFromCurrentState], animations: turn) } else { turn() }
    }

    // MARK: Buttons

    private func switchAspect() {
        settings.aspect = settings.aspect.next
        showSettings()
        CameraPerf.watch("aspect")
        UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseInOut, .beginFromCurrentState]) {
            self.view.setNeedsLayout()
            self.view.layoutIfNeeded()
        }
    }

    private func selectLens(_ index: Int) {
        let stops = state.lenses.stops
        guard stops.indices.contains(index), phase == .live || isCounting else { return }
        CameraPerf.watch("lens-switch")
        camera.setZoom(stops[index], ramp: true)
    }

    /// The other camera, with Telegram's turn: the picture flips over
    /// under a dark blur that lifts once the new camera's pictures come.
    /// At most one a second, as Telegram allows.
    func flip() {
        let now = CACurrentMediaTime()
        guard phase == .live, state.canFlip, now - lastFlip >= 1 else { return }
        lastFlip = now
        settings.front.toggle()
        let position: CameraPosition = settings.front ? .front : .back
        flippingTo = position
        CameraPerf.watch("flip")
        focusPoint = nil
        locked = false
        focusView.hide()
        hideBanner()
        if flipBlur.superview == nil { previewClip.insertSubview(flipBlur, aboveSubview: camera.preview) }
        UIView.transition(with: previewClip, duration: 0.4, options: [.transitionFlipFromLeft, .curveEaseOut]) {
            self.flipBlur.effect = UIBlurEffect(style: .dark)
        }
        showSettings()
        camera.run(CameraConfiguration(mode: .photo, position: position), asking: true)
    }

    // MARK: Focus, exposure, zoom

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        focus(at: recognizer.location(in: previewClip), lock: false)
    }

    @objc private func held(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began else { return }
        focus(at: recognizer.location(in: previewClip), lock: true)
    }

    /// Focus and exposure at a point of the picture; `lock` holds both
    /// until the next tap, with the system camera's banner.
    func focus(at point: CGPoint, lock: Bool) {
        guard phase == .live || isCounting, state.previewing else { return }
        focusPoint = point
        locked = lock
        camera.focus(at: previewClip.convert(point, to: camera.preview), lock: lock)
        placeFocus(in: previewClip.bounds)
        focusView.play(locked: lock)
        if lock { showBanner() } else { hideBanner() }
    }

    @objc private func pinched(_ recognizer: UIPinchGestureRecognizer) {
        switch recognizer.state {
        case .began:
            zoomAtPinch = state.zoom
        case .changed:
            camera.setZoom(state.lenses.pinched(from: zoomAtPinch, scale: Double(recognizer.scale)), ramp: false)
        default:
            break
        }
    }

    /// The exposure: up and down beside the square while it shows.
    @objc private func dragged(_ recognizer: UIPanGestureRecognizer) {
        switch recognizer.state {
        case .began:
            biasAtDrag = state.exposureBias
            focusView.wake(locked: locked)
        case .changed:
            camera.setExposureBias(CameraScreenLayout.exposureSlider(biasAtDrag, dragged: recognizer.translation(in: previewClip).y))
            focusView.wake(locked: locked)
        default:
            break
        }
    }

    func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
        guard let drag = recognizer as? UIPanGestureRecognizer else { return true }
        let velocity = drag.velocity(in: previewClip)
        return focusView.isShowing && abs(velocity.y) > abs(velocity.x)
    }

    private func showBanner() {
        UIView.animate(withDuration: 0.2) { self.banner.alpha = 1 }
    }

    private func hideBanner() {
        guard banner.alpha > 0 else { return }
        UIView.animate(withDuration: 0.2) { self.banner.alpha = 0 }
    }

    // MARK: The shot

    /// A press: the timer counts down first if set; a press while it
    /// counts stops it.
    func shutterPressed() {
        if isCounting { return cancelCountdown() }
        guard phase == .live, state.running else { return }
        guard settings.timer == .off else { return startCountdown(settings.timer.seconds) }
        shoot()
    }

    private func startCountdown(_ seconds: Int) {
        phase = .counting(seconds)
        tick(seconds)
        countdown = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, case .counting(let left) = self.phase else { return }
                if left <= 1 {
                    self.cancelCountdown()
                    self.shoot()
                } else {
                    self.phase = .counting(left - 1)
                    self.tick(left - 1)
                }
            }
        }
    }

    /// The count over the picture, each number in from larger.
    private func tick(_ seconds: Int) {
        countdownLabel.string = "\(seconds)"
        view.setNeedsLayout()
        view.layoutIfNeeded()
        countdownLabel.alpha = 1
        let turned = countdownLabel.transform
        countdownLabel.transform = turned.scaledBy(x: 1.3, y: 1.3)
        UIView.animate(withDuration: 0.3, delay: 0, options: [.curveEaseOut]) { self.countdownLabel.transform = turned }
    }

    private func cancelCountdown() {
        countdown?.invalidate()
        countdown = nil
        countdownLabel.alpha = 0
        if isCounting { phase = .live }
    }

    /// The front camera without a flash of its own lights the screen as
    /// Telegram does: full brightness and white, the photo 0.1 s after,
    /// both let go half a second later over 0.25 s.
    private func shoot() {
        let flash = settings.photoFlash
        let cameraFlashes = state.hasFlash
        phase = .capturing
        CameraPerf.watch("photo-capture", for: 1.5)
        guard settings.front, !cameraFlashes, flash != .off else { return take(flash) }
        if flash == .on { return lightScreen { self.take(.off) } }
        Task { [weak self] in
            guard let self else { return }
            let dark = await camera.sceneIsDark()
            guard phase == .capturing else { return }
            if settings.screenFlash(cameraFlashes: cameraFlashes, darkScene: dark) {
                lightScreen { self.take(.off) }
            } else {
                take(.off)
            }
        }
    }

    private func lightScreen(then shoot: @escaping () -> Void) {
        if let screen = view.window?.windowScene?.screen {
            brightness = ScreenBrightness(screen: screen)
            brightness?.set(1)
        }
        screenFlash.alpha = 1
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            shoot()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self?.restoreBrightness(animated: true) }
        }
    }

    private func restoreBrightness(animated: Bool) {
        guard screenFlash.alpha > 0 || brightness != nil else { return }
        brightness?.restore(over: animated ? 0.25 : 0)
        brightness = nil
        if animated {
            UIView.animate(withDuration: 0.25) { self.screenFlash.alpha = 0 }
        } else {
            screenFlash.alpha = 0
        }
    }

    private func take(_ flash: CameraSettings.Flash) {
        camera.capturePhoto(CameraShot(flash: flash, ratio: settings.effectiveAspect.ratio)) { [weak self] event in
            guard let self, phase == .capturing else { return }
            switch event {
            case .capturing:
                // Telegram's blink: the picture back in from black over 0.25 s.
                previewClip.alpha = 0
                UIView.animate(withDuration: 0.25) { self.previewClip.alpha = 1 }
            case .finished(let photo):
                if let onShot {
                    phase = .live
                    onShot(photo)
                } else {
                    showReview(photo)
                }
            case .failed:
                phase = .live
            }
        }
    }

    // MARK: Shots

    /// The shots so far, oldest first, as the menu has them (edited).
    func showShots(_ pictures: [UIImage]) {
        let added = pictures.count > stripViews.count
        shotsButton.count = pictures.count
        shotsButton.picture = pictures.last
        if shotsButton.isHidden, !pictures.isEmpty {
            shotsButton.isHidden = false
            shotsButton.transform = CGAffineTransform(scaleX: 0.1, y: 0.1)
            UIView.animate(withDuration: 0.4, delay: 0, usingSpringWithDamping: 0.6, initialSpringVelocity: 0) { self.shotsButton.transform = .identity }
        }
        shotsButton.isHidden = pictures.isEmpty
        for view in stripViews { view.removeFromSuperview() }
        stripViews = pictures.enumerated().map { index, picture in
            let view = UIImageView(image: picture)
            view.contentMode = .scaleAspectFill
            view.clipsToBounds = true
            view.layer.cornerRadius = 6
            view.isUserInteractionEnabled = true
            view.isAccessibilityElement = true
            view.accessibilityTraits = .button
            view.accessibilityLabel = Strings.Camera.photo
            view.accessibilityIdentifier = "camera-shot:\(index)"
            view.tag = index
            view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(shotTapped(_:))))
            strip.addSubview(view)
            return view
        }
        if let layout { placeStrip(layout) }
        if added, let picture = pictures.last { fly(picture) }
    }

    /// The shot just taken, out of the picture into its counter.
    private func fly(_ picture: UIImage) {
        guard let layout else { return }
        let flier = UIImageView(image: picture)
        flier.contentMode = .scaleAspectFill
        flier.clipsToBounds = true
        flier.layer.cornerRadius = 6
        flier.frame = layout.crop
        view.addSubview(flier)
        UIView.animate(withDuration: 0.35, delay: 0, options: [.curveEaseInOut]) {
            flier.frame = self.shotsButton.frame.insetBy(dx: 13, dy: 0)
            flier.alpha = 0.4
        } completion: { _ in flier.removeFromSuperview() }
    }

    /// The shot's thumbnail in the strip while it is open: the preview
    /// zooms out of it and back.
    func shotView(_ index: Int) -> UIView? {
        guard stripOpen, stripViews.indices.contains(index) else { return nil }
        return stripViews[index]
    }

    private func placeStrip(_ layout: CameraScreenLayout) {
        let side: CGFloat = 56, gap: CGFloat = 6
        let width = CGFloat(stripViews.count) * (side + gap) - gap
        let available = view.bounds.width - 32
        strip.frame = CGRect(x: 16 + max(0, (available - width) / 2), y: layout.shutter.minY - side - 8, width: min(available, max(0, width)), height: side)
        strip.contentSize = CGSize(width: max(0, width), height: side)
        for (index, thumbnail) in stripViews.enumerated() {
            thumbnail.frame = CGRect(x: CGFloat(index) * (side + gap), y: 0, width: side, height: side)
        }
    }

    private func toggleStrip() {
        stripOpen.toggle()
        shotsButton.open = stripOpen
        strip.isHidden = false
        UIView.animate(withDuration: 0.2) { self.strip.alpha = self.stripOpen ? 1 : 0 } completion: { _ in
            if !self.stripOpen { self.strip.isHidden = true }
        }
        if stripOpen { strip.scrollRectToVisible(CGRect(x: strip.contentSize.width - 1, y: 0, width: 1, height: 1), animated: false) }
    }

    @objc private func shotTapped(_ recognizer: UITapGestureRecognizer) {
        guard let index = recognizer.view?.tag else { return }
        onOpenShot?(index)
    }

    // MARK: Review

    /// The photo whole, read at the screen's size off the main thread; the
    /// camera stops while it shows.
    private func showReview(_ photo: CameraPhoto) {
        phase = .review(photo)
        events?.isEnabled = false
        camera.stop()
        let longEdge = Int(max(view.bounds.width, view.bounds.height) * traitCollection.displayScale)
        Task { [weak self] in
            let image = await Task.detached(priority: .userInitiated) { Self.picture(photo, longEdge: longEdge) }.value
            guard let self, case .review(let shown) = phase, shown == photo else { return }
            reviewImage = image
            reviewPhoto.image = image
            review.isHidden = false
            review.alpha = 0
            view.setNeedsLayout()
            view.layoutIfNeeded()
            UIView.animate(withDuration: 0.2) { self.review.alpha = 1 }
        }
    }

    nonisolated private static func picture(_ photo: CameraPhoto, longEdge: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(photo.data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: longEdge,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let cut = image.cropping(to: CameraCrop.rect(pixels: CGSize(width: image.width, height: image.height), ratio: CGFloat(photo.ratio))) ?? image
        return UIImage(cgImage: cut)
    }

    private func retake() {
        guard case .review = phase else { return }
        reviewImage = nil
        reviewPhoto.image = nil
        UIView.animate(withDuration: 0.2) { self.review.alpha = 0 } completion: { _ in
            if self.reviewImage == nil { self.review.isHidden = true }
        }
        phase = .live
        events?.isEnabled = true
        camera.run(CameraConfiguration(mode: .photo, position: settings.front ? .front : .back), asking: true)
    }
}

/// Telegram's photo counter: how many shots, the last one beside the
/// count; it opens and closes their strip.
final class CameraShotsButton: UIControl {
    var count = 0 {
        didSet {
            label.text = "\(count)"
            accessibilityLabel = Strings.PhotoEditor.shots(count)
            setNeedsLayout()
        }
    }
    var picture: UIImage? { didSet { thumbnail.image = picture } }
    var open = false { didSet { chevron.transform = open ? CGAffineTransform(rotationAngle: .pi) : .identity } }
    private let glass = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterialDark))
    private let thumbnail = UIImageView()
    private let label = UILabel()
    private let chevron = UIImageView(image: UIImage(systemName: "chevron.up", withConfiguration: UIImage.SymbolConfiguration(pointSize: 10, weight: .bold)))

    override init(frame: CGRect) {
        super.init(frame: frame)
        accessibilityIdentifier = "camera-shots-count"
        isAccessibilityElement = true
        accessibilityTraits = .button
        glass.isUserInteractionEnabled = false
        glass.clipsToBounds = true
        addSubview(glass)
        thumbnail.contentMode = .scaleAspectFill
        thumbnail.clipsToBounds = true
        thumbnail.layer.cornerRadius = 5
        label.font = .monospacedDigitSystemFont(ofSize: 15, weight: .semibold)
        label.textColor = .white
        chevron.tintColor = .white
        for view in [thumbnail, label, chevron] { glass.contentView.addSubview(view) }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var isHighlighted: Bool { didSet { alpha = isHighlighted ? 0.6 : 1 } }

    override func layoutSubviews() {
        super.layoutSubviews()
        glass.frame = bounds
        glass.layer.cornerRadius = bounds.height / 2
        thumbnail.frame = CGRect(x: 5, y: 5, width: bounds.height - 10, height: bounds.height - 10)
        label.sizeToFit()
        label.frame.origin = CGPoint(x: thumbnail.frame.maxX + 6, y: (bounds.height - label.bounds.height) / 2)
        chevron.sizeToFit()
        chevron.center = CGPoint(x: max(label.frame.maxX + 8, bounds.width - 12), y: bounds.midY)
    }
}

/// The screen's brightness, raised for a front shot and eased back after,
/// as Telegram's `animateBrightnessChange` does on each frame.
@MainActor
private final class ScreenBrightness: NSObject {
    private let screen: UIScreen
    private let original: CGFloat
    private var link: CADisplayLink?
    private var from: CGFloat = 0
    private var started: CFTimeInterval = 0
    private var duration: CFTimeInterval = 0

    init(screen: UIScreen) {
        self.screen = screen
        original = screen.brightness
    }

    func set(_ value: CGFloat) {
        screen.brightness = value
    }

    func restore(over seconds: CFTimeInterval) {
        guard seconds > 0 else { screen.brightness = original; return }
        from = screen.brightness
        started = CACurrentMediaTime()
        duration = seconds
        let link = CADisplayLink(target: self, selector: #selector(step))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func step() {
        let t = min(1, (CACurrentMediaTime() - started) / duration)
        screen.brightness = from + (original - from) * CGFloat(t)
        if t >= 1 {
            link?.invalidate()
            link = nil
        }
    }
}
#endif
