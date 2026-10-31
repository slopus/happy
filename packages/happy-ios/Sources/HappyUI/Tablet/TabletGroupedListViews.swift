#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// ProviderIcon.tsx: the GPT mark tinted the secondary text colour, the
/// Claude mark in its own colours, or an Ionicon in the secondary colour.
final class ProviderIconView: UIView {
    private let image = UIImageView()
    private let glyph: IconView
    private let size: CGFloat

    var kind: ProviderIconKind = .generic {
        didSet { if kind != oldValue { apply() } }
    }

    init(size: CGFloat) {
        self.size = size
        glyph = IconView(nil, size: size, tint: Palette.textSecondary)
        super.init(frame: .zero)
        image.contentMode = .scaleAspectFit
        image.tintColor = UIColor(Palette.textSecondary)
        addSubview(image)
        addSubview(glyph)
        isUserInteractionEnabled = false
        apply()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func apply() {
        switch kind {
        case .codex:
            image.image = UIImage.happy("icon-gpt")?.withRenderingMode(.alwaysTemplate)
        case .claude:
            image.image = UIImage.happy("icon-claude")?.withRenderingMode(.alwaysOriginal)
        case .grok, .kimi, .generic:
            image.image = nil
        }
        image.isHidden = image.image == nil
        glyph.isHidden = !image.isHidden
        switch kind {
        case .grok: glyph.icon = .ionicons("flash-outline")
        case .kimi: glyph.icon = .ionicons("moon-outline")
        case .generic: glyph.icon = .ionicons("sparkles-outline")
        case .codex, .claude: glyph.icon = nil
        }
        setNeedsLayout()
    }

    /// An image is `size` square; a glyph is its RN text box (`Icon.layout`).
    override func sizeThatFits(_ size: CGSize) -> CGSize {
        image.isHidden ? glyph.sizeThatFits(size) : CGSize(width: self.size, height: self.size)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        image.frame = bounds
        glyph.frame = bounds
    }
}

/// `TabletStatusTone` as drawn.
enum TabletStatusColors {
    static func color(_ tone: TabletStatusTone) -> ColorToken {
        switch tone {
        case .offline: TabletPalette.statusOffline
        case .working: TabletPalette.statusWorking
        case .online: TabletPalette.statusOnline
        case .attention: TabletPalette.statusAttention
        case .idle: Palette.textSecondary
        }
    }
}
#endif
