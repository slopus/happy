#if canImport(UIKit)
import HappyCore
import UIKit

/// A `gen_ui` artifact version's own pictures, read through its
/// `ArtifactMedia`: a path the version doesn't hold is never asked for, so a
/// document can't show a picture from another version.
@MainActor
final class GenUIArtifactFiles: GenUIFiles {
    let media: ArtifactMedia
    private let files: [String: AgentWire.ArtifactVersion.File]

    init(media: ArtifactMedia, files: [AgentWire.ArtifactVersion.File]) {
        self.media = media
        self.files = Dictionary(files.map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first })
    }

    /// The version's picture at `path`, registered with the media source.
    func picture(_ path: String) -> ChatMedia? {
        guard Self.isOwn(path), let file = files[path], file.mimeType.hasPrefix("image/") else { return nil }
        return media.media(file)
    }

    /// A viewer group's pictures the version holds, and where `index` is among them.
    func viewer(_ items: [GenUIViewerItem], at index: Int) -> (pictures: [Picture], start: Int) {
        var pictures: [Picture] = []
        var start = 0
        for (position, item) in items.enumerated() {
            guard let shown = picture(item.file) else { continue }
            if position == index { start = pictures.count }
            let size = item.width > 0 && item.height > 0 ? CGSize(width: item.width, height: item.height) : media.knownSize(shown.key)
            pictures.append(Picture(key: shown.key, thumbhash: item.thumbhash.isEmpty ? nil : item.thumbhash, label: item.alt.isEmpty ? shown.label : item.alt, size: size))
        }
        return (pictures, start)
    }

    func image(_ path: String, pixels: Int) async -> UIImage? {
        guard let picture = picture(path) else { return nil }
        return await media.image(picture.key, pixels: pixels)
    }
}
#endif
