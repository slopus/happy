#if canImport(UIKit)
import HappyCore
import QuickLook
import UIKit

/// A document or file a tool presented, shown in Quick Look: its bytes are
/// read through the paired computer into a folder of its own in the caches,
/// under the name it was presented with, previewed from there, and removed
/// when the preview closes.
@MainActor
final class StemCellFilePreview: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
    private let loader: StemCellMediaLoader
    private let media: StemCellMedia
    private let folder = StemCellFilePreview.root.appendingPathComponent(UUID().uuidString, isDirectory: true)
    private var url: URL?

    private static var cleared = false

    /// Where previews are read to; what a preview left (the app ended while
    /// one showed) goes at the next launch's first preview, or when a
    /// computer is forgotten.
    static let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("StemCells/files", isDirectory: true)

    init(loader: StemCellMediaLoader, media: StemCellMedia) {
        self.loader = loader
        self.media = media
    }

    /// Nil when the bytes could not be read.
    func controller() async -> QLPreviewController? {
        if !Self.cleared {
            Self.cleared = true
            let root = Self.root
            await Task.detached(priority: .userInitiated) { try? FileManager.default.removeItem(at: root) }.value
        }
        let name = (media.item.name as NSString).lastPathComponent
        let url = folder.appendingPathComponent(name.isEmpty ? "file" : name)
        guard await loader.download(media, to: url) else { return nil }
        self.url = url
        let controller = QLPreviewController()
        controller.dataSource = self
        controller.delegate = self
        return controller
    }

    nonisolated func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

    nonisolated func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem {
        MainActor.assumeIsolated { (url ?? URL(fileURLWithPath: "/dev/null")) as NSURL }
    }

    nonisolated func previewControllerDidDismiss(_ controller: QLPreviewController) {
        MainActor.assumeIsolated {
            let folder = folder
            Task.detached(priority: .utility) { try? FileManager.default.removeItem(at: folder) }
        }
    }

    static func removeAll() {
        let root = root
        Task.detached(priority: .utility) { try? FileManager.default.removeItem(at: root) }
    }
}
#endif
