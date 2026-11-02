import Foundation

/// How hard the camera may run as the device warms, after Apple's advice
/// for `ProcessInfo.thermalState`: as it gets serious the frame rate comes
/// down, and when critical the resolution too, before the system stops the
/// camera itself (`AVCaptureSession.InterruptionReason.videoDeviceNotAvailableDueToSystemPressure`).
public enum CameraThermal: Int, Comparable, Sendable {
    case nominal, fair, serious, critical

    public static func < (lhs: CameraThermal, rhs: CameraThermal) -> Bool { lhs.rawValue < rhs.rawValue }

    /// The highest frame rate allowed for one that was asked for.
    public func frameRate(_ wanted: Double) -> Double {
        switch self {
        case .nominal, .fair: wanted
        case .serious: min(wanted, 30)
        case .critical: min(wanted, 24)
        }
    }

    /// Whether 4K should step down to 1080p.
    public var limitsResolution: Bool { self == .critical }
}
