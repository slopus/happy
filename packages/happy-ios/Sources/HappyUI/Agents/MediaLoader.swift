#if canImport(UIKit)
import AVFoundation
import HappyCore
import os
import UIKit
import UniformTypeIdentifiers

/// One conversation's pictures and recordings over the paired computer: a
/// tool call's from `GET /v0/agents/:id/tool-calls/:tcid/media/:index`, a
/// photo the person sent from the bytes they sent. A tool's file is read
/// into the computer's `MediaLibrary` once and kept there for good; a
/// photo or small file reads itself as it shows up in the conversation
/// (`MediaAutoDownload`), anything else waits for a tap on its ring.
/// Decoded off the main thread at no more than they are drawn, and kept
/// while memory allows. A recording streams through `MediaStream`, from
/// what is here and a range at a time from the computer.
@MainActor
final class MediaLoader: NSObject, ChatMediaSource {
    private let client: AgentClient
    /// New work's is the daemon's ID once it has made it.
    var agentId: String
    /// Where its files are kept; nil only where the system gives no folder.
    let library: MediaLibrary?
    private var tools: [String: Media] = [:]
    private var sent: [String: Data] = [:]
    /// Files still on their way, read from their copy on this phone.
    private var local: [String: ChatItem.SentFile] = [:]
    private var streams: [String: MediaStream] = [:]
    private var durations: [String: Double] = [:]
    /// Files a person asked for, read whatever the automatic rules say.
    private var requested: Set<String> = []
    /// Files already handed to automatic download.
    private var automatic: Set<String> = []
    private var rules = MediaAutoDownload.load()
    /// Each key's largest decode, so eviction drops the size with the picture.
    private let images = NSCache<NSString, Decoded>()
    #if DEBUG
    /// UI tests: every picture fails until the first retry, as a dropped
    /// connection would make it (`V2_MEDIA_FAIL_UNTIL_RETRY`).
    private var failsUntilRetry = ProcessInfo.processInfo.environment["HAPPY_MEDIA_FAIL_UNTIL_RETRY"] == "1"
    #endif

    init(client: AgentClient, agentId: String, library: MediaLibrary?) {
        self.client = client
        self.agentId = agentId
        self.library = library
        images.totalCostLimit = 48 * 1024 * 1024
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(memoryWarning), name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(rulesChanged), name: MediaAutoDownload.didChange, object: nil)
    }

    @objc private func memoryWarning() {
        images.removeAllObjects()
    }

    @objc private func rulesChanged() {
        rules = MediaAutoDownload.load()
        automatic = []
        startAutomatic()
    }

    private final class Decoded {
        let pixels: Int
        let image: UIImage
        init(pixels: Int, image: UIImage) {
            self.pixels = pixels
            self.image = image
        }
    }

    /// Each row's making already registered (`ChatItem.revision`).
    private var registered: [String: UInt64] = [:]

    /// What the conversation shows now, by the keys its plans draw: each
    /// row once per making of it.
    func register(_ items: [ChatItem]) {
        for item in items {
            if item.revision != 0, registered[item.id] == item.revision { continue }
            registered[item.id] = item.revision
            for piece in item.pieces {
                switch piece {
                case .picture(let id, _, let data): sent[Self.sentKey(id)] = data
                case .sentFile(let file): local[Self.sentKey(file.id)] = file
                case .gallery(let media, _), .tree(let media, _): for one in media { tools[one.key] = one }
                case .file(let one): tools[one.key] = one
                case .text, .artifact, .sidebarProposal, .ui: break
                }
            }
        }
        startAutomatic()
    }

    nonisolated static func sentKey(_ id: String) -> String { "sent/\(id)" }

    func media(_ key: String) -> Media? { tools[key] }

    // MARK: Kept files

    /// The file's ID in the library: a tool call's media is never another's.
    func resourceID(_ media: Media) -> String { "tool/\(agentId)/\(media.toolCallId)/\(media.index)" }

    /// Where its bytes come from: the computer's media route, a range at a time.
    func source(_ media: Media) -> MediaSource {
        let client = client
        let agentId = agentId
        let (toolCallId, index) = (media.toolCallId, media.index)
        return MediaSource(length: media.item.size.map { Int($0) }) { range in
            do {
                let response = try await client.media(agentId, toolCallId: toolCallId, index: index, range: range.lowerBound...(range.upperBound - 1))
                return try MediaPiece.http(status: response.status, headers: response.headers, body: response.body)
            } catch AgentClientError.status(let status, _, _) where (400..<500).contains(status) && status != 408 && status != 429 {
                throw MediaError.status(status)
            }
        }
    }

    private nonisolated static func kind(_ media: Media) -> MediaAutoDownload.Kind {
        media.isVideo ? .videos : media.isVisual ? .photos : .files
    }

    /// What reads itself as it shows up, at low priority, a few at a time.
    private func startAutomatic() {
        guard let library else { return }
        for media in tools.values where !automatic.contains(media.key) {
            automatic.insert(media.key)
            guard rules.allows(Self.kind(media), size: media.item.size.map { Int($0) }) else { continue }
            let (id, source) = (resourceID(media), source(media))
            Task { await library.downloads.download(id, source: source, priority: .background) }
        }
    }

    func download(_ key: String) -> ChatDownload? {
        guard let library, let media = tools[key] else { return nil }
        return ChatDownload(boardKey: library.key(resourceID(media)), duration: durations[key])
    }

    func publishDownload(_ key: String) {
        guard let library, let media = tools[key] else { return }
        let (id, source) = (resourceID(media), source(media))
        Task { await library.downloads.phase(id, source: source) }
    }

    /// A tap on a file's ring: pause what is going, else read it.
    func toggleDownload(_ key: String) {
        guard let library, let media = tools[key] else { return }
        requested.insert(key)
        let (id, source) = (resourceID(media), source(media))
        Task { await library.downloads.toggle(id, source: source) }
    }

    /// Whether the whole file is here, from the board's last word.
    func isDownloaded(_ key: String) -> Bool {
        guard let found = download(key) else { return true }
        return DownloadRings.shared.phase(found.boardKey)?.isComplete == true
    }

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
        } else if let file = local[key] {
            image = await Self.picture(file, pixels: pixels)
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

    /// A tool's picture from the library: read first where the rules or a
    /// tap allow; nil, with its ring showing the arrow, where neither does.
    private func picture(_ media: Media, pixels: Int) async -> UIImage? {
        #if DEBUG
        if failsUntilRetry { return nil }
        #endif
        let id = resourceID(media)
        let source = source(media)
        guard let library else {
            guard let response = try? await client.media(agentId, toolCallId: media.toolCallId, index: media.index) else { return nil }
            return await Task.detached(priority: .userInitiated) { Images.decode(response.body, maxPixels: pixels) }.value
        }
        let allowed = requested.contains(media.key) || rules.allows(.photos, size: media.item.size.map { Int($0) })
        if !allowed {
            guard await library.downloads.phase(id, source: source).isComplete else { return nil }
        }
        guard let data = try? await library.downloads.data(id, source: source, priority: .user) else { return nil }
        return await Task.detached(priority: .userInitiated) { Images.decode(data, maxPixels: pixels) }.value
    }

    /// A file on its way: a picture decoded, a video's first frame, off
    /// the main thread.
    private nonisolated static func picture(_ file: ChatItem.SentFile, pixels: Int) async -> UIImage? {
        if file.isVideo {
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: file.file))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: pixels, height: pixels)
            guard let frame = try? await generator.image(at: .zero) else { return nil }
            return UIImage(cgImage: frame.image)
        }
        return await Task.detached(priority: .userInitiated) {
            (try? Data(contentsOf: file.file, options: .mappedIfSafe)).flatMap { Images.decode($0, maxPixels: pixels) }
        }.value
    }

    /// A recording's first frame and length, read through its stream: the
    /// few ranges they take, kept for when it plays.
    private func poster(_ media: Media, pixels: Int) async -> UIImage? {
        guard let library else { return nil }
        let asset = stream(media, library: library).asset()
        await library.downloads.phase(resourceID(media), source: source(media))
        if durations[media.key] == nil,
           let duration = (try? await asset.load(.duration)).map(CMTimeGetSeconds), duration.isFinite, duration > 0 {
            durations[media.key] = duration
        }
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: pixels, height: pixels)
        guard let frame = try? await generator.image(at: .zero) else { return nil }
        return UIImage(cgImage: frame.image)
    }

    /// Asks every picture that failed to load to try again, as when the
    /// computer is reachable again, and starts again the automatic
    /// downloads that gave up while it was away.
    func retryFailed() {
        #if DEBUG
        failsUntilRetry = false
        #endif
        automatic = []
        startAutomatic()
        NotificationCenter.default.post(name: Self.retry, object: self)
    }

    nonisolated static let retry = Notification.Name("V2MediaLoader.retry")

    /// A document's or file's bytes, as presented, at `url`: read into the
    /// library first where they aren't there yet (its card's ring shows
    /// how far), then linked to `url`. False when they could not be read.
    func download(_ media: Media, to url: URL) async -> Bool {
        requested.insert(media.key)
        let id = resourceID(media)
        let source = source(media)
        guard let library else { return false }
        do {
            try await library.downloads.complete(id, source: source, priority: .user)
        } catch {
            return false
        }
        let complete = library.store.completeURL(id)
        return await Task.detached(priority: .userInitiated) { () -> Bool in
            let manager = FileManager.default
            do {
                try manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? manager.removeItem(at: url)
                do { try manager.linkItem(at: complete, to: url) } catch { try manager.copyItem(at: complete, to: url) }
                return true
            } catch {
                return false
            }
        }.value
    }

    // MARK: Playback

    /// A player for a recording, streaming from what is here and from the
    /// computer as it plays; the rest of the file reads on behind it, so
    /// it is kept once played.
    func player(_ key: String) -> AVPlayer? {
        if let file = local[key], file.isVideo { return AVPlayer(url: file.file) }
        guard let media = tools[key], media.isVideo, let library else { return nil }
        requested.insert(key)
        let (id, source) = (resourceID(media), source(media))
        Task { await library.downloads.download(id, source: source, priority: .user) }
        return AVPlayer(playerItem: AVPlayerItem(asset: stream(media, library: library).asset()))
    }

    private func stream(_ media: Media, library: MediaLibrary) -> MediaStream {
        if let stream = streams[media.key] { return stream }
        let stream = MediaStream(downloads: library.downloads, id: resourceID(media), source: source(media), name: media.item.name, mimeType: media.item.mimeType)
        streams[media.key] = stream
        return stream
    }
}

/// A recording's bytes for AVFoundation, which can't send the computer's
/// token or read a file still arriving itself: a private URL scheme whose
/// every request is answered here from `MediaDownloads`, which serves what
/// is on this phone at once and fetches the rest a range at a time, the
/// range a player asks for first. So a recording plays from what is here
/// while the rest arrives, and a seek waits only for its own range. A
/// legacy file is decrypted on the way (`MediaSeal`).
final class MediaStream: NSObject, AVAssetResourceLoaderDelegate, @unchecked Sendable {
    static let scheme = "happy-media"
    /// Answered at a time while the bytes are here; a player asks for more as it plays.
    static let piece = 512 * 1024
    #if DEBUG
    /// Each range read, for checking that a recording streams.
    private static let log = Logger(subsystem: "engineering.happy", category: "media")
    #endif

    private let downloads: MediaDownloads
    private let id: String
    /// Where its bytes come from, found once (a legacy file's needs the
    /// session's key, read off the main thread).
    private let resolve: @Sendable () async throws -> MediaSource
    private let name: String
    private let mimeType: String
    private let queue = DispatchQueue(label: "engineering.happy.media-stream")
    /// Touched only on `queue`.
    private var serving: [ObjectIdentifier: Task<Void, Never>] = [:]
    /// Every range answered, for tests (on `queue`).
    private(set) var ranges: [Range<Int>] = []

    /// `name` is the file's, for its extension.
    init(downloads: MediaDownloads, id: String, source: MediaSource, name: String, mimeType: String) {
        self.downloads = downloads
        self.id = id
        resolve = { source }
        self.name = name
        self.mimeType = mimeType
    }

    /// A stream whose source is found when it is first read.
    init(downloads: MediaDownloads, id: String, name: String, mimeType: String, source: @escaping @Sendable () async throws -> MediaSource) {
        self.downloads = downloads
        self.id = id
        resolve = source
        self.name = name
        self.mimeType = mimeType
    }

    /// The ranges answered so far.
    func answered() async -> [Range<Int>] { await onQueue { self.ranges } }

    func asset() -> AVURLAsset {
        // Letters and digits only, so the URL always parses.
        let name = (name as NSString).pathExtension.filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
        let url = URL(string: "\(Self.scheme)://media/stream\(name.isEmpty ? "" : "." + name)")!
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

    /// Reads off `queue`; touches the request only on it, where
    /// AVFoundation cancels it.
    private func serve(_ box: Request) async {
        do {
            let source = try await resolve()
            let total = try await downloads.length(id, source: source)
            let type = (UTType(mimeType: mimeType) ?? UTType(filenameExtension: (name as NSString).pathExtension))?.identifier ?? UTType.mpeg4Movie.identifier
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
                return min(start, total)..<max(min(start, total), end)
            }
            guard let span else { return }
            var offset = span.lowerBound
            while offset < span.upperBound {
                try Task.checkCancellation()
                // What is here goes at once, in big pieces; what isn't, a
                // range at a time as it comes.
                let here = await downloads.available(id, source: source, from: offset, limit: min(Self.piece, span.upperBound - offset))
                let length = here > 0 ? here : min(MediaDownloads.streamChunk, span.upperBound - offset)
                let range = offset..<(offset + length)
                let piece = try await downloads.read(id, source: source, range: range)
                await onQueue { self.ranges.append(range) }
                #if DEBUG
                Self.log.notice("range \(range.lowerBound)-\(range.upperBound) of \(total), \(here > 0 ? "kept" : "fetched")")
                #endif
                guard !piece.isEmpty else { throw URLError(.networkConnectionLost) }
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

    private func onQueue<T: Sendable>(_ work: @escaping @Sendable () -> T) async -> T {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: work()) }
        }
    }
}
#endif
