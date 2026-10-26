#if canImport(UIKit)
import AVFoundation
import HappyCore
import HappyLayout
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// A story's frames from the photo library (happy-agent `API.md` "Making a
/// story by hand"), through the shared library sheet: photos and videos
/// only, picked in order. Each is readied for its upload here: a HEIC photo
/// becomes a JPEG, and each is measured and given a background from its
/// edges.
@MainActor
enum StoriesMediaChooser {
    struct Picked {
        var frame: StoryDraft.Frame
        var local: StoryLocalMedia?
    }

    /// Opens the library over `host`; `done` gets what was picked, readied,
    /// and isn't called when nothing was.
    static func choose(from host: UIViewController, limit: Int, done: @escaping ([Picked]) -> Void) {
        guard limit > 0 else { return }
        // Dark over the dark editor, as Telegram's story gallery is.
        let picker = LibraryPicker.present(from: host, options: .init(limit: limit, videos: true, action: Strings.Stories.add)) { [weak host] picks in
            Task { @MainActor in
                var picked: [Picked] = []
                for pick in picks {
                    if let one = await ready(pick) { picked.append(one) }
                }
                guard !picked.isEmpty else {
                    if let host { refuse(on: host) }
                    return
                }
                done(picked)
            }
        }
        picker.overrideUserInterfaceStyle = .dark
    }

    /// One library pick as a frame: its bytes kept or drawn into a JPEG, a
    /// video as it is.
    static func ready(_ pick: LibraryPick) async -> Picked? {
        switch pick.media {
        case .image(let data, let type): await image(data, type: type)
        case .video(let file): await video(file)
        // A story is pictures and recordings; nothing else is offered it.
        case .file: nil
        }
    }

    private static func refuse(on host: UIViewController) {
        let alert = UIAlertController(title: Strings.Stories.couldntOpen, message: nil, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Stories.done, style: .default))
        host.present(alert, animated: true)
    }

    nonisolated static var uploads: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("StoriesUploads", isDirectory: true)
    }

    /// A photo readied for its upload: kept as it is when the daemon reads
    /// it, otherwise (HEIC, or anything else) drawn upright into a JPEG.
    static func image(_ data: Data, type: UTType?) async -> Picked? {
        let ready = await Task.detached(priority: .userInitiated) { () -> (URL, String, CGSize, UIImage, [String])? in
            guard let image = UIImage(data: data) else { return nil }
            let kept: [UTType] = [.png, .jpeg, .gif, .webP]
            // A picture over the daemon's 32 MiB is drawn smaller instead.
            let keeps = (type.map { type in kept.contains { type.conforms(to: $0) } } ?? false) && data.count <= Self.maxImageBytes
            let size = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
            var bytes = data
            var ext = type?.preferredFilenameExtension ?? "jpg"
            var pixels = size
            if !keeps {
                let longest = max(size.width, size.height)
                let fit = min(1, 4096 / max(1, longest))
                pixels = CGSize(width: (size.width * fit).rounded(), height: (size.height * fit).rounded())
                let format = UIGraphicsImageRendererFormat()
                format.scale = 1
                let upright = UIGraphicsImageRenderer(size: pixels, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: pixels)) }
                guard let jpeg = upright.jpegData(compressionQuality: 0.9), jpeg.count <= Self.maxImageBytes else { return nil }
                bytes = jpeg
                ext = "jpg"
            }
            let preview = StemCellsImages.decode(bytes, maxPixels: 2048) ?? image
            let id = ClientID.make()
            try? FileManager.default.createDirectory(at: uploads, withIntermediateDirectories: true)
            let file = uploads.appendingPathComponent(id).appendingPathExtension(ext)
            guard (try? bytes.write(to: file)) != nil else { return nil }
            return (file, "\(id).\(ext)", pixels, preview, edges(preview))
        }.value
        guard let (file, name, pixels, preview, background) = ready else { return nil }
        let frame = StoryDraft.Frame(kind: .image, width: Int(pixels.width), height: Int(pixels.height), media: .local(file: file, name: name), background: background)
        return Picked(frame: frame, local: .image(preview))
    }

    nonisolated static let maxImageBytes = 32 * 1024 * 1024
    nonisolated static let maxVideoBytes = 256 * 1024 * 1024

    /// A recording as it is, measured, with its first frame to show. The
    /// file is the editor's from here, or removed when it can't be used.
    static func video(_ file: URL) async -> Picked? {
        let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) ?? 0
        let asset = AVURLAsset(url: file)
        guard size > 0, size <= maxVideoBytes, let track = try? await asset.loadTracks(withMediaType: .video).first,
              let (natural, transform) = try? await track.load(.naturalSize, .preferredTransform) else {
            try? FileManager.default.removeItem(at: file)
            return nil
        }
        let turned = natural.applying(transform)
        let duration = (try? await asset.load(.duration)).map { Int($0.seconds * 1000) }
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 1280, height: 1280)
        let poster = (try? await generator.image(at: .zero)).map { UIImage(cgImage: $0.image) }
        let name = "\(ClientID.make()).\(file.pathExtension.isEmpty ? "mov" : file.pathExtension)"
        let frame = StoryDraft.Frame(kind: .video, width: Int(abs(turned.width)), height: Int(abs(turned.height)), durationMs: duration, media: .local(file: file, name: name), background: ["#000000", "#000000"])
        return Picked(frame: frame, local: .video(file, poster: poster))
    }

    /// Two colours from the picture's top and bottom edges, as the daemon
    /// picks them when a client leaves the background out.
    nonisolated static func edges(_ image: UIImage) -> [String] {
        guard let cgImage = image.cgImage else { return ["#000000", "#000000"] }
        var pixels = [UInt8](repeating: 0, count: 4 * 16)
        guard let context = CGContext(data: &pixels, width: 1, height: 16, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return ["#000000", "#000000"] }
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: 1, height: 16))
        // The first row in memory is the picture's top. Scaling down blends
        // the edge rows with the clear outside, so they're un-premultiplied.
        func hex(_ row: Int) -> String {
            let alpha = max(1, Int(pixels[row * 4 + 3]))
            func channel(_ index: Int) -> Int { min(255, Int(pixels[row * 4 + index]) * 255 / alpha) }
            return String(format: "#%02X%02X%02X", channel(0), channel(1), channel(2))
        }
        return [hex(0), hex(15)]
    }
}
#endif
