#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// The shutter: a white ring around a white disc, after Telegram's
/// (`CaptureControlsComponent`'s `ShutterButtonContentComponent`). A press
/// shrinks the disc to 0.8 over 0.3 s and lets it back on release.
final class CameraShutterButton: UIControl {
    private let ring = CAShapeLayer()
    private let disc = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        ring.fillColor = nil
        ring.strokeColor = UIColor(Palette.cameraShutter).cgColor
        ring.lineWidth = CameraScreenLayout.Metrics.shutterRingWidth
        layer.addSublayer(ring)
        disc.backgroundColor = UIColor(Palette.cameraShutter)
        disc.isUserInteractionEnabled = false
        addSubview(disc)
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityLabel = Strings.Camera.shutter
        accessibilityIdentifier = "camera-shutter"
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var isHighlighted: Bool {
        didSet {
            guard isHighlighted != oldValue else { return }
            let scale: CGFloat = isHighlighted ? 0.8 : 1
            UIView.animate(withDuration: 0.3, delay: 0, options: [.curveEaseInOut, .beginFromCurrentState, .allowUserInteraction]) {
                self.disc.transform = CGAffineTransform(scaleX: scale, y: scale)
            }
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let ringFrame = CameraScreenLayout.shutterRing(in: bounds)
        let inset = CameraScreenLayout.Metrics.shutterRingWidth / 2
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ring.frame = bounds
        ring.path = UIBezierPath(ovalIn: ringFrame.insetBy(dx: inset, dy: inset)).cgPath
        CATransaction.commit()
        let transform = disc.transform
        disc.transform = .identity
        disc.frame = CameraScreenLayout.shutterDisc(in: bounds)
        disc.layer.cornerRadius = disc.bounds.width / 2
        disc.transform = transform
    }
}

/// A round button over the picture: a glyph, or a word ("4:3"), white,
/// yellow while what it switches is on. It turns with the device.
final class CameraIconButton: UIControl {
    private let glyph: IconView
    private let word = StyledLabel(style: TextStyles.cameraButton, color: Palette.cameraControl, lines: 1, alignment: .center)
    private let content = UIView()

    init(identifier: String, glyphSize: CGFloat = 22) {
        glyph = IconView(size: glyphSize, tint: Palette.cameraControl)
        super.init(frame: .zero)
        content.isUserInteractionEnabled = false
        addSubview(content)
        content.addSubview(glyph)
        content.addSubview(word)
        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityIdentifier = identifier
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Shows `icon`, or `text` where there is no icon; `active` in yellow.
    func show(icon: Icon?, text: String? = nil, active: Bool = false) {
        let tint = active ? Palette.cameraActive : Palette.cameraControl
        glyph.icon = icon
        glyph.tintColor = UIColor(tint)
        glyph.isHidden = icon == nil
        word.string = text ?? ""
        word.color = tint
        word.isHidden = icon != nil || text == nil
        setNeedsLayout()
    }

    /// The device's turn, so the glyph reads upright.
    var rotation: CGFloat = 0 {
        didSet { content.transform = CGAffineTransform(rotationAngle: rotation) }
    }

    override var isHighlighted: Bool {
        didSet { content.alpha = isHighlighted ? 0.5 : 1 }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let transform = content.transform
        content.transform = .identity
        content.frame = bounds
        content.transform = transform
        let box = CGRect(origin: .zero, size: bounds.size)
        // The icon centres itself on RN's pixels in what it is given.
        glyph.frame = box
        word.frame = CameraScreenLayout.centred(word.sizeThatFits(bounds.size), in: box)
    }
}

/// The lens buttons, Telegram's `ZoomComponent`: discs on a capsule, the
/// lens in use in yellow at its full size with the zoom as it stands
/// ("1.4×"), the others at 0.7 with their own number.
final class CameraZoomBar: UIView {
    var onSelect: ((Int) -> Void)?
    private let capsule = UIView()
    private var items: [UIButton] = []
    private var shown: [String] = []
    private var selected = -1

    override init(frame: CGRect) {
        super.init(frame: frame)
        capsule.backgroundColor = UIColor(Palette.cameraLensBar)
        capsule.isUserInteractionEnabled = false
        addSubview(capsule)
        accessibilityIdentifier = "camera-lenses"
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    var rotation: CGFloat = 0 {
        didSet { if rotation != oldValue { applyTransforms() } }
    }

    /// The lenses' labels, the one in use, and their frames in the bar.
    func update(labels: [String], selected: Int, frames: [CGRect], animated: Bool) {
        while items.count < labels.count {
            let item = UIButton(type: .custom)
            let index = items.count
            item.backgroundColor = UIColor(Palette.cameraLens)
            item.addAction(UIAction { [weak self] _ in self?.onSelect?(index) }, for: .touchUpInside)
            addSubview(item)
            items.append(item)
        }
        while items.count > labels.count { items.removeLast().removeFromSuperview() }
        let changed = selected != self.selected
        self.selected = selected
        for (index, item) in items.enumerated() {
            let on = index == selected
            item.setAttributedTitle(TextStyles.cameraLens.attributedString(labels[index], color: UIColor(on ? Palette.cameraActive : Palette.cameraControl), alignment: .center), for: .normal)
            item.accessibilityLabel = Strings.Camera.lens(labels[index])
            item.accessibilityTraits = on ? [.button, .selected] : .button
            item.accessibilityIdentifier = "camera-lens-\(index)"
            let transform = item.transform
            item.transform = .identity
            item.frame = frames[index]
            item.layer.cornerRadius = frames[index].height / 2
            item.transform = transform
        }
        shown = labels
        capsule.frame = bounds
        capsule.layer.cornerRadius = bounds.height / 2
        if changed, animated {
            UIView.animate(withDuration: 0.2, delay: 0, options: [.curveEaseInOut, .beginFromCurrentState, .allowUserInteraction]) { self.applyTransforms() }
        } else {
            applyTransforms()
        }
    }

    private func applyTransforms() {
        for (index, item) in items.enumerated() {
            let scale: CGFloat = index == selected ? 1 : 0.7
            item.transform = CGAffineTransform(rotationAngle: rotation).scaledBy(x: scale, y: scale)
        }
    }
}

/// The system camera's focus square and the exposure slider beside it,
/// with Telegram's motion (`TGCameraFocusCrosshairsControl`): the square
/// in from twice its size over 0.15 s, blinking for a second, then dimmed
/// to half and gone a while after; a lock holds it bright. It covers the
/// picture and places its parts where the layout says.
final class CameraFocusView: UIView {
    let square = UIView()
    let track = UIView()
    let sun = IconView(.ionicons("sunny"), size: 22, tint: Palette.cameraFocus)
    private var generation = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        square.layer.borderColor = UIColor(Palette.cameraFocus).cgColor
        square.layer.borderWidth = 1
        track.backgroundColor = UIColor(Palette.cameraFocus)
        for view in [square, track, sun] as [UIView] { addSubview(view) }
        alpha = 0
        accessibilityIdentifier = "camera-focus"
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func place(square frame: CGRect, track: CGRect, sun: CGRect) {
        let transform = square.transform
        square.transform = .identity
        square.frame = frame
        square.transform = transform
        self.track.frame = track
        self.sun.frame = sun
    }

    /// Shows the square where it now stands.
    func play(locked: Bool) {
        generation += 1
        let generation = generation
        layer.removeAllAnimations()
        square.layer.removeAllAnimations()
        alpha = 1
        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 2
        scale.toValue = 1
        scale.duration = 0.15
        square.layer.add(scale, forKey: "scale")
        let blink = CAKeyframeAnimation(keyPath: "opacity")
        blink.values = [0.6, 1, 0.6, 1, 0.6, 1]
        blink.keyTimes = [0, 0.2, 0.4, 0.6, 0.8, 1]
        blink.duration = 1
        square.layer.add(blink, forKey: "blink")
        guard !locked else { return }
        rest(generation)
    }

    /// Bright while the exposure is dragged, resting again after.
    func wake(locked: Bool) {
        generation += 1
        layer.removeAllAnimations()
        alpha = 1
        if !locked { rest(generation) }
    }

    func hide() {
        generation += 1
        UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState]) { self.alpha = 0 }
    }

    var isShowing: Bool { alpha > 0.01 }

    private func rest(_ generation: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.9) { [weak self] in
            guard let self, self.generation == generation else { return }
            UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) { self.alpha = 0.5 }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self, self.generation == generation else { return }
                self.hide()
            }
        }
    }
}
#endif
