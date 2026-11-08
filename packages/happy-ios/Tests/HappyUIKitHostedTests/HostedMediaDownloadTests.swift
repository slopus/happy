#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A computer whose tool call presented a photo and a document, served a
/// range at a time, slowly enough to watch a ring fill.
actor SlowMediaDaemon: AgentTransport {
    let files: [Int: Data]
    let pace: Duration
    private(set) var ranges: [String] = []

    init(files: [Int: Data], pace: Duration = .milliseconds(120)) {
        self.files = files
        self.pace = pace
    }

    func browserConnection() async throws -> any BrowserStream { throw URLError(.unsupportedURL) }
    func upload(path: String, credential: String, body: Data) async throws -> HTTP1Response { HTTP1Response(status: 404) }
    func send(method: String, path: String, credential: String, body: Data, upload: Bool, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response { HTTP1Response(status: 404) }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.unsupportedURL) }
    func reset() async {}
    func close() async {}

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        guard let index = path.split(separator: "/").last.flatMap({ Int($0) }), let data = files[index] else { return HTTP1Response(status: 404) }
        try await Task.sleep(for: pace)
        // Only what was answered: a pause cancels one on its way.
        ranges.append(headers["Range"] ?? "whole")
        let file = ArtifactDaemon.File(path: "f", mimeType: "image/png", data: data)
        // At most 64 KB an answer, so a ring moves in steps.
        let range = headers["Range"].map { spec -> String in
            let bounds = spec.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
            let start = Int(bounds[0]) ?? 0
            return "bytes=\(start)-\(min(Int(bounds[1]) ?? Int.max, start + 64 * 1024 - 1))"
        }
        return ArtifactDaemon.serve(file, range: range)
    }
}

/// Media on its way to this phone: Telegram's ring and size badge on
/// pictures, videos and file cards, tap to pause and resume, kept for good.
@MainActor
final class HostedMediaDownloadTests: XCTestCase {
    private var window: UIWindow?
    private var directory: URL!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("HostedMediaDownloadTests-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
        try? FileManager.default.removeItem(at: directory)
    }

    /// A screen whose media source is under test.
    private final class Host: UIViewController, ChatMediaProviding {
        var source: ChatMediaSource?
        var chatMedia: ChatMediaSource? { source }
    }

    /// Board keys, a video's length, and nothing to load: rings as the board says.
    private final class Downloads: ChatMediaSource {
        var keys: [String: ChatDownload] = [:]
        func cachedImage(_ key: String, pixels: Int) -> UIImage? { nil }
        func image(_ key: String, pixels: Int) async -> UIImage? { nil }
        func download(_ key: String) -> ChatDownload? { keys[key] }
    }

    /// An old poster request can finish failing after the computer returns.
    private final class InterruptedPoster: ChatMediaSource {
        private(set) var requests = 0
        var pending: CheckedContinuation<UIImage?, Never>?
        let picture = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 20, height: 20))
        }

        func cachedImage(_ key: String, pixels: Int) -> UIImage? { nil }
        func image(_ key: String, pixels: Int) async -> UIImage? {
            requests += 1
            if requests > 1 { return picture }
            return await withCheckedContinuation { pending = $0 }
        }

        func failPending() {
            let pending = pending
            self.pending = nil
            pending?.resume(returning: nil)
        }
    }

    func testAReconnectWhileTheOldPosterIsFailingStillLoadsItsPicture() async throws {
        let source = InterruptedPoster()
        defer { source.failPending() }
        let host = try await host(source)
        let tile = ChatMediaView(frame: CGRect(x: 16, y: 120, width: 176, height: 140))
        host.view.addSubview(tile)
        tile.apply(ChatMedia(key: "video", isVideo: true, thumbhash: nil, label: "recording"))
        try await wait { source.pending != nil }

        // A reconnect is an edge, not a repeated poll. Even several edges
        // while the old read unwinds need only one fresh read when it fails.
        for _ in 0..<3 { NotificationCenter.default.post(name: MediaLoader.retry, object: source) }
        source.failPending()

        try await wait { tile.pictureImage != nil }
        XCTAssertEqual(source.requests, 2)
        XCTAssertTrue(tile.pictureImage === source.picture)
    }

    private func host(_ source: ChatMediaSource) async throws -> Host {
        let host = Host()
        host.source = source
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: host)
        host.view.backgroundColor = UIColor(Palette.surface)
        self.window = window
        window.layoutIfNeeded()
        return host
    }

    private func wait(_ seconds: Double = 5, _ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !condition() {
            guard ContinuousClock.now < deadline else { return XCTFail("timed out", file: file, line: line) }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    private func keep(_ name: String) async throws {
        guard let window else { return }
        for style in [UIUserInterfaceStyle.light, .dark] {
            window.overrideUserInterfaceStyle = style
            try await Task.sleep(for: .milliseconds(250))
            window.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
            let attachment = XCTAttachment(image: image)
            attachment.name = "\(name)-\(style == .dark ? "dark" : "light")"
            attachment.lifetime = .keepAlways
            add(attachment)
            if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
                try image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(attachment.name ?? name).png"))
            }
        }
        window.overrideUserInterfaceStyle = .unspecified
    }

    /// Every state a download shows, side by side as a chat shows them:
    /// a photo not here with its size, one coming in ("1.2 / 8.4 MB"), one
    /// paused, one that failed; a video's play button with its length and
    /// size, one playing while it downloads; a file card not here and one
    /// coming in. Each reads its state out to VoiceOver.
    func testEveryDownloadStateAsTelegramShowsIt() async throws {
        let source = Downloads()
        let host = try await host(source)
        let prefix = "test-\(UUID().uuidString)|"
        let board = DownloadBoard.shared
        let MB = 1024 * 1024
        let states: [(String, DownloadPhase, Bool, Double?)] = [
            ("remote", .remote(total: Int(8.4 * Double(MB))), false, nil),
            ("coming", .downloading(done: Int(1.2 * Double(MB)), total: Int(8.4 * Double(MB))), false, nil),
            ("paused", .paused(done: Int(3.1 * Double(MB)), total: Int(8.4 * Double(MB))), false, nil),
            ("failed", .failed(done: 0, total: 860_160), false, nil),
            ("video", .remote(total: 24 * MB), true, 12),
            ("playing", .downloading(done: 6 * MB, total: 24 * MB), true, 12),
        ]
        var tiles: [String: ChatMediaView] = [:]
        let hashes = ["3OcRJYB4d3h/iIeHeEh3eIhw+j2w", "1QcSHQRnh493V4dIh4eXh1h4kJUI", "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iHB2Rw"]
        for (index, (name, phase, video, duration)) in states.enumerated() {
            let key = "\(name)-key"
            source.keys[key] = ChatDownload(boardKey: prefix + name, duration: duration)
            board.set(prefix + name, phase)
            let tile = ChatMediaView(frame: CGRect(x: 16 + CGFloat(index % 2) * 184, y: 70 + CGFloat(index / 2) * 150, width: 176, height: 140))
            host.view.addSubview(tile)
            tile.apply(ChatMedia(key: key, isVideo: video, thumbhash: hashes[index % hashes.count], label: name))
            tile.layoutIfNeeded()
            tiles[name] = tile
        }
        XCTAssertEqual(tiles["remote"]?.ring?.state, .download)
        XCTAssertEqual(tiles["remote"]?.badge?.lines, ["8.4 MB"])
        XCTAssertEqual(tiles["remote"]?.accessibilityValue, "not downloaded, 8.4 MB, double-tap to download")
        XCTAssertEqual(tiles["coming"]?.ring?.state, .progress(Double(Int(1.2 * Double(MB))) / Double(Int(8.4 * Double(MB)))))
        XCTAssertEqual(tiles["coming"]?.badge?.lines, ["1.2 / 8.4 MB"])
        XCTAssertEqual(tiles["coming"]?.accessibilityValue, "downloading, 14%")
        XCTAssertEqual(tiles["paused"]?.ring?.state, .download)
        XCTAssertEqual(tiles["paused"]?.badge?.lines, ["3.1 / 8.4 MB"])
        XCTAssertEqual(tiles["paused"]?.accessibilityValue, "paused at 36%, double-tap to resume")
        XCTAssertEqual(tiles["failed"]?.ring?.state, .failed)
        XCTAssertEqual(tiles["video"]?.ring?.state, .play)
        XCTAssertEqual(tiles["video"]?.badge?.lines, ["0:12", "24 MB"])
        XCTAssertEqual(tiles["playing"]?.ring?.state, .playing(0.25))
        XCTAssertEqual(tiles["playing"]?.badge?.lines, ["0:12", "6 / 24 MB"])
        // The ring sits in the tile's middle, the badge in its corner.
        XCTAssertEqual(tiles["remote"]?.ring?.frame, CGRect(x: 63, y: 45, width: 50, height: 50))
        XCTAssertEqual(tiles["remote"]?.badge?.frame.origin, CGPoint(x: 6, y: 6))

        // File cards: the ring on the chip, the size beside the kind.
        for (index, (name, phase)) in [("doc-remote", DownloadPhase.remote(total: 2_400_000)), ("doc-coming", .downloading(done: 600_000, total: 2_400_000))].enumerated() {
            source.keys["\(name)-key"] = ChatDownload(boardKey: prefix + name, duration: nil)
            board.set(prefix + name, phase)
            let frame = CGRect(x: 16, y: 530 + CGFloat(index) * 76, width: 360, height: ResultCardLayout.height)
            let card = UIView(frame: frame)
            card.backgroundColor = UIColor(Palette.cardFill)
            card.layer.cornerRadius = ResultCardLayout.radius
            host.view.addSubview(card)
            let layout = ResultCardLayout(frame: CGRect(origin: .zero, size: frame.size), opens: true)
            let chip = UIView(frame: layout.chip)
            chip.backgroundColor = UIColor(Palette.cardChip)
            chip.layer.cornerRadius = ResultCardLayout.chipRadius
            card.addSubview(chip)
            let title = UILabel(frame: layout.title)
            title.text = "Quarterly report.pdf"
            title.font = .systemFont(ofSize: 14, weight: .semibold)
            title.textColor = UIColor(Palette.cardTitle)
            card.addSubview(title)
            let status = ChatFileStatusView(frame: card.bounds)
            card.addSubview(status)
            status.apply(ChatFileStatus(key: "\(name)-key", glyph: .ionicons("document-outline"), glyphSize: 20, kind: "PDF", size: 2_400_000,
                                        chip: layout.chip, detail: layout.detail, fontScale: 1))
            status.layoutIfNeeded()
            if index == 0 {
                XCTAssertEqual(status.ringState, .download)
                XCTAssertEqual(status.detailText, "PDF · 2.3 MB")
            } else {
                XCTAssertEqual(status.ringState, .progress(0.25))
                XCTAssertEqual(status.detailText, "PDF · 0.6 / 2.3 MB")
            }
        }
        try await keep("download-states")

        // Complete: the ring goes, a video keeps its play button.
        board.set(prefix + "coming", .complete(total: Int(8.4 * Double(MB))))
        board.set(prefix + "playing", .complete(total: 24 * MB))
        try await wait { tiles["coming"]?.ring?.isHidden == true }
        XCTAssertEqual(tiles["playing"]?.ring?.state, .play)
        XCTAssertEqual(tiles["playing"]?.badge?.lines, ["0:12"])
        board.clear(prefix: prefix)
    }

    /// End to end over a paired computer: a photo larger than automatic
    /// download allows waits under its arrow with its size; a tap on the
    /// ring reads it a range at a time, the ring and badge counting up;
    /// a second tap pauses it, a third resumes it from where it stopped;
    /// then the picture shows and stays on this phone: a new loader on
    /// the same library shows it without asking the computer again.
    func testATapDownloadsPausesAndResumesAndTheFileIsKeptForGood() async throws {
        let defaults = UserDefaults.standard
        let saved = MediaAutoDownload.load(defaults)
        var rules = MediaAutoDownload()
        rules.photos.limit = 1 * 1024 * 1024
        rules.save(defaults)
        addTeardownBlock { @MainActor in saved.save(defaults) }

        let photo = Self.noisePNG(width: 900, height: 600)
        // Bigger than the limit, as the tool presented it.
        XCTAssertGreaterThan(photo.count, 1024 * 1024)
        let size = photo.count
        let daemon = SlowMediaDaemon(files: [0: photo], pace: .milliseconds(Int(TestTime.budget(60))))
        let client = AgentClient(transport: daemon, token: "t")
        let library = MediaLibrary(namespace: "hosted-\(UUID().uuidString)", directory: directory)
        let loader = MediaLoader(client: client, agentId: "agent1", library: library)
        let media = Media(toolCallId: "call1", index: 0, item: AgentWire.MediaItem(kind: "image", name: "photo.png", mimeType: "image/png", size: Double(size), width: 1600, height: 1000, thumbhash: "3OcRJYB4d3h/iIeHeEh3eIhw+j2w", scale: nil, source: nil))
        loader.register([ChatItem(id: "m1", role: .agent, pieces: [.gallery([media], columns: 0)], delivery: .sent)])
        let host = try await host(loader)
        let tile = ChatMediaView(frame: CGRect(x: 16, y: 120, width: 358, height: 224))
        host.view.addSubview(tile)
        tile.apply(ChatMedia(key: media.key, isVideo: false, thumbhash: media.item.thumbhash, label: "photo.png"))
        tile.layoutIfNeeded()
        try await wait { tile.ring?.state == .download }
        XCTAssertEqual(tile.badge?.lines, [MediaSizeText.size(size)])
        let asked = await daemon.ranges
        XCTAssertEqual(asked, [], "a photo over the limit was read without a tap")
        try await keep("download-tap-waits")

        loader.toggleDownload(media.key)
        try await wait { if case .progress(let share) = tile.ring?.state { share > 0.15 } else { false } }
        try await keep("download-coming")
        loader.toggleDownload(media.key)
        try await wait { if case .paused = tile.downloadPhase { true } else { false } }
        XCTAssertEqual(tile.ring?.state, .download)
        let pausedAt = await daemon.ranges.count
        try await Task.sleep(for: .milliseconds(300))
        let afterPause = await daemon.ranges.count
        XCTAssertLessThanOrEqual(afterPause - pausedAt, 1, "it kept reading after a pause")

        loader.toggleDownload(media.key)
        try await wait(30) { tile.pictureImage != nil }
        try await wait { tile.ring?.isHidden ?? true }
        XCTAssertTrue(library.store.isComplete(loader.resourceID(media)))
        // Each byte read once, pause or not.
        let ranges = await daemon.ranges
        let starts = ranges.compactMap { Int($0.dropFirst(6).split(separator: "-").first ?? "") }
        XCTAssertEqual(Set(starts).count, starts.count, "a range was read twice: \(ranges)")
        try await keep("download-done")

        // Another screen, the same library: from disk, no network.
        let again = MediaLoader(client: client, agentId: "agent1", library: library)
        again.register([ChatItem(id: "m1", role: .agent, pieces: [.gallery([media], columns: 0)], delivery: .sent)])
        let image = await again.image(media.key, pixels: 400)
        XCTAssertNotNil(image)
        let total = await daemon.ranges.count
        XCTAssertEqual(total, ranges.count, "a kept file was read again")
    }

    /// Random pixels, which PNG can't make small.
    private static func noisePNG(width: Int, height: Int) -> Data {
        var generator = SystemRandomNumberGenerator()
        var pixels = [UInt8](repeating: 255, count: width * height * 4)
        for index in stride(from: 0, to: pixels.count, by: 4) {
            pixels[index] = UInt8.random(in: 0...255, using: &generator)
            pixels[index + 1] = UInt8.random(in: 0...255, using: &generator)
            pixels[index + 2] = UInt8.random(in: 0...255, using: &generator)
        }
        let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        return UIImage(cgImage: context.makeImage()!).pngData()!
    }

    /// A small photo reads itself as it shows up, at low priority.
    func testASmallPhotoDownloadsByItself() async throws {
        let photo = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 30)).image { context in
            UIColor.systemTeal.setFill(); context.fill(CGRect(x: 0, y: 0, width: 40, height: 30))
        }.pngData()!
        let daemon = SlowMediaDaemon(files: [0: photo], pace: .milliseconds(10))
        let library = MediaLibrary(namespace: "hosted-\(UUID().uuidString)", directory: directory)
        let loader = MediaLoader(client: AgentClient(transport: daemon, token: "t"), agentId: "agent1", library: library)
        let media = Media(toolCallId: "call2", index: 0, item: AgentWire.MediaItem(kind: "image", name: "small.png", mimeType: "image/png", size: Double(photo.count), width: 40, height: 30, thumbhash: nil, scale: nil, source: nil))
        loader.register([ChatItem(id: "m2", role: .agent, pieces: [.gallery([media], columns: 0)], delivery: .sent)])
        try await wait { library.store.isComplete(loader.resourceID(media)) }
    }

    /// Data and Storage: what is kept, Clear Media, and the automatic
    /// download switches with their limits.
    func testDataAndStorageShowsUsageAndClears() async throws {
        let library = MediaLibrary(namespace: "hosted-\(UUID().uuidString)", directory: directory)
        try library.store.keep("a", data: Data(count: 3 * 1024 * 1024))
        let defaults = UserDefaults(suiteName: "HostedMediaDownloadTests-\(UUID().uuidString)")!
        let page = DataStorageViewController(library: library, defaults: defaults)
        let navigation = UINavigationController(rootViewController: page)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        self.window = window
        window.layoutIfNeeded()
        page.measure()
        try await wait { page.shownUsage ?? 0 > 0 }
        XCTAssertEqual(page.shownRowIDs, [
            ["storage-usage", "clear-media"],
            ["auto-photos", "auto-photos-limit", "auto-videos", "auto-files", "auto-files-limit"],
        ])
        XCTAssertEqual(page.shownRow("storage-usage")?.value, "3 MB")
        XCTAssertEqual(page.shownRow("auto-files-limit")?.value, "1 MB")
        try await keep("data-storage")

        page.shownRow("auto-videos")?.toggled?(true)
        XCTAssertTrue(MediaAutoDownload.load(defaults).videos.enabled)
        XCTAssertTrue(page.shownRowIDs[1].contains("auto-videos-limit"))

        page.clear()
        try await wait { page.shownUsage == 0 }
        XCTAssertFalse(library.store.isComplete("a"))
        XCTAssertEqual(page.shownRow("storage-usage")?.value, "0 B")
    }
}
#endif
