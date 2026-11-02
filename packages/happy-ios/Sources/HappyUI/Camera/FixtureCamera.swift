#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import HappyCore
import UIKit

/// A stand-in camera for the simulator, which has none: it records what
/// the screens ask of it, shows a drawn picture, and is told what to
/// report. Hosted tests drive the camera screens with it; `-camera fake`
/// gives the app one for screenshots.
@MainActor
final class FixtureCamera: CameraEngine {
    enum Call: Equatable {
        case run(CameraConfiguration, asking: Bool)
        case stop
        case zoom(Double, ramp: Bool)
        case focus(CGPoint?, lock: Bool)
        case scanArea(CGRect)
        case bias(Double)
        case capture(CameraShot)
    }

    private(set) var state = CameraState() {
        didSet { if state != oldValue { for handler in observers.values { handler(state) } } }
    }

    let preview: CameraPreviewView
    var onCodes: (@MainActor ([String]) -> Void)?
    private(set) var calls: [Call] = []
    /// What a run comes to.
    var availability: CameraAvailability
    var lenses: CameraLenses
    /// What `sceneIsDark` answers.
    var dark = false
    /// Whether a photo comes back, or a failure.
    var capturesFail = false
    private var observers: [Int: @MainActor (CameraState) -> Void] = [:]
    private var nextObserver = 0

    init(availability: CameraAvailability = .ready, lenses: CameraLenses = CameraLenses(hasUltraWide: true, switchOvers: [2, 6], minZoom: 1, maxZoom: 100)) {
        self.availability = availability
        self.lenses = lenses
        let surface = CALayer()
        surface.contentsGravity = .resizeAspectFill
        surface.contents = FixtureCamera.picture.cgImage
        preview = CameraPreviewView(surface: surface)
    }

    func observe(_ handler: @escaping @MainActor (CameraState) -> Void) -> CameraObservation {
        let id = nextObserver
        nextObserver += 1
        observers[id] = handler
        handler(state)
        return CameraObservation { [weak self] in self?.observers[id] = nil }
    }

    func run(_ configuration: CameraConfiguration, asking: Bool) {
        calls.append(.run(configuration, asking: asking))
        var next = state
        next.configuration = configuration
        next.availability = availability
        let ready = availability == .ready
        next.running = ready
        next.previewing = ready
        next.lenses = lenses
        if state.configuration?.position != configuration.position || !state.running { next.zoom = lenses.wideZoom }
        next.videoSize = ready ? CGSize(width: 1920, height: 1080) : nil
        next.firstFrameMilliseconds = ready ? 0 : nil
        next.hasFlash = ready && configuration.position == .back
        next.canFlip = ready
        next.activePosition = ready ? configuration.position : state.activePosition
        next.shutterReady = ready && configuration.mode == .photo
        state = next
    }

    func stop() {
        calls.append(.stop)
        state.configuration = nil
        state.running = false
        state.previewing = false
        state.shutterReady = false
    }

    func setZoom(_ zoom: Double, ramp: Bool) {
        calls.append(.zoom(zoom, ramp: ramp))
        state.zoom = min(lenses.maxZoom, max(lenses.minZoom, zoom))
    }

    func focus(at point: CGPoint?, lock: Bool) {
        calls.append(.focus(point, lock: lock))
        if point != nil { state.exposureBias = 0 }
    }

    func setScanArea(_ area: CGRect) {
        calls.append(.scanArea(area))
    }

    func setExposureBias(_ slider: Double) {
        calls.append(.bias(slider))
        state.exposureBias = min(1, max(-1, slider))
    }

    func sceneIsDark() async -> Bool { dark }

    /// The exposure, then the drawn picture as a JPEG, on later turns of
    /// the main queue as the device's come.
    func capturePhoto(_ shot: CameraShot, _ events: @escaping @MainActor (CameraShotEvent) -> Void) {
        calls.append(.capture(shot))
        guard state.running, state.configuration?.mode == .photo else { return events(.failed) }
        let fails = capturesFail
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                events(.capturing)
                events(fails ? .failed : .finished(CameraPhoto(data: FixtureCamera.jpeg, ratio: shot.ratio)))
            }
        }
    }

    /// What the device would report: an interruption, its end, warmth.
    func report(_ change: (inout CameraState) -> Void) {
        change(&state)
    }

    /// QR codes as the metadata output would hand them over.
    func read(_ codes: [String]) {
        guard state.configuration?.mode == .qr else { return }
        onCodes?(codes)
    }

    static let jpeg: Data = picture.jpegData(compressionQuality: 0.9) ?? Data()

    /// An evening sky over hills, never a real picture.
    static let picture: UIImage = {
        let size = CGSize(width: 270, height: 480)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            let cg = context.cgContext
            let space = CGColorSpaceCreateDeviceRGB()
            let sky = [UIColor(red: 0.16, green: 0.22, blue: 0.45, alpha: 1).cgColor, UIColor(red: 0.95, green: 0.55, blue: 0.35, alpha: 1).cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: space, colors: sky, locations: [0, 1]) {
                cg.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: size.height * 0.7), options: [.drawsAfterEndLocation])
            }
            UIColor(red: 1, green: 0.85, blue: 0.55, alpha: 1).setFill()
            cg.fillEllipse(in: CGRect(x: 150, y: 250, width: 70, height: 70))
            for (index, color) in [UIColor(red: 0.2, green: 0.3, blue: 0.25, alpha: 1), UIColor(red: 0.1, green: 0.17, blue: 0.14, alpha: 1)].enumerated() {
                let base = size.height * (0.66 + CGFloat(index) * 0.1)
                let hill = UIBezierPath()
                hill.move(to: CGPoint(x: 0, y: size.height))
                hill.addLine(to: CGPoint(x: 0, y: base))
                hill.addCurve(to: CGPoint(x: size.width, y: base - 20), controlPoint1: CGPoint(x: size.width * 0.3, y: base - 70), controlPoint2: CGPoint(x: size.width * 0.6, y: base + 40))
                hill.addLine(to: CGPoint(x: size.width, y: size.height))
                hill.close()
                color.setFill()
                hill.fill()
            }
        }
    }()
}
#endif
