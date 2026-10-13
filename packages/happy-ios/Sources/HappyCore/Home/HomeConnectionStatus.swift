import Foundation

/// homeConnectionStatus.ts: the home header only calls attention to a
/// socket that is not healthy. A custom subtitle owns the second line, so it
/// suppresses the status.
public enum HomeConnectionStatus {
    /// What the header shows before the socket reports anything
    /// (storage.ts `socketStatus: 'disconnected'`).
    public static let initial: RealtimeStatus = .disconnected

    public static func shows(_ status: RealtimeStatus, hasCustomSubtitle: Bool = false) -> Bool {
        status != .connected && !hasCustomSubtitle
    }

    /// StatusDot pulses only while connecting (HomeHeaderTitle.tsx).
    public static func pulses(_ status: RealtimeStatus) -> Bool {
        status == .connecting
    }
}
