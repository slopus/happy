#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Typing a text overlay, as Telegram's text tool: the canvas dims and the
/// text is typed on it, drawn as it will be posted; Cancel and Done over
/// the top; the size slider at the left edge; and on the keyboard's bar the
/// colour wheel, the fill, the alignment and the font. Done hands back the
/// text, its style and its size.
final class StoryTextEntryView: UIView, UITextViewDelegate, UIColorPickerViewControllerDelegate {
    var onDone: ((String, StoryTextStyle, Double) -> Void)?
    var onCancel: (() -> Void)?
    /// Presents the colour picker over the editor.
    var present: ((UIViewController) -> Void)?

    private let fade = UIControl()
    private let stage = UIView()
    private let preview: StoryTextOverlayView
    private let text = UITextView(usingTextLayoutManager: false)
    private let cancel = UIButton(type: .system)
    private let done = UIButton(type: .system)
    private let slider = StoryTextSizeSlider()
    private let bar = StoryTextBar()
    private(set) var style: StoryTextStyle
    private(set) var scale: Double
    /// The canvas, in this view, and its corners.
    private let canvas: CGRect
    private var keyboard: CGFloat = 0

    init(text initial: String, style: StoryTextStyle, scale: Double, canvas: CGRect, cornerRadius: CGFloat) {
        self.style = style
        self.scale = scale
        self.canvas = canvas
        preview = StoryTextOverlayView(.text(id: "entry", text: initial, style: style, transform: StoryTransform(x: 0.5, y: 0.5, scale: scale, rotation: 0)))
        super.init(frame: .zero)
        accessibilityIdentifier = "story-text-entry"
        fade.backgroundColor = UIColor(white: 0, alpha: 0.4)
        fade.layer.cornerRadius = cornerRadius
        fade.layer.cornerCurve = .continuous
        fade.addAction(UIAction { [weak self] _ in self?.finish() }, for: .touchUpInside)
        addSubview(fade)
        stage.clipsToBounds = true
        stage.layer.cornerRadius = cornerRadius
        stage.layer.cornerCurve = .continuous
        addSubview(stage)
        stage.addSubview(preview)
        text.backgroundColor = .clear
        text.isScrollEnabled = false
        text.textContainerInset = .zero
        text.textContainer.lineFragmentPadding = 0
        text.delegate = self
        text.text = initial
        text.keyboardAppearance = .dark
        text.tintColor = .white
        text.autocorrectionType = .default
        text.inputAccessoryView = bar
        text.accessibilityIdentifier = "story-text-field"
        preview.addSubview(text)
        for (button, title, id) in [(cancel, Strings.Stories.cancel, "story-text-cancel"), (done, Strings.Stories.done, "story-text-done")] {
            button.setTitle(title, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 17)
            button.tintColor = .white
            button.accessibilityIdentifier = id
            addSubview(button)
        }
        cancel.addAction(UIAction { [weak self] _ in self?.dismissEntry() }, for: .touchUpInside)
        done.addAction(UIAction { [weak self] _ in self?.finish() }, for: .touchUpInside)
        slider.value = StoryTextEntryLayout.slider(scale: CGFloat(scale))
        slider.onChange = { [weak self] value in self?.resize(value) }
        addSubview(slider)
        bar.onColor = { [weak self] in self?.chooseColor() }
        bar.onStyle = { [weak self] in self?.nextFill() }
        bar.onAlign = { [weak self] in self?.nextAlign() }
        bar.onFont = { [weak self] font in self?.choose(font) }
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        center.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
        apply()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func begin() { text.becomeFirstResponder() }

    @objc private func keyboardChanged(_ note: Notification) {
        guard let window, let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let local = convert(window.convert(end, from: nil), from: window)
        keyboard = note.name == UIResponder.keyboardWillHideNotification ? 0 : max(0, bounds.maxY - local.minY)
        setNeedsLayout()
        UIView.animate(withDuration: 0.25) { self.layoutIfNeeded() }
    }

    // MARK: Style

    /// Telegram's style button: plain, filled, half, and round again.
    private func nextFill() {
        style.fill = switch style.fill {
        case .regular: .filled
        case .filled: .semi
        case .semi, .stroke, .blur: .regular
        }
        apply()
    }

    private func nextAlign() {
        let all = StoryTextAlign.allCases
        style.align = all[((all.firstIndex(of: style.align) ?? 0) + 1) % all.count]
        apply()
    }

    private func choose(_ font: StoryTextFont) {
        style.font = font
        apply()
    }

    private func chooseColor() {
        let picker = UIColorPickerViewController()
        picker.supportsAlpha = false
        picker.selectedColor = UIColor(hex: style.color) ?? .white
        picker.delegate = self
        picker.overrideUserInterfaceStyle = .dark
        present?(picker)
    }

    nonisolated func colorPickerViewController(_ viewController: UIColorPickerViewController, didSelect color: UIColor, continuously: Bool) {
        MainActor.assumeIsolated {
            style.color = Self.hex(color)
            apply()
        }
    }

    nonisolated func colorPickerViewControllerDidFinish(_ viewController: UIColorPickerViewController) {
        MainActor.assumeIsolated {
            text.becomeFirstResponder()
        }
    }

    static func hex(_ color: UIColor) -> String {
        var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        func byte(_ value: CGFloat) -> Int { Int((min(1, max(0, value)) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", byte(r), byte(g), byte(b))
    }

    /// The slider sets the font; the text keeps wrapping at 90% of the
    /// canvas, as Telegram's does, so a larger size wraps sooner.
    private func resize(_ value: CGFloat) {
        scale = Self.rounded(Double(StoryTextEntryLayout.scale(slider: value)))
        style.width = Self.width(scale: scale)
        apply()
    }

    static func width(scale: Double) -> Double {
        rounded(min(1, max(0.1, StoryTextEntryLayout.Metrics.newWidth / max(0.05, scale))))
    }

    private static func rounded(_ value: Double) -> Double { (value * 1000).rounded() / 1000 }

    /// A new look: the caret's text view takes the font and paragraph, and
    /// the text is drawn again.
    private func apply() {
        var attributes = StoryTextOverlayView.attributes(style, canvas: canvas.size, inked: false)
        // The overlay under it draws the letters; this one only holds the caret.
        attributes[.foregroundColor] = UIColor.clear
        if text.markedTextRange == nil {
            let selection = text.selectedRange
            text.attributedText = NSAttributedString(string: text.text ?? "", attributes: attributes)
            text.selectedRange = selection
        }
        text.typingAttributes = attributes
        bar.show(style)
        slider.accessibilityValue = String(format: "%.2f", scale)
        redraw()
    }

    private func redraw() {
        _ = preview.update(.text(id: "entry", text: text.text ?? "", style: style, transform: StoryTransform(x: 0.5, y: 0.5, scale: scale, rotation: 0)))
        setNeedsLayout()
    }

    func textViewDidChange(_ textView: UITextView) {
        // An unfinished composition (a keyboard's marked text) is left to finish first.
        if textView.markedTextRange == nil, textView.text.count > 2_048 {
            textView.text = String(textView.text.prefix(2_048))
            apply()
            return
        }
        redraw()
    }

    private func finish() {
        text.resignFirstResponder()
        onDone?(text.text ?? "", style, scale)
    }

    private func dismissEntry() {
        text.resignFirstResponder()
        onCancel?()
    }

    // MARK: Layout

    override func layoutSubviews() {
        super.layoutSubviews()
        let statusBar = window?.windowScene?.statusBarManager?.statusBarFrame.height ?? safeAreaInsets.top
        let layout = StoryTextEntryLayout(
            bounds: bounds, statusBar: statusBar, safeTop: safeAreaInsets.top, safeBottom: safeAreaInsets.bottom, keyboard: keyboard,
            cancelWidth: cancel.intrinsicContentSize.width, doneWidth: done.intrinsicContentSize.width
        )
        fade.frame = canvas
        stage.frame = canvas
        cancel.frame = layout.cancel
        done.frame = layout.done
        slider.frame = layout.slider
        preview.place(canvas: canvas.size)
        if let frame = preview.textFrame(canvas: canvas.size) {
            // Tall enough for the caret on an empty line.
            let line = (StoryTextOverlayView.attributes(style, canvas: canvas.size)[.font] as? UIFont)?.lineHeight ?? 0
            text.frame = CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: max(frame.height, ceil(line)))
        }
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        // Over the canvas the typed text takes touches; the rest of the dim ends typing.
        let hit = super.hitTest(point, with: event)
        if hit === stage { return fade }
        return hit === preview ? text : hit
    }
}

/// The text size slider at the canvas's left edge: a tapering track half
/// out of view until held, and a knob riding it.
final class StoryTextSizeSlider: UIView {
    var onChange: ((CGFloat) -> Void)?
    var value: CGFloat = 0.5 { didSet { setNeedsLayout() } }
    private let track = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
    private let tint = UIView()
    private let shape = CAShapeLayer()
    private let knob = UIView()
    private var tracking = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        isExclusiveTouch = true
        tint.backgroundColor = UIColor(white: 0.53, alpha: 0.3)
        track.contentView.addSubview(tint)
        track.layer.mask = shape
        track.isUserInteractionEnabled = false
        addSubview(track)
        knob.backgroundColor = .white
        knob.layer.cornerRadius = 16
        knob.layer.shadowColor = UIColor.black.cgColor
        knob.layer.shadowOpacity = 0.3
        knob.layer.shadowRadius = 4.5
        knob.layer.shadowOffset = .zero
        knob.isUserInteractionEnabled = false
        addSubview(knob)
        let press = UILongPressGestureRecognizer(target: self, action: #selector(dragged(_:)))
        press.minimumPressDuration = 0.01
        addGestureRecognizer(press)
        isAccessibilityElement = true
        accessibilityLabel = Strings.Stories.textSize
        accessibilityIdentifier = "story-text-size"
        accessibilityTraits = .adjustable
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        bounds.insetBy(dx: -12, dy: -16).contains(point)
    }

    @objc private func dragged(_ press: UILongPressGestureRecognizer) {
        switch press.state {
        case .began, .changed:
            if !tracking { tracking = true; slide() }
            value = StoryTextEntryLayout.value(y: press.location(in: self).y, height: bounds.height)
            onChange?(value)
        default:
            tracking = false
            slide()
        }
    }

    override func accessibilityIncrement() { value = min(1, value + 0.1); onChange?(value) }
    override func accessibilityDecrement() { value = max(0, value - 0.1); onChange?(value) }

    /// Half out of view at rest; out beside the edge while held.
    private func slide() {
        UIView.animate(withDuration: 0.2) {
            self.layoutIfNeeded()
            let shift = self.tracking ? 8 : -self.bounds.width / 2
            self.track.transform = CGAffineTransform(translationX: shift, y: 0)
            self.knob.transform = CGAffineTransform(translationX: shift + (self.tracking ? 0 : 4), y: 0)
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let shift = tracking ? 8 : -bounds.width / 2
        track.bounds = bounds
        track.center = CGPoint(x: bounds.midX, y: bounds.midY)
        track.transform = CGAffineTransform(translationX: shift, y: 0)
        tint.frame = track.bounds
        let path = UIBezierPath()
        let top: CGFloat = 15, bottom: CGFloat = 3
        path.addArc(withCenter: CGPoint(x: bounds.width / 2, y: top), radius: top, startAngle: .pi, endAngle: 0, clockwise: true)
        path.addArc(withCenter: CGPoint(x: bounds.width / 2, y: bounds.height - bottom), radius: bottom, startAngle: 0, endAngle: .pi, clockwise: true)
        path.close()
        shape.path = path.cgPath
        knob.bounds = CGRect(x: 0, y: 0, width: 32, height: 32)
        knob.center = CGPoint(x: bounds.midX, y: StoryTextEntryLayout.knob(value: value, height: bounds.height))
        knob.transform = CGAffineTransform(translationX: shift + (tracking ? 0 : 4), y: 0)
    }
}

/// The keyboard's bar while typing: the colour wheel around the colour, the
/// fill, the alignment, and the font in its pill at the right.
final class StoryTextBar: UIView {
    var onColor: (() -> Void)?
    var onStyle: (() -> Void)?
    var onAlign: (() -> Void)?
    var onFont: ((StoryTextFont) -> Void)?
    private let swatch = UIButton(type: .custom)
    private let style = UIButton(type: .custom)
    private let align = UIButton(type: .custom)
    private let font = UIButton(type: .custom)
    private let chevron = UIImageView(image: StoryEditorIcons.fontArrow)
    private var shown: StoryTextStyle?

    init() {
        super.init(frame: CGRect(x: 0, y: 0, width: 320, height: StoryTextEntryLayout.Metrics.bar))
        autoresizingMask = .flexibleWidth
        swatch.accessibilityIdentifier = "story-text-color"
        swatch.accessibilityLabel = Strings.Stories.color
        swatch.addAction(UIAction { [weak self] _ in self?.onColor?() }, for: .touchUpInside)
        style.accessibilityIdentifier = "story-text-fill"
        style.accessibilityLabel = Strings.Stories.fill
        style.addAction(UIAction { [weak self] _ in self?.onStyle?() }, for: .touchUpInside)
        align.accessibilityIdentifier = "story-text-align"
        align.accessibilityLabel = Strings.Stories.align
        align.addAction(UIAction { [weak self] _ in self?.onAlign?() }, for: .touchUpInside)
        font.layer.cornerRadius = 11
        font.layer.borderWidth = 1
        font.layer.borderColor = UIColor.white.cgColor
        font.setTitleColor(.white, for: .normal)
        font.contentHorizontalAlignment = .left
        font.showsMenuAsPrimaryAction = true
        font.accessibilityIdentifier = "story-text-font"
        font.accessibilityLabel = Strings.Stories.font
        font.addSubview(chevron)
        font.menu = UIMenu(children: StoryTextFont.allCases.reversed().map { choice in
            UIAction(title: Strings.Stories.fontName(choice)) { [weak self] _ in self?.onFont?(choice) }
        })
        for view in [swatch, style, align, font] { addSubview(view) }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: StoryTextEntryLayout.Metrics.bar) }

    func show(_ next: StoryTextStyle) {
        guard next != shown else { return }
        shown = next
        swatch.setImage(StoryEditorIcons.swatch(UIColor(hex: next.color) ?? .white), for: .normal)
        swatch.accessibilityValue = next.color
        style.setImage(StoryEditorIcons.style(next.fill), for: .normal)
        style.accessibilityValue = next.fill.rawValue
        align.setImage(StoryEditorIcons.align(next.align), for: .normal)
        align.accessibilityValue = next.align.rawValue
        font.setTitle(Strings.Stories.fontName(next.font), for: .normal)
        font.titleLabel?.font = StoryTextOverlayView.font(next.font, size: 13)
        font.accessibilityValue = next.font.rawValue
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let title = font.titleLabel?.intrinsicContentSize.width ?? 0
        let bar = StoryTextEntryLayout.bar(width: bounds.width, fontTitle: title)
        swatch.frame = bar.swatch
        style.frame = bar.style
        align.frame = bar.align
        font.frame = bar.font
        font.titleEdgeInsets = UIEdgeInsets(top: 0, left: StoryTextEntryLayout.Metrics.fontLeft, bottom: 0, right: 0)
        chevron.frame = CGRect(x: bar.font.width - 16 - 8, y: (bar.font.height - 16) / 2, width: 16, height: 16)
    }
}
#endif
