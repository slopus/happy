#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// MakeStuffIntro: the work's 64px mark centred over its line, then
/// "Or start one of these:" and what can be made at once. Once the
/// conversation has begun the offers go and the line keeps its place, hidden.
final class StemCellIntroView: UIView {
    enum Mark: Equatable {
        case stemCell(seed: String)
        case clay(String)
    }

    var onOffer: ((StemCellOffer) -> Void)?

    private let stemCell = StemCellMarkView()
    private let clay = UIImageView()
    private let line = UILabel()
    private let caption = UILabel()
    private var buttons: [StemCellOfferButton] = []
    private(set) var offers: [StemCellOffer] = []
    private var settled = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        clay.contentMode = .scaleAspectFit
        line.attributedText = Self.centred(Strings.StemCells.introLine, color: Palette.text)
        line.numberOfLines = 0
        caption.attributedText = Self.centred(Strings.StemCells.introOptions, color: Palette.stemCellsRowText)
        caption.numberOfLines = 0
        for view in [stemCell, clay, line, caption] { addSubview(view) }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// `.happy-make-stuff__line` and `__caption`: 14/20, centred.
    private static func centred(_ text: String, color: ColorToken) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.minimumLineHeight = 20
        paragraph.maximumLineHeight = 20
        return NSAttributedString(string: text, attributes: [
            .font: StemCellsFonts.ui(.regular, size: 14),
            .foregroundColor: UIColor(color),
            .paragraphStyle: paragraph,
        ])
    }

    private static func measurable(_ text: NSAttributedString) -> Measurable {
        Measurable { width in
            text.boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin], context: nil).size.ceiled
        }
    }

    func setOffers(_ offers: [StemCellOffer]) {
        guard offers != self.offers else { return }
        self.offers = offers
        buttons.forEach { $0.removeFromSuperview() }
        buttons = offers.map { offer in
            let button = StemCellOfferButton(offer: offer)
            button.addAction(UIAction { [weak self] _ in self?.onOffer?(offer) }, for: .touchUpInside)
            addSubview(button)
            return button
        }
        applyVisibility()
    }

    func configure(_ mark: Mark, settled: Bool) {
        switch mark {
        case .stemCell(let seed):
            stemCell.seed = seed
            stemCell.isHidden = false
            clay.isHidden = true
        case .clay(let slug):
            let image = ClayIconImages.image(slug)
            if clay.isHidden, !stemCell.isHidden, let seed = stemCell.seed, let image, StemCellHatchView.canPlay(in: self) {
                // The stem cell grows into the picture Prioritizing chose.
                clay.image = image
                clay.isHidden = false
                clay.alpha = 0
                stemCell.isHidden = true
                let hatch = StemCellHatchView(frame: stemCell.frame)
                addSubview(hatch)
                StemCellHatchHaptics.shared.play(size: stemCell.frame.width)
                hatch.play(seed: seed, image: image) { [weak self] in self?.clay.alpha = 1 }
            } else {
                clay.image = image
                clay.isHidden = false
                stemCell.isHidden = true
            }
        }
        self.settled = settled
        applyVisibility()
    }

    private func applyVisibility() {
        line.isHidden = settled
        caption.isHidden = settled || offers.isEmpty
        buttons.forEach { $0.isHidden = settled }
    }

    func layout(width: CGFloat) -> MakeStuffIntroLayout {
        MakeStuffIntroLayout(
            width: width,
            line: Self.measurable(line.attributedText ?? NSAttributedString()),
            caption: Self.measurable(caption.attributedText ?? NSAttributedString()),
            optionLabels: buttons.map(\.labelWidth),
            settled: settled
        )
    }

    func place(_ layout: MakeStuffIntroLayout) {
        stemCell.frame = layout.mark
        clay.frame = layout.mark
        line.frame = layout.line
        caption.frame = layout.caption ?? .zero
        for (index, button) in buttons.enumerated() {
            button.setLayoutFrame(index < layout.options.count ? layout.options[index] : .zero)
        }
    }
}

/// A small secondary Button with an icon: the Surface kind's glyph, or a
/// person's for a bot, and its label, in a pill ringed in the divider.
final class StemCellOfferButton: UIControl {
    private let icon: IconView
    private let label = UILabel()

    init(offer: StemCellOffer) {
        let name = switch offer {
        case .bot: "agents"
        case .surface(let type): StemCellsRows.surfaceGlyph(type)
        }
        icon = IconView(StemCellsGlyphs.icon(name), size: 14, tint: Palette.text)
        super.init(frame: .zero)
        backgroundColor = UIColor(Palette.stemCellsButton)
        layer.borderWidth = 1
        updateBorder()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.updateBorder() }
        layer.cornerCurve = .continuous
        label.attributedText = NSAttributedString(string: Strings.StemCells.offer(offer), attributes: [
            .font: StemCellsFonts.ui(.bold, size: 12),
            .foregroundColor: UIColor(Palette.text),
            .kern: 0.12,
        ])
        accessibilityLabel = Strings.StemCells.offer(offer)
        accessibilityTraits = .button
        isAccessibilityElement = true
        accessibilityIdentifier = "stem-offer:\(Strings.StemCells.offer(offer))"
        addSubview(icon)
        addSubview(label)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    var labelWidth: CGFloat { label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: 16)).width }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.6 : 1 }
    }

    private func updateBorder() {
        layer.borderColor = UIColor(Palette.stemCellsDivider).resolvedColor(with: traitCollection).cgColor
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = bounds.height / 2
        let content = MakeStuffIntroLayout.optionContent(bounds.size, label: label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: 16)))
        icon.frame = content.icon
        label.frame = content.label
    }
}

private extension CGSize {
    var ceiled: CGSize { CGSize(width: width.rounded(.up), height: height.rounded(.up)) }
}
#endif
