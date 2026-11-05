#if canImport(UIKit)
import AVFoundation
import HappyCore
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// One artifact version's pictures and recordings, by `ChatMedia.key`:
/// its own files read through the file route (`artifactFile`) over the
/// paired computer, a range at a time; an http(s) picture a document
/// links to through the computer's network (`BrowserFetcher`), never the
/// phone's; a `data:` picture from what it says. Decoded off the main
/// thread at no more than they are drawn, and kept while memory allows. A
/// recording streams through `MediaStream`, whose ranges the daemon
/// answers with `206`, so a player seeks without reading the whole file.
@MainActor
final class ArtifactMedia: NSObject, ChatMediaSource, ChatMediaPlaying, ChatMediaSharing {
    enum Item: Equatable {
        case file(AgentWire.ArtifactVersion.File)
        case web(URL)
        case data(URL)
    }

    let artifactId: String
    let version: Int
    private let client: AgentClient
    /// Where the version's files are kept, read once.
    private let library: MediaLibrary?
    private let fetcher: BrowserFetcher
    private var items: [String: Item] = [:]
    private var reading: [String: Task<Data?, Never>] = [:]
    private var streams: [String: MediaStream] = [:]
    private var sizes: [String: CGSize] = [:]
    private var durations: [String: Double] = [:]
    /// Each key's largest decode, so eviction drops the size with the picture.
    private let images = NSCache<NSString, Decoded>()
    private let bytes = NSCache<NSString, NSData>()
    private var shared: URL?

    /// `workspace` names the workspace whose network reaches linked
    /// pictures (the artifact's source's, as the browser picks it).
    init(client: AgentClient, artifactId: String, version: Int, library: MediaLibrary? = nil, workspace: (@Sendable () async throws -> String)? = nil) {
        self.client = client
        self.library = library
        self.artifactId = artifactId
        self.version = version
        fetcher = BrowserFetcher(client: client, workspace: workspace ?? { [client] in try await client.browserWorkspace(artifactID: artifactId) })
        images.totalCostLimit = 64 * 1024 * 1024
        bytes.totalCostLimit = 48 * 1024 * 1024
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(memoryWarning), name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
    }

    deinit {
        let fetcher = fetcher
        Task { await fetcher.stop() }
        if let shared { try? FileManager.default.removeItem(at: shared) }
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

    // MARK: Items

    nonisolated static func key(_ path: String) -> String { "artifact/\(path)" }

    nonisolated static func isVideo(_ file: AgentWire.ArtifactVersion.File) -> Bool { file.mimeType.hasPrefix("video/") }
    nonisolated static func isVisual(_ file: AgentWire.ArtifactVersion.File) -> Bool { file.mimeType.hasPrefix("image/") || isVideo(file) }

    /// The version's file, as the views draw it.
    func media(_ file: AgentWire.ArtifactVersion.File) -> ChatMedia {
        let key = Self.key(file.path)
        items[key] = .file(file)
        let isVideo = Self.isVideo(file)
        return ChatMedia(key: key, isVideo: isVideo, thumbhash: file.thumbhash, label: Strings.media(isVideo: isVideo, name: (file.path as NSString).lastPathComponent))
    }

    /// A picture a document links to by its address.
    func media(web url: URL, label: String) -> ChatMedia {
        let key = "web/\(url.absoluteString)"
        items[key] = .web(url)
        return ChatMedia(key: key, isVideo: false, thumbhash: nil, label: label)
    }

    func media(data url: URL, label: String) -> ChatMedia {
        let key = "data/\(url.absoluteString.hashValue)"
        items[key] = .data(url)
        return ChatMedia(key: key, isVideo: false, thumbhash: nil, label: label)
    }

    func item(_ key: String) -> Item? { items[key] }

    // MARK: Bytes

    /// The item's bytes, read once however many ask; nil when they can't be had.
    func data(_ key: String) async -> Data? {
        if let kept = bytes.object(forKey: key as NSString) { return kept as Data }
        if let task = reading[key] { return await task.value }
        guard let item = items[key] else { return nil }
        let client = client
        let fetcher = fetcher
        let (artifactId, version) = (artifactId, version)
        if case .file(let file) = item, let library {
            let (id, source) = (resourceID(file), source(file))
            let task = Task { try? await library.downloads.data(id, source: source, priority: .user) }
            reading[key] = task
            let data = await task.value
            reading[key] = nil
            if let data { bytes.setObject(data as NSData, forKey: key as NSString, cost: data.count) }
            return data
        }
        let task = Task.detached(priority: .userInitiated) { () -> Data? in
            switch item {
            case .file(let file):
                var data = Data()
                do {
                    try await AgentClient.read({ range in
                        try await client.artifactFile(artifactId, version: version, path: file.path, range: range.map { "bytes=\($0.lowerBound)-\($0.upperBound)" })
                    }, each: { piece, _, _ in data.append(piece) })
                } catch { return nil }
                return data
            case .web(let url):
                return try? await fetcher.data(url)
            case .data(let url):
                let string = url.absoluteString
                guard let comma = string.firstIndex(of: ","), string[..<comma].hasSuffix(";base64") else { return nil }
                return Data(base64Encoded: String(string[string.index(after: comma)...]), options: .ignoreUnknownCharacters)
            }
        }
        reading[key] = task
        let data = await task.value
        reading[key] = nil
        if let data { bytes.setObject(data as NSData, forKey: key as NSString, cost: data.count) }
        return data
    }

    /// The item's upright size in pixels, which a document and the grid lay
    /// it out by: a picture's from its header, a recording's from its track.
    func pixelSize(_ key: String) async -> CGSize? {
        if let size = sizes[key] { return size }
        let size: CGSize?
        if case .file(let file) = items[key], Self.isVideo(file) {
            size = await videoInfo(key).size
        } else if let data = await data(key) {
            size = await Task.detached(priority: .userInitiated) { Self.pictureSize(data) }.value
        } else {
            size = nil
        }
        if let size { sizes[key] = size }
        return size
    }

    func knownSize(_ key: String) -> CGSize? { sizes[key] }

    func cachedDuration(_ key: String) -> Double? { durations[key] }

    /// A recording's length in seconds.
    func duration(_ key: String) async -> Double? {
        if let duration = durations[key] { return duration }
        return await videoInfo(key).duration
    }

    private func videoInfo(_ key: String) async -> (size: CGSize?, duration: Double?) {
        guard let asset = stream(key)?.asset() else { return (nil, nil) }
        var size: CGSize?
        if let track = try? await asset.loadTracks(withMediaType: .video).first,
           let (natural, transform) = try? await track.load(.naturalSize, .preferredTransform) {
            let turned = natural.applying(transform)
            size = CGSize(width: abs(turned.width), height: abs(turned.height))
        }
        let duration = (try? await asset.load(.duration)).map(CMTimeGetSeconds).flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        if let size { sizes[key] = size }
        if let duration { durations[key] = duration }
        return (size, duration)
    }

    nonisolated static func pictureSize(_ data: Data) -> CGSize? {
        let image = ChatPlanner.pictureSize(data)
        guard let width = image.width, let height = image.height, width > 0, height > 0 else { return nil }
        return CGSize(width: width, height: height)
    }

    // MARK: ChatMediaSource

    func cachedImage(_ key: String, pixels: Int) -> UIImage? {
        guard let kept = images.object(forKey: key as NSString), kept.pixels >= pixels else { return nil }
        return kept.image
    }

    func image(_ key: String, pixels: Int) async -> UIImage? {
        if let cached = cachedImage(key, pixels: pixels) { return cached }
        let image: UIImage?
        if case .file(let file) = items[key], Self.isVideo(file) {
            if let still = await preview(file, pixels: pixels) { image = still } else { image = await poster(key, pixels: pixels) }
        } else if let data = await data(key) {
            image = await Task.detached(priority: .userInitiated) { Images.decode(data, maxPixels: pixels) }.value
        } else {
            image = nil
        }
        if let image, pixels > images.object(forKey: key as NSString)?.pixels ?? 0 {
            let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
            images.setObject(Decoded(pixels: pixels, image: image), forKey: key as NSString, cost: cost)
        }
        return image
    }

    /// The poster the daemon made of a recording (its `preview`), so the
    /// viewer shows it before playback reads a byte of the recording.
    private func preview(_ file: AgentWire.ArtifactVersion.File, pixels: Int) async -> UIImage? {
        guard file.preview != nil else { return nil }
        let path = ArtifactSummary.served(id: artifactId, version: version, route: "previews", file: file.path)
        guard let data = try? await client.image(path) else { return nil }
        return await Task.detached(priority: .userInitiated) { Images.decode(data, maxPixels: pixels) }.value
    }

    /// A recording's first frame, read through its stream.
    private func poster(_ key: String, pixels: Int) async -> UIImage? {
        guard let asset = stream(key)?.asset() else { return nil }
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: pixels, height: pixels)
        guard let frame = try? await generator.image(at: .zero) else { return nil }
        return UIImage(cgImage: frame.image)
    }

    // MARK: Playback

    func player(_ key: String) -> AVPlayer? {
        guard let stream = stream(key) else { return nil }
        return AVPlayer(playerItem: AVPlayerItem(asset: stream.asset()))
    }

    /// The recording's stream, made once.
    func stream(_ key: String) -> MediaStream? {
        if let stream = streams[key] { return stream }
        guard case .file(let file) = items[key], Self.isVideo(file) else { return nil }
        let downloads = (library ?? Self.scratch).downloads
        let stream = MediaStream(downloads: downloads, id: resourceID(file), source: source(file), name: file.path, mimeType: file.mimeType)
        streams[key] = stream
        return stream
    }

    // MARK: Kept files

    /// Where a version's file is kept: a numbered version never changes.
    func resourceID(_ file: AgentWire.ArtifactVersion.File) -> String { "artifact/\(artifactId)/\(version)/\(file.path)" }

    /// Its bytes from the file route, a range at a time.
    func source(_ file: AgentWire.ArtifactVersion.File) -> MediaSource {
        let client = client
        let (artifactId, version, path) = (artifactId, version, file.path)
        return MediaSource(length: Int(file.size)) { range in
            do {
                let response = try await client.artifactFile(artifactId, version: version, path: path, range: MediaPiece.header(range))
                return try MediaPiece.http(status: response.status, headers: response.headers, body: response.body)
            } catch AgentClientError.status(let status, _, _) where (400..<500).contains(status) && status != 408 && status != 429 {
                throw MediaError.status(status)
            }
        }
    }

    /// Where a stream reads when the computer has no folder of its own:
    /// a temporary one, for the app's run.
    private static let scratch = MediaLibrary(namespace: "scratch", directory: FileManager.default.temporaryDirectory.appendingPathComponent("happy-media", isDirectory: true))

    func download(_ key: String) -> ChatDownload? {
        guard let library, case .file(let file) = items[key] else { return nil }
        return ChatDownload(boardKey: library.key(resourceID(file)), duration: durations[key])
    }

    func publishDownload(_ key: String) {
        guard let library, case .file(let file) = items[key] else { return }
        let (id, source) = (resourceID(file), source(file))
        Task { await library.downloads.phase(id, source: source) }
    }

    /// A tap on a file's ring: pause what is going, else read it.
    func toggleDownload(_ key: String) {
        guard let library, case .file(let file) = items[key] else { return }
        let (id, source) = (resourceID(file), source(file))
        Task { await library.downloads.toggle(id, source: source) }
    }

    // MARK: Sharing

    /// The item as a file named as the artifact names it, for the share
    /// sheet (which offers Save Image and Save Video): written off the main
    /// thread a range at a time, in a folder of this screen's own that goes
    /// with it.
    func shareable(_ key: String) async -> URL? {
        guard let item = items[key] else { return nil }
        let folder = shared ?? FileManager.default.temporaryDirectory.appendingPathComponent("ArtifactShare/\(UUID().uuidString)", isDirectory: true)
        shared = folder
        let name: String
        switch item {
        case .file(let file): name = (file.path as NSString).lastPathComponent
        case .web(let url): name = url.lastPathComponent.isEmpty ? "picture" : url.lastPathComponent
        case .data(let url):
            let type = url.absoluteString.dropFirst(5).prefix { $0 != ";" && $0 != "," }
            name = "picture." + (UTType(mimeType: String(type))?.preferredFilenameExtension ?? "png")
        }
        let target = folder.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: target.path) { return target }
        if case .file(let file) = item, Self.isVideo(file), let library {
            let (id, source) = (resourceID(file), source(file))
            guard (try? await library.downloads.complete(id, source: source, priority: .user)) != nil else { return nil }
            let complete = library.store.completeURL(id)
            let linked = await Task.detached(priority: .userInitiated) { () -> Bool in
                let manager = FileManager.default
                try? manager.createDirectory(at: folder, withIntermediateDirectories: true)
                if (try? manager.linkItem(at: complete, to: target)) != nil { return true }
                return (try? manager.copyItem(at: complete, to: target)) != nil
            }.value
            return linked ? target : nil
        }
        if case .file(let file) = item, Self.isVideo(file) {
            let client = client
            let (artifactId, version) = (artifactId, version)
            let written = await Task.detached(priority: .userInitiated) { () -> Bool in
                let manager = FileManager.default
                do {
                    try manager.createDirectory(at: folder, withIntermediateDirectories: true)
                    guard manager.createFile(atPath: target.path, contents: nil) else { return false }
                    let handle = try FileHandle(forWritingTo: target)
                    defer { try? handle.close() }
                    try await AgentClient.read({ range in
                        try await client.artifactFile(artifactId, version: version, path: file.path, range: range.map { "bytes=\($0.lowerBound)-\($0.upperBound)" })
                    }, each: { piece, _, _ in try handle.write(contentsOf: piece) })
                    return true
                } catch {
                    try? manager.removeItem(at: target)
                    return false
                }
            }.value
            return written ? target : nil
        }
        guard let data = await data(key) else { return nil }
        let written = await Task.detached(priority: .userInitiated) { () -> Bool in
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                try data.write(to: target, options: .atomic)
                return true
            } catch { return false }
        }.value
        return written ? target : nil
    }
}
#endif
