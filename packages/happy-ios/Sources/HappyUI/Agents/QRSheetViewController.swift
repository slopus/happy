#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit

/// Reading a code with the camera, or pasting one: a computer's pairing
/// code (`happy://direct?`), a terminal's, or another device's account
/// link, each to the flow that answers it.
@MainActor
enum Scan {
    static func scan(context: AppContext, on controller: UIViewController) {
        Task { @MainActor in
            await HappyScan.scan(intent: .connect, context: context, on: controller)
        }
    }

    static func enterLink(context: AppContext, on controller: UIViewController) {
        Task { @MainActor in
            let text = await Alerts.prompt(Strings.enterLink, placeholder: "happy://…", confirmTitle: Strings.Common.continueAction, on: controller)
            guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return }
            open(text, context: context, on: controller, start: .pasteLink)
        }
    }

    static func open(_ text: String, context: AppContext, on controller: UIViewController, start: PairingStart) {
        Task { @MainActor in
            await HappyScan.open(text, intent: .connect, context: context, on: controller, start: start)
        }
    }
}

/// The QR sheet, after Telegram's QR screen: the profile's picture and
/// name in capitals over a blurred ground, and a sheet at the foot with a
/// close button, the title, a line and two buttons. Nothing of a profile is
/// safe to show as a code (a computer's would carry its address and an
/// account's its key), so there is no code card: Scan is the first button
/// and pasting a link the second.
final class QRSheetViewController: UIViewController {
    var onScan: (() -> Void)?
    var onEnterLink: (() -> Void)?
    private let image: UIImage?
    private let isAgentConnection: Bool
    private let nameText: String
    private let ground = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterial))
    private let avatar = UIImageView()
    private let name = UILabel()
    private let sheet = UIView()
    private let close = UIButton(type: .system)
    private let titleLabel = UILabel()
    private let text = UILabel()
    private let primary = UIButton(type: .system)
    private let secondary = UIButton(type: .system)
    private var shown = false

    init(name: String, image: UIImage?, isAgentConnection: Bool) {
        nameText = name
        self.image = image
        self.isAgentConnection = isAgentConnection
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "qr"
        view.addSubview(ground)
        avatar.clipsToBounds = true
        avatar.layer.cornerRadius = QRSheetLayout.Metrics.avatar / 2
        avatar.backgroundColor = UIColor(Palette.settingsAddFill)
        avatar.tintColor = UIColor(Palette.settingsText)
        if let image {
            avatar.image = image
            avatar.contentMode = .scaleAspectFill
        } else {
            avatar.image = isAgentConnection ? UIImage.happy("logo-black")?.withRenderingMode(.alwaysTemplate) : Glyphs.image("person-outline", size: 44)
            avatar.contentMode = .center
        }
        view.addSubview(avatar)
        name.text = nameText.uppercased()
        name.font = UIFont.systemFont(ofSize: 23, weight: .bold).rounded
        name.textColor = UIColor(Palette.settingsText)
        name.textAlignment = .center
        name.adjustsFontSizeToFitWidth = true
        name.minimumScaleFactor = 0.6
        view.addSubview(name)

        sheet.backgroundColor = UIColor(Palette.settingsCard)
        sheet.layer.cornerRadius = QRSheetLayout.Metrics.radius
        sheet.layer.cornerCurve = .continuous
        sheet.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        sheet.accessibilityIdentifier = "qr-sheet"
        view.addSubview(sheet)
        close.setImage(Glyphs.image("close", size: 24), for: .normal)
        close.tintColor = UIColor(Palette.settingsText)
        close.backgroundColor = UIColor(Palette.settingsAddFill)
        close.layer.cornerRadius = QRSheetLayout.Metrics.close / 2
        close.accessibilityLabel = Strings.close
        close.accessibilityIdentifier = "qr-close"
        close.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .touchUpInside)
        sheet.addSubview(close)
        titleLabel.text = Strings.qrCode
        titleLabel.font = Fonts.ui(.semiBold, size: 17)
        titleLabel.textColor = UIColor(Palette.settingsText)
        titleLabel.textAlignment = .center
        titleLabel.accessibilityTraits = .header
        sheet.addSubview(titleLabel)
        text.text = Strings.qrText
        text.font = Fonts.ui(.regular, size: 15)
        text.textColor = UIColor(Palette.settingsSecondary)
        text.textAlignment = .center
        text.numberOfLines = 0
        sheet.addSubview(text)
        style(primary, title: Strings.scanQRCode, glyph: "qr-code-outline", fill: Palette.settingsPrimary, ink: Palette.settingsPrimaryInk)
        primary.accessibilityIdentifier = "qr-scan"
        primary.addAction(UIAction { [weak self] _ in self?.finish(self?.onScan) }, for: .touchUpInside)
        style(secondary, title: Strings.enterLink, glyph: "link-outline", fill: Palette.settingsSecondaryFill, ink: Palette.settingsPrimary)
        secondary.accessibilityIdentifier = "qr-link"
        secondary.addAction(UIAction { [weak self] _ in self?.finish(self?.onEnterLink) }, for: .touchUpInside)
        sheet.addSubview(primary)
        sheet.addSubview(secondary)
    }

    private func style(_ button: UIButton, title: String, glyph: String, fill: ColorToken, ink: ColorToken) {
        var configuration = UIButton.Configuration.filled()
        configuration.attributedTitle = AttributedString(title, attributes: AttributeContainer([.font: Fonts.ui(.semiBold, size: 17)]))
        configuration.image = Glyphs.image(glyph, size: 20)
        configuration.imagePadding = 6
        configuration.baseBackgroundColor = UIColor(fill)
        configuration.baseForegroundColor = UIColor(ink)
        configuration.cornerStyle = .capsule
        button.configuration = configuration
    }

    private func finish(_ next: (() -> Void)?) {
        dismiss(animated: true) { next?() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        ground.frame = view.bounds
        let layout = QRSheetLayout(
            size: view.bounds.size, safeTop: view.safeAreaInsets.top, safeBottom: view.safeAreaInsets.bottom,
            nameHeight: ceil(name.font.lineHeight),
            text: Measurable { [text] in text.sizeThatFits(CGSize(width: $0, height: .greatestFiniteMagnitude)) }
        )
        avatar.frame = layout.avatar
        name.frame = layout.name
        sheet.frame = layout.sheet
        close.frame = layout.close
        titleLabel.frame = layout.title
        text.frame = layout.text
        primary.frame = layout.primary
        secondary.frame = layout.secondary
        if !shown { sheet.transform = CGAffineTransform(translationX: 0, y: layout.sheet.height) }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        view.layoutIfNeeded()
        shown = true
        // The sheet rises as the ground fades in, as Telegram's does.
        UIView.animate(withDuration: animated ? 0.42 : 0, delay: 0, usingSpringWithDamping: 0.9, initialSpringVelocity: 0) {
            self.sheet.transform = .identity
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        UIView.animate(withDuration: animated ? 0.3 : 0) {
            self.sheet.transform = CGAffineTransform(translationX: 0, y: self.sheet.bounds.height)
        }
    }
}

private extension UIFont {
    /// The rounded design of the same font, as Telegram draws the QR name.
    var rounded: UIFont {
        guard let descriptor = fontDescriptor.withDesign(.rounded) else { return self }
        return UIFont(descriptor: descriptor, size: pointSize)
    }
}
#endif
