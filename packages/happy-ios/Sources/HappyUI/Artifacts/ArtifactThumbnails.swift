#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The artifacts list's small pictures: each image or recording entry read
/// once through the artifact viewer's own media (`ArtifactMedia`), so the
/// bytes land in the account's media folder and the viewer opens on them,
/// decoded at the tile's size off the main thread and kept for the screen.
@MainActor
final class ArtifactThumbnails {
    private let session: Session
    private let images = NSCache<NSString, UIImage>()
    private var loading: [String: Task<Void, Never>] = [:]
    private var waiting: [String: [WeakThumbnail]] = [:]

    private struct WeakThumbnail { weak var view: ArtifactThumbnailView? }

    init(session: Session) {
        self.session = session
        images.countLimit = 300
    }

    /// Fills `view` with `artifact`'s picture now or once it is read.
    func show(_ artifact: ArtifactSummary, in view: ArtifactThumbnailView, pixels: Int) {
        let key = ArtifactListItems.thumbnailKey(artifact)
        view.key = key
        if let image = images.object(forKey: key as NSString) { return view.show(image, animated: false) }
        waiting[key, default: []].append(WeakThumbnail(view: view))
        guard loading[key] == nil, let entry = artifact.entry else { return }
        let media = ArtifactMedia(client: session.client, artifactId: artifact.id, version: artifact.latestVersion, library: session.media)
        loading[key] = Task { [weak self] in
            let shown = media.media(entry.file)
            let image = await media.image(shown.key, pixels: pixels)
            guard let self else { return }
            loading[key] = nil
            let views = waiting.removeValue(forKey: key) ?? []
            guard let image else { return }
            images.setObject(image, forKey: key as NSString)
            for view in views.compactMap(\.view) where view.key == key { view.show(image, animated: true) }
        }
    }

    func cancel() {
        for task in loading.values { task.cancel() }
        loading = [:]
        waiting = [:]
    }
}

/// A row's picture over its kind's tile, which shows until it arrives.
final class ArtifactThumbnailView: UIImageView {
    var key: String?

    init(radius: CGFloat) {
        super.init(frame: .zero)
        contentMode = .scaleAspectFill
        clipsToBounds = true
        layer.cornerRadius = radius
        layer.cornerCurve = .continuous
        isUserInteractionEnabled = false
        accessibilityIgnoresInvertColors = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(_ image: UIImage, animated: Bool) {
        self.image = image
        guard animated, window != nil, !UIAccessibility.isReduceMotionEnabled else { return }
        alpha = 0
        UIView.animate(withDuration: 0.2) { self.alpha = 1 }
    }
}
#endif
