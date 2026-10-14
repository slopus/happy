#if canImport(UIKit)
import UIKit
import XCTest

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
#endif
