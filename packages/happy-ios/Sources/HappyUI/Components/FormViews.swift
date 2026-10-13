#if canImport(UIKit)
import CoreImage
import CoreImage.CIFilterBuiltins
import HappyLayout
import UIKit

/// The custom server form from app/(app)/server.tsx, laid out by
/// `ServerFormLayout`. The controller owns the logic and sets the state.
public final class ServerFormView: UIView {
    public let field = UITextField()
    public let save = RoundButton(title: Strings.Common.save, size: .normal)
    public let reset = RoundButton(title: Strings.Server.resetToDefault, size: .normal, display: .inverted)

    public var error: String? {
        didSet { apply() }
    }

    public var isValidating = false {
        didSet { apply() }
    }

    public var isCustomServer = false {
        didSet { apply() }
    }

    let label = StyledLabel(style: TextStyles.fieldLabel, color: Palette.textSecondary, lines: 1)
    let fieldBackground = UIView()
    let errorLabel = StyledLabel(style: TextStyles.fieldError, color: Palette.textDestructive)
    let validatingLabel = StyledLabel(style: TextStyles.fieldError, color: Palette.statusConnecting)
    let statusLabel = StyledLabel(style: TextStyles.fieldStatus, color: Palette.textSecondary, alignment: .center)

    public override init(frame: CGRect) {
        super.init(frame: frame)
        label.string = Strings.Server.serverUrlLabel
        validatingLabel.string = Strings.Server.validatingServer
        statusLabel.string = Strings.Server.currentlyUsingCustomServer
        fieldBackground.backgroundColor = UIColor(Palette.surfaceHigh)
        fieldBackground.layer.cornerRadius = ServerFormLayout.Metrics.fieldCornerRadius
        fieldBackground.layer.cornerCurve = .continuous
        field.textColor = UIColor(Palette.inputText)
        applyInputStyle()
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.keyboardType = .URL
        field.textContentType = .URL
        field.returnKeyType = .done
        field.clearButtonMode = .whileEditing
        for view in [label, fieldBackground, field, errorLabel, validatingLabel, save, reset, statusLabel] {
            addSubview(view)
        }
        // Assignments in a class's own initializer skip didSet.
        apply()
        registerForTraitChanges(UIView.textSizeTraits) { (self: Self, _) in
            self.applyInputStyle()
            self.setNeedsLayoutUpTheTree()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// The field's text, as RN's TextInput draws it: at the person's text
    /// size where the screen follows it.
    private var inputStyle: TextStyle {
        traitCollection.textEnvironment.map { TextStyles.serverInput.scaled($0.scale) } ?? TextStyles.serverInput
    }

    private func applyInputStyle() {
        let font = inputStyle.font
        field.font = font
        field.attributedPlaceholder = NSAttributedString(
            string: Strings.Common.urlPlaceholder,
            attributes: [.foregroundColor: UIColor(Palette.inputPlaceholder), .font: font]
        )
    }

    public func layout(width: CGFloat) -> ServerFormLayout {
        ServerFormLayout(.init(
            width: width,
            label: label.measurable,
            fieldLineHeight: inputStyle.lineHeightValue,
            error: error == nil ? nil : errorLabel.measurable,
            validating: isValidating ? validatingLabel.measurable : nil,
            save: save.measurable,
            reset: isCustomServer ? reset.measurable : nil,
            status: isCustomServer ? statusLabel.measurable : nil
        ))
    }

    public override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout(width: size.width).size
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        label.setLayoutFrame(layout.label)
        fieldBackground.setLayoutFrame(layout.field)
        let padding = ServerFormLayout.Metrics.fieldPaddingHorizontal
        field.setLayoutFrame(layout.field.insetBy(dx: padding, dy: 0))
        if let frame = layout.error { errorLabel.setLayoutFrame(frame) }
        if let frame = layout.validating { validatingLabel.setLayoutFrame(frame) }
        save.setLayoutFrame(layout.save)
        if let frame = layout.reset { reset.setLayoutFrame(frame) }
        if let frame = layout.status { statusLabel.setLayoutFrame(frame) }
    }

    private func apply() {
        errorLabel.string = error ?? ""
        errorLabel.isHidden = error == nil
        validatingLabel.isHidden = !isValidating
        field.isEnabled = !isValidating
        field.alpha = isValidating ? 0.6 : 1
        save.title = isValidating ? Strings.Server.validating : Strings.Common.save
        save.isEnabled = !isValidating
        reset.isHidden = !isCustomServer
        statusLabel.isHidden = !isCustomServer
        invalidate()
    }

    private func invalidate() {
        setNeedsLayout()
        // The group and list above size themselves from this view.
        var view = superview
        while let current = view {
            current.setNeedsLayout()
            view = current.superview
        }
    }
}

/// A QR code rendered crisp at any size: CoreImage makes one module per
/// pixel and the image view scales it with nearest-neighbour filtering.
public final class QRCodeView: UIImageView {
    public var payload: String? {
        didSet { image = payload.flatMap(Self.image(for:)) }
    }

    public convenience init() {
        self.init(frame: .zero)
    }

    public override init(frame: CGRect) {
        super.init(frame: frame)
        layer.magnificationFilter = .nearest
        contentMode = .scaleToFill
        backgroundColor = UIColor(Palette.qrBackground)
        isAccessibilityElement = true
        accessibilityTraits = .image
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    static func image(for payload: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(payload.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage,
              let cgImage = CIContext(options: [.useSoftwareRenderer: false]).createCGImage(output, from: output.extent) else {
            return nil
        }
        return UIImage(cgImage: cgImage)
    }
}
#endif
