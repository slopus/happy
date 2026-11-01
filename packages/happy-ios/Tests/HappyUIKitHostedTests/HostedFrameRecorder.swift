#if canImport(UIKit)
import UIKit

/// Keeps what a window shows, 30 times a second, as numbered JPEGs in
/// `HAPPY_RECORDING_DIR/<name>/`, for a video of a test made without
/// Simulator.app (whose screen recording needs its window). Encoding and
/// writing happen off the main thread.
@MainActor
final class HostedFrameRecorder: NSObject {
    private let window: UIWindow
    private let directory: URL
    private var link: CADisplayLink?
    private var count = 0
    private let queue = DispatchQueue(label: "recorder", qos: .utility)

    /// Nil without `HAPPY_RECORDING_DIR`.
    init?(window: UIWindow, name: String) {
        guard let root = ProcessInfo.processInfo.environment["HAPPY_RECORDING_DIR"] else { return nil }
        directory = URL(fileURLWithPath: root).appendingPathComponent(name)
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        self.window = window
    }

    func start() {
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 30, preferred: 30)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    func stop() {
        link?.invalidate()
        link = nil
        queue.sync {}
    }

    @objc private func tick() {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        let bounds = window.bounds
        let image = UIGraphicsImageRenderer(bounds: bounds, format: format).image { _ in
            window.drawHierarchy(in: bounds, afterScreenUpdates: false)
        }
        count += 1
        let url = directory.appendingPathComponent(String(format: "frame-%05d.jpg", count))
        queue.async { try? image.jpegData(compressionQuality: 0.85)?.write(to: url) }
    }
}
#endif
