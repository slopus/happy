#if canImport(UIKit)
import AVKit
import HappyCore
@testable import HappyUI
import HappyWire
import UIKit
import XCTest

private struct PreviewNoComputer: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.notConnectedToInternet)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.notConnectedToInternet)
    }
    func reset() async {}
    func close() async {}
}

/// A computer whose workspace `w` holds one file, read as the routes API
/// answers it: its bytes as base64.
private struct PreviewWorkspace: AgentTransport {
    let path: String
    let bytes: Data

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        let query = path.split(separator: "?", maxSplits: 1)
        guard query.first == "/v0/workspaces/w/file", query.count == 2,
              URLComponents(string: "?\(query[1])")?.queryItems?.first(where: { $0.name == "path" })?.value == self.path else { return HTTP1Response(status: 404) }
        return HTTP1Response(status: 200, body: try JSONEncoder().encode(["content": bytes.base64EncodedString()]))
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.notConnectedToInternet)
    }
    func reset() async {}
    func close() async {}
}

/// Forgetting one computer touches nothing of another's. Preview files are
/// not filed by computer, so forgetting used to clear all of them, and with
/// them the file under a preview another computer still had on screen.
@MainActor
final class HostedFilePreviewTests: XCTestCase {
    func testForgettingAComputerLeavesAnotherComputersOpenPreview() async throws {
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "preview-test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil, agentTransport: { _ in PreviewNoComputer() })
        await account.agentConnections.setForeground(false)
        func pair(_ name: String) async throws -> AgentConnection {
            try await account.agentConnections.add(JSONDecoder().decode(AgentConnectionCredentials.self,
                from: Data(#"{"address":"preview-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"test"}"#.utf8)), name: name)
        }
        let gone = try await pair("Going")
        let kept = try await pair("Previewing")
        let context = AppContext(account: account, variant: .preview, version: "test")
        _ = try XCTUnwrap(Session.session(for: gone.id, context: context))
        // Where an open preview of the other computer's document is read to.
        let folder = FilePreview.root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let file = folder.appendingPathComponent("report.pdf")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("still being read".utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: folder) }

        Session.forget(gone.id)
        // The old purge ran on a detached task; give anything like it time.
        try await Task.sleep(for: .milliseconds(500))

        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path), "another computer's open preview keeps its file")
        XCTAssertEqual(try? Data(contentsOf: file), Data("still being read".utf8))
        try await account.agentConnections.remove(gone.id)
        try await account.agentConnections.remove(kept.id)
    }

    // MARK: Pictures and recordings

    /// A file link to a picture reads its bytes and shows the picture under
    /// the path, fitted to the screen and zoomable, rather than "Binary File".
    func testAPictureFileLinkShowsThePictureFittedAndZoomable() async throws {
        let png = UIGraphicsImageRenderer(size: CGSize(width: 800, height: 400), format: Self.pointFormat).pngData { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 800, height: 400))
            UIColor.systemOrange.setFill()
            context.fill(CGRect(x: 300, y: 100, width: 200, height: 200))
        }
        let (viewer, link) = try await open("shots/wide.png", png)
        try await until { viewer.picture?.shownImage != nil }
        let page = try XCTUnwrap(viewer.picture)
        XCTAssertNil(viewer.stateView, "a picture is not binary")
        XCTAssertEqual(page.shownImage?.size, CGSize(width: 800, height: 400))
        // Fitted to the width under the header, centred, in its proportions.
        XCTAssertGreaterThan(page.frame.minY, viewer.view.safeAreaInsets.top, "under the path")
        XCTAssertEqual(page.frame.maxY, viewer.view.bounds.maxY)
        XCTAssertEqual(page.shownFrame.width, page.bounds.width)
        XCTAssertEqual(page.shownFrame.height, (page.bounds.width / 2).rounded())
        XCTAssertGreaterThan(page.maximumZoomScale, 1, "pinched to zoom")
        XCTAssertEqual(link.path, "shots/wide.png")
        try screenshot(viewer, name: "workspace-file-picture")

        // A tap opens it whole in the viewer.
        page.onTap?()
        try await until { viewer.presentedViewController is PictureViewController }
        viewer.dismiss(animated: false)
    }

    /// A file link to a recording plays it in the system's player, from a
    /// copy that goes when the screen does.
    func testAVideoFileLinkPlaysInTheSystemPlayer() async throws {
        let video = try await HostedArtifactMediaTests.video()
        weak var gone: WorkspaceFileViewController?
        let url: URL
        do {
            let (viewer, _) = try await open("clips/demo.mp4", video)
            gone = viewer
            try await until { viewer.playback != nil }
            let playback = try XCTUnwrap(viewer.playback)
            XCTAssertNil(viewer.stateView)
            XCTAssertNil(viewer.picture)
            XCTAssertEqual(playback.view.accessibilityIdentifier, "workspace-file-video")
            XCTAssertTrue(playback.showsPlaybackControls, "the system's controls")
            let item = try XCTUnwrap(playback.player?.currentItem)
            url = try XCTUnwrap((item.asset as? AVURLAsset)?.url)
            XCTAssertEqual(url.lastPathComponent, "demo.mp4")
            XCTAssertEqual(try Data(contentsOf: url), video)
            try await until { item.status == .readyToPlay }
            XCTAssertEqual(item.presentationSize, CGSize(width: 320, height: 180))
            XCTAssertGreaterThan(playback.view.frame.height, 0)
            try screenshot(viewer, name: "workspace-file-video")
            playback.player = nil
            viewer.navigationController?.setViewControllers([UIViewController()], animated: false)
        }
        try await until { gone == nil }
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.deletingLastPathComponent().path), "the copy goes with the screen")
    }

    /// Bytes named as a picture that aren't one say so, as before.
    func testAPictureThatDoesNotDecodeIsBinary() async throws {
        let (viewer, _) = try await open("broken.png", Data([0x00, 0x01, 0x02, 0x03]))
        try await until { viewer.stateView != nil }
        XCTAssertNil(viewer.picture)
    }

    private static let pointFormat: UIGraphicsImageRendererFormat = {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return format
    }()

    /// The file read through the link path the conversation takes, then
    /// shown as the conversation pushes it.
    private func open(_ path: String, _ bytes: Data) async throws -> (WorkspaceFileViewController, HappyLink.File) {
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "preview-media-test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil, agentTransport: { _ in PreviewWorkspace(path: path, bytes: bytes) })
        await account.agentConnections.setForeground(false)
        let connection = try await account.agentConnections.add(JSONDecoder().decode(AgentConnectionCredentials.self,
            from: Data(#"{"address":"preview-media-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"test"}"#.utf8)), name: "Studio")
        addTeardownBlock { try? await account.agentConnections.remove(connection.id) }
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: connection.id, context: context))
        let link = HappyLink.File(target: .workspace("w"), path: path)
        guard case .media(let kind, let read) = await session.client.linkedFile(link) else {
            XCTFail("\(path) reads as a picture or a recording")
            throw CancellationError()
        }
        XCTAssertEqual(read, bytes)
        let viewer = WorkspaceFileViewController(session: session, file: link, media: kind, bytes: read)
        let navigation = UINavigationController(rootViewController: viewer)
        let scene = try await hostedActiveScene()
        let previous = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in window.isHidden = true; previous?.makeKey() }
        window.layoutIfNeeded()
        return (viewer, link)
    }

    private func until(_ condition: () -> Bool, seconds: Int = 10, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertTrue(condition(), file: file, line: line)
    }

    private static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("evidence/file-preview")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    private func screenshot(_ controller: UIViewController, name: String) throws {
        let window = try XCTUnwrap(controller.view.window)
        window.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = Self.evidence, let data = image.pngData() {
            try? data.write(to: folder.appendingPathComponent("\(name).png"))
        }
    }
}
#endif
