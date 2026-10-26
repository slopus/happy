#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// MakeStuffIntro: the work's 64px mark centred over its line. Once the
/// conversation has begun the line keeps its place, hidden.
final class StemCellIntroView: UIView {
    enum Mark: Equatable {
        case stemCell(seed: String)
        case clay(String)
    }

    private let stemCell = StemCellMarkView()
    private let clay = UIImageView()
    private let line = UILabel()
    private var settled = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        clay.contentMode = .scaleAspectFit
        line.attributedText = Self.centred(Strings.StemCells.introLine, color: Palette.text)
        line.numberOfLines = 0
        for view in [stemCell, clay, line] { addSubview(view) }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// `.happy-make-stuff__line`: 14/20, centred.
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
    }

    func layout(width: CGFloat) -> MakeStuffIntroLayout {
        MakeStuffIntroLayout(
            width: width,
            line: Self.measurable(line.attributedText ?? NSAttributedString()),
            settled: settled
        )
    }

    func place(_ layout: MakeStuffIntroLayout) {
        stemCell.frame = layout.mark
        clay.frame = layout.mark
        line.frame = layout.line
    }
}

private extension CGSize {
    var ceiled: CGSize { CGSize(width: width.rounded(.up), height: height.rounded(.up)) }
}
#endif
