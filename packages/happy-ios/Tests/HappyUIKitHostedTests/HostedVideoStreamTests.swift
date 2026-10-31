#if canImport(UIKit)
import AVFoundation
import AVKit
import Foundation
@testable import HappyCore
import HappyCrypto
import HappyLayout
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

/// A video plays as soon as its first range is here, while the rest of it
/// downloads behind: Telegram's play button over its first frame, a small
/// spinner only until it can play, then the system's player. Over a paired
/// computer and over a legacy session, whose sealed file is opened a range
/// at a time.
@MainActor
final class HostedVideoStreamTests: XCTestCase {
    private var window: UIWindow?
    private var directory: URL!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("HostedVideoStreamTests-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() async throws {
        VideoOpening.shared.cancel()
        if let presented = window?.rootViewController?.presentedViewController {
            await withCheckedContinuation { continuation in presented.dismiss(animated: false) { continuation.resume() } }
        }
        window?.isHidden = true
        window = nil
        try? FileManager.default.removeItem(at: directory)
    }

    /// The agent chat's screen, as far as its tiles look for their media.
    private final class AgentHost: UIViewController, ChatMediaProviding {
        var source: ChatMediaSource?
        var chatMedia: ChatMediaSource? { source }
    }

    /// The legacy chat's screen, as far as its tiles look for their files.
    private final class LegacyHost: UIViewController, ChatAttachmentProviding {
        var chatAttachments: ChatAttachmentImages?
    }

    /// Board keys and lengths, nothing to load: rings as the board says.
    private final class Boards: ChatMediaSource {
        var keys: [String: ChatDownload] = [:]
        func cachedImage(_ key: String, pixels: Int) -> UIImage? { nil }
        func image(_ key: String, pixels: Int) async -> UIImage? { nil }
        func download(_ key: String) -> ChatDownload? { keys[key] }
    }

    private func show(_ host: UIViewController) async throws {
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: host)
        host.view.backgroundColor = UIColor(Palette.surface)
        self.window = window
        window.layoutIfNeeded()
    }

    private func wait(_ seconds: Double = 5, _ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !condition() {
            guard ContinuousClock.now < deadline else { return XCTFail("timed out", file: file, line: line) }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    /// The window in light and dark, kept with the test and written to
    /// `HAPPY_PREVIEW_DIR` when it is set.
    private func keep(_ name: String, styles: [UIUserInterfaceStyle] = [.light, .dark]) async throws {
        guard let window else { return }
        for style in styles {
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

    /// Held on screen this long while it plays, for a screen recording
    /// (`HAPPY_VIDEO_HOLD`, in seconds).
    private func holdForRecording() async throws {
        guard let seconds = ProcessInfo.processInfo.environment["HAPPY_VIDEO_HOLD"].flatMap(Double.init), seconds > 0 else { return }
        try await Task.sleep(for: .seconds(seconds))
    }

    /// The play button's states side by side, as a chat shows them: ready
    /// to play with its length and size, its spinner while the first range
    /// comes, and its ring while the rest downloads.
    func testThePlayButtonsStates() async throws {
        let host = AgentHost()
        let boards = Boards()
        host.source = boards
        try await show(host)
        let board = DownloadBoard.shared
        let prefix = "hosted-play-\(UUID().uuidString)|"
        defer {
            board.clear(prefix: prefix)
            for key in ["ready", "starting", "playing"] { DownloadRings.shared.setStarting(prefix + key, false) }
        }
        let total = 8_808_038
        board.set(prefix + "ready", .remote(total: total))
        board.set(prefix + "starting", .remote(total: total))
        board.set(prefix + "playing", .downloading(done: 1_258_291, total: total))
        DownloadRings.shared.setStarting(prefix + "starting", true)
        DownloadRings.shared.drain()
        var tiles: [String: ChatMediaView] = [:]
        for (index, key) in ["ready", "starting", "playing"].enumerated() {
            boards.keys[key] = ChatDownload(boardKey: prefix + key, duration: 12)
            let tile = ChatMediaView(frame: CGRect(x: 16, y: 80 + CGFloat(index) * 230, width: 358, height: 214))
            host.view.addSubview(tile)
            tile.apply(ChatMedia(key: key, isVideo: true, thumbhash: "3OcRJYB4d3h/iIeHeEh3eIhw+j2w", label: "clip.mp4"))
            tile.layoutIfNeeded()
            tiles[key] = tile
        }
        XCTAssertEqual(tiles["ready"]?.ring?.state, .play)
        XCTAssertEqual(tiles["ready"]?.badge?.lines, ["0:12", "8.4 MB"])
        XCTAssertEqual(tiles["starting"]?.ring?.state, .starting)
        XCTAssertEqual(tiles["playing"]?.ring?.state, .playing(1_258_291 / Double(total)))
        XCTAssertEqual(tiles["playing"]?.badge?.lines, ["0:12", "1.2 / 8.4 MB"])
        try await keep("video-play-button")
        // Ready to play: the spinner goes back to the play glyph.
        DownloadRings.shared.setStarting(prefix + "starting", false)
        XCTAssertEqual(tiles["starting"]?.ring?.state, .play)
    }

    /// Over a paired computer: the first frame and length come from a few
    /// ranges; a tap spins only until the first playable range is here,
    /// then the player plays while most of the file is still to come; the
    /// file reads on behind and is kept.
    func testAnAgentsVideoPlaysWhileItDownloads() async throws {
        let video = try await Self.video(seconds: 6)
        XCTAssertGreaterThan(video.count, 1_000_000, "too small to show streaming")
        let daemon = SlowMediaDaemon(files: [0: video], pace: .milliseconds(150))
        let library = MediaLibrary(namespace: "hosted-\(UUID().uuidString)", directory: directory)
        let loader = MediaLoader(client: AgentClient(transport: daemon, token: "t"), agentId: "agent1", library: library)
        let media = Media(toolCallId: "call1", index: 0, item: AgentWire.MediaItem(kind: "video", name: "clip.mp4", mimeType: "video/mp4", size: Double(video.count), width: 640, height: 360, thumbhash: nil, scale: nil, source: nil))
        loader.register([ChatItem(id: "m1", role: .agent, pieces: [.gallery([media], columns: 0)], delivery: .sent)])
        let host = AgentHost()
        host.source = loader
        try await show(host)
        let tile = ChatMediaView(frame: CGRect(x: 16, y: 120, width: 358, height: 201))
        host.view.addSubview(tile)
        tile.apply(ChatMedia(key: media.key, isVideo: true, thumbhash: nil, label: "clip.mp4"))
        tile.layoutIfNeeded()

        // Its first frame and length, without the whole file.
        try await wait(20) { tile.pictureImage != nil }
        try await wait { tile.badge?.lines.first == "0:06" }
        XCTAssertEqual(tile.ring?.state, .play)
        let id = loader.resourceID(media)
        XCTAssertFalse(library.store.isComplete(id), "the first frame took the whole file")

        // The tap: the spinner, then the player, playing before the file is here.
        let boardKey = try XCTUnwrap(loader.download(media.key)?.boardKey)
        VideoOpening.shared.open(boardKey: boardKey, from: host) { loader.player(media.key) }
        XCTAssertEqual(tile.ring?.state, .starting)
        try await wait(20) { VideoOpening.shared.presented?.player != nil && host.presentedViewController != nil }
        XCTAssertNotEqual(tile.ring?.state, .starting)
        let player = try XCTUnwrap(VideoOpening.shared.presented?.player)
        try await wait(30) { player.currentTime().seconds > 0.5 }
        let phase = await library.downloads.phase(id, source: loader.source(media))
        XCTAssertFalse(phase.isComplete, "it played only once the whole file was here")
        let done = phase.share ?? 0
        XCTAssertLessThan(done, 0.8, "most of the file was here before it played")
        try await holdForRecording()

        // The rest reads on behind and is kept.
        try await wait(60) { library.store.isComplete(id) }
        XCTAssertEqual(try Data(contentsOf: library.store.completeURL(id)), video)
    }

    /// Over a legacy session: its file is sealed on the server, and each
    /// range the player asks for is opened on the way; the whole file is
    /// kept, opened, once its MAC checks.
    func testALegacyVideoPlaysWhileItDownloads() async throws {
        let video = try await Self.video(seconds: 4)
        let key = Data((0..<32).map { UInt8($0) })
        let sealed = try BlobCipher.seal(video, key: key)
        let served = Served()
        let pace = Duration.milliseconds(150)
        let source: ChatAttachmentImages.Source = { _, size in
            MediaSource(length: size.map { $0 + MediaSeal.header }, seal: MediaSeal(key: key)) { range in
                try await Task.sleep(for: pace)
                await served.add(range)
                // At most 64 KB an answer, as a slow link gives them.
                let end = min(sealed.count, range.upperBound, range.lowerBound + 64 * 1024)
                return MediaPiece(offset: range.lowerBound, data: sealed.subdata(in: range.lowerBound..<end), total: sealed.count)
            }
        }
        let library = MediaLibrary(namespace: "hosted-\(UUID().uuidString)", directory: directory)
        let images = ChatAttachmentImages(pictures: AttachmentPictures(), sessionId: "s1", library: library, source: source)
        let host = LegacyHost()
        host.chatAttachments = images
        try await show(host)

        // As the session's file event draws it: a recording by its name.
        let input: JSONValue = .object(["ref": .string("ref1"), "name": .string("clip.mov"), "size": .number(Double(video.count))])
        let tool = ToolCall(callId: "f1", name: "file", state: .completed, input: input, createdAt: 0)
        let entry = try XCTUnwrap(ChatRowRenderer.fileView(tool, text: ChatRowText(environment: nil, words: .english)))
        let (items, hits) = entry.piece.draw(CGRect(x: 0, y: 0, width: 390, height: 600))
        guard case .attachment(let attachment, let frame)? = items.first else { return XCTFail("no attachment drawn: \(items)") }
        XCTAssertTrue(attachment.isVideo)
        XCTAssertEqual(hits.first { $0.frame.contains(CGPoint(x: frame.midX, y: frame.midY)) }?.action, .playAttachment(attachment))
        XCTAssertEqual(hits.first { $0.frame.contains(CGPoint(x: frame.minX + 10, y: frame.minY + 10)) }?.action, .toggleDownload("ref1"))

        let tile = ChatAttachmentView(frame: frame.offsetBy(dx: 0, dy: 120))
        host.view.addSubview(tile)
        tile.apply(attachment)
        tile.layoutIfNeeded()
        try await wait(20) { tile.pictureImage != nil }
        try await wait { tile.sizeBadge?.lines.first == "0:04" }
        XCTAssertEqual(tile.ring?.state, .play)
        XCTAssertFalse(library.store.isComplete("ref1"))
        try await keep("legacy-video-play-button")

        let boardKey = try XCTUnwrap(images.download("ref1")?.boardKey)
        VideoOpening.shared.open(boardKey: boardKey, from: host) { images.player(attachment) }
        XCTAssertEqual(tile.ring?.state, .starting)
        try await wait(20) { VideoOpening.shared.presented?.player != nil && host.presentedViewController != nil }
        let player = try XCTUnwrap(VideoOpening.shared.presented?.player)
        try await wait(30) { player.currentTime().seconds > 0.5 }
        XCTAssertFalse(library.store.isComplete("ref1"), "it played only once the whole file was here")
        try await holdForRecording()

        // Kept opened, once the MAC checked.
        try await wait(60) { library.store.isComplete("ref1") }
        XCTAssertEqual(try Data(contentsOf: library.store.completeURL("ref1")), video)
    }

    private actor Served {
        var ranges: [Range<Int>] = []
        func add(_ range: Range<Int>) { ranges.append(range) }
    }

    /// `seconds` of 640×360 H.264 at 30 fps, its index first so it can play
    /// from the start: a colour sweep and a moving box under a little
    /// noise, which keeps it a few megabytes.
    nonisolated static func video(seconds: Int) async throws -> Data {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).mp4")
        defer { try? FileManager.default.removeItem(at: url) }
        let (width, height) = (640, 360)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 4_000_000],
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
        ])
        writer.add(input)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        var noise: UInt32 = 0x9E37_79B9
        let frames = seconds * 30
        for frame in 0..<frames {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer)
            let pixels = buffer!
            CVPixelBufferLockBaseAddress(pixels, [])
            let base = CVPixelBufferGetBaseAddress(pixels)!.assumingMemoryBound(to: UInt8.self)
            let row = CVPixelBufferGetBytesPerRow(pixels)
            let boxX = frame * (width - 120) / max(1, frames - 1)
            let shift = frame * 255 / max(1, frames - 1)
            for y in 0..<height {
                for x in 0..<width {
                    noise ^= noise << 13
                    noise ^= noise >> 17
                    noise ^= noise << 5
                    let grain = Int(noise & 31) - 16
                    let at = y * row + x * 4
                    let inBox = x >= boxX && x < boxX + 120 && y >= 120 && y < 240
                    base[at] = UInt8(clamping: (inBox ? 250 : (x * 255 / width + shift) % 256) + grain)
                    base[at + 1] = UInt8(clamping: (inBox ? 250 : y * 255 / height) + grain)
                    base[at + 2] = UInt8(clamping: (inBox ? 250 : 255 - shift) + grain)
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
}
#endif
