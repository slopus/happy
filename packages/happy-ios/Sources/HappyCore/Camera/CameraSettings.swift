import Foundation

/// What the full camera's buttons choose, as the system camera offers it.
/// Kept while the app runs, as the system camera keeps its own until it
/// is closed for a while; never synced.
public struct CameraSettings: Equatable, Sendable {
    public enum Mode: Equatable, Sendable, CaseIterable {
        case photo, video
    }

    /// The system camera's flash, in the order its button cycles.
    public enum Flash: Equatable, Sendable, CaseIterable {
        case auto, on, off

        public var next: Flash {
            switch self {
            case .auto: .on
            case .on: .off
            case .off: .auto
            }
        }
    }

    public enum Timer: Int, Equatable, Sendable, CaseIterable {
        case off = 0, three = 3, ten = 10

        public var next: Timer {
            switch self {
            case .off: .three
            case .three: .ten
            case .ten: .off
            }
        }

        public var seconds: Int { rawValue }
    }

    /// The photo's shape: the sensor's own 4:3, or cut to 16:9 or square.
    public enum Aspect: Equatable, Sendable, CaseIterable {
        case standard, wide, square

        public var next: Aspect {
            switch self {
            case .standard: .wide
            case .wide: .square
            case .square: .standard
            }
        }

        /// The long side over the short.
        public var ratio: Double {
            switch self {
            case .standard: 4.0 / 3.0
            case .wide: 16.0 / 9.0
            case .square: 1
            }
        }
    }

    public var mode: Mode = .photo
    public var flash: Flash = .auto
    /// Video's light: the torch, on or off (the system camera's video flash).
    public var torch = false
    public var timer: Timer = .off
    public var aspect: Aspect = .standard
    public var grid = false
    public var front = false

    public init() {}

    /// The flash a photo asks the camera for. The back camera's is its LED;
    /// the front camera's, where it has one, is the screen, lit by the
    /// system as its own camera lights it (Retina Flash). Video uses the
    /// torch instead.
    public var photoFlash: Flash {
        mode == .photo ? flash : .off
    }

    /// Whether the screen is lit white for a front shot by the camera screen
    /// itself, as Telegram lights it: only where the camera has no flash of
    /// its own; on, or auto in a dark scene.
    public func screenFlash(cameraFlashes: Bool, darkScene: Bool) -> Bool {
        guard mode == .photo, front, !cameraFlashes else { return false }
        switch flash {
        case .on: return true
        case .auto: return darkScene
        case .off: return false
        }
    }

    /// Video is always the sensor's 16:9; the shape and the timer are
    /// photo's alone.
    public var effectiveAspect: Aspect { mode == .video ? .wide : aspect }
}

/// The photo size to capture: the smallest the camera offers that still
/// fills what the composer sends (3072 on its long edge), so a shot takes
/// no longer and holds no more memory than it needs. The 48 MP sizes
/// would only be scaled down again.
public enum CameraPhotoSize {
    public struct Dimensions: Equatable, Sendable {
        public var width: Int
        public var height: Int

        public init(width: Int, height: Int) {
            self.width = width
            self.height = height
        }

        public var longEdge: Int { max(width, height) }
    }

    public static func choose(_ supported: [Dimensions], longEdge wanted: Int) -> Dimensions? {
        let sorted = supported.sorted { $0.width * $0.height < $1.width * $1.height }
        return sorted.first { $0.longEdge >= wanted } ?? sorted.last
    }
}

/// The exposure slider beside the focus square, and how dark a scene is.
public enum CameraExposure {
    /// The system camera's slider spans two stops each way. Telegram's
    /// spans most of the device's ±8, which no one can aim with a thumb.
    public static let stops: Double = 2

    /// The slider's -1...1 as the device's target bias in EV, within what
    /// the camera allows.
    public static func bias(slider: Double, min low: Double, max high: Double) -> Double {
        let bias = Swift.min(1, Swift.max(-1, slider)) * stops
        return Swift.min(high, Swift.max(low, bias))
    }

    /// The light falling on the scene as EV at ISO 100, from what the
    /// camera chose to expose it: `aperture` the f-number, `duration` in
    /// seconds. A room lit by one lamp is about 5; daylight about 15.
    public static func ev100(aperture: Double, duration: Double, iso: Double) -> Double {
        guard aperture > 0, duration > 0, iso > 0 else { return 0 }
        return log2(aperture * aperture / duration) - log2(iso / 100)
    }

    /// Darker than a dimly lit room: where the system camera's auto flash
    /// fires for a selfie.
    public static let darkBelow: Double = 4.5

    public static func isDark(aperture: Double, duration: Double, iso: Double) -> Bool {
        ev100(aperture: aperture, duration: duration, iso: iso) < darkBelow
    }
}
