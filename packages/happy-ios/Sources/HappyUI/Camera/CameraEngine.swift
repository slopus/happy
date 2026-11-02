#if canImport(UIKit)
import HappyCore
import UIKit

/// The camera every screen uses: the QR scanner, the attach menu's tile
/// and the full camera. One engine is one capture session; its picture is
/// one view, `preview`, which a screen hosts and may hand on (the tile
/// gives it to the full camera) without the session stopping.
///
/// Everything here is called on the main thread and returns at once. The
/// session's work (configuring, starting, stopping, switching lenses) runs
/// on the engine's own queue, and what it changes comes back as `state`.
@MainActor
protocol CameraEngine: AnyObject {
    var state: CameraState { get }
    /// The live picture. Screens put it where they want it; it fills its
    /// bounds aspect-fill.
    var preview: CameraPreviewView { get }
    /// Called with every new state, and once at once. Keep the token.
    func observe(_ handler: @escaping @MainActor (CameraState) -> Void) -> CameraObservation
    /// Runs with `configuration`, reconfiguring a running session in place.
    /// `asking`: asks for camera access if it was never asked; the tile
    /// never asks, the screens that open on a tap do.
    func run(_ configuration: CameraConfiguration, asking: Bool)
    func stop()
    /// A device zoom (`CameraLenses`), ramped as a lens button does or set
    /// at once as a pinch does.
    func setZoom(_ zoom: Double, ramp: Bool)
    /// Focus and exposure at a point of the preview, in its own coordinates;
    /// `lock`, held there as a long press does. A point of nil goes back to
    /// continuous focus and exposure in the middle.
    func focus(at point: CGPoint?, lock: Bool)
    /// The QR mode's rect of interest, in the output's unit space.
    func setScanArea(_ area: CGRect)
    /// The QR codes read, on the main thread, while in QR mode.
    var onCodes: (@MainActor ([String]) -> Void)? { get set }
}

struct CameraConfiguration: Equatable, Sendable {
    enum Mode: Equatable, Sendable {
        /// QR codes from metadata output; no photos.
        case qr
        case photo
        case video
    }

    var mode: Mode
    var position: CameraPosition = .back
}

enum CameraPosition: Equatable, Sendable {
    case back, front
}

enum CameraAvailability: Equatable, Sendable {
    /// Not looked at yet, or looking.
    case unknown
    /// Never asked for, and this run didn't ask (the tile's).
    case notDetermined
    case ready
    /// Access refused; Settings can give it.
    case denied
    /// Refused by the device's owner (Screen Time, MDM); Settings can't.
    case restricted
    /// No camera at all, as in the simulator, or none that does the mode.
    case noCamera
}

/// Why a running session stopped showing, from
/// `AVCaptureSession.InterruptionReason`.
enum CameraInterruption: Equatable, Sendable {
    /// Another app took the camera (a FaceTime call).
    case inUse
    /// iPad multitasking without multitasking camera access.
    case multitasking
    /// The device is too hot, or too low on power.
    case systemPressure
    /// The app went to the background.
    case background
    /// A call or Siri took the audio.
    case audio
}

struct CameraState: Equatable {
    var availability: CameraAvailability = .unknown
    /// What it was last asked to run, nil when stopped.
    var configuration: CameraConfiguration?
    /// The session runs.
    var running = false
    /// The preview shows the camera's pictures (the layer's `isPreviewing`).
    var previewing = false
    var interruption: CameraInterruption?
    var lenses: CameraLenses = .single
    /// The device zoom.
    var zoom: Double = 1
    /// The picture as the sensor delivers it, landscape; nil until known.
    var videoSize: CGSize?
    /// The preview's clockwise turn (`videoRotationAngle`): 90 in portrait.
    var previewRotation: CGFloat = 90
    var thermal: CameraThermal = .nominal
    var hasTorch = false
    /// Milliseconds from `run` to the first picture on screen, for the run
    /// that last brought one.
    var firstFrameMilliseconds: Double?
}

/// Ends an observation when released or cancelled.
final class CameraObservation {
    private var end: (@MainActor @Sendable () -> Void)?

    init(_ end: @escaping @MainActor @Sendable () -> Void) {
        self.end = end
    }

    @MainActor func cancel() {
        end?()
        end = nil
    }

    deinit {
        guard let end else { return }
        if Thread.isMainThread {
            MainActor.assumeIsolated { end() }
        } else {
            Task { @MainActor in end() }
        }
    }
}

/// The engine's picture: the session's preview layer (or a stand-in's)
/// over black, which a screen sizes and places. Its layer fills it
/// aspect-fill, so the screens only set its frame.
final class CameraPreviewView: UIView {
    let surface: CALayer

    init(surface: CALayer) {
        self.surface = surface
        super.init(frame: .zero)
        backgroundColor = .black
        clipsToBounds = true
        isUserInteractionEnabled = false
        accessibilityIgnoresInvertColors = true
        layer.addSublayer(surface)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        surface.frame = bounds
        CATransaction.commit()
    }
}
#endif
