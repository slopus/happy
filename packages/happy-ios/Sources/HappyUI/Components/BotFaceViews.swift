#if canImport(UIKit)
import HappyIcons
import HappyLayout
import ImageIO
import UIKit

/// A seed's face as pixels (utils/botFacePaint.ts): the ground, then each
/// outline the seed picks, filled. Painted with Core Graphics alone, off
/// the main thread; the style is parsed on first use there too.
enum BotFacePainter {
    struct PaintFailed: Error, LocalizedError {
        var errorDescription: String? { "The face could not be painted." }
    }

    /// `paintBotFace`: the PNG the bot wears, at `BOT_FACE_PAINT_SIZE`.
    static func png(seed: String) async throws -> Data {
        let data = await Task.detached(priority: .userInitiated) { () -> Data? in
            guard let image = render(seed: seed, pixels: Int(BotFace.paintSize)) else { return nil }
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(destination, image, nil)
            guard CGImageDestinationFinalize(destination) else { return nil }
            return data as Data
        }.value
        guard let data, !data.isEmpty else { throw PaintFailed() }
        return data
    }

    /// A face for the picker, `side` points square at `scale`.
    static func image(seed: String, side: CGFloat, scale: CGFloat) async -> UIImage? {
        let pixels = Int((side * scale).rounded(.up))
        guard pixels > 0 else { return nil }
        let image = await Task.detached(priority: .userInitiated) { render(seed: seed, pixels: pixels) }.value
        return image.map { UIImage(cgImage: $0, scale: scale, orientation: .up) }
    }

    private static func render(seed: String, pixels: Int) -> CGImage? {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                data: nil,
                width: pixels,
                height: pixels,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: space,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else { return nil }
        // The outlines are drawn y-down, as SVG has them.
        context.translateBy(x: 0, y: CGFloat(pixels))
        context.scaleBy(x: 1, y: -1)
        draw(seed: seed, side: CGFloat(pixels), in: context)
        return context.makeImage()
    }

    private static func draw(seed: String, side: CGFloat, in context: CGContext) {
        let style = BotFaceStyle.adventurerNeutral
        let face = BotFace(seed: seed, style: style)
        context.scaleBy(x: side / style.canvas.width, y: side / style.canvas.height)
        if let ground = RGBA(hex: face.background) {
            context.setFillColor(cgColor(ground))
            context.fill(CGRect(origin: .zero, size: style.canvas))
        }
        for shape in face.shapes(in: style) {
            context.addPath(shape.path.cgPath)
            context.setFillColor(cgColor(shape.fill))
            context.fillPath(using: shape.evenOdd ? .evenOdd : .winding)
        }
    }

    private static func cgColor(_ rgba: RGBA) -> CGColor {
        CGColor(srgbRed: CGFloat(rgba.red), green: CGFloat(rgba.green), blue: CGFloat(rgba.blue), alpha: CGFloat(rgba.alpha))
    }
}

/// The faces a new bot may wear (BotFacePicker.tsx): four drawn from
/// seeds, one picked, a die to roll four more, and the artist's credit
/// with a link to her work, as the licence asks.
final class BotFacePickerView: UIView {
    var onPick: ((Int) -> Void)?
    var onRoll: (() -> Void)?

    private let heading = StyledLabel(style: TextStyles.botFaceHeading, color: Palette.textSecondary, lines: 0)
    private let faces = (0..<BotFacePickerLayout.Metrics.faceCount).map { BotFaceButton(index: $0) }
    private let die = BotFaceDieButton()
    private let credit = UILabel()
    private let creditLead = StyledLabel(style: TextStyles.botFaceCredit, color: Palette.textSecondary, lines: 1)
    private let creditLink = UIControl()
    private var localLayout: BotFacePickerLayout?

    var seeds: [String] = [] {
        didSet { if seeds != oldValue { setNeedsLayout() } }
    }

    var slot = 0 {
        didSet {
            guard slot != oldValue else { return }
            for face in faces { face.isPicked = face.index == slot }
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        heading.string = Strings.Home.botFaceHeading
        addSubview(heading)
        for face in faces {
            face.isPicked = face.index == slot
            face.addAction(UIAction { [weak self, weak face] _ in
                guard let face else { return }
                self?.onPick?(face.index)
            }, for: .touchUpInside)
            addSubview(face)
        }
        die.addAction(UIAction { [weak self] _ in self?.onRoll?() }, for: .touchUpInside)
        addSubview(die)

        credit.numberOfLines = 1
        applyCredit()
        credit.isAccessibilityElement = false
        addSubview(credit)
        creditLead.string = Strings.Home.botFaceCreditLead
        creditLink.isAccessibilityElement = true
        creditLink.accessibilityLabel = BotFaceStyle.adventurerNeutralCredit.artist
        creditLink.accessibilityTraits = .link
        creditLink.addAction(UIAction { _ in
            guard let url = URL(string: BotFaceStyle.adventurerNeutralCredit.artistURL) else { return }
            UIApplication.shared.open(url)
        }, for: .touchUpInside)
        addSubview(creditLink)

        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyCredit() }
        registerForTraitChanges(UIView.textSizeTraits) { (self: Self, _) in
            self.applyCredit()
            self.setNeedsLayoutUpTheTree()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// "Art by " and the artist's name, underlined, at the text size here.
    private func applyCredit() {
        let style = traitCollection.textEnvironment.map { TextStyles.botFaceCredit.scaled($0.scale) } ?? TextStyles.botFaceCredit
        let color = UIColor(Palette.textSecondary)
        let text = NSMutableAttributedString(attributedString: style.attributedString(
            Strings.Home.botFaceCreditLead,
            color: color,
            lineBreakMode: .byTruncatingTail
        ))
        var link = style.attributes(color: color, lineBreakMode: .byTruncatingTail)
        link[.underlineStyle] = NSUnderlineStyle.single.rawValue
        text.append(NSAttributedString(string: BotFaceStyle.adventurerNeutralCredit.artist, attributes: link))
        credit.attributedText = text
    }

    /// The words the layout measures.
    var text: BotFacePickerLayout.Text {
        BotFacePickerLayout.Text(heading: heading.measurable, credit: credit.measurable, creditLead: creditLead.measurable)
    }

    /// The words at heights made off the main thread (`HomeDockText`):
    /// "Avatar" and the credit are one line each.
    func text(headingLine: CGFloat, creditLine: CGFloat) -> BotFacePickerLayout.Text {
        BotFacePickerLayout.Text(
            heading: HomeDockText.line(heading, headingLine),
            credit: HomeDockText.line(credit, creditLine),
            creditLead: creditLead.measurable
        )
    }

    /// The picker's frames, in its own space.
    func apply(_ layout: BotFacePickerLayout) {
        guard layout != localLayout else { return }
        localLayout = layout
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let layout = localLayout else { return }
        heading.setLayoutFrame(layout.heading)
        let scale = window?.screen.scale ?? traitCollection.displayScale
        for (face, frame) in zip(faces, layout.faces) {
            face.setLayoutFrame(frame)
            if face.index < seeds.count { face.show(seed: seeds[face.index], scale: max(1, scale)) }
        }
        die.setLayoutFrame(layout.die)
        credit.setLayoutFrame(layout.credit)
        creditLink.frame = layout.creditLink
    }
}

/// One face on offer: the picture inside a ring that shows once it's
/// picked. The ring is always there, so picking moves nothing.
final class BotFaceButton: UIControl {
    let index: Int
    private let imageView = UIImageView()
    private var shown: (seed: String, pixels: CGFloat)?
    private var render: Task<Void, Never>?

    var isPicked = false {
        didSet {
            guard isPicked != oldValue else { return }
            applyRing()
            accessibilityTraits = isPicked ? [.button, .selected] : .button
        }
    }

    init(index: Int) {
        self.index = index
        super.init(frame: .zero)
        layer.cornerRadius = BotFacePickerLayout.Metrics.faceRadius
        layer.borderWidth = BotFacePickerLayout.Metrics.ringWidth
        imageView.isUserInteractionEnabled = false
        imageView.clipsToBounds = true
        imageView.layer.cornerRadius = BotFacePickerLayout.Metrics.imageRadius
        imageView.contentMode = .scaleToFill
        addSubview(imageView)
        isAccessibilityElement = true
        accessibilityLabel = Strings.Home.botFaceLabel(index)
        accessibilityTraits = .button
        applyRing()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.applyRing() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        render?.cancel()
    }

    private func applyRing() {
        layer.borderColor = isPicked ? UIColor(Palette.text).resolvedColor(with: traitCollection).cgColor : UIColor.clear.cgColor
    }

    /// Paints `seed` at the picture's size, keeping the last face until the
    /// new one is ready.
    func show(seed: String, scale: CGFloat) {
        let side = max(0, bounds.width - 2 * BotFacePickerLayout.Metrics.ringWidth)
        let pixels = (side * scale).rounded(.up)
        guard side > 0, shown?.seed != seed || shown?.pixels != pixels else { return }
        shown = (seed, pixels)
        render?.cancel()
        render = Task { [weak self] in
            let image = await BotFacePainter.image(seed: seed, side: side, scale: scale)
            guard !Task.isCancelled, let self, self.shown?.seed == seed, self.shown?.pixels == pixels else { return }
            self.imageView.image = image
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let ring = BotFacePickerLayout.Metrics.ringWidth
        imageView.frame = bounds.insetBy(dx: ring, dy: ring)
    }
}

/// The die beside the faces: rolls four new ones. Round, with the glass
/// wash behind it while pressed.
final class BotFaceDieButton: UIControl {
    private let iconView = IconView(.ionicons("dice-outline"), size: BotFacePickerLayout.Metrics.dieIconSize, tint: Palette.text)

    override init(frame: CGRect) {
        super.init(frame: frame)
        addSubview(iconView)
        isAccessibilityElement = true
        accessibilityLabel = Strings.Home.rollBotFaces
        accessibilityTraits = .button
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override var isHighlighted: Bool {
        didSet {
            // theme.colors.glass.backgroundSubtle.
            backgroundColor = isHighlighted ? UIColor(Palette.optionSelected) : nil
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = bounds.height / 2
        iconView.frame = bounds
    }
}

/// One line over the open composer that reveals in turn and refuses
/// presses while a session starts (`FocusConfigRevealRow`): a press
/// anywhere on it shakes it. A line over the backdrop lets the backdrop
/// have every touch its controls don't take (`box-none`).
final class HomeDockRevealLineView: UIView {
    let blocker = UIControl()
    private let passesThrough: Bool

    init(passesThrough: Bool) {
        self.passesThrough = passesThrough
        super.init(frame: .zero)
        blocker.isHidden = true
        addSubview(blocker)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    var refusing = false {
        didSet { blocker.isHidden = !refusing }
    }

    /// Keeps the blocker over whatever is added.
    override func didAddSubview(_ subview: UIView) {
        super.didAddSubview(subview)
        if subview !== blocker { bringSubviewToFront(blocker) }
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return passesThrough && hit === self ? nil : hit
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        blocker.frame = bounds
    }
}
#endif
