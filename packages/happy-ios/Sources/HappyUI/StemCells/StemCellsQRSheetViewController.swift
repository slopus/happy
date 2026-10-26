#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit

/// Reading a code with the camera, or pasting one: a computer's pairing
/// code (`happy://direct?`), a terminal's, or another device's account
/// link, each to the flow that answers it.
@MainActor
enum StemCellsScan {
    static func scan(context: AppContext, on controller: UIViewController) {
        Task { @MainActor in
            let text: String? = await withCheckedContinuation { continuation in
                let scanner = QRScannerViewController()
                scanner.accepts = { accepts($0) }
                scanner.onFinish = { continuation.resume(returning: $0) }
                controller.present(scanner, animated: true)
            }
            guard let text else { return }
            open(text, context: context, on: controller, start: .scan)
        }
    }

    static func enterLink(context: AppContext, on controller: UIViewController) {
        Task { @MainActor in
            let text = await Alerts.prompt(Strings.StemCells.enterLink, placeholder: "happy://…", confirmTitle: Strings.Common.continueAction, on: controller)
            guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return }
            open(text, context: context, on: controller, start: .pasteLink)
        }
    }

    static func accepts(_ text: String) -> Bool {
        DirectPairingLink.isDirect(text) || PairingLink(text) != nil
    }

    static func open(_ text: String, context: AppContext, on controller: UIViewController, start: PairingStart) {
        if DirectPairingFlow.openIfDirect(text, context: context, on: controller, start: start) { return }
        guard let link = PairingLink(text) else {
            Alerts.show(Strings.Common.error, Strings.Modals.invalidAuthUrl, on: controller)
            return
        }
        guard let session = context.account.session else {
            Alerts.show(Strings.StemCells.signInFirst, Strings.StemCells.signInFirstDetail, on: controller)
            return
        }
        let kind: PairingFlow.Kind = if case .account = link { .account } else { .terminal }
        Task { @MainActor in
            let outcome = await PairingFlow.approve(text, expecting: kind, session: session)
            PairingFlow.report(outcome, kind: kind, on: controller)
        }
    }
}

/// The QR sheet, after Telegram's QR screen: the profile's picture and
/// name in capitals over a blurred ground, and a sheet at the foot with a
/// close button, the title, a line and two buttons. Nothing of a profile is
/// safe to show as a code (a computer's would carry its address and an
/// account's its key), so there is no code card: Scan is the first button
/// and pasting a link the second.
final class StemCellsQRSheetViewController: UIViewController {
    var onScan: (() -> Void)?
    var onEnterLink: (() -> Void)?
    private let image: UIImage?
    private let isDirect: Bool
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

    init(name: String, image: UIImage?, isDirect: Bool) {
        nameText = name
        self.image = image
        self.isDirect = isDirect
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "stem-qr"
        view.addSubview(ground)
        avatar.clipsToBounds = true
        avatar.layer.cornerRadius = StemCellsQRSheetLayout.Metrics.avatar / 2
        avatar.backgroundColor = UIColor(Palette.stemCellsSettingsAddFill)
        avatar.tintColor = UIColor(Palette.stemCellsSettingsText)
        if let image {
            avatar.image = image
            avatar.contentMode = .scaleAspectFill
        } else {
            avatar.image = isDirect ? UIImage.happy("logo-black")?.withRenderingMode(.alwaysTemplate) : StemCellsGlyphs.image("person-outline", size: 44)
            avatar.contentMode = .center
        }
        view.addSubview(avatar)
        name.text = nameText.uppercased()
        name.font = UIFont.systemFont(ofSize: 23, weight: .bold).rounded
        name.textColor = UIColor(Palette.stemCellsSettingsText)
        name.textAlignment = .center
        name.adjustsFontSizeToFitWidth = true
        name.minimumScaleFactor = 0.6
        view.addSubview(name)

        sheet.backgroundColor = UIColor(Palette.stemCellsSettingsCard)
        sheet.layer.cornerRadius = StemCellsQRSheetLayout.Metrics.radius
        sheet.layer.cornerCurve = .continuous
        sheet.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        sheet.accessibilityIdentifier = "stem-qr-sheet"
        view.addSubview(sheet)
        close.setImage(StemCellsGlyphs.image("close", size: 24), for: .normal)
        close.tintColor = UIColor(Palette.stemCellsSettingsText)
        close.backgroundColor = UIColor(Palette.stemCellsSettingsAddFill)
        close.layer.cornerRadius = StemCellsQRSheetLayout.Metrics.close / 2
        close.accessibilityLabel = Strings.StemCells.close
        close.accessibilityIdentifier = "stem-qr-close"
        close.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .touchUpInside)
        sheet.addSubview(close)
        titleLabel.text = Strings.StemCells.qrCode
        titleLabel.font = StemCellsFonts.ui(.semiBold, size: 17)
        titleLabel.textColor = UIColor(Palette.stemCellsSettingsText)
        titleLabel.textAlignment = .center
        titleLabel.accessibilityTraits = .header
        sheet.addSubview(titleLabel)
        text.text = Strings.StemCells.qrText
        text.font = StemCellsFonts.ui(.regular, size: 15)
        text.textColor = UIColor(Palette.stemCellsSettingsSecondary)
        text.textAlignment = .center
        text.numberOfLines = 0
        sheet.addSubview(text)
        style(primary, title: Strings.StemCells.scanQRCode, glyph: "qr-code-outline", fill: Palette.stemCellsSettingsPrimary, ink: Palette.stemCellsSettingsPrimaryInk)
        primary.accessibilityIdentifier = "stem-qr-scan"
        primary.addAction(UIAction { [weak self] _ in self?.finish(self?.onScan) }, for: .touchUpInside)
        style(secondary, title: Strings.StemCells.enterLink, glyph: "link-outline", fill: Palette.stemCellsSettingsSecondaryFill, ink: Palette.stemCellsSettingsPrimary)
        secondary.accessibilityIdentifier = "stem-qr-link"
        secondary.addAction(UIAction { [weak self] _ in self?.finish(self?.onEnterLink) }, for: .touchUpInside)
        sheet.addSubview(primary)
        sheet.addSubview(secondary)
    }

    private func style(_ button: UIButton, title: String, glyph: String, fill: ColorToken, ink: ColorToken) {
        var configuration = UIButton.Configuration.filled()
        configuration.attributedTitle = AttributedString(title, attributes: AttributeContainer([.font: StemCellsFonts.ui(.semiBold, size: 17)]))
        configuration.image = StemCellsGlyphs.image(glyph, size: 20)
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
        let layout = StemCellsQRSheetLayout(
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
