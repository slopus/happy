#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

extension UIImage {
    /// One of happy-app's icons at RN's `size`, as a template image to tint.
    ///
    /// The image is the box RN measures for `<Ionicons size={size} />`
    /// (`IconLayout`): the glyph's advance wide, one line of the font tall,
    /// rounded up to whole pixels at `scale`, with the glyph where RN draws
    /// it. Centre it in a container with `IconLayout.frame(centeredIn:)`, or
    /// use `IconView`, to land on RN's pixels; `.center` content mode can be
    /// half a pixel off.
    ///
    /// An icon missing from the catalog draws as an empty `size` square, so a
    /// screen never crashes over a glyph that was not generated.
    public static func icon(_ icon: Icon, size: CGFloat, scale: CGFloat? = nil) -> UIImage {
        let scale = scale ?? UIGraphicsImageRendererFormat.preferred().scale
        guard size > 0, scale > 0 else { return UIImage() }
        let key = IconImageKey(icon: icon, size: size, scale: scale)
        if let cached = IconImageCache.shared.object(forKey: key) { return cached }
        let glyph = IconCatalog.glyph(for: icon)
        let layout = glyph?.layout(size: size, scale: scale)
        let format = UIGraphicsImageRendererFormat.preferred()
        format.scale = scale
        format.opaque = false
        let renderer = UIGraphicsImageRenderer(size: layout?.size ?? CGSize(width: size, height: size), format: format)
        let image = renderer.image { context in
            guard let glyph, let layout else { return }
            let cg = context.cgContext
            cg.translateBy(x: layout.glyphOrigin.x, y: layout.glyphOrigin.y)
            cg.scaleBy(x: layout.glyphScale, y: layout.glyphScale)
            cg.addPath(glyph.path.cgPath)
            // TrueType outlines are drawn non-zero, as CoreText draws them.
            cg.fillPath(using: .winding)
        }.withRenderingMode(.alwaysTemplate)
        IconImageCache.shared.setObject(image, forKey: key)
        return image
    }
}

extension Icon {
    /// Where RN draws this icon at `size`; nil when it was not generated.
    public func layout(size: CGFloat, scale: CGFloat) -> IconLayout? {
        IconCatalog.glyph(for: self)?.layout(size: size, scale: scale)
    }
}

/// An icon centred in its bounds on the pixels RN puts it: `<View
/// style={{ alignItems: 'center', justifyContent: 'center' }}><Ionicons …/>`.
/// Give it the container's frame. Its fitting size is RN's text box for the
/// icon, for layouts that place the icon itself.
public final class IconView: UIView {
    public var icon: Icon? {
        didSet { if icon != oldValue { update() } }
    }

    public var size: CGFloat {
        didSet { if size != oldValue { update() } }
    }

    private let imageView = UIImageView()

    public init(_ icon: Icon? = nil, size: CGFloat, tint: ColorToken? = nil) {
        self.icon = icon
        self.size = size
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        imageView.contentMode = .topLeft
        addSubview(imageView)
        if let tint { tintColor = UIColor(tint) }
        // didSet doesn't run in the initializer.
        update()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private var iconLayout: IconLayout? {
        icon?.layout(size: size, scale: layoutScale)
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        iconLayout?.size ?? CGSize(width: self.size, height: self.size)
    }

    public override var intrinsicContentSize: CGSize {
        sizeThatFits(.zero)
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        imageView.frame = iconLayout?.frame(centeredIn: bounds, scale: layoutScale) ?? bounds
    }

    public override func didMoveToWindow() {
        super.didMoveToWindow()
        // The image is rendered for the screen's pixels.
        update()
    }

    private func update() {
        imageView.image = icon.map { UIImage.icon($0, size: size, scale: layoutScale) }
        invalidateIntrinsicContentSize()
        setNeedsLayout()
    }
}

extension UIView {
    /// Device pixels per point for this view: its screen's once it is on
    /// one, the main screen's before.
    var layoutScale: CGFloat {
        let scale = window?.screen.scale ?? traitCollection.displayScale
        return scale > 0 ? scale : UIGraphicsImageRendererFormat.preferred().scale
    }
}

private final class IconImageKey: NSObject {
    let icon: Icon
    let size: CGFloat
    let scale: CGFloat

    init(icon: Icon, size: CGFloat, scale: CGFloat) {
        self.icon = icon
        self.size = size
        self.scale = scale
    }

    override var hash: Int {
        var hasher = Hasher()
        hasher.combine(icon)
        hasher.combine(size)
        hasher.combine(scale)
        return hasher.finalize()
    }

    override func isEqual(_ object: Any?) -> Bool {
        guard let other = object as? IconImageKey else { return false }
        return other.icon == icon && other.size == size && other.scale == scale
    }
}

private enum IconImageCache {
    nonisolated(unsafe) static let shared = NSCache<IconImageKey, UIImage>()
}
#endif
