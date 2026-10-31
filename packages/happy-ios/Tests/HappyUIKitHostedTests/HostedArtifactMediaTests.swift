#if canImport(UIKit)
import AVFoundation
import AVKit
import Foundation
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A daemon that holds one artifact version: its version object, its files
/// with `Range` answered as the file route answers it (`206`,
/// `Content-Range`), the artifact's source workspace, and a CONNECT tunnel
/// for pictures on the web that serves `/remote.png` to any host.
actor ArtifactDaemon: AgentTransport {
    struct File {
        let path: String
        let mimeType: String
        let data: Data
    }

    let id = "art1"
    let number = 3
    let type: String
    let title: String
    let files: [File]
    let remote: Data
    /// Every API request, with its `Range` when it had one.
    private(set) var requests: [String] = []
    /// Every request line a tunnel carried.
    private(set) var tunneled: [String] = []

    init(type: String, title: String, files: [File], remote: Data = Data()) {
        self.type = type
        self.title = title
        self.files = files
        self.remote = remote
    }

    func browserConnection() async throws -> any BrowserStream { Socket(self) }
    func close() async {}

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        requests.append(path + (headers["Range"].map { " \($0)" } ?? ""))
        let versions = "/v0/artifacts/\(id)/versions/"
        if path.hasPrefix(versions) {
            let rest = path.dropFirst(versions.count)
            if let files = rest.range(of: "/files/") {
                let wanted = rest[files.upperBound...].split(separator: "/").map { String($0).removingPercentEncoding ?? "" }.joined(separator: "/")
                guard let file = self.files.first(where: { $0.path == wanted }) else { return HTTP1Response(status: 404, body: Data(#"{"error":"not found"}"#.utf8)) }
                return Self.serve(file, range: headers["Range"])
            }
            return HTTP1Response(status: 200, body: Data(versionJSON.utf8))
        }
        if path == "/v0/artifacts/\(id)" {
            return HTTP1Response(status: 200, body: Data(#"{"artifact":{"id":"art1","source":{"kind":"workspace","workspaceId":"work1","projectId":"proj1","agentId":"agent1"}}}"#.utf8))
        }
        if path == "/v0/config" { return HTTP1Response(status: 200, body: Data(#"{"config":{"node":{"name":"Studio Mac"}}}"#.utf8)) }
        return HTTP1Response(status: 200, body: Data("{}".utf8))
    }

    private func object(_ file: File) -> String {
        #"{"path":"\#(file.path)","mimeType":"\#(file.mimeType)","size":\#(file.data.count),"sha256":"0"}"#
    }

    private var versionJSON: String {
        let entry = files.first { $0.path.hasSuffix(".md") && !$0.path.contains("/") } ?? files[0]
        return #"{"version":{"artifactId":"\#(id)","number":\#(number),"title":"\#(title)","entry":\#(object(entry)),"files":[\#(files.map(object).joined(separator: ","))],"background":null}}"#
    }

    /// The file route: one range when asked for one, else the whole file.
    static func serve(_ file: File, range: String?) -> HTTP1Response {
        let total = file.data.count
        guard let range, range.hasPrefix("bytes=") else {
            return HTTP1Response(status: 200, headers: ["content-type": file.mimeType, "content-length": "\(total)"], body: file.data)
        }
        let bounds = range.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
        guard bounds.count == 2, let start = Int(bounds[0]), start < total else {
            return HTTP1Response(status: 416, headers: ["content-range": "bytes */\(total)"], body: Data(#"{"code":"range_not_satisfiable"}"#.utf8))
        }
        let end = min(total - 1, Int(bounds[1]) ?? total - 1)
        return HTTP1Response(status: 206, headers: ["content-type": file.mimeType, "content-range": "bytes \(start)-\(end)/\(total)", "accept-ranges": "bytes"], body: file.data.subdata(in: start..<(end + 1)))
    }

    fileprivate func answer(_ head: BrowserHTTPHead) -> (Data, Bool) {
        tunneled.append(head.line)
        if head.line.hasPrefix("CONNECT ") { return (Data("HTTP/1.1 200 Connection Established\r\n\r\n".utf8), true) }
        var bytes = Data("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: \(remote.count)\r\nConnection: close\r\n\r\n".utf8)
        bytes.append(remote)
        return (bytes, false)
    }

    private actor Socket: BrowserStream {
        let daemon: ArtifactDaemon
        var buffer = Data()
        var pending = Data()
        var reader: CheckedContinuation<Data, Error>?
        var ended = false
        init(_ daemon: ArtifactDaemon) { self.daemon = daemon }

        func read(maximumBytes: Int) async throws -> Data {
            if !pending.isEmpty {
                let data = Data(pending.prefix(maximumBytes))
                pending.removeFirst(data.count)
                return data
            }
            if ended { return Data() }
            return try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { reader = $0 }
            } onCancel: { Task { await self.close() } }
        }

        func write(_ data: Data) async throws {
            buffer.append(data)
            // TLS, which this daemon can't speak: the connection ends.
            if let first = buffer.first, !(65...90).contains(first) {
                await close()
                return
            }
            guard let (head, _) = try BrowserHTTPHead.parse(buffer) else { return }
            buffer = Data()
            let (response, staysOpen) = await daemon.answer(head)
            pending.append(response)
            ended = !staysOpen
            if let reader {
                self.reader = nil
                let bytes = pending
                pending = Data()
                reader.resume(returning: bytes)
            }
        }

        func close() async {
            ended = true
            reader?.resume(returning: Data())
            reader = nil
        }
    }
}

@MainActor
final class HostedArtifactMediaTests: XCTestCase {
    private var teardown: [() -> Void] = []

    override func tearDown() async throws {
        for step in teardown { step() }
        teardown = []
    }

    // MARK: Fixtures

    nonisolated static func png(_ size: CGSize, _ color: UIColor) -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).pngData { context in
            color.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            UIColor.white.withAlphaComponent(0.85).setFill()
            context.cgContext.fillEllipse(in: CGRect(x: size.width * 0.35, y: size.height * 0.3, width: size.height * 0.4, height: size.height * 0.4))
        }
    }

    nonisolated static func jpeg(_ size: CGSize, _ color: UIColor) -> Data {
        UIImage(data: png(size, color))!.jpegData(compressionQuality: 0.9)!
    }

    /// A second of H.264 at 320 × 180, its colour sweeping from frame to frame.
    nonisolated static func video() async throws -> Data {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).mp4")
        defer { try? FileManager.default.removeItem(at: url) }
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 320, AVVideoHeightKey: 180])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: 320, kCVPixelBufferHeightKey as String: 180,
        ])
        writer.add(input)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        for frame in 0..<30 {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer)
            let pixels = buffer!
            CVPixelBufferLockBaseAddress(pixels, [])
            let base = CVPixelBufferGetBaseAddress(pixels)!.assumingMemoryBound(to: UInt8.self)
            let row = CVPixelBufferGetBytesPerRow(pixels)
            for y in 0..<180 {
                for x in 0..<320 {
                    let at = y * row + x * 4
                    base[at] = UInt8(40 + frame * 6) // blue
                    base[at + 1] = UInt8(x * 255 / 320) // green
                    base[at + 2] = UInt8(y * 255 / 180) // red
                    base[at + 3] = 255
                }
            }
            CVPixelBufferUnlockBaseAddress(pixels, [])
            adaptor.append(pixels, withPresentationTime: CMTime(value: Int64(frame), timescale: 30))
        }
        input.markAsFinished()
        await writer.finishWriting()
        XCTAssertEqual(writer.status, .completed, "\(String(describing: writer.error))")
        return try Data(contentsOf: url)
    }

    /// The artifact's screen over `daemon`, in a navigation controller in a
    /// key window, as the Artifacts list pushes it.
    private func open(_ daemon: ArtifactDaemon, type: String, title: String) async throws -> (UIWindow, UINavigationController, ArtifactViewController) {
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "artifact-test", credentialStore: InMemoryCredentialStore(), storeDirectory: nil, agentTransport: { _ in daemon })
        await account.agentConnections.setForeground(false)
        let connection = try await account.agentConnections.add(JSONDecoder().decode(AgentConnectionCredentials.self,
            from: Data(#"{"address":"artifact-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"native-secret"}"#.utf8)), name: "Studio Mac")
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: connection.id, context: context))
        let screen = ArtifactViewController(session: session, artifact: Artifact(id: "art1", version: 3, type: type, title: title, followsLatest: true))
        let navigation = UINavigationController(rootViewController: UIViewController())
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        navigation.pushViewController(screen, animated: false)
        teardown.append {
            window.isHidden = true
            Session.forget(connection.id)
            Task { try? await account.agentConnections.remove(connection.id) }
        }
        return (window, navigation, screen)
    }

    private func wait(_ what: String, timeout: Duration = .seconds(15), _ done: () -> Bool) async throws {
        let deadline = ContinuousClock.now + timeout
        while !done() {
            guard ContinuousClock.now < deadline else {
                XCTFail("timed out waiting for \(what)")
                throw CancellationError()
            }
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    private func documentMedia(_ screen: ArtifactViewController) -> [ChatMediaView] {
        let document = screen.view.allSubviews.compactMap { $0 as? ChatPlanView }.first { $0.accessibilityIdentifier == "artifact-document" }
        return (document?.mediaViews ?? []).compactMap { $0 as? ChatMediaView }
    }

    private func gallery(_ screen: ArtifactViewController) -> ArtifactGalleryView? {
        screen.view.subviews.compactMap { $0 as? ArtifactGalleryView }.first
    }

    // MARK: Markdown

    func testMarkdownWithTwoEmbeddedPicturesShowsBoth() async throws {
        let markdown = """
        # Q3 report

        Revenue rose in every region. ![Revenue by region](images/chart.png) The team photo is below.

        <p align="center"><img src="./images/team%20photo.jpg" alt="The team"></p>

        From the web: ![Logo](http://cdn.example.invalid/remote.png)

        Over TLS: ![Secure](https://secure.example.invalid/s.png)

        See the [appendix](docs/appendix.md) for the method.
        """
        let daemon = ArtifactDaemon(type: "markdown", title: "Q3 report", files: [
            .init(path: "docs/appendix.md", mimeType: "text/markdown", data: Data("# Appendix\n\n![Again](../images/chart.png)".utf8)),
            .init(path: "images/chart.png", mimeType: "image/png", data: Self.png(CGSize(width: 1200, height: 600), .systemOrange)),
            .init(path: "images/team photo.jpg", mimeType: "image/jpeg", data: Self.jpeg(CGSize(width: 300, height: 300), .systemTeal)),
            .init(path: "index.md", mimeType: "text/markdown", data: Data(markdown.utf8)),
        ], remote: Self.png(CGSize(width: 160, height: 80), .systemPurple))
        let (window, navigation, screen) = try await open(daemon, type: "markdown", title: "Q3 report")

        try await wait("the three pictures") { documentMedia(screen).filter { $0.pictureImage != nil }.count == 3 }
        let views = documentMedia(screen)
        XCTAssertEqual(views.count, 4)
        // Each in its own shape: the chart 2:1 across the column, the photo
        // and the web logo at their own sizes.
        let column = screen.view.bounds.width - 32
        XCTAssertEqual(views[0].frame.size, CGSize(width: column, height: (column / 2).rounded()))
        XCTAssertEqual(views[1].frame.size, CGSize(width: 300, height: 300))
        XCTAssertEqual(views[2].frame.size, CGSize(width: 160, height: 80))

        let requests = await daemon.requests
        XCTAssertTrue(requests.contains { $0.hasPrefix("/v0/artifacts/art1/versions/3/files/images/chart.png") }, "\(requests)")
        XCTAssertTrue(requests.contains { $0.hasPrefix("/v0/artifacts/art1/versions/3/files/images/team%20photo.jpg") }, "\(requests)")
        // The web picture came through the artifact's workspace, never the phone's network.
        let tunneled = await daemon.tunneled
        for line in ["CONNECT /v0/workspaces/work1/proxy HTTP/1.1", "CONNECT cdn.example.invalid:80 HTTP/1.1", "GET /remote.png HTTP/1.1"] {
            XCTAssertTrue(tunneled.contains(line), "\(tunneled)")
        }
        // https goes through the loopback proxy too, its TLS end to end (which this daemon can't speak).
        var secure: [String] = []
        for _ in 0..<100 where !secure.contains("CONNECT secure.example.invalid:443 HTTP/1.1") {
            secure = await daemon.tunneled
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertTrue(secure.contains("CONNECT secure.example.invalid:443 HTTP/1.1"), "\(secure)")

        window.overrideUserInterfaceStyle = .light
        try await settle()
        capture(window, "markdown-light")
        window.overrideUserInterfaceStyle = .dark
        try await settle()
        capture(window, "markdown-dark")

        // A tap on a picture opens the viewer on it, its neighbours a swipe away.
        screen.openDocumentPicture(views[1].item!.key)
        let viewer = try XCTUnwrap(screen.presentedViewController as? PictureViewController)
        XCTAssertEqual(viewer.index, 1)
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in viewer.dismiss(animated: false) { done.resume() } }

        // A link to another of its files opens it here, its picture resolved against its own folder.
        screen.open(link: "docs/appendix.md")
        try await wait("the appendix") { navigation.topViewController !== screen }
        let appendix = try XCTUnwrap(navigation.topViewController as? ArtifactViewController)
        XCTAssertEqual(appendix.title, "appendix.md")
        try await wait("the appendix's picture") { documentMedia(appendix).first?.pictureImage != nil }
    }

    // MARK: Image series

    func testImageSeriesShowsAllFourAndTheViewerSwipesThroughThem() async throws {
        let colors: [UIColor] = [.systemRed, .systemGreen, .systemBlue, .systemYellow]
        let sizes = [CGSize(width: 1600, height: 1200), CGSize(width: 900, height: 1200), CGSize(width: 1200, height: 800), CGSize(width: 1000, height: 1000)]
        let files = (0..<4).map { ArtifactDaemon.File(path: "frames/\($0 + 1).png", mimeType: "image/png", data: Self.png(sizes[$0], colors[$0])) }
        let daemon = ArtifactDaemon(type: "image_series", title: "Storyboard", files: files)
        let (window, _, screen) = try await open(daemon, type: "image_series", title: "Storyboard")

        try await wait("the grid") { gallery(screen)?.tileViews.filter { $0.pictureImage != nil }.count == 4 }
        let grid = try XCTUnwrap(gallery(screen))
        XCTAssertEqual(grid.items.map(\.size), sizes)
        let count = grid.subviews.compactMap { $0 as? UILabel }.first { $0.accessibilityIdentifier == "artifact-count" }
        XCTAssertEqual(count?.text, "4 images")
        // Where the layout puts them, every one visible.
        let layout = ArtifactMediaLayout(
            size: grid.bounds.size, safeArea: LayoutInsets(grid.safeAreaInsets),
            items: sizes.map { MediaLayout.Item(isVideo: false, image: MediaFlow.Image(width: $0.width, height: $0.height)) },
            count: count?.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)), badges: [nil, nil, nil, nil]
        )
        for (tile, frame) in zip(grid.tileViews, layout.tiles) {
            XCTAssertEqual(tile.frame.minX, frame.minX, accuracy: 0.5)
            XCTAssertEqual(tile.frame.width, frame.width, accuracy: 0.5)
            XCTAssertTrue(grid.bounds.contains(tile.frame), "\(tile.frame) is off screen")
        }
        window.overrideUserInterfaceStyle = .light
        try await settle()
        capture(window, "series-grid-light")
        window.overrideUserInterfaceStyle = .dark
        try await settle()
        capture(window, "series-grid-dark")

        grid.onOpen?(0)
        let viewer = try XCTUnwrap(screen.presentedViewController as? PictureViewController)
        try await settle()
        let pager = try XCTUnwrap(viewer.view.subviews.compactMap { $0 as? UIScrollView }.first)
        for index in 0..<4 {
            if index > 0 { pager.setContentOffset(CGPoint(x: pager.bounds.width * CGFloat(index), y: 0), animated: false) }
            XCTAssertEqual(viewer.index, index)
            try await wait("picture \(index + 1)") {
                pager.subviews.compactMap { $0 as? PicturePage }.contains { $0.frame.minX > pager.contentOffset.x - 1 && $0.frame.minX < pager.contentOffset.x + pager.bounds.width && $0.shownImage != nil }
            }
            let page = try XCTUnwrap(pager.subviews.compactMap { $0 as? PicturePage }.first { abs($0.frame.midX - (pager.contentOffset.x + pager.bounds.width / 2)) < 1 })
            let shown = try XCTUnwrap(page.shownImage)
            XCTAssertEqual(shown.size.width / shown.size.height, sizes[index].width / sizes[index].height, accuracy: 0.01)
            if index == 1 {
                for style in [UIUserInterfaceStyle.light, .dark] {
                    window.overrideUserInterfaceStyle = style
                    try await settle()
                    capture(window, "viewer-\(style == .light ? "light" : "dark")")
                }
            }
        }
        XCTAssertNotNil(viewer.view.subviews.first { $0.accessibilityIdentifier == "picture-share" })
    }

    // MARK: Video

    func testVideoShowsItsFirstFrameAndPlaysInTheViewer() async throws {
        let movie = try await Self.video()
        let daemon = ArtifactDaemon(type: "video", title: "Walkthrough", files: [.init(path: "walkthrough.mp4", mimeType: "video/mp4", data: movie)])
        let (window, _, screen) = try await open(daemon, type: "video", title: "Walkthrough")

        try await wait("the first frame") { gallery(screen)?.tileViews.first?.pictureImage != nil }
        let grid = try XCTUnwrap(gallery(screen))
        XCTAssertEqual(grid.items.first?.size, CGSize(width: 320, height: 180))
        XCTAssertEqual(grid.items.first?.duration ?? 0, 1, accuracy: 0.1)
        let badge = grid.subviews.compactMap { $0 as? UILabel }.first { $0.text == "0:01" }
        XCTAssertNotNil(badge)
        window.overrideUserInterfaceStyle = .light
        try await settle()
        capture(window, "video-light")
        window.overrideUserInterfaceStyle = .dark
        try await settle()
        capture(window, "video-dark")

        grid.onOpen?(0)
        let viewer = try XCTUnwrap(screen.presentedViewController as? PictureViewController)
        try await settle()
        let page = try XCTUnwrap(viewer.view.allSubviews.compactMap { $0 as? VideoPage }.first)
        try await wait("ready to play", timeout: .seconds(20)) { page.player.currentItem?.status == .readyToPlay }
        XCTAssertEqual(page.player.currentItem?.status, .readyToPlay)
        // Read in ranges, as a player seeks: never the whole file at once.
        let requests = await daemon.requests
        XCTAssertFalse(requests.filter { $0.contains("/files/walkthrough.mp4 bytes=") }.isEmpty)
        XCTAssertFalse(requests.contains("/v0/artifacts/art1/versions/3/files/walkthrough.mp4"))
        try await Task.sleep(for: .milliseconds(600))
        capture(window, "video-viewer-dark")
    }

    // MARK: Evidence

    private func settle() async throws {
        try await Task.sleep(for: .milliseconds(250))
    }

    private static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        return context.appendingPathComponent("evidence/artifact-media")
    }()

    private func capture(_ window: UIWindow, _ name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = Self.evidence, let data = image.pngData() {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try? data.write(to: folder.appendingPathComponent("\(name).png"))
        }
    }
}

private extension UIView {
    var allSubviews: [UIView] { subviews + subviews.flatMap(\.allSubviews) }
}
#endif
