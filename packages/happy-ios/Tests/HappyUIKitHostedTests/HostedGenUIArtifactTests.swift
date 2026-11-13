#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A `gen_ui` artifact opened as the Artifacts list opens it, over a daemon
/// that holds one version: its entry, the render document its daemon
/// compiled and the pictures it names.
@MainActor
final class HostedGenUIArtifactTests: XCTestCase {
    private var teardown: [() -> Void] = []

    override func tearDown() async throws {
        for step in teardown { step() }
        teardown = []
    }

    private var fixtures: URL { Bundle(for: Self.self).resourceURL!.appendingPathComponent("GenUI") }

    /// `type`: what opened it knew the artifact's; empty, as a link opens it.
    private func open(_ daemon: ArtifactDaemon, type: String = "gen_ui") async throws -> (UIWindow, ArtifactViewController) {
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "genui-test", credentialStore: InMemoryCredentialStore(), storeDirectory: nil, agentTransport: { _ in daemon })
        await account.agentConnections.setForeground(false)
        let connection = try await account.agentConnections.add(JSONDecoder().decode(AgentConnectionCredentials.self,
            from: Data(#"{"address":"genui-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"native-secret"}"#.utf8)), name: "Studio Mac")
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: connection.id, context: context))
        let screen = ArtifactViewController(session: session, artifact: Artifact(id: "art1", version: 3, type: type, title: daemon.title, followsLatest: true))
        let navigation = UINavigationController(rootViewController: UIViewController())
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        navigation.pushViewController(screen, animated: false)
        teardown.append {
            window.isHidden = true
            Session.forget(connection.id)
            Task { try? await account.agentConnections.remove(connection.id) }
        }
        return (window, screen)
    }

    private func wait(_ what: String, timeout: Duration = .seconds(15), _ done: () async -> Bool) async throws {
        let deadline = ContinuousClock.now + timeout
        while await !done() {
            guard ContinuousClock.now < deadline else {
                XCTFail("timed out waiting for \(what)")
                throw CancellationError()
            }
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    private func block(_ screen: ArtifactViewController) -> GenUIBlockView? {
        screen.view.genuiSubviews.compactMap { $0 as? GenUIBlockView }.first { $0.accessibilityIdentifier == "artifact-gen-ui" }
    }

    func testAGalleryOpensAtItsPlannedHeightWithTheVersionsOwnPictures() async throws {
        let render = try Data(contentsOf: fixtures.appendingPathComponent("05-gallery-grid.render.json"))
        // The version holds four of the five pictures the document names.
        let held = ["coast", "forest", "dunes", "lake"]
        let pictures = try held.map { name in
            ArtifactDaemon.File(path: "assets/\(name).jpg", mimeType: "image/jpeg", data: try Data(contentsOf: fixtures.appendingPathComponent("assets/\(name).jpg")))
        }
        let daemon = ArtifactDaemon(type: "gen_ui", title: "Trip photos", files: [
            .init(path: "index.genui.json", mimeType: "application/json", data: Data("{}".utf8)),
            .init(path: GenUIRenderDocument.path, mimeType: "application/json", data: render),
        ] + pictures)
        let (window, screen) = try await open(daemon)
        window.overrideUserInterfaceStyle = .light

        try await wait("the document") { block(screen)?.built != nil }
        let view = try XCTUnwrap(block(screen))
        let built = try XCTUnwrap(view.built)
        // Planned once at the reading column, as tall as the planner says,
        // where the page layout puts it.
        let margin = MessageLayout.Metrics.marginH
        let width = screen.view.bounds.width
        let column = GenUIPageLayout.column(width: width, maxWidth: ContentWidth.maxWidth, margin: margin)
        let document = try XCTUnwrap(GenUIRenderDocument.parse(render))
        let height = GenUIPlanner(document: document, traits: GenUITraits(text: screen.traitCollection.textEnvironment, displayScale: screen.traitCollection.displayScale)).height(width: column)
        XCTAssertEqual(built.plan.width, column)
        XCTAssertEqual(built.plan.size.height, height)
        screen.view.layoutIfNeeded()
        XCTAssertEqual(view.frame, GenUIPageLayout(width: width, maxWidth: ContentWidth.maxWidth, margin: margin, height: height).block)

        // The pictures the version holds are read through its file route; the
        // one it doesn't is never asked for.
        try await wait("the four pictures") {
            let requests = await daemon.requests
            return held.allSatisfy { name in requests.contains { $0.hasPrefix("/v0/artifacts/art1/versions/3/files/assets/\(name).jpg") } }
        }
        let requests = await daemon.requests
        XCTAssertTrue(requests.contains { $0.hasPrefix("/v0/artifacts/art1/versions/3/files/.genui/render.json") }, "\(requests)")
        XCTAssertFalse(requests.contains { $0.contains("assets/city.jpg") }, "\(requests)")
        try await Task.sleep(for: .milliseconds(500))
        capture(window, "genui-artifact-light")
        window.overrideUserInterfaceStyle = .dark
        try await Task.sleep(for: .milliseconds(500))
        capture(window, "genui-artifact-dark")

        // A tile opens the viewer on its group, at that picture.
        view.interaction.onViewer?("gallery.1", "gallery", 1)
        let viewer = try XCTUnwrap(screen.presentedViewController as? PictureViewController)
        XCTAssertEqual(viewer.index, 1)
        // Swiped through the four the version holds, the missing one left out.
        let pager = try XCTUnwrap(viewer.view.subviews.compactMap { $0 as? UIScrollView }.first)
        viewer.view.layoutIfNeeded()
        XCTAssertEqual(pager.contentSize.width, pager.bounds.width * 4, accuracy: 1)
    }

    func testAnUnreadableDocumentSaysSo() async throws {
        let daemon = ArtifactDaemon(type: "gen_ui", title: "Broken", files: [
            .init(path: "index.genui.json", mimeType: "application/json", data: Data("{}".utf8)),
            .init(path: GenUIRenderDocument.path, mimeType: "application/json", data: Data("not json".utf8)),
        ])
        let (_, screen) = try await open(daemon)
        let message = try XCTUnwrap(screen.view.genuiSubviews.compactMap { $0 as? UILabel }.first { $0.accessibilityIdentifier == "artifact-message" })
        try await wait("the message") { message.text != nil }
        XCTAssertEqual(message.text, Strings.artifactUnavailable)
        XCTAssertNil(block(screen))
    }

    /// Happy Cloud leaves the render document out of a version's files and
    /// serves it all the same: read by its path, from the chat's card and
    /// the Artifacts list (which know the type) and from a link (which
    /// reads it), never the entry's JSON as a page.
    func testARenderDocumentTheFilesDontListIsReadByItsPath() async throws {
        let render = try Data(contentsOf: fixtures.appendingPathComponent("05-gallery-grid.render.json"))
        for type in ["gen_ui", ""] {
            let daemon = ArtifactDaemon(type: "gen_ui", title: "Trip photos", files: [
                .init(path: "index.genui.json", mimeType: "application/json", data: Data("{}".utf8)),
                .init(path: GenUIRenderDocument.path, mimeType: "application/json", data: render),
            ], unlisted: [GenUIRenderDocument.path])
            let (_, screen) = try await open(daemon, type: type)
            try await wait("the document") { block(screen)?.built != nil }
            let requests = await daemon.requests
            XCTAssertTrue(requests.contains { $0.hasPrefix("/v0/artifacts/art1/versions/3/files/.genui/render.json") }, "\(requests)")
            XCTAssertFalse(requests.contains { $0.contains("/files/index.genui.json") }, "\(requests)")
            XCTAssertTrue(screen.children.isEmpty, "a page opened: \(screen.children)")
            for step in teardown { step() }
            teardown = []
        }
    }

    func testAnUnlistedDocumentThatCantBeReadSaysSo() async throws {
        let daemon = ArtifactDaemon(type: "gen_ui", title: "Missing", files: [
            .init(path: "index.genui.json", mimeType: "application/json", data: Data("{}".utf8)),
        ])
        let (_, screen) = try await open(daemon)
        let message = try XCTUnwrap(screen.view.genuiSubviews.compactMap { $0 as? UILabel }.first { $0.accessibilityIdentifier == "artifact-message" })
        try await wait("the message") { message.text != nil }
        XCTAssertEqual(message.text, Strings.artifactUnavailable)
        XCTAssertNil(block(screen))
        XCTAssertTrue(screen.children.isEmpty, "a page opened: \(screen.children)")
    }

    private func capture(_ window: UIWindow, _ name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
private extension UIView {
    var genuiSubviews: [UIView] { subviews + subviews.flatMap(\.genuiSubviews) }
}
#endif
