#if canImport(UIKit)
import AVFoundation
import HappyCore
import HappyLayout
import OSLog
import UIKit

/// The device's camera behind `CameraEngine`. This half lives on the main
/// thread: the preview layer, its rotation, what the screens observe.
/// Everything that touches the session is `CaptureCore`'s, on its queue,
/// after Telegram's camera (`Camera/CameraLegacy`: `LegacyCamera`,
/// `CameraDevice`), whose context runs on a queue of its own and hands its
/// state back as signals.
@MainActor
final class DeviceCamera: CameraEngine {
    private(set) var state = CameraState() {
        didSet { if state != oldValue { notify() } }
    }

    let preview: CameraPreviewView
    var onCodes: (@MainActor ([String]) -> Void)?
    private let layer: AVCaptureVideoPreviewLayer
    /// Internal so a test can hand its metadata delegate a code.
    let core = CaptureCore()
    private var observers: [Int: @MainActor (CameraState) -> Void] = [:]
    private var nextObserver = 0
    /// Each `run` and `stop`, so an access prompt answered late runs nothing.
    private var generation = 0
    private var rotation: AVCaptureDevice.RotationCoordinator?
    private var rotationObservation: NSKeyValueObservation?
    private var rotationDevice: String?
    private var previewingObservation: NSKeyValueObservation?
    nonisolated(unsafe) private var thermalObserver: NSObjectProtocol?
    /// When the run that has no picture yet began, for the first frame's time.
    private var runStartedAt: CFTimeInterval?
    nonisolated static let log = Logger(subsystem: "engineering.happy", category: "camera")

    init() {
        layer = AVCaptureVideoPreviewLayer(session: core.session)
        layer.videoGravity = .resizeAspectFill
        preview = CameraPreviewView(surface: layer)
        core.onEvent = { [weak self] event in
            Task { @MainActor in self?.apply(event) }
        }
        // The metadata delegate's queue is the main one.
        core.onCodes = { [weak self] codes in
            MainActor.assumeIsolated { self?.onCodes?(codes) }
        }
        previewingObservation = layer.observe(\.isPreviewing, options: [.new]) { [weak self] layer, _ in
            let previewing = layer.isPreviewing
            Task { @MainActor in self?.previewing(previewing) }
        }
        thermalObserver = NotificationCenter.default.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: nil) { [weak self] _ in
            let thermal = CameraThermal(ProcessInfo.processInfo.thermalState)
            Task { @MainActor in self?.thermal(thermal) }
        }
        state.thermal = CameraThermal(ProcessInfo.processInfo.thermalState)
        core.setThermal(state.thermal)
    }

    deinit {
        if let thermalObserver { NotificationCenter.default.removeObserver(thermalObserver) }
    }

    func observe(_ handler: @escaping @MainActor (CameraState) -> Void) -> CameraObservation {
        let id = nextObserver
        nextObserver += 1
        observers[id] = handler
        handler(state)
        return CameraObservation { [weak self] in self?.observers[id] = nil }
    }

    private func notify() {
        let state = state
        for handler in observers.values { handler(state) }
    }

    // MARK: Running

    func run(_ configuration: CameraConfiguration, asking: Bool) {
        generation += 1
        let generation = generation
        if !state.previewing || state.configuration?.position != configuration.position { runStartedAt = CACurrentMediaTime() }
        state.configuration = configuration
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            core.run(configuration)
        case .notDetermined:
            // No camera (the simulator) says so without asking for one.
            Task { [weak self, core] in
                guard await core.hasCamera(configuration.position) else {
                    if self?.generation == generation { self?.state.availability = .noCamera }
                    return
                }
                guard asking else {
                    if self?.generation == generation { self?.state.availability = .notDetermined }
                    return
                }
                let granted = await AVCaptureDevice.requestAccess(for: .video)
                guard let self, self.generation == generation else { return }
                if granted { core.run(configuration) } else { state.availability = .denied }
            }
        case .restricted:
            state.availability = .restricted
        default:
            state.availability = .denied
        }
    }

    func stop() {
        generation += 1
        state.configuration = nil
        runStartedAt = nil
        core.stop()
    }

    func setZoom(_ zoom: Double, ramp: Bool) {
        let zoom = min(state.lenses.maxZoom, max(state.lenses.minZoom, zoom))
        state.zoom = zoom
        core.setZoom(zoom, ramp: ramp)
    }

    func focus(at point: CGPoint?, lock: Bool) {
        // The layer fills the preview, so their points are the same.
        core.focus(at: point.map { layer.captureDevicePointConverted(fromLayerPoint: $0) }, lock: lock)
    }

    func setScanArea(_ area: CGRect) {
        core.setScanArea(area)
    }

    // MARK: What comes back

    private func apply(_ event: CaptureCore.Event) {
        switch event {
        case .configured(let snapshot):
            state.availability = .ready
            state.running = snapshot.running
            state.lenses = snapshot.lenses
            state.zoom = snapshot.zoom
            state.videoSize = snapshot.videoSize
            state.hasTorch = snapshot.hasTorch
            follow(snapshot.device)
        case .stopped:
            state.running = false
        case .noCamera:
            state.availability = .noCamera
            state.running = false
        case .interrupted(let reason):
            state.interruption = reason
        case .resumed:
            state.interruption = nil
        case .zoom(let zoom):
            state.zoom = zoom
        }
    }

    private func previewing(_ previewing: Bool) {
        state.previewing = previewing
        guard previewing, let started = runStartedAt else { return }
        runStartedAt = nil
        let milliseconds = (CACurrentMediaTime() - started) * 1000
        state.firstFrameMilliseconds = milliseconds
        let mode = String(describing: state.configuration?.mode)
        Self.log.info("first frame \(Int(milliseconds), privacy: .public) ms (\(mode, privacy: .public))")
    }

    private func thermal(_ thermal: CameraThermal) {
        state.thermal = thermal
        core.setThermal(thermal)
        Self.log.info("thermal \(String(describing: thermal), privacy: .public)")
    }

    /// The preview upright whichever way the device and the window turn
    /// (an iPad's split, Slide Over and windows included), as the
    /// coordinator works it out from both. A new one for each device: a
    /// flip changes it.
    private func follow(_ handle: CaptureCore.DeviceHandle) {
        guard rotationDevice != handle.device.uniqueID else { return }
        rotationDevice = handle.device.uniqueID
        let coordinator = AVCaptureDevice.RotationCoordinator(device: handle.device, previewLayer: layer)
        rotation = coordinator
        rotate(to: coordinator.videoRotationAngleForHorizonLevelPreview)
        rotationObservation = coordinator.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.new]) { [weak self] coordinator, _ in
            let angle = coordinator.videoRotationAngleForHorizonLevelPreview
            Task { @MainActor in self?.rotate(to: angle) }
        }
    }

    private func rotate(to angle: CGFloat) {
        guard let connection = layer.connection, connection.isVideoRotationAngleSupported(angle) else { return }
        if connection.videoRotationAngle != angle {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            connection.videoRotationAngle = angle
            CATransaction.commit()
        }
        state.previewRotation = angle
    }
}

extension CameraThermal {
    init(_ state: ProcessInfo.ThermalState) {
        switch state {
        case .fair: self = .fair
        case .serious: self = .serious
        case .critical: self = .critical
        default: self = .nominal
        }
    }
}

/// The capture session and everything that touches it, on one serial
/// queue: AVCaptureSession is not Sendable, and starting, stopping and
/// configuring it block. Nothing here runs on the main thread except the
/// metadata delegate, whose work is a handful of strings.
final class CaptureCore: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    /// A device, handed to the main thread for its rotation coordinator.
    struct DeviceHandle: @unchecked Sendable {
        let device: AVCaptureDevice
    }

    struct Snapshot: Sendable {
        var device: DeviceHandle
        var running: Bool
        var lenses: CameraLenses
        var zoom: Double
        var videoSize: CGSize
        var hasTorch: Bool
    }

    enum Event: Sendable {
        case configured(Snapshot)
        case stopped
        case noCamera
        case interrupted(CameraInterruption)
        case resumed
        case zoom(Double)
    }

    let session = AVCaptureSession()
    /// Set before the session first runs, read on the queue.
    nonisolated(unsafe) var onEvent: (@Sendable (Event) -> Void)?
    /// Called on the main queue, the metadata delegate's.
    nonisolated(unsafe) var onCodes: ((([String]) -> Void))?
    private let queue = DispatchQueue(label: "engineering.happy.camera", qos: .userInitiated)
    // Everything below only on `queue`.
    private var configuration: CameraConfiguration?
    private var wanted = false
    private var input: AVCaptureDeviceInput?
    private var device: AVCaptureDevice? { input?.device }
    private let metadata = AVCaptureMetadataOutput()
    private var lenses = CameraLenses.single
    private var thermal = CameraThermal.nominal
    private var scanArea = CGRect(x: 0, y: 0, width: 1, height: 1)
    private var zoomObservation: NSKeyValueObservation?
    private var log: Logger { DeviceCamera.log }

    override init() {
        super.init()
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(interrupted(_:)), name: AVCaptureSession.wasInterruptedNotification, object: session)
        center.addObserver(self, selector: #selector(resumed(_:)), name: AVCaptureSession.interruptionEndedNotification, object: session)
        center.addObserver(self, selector: #selector(failed(_:)), name: AVCaptureSession.runtimeErrorNotification, object: session)
    }

    // MARK: Commands, from the main thread

    func hasCamera(_ position: CameraPosition) async -> Bool {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: Self.camera(position) != nil) }
        }
    }

    func run(_ configuration: CameraConfiguration) {
        queue.async { self.start(configuration) }
    }

    func stop() {
        queue.async {
            self.wanted = false
            if self.session.isRunning {
                self.session.stopRunning()
                self.log.debug("stopped")
            }
            self.onEvent?(.stopped)
        }
    }

    func setZoom(_ zoom: Double, ramp: Bool) {
        queue.async { self.zoom(to: zoom, ramp: ramp) }
    }

    func focus(at point: CGPoint?, lock: Bool) {
        queue.async { self.focus(point, lock: lock) }
    }

    func setThermal(_ thermal: CameraThermal) {
        queue.async {
            self.thermal = thermal
            self.applyFrameRate()
        }
    }

    /// The rect of interest, and the zoom that keeps a code filling it in
    /// focus on a camera that can't switch to its ultra wide for that.
    func setScanArea(_ area: CGRect) {
        queue.async {
            self.scanArea = area
            guard self.configuration?.mode == .qr, let device = self.device else { return }
            self.metadata.rectOfInterest = area
            let focus = device.isVirtualDevice || area.width >= 1 ? 1 : QRScannerLayout.focusZoom(
                minimumFocusDistance: Float(device.minimumFocusDistance),
                fieldOfView: device.activeFormat.videoFieldOfView,
                fill: area.width
            )
            self.zoom(to: self.lenses.wideZoom * Double(focus), ramp: false)
        }
    }

    // MARK: On the queue

    /// A virtual camera with an ultra wide one switches to it for a subject
    /// held close, as the Camera app does for macro; the wide camera alone
    /// focuses no nearer than about 20 cm on recent iPhones. The front
    /// camera is the wide one (TrueDepth's depth is not wanted).
    private static func camera(_ position: CameraPosition) -> AVCaptureDevice? {
        switch position {
        case .back:
            for type: AVCaptureDevice.DeviceType in [.builtInTripleCamera, .builtInDualWideCamera, .builtInDualCamera, .builtInWideAngleCamera] {
                if let device = AVCaptureDevice.default(type, for: .video, position: .back) { return device }
            }
            return AVCaptureDevice.default(for: .video)
        case .front:
            return AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front)
        }
    }

    private func start(_ configuration: CameraConfiguration) {
        dispatchPrecondition(condition: .onQueue(queue))
        wanted = true
        if configuration != self.configuration || input == nil {
            guard configure(configuration) else {
                self.configuration = nil
                onEvent?(.noCamera)
                return
            }
        }
        if !session.isRunning {
            let started = CACurrentMediaTime()
            session.startRunning()
            log.debug("started in \(Int((CACurrentMediaTime() - started) * 1000), privacy: .public) ms")
        }
        report()
    }

    /// Reconfigures in one transaction, so a running session swaps its
    /// outputs and camera without stopping. False when the camera can't do
    /// the mode.
    private func configure(_ configuration: CameraConfiguration) -> Bool {
        let started = CACurrentMediaTime()
        let previous = self.configuration
        var newDevice = false
        session.beginConfiguration()
        // On an iPad another app in front, in a split, Slide Over or a
        // window, would stop the camera.
        if session.isMultitaskingCameraAccessSupported, !session.isMultitaskingCameraAccessEnabled {
            session.isMultitaskingCameraAccessEnabled = true
        }
        if previous?.position != configuration.position || input == nil {
            if let input { session.removeInput(input) }
            input = nil
            guard let device = Self.camera(configuration.position),
                  let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
                session.commitConfiguration()
                return false
            }
            session.addInput(input)
            self.input = input
            newDevice = true
        }
        let preset: AVCaptureSession.Preset = switch configuration.mode {
        case .qr: .high
        case .photo: .photo
        case .video: .high
        }
        if session.sessionPreset != preset, session.canSetSessionPreset(preset) {
            session.sessionPreset = preset
        }
        let wantsMetadata = configuration.mode == .qr
        if wantsMetadata, !session.outputs.contains(metadata) {
            guard session.canAddOutput(metadata) else {
                session.commitConfiguration()
                return false
            }
            session.addOutput(metadata)
            metadata.setMetadataObjectsDelegate(self, queue: .main)
        } else if !wantsMetadata, session.outputs.contains(metadata) {
            session.removeOutput(metadata)
        }
        if wantsMetadata {
            guard metadata.availableMetadataObjectTypes.contains(.qr) else {
                session.commitConfiguration()
                return false
            }
            metadata.metadataObjectTypes = [.qr]
            metadata.rectOfInterest = scanArea
        }
        session.commitConfiguration()
        self.configuration = configuration
        prepareDevice(resetZoom: newDevice)
        log.debug("configured \(String(describing: configuration.mode), privacy: .public) \(String(describing: configuration.position), privacy: .public) in \(Int((CACurrentMediaTime() - started) * 1000), privacy: .public) ms")
        return true
    }

    /// Continuous focus and exposure, the frame rate the warmth allows, and
    /// for a camera just chosen, the zoom at the Camera app's 1×.
    private func prepareDevice(resetZoom: Bool) {
        guard let device else { return }
        lenses = CameraLenses(
            hasUltraWide: device.constituentDevices.contains { $0.deviceType == .builtInUltraWideCamera },
            switchOvers: device.virtualDeviceSwitchOverVideoZoomFactors.map(\.doubleValue),
            secondaryNative: device.activeFormat.secondaryNativeResolutionZoomFactors.map(Double.init),
            minZoom: Double(device.minAvailableVideoZoomFactor),
            maxZoom: Double(device.maxAvailableVideoZoomFactor)
        )
        lock(device) { device in
            if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
            if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
            if device.isSmoothAutoFocusSupported { device.isSmoothAutoFocusEnabled = configuration?.mode == .video }
            device.isSubjectAreaChangeMonitoringEnabled = false
            if resetZoom { device.videoZoomFactor = CGFloat(lenses.wideZoom) }
        }
        applyFrameRate()
        zoomObservation = device.observe(\.videoZoomFactor, options: [.new]) { [weak self] device, _ in
            self?.onEvent?(.zoom(Double(device.videoZoomFactor)))
        }
        NotificationCenter.default.removeObserver(self, name: AVCaptureDevice.subjectAreaDidChangeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(subjectAreaChanged(_:)), name: AVCaptureDevice.subjectAreaDidChangeNotification, object: device)
        let dimensions = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
        log.debug("camera \(device.deviceType.rawValue, privacy: .public), \(dimensions.width, privacy: .public)×\(dimensions.height, privacy: .public), lenses \(self.lenses.displayStops, privacy: .public), focuses from \(device.minimumFocusDistance, privacy: .public) mm")
    }

    /// 30 frames a second, or what the warmth allows (`CameraThermal`).
    private func applyFrameRate() {
        guard let device else { return }
        let wanted = thermal.frameRate(30)
        let ranges = device.activeFormat.videoSupportedFrameRateRanges
        guard let top = ranges.map(\.maxFrameRate).max(), let bottom = ranges.map(\.minFrameRate).min() else { return }
        let rate = min(top, max(bottom, wanted))
        let duration = CMTime(value: 1000, timescale: CMTimeScale(rate * 1000))
        lock(device) { device in
            device.activeVideoMinFrameDuration = duration
            device.activeVideoMaxFrameDuration = duration
        }
    }

    private func report() {
        guard let device else { return }
        let dimensions = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
        onEvent?(.configured(Snapshot(
            device: DeviceHandle(device: device),
            running: session.isRunning,
            lenses: lenses,
            zoom: Double(device.videoZoomFactor),
            videoSize: CGSize(width: CGFloat(dimensions.width), height: CGFloat(dimensions.height)),
            hasTorch: device.hasTorch
        )))
    }

    private func zoom(to zoom: Double, ramp: Bool) {
        guard let device else { return }
        let zoom = CGFloat(min(lenses.maxZoom, max(lenses.minZoom, zoom)))
        lock(device) { device in
            let zoom = min(max(zoom, device.minAvailableVideoZoomFactor), device.maxAvailableVideoZoomFactor)
            if ramp {
                // Telegram's and the system camera's lens buttons glide.
                device.ramp(toVideoZoomFactor: zoom, withRate: 16)
            } else {
                if device.isRampingVideoZoom { device.cancelVideoZoomRamp() }
                if device.videoZoomFactor != zoom { device.videoZoomFactor = zoom }
            }
        }
    }

    /// A tap focuses and exposes there and lets go when the scene changes,
    /// as Telegram's `CameraDevice.setFocusPoint` does; a lock holds both
    /// until the next tap. Nil goes back to continuous, in the middle.
    private func focus(_ point: CGPoint?, lock locked: Bool) {
        guard let device else { return }
        let continuous = point == nil
        let point = point ?? CGPoint(x: 0.5, y: 0.5)
        lock(device) { device in
            let focusMode: AVCaptureDevice.FocusMode = continuous ? .continuousAutoFocus : .autoFocus
            let exposureMode: AVCaptureDevice.ExposureMode = continuous ? .continuousAutoExposure : .autoExpose
            if device.isFocusPointOfInterestSupported, device.isFocusModeSupported(focusMode) {
                device.focusPointOfInterest = point
                device.focusMode = focusMode
            }
            if device.isExposurePointOfInterestSupported, device.isExposureModeSupported(exposureMode) {
                device.exposurePointOfInterest = point
                device.exposureMode = exposureMode
            }
            device.isSubjectAreaChangeMonitoringEnabled = !continuous && !locked
        }
    }

    private func lock(_ device: AVCaptureDevice, _ change: (AVCaptureDevice) -> Void) {
        do {
            try device.lockForConfiguration()
            change(device)
            device.unlockForConfiguration()
        } catch {
            log.error("camera locked by another: \(String(describing: error), privacy: .public)")
        }
    }

    // MARK: Notifications

    @objc private func subjectAreaChanged(_ notification: Notification) {
        queue.async { self.focus(nil, lock: false) }
    }

    @objc private func interrupted(_ notification: Notification) {
        let raw = notification.userInfo?[AVCaptureSessionInterruptionReasonKey] as? Int
        let reason: CameraInterruption = switch raw.flatMap(AVCaptureSession.InterruptionReason.init(rawValue:)) {
        case .videoDeviceInUseByAnotherClient: .inUse
        case .videoDeviceNotAvailableWithMultipleForegroundApps: .multitasking
        case .videoDeviceNotAvailableDueToSystemPressure: .systemPressure
        case .audioDeviceInUseByAnotherClient: .audio
        default: .background
        }
        log.info("interrupted: \(String(describing: reason), privacy: .public) (\(String(describing: raw), privacy: .public))")
        onEvent?(.interrupted(reason))
    }

    @objc private func resumed(_ notification: Notification) {
        log.info("interruption ended")
        onEvent?(.resumed)
    }

    /// Media services reset (or another failure): start again if wanted.
    @objc private func failed(_ notification: Notification) {
        let error = notification.userInfo?[AVCaptureSessionErrorKey] as? AVError
        log.error("runtime error: \(String(describing: error), privacy: .public)")
        queue.async {
            guard self.wanted, !self.session.isRunning else { return }
            self.session.startRunning()
            self.report()
        }
    }

    // MARK: Metadata

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        let codes = metadataObjects.compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }
        guard !codes.isEmpty else { return }
        onCodes?(codes)
    }
}
#endif
