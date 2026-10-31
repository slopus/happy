#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Pictures on a slow network (every one arrives 1.5 s after it is asked
/// for), drawn at moments from the first frame on: a chat picture, the
/// viewer, a story circle and the Settings picture. The frames go to the
/// repository's `.context/evidence/thumbhash/`.
@MainActor
final class HostedThumbHashEvidenceTests: XCTestCase {
    nonisolated static let delay: Duration = .milliseconds(1500)
    static let landscape = "HwgKPJxwd3dweHiHiHdwgAf3iA"
    static let square = "HwgKPxxwd3dweHiHiHiHd4h3Bwd4gI8I"

    /// Roughly what the hashes are: blue at the top left to yellow at the
    /// bottom right.
    nonisolated static func picture(_ size: CGSize) -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).pngData { context in
            let colors = [UIColor(red: 0.05, green: 0.05, blue: 0.6, alpha: 1).cgColor, UIColor(red: 0.55, green: 0.6, blue: 0.45, alpha: 1).cgColor, UIColor(red: 0.92, green: 0.8, blue: 0.3, alpha: 1).cgColor]
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 0.5, 1])!
            context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
            UIColor.white.withAlphaComponent(0.8).setFill()
            context.cgContext.fillEllipse(in: CGRect(x: size.width * 0.4, y: size.height * 0.3, width: size.height * 0.4, height: size.height * 0.4))
        }
    }

    private struct Slow: AgentTransport {
        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            try await Task.sleep(for: HostedThumbHashEvidenceTests.delay)
            return HTTP1Response(status: 200, headers: ["content-type": "image/png"], body: HostedThumbHashEvidenceTests.picture(CGSize(width: 600, height: 600)))
        }
        func close() async {}
    }

    private final class SlowMedia: ChatMediaSource {
        func cachedImage(_ key: String, pixels: Int) -> UIImage? { nil }
        func image(_ key: String, pixels: Int) async -> UIImage? {
            try? await Task.sleep(for: HostedThumbHashEvidenceTests.delay)
            return UIImage(data: HostedThumbHashEvidenceTests.picture(CGSize(width: 1600, height: 900)))
        }
        /// What the conversation's loader did before placeholders were made where they are shown.
        func placeholder(_ thumbhash: String) async -> UIImage? {
            await Task.detached { AccountPictureImages.placeholder(thumbhash)?.picture as? UIImage }.value
        }
    }

    private final class Host: UIViewController, ChatMediaProviding {
        let media = SlowMedia()
        var chatMedia: ChatMediaSource? { media }
    }

    private static let evidence: URL? = {
        let file = URL(fileURLWithPath: #filePath)
        // Inside a copy kept under `.context` (the code before), next to it.
        let parts = file.pathComponents
        if let at = parts.firstIndex(of: ".context") {
            return URL(fileURLWithPath: NSString.path(withComponents: Array(parts[...at]))).appendingPathComponent("evidence/thumbhash/before")
        }
        var root = file
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        return context.appendingPathComponent("evidence/thumbhash/after")
    }()

    private func capture(_ window: UIWindow, _ name: String, committing: Bool = false) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: committing)
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

    func testPicturesOnASlowNetwork() async throws {
        let host = Host()
        host.view.backgroundColor = UIColor(Palette.surface)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: host)
        window.overrideUserInterfaceStyle = .light
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        let images = Images(client: AgentClient(transport: Slow(), token: "t"))
        let pictures = AccountPictures(owner: "evidence-\(UUID().uuidString)", directory: nil) { _, _ in
            try? await Task.sleep(for: HostedThumbHashEvidenceTests.delay)
            return HostedThumbHashEvidenceTests.picture(CGSize(width: 600, height: 600))
        }
        let start = ContinuousClock.now

        // Configured before they are on screen, as a list configures a cell.
        let media = ChatMediaView()
        media.apply(ChatMedia(key: "tool/t/0", isVideo: false, thumbhash: Self.landscape, label: "a.png"))
        media.frame = CGRect(x: 16, y: 80, width: 358, height: 201)
        let viewer = PicturePage(source: host.media, picture: Picture(key: "tool/t/1", thumbhash: Self.landscape, label: "b.png"))
        viewer.backgroundColor = .black
        viewer.frame = CGRect(x: 16, y: 300, width: 220, height: 300)
        let story = StoriesCircleView(frame: CGRect(origin: CGPoint(x: 260, y: 320), size: StoriesRowLayout.Metrics.item))
        story.configure(StoriesRowItem(id: "u2", title: "Ada", isSelf: false, photo: "/v0/users/u2/photo", thumbhash: Self.square, initials: "AL", placeholderSeed: "u2", segments: 1, unseen: 1), images: images)
        let settings = RemoteImageView(size: SettingsProfileHeaderLayout.Metrics.avatarSize)
        settings.show(URL(string: "https://example.com/\(UUID().uuidString).png")!, thumbhash: Self.square, from: pictures)
        settings.frame = CGRect(x: 260, y: 440, width: 90, height: 90)
        for view in [media, viewer, story, settings] as [UIView] { host.view.addSubview(view) }
        host.view.layoutIfNeeded()

        // The first frame these are drawn in: nothing has had a turn yet.
        capture(window, "0-first-frame", committing: true)
        for (at, name) in [(100, "1-100ms"), (1000, "2-1000ms"), (1600, "3-1600ms-fading"), (2400, "4-2400ms-loaded")] {
            try await Task.sleep(until: start + .milliseconds(at), clock: .continuous)
            capture(window, name)
        }
        withExtendedLifetime((images, pictures)) {}
    }
}
#endif
