#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A document's image files, read off the main thread once each.
@MainActor
final class GenUIImages {
    private var cache: [URL: UIImage] = [:]
    private var waiting: [URL: [(UIImage?) -> Void]] = [:]

    func load(_ url: URL, _ done: @escaping (UIImage?) -> Void) {
        if let image = cache[url] { return done(image) }
        if waiting[url] != nil {
            waiting[url]?.append(done)
            return
        }
        waiting[url] = [done]
        Task.detached(priority: .userInitiated) {
            // Files of the artifact only: the document never names a remote URL.
            let image = url.isFileURL ? (try? Data(contentsOf: url)).flatMap { UIImage(data: $0)?.preparingForDisplay() } : nil
            await MainActor.run { [weak self] in
                guard let self else { return }
                if let image { cache[url] = image }
                let callbacks = waiting.removeValue(forKey: url) ?? []
                callbacks.forEach { $0(image) }
            }
        }
    }
}

/// `image`: a stored file filling a box of its shape, cropped and centred.
/// The box is its final size from the start; the ThumbHash fills it until
/// the file arrives. `figure` is rounded and height-capped, `tile` square
/// (its mosaic rounds the whole), `thumb` a small leading square, `cover`
/// the rounded top of a carousel card. Tapping one in a viewer group asks
/// the host to open its viewer there.
final class GenUIImageView: GenUIElementView {
    let shape: GenUIShape
    private let role: GenUIImage.Role
    private let placeholder = UIImageView()
    private let imageView = UIImageView()
    private let dim = UIView()
    private let overlay = UILabel()
    private let control = GenUIPressable()

    init(key: String, _ image: GenUIImage, context: GenUIContext) {
        shape = image.shape
        role = image.role
        super.init(key: key)
        backgroundColor = UIColor(GenUITone.neutral.fill)
        clipsToBounds = true
        layer.cornerCurve = .continuous
        layer.cornerRadius = switch image.role {
        case .figure: GenUIMetrics.imageRadius
        case .cover: GenUIMetrics.coverRadius
        case .thumb: GenUIMetrics.thumbRadius
        case .tile: 0
        }
        placeholder.image = ThumbHashImages.image(image.thumbhash)
        placeholder.contentMode = .scaleToFill
        addSubview(placeholder)
        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        addSubview(imageView)
        if let text = image.overlay {
            dim.backgroundColor = UIColor.black.withAlphaComponent(0.45)
            addSubview(dim)
            overlay.attributedText = NSAttributedString(string: text, attributes: [.font: Fonts.ui(.semiBold, size: 22), .foregroundColor: UIColor.white])
            overlay.textAlignment = .center
            addSubview(overlay)
        }
        isAccessibilityElement = true
        accessibilityLabel = image.alt
        accessibilityTraits = .image
        if let viewer = image.viewer {
            control.pressedColor = UIColor.black.withAlphaComponent(0.15)
            control.addAction(UIAction { [weak context, key] _ in context?.onViewer?(key, viewer.group, viewer.index) }, for: .touchUpInside)
            addSubview(control)
            accessibilityTraits = [.image, .button]
        }
        if let url = context.url(image.file) {
            let fades = !context.freezesMotion
            context.images.load(url) { [weak self] loaded in
                guard let self, let loaded else { return }
                ImageFade.show(loaded, in: imageView, fade: fades)
            }
        }
    }

    override func natural(_ width: CGFloat) -> CGSize {
        switch role {
        case .thumb: return CGSize(width: min(width, GenUIMetrics.thumb), height: GenUIMetrics.thumb)
        case .figure: return CGSize(width: width, height: min(GenUIMetrics.figureMaxHeight, (width * GenUIMetrics.ratio(shape.rawValue)).rounded()))
        case .tile, .cover: return CGSize(width: width, height: (width * GenUIMetrics.ratio(shape.rawValue)).rounded())
        }
    }

    override var minWidth: CGFloat { role == .thumb ? GenUIMetrics.thumb : 80 }
    override var fills: Bool { role != .thumb }
    override var isLeading: Bool { role == .thumb }

    override func layoutSubviews() {
        super.layoutSubviews()
        placeholder.frame = bounds
        imageView.frame = bounds
        dim.frame = bounds
        overlay.frame = bounds
        control.frame = bounds
    }
}
#endif
