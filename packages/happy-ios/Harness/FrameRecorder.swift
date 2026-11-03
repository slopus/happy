#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import UIKit

/// Records what the window draws, on the phone itself, for a video where
/// the system's screen recording isn't reachable (`-recordFrames SECONDS`):
/// each display frame the window's rendered layers, at 1×, as JPEGs in the
/// app's Documents/frames, each named by its time in ms (copied off with
/// `devicectl device copy from`).
/// `-recordTop POINTS` keeps only the top of the window.
@MainActor
final class FrameRecorder: NSObject {
    private let window: UIWindow
    private let until: CFTimeInterval
    private let top: CGFloat?
    private let directory: URL
    private var link: CADisplayLink?
    private var index = 0
    private var started: CFTimeInterval?

    init(window: UIWindow, seconds: Double, top: CGFloat?) {
        self.window = window
        until = seconds
        self.top = top
        directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("frames")
        super.init()
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 30, preferred: 30)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func tick(_ link: CADisplayLink) {
        let now = link.timestamp
        if started == nil { started = now }
        guard let started, now - started < until else {
            link.invalidate()
            self.link = nil
            try? Data("\(index)".utf8).write(to: directory.appendingPathComponent("done"))
            return
        }
        let bounds = window.bounds
        let size = CGSize(width: bounds.width, height: top.map { min($0, bounds.height) } ?? bounds.height)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            window.drawHierarchy(in: bounds, afterScreenUpdates: false)
        }
        guard let data = image.jpegData(compressionQuality: 0.8) else { return }
        // Named by its time in milliseconds, so a slow frame keeps its place.
        let name = String(format: "%06d.jpg", Int((now - started) * 1000))
        index += 1
        let url = directory.appendingPathComponent(name)
        Task.detached(priority: .utility) { try? data.write(to: url) }
    }
}
#endif
