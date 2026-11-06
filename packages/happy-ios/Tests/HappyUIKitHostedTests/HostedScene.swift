#if canImport(UIKit)
import UIKit
import XCTest

/// How much slower than a Mac's simulator this one runs, from
/// `HAPPY_TEST_TIME_SCALE`: CI sets it for its virtual Macs, and it is 1
/// anywhere else. Budgets of time multiply by it and counts of frames sampled
/// divide by it; what any one frame shows is checked the same at every scale.
enum HostedTime {
    static let scale: Double = {
        guard let value = ProcessInfo.processInfo.environment["HAPPY_TEST_TIME_SCALE"].flatMap(Double.init), value > 1 else { return 1 }
        return value
    }()

    /// `budget`, at this simulator's speed.
    static func budget(_ budget: Double) -> Double { budget * scale }

    /// A floor of `frames` frames sampled, in what this simulator draws in
    /// their time.
    static func sampled(_ frames: Int) -> Int { Int((Double(frames) / scale).rounded(.down)) }
}

/// The host's window scene once it is in the foreground. These tests are
/// for what only a running application gives a view, so without one they
/// fail; they never skip.
@MainActor
func hostedActiveScene(file: StaticString = #filePath, line: UInt = #line) async throws -> UIWindowScene {
    let deadline = ContinuousClock.now + .seconds(10)
    var found: UIWindowScene?
    while found == nil, ContinuousClock.now < deadline {
        found = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        if found == nil { try await Task.sleep(for: .milliseconds(50)) }
    }
    return try XCTUnwrap(found, "the host has no foreground active window scene", file: file, line: line)
}

/// A window of `scene`, key and visible over the host's, with `root`, by
/// default an empty screen to put views on.
@MainActor
func hostedKeyWindow(in scene: UIWindowScene, root: UIViewController = UIViewController()) -> UIWindow {
    let window = UIWindow(windowScene: scene)
    window.rootViewController = root
    window.makeKeyAndVisible()
    return window
}

/// Calls back on every display frame, so a blocked main thread shows as a gap.
@MainActor
final class TickRecorder: NSObject {
    private var link: CADisplayLink?
    private let onTick: (CFTimeInterval) -> Void

    init(_ onTick: @escaping (CFTimeInterval) -> Void) {
        self.onTick = onTick
        super.init()
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func tick(_ link: CADisplayLink) { onTick(link.timestamp) }

    func stop() {
        link?.invalidate()
        link = nil
    }
}
#endif
