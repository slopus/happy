#if canImport(UIKit)
import ImageIO
import UIKit

/// A cover that moves (an animated WebP or GIF, which `UIImageView` won't
/// play), playing in a feed post's view as the file says: each frame for
/// its delay, looping its loop count. Whether it moves is the decoder's
/// to say: more than one frame. Frames are decoded off the main thread,
/// one ahead of the one shown, at the size drawn (`pixels`), so a post
/// never holds more than two and never one at full size.
///
/// It plays only while its view is on screen, the app is active and
/// Reduce Motion is off; otherwise it holds its frame and lets the next
/// one go. Under Reduce Motion it shows the first frame, as the lists'
/// slots always do.
@MainActor
final class CoverAnimation {
    /// How long each frame shows, and how many times it all plays (0:
    /// for ever).
    struct Timing: Equatable, Sendable {
        var delays: [Double]
        var loops: Int
    }

    private let frames: Frames
    let timing: Timing
    private weak var view: UIImageView?
    private let first: UIImage?
    // Let go in `deinit`, which no actor runs.
    nonisolated(unsafe) private var link: CADisplayLink?
    /// The frame shown.
    private(set) var index = 0
    private var shownAt: CFTimeInterval?
    private var next: (index: Int, image: UIImage)?
    private var decoding = false
    private var played = 0
    private var finished = false
    nonisolated(unsafe) private var observers: [NSObjectProtocol] = []
    /// The app is in the background (from its notifications: a post is
    /// made while the app shows it).
    private var background = false

    /// Plays `data` in `view` from the frame it shows now (the still the
    /// cover was read as); nil for a picture of one frame.
    init?(data: Data, pixels: Int, view: UIImageView) {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let timing = Self.timing(source) else { return nil }
        frames = Frames(source: source, pixels: pixels)
        self.timing = timing
        self.view = view
        first = view.image
        let center = NotificationCenter.default
        for name in [UIApplication.didEnterBackgroundNotification, UIApplication.willEnterForegroundNotification, UIAccessibility.reduceMotionStatusDidChangeNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                let name = note.name
                MainActor.assumeIsolated {
                    guard let self else { return }
                    if name == UIApplication.didEnterBackgroundNotification { self.background = true }
                    if name == UIApplication.willEnterForegroundNotification { self.background = false }
                    self.update()
                }
            })
        }
        let link = CADisplayLink(target: Tick(self), selector: #selector(Tick.tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 8, maximum: 30, preferred: 30)
        link.add(to: .main, forMode: .common)
        self.link = link
        update()
    }

    /// Whether the system's Reduce Motion is on; the harness says so itself.
    static var reduceMotion: () -> Bool = { UIAccessibility.isReduceMotionEnabled }

    deinit {
        link?.invalidate()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    /// Frames shown since it started, for the harness.
    private(set) var advanced = 0

    var playing: Bool { link.map { !$0.isPaused } ?? false }

    /// Its view came or went, or the app or Reduce Motion changed.
    func update() {
        let still = Self.reduceMotion()
        if still, index != 0 {
            index = 0
            view?.image = first
        }
        let runs = !finished && !still && !background && view?.window != nil
        link?.isPaused = !runs
        if !runs { rest() }
    }

    /// Lets the next frame go, and starts its frame's time again on return.
    private func rest() {
        next = nil
        shownAt = nil
    }

    func stop() {
        link?.invalidate()
        link = nil
        rest()
    }

    /// On screen: in its window's bounds, nothing over it hidden.
    private var onScreen: Bool {
        guard let view, let window = view.window else { return false }
        var ancestor: UIView? = view
        while let current = ancestor {
            if current.isHidden || current.alpha < 0.01 { return false }
            ancestor = current.superview
        }
        return view.convert(view.bounds, to: window).intersects(window.bounds)
    }

    fileprivate func tick(_ link: CADisplayLink) {
        guard onScreen else { return rest() }
        let now = link.timestamp
        guard let shownAt else {
            shownAt = now
            return want()
        }
        guard now - shownAt >= timing.delays[index], let next else { return want() }
        view?.image = next.image
        advanced += 1
        if next.index == 0 { played += 1 }
        index = next.index
        self.next = nil
        self.shownAt = now
        if timing.loops > 0, index == timing.delays.count - 1, played + 1 >= timing.loops {
            finished = true
            return update()
        }
        want()
    }

    /// Decodes the frame after the one shown, once.
    private func want() {
        guard next == nil, !decoding else { return }
        let wanted = (index + 1) % timing.delays.count
        decoding = true
        frames.decode(wanted) { [weak self] image in
            Task { @MainActor in
                guard let self else { return }
                self.decoding = false
                guard let image, self.playing, self.shownAt != nil, (self.index + 1) % self.timing.delays.count == wanted else { return }
                self.next = (wanted, image)
            }
        }
    }

    /// A display link holds its target: this holds the animation weakly.
    private final class Tick: NSObject {
        weak var animation: CoverAnimation?
        init(_ animation: CoverAnimation) { self.animation = animation }

        @MainActor @objc func tick(_ link: CADisplayLink) {
            guard let animation else { return link.invalidate() }
            animation.tick(link)
        }
    }

    /// The file's decoder, used on one queue.
    private final class Frames: @unchecked Sendable {
        private let source: CGImageSource
        private let options: CFDictionary
        private let queue = DispatchQueue(label: "engineering.happy.cover-frames", qos: .userInitiated)

        init(source: CGImageSource, pixels: Int) {
            self.source = source
            options = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceShouldCache: false,
                kCGImageSourceThumbnailMaxPixelSize: max(1, pixels),
            ] as CFDictionary
        }

        func decode(_ index: Int, done: @escaping @Sendable (UIImage?) -> Void) {
            queue.async {
                done(CGImageSourceCreateThumbnailAtIndex(self.source, index, self.options).map { UIImage(cgImage: $0) })
            }
        }
    }

    // MARK: The file's timing

    /// Each frame's delay and the loop count; nil for one frame.
    nonisolated static func timing(_ source: CGImageSource) -> Timing? {
        let count = CGImageSourceGetCount(source)
        guard count > 1 else { return nil }
        let properties = CGImageSourceCopyProperties(source, nil) as? [CFString: Any]
        let webp = properties?[kCGImagePropertyWebPDictionary] as? [CFString: Any]
        let gif = properties?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
        let loops = (webp?[kCGImagePropertyWebPLoopCount] as? Int) ?? (gif?[kCGImagePropertyGIFLoopCount] as? Int) ?? 0
        return Timing(delays: (0..<count).map { delay(source, $0) }, loops: max(0, loops))
    }

    /// A frame's delay in seconds; as browsers do, one under 20 ms is 100.
    nonisolated static func delay(_ source: CGImageSource, _ index: Int) -> Double {
        let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any]
        let webp = properties?[kCGImagePropertyWebPDictionary] as? [CFString: Any]
        let gif = properties?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
        let value = [webp?[kCGImagePropertyWebPUnclampedDelayTime], webp?[kCGImagePropertyWebPDelayTime], gif?[kCGImagePropertyGIFUnclampedDelayTime], gif?[kCGImagePropertyGIFDelayTime]]
            .lazy.compactMap { ($0 as? NSNumber)?.doubleValue }.first { $0 > 0 } ?? 0
        return value < 0.02 ? 0.1 : value
    }

    /// Whether `data` is a picture of more than one frame.
    nonisolated static func moves(_ data: Data) -> Bool {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return false }
        return CGImageSourceGetCount(source) > 1
    }
}
#endif
