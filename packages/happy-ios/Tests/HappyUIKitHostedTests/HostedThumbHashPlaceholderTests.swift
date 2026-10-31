#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyLayout
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

/// Every picture with a thumbhash shows it in the first layout pass it is
/// in, while the network never answers, in the hash's shape; and one that
/// was already in memory is set without a fade.
@MainActor
final class HostedThumbHashPlaceholderTests: XCTestCase {
    /// 32 × 18 when decoded; 7:4 by its header.
    static let landscape = "HwgKPJxwd3dweHiHiHdwgAf3iA"
    static let square = "HwgKPxxwd3dweHiHiHiHd4h3Bwd4gI8I"

    /// A computer that never answers.
    private struct Hanging: AgentTransport {
        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            try await Task.sleep(for: .seconds(600))
            throw URLError(.timedOut)
        }
        func close() async {}
    }

    /// A conversation's media that never arrives, unless it is already kept.
    private final class Pictures: ChatMediaSource {
        var kept: UIImage?
        func cachedImage(_ key: String, pixels: Int) -> UIImage? { kept }
        func image(_ key: String, pixels: Int) async -> UIImage? {
            if let kept { return kept }
            try? await Task.sleep(for: .seconds(600))
            return nil
        }
    }

    private final class Host: UIViewController, ChatMediaProviding, ChatAttachmentProviding {
        let media = Pictures()
        let attachments = ChatAttachmentImages(pictures: AttachmentPictures(), sessionId: "s") { _ in
            try await Task.sleep(for: .seconds(600))
            throw URLError(.timedOut)
        }
        var chatMedia: ChatMediaSource? { media }
        var chatAttachments: ChatAttachmentImages? { attachments }
    }

    private func host() async throws -> (Host, UIWindow) {
        let host = Host()
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: host)
        addTeardownBlock { @MainActor in window.isHidden = true }
        window.layoutIfNeeded()
        return (host, window)
    }

    private var images: Images { Images(client: AgentClient(transport: Hanging(), token: "t")) }

    /// The placeholder is there and has the hash's shape (within what 32
    /// pixels can say).
    private func assertShape(_ image: UIImage?, of hash: String, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        guard let image else { return XCTFail("\(what): no placeholder in its first layout", file: file, line: line) }
        let expected = ThumbHash.aspectRatio(base64: hash) ?? 0
        XCTAssertEqual(image.size.width / image.size.height, expected, accuracy: 0.08, "\(what): not the hash's shape", file: file, line: line)
    }

    func testAChatPictureHasItsThumbhashBeforeItIsOnScreen() async throws {
        let (host, _) = try await host()
        let view = ChatMediaView()
        view.apply(ChatMedia(key: "tool/t/0", isVideo: false, thumbhash: Self.landscape, label: "a.png"))
        // Configured off screen, as a cell is before it is shown.
        assertShape(view.placeholderImage, of: Self.landscape, "chat picture, before a window")
        view.frame = CGRect(x: 16, y: 100, width: 280, height: 160)
        host.view.addSubview(view)
        view.layoutIfNeeded()
        assertShape(view.placeholderImage, of: Self.landscape, "chat picture")
        XCTAssertNil(view.pictureImage, "the network answered")
    }

    func testAnAttachedPictureHasItsThumbhashBeforeItIsOnScreen() async throws {
        let (host, _) = try await host()
        let view = ChatAttachmentView()
        view.apply(ChatAttachment(ref: "r1", thumbhash: Self.landscape))
        assertShape(view.placeholderImage, of: Self.landscape, "attachment, before a window")
        view.frame = CGRect(x: 16, y: 300, width: 280, height: 160)
        host.view.addSubview(view)
        view.layoutIfNeeded()
        assertShape(view.placeholderImage, of: Self.landscape, "attachment")
    }

    func testAnAvatarRowHasItsThumbhash() async throws {
        let (host, _) = try await host()
        let row = RowView(frame: CGRect(x: 0, y: 0, width: 390, height: 52))
        row.images = images
        row.configure(Row(id: "bot:research", nodeId: "bot:research", kind: .space, label: "Research", mark: .image(path: "/v0/bots/research/avatar", thumbhash: Self.square), targetKind: "bot"))
        host.view.addSubview(row)
        row.layoutIfNeeded()
        assertShape(row.markImage, of: Self.square, "avatar row")
    }

    func testAStoryCircleHasItsThumbhash() async throws {
        let (host, _) = try await host()
        let circle = StoriesCircleView(frame: CGRect(origin: CGPoint(x: 12, y: 500), size: StoriesRowLayout.Metrics.item))
        let item = StoriesRowItem(id: "u2", title: "Ada", isSelf: false, photo: "/v0/users/u2/photo", thumbhash: Self.landscape, initials: "AL", segments: 1, unseen: 1)
        circle.configure(item, images: images)
        assertShape(circle.avatarImage, of: Self.landscape, "story circle")
        // With nothing to read it with yet, the hash still shows.
        let waiting = StoriesCircleView(frame: circle.frame)
        waiting.configure(item, images: nil)
        assertShape(waiting.avatarImage, of: Self.landscape, "story circle without its reader")
        host.view.addSubview(circle)
        circle.layoutIfNeeded()
        assertShape(circle.avatarImage, of: Self.landscape, "story circle on screen")
    }

    /// The Happy account's Settings header picture.
    func testASettingsPictureHasItsThumbhash() async throws {
        let (host, _) = try await host()
        let pictures = AccountPictures(owner: "a", directory: nil) { _, _ in
            try? await Task.sleep(for: .seconds(600))
            return nil
        }
        let view = RemoteImageView(size: SettingsProfileHeaderLayout.Metrics.avatarSize)
        view.show(URL(string: "https://example.com/a.png")!, thumbhash: Self.square, from: pictures)
        host.view.addSubview(view)
        view.frame = CGRect(x: 100, y: 600, width: 90, height: 90)
        view.layoutIfNeeded()
        assertShape(view.image, of: Self.square, "Settings picture")
    }

    /// The viewer lays the placeholder out at the picture's size, not at
    /// its own 32 pixels.
    func testTheViewerDrawsThePlaceholderWhereThePictureGoes() async throws {
        let (host, _) = try await host()
        let page = PicturePage(source: host.media, picture: Picture(key: "tool/t/0", thumbhash: Self.landscape, label: "a.png", size: CGSize(width: 1600, height: 900)))
        page.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        host.view.addSubview(page)
        page.layoutIfNeeded()
        assertShape(page.shownImage, of: Self.landscape, "viewer")
        XCTAssertEqual(page.shownFrame.width, 390, "the placeholder isn't drawn at the picture's width")
        XCTAssertEqual(page.shownFrame.height, (390 * 900 / 1600).rounded(), accuracy: 1)

        // Without a stated size, the hash's shape across the screen.
        let unsized = PicturePage(source: host.media, picture: Picture(key: "tool/t/1", thumbhash: Self.landscape, label: "b.png"))
        unsized.frame = page.frame
        host.view.addSubview(unsized)
        unsized.layoutIfNeeded()
        XCTAssertEqual(unsized.shownFrame.width, 390)
        XCTAssertEqual(unsized.shownFrame.width / unsized.shownFrame.height, 7.0 / 4, accuracy: 0.02)
    }

    /// A picture already in memory goes straight in: no fade, so a reused
    /// cell doesn't flicker.
    func testAKeptPictureIsSetWithoutAFade() async throws {
        let (host, _) = try await host()
        host.media.kept = UIGraphicsImageRenderer(size: CGSize(width: 16, height: 9)).image { context in
            UIColor.orange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 16, height: 9))
        }
        let view = ChatMediaView(frame: CGRect(x: 16, y: 100, width: 280, height: 160))
        host.view.addSubview(view)
        view.apply(ChatMedia(key: "tool/t/0", isVideo: false, thumbhash: Self.landscape, label: "a.png"))
        view.layoutIfNeeded()
        XCTAssertTrue(view.pictureImage === host.media.kept)
        XCTAssertNil(view.placeholderImage, "the placeholder stayed under a kept picture")
        let animated = view.subviews.contains { !($0.layer.animationKeys() ?? []).isEmpty || $0.alpha < 1 }
        XCTAssertFalse(animated, "a kept picture faded in")
    }

    /// The Profile page: the photo's blur comes in the same update as the
    /// profile that names it, while the photo itself never arrives.
    func testTheProfilePageShowsTheBlurWithTheProfile() async throws {
        let daemon = ProfileDaemon()
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in daemon },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: Offline(), connector: NoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let computer = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"thumbhash-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Studio Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await controller.agentConnections.remove(computer.id)
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: computer.id, context: context))
        let page = ProfileViewController(source: session.profile)
        let navigation = UINavigationController(rootViewController: page)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        addTeardownBlock { @MainActor in window.isHidden = true }
        let deadline = Date().addingTimeInterval(5)
        while page.nameField.text != "Alex Rivera", Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(page.nameField.text, "Alex Rivera")
        assertShape(page.shownPhoto, of: ProfileDaemon.hash, "Profile page")
        var asked = false
        while !asked, Date() < deadline {
            asked = await daemon.photoAsked
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(asked, "the photo was never asked for")
        assertShape(page.shownPhoto, of: ProfileDaemon.hash, "Profile page, its photo on its way")
        withExtendedLifetime(controller) {}
    }

    /// How long a placeholder takes to make on the main thread, decoded
    /// fresh each time; written to the log.
    func testAPlaceholderIsCheapOnTheMainThread() {
        let hashes = [Self.landscape, Self.square, "W5eFGw43M0B3eHczQDjzi4+IiIiIiHg=", "1QcSHQRnh493V4dIh4eXh1h4kJUI"]
        var worst = Duration.zero
        var total = Duration.zero
        for round in 0..<25 {
            for hash in hashes {
                let start = ContinuousClock.now
                _ = AccountPictureImages.placeholder(hash)
                let took = ContinuousClock.now - start
                if round > 0 { worst = max(worst, took) }
                total += took
            }
        }
        print("thumbhash placeholder decode: mean \(total / 100), worst \(worst)")
        XCTAssertLessThan(worst, .milliseconds(4), "a decode is longer than half a 120 Hz frame")
    }
}

private struct Offline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct NoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// Answers the profile with a photo, and never sends the photo.
private actor ProfileDaemon: AgentTransport {
    static let hash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"
    private(set) var photoAsked = false

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        switch (method, path) {
        case ("GET", "/v0/profile"):
            let version = "0199a000-0000-7000-8000-000000000001"
            return HTTP1Response(status: 200, body: Data(#"{"profile":{"email":null,"name":"Alex Rivera","photo":{"thumbhash":"\#(Self.hash)"},"userId":null,"updatedAt":1,"version":"\#(version)"}}"#.utf8))
        case ("GET", "/v0/profile/photo"):
            photoAsked = true
            try await Task.sleep(for: .seconds(600))
            throw URLError(.timedOut)
        default:
            return HTTP1Response(status: 404, body: Data(#"{"error":"Not here.","code":"not_found"}"#.utf8))
        }
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.cannotConnectToHost) }
    func reset() async {}
    func close() async {}
}
#endif
