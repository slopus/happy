#if canImport(UIKit)
import AVFoundation
import HappyCore
import os
import UIKit
import UniformTypeIdentifiers

/// One conversation's pictures and recordings over the paired computer: a
/// tool call's from `GET /v0/agents/:id/tool-calls/:tcid/media/:index`, a
/// photo the person sent from the bytes they sent. Decoded off the main
/// thread at no more than they are drawn, and kept while memory allows.
/// A recording streams through `MediaStream`, a range at a time.
@MainActor
final class MediaLoader: NSObject, ChatMediaSource {
    private let client: AgentClient
    /// New work's is the daemon's ID once it has made it.
    var agentId: String
    private var tools: [String: Media] = [:]
    private var sent: [String: Data] = [:]
    private var streams: [String: MediaStream] = [:]
    /// Each key's largest decode, so eviction drops the size with the picture.
    private let images = NSCache<NSString, Decoded>()
    /// A tool's bytes, so a larger decode doesn't fetch them again.
    private let bytes = NSCache<NSString, NSData>()
    private let placeholders = NSCache<NSString, UIImage>()
    #if DEBUG
    /// UI tests: every picture fails until the first retry, as a dropped
    /// connection would make it (`V2_MEDIA_FAIL_UNTIL_RETRY`).
    private var failsUntilRetry = ProcessInfo.processInfo.environment["HAPPY_MEDIA_FAIL_UNTIL_RETRY"] == "1"
    #endif

    init(client: AgentClient, agentId: String) {
        self.client = client
        self.agentId = agentId
        images.totalCostLimit = 48 * 1024 * 1024
        bytes.totalCostLimit = 32 * 1024 * 1024
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(memoryWarning), name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
    }

    @objc private func memoryWarning() {
        images.removeAllObjects()
        bytes.removeAllObjects()
    }

    private final class Decoded {
        let pixels: Int
        let image: UIImage
        init(pixels: Int, image: UIImage) {
            self.pixels = pixels
            self.image = image
        }
    }

    /// What the conversation shows now, by the keys its plans draw.
    func register(_ items: [ChatItem]) {
        for item in items {
            for piece in item.pieces {
                switch piece {
                case .picture(let id, _, let data): sent[Self.sentKey(id)] = data
                case .gallery(let media, _), .tree(let media, _): for one in media { tools[one.key] = one }
                case .file(let one): tools[one.key] = one
                case .text, .artifact, .story, .sidebarProposal: break
                }
            }
        }
    }

    nonisolated static func sentKey(_ id: String) -> String { "sent/\(id)" }

    func media(_ key: String) -> Media? { tools[key] }

    // MARK: ChatMediaSource

    func cachedImage(_ key: String, pixels: Int) -> UIImage? {
        guard let kept = images.object(forKey: key as NSString), kept.pixels >= pixels else { return nil }
        return kept.image
    }

    func image(_ key: String, pixels: Int) async -> UIImage? {
        if let cached = cachedImage(key, pixels: pixels) { return cached }
        let image: UIImage?
        if let data = sent[key] {
            image = await Task.detached(priority: .userInitiated) { Images.decode(data, maxPixels: pixels) }.value
        } else if let media = tools[key] {
            image = media.isVideo ? await poster(media, pixels: pixels) : await picture(media, pixels: pixels)
        } else {
            image = nil
        }
        if let image, pixels > images.object(forKey: key as NSString)?.pixels ?? 0 {
            let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
            images.setObject(Decoded(pixels: pixels, image: image), forKey: key as NSString, cost: cost)
        }
        return image
    }

    func placeholder(_ thumbhash: String) async -> UIImage? {
        if let kept = placeholders.object(forKey: thumbhash as NSString) { return kept }
        let image = await Task.detached(priority: .userInitiated) {
            AccountPictureImages.placeholder(thumbhash)?.picture as? UIImage
        }.value
        if let image { placeholders.setObject(image, forKey: thumbhash as NSString) }
        return image
    }

    private func picture(_ media: Media, pixels: Int) async -> UIImage? {
        #if DEBUG
        if failsUntilRetry { return nil }
        #endif
        let key = media.key as NSString
        let data: Data
        if let kept = bytes.object(forKey: key) {
            data = kept as Data
        } else {
            guard let response = try? await client.media(agentId, toolCallId: media.toolCallId, index: media.index) else { return nil }
            data = response.body
            bytes.setObject(data as NSData, forKey: key, cost: data.count)
        }
        return await Task.detached(priority: .userInitiated) { Images.decode(data, maxPixels: pixels) }.value
    }

    /// A recording's first frame, read through its stream.
    private func poster(_ media: Media, pixels: Int) async -> UIImage? {
        let generator = AVAssetImageGenerator(asset: stream(media).asset())
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: pixels, height: pixels)
        guard let frame = try? await generator.image(at: .zero) else { return nil }
        return UIImage(cgImage: frame.image)
    }

    /// Asks every picture that failed to load to try again, as when the
    /// computer is reachable again.
    func retryFailed() {
        #if DEBUG
        failsUntilRetry = false
        #endif
        NotificationCenter.default.post(name: Self.retry, object: self)
    }

    nonisolated static let retry = Notification.Name("V2MediaLoader.retry")

    /// A document's or file's bytes, as presented, written to `url` a range
    /// at a time off the main thread. False when they could not be read.
    func download(_ media: Media, to url: URL) async -> Bool {
        let kept = bytes.object(forKey: media.key as NSString).map { $0 as Data }
        let client = client
        let agentId = agentId
        return await Task.detached(priority: .userInitiated) { () -> Bool in
            let manager = FileManager.default
            do {
                try manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                if let kept { try kept.write(to: url, options: .atomic); return true }
                guard manager.createFile(atPath: url.path, contents: nil) else { return false }
                let handle = try FileHandle(forWritingTo: url)
                defer { try? handle.close() }
                try await AgentClient.read({ range in
                    try await client.media(agentId, toolCallId: media.toolCallId, index: media.index, range: range)
                }, each: { piece, _, _ in try handle.write(contentsOf: piece) })
                return true
            } catch {
                try? manager.removeItem(at: url)
                return false
            }
        }.value
    }

    // MARK: Playback

    /// A player for a recording, streamed from the computer as it plays.
    func player(_ key: String) -> AVPlayer? {
        guard let media = tools[key], media.isVideo else { return nil }
        return AVPlayer(playerItem: AVPlayerItem(asset: stream(media).asset()))
    }

    private func stream(_ media: Media) -> MediaStream {
        if let stream = streams[media.key] { return stream }
        let stream = MediaStream(client: client, agentId: agentId, media: media)
        streams[media.key] = stream
        return stream
    }
}

/// A recording's bytes for AVFoundation, which can't send the computer's
/// token itself: a private URL scheme whose every request is answered here
/// with `Range` requests over the paired connection.
final class MediaStream: NSObject, AVAssetResourceLoaderDelegate, @unchecked Sendable {
    static let scheme = "happy-v2-media"
    /// Asked for at a time; a player asks for more as it plays.
    static let chunk = 512 * 1024
    #if DEBUG
    /// Each range read, for checking that a recording streams.
    private static let log = Logger(subsystem: "engineering.happy", category: "media")
    #endif

    private let client: AgentClient
    private let agentId: String
    private let media: Media
    private let queue = DispatchQueue(label: "engineering.happy.v2-media")
    /// Touched only on `queue`.
    private var serving: [ObjectIdentifier: Task<Void, Never>] = [:]
    private var total: Int?

    init(client: AgentClient, agentId: String, media: Media) {
        self.client = client
        self.agentId = agentId
        self.media = media
        total = media.item.size.map { Int($0) }
    }

    func asset() -> AVURLAsset {
        // Letters and digits only, so the URL always parses.
        let name = (media.item.name as NSString).pathExtension.filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
        let url = URL(string: "\(Self.scheme)://media/\(media.index)\(name.isEmpty ? "" : "." + name)")!
        let asset = AVURLAsset(url: url)
        asset.resourceLoader.setDelegate(self, queue: queue)
        return asset
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader, shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest) -> Bool {
        let id = ObjectIdentifier(loadingRequest)
        let request = Request(loadingRequest)
        serving[id] = Task { [weak self] in
            guard let self else { return }
            await serve(request)
            queue.async { self.serving[id] = nil }
        }
        return true
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader, didCancel loadingRequest: AVAssetResourceLoadingRequest) {
        serving.removeValue(forKey: ObjectIdentifier(loadingRequest))?.cancel()
    }

    private struct Request: @unchecked Sendable {
        let request: AVAssetResourceLoadingRequest
        init(_ request: AVAssetResourceLoadingRequest) { self.request = request }
    }

    /// Fetches off `queue`; reads and answers the request only on it, where
    /// AVFoundation cancels it.
    private func serve(_ box: Request) async {
        do {
            let total = try await size()
            let type = UTType(mimeType: media.item.mimeType)?.identifier ?? UTType.mpeg4Movie.identifier
            let span = await onQueue { () -> Range<Int>? in
                let request = box.request
                guard !request.isCancelled else { return nil }
                if let info = request.contentInformationRequest {
                    info.contentType = type
                    info.contentLength = Int64(total)
                    info.isByteRangeAccessSupported = true
                }
                guard let data = request.dataRequest else { return 0..<0 }
                let start = Int(data.currentOffset != 0 ? data.currentOffset : data.requestedOffset)
                let end = data.requestsAllDataToEndOfResource ? total : min(total, Int(data.requestedOffset) + data.requestedLength)
                return start..<max(start, end)
            }
            guard let span else { return }
            var offset = span.lowerBound
            while offset < span.upperBound {
                try Task.checkCancellation()
                let response = try await client.media(agentId, toolCallId: media.toolCallId, index: media.index, range: offset...(min(span.upperBound, offset + Self.chunk) - 1))
                #if DEBUG
                Self.log.notice("range \(offset)-\(min(span.upperBound, offset + Self.chunk) - 1) of \(total): \(response.status), \(response.body.count) bytes")
                #endif
                // A whole file answered to a range starts at zero.
                let body = response.status == 200 ? response.body.dropFirst(offset) : response.body
                guard !body.isEmpty else { throw URLError(.networkConnectionLost) }
                let piece = Data(body.prefix(span.upperBound - offset))
                let going = await onQueue { () -> Bool in
                    guard !box.request.isCancelled else { return false }
                    box.request.dataRequest?.respond(with: piece)
                    return true
                }
                guard going else { return }
                offset += piece.count
            }
            await onQueue { if !box.request.isCancelled { box.request.finishLoading() } }
        } catch is CancellationError {
        } catch {
            await onQueue { if !box.request.isCancelled { box.request.finishLoading(with: error) } }
        }
    }

    /// The recording's length: as presented, else from a first range's
    /// `Content-Range`, else a whole file's length.
    private func size() async throws -> Int {
        if let total = await onQueue({ self.total }) { return total }
        let response = try await client.media(agentId, toolCallId: media.toolCallId, index: media.index, range: 0...1)
        let range = response.headers.first { $0.key.lowercased() == "content-range" }?.value
        guard let size = range.flatMap({ $0.split(separator: "/").last.flatMap { Int($0) } }) ?? (response.status == 200 ? response.body.count : nil) else {
            throw URLError(.cannotParseResponse)
        }
        await onQueue { self.total = size }
        return size
    }

    private func onQueue<T: Sendable>(_ work: @escaping @Sendable () -> T) async -> T {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: work()) }
        }
    }
}
#endif
