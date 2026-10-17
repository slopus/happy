#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyStore
@testable import HappyUI
import UIKit
import XCTest

private struct NoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        throw URLError(.notConnectedToInternet)
    }
}

private struct NoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection {
        throw URLError(.notConnectedToInternet)
    }
}

/// Home's resting dock fades in when it goes from hidden to shown
/// (`HomeDockFade`): from nothing when home's first content comes in, its
/// surface from the closed composer's 0.72 and its prompt from nothing when
/// the composer closes, and not again when home
/// comes back from a pushed screen with its dock showing. Hosted: the fade
/// runs on the display link of a real scene, on the real home screen.
@MainActor
final class HostedHomeDockFadeTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func signedIn() async throws -> AccountController {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(),
            storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(),
            connector: NoSockets()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 1, count: 32)))
        return controller
    }

    /// A computer in the account's store, written off the main thread as
    /// sync writes it: home leaves its loading state for one with a dock.
    private func addComputer(to store: LocalStore) async throws {
        try await Task.detached {
            try store.upsertMachine(MachineRecord(
                id: "m", seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
                metadataVersion: 1, metadataCipher: "", metadata: .object(["host": .string("mac")]),
                daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil,
                dataKeyCipher: nil, decryptable: true
            ))
        }.value
    }

    private func subview<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        for child in view.subviews {
            if let match = child as? T { return match }
            if let match = subview(type, in: child) { return match }
        }
        return nil
    }

    /// The dock's surface's or content's presence read every few
    /// milliseconds for `seconds`, with the time since the first read.
    private func samples(_ dock: HomeDockView, seconds: Double) async throws -> (surface: [(time: Double, presence: CGFloat)], content: [(time: Double, presence: CGFloat)]) {
        let start = CACurrentMediaTime()
        var surface: [(Double, CGFloat)] = []
        var content: [(Double, CGFloat)] = []
        while CACurrentMediaTime() - start < seconds {
            let now = CACurrentMediaTime() - start
            surface.append((now, dock.presence))
            content.append((now, dock.contentPresence))
            try await Task.sleep(for: .milliseconds(4))
        }
        return (surface, content)
    }

    private func until(seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(2))
        }
        return condition()
    }

    /// Rises from `from` to 1, never down, never over, within the fade's
    /// duration and a few frames of slack, and the dock and its shell keep
    /// full alpha all the while (an ancestor below it turns the blur off).
    private func assertFades(
        _ samples: [(time: Double, presence: CGFloat)],
        from: CGFloat,
        duration: Double,
        _ dock: HomeDockView,
        _ label: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard let first = samples.first else { return XCTFail("no samples, \(label)", file: file, line: line) }
        XCTAssertLessThanOrEqual(first.presence, from + 0.15, "starts near \(from), \(label)", file: file, line: line)
        XCTAssertGreaterThanOrEqual(first.presence, from - 0.0001, "never below \(from), \(label)", file: file, line: line)
        let mids = samples.filter { $0.presence > from + 0.01 && $0.presence < 0.99 }
        XCTAssertGreaterThanOrEqual(mids.count, 3, "seen part-way: \(samples.map(\.presence)), \(label)", file: file, line: line)
        for (earlier, later) in zip(samples, samples.dropFirst()) {
            XCTAssertGreaterThanOrEqual(later.presence, earlier.presence - 0.0001, "never back, \(label)", file: file, line: line)
        }
        let full = samples.first { $0.presence >= 1 }
        XCTAssertNotNil(full, "reaches 1, \(label)", file: file, line: line)
        XCTAssertLessThan(full?.time ?? .infinity, duration + 0.1, "within \(duration)s, \(label)", file: file, line: line)
        XCTAssertGreaterThan(full?.time ?? 0, duration * 0.5, "takes its time, \(label)", file: file, line: line)
        XCTAssertEqual(samples.last?.presence, 1, label, file: file, line: line)
        XCTAssertEqual(dock.alpha, 1, file: file, line: line)
    }

    func testTheDockFadesInWhenItArrivesAndBackFromTheComposerAndNotAfterAPush() async throws {
        let controller = try await signedIn()
        let account = try XCTUnwrap(controller.session)
        let context = AppContext(account: controller, variant: .development, version: "test")
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let home = HomeViewController(context: context, session: account)
        let navigation = UINavigationController(rootViewController: home)
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
        }
        window.layoutIfNeeded()
        let dock = try XCTUnwrap(subview(HomeDockView.self, in: home.view))
        XCTAssertTrue(dock.isHidden, "no dock before home's first content")

        // Home's first content comes in with home on screen (its loading
        // state already has the dock): the dock fades in from nothing.
        let shown = try await until { !dock.isHidden }
        XCTAssertTrue(shown, "the dock never showed")
        let arriving = try await samples(dock, seconds: HomeDockFade.appearDuration + 0.25)
        assertFades(arriving.surface, from: 0, duration: HomeDockFade.appearDuration, dock, "arriving, the surface")
        assertFades(arriving.content, from: 0, duration: HomeDockFade.appearDuration, dock, "arriving, the prompt")
        // A computer, so the composer has one to start on; the dock stays.
        try await addComputer(to: account.store)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertFalse(dock.isHidden)
        XCTAssertEqual(dock.presence, 1)

        // A screen pushed over home and popped: home comes back with its
        // dock showing, and nothing fades again.
        navigation.pushViewController(UIViewController(), animated: true)
        _ = try await until { home.view.window == nil }
        XCTAssertNil(home.view.window)
        navigation.popViewController(animated: true)
        _ = try await until { home.view.window != nil }
        let back = try await samples(dock, seconds: 0.6)
        XCTAssertFalse(dock.isHidden)
        XCTAssertEqual((back.surface + back.content).map(\.presence).min(), 1, "nothing fades after a pop")

        // The composer opens over home and closes: once the close has
        // ended, the capsule takes up from the closed shell's 0.72 and the
        // prompt, which the shell didn't show, fades in from nothing.
        dock.entryButton.sendActions(for: .touchUpInside)
        let opened = try await until { home.presentedViewController is HomeDockFocusViewController }
        XCTAssertTrue(opened, "the composer never opened")
        XCTAssertTrue(dock.isHidden, "the capsule is replaced while the composer is open")
        try await Task.sleep(for: .milliseconds(600))
        let focus = try XCTUnwrap(home.presentedViewController as? HomeDockFocusViewController)
        focus.close()
        // Hidden through the composer's own close, never under it.
        var hiddenWhileClosing = true
        let closed = try await until {
            if home.presentedViewController != nil, !dock.isHidden { hiddenWhileClosing = false }
            return home.presentedViewController == nil && !dock.isHidden
        }
        XCTAssertTrue(closed, "the composer never closed")
        XCTAssertTrue(hiddenWhileClosing, "the capsule showed under the closing composer")
        let returning = try await samples(dock, seconds: HomeDockFade.returnDuration + 0.25)
        assertFades(returning.surface, from: HomeDockFocusMotion(progress: 0).composerAlpha, duration: HomeDockFade.returnDuration, dock, "back from the composer, the surface")
        assertFades(returning.content, from: 0, duration: HomeDockFade.returnDuration, dock, "back from the composer, the prompt")
        withExtendedLifetime(controller) {}
    }
}
#endif
