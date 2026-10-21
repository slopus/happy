#if canImport(UIKit)
import AVFoundation
import HappyLayout
import UIKit

/// Full-screen camera QR scanner. Reports the first code it reads that
/// `accepts` lets through, or nil when closed, then dismisses itself. Without camera access it explains
/// why and offers the Settings app; in the simulator there is no camera, so
/// it says so.
public final class QRScannerViewController: UIViewController {
    /// Called exactly once.
    public var onFinish: ((String?) -> Void)?
    /// Codes this rejects are ignored and scanning goes on.
    public var accepts: (String) -> Bool = { _ in true }

    private enum Mode {
        case scanning
        case denied
        case unavailable
    }

    private var mode: Mode = .scanning {
        didSet { updateMode() }
    }

    private let capture = CaptureSession()
    private let previewLayer: AVCaptureVideoPreviewLayer
    private let overlay = ScannerOverlayView()
    private let hintLabel = StyledLabel(style: TextStyles.scannerHint, color: ColorToken(light: .white, dark: .white), alignment: .center)
    private let messageLabel = StyledLabel(style: TextStyles.scannerMessage, color: Palette.text, alignment: .center)
    private let settingsButton = RoundButton(title: Strings.Scanner.openSettings)
    private let closeButton = UIButton(type: .system)
    private var finished = false

    public init() {
        previewLayer = AVCaptureVideoPreviewLayer(session: capture.session)
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
        previewLayer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(previewLayer)
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
        updateMode()
        start()
    }

    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let mode: QRScannerLayout.Mode = switch self.mode {
        case .scanning: .scanning(hint: hintLabel.measurable)
        case .denied, .unavailable: .message(text: messageLabel.measurable, button: settingsButton.measurable)
        }
        let layout = QRScannerLayout(.init(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets), mode: mode))
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        previewLayer.frame = layout.preview
        CATransaction.commit()
        overlay.frame = layout.preview
        overlay.viewfinder = layout.viewfinder
        if let frame = layout.hint { hintLabel.setLayoutFrame(frame) }
        if let frame = layout.message { messageLabel.setLayoutFrame(frame) }
        if let frame = layout.button { settingsButton.setLayoutFrame(frame) }
        closeButton.setLayoutFrame(layout.close)
        updateScanArea(layout.viewfinder)
    }

    public override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        capture.stop()
    }

    public override var preferredStatusBarStyle: UIStatusBarStyle {
        mode == .scanning ? .lightContent : .default
    }

    private func updateMode() {
        let scanning = mode == .scanning
        view.backgroundColor = scanning ? .black : UIColor(Palette.groupedBackground)
        previewLayer.isHidden = !scanning
        overlay.isHidden = !scanning
        hintLabel.isHidden = !scanning
        messageLabel.isHidden = scanning
        settingsButton.isHidden = mode != .denied
        closeButton.tintColor = scanning ? .white : UIColor(Palette.text)
        messageLabel.string = mode == .denied ? Strings.Modals.cameraPermissionsRequiredToScanQr : Strings.Scanner.unavailable
        setNeedsStatusBarAppearanceUpdate()
        view.setNeedsLayout()
    }

    private func start() {
        Task { @MainActor [weak self] in
            guard await Self.cameraAccess() else {
                self?.mode = .denied
                return
            }
            let started = await self?.capture.start { [weak self] value in
                self?.found(value)
            }
            if started == false { self?.mode = .unavailable }
        }
    }

    private static func cameraAccess() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: true
        case .notDetermined: await AVCaptureDevice.requestAccess(for: .video)
        default: false
        }
    }

    /// Reads only inside the viewfinder, so a second code nearby is ignored.
    private func updateScanArea(_ viewfinder: CGRect?) {
        guard let viewfinder, previewLayer.frame.width > 0 else { return }
        capture.setRectOfInterest(previewLayer.metadataOutputRectConverted(fromLayerRect: viewfinder))
    }

    private func found(_ value: String) {
        guard !finished, accepts(value) else { return }
        finish(value)
    }

    @objc private func close() {
        finish(nil)
    }

    private func finish(_ value: String?) {
        guard !finished else { return }
        finished = true
        capture.stop()
        let onFinish = onFinish
        dismiss(animated: true) {
            onFinish?(value)
        }
    }
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

/// The capture session and its queue. AVCaptureSession is not Sendable and
/// startRunning blocks, so every call goes through one serial queue.
private final class CaptureSession: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "engineering.happy.scanner")
    private let output = AVCaptureMetadataOutput()
    private var configured = false
    // Read and written on the main queue only.
    private var onCode: (@MainActor (String) -> Void)?

    /// Configures on first use and starts. False when there is no camera.
    @MainActor
    func start(onCode: @escaping @MainActor (String) -> Void) async -> Bool {
        self.onCode = onCode
        return await withCheckedContinuation { continuation in
            queue.async {
                guard self.configureIfNeeded() else {
                    continuation.resume(returning: false)
                    return
                }
                if !self.session.isRunning {
                    self.session.startRunning()
                }
                continuation.resume(returning: true)
            }
        }
    }

    func stop() {
        queue.async {
            if self.session.isRunning {
                self.session.stopRunning()
            }
        }
    }

    func setRectOfInterest(_ rect: CGRect) {
        queue.async {
            guard self.configured else { return }
            self.output.rectOfInterest = rect
        }
    }

    private func configureIfNeeded() -> Bool {
        if configured { return true }
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else {
            return false
        }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        guard session.canAddInput(input), session.canAddOutput(output) else { return false }
        session.addInput(input)
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        guard output.availableMetadataObjectTypes.contains(.qr) else { return false }
        output.metadataObjectTypes = [.qr]
        configured = true
        return true
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        let values = metadataObjects.compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }
        guard let value = values.first else { return }
        // The delegate queue is .main.
        MainActor.assumeIsolated {
            onCode?(value)
        }
    }
}
#endif
