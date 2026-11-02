#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

extension AttachMenuEnvironment {
    /// The camera the menu's cell shows live and the full camera takes
    /// over. Tests swap it before the menu opens.
    static var cameraEngine: () -> CameraEngine = {
        #if DEBUG || HAPPY_FIXTURES
        // Screenshots in the simulator: `-attachCamera fake`.
        if ProcessInfo.processInfo.arguments.contains("-attachCamera") { return FixtureCamera() }
        #endif
        return CameraEnvironment.engine()
    }
}

/// The camera's cell, two pictures tall, after Telegram's
/// (`TGAttachmentCameraView`, `MediaPickerScreen`): the back camera live,
/// a full-screen camera's picture cropped to the cell, with the camera's
/// glyph at its top right. Until the first picture arrives, and whenever
/// the camera can't be shown (not asked yet, denied, no camera), it is
/// black with the glyph.
///
/// Its camera is the app's engine in photo mode, so the full camera that
/// opens from it (`lend()`) takes the running session as it is, and gives
/// it back (`takeBack()`) still running.
///
/// It runs itself: the camera starts once the cell is in a window, the
/// app in front and the cell scrolled into its scroll view's bounds, and
/// stops when any of that ends. It never asks for access; the full camera
/// does. Starting and stopping are the engine's, off the main thread.
final class AttachCameraTile: UIControl {
    let camera: CameraEngine
    /// Asked to run: the camera starts once it would show.
    private(set) var running = false
    /// The first picture has come since the cell was made.
    private(set) var live = false
    /// The full camera has it, until `takeBack()`.
    private(set) var lent = false
    /// Paused by `pause()`, until `resume()`.
    private var paused = false
    private var background = UIApplication.shared.applicationState == .background
    /// Telegram's `isCameraPreviewVisible`: the cell meets its scroll view's bounds.
    private(set) var onScreen = true
    private var scrolling: NSKeyValueObservation?
    private var observation: CameraObservation?

    private let content = UIView()
    private let previewHost = UIView()
    /// The black over the preview until the first picture.
    let fade = UIView()
    /// Telegram's glyph, at the top right.
    let icon = IconView(.ionicons("camera"), size: AttachCameraTileLayout.Metrics.glyph, tint: Palette.attachMenuCameraGlyph)

    init(camera: CameraEngine = AttachMenuEnvironment.cameraEngine()) {
        self.camera = camera
        super.init(frame: .zero)
        backgroundColor = UIColor(Palette.attachMenuCamera)
        clipsToBounds = true
        content.isUserInteractionEnabled = false
        addSubview(content)
        previewHost.isUserInteractionEnabled = false
        previewHost.addSubview(camera.preview)
        content.addSubview(previewHost)
        fade.backgroundColor = UIColor(Palette.attachMenuCamera)
        fade.isUserInteractionEnabled = false
        content.addSubview(fade)
        content.addSubview(icon)
        for view in [content, previewHost, fade, icon] { view.accessibilityIgnoresInvertColors = true }
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityIdentifier = "attach-camera"
        accessibilityLabel = Strings.AttachMenu.camera
        accessibilityHint = Strings.AttachMenu.cameraHint
        NotificationCenter.default.addObserver(self, selector: #selector(enteredBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(enteringForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
        observation = camera.observe { [weak self] state in self?.apply(state) }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    // MARK: Running

    /// The full camera takes the engine as it runs; the cell lets go of
    /// its picture and no longer starts or stops it.
    func lend() -> CameraEngine {
        lent = true
        running = false
        return camera
    }

    /// The engine back from the full camera, its picture in the cell again.
    func takeBack() {
        guard lent else { return }
        lent = false
        previewHost.addSubview(camera.preview)
        camera.preview.transform = .identity
        setNeedsLayout()
        layoutIfNeeded()
        update()
    }

    /// Holds the camera, as Telegram does while something covers the menu.
    func pause() {
        paused = true
        update()
    }

    func resume() {
        paused = false
        update()
    }

    /// Whether the camera would show now.
    private var wanted: Bool {
        window != nil && !isHidden && !background && onScreen && !paused
    }

    private func update() {
        guard !lent else { return }
        let wanted = wanted
        guard wanted != running else { return }
        running = wanted
        if wanted {
            // The back camera as the full camera opens on it, so opening
            // it reconfigures nothing.
            camera.run(CameraConfiguration(mode: .photo, position: .back), asking: false)
        } else {
            camera.stop()
        }
    }

    /// The first picture fades in over the black, as Telegram's preview
    /// does: 0.3 s, linear, after 0.05.
    private func apply(_ state: CameraState) {
        guard state.previewing, running || lent, !live else { return }
        live = true
        UIView.animate(withDuration: 0.3, delay: 0.05, options: [.curveLinear, .beginFromCurrentState]) {
            self.fade.alpha = 0
        }
    }

    @objc private func enteredBackground() {
        background = true
        update()
    }

    @objc private func enteringForeground() {
        background = false
        update()
    }

    // MARK: Where it is

    override var isHidden: Bool {
        didSet { if isHidden != oldValue { update() } }
    }

    override var frame: CGRect {
        didSet { if frame != oldValue { checkOnScreen() } }
    }

    override func didMoveToSuperview() {
        super.didMoveToSuperview()
        scrolling?.invalidate()
        scrolling = (superview as? UIScrollView)?.observe(\.contentOffset) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.checkOnScreen() }
        }
        checkOnScreen()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { setNeedsLayout() }
        update()
    }

    private func checkOnScreen() {
        onScreen = (superview as? UIScrollView).map { $0.bounds.intersects(frame) } ?? true
        update()
    }

    // MARK: Drawing

    override var isHighlighted: Bool {
        didSet { content.alpha = isHighlighted ? 0.6 : 1 }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let screen = window?.windowScene?.screen.bounds.size ?? bounds.size
        let layout = AttachCameraTileLayout(size: bounds.size, screenWidth: min(screen.width, screen.height), scale: traitCollection.displayScale)
        content.frame = bounds
        fade.frame = bounds
        icon.frame = layout.glyph
        previewHost.transform = .identity
        previewHost.bounds = CGRect(origin: .zero, size: layout.previewSize)
        previewHost.center = layout.previewCenter
        previewHost.transform = CGAffineTransform(scaleX: layout.previewScale, y: layout.previewScale)
        guard !lent else { return }
        camera.preview.frame = previewHost.bounds
    }
}
#endif
