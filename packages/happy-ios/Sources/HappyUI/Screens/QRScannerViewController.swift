#if canImport(UIKit)
import HappyCore
import HappyLayout
import OSLog
import UIKit

/// Full-screen camera QR scanner. Reports the first QR code it reads, or nil
/// when closed, then dismisses itself. It never judges a code: the caller
/// says what a wrong one is, so none is ignored. Without camera access it explains
/// why and offers the Settings app; in the simulator there is no camera, so
/// it says so. The camera is the app's one engine (`CameraEngine`) in its
/// QR mode.
public final class QRScannerViewController: UIViewController {
    /// Called exactly once.
    public var onFinish: ((String?) -> Void)?
    /// The other ways in, under ⋯ at the top right (entering a link,
    /// restoring, the server): each closes the scanner, then runs.
    var otherWays: [ScannerWay] = []

    private enum Mode {
        case scanning
        case denied
        case restricted
        case unavailable
    }

    private var mode: Mode = .scanning {
        didSet { if mode != oldValue { updateMode() } }
    }

    /// Internal so a test can stand in for it.
    let camera: CameraEngine
    private var observation: CameraObservation?
    private let overlay = ScannerOverlayView()
    private let hintLabel = StyledLabel(style: TextStyles.scannerHint, color: ColorToken(light: .white, dark: .white), alignment: .center)
    private let messageLabel = StyledLabel(style: TextStyles.scannerMessage, color: Palette.text, alignment: .center)
    private let settingsButton = RoundButton(title: Strings.Scanner.openSettings)
    private let closeButton = UIButton(type: .system)
    private let moreButton = UIButton(type: .system)
    private var finished = false
    private var viewfinder: CGRect?
    /// The last area handed to the camera, so a layout that changes
    /// nothing sends nothing.
    private var scanArea: CGRect?
    private static let log = Logger(subsystem: "engineering.happy", category: "scan")

    public convenience init() {
        self.init(camera: DeviceCamera())
    }

    init(camera: CameraEngine) {
        self.camera = camera
        super.init(nibName: nil, bundle: nil)
        // The system scanner happy-app opens follows the text size.
        followsTextSize()
        modalPresentationStyle = .fullScreen
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        view.addSubview(camera.preview)
        view.addSubview(overlay)
        hintLabel.string = Strings.Scanner.hint
        view.addSubview(hintLabel)
        view.addSubview(messageLabel)
        settingsButton.onTap = {
            guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
            UIApplication.shared.open(url)
        }
        view.addSubview(settingsButton)
        // happy-app shows the system scanner, so there is no RN icon to
        // match; Ionicons' close, as happy-app's own close buttons use.
        closeButton.setImage(.icon(.ionicons("close"), size: 22), for: .normal)
        closeButton.tintColor = .white
        closeButton.backgroundColor = UIColor(white: 0, alpha: 0.4)
        closeButton.layer.cornerRadius = QRScannerLayout.Metrics.closeButtonSize / 2
        closeButton.accessibilityLabel = Strings.Scanner.close
        closeButton.addTarget(self, action: #selector(close), for: .touchUpInside)
        view.addSubview(closeButton)
        moreButton.setImage(UIImage(systemName: "ellipsis", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold)), for: .normal)
        moreButton.backgroundColor = closeButton.backgroundColor
        moreButton.layer.cornerRadius = QRScannerLayout.Metrics.closeButtonSize / 2
        moreButton.accessibilityLabel = Strings.Start.more
        moreButton.accessibilityIdentifier = "scanner-more"
        moreButton.showsMenuAsPrimaryAction = true
        moreButton.menu = UIMenu(children: otherWays.map { way in
            UIAction(title: way.title, image: UIImage(systemName: way.symbol)) { [weak self] _ in self?.finish(nil, then: way.run) }
        })
        moreButton.isHidden = otherWays.isEmpty
        view.addSubview(moreButton)
        // Before the camera starts, so no code it reads is dropped.
        camera.onCodes = { [weak self] codes in
            guard let code = codes.first else { return }
            self?.found(code)
        }
        updateMode()
        observation = camera.observe { [weak self] state in self?.apply(state) }
        // Started as the screen loads, so the camera warms while it slides up.
        camera.run(CameraConfiguration(mode: .qr), asking: true)
    }

    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let mode: QRScannerLayout.Mode = switch self.mode {
        case .scanning: .scanning(hint: hintLabel.measurable)
        case .denied, .restricted, .unavailable: .message(text: messageLabel.measurable, button: settingsButton.measurable)
        }
        let layout = QRScannerLayout(.init(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets), mode: mode))
        camera.preview.frame = layout.preview
        overlay.frame = layout.preview
        overlay.viewfinder = layout.viewfinder
        if let frame = layout.hint { hintLabel.setLayoutFrame(frame) }
        if let frame = layout.message { messageLabel.setLayoutFrame(frame) }
        if let frame = layout.button { settingsButton.setLayoutFrame(frame) }
        closeButton.setLayoutFrame(layout.close)
        // The close button's mirror at the right.
        moreButton.setLayoutFrame(CGRect(x: view.bounds.width - layout.close.maxX, y: layout.close.minY, width: layout.close.width, height: layout.close.height))
        viewfinder = layout.viewfinder
        updateScanArea()
    }

    public override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        CameraPerf.watch("qr-open")
    }

    public override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        #if DEBUG
        // A UI test hands the scanner the code it would have read: the
        // simulator has no camera, and a phone's can't be aimed.
        if let code = ProcessInfo.processInfo.environment["HAPPY_SIMULATED_SCAN"], !code.isEmpty { found(code) }
        #endif
    }

    public override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        camera.stop()
    }

    public override var preferredStatusBarStyle: UIStatusBarStyle {
        mode == .scanning ? .lightContent : .default
    }

    private func apply(_ state: CameraState) {
        mode = switch state.availability {
        case .denied, .notDetermined: .denied
        case .restricted: .restricted
        case .noCamera: .unavailable
        case .unknown, .ready: .scanning
        }
        let hint = switch state.interruption {
        case .inUse: Strings.Camera.inUse
        case .multitasking: Strings.Camera.multitasking
        case .systemPressure: Strings.Camera.systemPressure
        case .audio, .background, nil: Strings.Scanner.hint
        }
        if hintLabel.string != hint {
            hintLabel.string = hint
            view.setNeedsLayout()
        }
        updateScanArea()
    }

    private func updateMode() {
        let scanning = mode == .scanning
        view.backgroundColor = scanning ? .black : UIColor(Palette.groupedBackground)
        camera.preview.isHidden = !scanning
        overlay.isHidden = !scanning
        hintLabel.isHidden = !scanning
        messageLabel.isHidden = scanning
        settingsButton.isHidden = mode != .denied
        closeButton.tintColor = scanning ? .white : UIColor(Palette.text)
        moreButton.tintColor = closeButton.tintColor
        messageLabel.string = switch mode {
        case .denied: Strings.Modals.cameraPermissionsRequiredToScanQr
        case .restricted: Strings.Camera.restricted
        case .scanning, .unavailable: Strings.Scanner.unavailable
        }
        setNeedsStatusBarAppearanceUpdate()
        view.setNeedsLayout()
    }

    /// Reads only inside the viewfinder, so a second code nearby is ignored:
    /// on every layout and every turn, from the picture the preview shows
    /// (`QRScannerLayout.scanArea`).
    private func updateScanArea() {
        let state = camera.state
        guard state.running, let viewfinder, let video = state.videoSize, camera.preview.bounds.width > 0 else { return }
        let area = QRScannerLayout.scanArea(viewfinder: viewfinder, preview: camera.preview.bounds.size, video: video, rotation: state.previewRotation)
        guard area != scanArea else { return }
        scanArea = area
        Self.log.debug("scan area \(String(describing: area), privacy: .public), rotation \(state.previewRotation, privacy: .public)")
        camera.setScanArea(area)
    }

    private func found(_ value: String) {
        Self.log.debug("read a code of \(value.utf8.count) bytes")
        guard !finished else { return }
        finish(value)
    }

    @objc private func close() {
        finish(nil)
    }

    private func finish(_ value: String?, then next: (() -> Void)? = nil) {
        guard !finished else { return }
        finished = true
        camera.stop()
        let onFinish = onFinish
        dismiss(animated: true) {
            onFinish?(value)
            next?()
        }
    }
}

/// One of the scanner's other ways in.
struct ScannerWay {
    var title: String
    var symbol: String
    var run: () -> Void
}

/// Dims everything but the viewfinder and outlines it.
final class ScannerOverlayView: UIView {
    var viewfinder: CGRect? {
        didSet { if viewfinder != oldValue { update() } }
    }

    private let dimming = CAShapeLayer()
    private let outline = CAShapeLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        dimming.fillRule = .evenOdd
        dimming.fillColor = UIColor(Palette.scannerDimming).cgColor
        outline.fillColor = UIColor.clear.cgColor
        outline.strokeColor = UIColor.white.cgColor
        outline.lineWidth = 3
        layer.addSublayer(dimming)
        layer.addSublayer(outline)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        update()
    }

    private func update() {
        let path = UIBezierPath(rect: bounds)
        guard let viewfinder else {
            dimming.path = path.cgPath
            outline.path = nil
            return
        }
        let radius = QRScannerLayout.Metrics.viewfinderCornerRadius
        let hole = UIBezierPath(roundedRect: viewfinder, cornerRadius: radius)
        path.append(hole)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        dimming.frame = bounds
        outline.frame = bounds
        dimming.path = path.cgPath
        outline.path = hole.cgPath
        CATransaction.commit()
    }
}

#endif
