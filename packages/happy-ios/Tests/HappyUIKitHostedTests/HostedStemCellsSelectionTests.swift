#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
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

/// A paired computer that never answers: home shows what it is given.
private struct Unreachable: DirectTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> DirectHTTPResponse {
        throw URLError(.cannotConnectToHost)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> DirectHTTPStream {
        throw URLError(.cannotConnectToHost)
    }
    func reset() async {}
    func close() async {}
}

/// Pushes and pops with a plain slide, the pop driven by hand the way a
/// finger drives a swipe back: started, held halfway, then let go.
@MainActor
private final class SwipeBack: NSObject, UINavigationControllerDelegate, UIViewControllerAnimatedTransitioning {
    var interaction: UIPercentDrivenInteractiveTransition?
    private var popping = false

    func navigationController(_ navigationController: UINavigationController, animationControllerFor operation: UINavigationController.Operation, from fromVC: UIViewController, to toVC: UIViewController) -> (any UIViewControllerAnimatedTransitioning)? {
        popping = operation == .pop
        return self
    }

    func navigationController(_ navigationController: UINavigationController, interactionControllerFor animationController: any UIViewControllerAnimatedTransitioning) -> (any UIViewControllerInteractiveTransitioning)? {
        interaction
    }

    nonisolated func transitionDuration(using context: (any UIViewControllerContextTransitioning)?) -> TimeInterval { 0.25 }

    nonisolated func animateTransition(using context: any UIViewControllerContextTransitioning) {
        MainActor.assumeIsolated {
            guard let from = context.view(forKey: .from), let to = context.view(forKey: .to),
                  let toController = context.viewController(forKey: .to) else { return }
            let width = context.containerView.bounds.width
            to.frame = context.finalFrame(for: toController)
            if popping {
                context.containerView.insertSubview(to, belowSubview: from)
            } else {
                context.containerView.addSubview(to)
                to.transform = CGAffineTransform(translationX: width, y: 0)
            }
            UIView.animate(withDuration: 0.25, delay: 0, options: .curveLinear) {
                if self.popping { from.transform = CGAffineTransform(translationX: width, y: 0) } else { to.transform = .identity }
            } completion: { _ in
                from.transform = .identity
                to.transform = .identity
                context.completeTransition(!context.transitionWasCancelled)
            }
        }
    }
}

/// Stem Cells home's rows behave as Telegram's chat list: the row tapped is
/// lit while its conversation comes in, and coming back, by the back button
/// or a swipe, nothing is selected. A swipe let go of halfway stays in the
/// conversation, and the list under it is still unselected.
/// With `HAPPY_PREVIEW_DIR` set, it writes the list as it returned there.
@MainActor
final class HostedStemCellsSelectionTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private static let rows = [
        StemCellsRow(id: "space:happy", nodeId: "happy", kind: .space, label: "Happy", mark: .happy, isHappy: true, agentId: "agent-happy", spaceId: "happy"),
        StemCellsRow(id: "section:priority", nodeId: "priority", kind: .section, label: "Priority", collapsed: false),
        StemCellsRow(id: "space:ios", nodeId: "ios", kind: .space, label: "iOS selection reset", mark: .glyph("tasks"), agentId: "agent-ios", spaceId: "ios"),
        StemCellsRow(id: "space:stories", nodeId: "stories", kind: .space, label: "Stories", mark: .glyph("agents"), agentId: "agent-stories", spaceId: "stories"),
        StemCellsRow(id: "space:bench", nodeId: "bench", kind: .space, label: "Agent benchmark", mark: .glyph("agents"), agentId: "agent-bench", spaceId: "bench"),
    ]

    func testTapPushAndSwipeBackLeaveNoRowSelected() async throws {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(),
            storeDirectory: nil,
            directTransport: { _ in Unreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(),
            connector: NoSockets()
        )
        // Paused: nothing reaches for the computer, and no snapshot replaces the rows.
        await controller.direct.setForeground(false)
        let computer = try await controller.direct.add(
            JSONDecoder().decode(DirectDeviceCredentials.self, from: Data(#"{"address":"selection-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        addTeardownBlock { @MainActor in
            StemCellsSession.forget(computer.id)
            try? await controller.direct.remove(computer.id)
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let home = StemCellsDirectHomeViewController(context: context, id: computer.id)
        let navigation = UINavigationController(rootViewController: home)
        let swipe = SwipeBack()
        navigation.delegate = swipe
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: navigation)
        window.overrideUserInterfaceStyle = .light
        defer { window.isHidden = true }
        window.layoutIfNeeded()

        let sidebar = try XCTUnwrap(Self.subview(StemCellsSidebarView.self, in: home.view))
        sidebar.apply(Self.rows)
        home.view.layoutIfNeeded()
        let row = try XCTUnwrap(rowView(sidebar, "space:ios"))
        XCTAssertNil(selectedRows(sidebar))

        // The tap lights the row, and it stays lit while the chat comes in.
        sidebar.tap(row, at: CGPoint(x: row.frame.midX, y: row.frame.midY))
        let chat = try XCTUnwrap(navigation.topViewController as? StemCellChatViewController)
        XCTAssertEqual(selectedRows(sidebar), ["space:ios"])
        XCTAssertNotNil(navigation.transitionCoordinator, "the chat is still coming in")
        try await settle(navigation)
        XCTAssertNil(selectedRows(sidebar), "covered, the row lets go")

        // A swipe back held halfway: the list shows, with nothing selected.
        let interaction = UIPercentDrivenInteractiveTransition()
        swipe.interaction = interaction
        navigation.popViewController(animated: true)
        interaction.update(0.5)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertNotNil(sidebar.window, "the list is uncovered under the swipe")
        XCTAssertNil(selectedRows(sidebar))

        // Let go of: the chat stays, and keeps working.
        interaction.cancel()
        try await settle(navigation)
        swipe.interaction = nil
        XCTAssertTrue(navigation.topViewController === chat)
        XCTAssertEqual(navigation.viewControllers.count, 2)
        XCTAssertNil(selectedRows(sidebar))

        // Swiped all the way: home, nothing selected.
        let finishing = UIPercentDrivenInteractiveTransition()
        swipe.interaction = finishing
        navigation.popViewController(animated: true)
        finishing.update(0.6)
        try await Task.sleep(for: .milliseconds(50))
        finishing.finish()
        try await settle(navigation)
        swipe.interaction = nil
        XCTAssertTrue(navigation.topViewController === home)
        XCTAssertNil(selectedRows(sidebar))
        keep(window, "stem-cells-after-swipe-back")

        // Again, and back by the back button's pop.
        sidebar.tap(row, at: CGPoint(x: row.frame.midX, y: row.frame.midY))
        XCTAssertEqual(selectedRows(sidebar), ["space:ios"])
        try await settle(navigation)
        navigation.popViewController(animated: true)
        try await settle(navigation)
        XCTAssertTrue(navigation.topViewController === home)
        XCTAssertNil(selectedRows(sidebar))
    }

    private func rowView(_ sidebar: StemCellsSidebarView, _ id: String) -> StemCellsRowView? {
        sidebar.subviews.compactMap { $0 as? StemCellsRowView }.first { $0.row?.id == id }
    }

    /// The rows drawn selected, nil when none is.
    private func selectedRows(_ sidebar: StemCellsSidebarView) -> [String]? {
        let ids = sidebar.subviews.compactMap { $0 as? StemCellsRowView }.filter(\.selected).compactMap(\.row?.id)
        return ids.isEmpty ? nil : ids.sorted()
    }

    private func settle(_ navigation: UINavigationController) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while navigation.transitionCoordinator != nil, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertNil(navigation.transitionCoordinator, "the transition never ended")
        try await Task.sleep(for: .milliseconds(50))
    }

    private func keep(_ window: UIWindow, _ name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
            try? image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }

    private static func subview<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        if let match = view as? T { return match }
        for child in view.subviews {
            if let match = subview(type, in: child) { return match }
        }
        return nil
    }
}
#endif
