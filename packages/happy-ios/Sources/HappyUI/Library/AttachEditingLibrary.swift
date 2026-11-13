#if canImport(UIKit)
import HappyLayout
import UIKit
import ImageIO
import UniformTypeIdentifiers

/// The "+" menu's library as the menu shows it: the photo library, with
/// the shots the menu's camera took this time first (Telegram puts them at
/// the grid's start, picked), and each picture as the editor left it. The
/// grid, the preview and the composer all read through it, so an edited
/// picture is the same everywhere: its thumbnail, what is sent.
@MainActor
final class AttachEditingLibrary: AttachLibrary {
    let base: AttachLibrary
    /// A picture's edit, by id; none for one as it was.
    private(set) var edits: [String: PhotoEdit] = [:]
    /// An edit came or went: the picture shows anew.
    var onEdited: ((String) -> Void)?
    var onChange: (@MainActor () -> Void)?

    /// One taken with the menu's camera: newest first.
    private struct Shot {
        let id: String
        let image: UIImage
        let data: Data
    }
    private var shots: [Shot] = []
    /// Shots in what the grid last committed.
    private var committedShots = 0

    init(_ base: AttachLibrary) {
        self.base = base
        base.onChange = { [weak self] in self?.onChange?() }
    }

    // MARK: Edits

    func edit(_ id: String) -> PhotoEdit? { edits[id] }

    func setEdit(_ id: String, _ edit: PhotoEdit?) {
        let kept = edit.flatMap { $0.isEmpty ? nil : $0 }
        guard edits[id] != kept else { return }
        edits[id] = kept
        onEdited?(id)
    }

    // MARK: Shots

    /// A shot from the menu's camera, at the grid's start, as it shows
    /// (upright, cut to the camera's shape): its id once it is in.
    func add(shot photo: CameraPhoto, _ done: @escaping @MainActor (String?) -> Void) {
        Task { [weak self] in
            let prepared = await Task.detached(priority: .userInitiated) { Self.prepare(photo) }.value
            guard let self, let prepared else { return done(nil) }
            let id = "shot:\(UUID().uuidString)"
            shots.insert(Shot(id: id, image: prepared.image, data: prepared.data), at: 0)
            onChange?()
            done(id)
        }
    }

    /// The shot upright and cut to its shape, as JPEG, and its picture
    /// for the screen (2048 at most).
    nonisolated private static func prepare(_ photo: CameraPhoto) -> (data: Data, image: UIImage)? {
        guard let source = CGImageSourceCreateWithData(photo.data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else { return nil }
        let width = properties[kCGImagePropertyPixelWidth] as? Int ?? 0, height = properties[kCGImagePropertyPixelHeight] as? Int ?? 0
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(width, height, 1),
        ]
        guard let whole = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let cut = whole.cropping(to: CameraCrop.rect(pixels: CGSize(width: whole.width, height: whole.height), ratio: CGFloat(photo.ratio))) ?? whole
        let full = UIImage(cgImage: cut)
        guard let data = full.jpegData(compressionQuality: 0.92) else { return nil }
        let fit = min(1, 2048 / CGFloat(max(cut.width, cut.height, 1)))
        let size = CGSize(width: (CGFloat(cut.width) * fit).rounded(), height: (CGFloat(cut.height) * fit).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in full.draw(in: CGRect(origin: .zero, size: size)) }
        return (data, image)
    }

    var shotIDs: [String] { shots.map(\.id) }

    private func shot(_ id: String) -> Shot? { shots.first { $0.id == id } }

    /// The camera's shots oldest first, as its strip and its preview have them.
    var shotsTaken: [String] { shots.reversed().map(\.id) }

    /// A shot's picture as edited, for the camera's strip and preview.
    func shotPicture(_ id: String) -> UIImage? { shot(id).map { edited($0.image, id) } }

    /// The picture with no edit, for the editor: a shot's own, else the
    /// library's at `index` (in this library's order) filling `pixels`.
    func original(_ id: String, index: Int?, pixels: CGSize, _ deliver: @escaping @MainActor (UIImage) -> Void) -> Int? {
        if let shot = shot(id) {
            deliver(shot.image)
            return nil
        }
        guard let index, index >= committedShots else { return nil }
        return base.thumbnail(at: index - committedShots, pixels: pixels, deliver)
    }

    // MARK: AttachLibrary

    var access: AttachLibraryAccess { base.access }
    func requestAccess(_ answer: @escaping @MainActor (AttachLibraryAccess) -> Void) { base.requestAccess(answer) }
    func load(_ done: @escaping @MainActor () -> Void) { base.load(done) }
    func manageLimited(from host: UIViewController) { base.manageLimited(from: host) }

    func commit() -> AttachLibraryChange {
        let before = committedShots + baseCountBefore
        let change = base.commit()
        let added = shots.count - committedShots
        defer {
            committedShots = shots.count
            baseCountBefore = base.count
        }
        if added == 0 { return Self.offset(change, by: committedShots) }
        if change == .none { return .update(removed: [], inserted: Array(0..<added), changed: [], moves: []) }
        return .reload(from: before, to: shots.count + base.count)
    }
    private var baseCountBefore = 0

    private static func offset(_ change: AttachLibraryChange, by shift: Int) -> AttachLibraryChange {
        guard shift > 0 else { return change }
        switch change {
        case .none: return .none
        case let .reload(from, to): return .reload(from: from + shift, to: to + shift)
        case let .update(removed, inserted, changed, moves):
            return .update(removed: removed.map { $0 + shift }, inserted: inserted.map { $0 + shift }, changed: changed.map { $0 + shift },
                           moves: moves.map { .init(from: $0.from + shift, to: $0.to + shift) })
        }
    }

    var count: Int { committedShots + base.count }

    func item(at index: Int) -> AttachLibraryItem? {
        if index < committedShots {
            return index >= 0 ? AttachLibraryItem(id: shots[shots.count - committedShots + index].id, duration: nil) : nil
        }
        return base.item(at: index - committedShots)
    }

    func contains(_ id: String) -> Bool { shot(id) != nil || base.contains(id) }

    func thumbnail(at index: Int, pixels size: CGSize, _ deliver: @escaping @MainActor (UIImage) -> Void) -> Int? {
        guard let id = item(at: index)?.id else { return nil }
        let show: @MainActor (UIImage) -> Void = { [weak self] image in deliver(self?.edited(image, id) ?? image) }
        if let shot = shot(id) {
            show(shot.image)
            return nil
        }
        return base.thumbnail(at: index - committedShots, pixels: size, show)
    }

    func cancelThumbnail(_ token: Int) { base.cancelThumbnail(token) }

    func prepare(_ range: Range<Int>, pixels size: CGSize) {
        let shifted = max(0, range.lowerBound - committedShots)..<max(0, range.upperBound - committedShots)
        base.prepare(shifted, pixels: size)
    }

    func preview(_ id: String) async -> (image: UIImage, pixels: CGSize)? {
        if let shot = shot(id) {
            let image = edited(shot.image, id)
            return (image, CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale))
        }
        guard let shown = await base.preview(id) else { return nil }
        guard let edit = edits[id] else { return shown }
        let image = PhotoEditRenderer.render(shown.image, edit, maxPixels: 512)
        let scale = shown.pixels.width / max(edit.canvas.width, 1)
        return (image, CGSize(width: edit.crop.size.width * scale, height: edit.crop.size.height * scale))
    }

    /// The picks in full, an edited photo drawn as it was edited and
    /// sent as a JPEG; a shot as it was taken.
    func read(_ ids: [String]) async -> [LibraryPick] {
        let fromBase = ids.filter { shot($0) == nil }
        var read = Dictionary(uniqueKeysWithValues: await base.read(fromBase).map { ($0.assetIdentifier, $0) })
        for id in ids {
            guard let shot = shot(id) else { continue }
            read[id] = LibraryPick(media: .image(shot.data, .jpeg), thumbnail: shot.image,
                                   pixelSize: CGSize(width: shot.image.size.width * shot.image.scale, height: shot.image.size.height * shot.image.scale),
                                   duration: nil, assetIdentifier: id)
        }
        var picks: [LibraryPick] = []
        for id in ids {
            guard let pick = read[id] else { continue }
            guard let edit = edits[id], case let .image(data, _) = pick.media else {
                picks.append(pick)
                continue
            }
            let done = await Task.detached(priority: .userInitiated) { () -> (Data, UIImage, CGSize)? in
                guard let image = UIImage(data: data) else { return nil }
                let out = PhotoEditRenderer.render(image, edit, maxPixels: 4096)
                guard let jpeg = out.jpegData(compressionQuality: 0.92) else { return nil }
                let thumbnail = PhotoEditRenderer.render(image, edit, maxPixels: 512)
                return (jpeg, thumbnail, CGSize(width: out.size.width * out.scale, height: out.size.height * out.scale))
            }.value
            guard let (jpeg, thumbnail, pixels) = done else {
                picks.append(pick)
                continue
            }
            picks.append(LibraryPick(media: .image(jpeg, .jpeg), thumbnail: thumbnail, pixelSize: pixels, duration: nil, assetIdentifier: id))
        }
        return picks
    }

    /// `image`, a picture of `id`, as its edit has it.
    func edited(_ image: UIImage, _ id: String) -> UIImage {
        guard let edit = edits[id] else { return image }
        return PhotoEditRenderer.render(image, edit, maxPixels: 1024)
    }
}

extension PhotoEdit {
    /// The editor's numbers for a picture shaped like `image`: its longer
    /// side 2048, whatever size the picture at hand.
    static func canvas(for image: UIImage) -> CGSize {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return CGSize(width: 2048, height: 2048) }
        let scale = 2048 / max(size.width, size.height)
        return CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
    }
}
#endif
