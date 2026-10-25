#if canImport(UIKit)
import AVFoundation
import HappyCore
import UIKit
import UniformTypeIdentifiers

/// One computer's story pictures, recordings and stickers, read over the
/// paired connection and decoded off the main thread at no more than they
/// are drawn. A frame's bytes never change for its URL, so they are kept
/// while memory allows; sticker files are kept on disk by their digest.
@MainActor
final class StoriesMedia {
    private let client: DirectAgentClient
    private let images = NSCache<NSString, Decoded>()
    private let placeholders = NSCache<NSString, UIImage>()
    private var loading: [String: Task<UIImage?, Never>] = [:]
    private var packs: [String: Task<[String: Sticker], Never>] = [:]
    private var stickerFiles: [String: Task<Data?, Never>] = [:]
    private var streams: [String: StoriesByteStream] = [:]
    nonisolated(unsafe) private var observer: NSObjectProtocol?

    private final class Decoded {
        let pixels: Int
        let image: UIImage
        init(pixels: Int, image: UIImage) { self.pixels = pixels; self.image = image }
    }

    init(client: DirectAgentClient) {
        self.client = client
        images.totalCostLimit = 64 * 1024 * 1024
        observer = NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.images.removeAllObjects()
                // A playing recording keeps its own stream (see `asset()`).
                self?.streams.removeAll()
            }
        }
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    // MARK: Frames

    nonisolated static func key(_ storyId: String, _ frameId: String) -> String { "\(storyId)/\(frameId)" }

    func cachedFrame(_ storyId: String, _ frameId: String, pixels: Int) -> UIImage? {
        guard let kept = images.object(forKey: Self.key(storyId, frameId) as NSString), kept.pixels >= pixels else { return nil }
        return kept.image
    }

    /// A frame's picture, or a recording's first frame.
    func frame(_ storyId: String, _ frame: StoryFrame, pixels: Int) async -> UIImage? {
        let key = Self.key(storyId, frame.id)
        if let cached = cachedFrame(storyId, frame.id, pixels: pixels) { return cached }
        let job = "\(key)@\(pixels)"
        if let task = loading[job] { return await task.value }
        let client = client
        let task: Task<UIImage?, Never>
        if frame.kind == .video {
            let asset = stream(storyId, frame).asset()
            task = Task.detached(priority: .userInitiated) {
                let generator = AVAssetImageGenerator(asset: asset)
                generator.appliesPreferredTrackTransform = true
                generator.maximumSize = CGSize(width: pixels, height: pixels)
                return (try? await generator.image(at: .zero)).map { UIImage(cgImage: $0.image) }
            }
        } else {
            task = Task.detached(priority: .userInitiated) {
                guard let response = try? await client.storyFrame(storyId, frameId: frame.id) else { return nil }
                return StemCellsImages.decode(response.body, maxPixels: pixels)
            }
        }
        loading[job] = task
        let image = await task.value
        loading.removeValue(forKey: job)
        store(image, key: key, pixels: pixels)
        return image
    }

    private func store(_ image: UIImage?, key: String, pixels: Int) {
        guard let image, pixels > images.object(forKey: key as NSString)?.pixels ?? 0 else { return }
        let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
        images.setObject(Decoded(pixels: pixels, image: image), forKey: key as NSString, cost: cost)
    }

    /// A player for a recorded frame, streamed a range at a time.
    func player(_ storyId: String, _ frame: StoryFrame) -> AVPlayer {
        AVPlayer(playerItem: AVPlayerItem(asset: stream(storyId, frame).asset()))
    }

    /// A conversation's picture, before a story holds it.
    func assetImage(_ asset: StoryAsset, pixels: Int) async -> UIImage? {
        let client = client
        return await picture("asset/\(DirectAgentClient.path(asset))", pixels: pixels) { try? await client.asset(asset).body }
    }

    /// A player for a conversation's recording, before a story holds it.
    func player(_ asset: StoryAsset) -> AVPlayer {
        let client = client
        let stream = StoriesByteStream(name: "asset", mimeType: "video/mp4") { range in
            try await client.asset(asset, range: range)
        }
        return AVPlayer(playerItem: AVPlayerItem(asset: stream.asset()))
    }

    private func stream(_ storyId: String, _ frame: StoryFrame) -> StoriesByteStream {
        let key = Self.key(storyId, frame.id)
        if let stream = streams[key] { return stream }
        let client = client
        let stream = StoriesByteStream(name: frame.id, mimeType: "video/mp4") { range in
            try await client.storyFrame(storyId, frameId: frame.id, range: range)
        }
        streams[key] = stream
        return stream
    }

    func placeholder(_ thumbhash: String?) async -> UIImage? {
        guard let thumbhash else { return nil }
        if let kept = placeholders.object(forKey: thumbhash as NSString) { return kept }
        let image = await Task.detached(priority: .userInitiated) { AccountPictureImages.placeholder(thumbhash)?.picture as? UIImage }.value
        if let image { placeholders.setObject(image, forKey: thumbhash as NSString) }
        return image
    }

    /// Any picture under a key of the caller's, from bytes the caller reads.
    func picture(_ key: String, pixels: Int, read: @escaping @Sendable () async -> Data?) async -> UIImage? {
        if let kept = images.object(forKey: key as NSString), kept.pixels >= pixels { return kept.image }
        let job = "\(key)@\(pixels)"
        if let task = loading[job] { return await task.value }
        let task = Task.detached(priority: .userInitiated) { () -> UIImage? in
            guard let data = await read() else { return nil }
            return StemCellsImages.decode(data, maxPixels: pixels)
        }
        loading[job] = task
        let image = await task.value
        loading.removeValue(forKey: job)
        store(image, key: key, pixels: pixels)
        return image
    }

    // MARK: Stickers

    /// A sticker's description, from its pack read once.
    func sticker(_ ref: StickerRef) async -> Sticker? {
        await pack(ref.packId)[ref.stickerId]
    }

    func pack(_ packId: String) async -> [String: Sticker] {
        if let task = packs[packId] { return await task.value }
        let client = client
        let task = Task<[String: Sticker], Never> {
            guard let contents = try? await client.stickerPack(packId) else { return [:] }
            return Dictionary(contents.stickers.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        }
        packs[packId] = task
        let stickers = await task.value
        if stickers.isEmpty { packs.removeValue(forKey: packId) }
        return stickers
    }

    /// Tells the cache what a pack holds, read elsewhere (the picker).
    func remember(_ contents: StickerPackContents) {
        let stickers = Dictionary(contents.stickers.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        packs[contents.pack.id] = Task { stickers }
    }

    /// A sticker's file, as served, or its Lottie JSON for a `tgs` one.
    /// Kept on disk by digest: a sticker's file never changes under it.
    func stickerFile(_ sticker: Sticker) async -> Data? {
        let lottie = sticker.format == .tgs
        let name = sticker.sha256 + (lottie ? ".json" : "")
        if let task = stickerFiles[name] { return await task.value }
        let client = client
        let directory = Self.stickerDirectory
        let task = Task.detached(priority: .userInitiated) { () -> Data? in
            let url = directory?.appendingPathComponent(name)
            if let url, let kept = try? Data(contentsOf: url) { return kept }
            guard let data = try? await client.stickerFile(sticker.ref, lottie: lottie) else { return nil }
            if let url, let directory {
                try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try? data.write(to: url, options: .atomic)
            }
            return data
        }
        stickerFiles[name] = task
        let data = await task.value
        if data == nil { stickerFiles.removeValue(forKey: name) }
        return data
    }

    /// A still sticker's picture (a `webp`), at no more than `pixels`.
    func stickerImage(_ sticker: Sticker, pixels: Int) async -> UIImage? {
        guard sticker.format == .webp else { return nil }
        return await picture("sticker/\(sticker.sha256)", pixels: pixels) { [weak self] in await self?.stickerFile(sticker) }
    }

    nonisolated static var stickerDirectory: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appendingPathComponent("StoriesStickers", isDirectory: true)
    }
}

/// A recording's bytes for AVFoundation, which can't send the computer's
/// token itself: a private URL scheme whose every request is answered with
/// `Range` requests over the paired connection, as Stem Cells streams
/// conversation media.
final class StoriesByteStream: NSObject, AVAssetResourceLoaderDelegate, @unchecked Sendable {
    static let scheme = "happy-story-media"
    static let chunk = 512 * 1024

    typealias Fetch = @Sendable (ClosedRange<Int>?) async throws -> DirectHTTPResponse

    private let name: String
    private let mimeType: String
    private let fetch: Fetch
    private let queue = DispatchQueue(label: "engineering.happy.story-media")
    /// Touched only on `queue`.
    private var serving: [ObjectIdentifier: Task<Void, Never>] = [:]
    private var total: Int?

    init(name: String, mimeType: String, fetch: @escaping Fetch) {
        self.name = name.filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
        self.mimeType = mimeType
        self.fetch = fetch
    }

    nonisolated(unsafe) private static var owner: UInt8 = 0

    /// An asset read through this stream, which it keeps alive: the
    /// resource loader holds its delegate weakly.
    func asset() -> AVURLAsset {
        let asset = AVURLAsset(url: URL(string: "\(Self.scheme)://frame/\(name.isEmpty ? "media" : name).mp4")!)
        asset.resourceLoader.setDelegate(self, queue: queue)
        withUnsafePointer(to: &Self.owner) { objc_setAssociatedObject(asset, $0, self, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
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
        do {
            let (total, type) = try await head()
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
                let response = try await fetch(offset...(min(span.upperBound, offset + Self.chunk) - 1))
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

    private var type: String?
    /// The one probe for the length under way, shared by every request
    /// that arrives meanwhile. Touched only on `queue`.
    private var probing: Task<(Int, String), Error>?

    /// The length, from a first range's `Content-Range`, and the type served.
    private func head() async throws -> (Int, String) {
        let probe = await onQueue { () -> Task<(Int, String), Error> in
            if let total = self.total { return Task { (total, self.type ?? UTType.mpeg4Movie.identifier) } }
            if let probing = self.probing { return probing }
            let probing = Task { try await self.probe() }
            self.probing = probing
            return probing
        }
        do { return try await probe.value } catch {
            await onQueue { self.probing = nil }
            throw error
        }
    }

    private func probe() async throws -> (Int, String) {
        let response = try await fetch(0...1)
        let range = response.headers.first { $0.key.lowercased() == "content-range" }?.value
        guard let size = range.flatMap({ $0.split(separator: "/").last.flatMap { Int($0) } }) ?? (response.status == 200 ? response.body.count : nil) else {
            throw URLError(.cannotParseResponse)
        }
        let served = response.headers.first { $0.key.lowercased() == "content-type" }?.value.split(separator: ";").first.map(String.init) ?? mimeType
        let type = UTType(mimeType: served)?.identifier ?? UTType.mpeg4Movie.identifier
        await onQueue { self.total = size; self.type = type }
        return (size, type)
    }

    private func onQueue<T: Sendable>(_ work: @escaping @Sendable () -> T) async -> T {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: work()) }
        }
    }
}
#endif
