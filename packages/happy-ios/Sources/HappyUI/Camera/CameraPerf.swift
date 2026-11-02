#if canImport(UIKit)
import OSLog
import QuartzCore
import UIKit

/// The camera's measurements, written to the log (subsystem
/// `engineering.happy`, category `camera`) where a device run reads them:
/// a signpost interval for each event, and the frames the main thread
/// missed while it ran.
@MainActor
enum CameraPerf {
    static let signposter = OSSignposter(subsystem: "engineering.happy", category: "camera")
    private static var meters: [String: HitchMeter] = [:]

    /// Watches the main thread's frames for `seconds` after an event (an
    /// open, a lens switch, a flip, a shutter press): the longest gap and
    /// how many frames ran past their deadline.
    static func watch(_ event: String, for seconds: Double = 1) {
        meters[event]?.finish()
        let meter = HitchMeter(event: event, seconds: seconds) { meters[event] = nil }
        meters[event] = meter
    }

    /// The last finished measurement of each event, for tests.
    private(set) static var results: [String: HitchMeter.Result] = [:]

    fileprivate static func record(_ result: HitchMeter.Result) {
        results[result.event] = result
        DeviceCamera.log.info("\(result.event, privacy: .public): longest frame \(Int(result.longest * 1000), privacy: .public) ms, \(result.late, privacy: .public) late of \(result.frames, privacy: .public)")
    }

    @MainActor
    final class HitchMeter: NSObject {
        struct Result: Equatable {
            var event: String
            var frames: Int
            var late: Int
            /// Seconds.
            var longest: Double
        }

        private var link: CADisplayLink?
        private var last: CFTimeInterval?
        private var result: Result
        private let deadline: CFTimeInterval
        private let onFinish: () -> Void

        init(event: String, seconds: Double, onFinish: @escaping () -> Void) {
            result = Result(event: event, frames: 0, late: 0, longest: 0)
            deadline = CACurrentMediaTime() + seconds
            self.onFinish = onFinish
            super.init()
            let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
        }

        @objc private func tick(_ link: CADisplayLink) {
            let now = link.timestamp
            if let last {
                let gap = now - last
                let interval = link.targetTimestamp - link.timestamp
                result.frames += 1
                result.longest = max(result.longest, gap)
                if interval > 0, gap > interval * 1.5 { result.late += 1 }
            }
            last = now
            if CACurrentMediaTime() >= deadline { finish() }
        }

        func finish() {
            guard let link else { return }
            link.invalidate()
            self.link = nil
            CameraPerf.record(result)
            onFinish()
        }
    }
}
#endif
