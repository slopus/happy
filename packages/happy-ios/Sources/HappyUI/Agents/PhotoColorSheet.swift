#if canImport(UIKit)
import HappyLayout
import UIKit

/// Telegram's colour sheet (`ColorPickerScreen`), dark: close, "Colors"
/// and the eyedropper at the top; the grid or the spectrum; the opacity;
/// the colour as it is beside five swatches. Every change is the
/// brush's at once.
final class PhotoColorSheet: UIViewController {
    var onColor: ((RGBA) -> Void)?
    var onEyedropper: (() -> Void)?
    private(set) var color: RGBA
    /// Where on the spectrum the colour was picked, for its knob.
    private var spectrumPoint: CGPoint?

    private let close = PhotoEditorButton(.symbol("xmark"), identifier: "photo-color-close", label: Strings.PhotoEditor.close)
    private let eyedropper = PhotoEditorButton(.symbol("eyedropper"), identifier: "photo-color-eyedropper", label: Strings.PhotoEditor.eyedropper)
    private let heading = UILabel()
    private let modes = UISegmentedControl(items: [Strings.PhotoEditor.grid, Strings.PhotoEditor.spectrum])
    private let grid = PhotoColorGrid()
    private let spectrum = PhotoSpectrum()
    private let opacityTitle = UILabel()
    private let opacity = PhotoOpacitySlider()
    private let opacityField = UILabel()
    private let rule = UIView()
    private let preview = PhotoColorPreview()
    private var swatches: [PhotoSwatch] = []

    init(color: RGBA) {
        self.color = color
        super.init(nibName: nil, bundle: nil)
        overrideUserInterfaceStyle = .dark
        modalPresentationStyle = .pageSheet
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "photo-color"
        view.backgroundColor = UIColor(white: 0.11, alpha: 1)
        close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        eyedropper.addTarget(self, action: #selector(eyedropperTapped), for: .touchUpInside)
        heading.text = Strings.PhotoEditor.colors
        heading.font = .systemFont(ofSize: 17, weight: .semibold)
        heading.textColor = UIColor(Palette.photoEditorControl)
        modes.selectedSegmentIndex = 0
        modes.accessibilityIdentifier = "photo-color-mode"
        modes.addTarget(self, action: #selector(modeChanged), for: .valueChanged)
        grid.accessibilityIdentifier = "photo-color-grid"
        grid.onPick = { [weak self] picked in self?.pick(picked, at: nil) }
        spectrum.accessibilityIdentifier = "photo-color-spectrum"
        spectrum.isHidden = true
        spectrum.onPick = { [weak self] picked, point in self?.pick(picked, at: point) }
        opacityTitle.text = Strings.PhotoEditor.opacity
        opacityTitle.font = .systemFont(ofSize: 13, weight: .semibold)
        opacityTitle.textColor = UIColor(Palette.photoEditorCaption)
        opacity.accessibilityIdentifier = "photo-color-opacity"
        opacity.onChange = { [weak self] alpha in self?.setAlpha(alpha) }
        opacityField.font = .monospacedDigitSystemFont(ofSize: 17, weight: .regular)
        opacityField.textColor = UIColor(Palette.photoEditorControl)
        opacityField.textAlignment = .center
        opacityField.backgroundColor = UIColor(Palette.photoEditorField)
        opacityField.layer.cornerRadius = 9
        opacityField.clipsToBounds = true
        rule.backgroundColor = UIColor(Palette.photoEditorRule)
        for (index, swatch) in PhotoTools.sheetSwatches.enumerated() {
            let view = PhotoSwatch(color: swatch)
            view.accessibilityIdentifier = "photo-color-swatch:\(index)"
            view.addTarget(self, action: #selector(swatchTapped(_:)), for: .touchUpInside)
            swatches.append(view)
        }
        for subview in [close, eyedropper, heading, modes, grid, spectrum, opacityTitle, opacity, opacityField, rule, preview] + swatches { view.addSubview(subview) }
        show()
    }

    /// As tall as its rows at `width`.
    static func height(width: CGFloat) -> CGFloat {
        let square = floor((width - 32) / CGFloat(PhotoTools.gridColumns))
        return 76 + 32 + 16 + square * CGFloat(PhotoTools.gridRows) + 24 + 16 + 8 + 36 + 24 + 1 + 22 + 82 + 16
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width, side: CGFloat = 16
        close.frame = CGRect(x: side, y: 16, width: 44, height: 44)
        eyedropper.frame = CGRect(x: width - side - 44, y: 16, width: 44, height: 44)
        heading.sizeToFit()
        heading.center = CGPoint(x: width / 2, y: 38)
        modes.frame = CGRect(x: side, y: 76, width: width - side * 2, height: 32)
        let square = floor((width - side * 2) / CGFloat(PhotoTools.gridColumns))
        let field = CGRect(x: (width - square * CGFloat(PhotoTools.gridColumns)) / 2, y: modes.frame.maxY + 16, width: square * CGFloat(PhotoTools.gridColumns), height: square * CGFloat(PhotoTools.gridRows))
        grid.frame = field
        spectrum.frame = field
        var y = field.maxY + 24
        opacityTitle.sizeToFit()
        opacityTitle.frame.origin = CGPoint(x: side + 5, y: y)
        y = opacityTitle.frame.maxY + 8
        opacity.frame = CGRect(x: side, y: y, width: width - side * 2 - 89, height: 36)
        opacityField.frame = CGRect(x: width - side - 77, y: y, width: 77, height: 36)
        y += 36 + 24
        rule.frame = CGRect(x: side, y: y, width: width - side * 2, height: 1)
        y += 1 + 22
        preview.frame = CGRect(x: side, y: y, width: 82, height: 82)
        var x = preview.frame.maxX + 38
        for swatch in swatches {
            swatch.frame = CGRect(x: x - 6, y: y + 26 - 6, width: 42, height: 42)
            x += 30 + 20
        }
    }

    /// Sized to its rows on a screen `width` across; before it is presented.
    func fit(width: CGFloat) {
        let height = Self.height(width: width)
        sheetPresentationController?.prefersGrabberVisible = false
        sheetPresentationController?.detents = [.custom(identifier: .init("colors")) { context in min(context.maximumDetentValue, height) }]
    }

    private func show() {
        grid.selected = color
        spectrum.point = spectrumPoint
        spectrum.color = color
        opacity.color = color
        opacityField.text = "\(Int((color.alpha * 100).rounded()))%"
        preview.color = color
        for swatch in swatches { swatch.chosen = PhotoTools.sameHue(swatch.color, color) }
    }

    /// A colour picked keeps the opacity chosen (`keepAlpha`).
    private func pick(_ picked: RGBA, at point: CGPoint?) {
        var next = picked
        next.alpha = color.alpha
        spectrumPoint = point
        color = next
        show()
        onColor?(next)
    }

    private func setAlpha(_ alpha: Double) {
        color.alpha = alpha
        show()
        onColor?(color)
    }

    @objc private func modeChanged() {
        grid.isHidden = modes.selectedSegmentIndex != 0
        spectrum.isHidden = modes.selectedSegmentIndex != 1
    }

    @objc private func swatchTapped(_ swatch: PhotoSwatch) { pick(swatch.color, at: nil) }
    @objc private func closeTapped() { dismiss(animated: true) }
    @objc private func eyedropperTapped() { onEyedropper?() }
}

/// Telegram's grid of 120 colours: a touch picks the square under it and
/// a drag keeps picking; the chosen square ringed.
final class PhotoColorGrid: UIView {
    var onPick: ((RGBA) -> Void)?
    var selected: RGBA? { didSet { setNeedsLayout() } }
    private let picture = UIImageView()
    private let ring = CAShapeLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        picture.layer.cornerRadius = 10
        picture.clipsToBounds = true
        addSubview(picture)
        ring.fillColor = nil
        ring.lineWidth = 3
        ring.shadowColor = UIColor.black.cgColor
        ring.shadowOpacity = 0.15
        ring.shadowRadius = 4.5
        ring.shadowOffset = .zero
        layer.addSublayer(ring)
        let press = UILongPressGestureRecognizer(target: self, action: #selector(pressed(_:)))
        press.minimumPressDuration = 0.01
        press.allowableMovement = .greatestFiniteMagnitude
        addGestureRecognizer(press)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private var square: CGFloat { bounds.width / CGFloat(PhotoTools.gridColumns) }

    override func layoutSubviews() {
        super.layoutSubviews()
        picture.frame = bounds
        if picture.image?.size != bounds.size, bounds.width > 0 {
            let square = square
            picture.image = UIGraphicsImageRenderer(size: bounds.size).image { _ in
                for (index, color) in PhotoTools.grid.enumerated() {
                    UIColor(color).setFill()
                    UIRectFill(CGRect(x: CGFloat(index % PhotoTools.gridColumns) * square, y: CGFloat(index / PhotoTools.gridColumns) * square, width: square + 0.5, height: square + 0.5))
                }
            }
        }
        guard let selected, let index = PhotoTools.grid.firstIndex(where: { PhotoTools.sameHue($0, selected) }) else {
            ring.path = nil
            return
        }
        let cell = CGRect(x: CGFloat(index % PhotoTools.gridColumns) * square, y: CGFloat(index / PhotoTools.gridColumns) * square, width: square, height: square)
        ring.path = UIBezierPath(roundedRect: cell, cornerRadius: 4).cgPath
        let light = selected.red * 0.2126 + selected.green * 0.7152 + selected.blue * 0.0722 > 0.75
        ring.strokeColor = (light ? UIColor(Palette.photoEditorKnob) : UIColor.white).cgColor
    }

    @objc private func pressed(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began || recognizer.state == .changed else { return }
        let point = recognizer.location(in: self)
        let column = min(max(Int(point.x / square), 0), PhotoTools.gridColumns - 1)
        let row = min(max(Int(point.y / square), 0), PhotoTools.gridRows - 1)
        let color = PhotoTools.grid[row * PhotoTools.gridColumns + column]
        if selected.map({ !PhotoTools.sameHue($0, color) }) ?? true { onPick?(color) }
    }
}

/// The spectrum: the hues across, white over them at the top and black
/// at the bottom; a knob where the colour was picked.
final class PhotoSpectrum: UIView {
    var onPick: ((RGBA, CGPoint) -> Void)?
    var point: CGPoint? { didSet { setNeedsLayout() } }
    var color: RGBA = .white { didSet { setNeedsLayout() } }
    private let picture = UIImageView()
    private let knob = UIView()
    private let dot = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        picture.layer.cornerRadius = 10
        picture.clipsToBounds = true
        addSubview(picture)
        knob.bounds = CGRect(x: 0, y: 0, width: 32, height: 32)
        knob.layer.cornerRadius = 16
        knob.backgroundColor = UIColor(Palette.photoEditorKnob)
        knob.layer.shadowColor = UIColor.black.cgColor
        knob.layer.shadowOpacity = 0.3
        knob.layer.shadowRadius = 4.5
        knob.layer.shadowOffset = .zero
        dot.bounds = CGRect(x: 0, y: 0, width: 26, height: 26)
        dot.layer.cornerRadius = 13
        knob.addSubview(dot)
        dot.center = CGPoint(x: 16, y: 16)
        addSubview(knob)
        let press = UILongPressGestureRecognizer(target: self, action: #selector(pressed(_:)))
        press.minimumPressDuration = 0.01
        press.allowableMovement = .greatestFiniteMagnitude
        addGestureRecognizer(press)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        picture.frame = bounds
        if picture.image?.size != bounds.size, bounds.width > 0 {
            let width = Int(bounds.width), height = Int(bounds.height)
            picture.image = UIGraphicsImageRenderer(size: bounds.size).image { _ in
                for y in stride(from: 0, to: height, by: 2) {
                    for x in stride(from: 0, to: width, by: 2) {
                        UIColor(PhotoTools.spectrum(at: CGPoint(x: CGFloat(x) / CGFloat(width), y: CGFloat(y) / CGFloat(height)))).setFill()
                        UIRectFill(CGRect(x: x, y: y, width: 2, height: 2))
                    }
                }
            }
        }
        knob.isHidden = point == nil
        if let point { knob.center = CGPoint(x: point.x * bounds.width, y: point.y * bounds.height) }
        var solid = color
        solid.alpha = 1
        dot.backgroundColor = UIColor(solid)
    }

    @objc private func pressed(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began || recognizer.state == .changed, bounds.width > 0 else { return }
        let location = recognizer.location(in: self)
        let point = CGPoint(x: min(max(location.x / bounds.width, 0), 1), y: min(max(location.y / bounds.height, 0), 1))
        onPick?(PhotoTools.spectrum(at: point), point)
    }
}

/// The opacity: checks under the colour fading in from clear, a knob at
/// how opaque it is.
final class PhotoOpacitySlider: UIView {
    var onChange: ((Double) -> Void)?
    var color: RGBA = .white { didSet { setNeedsLayout() } }
    private let checks = UIImageView()
    private let gradient = CAGradientLayer()
    private let knob = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isAccessibilityElement = true
        accessibilityLabel = Strings.PhotoEditor.opacity
        accessibilityTraits = .adjustable
        checks.layer.cornerRadius = 18
        checks.clipsToBounds = true
        addSubview(checks)
        gradient.startPoint = CGPoint(x: 0, y: 0.5)
        gradient.endPoint = CGPoint(x: 1, y: 0.5)
        gradient.cornerRadius = 18
        layer.addSublayer(gradient)
        knob.bounds = CGRect(x: 0, y: 0, width: 32, height: 32)
        knob.layer.cornerRadius = 16
        knob.layer.borderWidth = 3
        knob.layer.borderColor = UIColor.white.cgColor
        knob.layer.shadowColor = UIColor.black.cgColor
        knob.layer.shadowOpacity = 0.3
        knob.layer.shadowRadius = 4.5
        knob.layer.shadowOffset = .zero
        addSubview(knob)
        let press = UILongPressGestureRecognizer(target: self, action: #selector(pressed(_:)))
        press.minimumPressDuration = 0.01
        press.allowableMovement = .greatestFiniteMagnitude
        addGestureRecognizer(press)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        checks.frame = bounds
        if checks.image?.size != bounds.size, bounds.width > 0 {
            checks.image = UIGraphicsImageRenderer(size: bounds.size).image { _ in
                UIColor(white: 0.25, alpha: 1).setFill()
                UIRectFill(CGRect(origin: .zero, size: bounds.size))
                UIColor.white.setFill()
                for i in 0..<Int(ceil(bounds.width / 12)) {
                    for j in 0..<Int(ceil(bounds.height / 12)) where (i + j) % 2 == 1 {
                        UIRectFill(CGRect(x: CGFloat(i) * 12, y: CGFloat(j) * 12, width: 12, height: 12))
                    }
                }
            }
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        gradient.frame = bounds
        var solid = color
        solid.alpha = 1
        gradient.colors = [UIColor(solid).withAlphaComponent(0).cgColor, UIColor(solid).cgColor]
        CATransaction.commit()
        knob.backgroundColor = UIColor(color)
        knob.center = CGPoint(x: 18 + (bounds.width - 36) * CGFloat(color.alpha), y: bounds.midY)
        accessibilityValue = "\(Int((color.alpha * 100).rounded()))%"
    }

    @objc private func pressed(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began || recognizer.state == .changed, bounds.width > 36 else { return }
        let value = (recognizer.location(in: self).x - 18) / (bounds.width - 36)
        onChange?(Double(min(max(value, 0), 1)))
    }

    override func accessibilityIncrement() { onChange?(min(1, color.alpha + 0.1)) }
    override func accessibilityDecrement() { onChange?(max(0, color.alpha - 0.1)) }
}

/// The colour as it is, over checks so its opacity shows.
final class PhotoColorPreview: UIView {
    var color: RGBA = .white { didSet { fill.backgroundColor = UIColor(color) } }
    private let checks = UIImageView()
    private let fill = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.cornerRadius = 12
        clipsToBounds = true
        addSubview(checks)
        addSubview(fill)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        checks.frame = bounds
        fill.frame = bounds
        if checks.image?.size != bounds.size, bounds.width > 0 {
            checks.image = UIGraphicsImageRenderer(size: bounds.size).image { _ in
                UIColor(white: 0.25, alpha: 1).setFill()
                UIRectFill(CGRect(origin: .zero, size: bounds.size))
                UIColor.white.setFill()
                for i in 0..<Int(ceil(bounds.width / 12)) {
                    for j in 0..<Int(ceil(bounds.height / 12)) where (i + j) % 2 == 1 {
                        UIRectFill(CGRect(x: CGFloat(i) * 12, y: CGFloat(j) * 12, width: 12, height: 12))
                    }
                }
            }
        }
    }
}
#endif
