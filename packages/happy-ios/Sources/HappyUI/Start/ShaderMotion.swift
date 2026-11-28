#if canImport(UIKit)
import Foundation
import UIKit

/// Whether the sky (`GrainGradientView`) and the Happy Cloud mark
/// (`LiquidMetalView`) move. Each holds Paper's frame 0, drawn by its own
/// shader, with Reduce Motion, in Low Power Mode, and while the phone runs
/// hot (thermal state serious or critical): a frame on every refresh costs
/// most there. Every phone iOS 26 runs on draws them live otherwise.
@MainActor
enum ShaderMotion {
    /// Posted on the main thread when any of the three changes.
    nonisolated static let changed = Notification.Name("happy.shader-motion.changed")

    static var allowed: Bool {
        _ = relay
        let thermal = ProcessInfo.processInfo.thermalState
        return !UIAccessibility.isReduceMotionEnabled && !ProcessInfo.processInfo.isLowPowerModeEnabled
            && thermal != .serious && thermal != .critical
    }

    /// The power and thermal notifications come on any thread: they are
    /// posted again on the main one.
    private static let relay: [NSObjectProtocol] = [
        UIAccessibility.reduceMotionStatusDidChangeNotification,
        .NSProcessInfoPowerStateDidChange,
        ProcessInfo.thermalStateDidChangeNotification,
    ].map { name in
        NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
            NotificationCenter.default.post(name: changed, object: nil)
        }
    }
}
#endif
