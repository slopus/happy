#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// One row of the Stem Cells sidebar as desktop's `Sidebar` draws it: a
/// rounded box, the mark in its leading lane, the label, and the trailing
/// square for a status, an unread dot or a section's fold. It applies the
/// frames `StemCellsSidebarLayout` gives it and decides nothing about where
/// anything goes.
final class StemCellsRowView: UIView {
    private let fill = UIView()
    private let stemCell = StemCellMarkView()
    private let picture = UIImageView()
    private let label = StemCellsShimmerLabel()
    private let trailing = UIImageView()
    private let dot = UIView()
    private let chevron = UIImageView()
    private let rule = UIView()
    private var pictureJob: Task<Void, Never>?

    private(set) var row: StemCellsRow?
    var images: StemCellsImages?
    var frames: StemCellsSidebarLayout.Frame? {
        didSet { if frames != oldValue { setNeedsLayout() } }
    }
    var selected = false {
        didSet { if selected != oldValue { applyState() } }
    }
    var pressed = false {
        didSet { if pressed != oldValue { applyState() } }
    }
    /// The row is being carried: it rides above the others.
    var lifted = false {
        didSet { if lifted != oldValue { applyState() } }
    }
    /// Pulled sideways over its actions: its box is filled so they stay under it.
    var swiping = false {
        didSet { if swiping != oldValue { applyState() } }
    }
    private var field: StemCellsRenameField?
    private var finish: ((String?) -> Void)?
    /// A title just saved, shown until the row says the same.
    private var held: (label: String, until: Task<Void, Never>)?
    /// The row as the sidebar last gave it.
    private var latest: StemCellsRow?

    override init(frame: CGRect) {
        super.init(frame: frame)
        fill.layer.cornerRadius = StemCellsMetrics.cornerRadius
        fill.layer.cornerCurve = .continuous
        fill.isUserInteractionEnabled = false
        picture.contentMode = .scaleAspectFill
        picture.clipsToBounds = true
        picture.layer.cornerCurve = .continuous
        trailing.contentMode = .center
        dot.layer.cornerRadius = StemCellsMetrics.unreadDot / 2
        dot.backgroundColor = UIColor(Palette.stemCellsQuestion)
        chevron.contentMode = .center
        rule.backgroundColor = UIColor(Palette.stemCellsDivider)
        for view in [fill, stemCell, picture, label, trailing, dot, chevron, rule] { addSubview(view) }
        isAccessibilityElement = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Shows `row`; a row equal to the one shown changes nothing.
    func configure(_ row: StemCellsRow) {
        latest = row
        var row = row
        if let held {
            if row.label == held.label { held.until.cancel(); self.held = nil } else { row.label = held.label }
        }
        guard row != self.row else { return }
        let previous = self.row
        self.row = row
        if previous?.mark != row.mark {
            applyMark(row.mark)
            if case .stemCell(let seed) = previous?.mark, case .clay(let slug) = row.mark, let image = ClayIconImages.image(slug) { hatch(seed: seed, into: image) }
        }
        applyText(row)
        applyTrailing(row)
        applyState()
        accessibilityLabel = row.kind == .separator ? nil : row.label
        accessibilityTraits = row.kind == .section ? [.header, .button] : row.kind == .separator ? .none : .button
        isAccessibilityElement = row.kind != .separator
        accessibilityIdentifier = "stem-row:\(row.kind):\(row.label)"
        // What the row wears, so a test can watch a stem cell grow its icon.
        accessibilityValue = switch row.mark {
        case .stemCell: "stem cell"
        case .clay(let slug): slug
        default: nil
        }
        setNeedsLayout()
    }

    private func applyMark(_ mark: StemCellsRow.Mark) {
        pictureJob?.cancel(); pictureJob = nil
        stemCell.seed = nil
        stemCell.isHidden = true
        picture.isHidden = true
        picture.image = nil
        picture.tintColor = nil
        picture.contentMode = .scaleAspectFit
        picture.layer.cornerRadius = 0
        switch mark {
        case .none:
            break
        case .stemCell(let seed):
            stemCell.isHidden = false
            stemCell.seed = seed
        case .happy:
            picture.isHidden = false
            picture.image = ClayIconImages.happy
        case .clay(let slug):
            // Clay art stands as drawn: no frame, no rounding.
            picture.isHidden = false
            picture.image = ClayIconImages.image(slug)
        case .glyph(let name):
            picture.isHidden = false
            picture.contentMode = .center
            picture.image = StemCellsGlyphs.image(name, size: StemCellsMetrics.glyph)
        case .image(let path, let thumbhash):
            // A picture is a rounded square.
            picture.isHidden = false
            picture.contentMode = .scaleAspectFill
            picture.layer.cornerRadius = StemCellsMetrics.pictureRadius
            let pixels = Int(StemCellsMetrics.mark * 3)
            if let cached = images?.cached(path, pixels: pixels) {
                picture.image = cached
            } else {
                picture.image = StemCellsImages.placeholder(thumbhash)
                pictureJob = Task { [weak self] in
                    guard let image = await self?.images?.image(path, pixels: pixels), !Task.isCancelled else { return }
                    self?.picture.image = image
                }
            }
        }
    }

    private func applyText(_ row: StemCellsRow) {
        switch row.kind {
        case .section:
            label.attributedText = NSAttributedString(string: row.label.uppercased(), attributes: [
                .font: StemCellsFonts.mono(bold: true, size: StemCellsMetrics.sectionLabelSize),
                .kern: StemCellsMetrics.sectionLabelSize * StemCellsMetrics.sectionTracking,
            ])
        case .separator:
            label.attributedText = nil
        default:
            let weight: StemCellsFonts.Weight = row.unread ? .bold : selected ? .semiBold : .medium
            label.attributedText = NSAttributedString(string: row.label, attributes: [.font: StemCellsFonts.ui(weight, size: StemCellsMetrics.labelSize)])
        }
        // Working rows shimmer their title; nothing else spins.
        label.shimmering = row.status == .working && (row.kind == .space || row.kind == .session)
    }

    private func applyTrailing(_ row: StemCellsRow) {
        trailing.isHidden = true
        dot.isHidden = true
        chevron.isHidden = row.kind != .section
        rule.isHidden = row.kind != .separator
        if row.kind == .section {
            chevron.image = StemCellsGlyphs.image(row.collapsed == true ? "chevron-right" : "chevron-down", size: 12)
            // Shown while folded; faint while open, so it is found without hovering.
            chevron.alpha = row.collapsed == true ? 1 : 0.45
        }
        switch row.status {
        case .awaitingInput:
            trailing.isHidden = false
            trailing.image = StemCellsGlyphs.image("question", size: 15)
            trailing.tintColor = UIColor(Palette.stemCellsQuestion)
        case .waiting:
            trailing.isHidden = false
            trailing.image = StemCellsGlyphs.image("clock", size: 14)
            trailing.tintColor = UIColor(Palette.stemCellsRowText)
        case .working, .none:
            dot.isHidden = !row.unread
        }
    }

    private func applyState() {
        let ink = UIColor(selected || row?.unread == true ? Palette.stemCellsRowTextActive : Palette.stemCellsRowText)
        label.textColor = ink
        picture.tintColor = picture.contentMode == .center ? ink : nil
        chevron.tintColor = UIColor(Palette.stemCellsRowText)
        if let row, row.kind != .section, row.kind != .separator { applyText(row) }
        let carryable = row?.kind != .section && row?.kind != .separator
        fill.backgroundColor = lifted || swiping ? UIColor(Palette.stemCellsBackground) : selected ? UIColor(Palette.stemCellsRowSelected) : pressed && carryable ? UIColor(Palette.stemCellsRowPressed) : .clear
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = lifted ? 0.14 : 0
        layer.shadowRadius = 12
        layer.shadowOffset = CGSize(width: 0, height: 4)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let frames else { return }
        // Frames are in sidebar content coordinates; this view's own frame is the box.
        let origin = frames.box.origin
        func local(_ rect: CGRect) -> CGRect { rect.offsetBy(dx: -origin.x, dy: -origin.y) }
        fill.frame = bounds
        layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: StemCellsMetrics.cornerRadius).cgPath
        let mark = frames.mark.map(local) ?? .zero
        stemCell.frame = mark
        picture.frame = mark
        label.frame = local(frames.label)
        field?.frame = label.frame
        trailing.frame = frames.trailing.map(local) ?? .zero
        dot.frame = trailing.frame.isEmpty ? .zero : CGRect(
            x: trailing.frame.midX - StemCellsMetrics.unreadDot / 2, y: trailing.frame.midY - StemCellsMetrics.unreadDot / 2,
            width: StemCellsMetrics.unreadDot, height: StemCellsMetrics.unreadDot
        )
        chevron.frame = frames.chevron.map(local) ?? .zero
        rule.frame = frames.rule.map(local) ?? .zero
    }

    // MARK: Hatch

    /// The stem cell grows into its picture where the person can see it;
    /// elsewhere the picture just shows.
    private func hatch(seed: String, into image: UIImage) {
        guard let frames, let mark = frames.mark, StemCellHatchView.canPlay(in: self) else { return }
        let hatch = StemCellHatchView(frame: mark.offsetBy(dx: -frames.box.minX, dy: -frames.box.minY))
        picture.alpha = 0
        insertSubview(hatch, aboveSubview: picture)
        StemCellHatchHaptics.shared.play(size: mark.width)
        hatch.play(seed: seed, image: image) { [weak self] in self?.picture.alpha = 1 }
    }

    // MARK: Rename in place

    /// The title becomes a field in its own frame and font, `text` selected
    /// and the keyboard up. `done` gets what was kept, or nil when Escape
    /// put the old one back. False, and nothing changed, when the field
    /// couldn't take the keyboard.
    @discardableResult
    func beginEditing(_ text: String, done: @escaping (String?) -> Void) -> Bool {
        guard field == nil, let row else { return false }
        let field = StemCellsRenameField()
        let section = row.kind == .section
        field.font = section ? StemCellsFonts.mono(bold: true, size: StemCellsMetrics.sectionLabelSize) : StemCellsFonts.ui(.medium, size: StemCellsMetrics.labelSize)
        if section { field.defaultTextAttributes[.kern] = StemCellsMetrics.sectionLabelSize * StemCellsMetrics.sectionTracking }
        field.textColor = UIColor(Palette.stemCellsRowTextActive)
        field.tintColor = UIColor(Palette.stemCellsRowTextActive)
        field.text = text
        field.returnKeyType = .done
        field.autocapitalizationType = .sentences
        field.accessibilityIdentifier = "stem-rename"
        field.frame = label.frame
        field.onFinish = { [weak self] kept in self?.finishEditing(kept) }
        addSubview(field)
        self.field = field
        finish = done
        label.isHidden = true
        guard field.becomeFirstResponder() else {
            finish = nil
            finishEditing(nil)
            return false
        }
        field.selectAll(nil)
        return true
    }

    /// Keeps what the field holds: by letting go of the keyboard, or at once
    /// when it no longer has it.
    func commitEditing() {
        guard let field else { return }
        if field.isFirstResponder { field.resignFirstResponder() } else { finishEditing(field.text) }
    }

    private func finishEditing(_ kept: String?) {
        guard let field else { return }
        self.field = nil
        field.onFinish = nil
        field.removeFromSuperview()
        label.isHidden = false
        let finish = finish
        self.finish = nil
        finish?(kept)
    }

    /// Shows `title` now and keeps it until the row says the same (or a
    /// moment passes), so a saved name never flickers back.
    func holdLabel(_ title: String) {
        held?.until.cancel()
        let until = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled, let self else { return }
            held = nil
            if let latest { show(latest) }
        }
        held = (title, until)
        if var shown = latest {
            shown.label = title
            show(shown)
        }
    }

    /// A row that differs only in its title.
    private func show(_ shown: StemCellsRow) {
        row = shown
        applyText(shown)
        accessibilityLabel = shown.label
        accessibilityIdentifier = "stem-row:\(shown.kind):\(shown.label)"
    }
}

/// The field a title turns into: Return and losing focus keep it, Escape
/// puts the old one back.
final class StemCellsRenameField: UITextField, UITextFieldDelegate {
    var onFinish: ((String?) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        delegate = self
        borderStyle = .none
        backgroundColor = .clear
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var keyCommands: [UIKeyCommand]? {
        [UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(cancel))]
    }

    @objc private func cancel() {
        let finish = onFinish
        onFinish = nil
        resignFirstResponder()
        finish?(nil)
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        resignFirstResponder()
        return false
    }

    func textFieldDidEndEditing(_ textField: UITextField) {
        let finish = onFinish
        onFinish = nil
        finish?(text ?? "")
    }
}

/// One line of text that can carry desktop's ShimmerText: a band of light
/// travelling through the glyphs, the letters never moving.
final class StemCellsShimmerLabel: UIView {
    private let base = UILabel()
    private let highlight = UILabel()
    private let band = CAGradientLayer()

    var attributedText: NSAttributedString? {
        didSet {
            base.attributedText = attributedText
            highlight.attributedText = attributedText
            applyColors()
        }
    }

    var textColor: UIColor = .label {
        didSet { applyColors() }
    }

    var shimmering = false {
        didSet {
            guard shimmering != oldValue else { return }
            highlight.isHidden = !shimmering
            applyColors()
            if shimmering { startBand() } else { band.removeAllAnimations() }
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        for label in [base, highlight] {
            label.lineBreakMode = .byTruncatingTail
            label.numberOfLines = 1
            addSubview(label)
        }
        highlight.isHidden = true
        band.startPoint = CGPoint(x: 0, y: 0.5)
        band.endPoint = CGPoint(x: 1, y: 0.5)
        band.colors = [UIColor.clear.cgColor, UIColor.white.cgColor, UIColor.clear.cgColor]
        band.locations = [0.4, 0.5, 0.6]
        highlight.layer.mask = band
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func applyColors() {
        // Resting letters sit at 38% of the ink while the band passes.
        base.textColor = shimmering ? textColor.withAlphaComponent(0.38) : textColor
        highlight.textColor = textColor
        if let text = attributedText, text.length > 0 {
            for label in [base, highlight] {
                let colored = NSMutableAttributedString(attributedString: text)
                colored.addAttribute(.foregroundColor, value: label === base ? base.textColor! : highlight.textColor!, range: NSRange(location: 0, length: colored.length))
                label.attributedText = colored
            }
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        base.frame = bounds
        highlight.frame = bounds
        // Three widths of ramp, sliding two widths a cycle, as desktop's does.
        let width = max(1, min(bounds.width, base.intrinsicContentSize.width))
        CATransaction.begin(); CATransaction.setDisableActions(true)
        band.frame = CGRect(x: -2 * width, y: 0, width: 3 * width, height: bounds.height)
        CATransaction.commit()
        if shimmering { startBand() }
    }

    private func startBand() {
        let width = band.bounds.width / 3
        guard width > 0 else { return }
        band.removeAnimation(forKey: "sweep")
        let sweep = CABasicAnimation(keyPath: "position.x")
        sweep.fromValue = -width * 0.5
        sweep.toValue = width * 1.5
        sweep.duration = 1.6
        sweep.repeatCount = .infinity
        band.add(sweep, forKey: "sweep")
    }
}
#endif
