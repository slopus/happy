#if canImport(UIKit)
import AVFoundation
import HappyCore
import UIKit
import UniformTypeIdentifiers

/// One conversation's pictures and recordings over the paired computer: a
/// tool call's from `GET /v0/agents/:id/tool-calls/:tcid/media/:index`, a
/// photo the person sent from the bytes they sent. Decoded off the main
/// thread at no more than they are drawn, and kept while memory allows.
/// A recording streams through `StemCellMediaStream`, a range at a time.
@MainActor
final class StemCellMediaLoader: NSObject, ChatMediaSource {
    private let client: DirectAgentClient
    private let agentId: String
    private var tools: [String: StemCellMedia] = [:]
    private var sent: [String: Data] = [:]
    private var streams: [String: StemCellMediaStream] = [:]
    /// Decoded pictures by "pixels|key", and the largest kept for each key.
    private let images = NSCache<NSString, UIImage>()
    private var largest: [String: Int] = [:]
    /// A tool's bytes, so a larger decode doesn't fetch them again.
    private let bytes = NSCache<NSString, NSData>()
    private let placeholders = NSCache<NSString, UIImage>()

    init(client: DirectAgentClient, agentId: String) {
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
        largest = [:]
    }

    /// What the conversation shows now, by the keys its plans draw.
    func register(_ items: [StemCellChatItem]) {
        for item in items {
            for piece in item.pieces {
                switch piece {
                case .picture(let id, _, let data): sent[Self.sentKey(id)] = data
                case .gallery(let media, _): for one in media { tools[one.key] = one }
                case .text: break
                }
            }
        }
    }

    nonisolated static func sentKey(_ id: String) -> String { "sent/\(id)" }

    func media(_ key: String) -> StemCellMedia? { tools[key] }

    // MARK: ChatMediaSource

    func cachedImage(_ key: String, pixels: Int) -> UIImage? {
        guard let kept = largest[key], kept >= pixels else { return nil }
        return images.object(forKey: "\(kept)|\(key)" as NSString)
    }

    func image(_ key: String, pixels: Int) async -> UIImage? {
        if let cached = cachedImage(key, pixels: pixels) { return cached }
        let image: UIImage?
        if let data = sent[key] {
            image = await Task.detached(priority: .userInitiated) { StemCellsImages.decode(data, maxPixels: pixels) }.value
        } else if let media = tools[key] {
            image = media.isVideo ? await poster(media, pixels: pixels) : await picture(media, pixels: pixels)
        } else {
            image = nil
        }
        if let image, pixels > largest[key] ?? 0 {
            let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
            images.setObject(image, forKey: "\(pixels)|\(key)" as NSString, cost: cost)
            largest[key] = pixels
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

    private func picture(_ media: StemCellMedia, pixels: Int) async -> UIImage? {
        let key = media.key as NSString
        let data: Data
        if let kept = bytes.object(forKey: key) {
            data = kept as Data
        } else {
            guard let response = try? await client.media(agentId, toolCallId: media.toolCallId, index: media.index) else { return nil }
            data = response.body
            bytes.setObject(data as NSData, forKey: key, cost: data.count)
        }
        return await Task.detached(priority: .userInitiated) { StemCellsImages.decode(data, maxPixels: pixels) }.value
    }

    /// A recording's first frame, read through its stream.
    private func poster(_ media: StemCellMedia, pixels: Int) async -> UIImage? {
        let generator = AVAssetImageGenerator(asset: stream(media).asset())
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: pixels, height: pixels)
        guard let frame = try? await generator.image(at: .zero) else { return nil }
        return UIImage(cgImage: frame.image)
    }

    // MARK: Playback

    /// A player for a recording, streamed from the computer as it plays.
    func player(_ key: String) -> AVPlayer? {
        guard let media = tools[key], media.isVideo else { return nil }
        return AVPlayer(playerItem: AVPlayerItem(asset: stream(media).asset()))
    }

    private func stream(_ media: StemCellMedia) -> StemCellMediaStream {
        if let stream = streams[media.key] { return stream }
        let stream = StemCellMediaStream(client: client, agentId: agentId, media: media)
        streams[media.key] = stream
        return stream
    }
}

/// A recording's bytes for AVFoundation, which can't send the computer's
/// token itself: a private URL scheme whose every request is answered here
/// with `Range` requests over the paired connection.
final class StemCellMediaStream: NSObject, AVAssetResourceLoaderDelegate, @unchecked Sendable {
    static let scheme = "happy-stem-media"
    /// Asked for at a time; a player asks for more as it plays.
    static let chunk = 512 * 1024

    private let client: DirectAgentClient
    private let agentId: String
    private let media: StemCellMedia
    private let queue = DispatchQueue(label: "engineering.happy.stem-media")
    /// Touched only on `queue`.
    private var serving: [ObjectIdentifier: Task<Void, Never>] = [:]
    private var total: Int?

    init(client: DirectAgentClient, agentId: String, media: StemCellMedia) {
        self.client = client
        self.agentId = agentId
        self.media = media
        total = media.item.size.map { Int($0) }
    }

    func asset() -> AVURLAsset {
        let name = (media.item.name as NSString).pathExtension
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

    private func serve(_ box: Request) async {
        let request = box.request
        do {
            let total = try await size()
            if let info = request.contentInformationRequest {
                info.contentType = UTType(mimeType: media.item.mimeType)?.identifier ?? UTType.mpeg4Movie.identifier
                info.contentLength = Int64(total)
                info.isByteRangeAccessSupported = true
            }
            if let data = request.dataRequest {
                var offset = Int(data.currentOffset != 0 ? data.currentOffset : data.requestedOffset)
                let end = data.requestsAllDataToEndOfResource ? total : min(total, Int(data.requestedOffset) + data.requestedLength)
                while offset < end {
                    try Task.checkCancellation()
                    let response = try await client.media(agentId, toolCallId: media.toolCallId, index: media.index, range: offset...(min(end, offset + Self.chunk) - 1))
                    // A whole file answered to a range starts at zero.
                    let body = response.status == 200 ? response.body.dropFirst(offset) : response.body
                    guard !body.isEmpty else { break }
                    data.respond(with: Data(body.prefix(end - offset)))
                    offset += min(body.count, end - offset)
                }
            }
            request.finishLoading()
        } catch is CancellationError {
        } catch {
            request.finishLoading(with: error)
        }
    }

    /// The recording's length: as presented, else from a first range's
    /// `Content-Range`.
    private func size() async throws -> Int {
        if let total { return total }
        let response = try await client.media(agentId, toolCallId: media.toolCallId, index: media.index, range: 0...1)
        let range = response.headers.first { $0.key.lowercased() == "content-range" }?.value
        let size = range.flatMap { $0.split(separator: "/").last.flatMap { Int($0) } } ?? response.body.count
        total = size
        return size
    }
}
#endif
