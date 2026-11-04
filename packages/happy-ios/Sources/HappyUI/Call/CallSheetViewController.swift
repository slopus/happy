#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Voice's two full-height sheets, drawn alike: the welcome a device sees
/// before its first call, and the paywall once its free time is used
/// (`CallAllowance`). The call's own indigo and its three bars on top, a
/// headline, what it does or what more time would bring, and one button
/// at the bottom. Closed by its ✕ or a swipe down, which starts nothing.
@MainActor
final class CallSheetViewController: UIViewController {
    enum Screen: Equatable {
        /// Before the first call; its button starts it.
        case welcome
        /// The free time is used; when some is back, if that is known.
        case used(freeAgain: Date?, offer: CallOffer)
    }

    let screen: Screen
    /// The welcome's "Start talking", once the sheet has gone.
    var onStart: (() -> Void)?

    private let scroll = UIScrollView()
    private let footer = UIView()
    let close = UIButton(type: .system)
    let primary = UIButton(type: .system)

    init(_ screen: Screen) {
        self.screen = screen
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        view.accessibilityIdentifier = screen == .welcome ? "call-welcome" : "call-paywall"

        let hero = Hero()
        let content = UIStackView()
        content.axis = .vertical
        content.spacing = 12
        content.isLayoutMarginsRelativeArrangement = true
        content.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 24, leading: 24, bottom: 24, trailing: 24)

        let title = label(.title1, weight: .bold, color: .label)
        title.accessibilityTraits = .header
        let body = label(.body, color: .secondaryLabel)
        content.addArrangedSubview(title)
        content.addArrangedSubview(body)
        content.setCustomSpacing(24, after: body)

        let note = label(.footnote, color: .secondaryLabel)
        note.textAlignment = .center
        var rows: [(String, String, String)] = []
        switch screen {
        case .welcome:
            title.text = Strings.Call.welcomeTitle
            body.text = Strings.Call.welcomeBody
            rows = [("text.bubble", Strings.Call.welcomeAsk, Strings.Call.welcomeAskDetail),
                    ("paperplane", Strings.Call.welcomeAct, Strings.Call.welcomeActDetail),
                    ("checkmark.shield", Strings.Call.welcomeApprove, Strings.Call.welcomeApproveDetail),
                    ("gift", Strings.Call.welcomeFree, Strings.Call.welcomeFreeDetail)]
            primary.setTitle(Strings.Call.welcomeStart, for: .normal)
            note.text = Strings.Call.welcomeNote
            primary.addAction(UIAction { [weak self] _ in self?.start() }, for: .primaryActionTriggered)
        case .used(let freeAgain, let offer):
            title.text = Strings.Call.usedTitle
            body.text = freeAgain.map { Strings.Call.usedBody(Self.when($0, now: Date())) } ?? Strings.Call.usedBodyLater
            rows = [("timer", Strings.Call.upgradeTime, Strings.Call.upgradeTimeDetail),
                    ("heart", Strings.Call.upgradeSupport, Strings.Call.upgradeSupportDetail)]
            switch offer {
            case .preview:
                primary.setTitle(Strings.Call.upgradeBuy, for: .normal)
                note.text = Strings.Call.upgradePreviewNote
                primary.addAction(UIAction { [weak self] _ in self?.preview() }, for: .primaryActionTriggered)
            case .unavailable:
                // Nothing to buy: the button only closes, and says so.
                primary.setTitle(Strings.Call.gotIt, for: .normal)
                note.text = Strings.Call.upgradeSoon
                primary.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .primaryActionTriggered)
            }
        }
        for (symbol, heading, detail) in rows { content.addArrangedSubview(Benefit(symbol: symbol, title: heading, detail: detail)) }
        for case let row as Benefit in content.arrangedSubviews where row !== content.arrangedSubviews.last { content.setCustomSpacing(20, after: row) }

        let stack = UIStackView(arrangedSubviews: [hero, content])
        stack.axis = .vertical
        stack.alignment = .center
        scroll.alwaysBounceVertical = true
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.addSubview(stack)

        var button = UIButton.Configuration.filled()
        button.baseBackgroundColor = UIColor(Palette.CallBar.listening.start)
        button.baseForegroundColor = .white
        button.cornerStyle = .large
        button.buttonSize = .large
        button.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = UIFont.preferredFont(forTextStyle: .headline)
            return attributes
        }
        primary.configuration = button
        primary.accessibilityIdentifier = "call-sheet-primary"
        let bottom = UIStackView(arrangedSubviews: [primary, note])
        bottom.axis = .vertical
        bottom.spacing = 12
        footer.backgroundColor = .systemBackground
        footer.addSubview(bottom)

        var cross = UIButton.Configuration.filled()
        cross.image = UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 14, weight: .bold))
        cross.baseBackgroundColor = UIColor.white.withAlphaComponent(0.22)
        cross.baseForegroundColor = .white
        cross.cornerStyle = .capsule
        cross.background.backgroundInsets = NSDirectionalEdgeInsets(top: 6, leading: 6, bottom: 6, trailing: 6)
        close.configuration = cross
        close.accessibilityLabel = Strings.Call.close
        close.accessibilityIdentifier = "call-sheet-close"
        close.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .primaryActionTriggered)

        for view in [scroll, footer, close] {
            view.translatesAutoresizingMaskIntoConstraints = false
            self.view.addSubview(view)
        }
        for view in [stack, bottom] { view.translatesAutoresizingMaskIntoConstraints = false }
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: footer.topAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
            hero.widthAnchor.constraint(equalTo: stack.widthAnchor),
            // A readable column on a wide sheet.
            content.widthAnchor.constraint(lessThanOrEqualToConstant: 560),
            {
                let full = content.widthAnchor.constraint(equalTo: stack.widthAnchor)
                full.priority = .defaultHigh
                return full
            }(),
            footer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            footer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            footer.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            bottom.topAnchor.constraint(equalTo: footer.topAnchor, constant: 12),
            bottom.leadingAnchor.constraint(equalTo: footer.readableContentGuide.leadingAnchor, constant: 8),
            bottom.trailingAnchor.constraint(equalTo: footer.readableContentGuide.trailingAnchor, constant: -8),
            bottom.bottomAnchor.constraint(equalTo: footer.safeAreaLayoutGuide.bottomAnchor, constant: -12),
            close.topAnchor.constraint(equalTo: view.topAnchor, constant: 10),
            close.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -10),
            // 44 points to touch, the circle drawn inside.
            close.widthAnchor.constraint(equalToConstant: 44),
            close.heightAnchor.constraint(equalToConstant: 44),
        ])
    }

    private func label(_ style: UIFont.TextStyle, weight: UIFont.Weight? = nil, color: UIColor) -> UILabel {
        let label = UILabel()
        var font = UIFont.preferredFont(forTextStyle: style)
        if let weight {
            font = UIFontMetrics(forTextStyle: style).scaledFont(for: .systemFont(ofSize: font.pointSize, weight: weight))
        }
        label.font = font
        label.adjustsFontForContentSizeCategory = true
        label.textColor = color
        label.numberOfLines = 0
        return label
    }

    /// When free time is back, as a sentence ends it: "at 5:19 PM" today,
    /// "on Thu at 5:19 PM" this week, "on Dec 3" after.
    static func when(_ date: Date, now: Date) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        let calendar = Calendar.current
        if calendar.isDate(date, inSameDayAs: now) { return Strings.Call.at(time) }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        if days < 7 { return Strings.Call.on(Strings.Call.at(time, day: date.formatted(.dateTime.weekday(.abbreviated)))) }
        return Strings.Call.on(date.formatted(.dateTime.month(.abbreviated).day()))
    }

    private func start() {
        let onStart = onStart
        dismiss(animated: true) { onStart?() }
    }

    /// Debug builds' test preview: what a purchase would say, said plainly
    /// as nothing. No product, charge, grant or change to the free time.
    private func preview() {
        let alert = UIAlertController(title: Strings.Call.upgradePreviewTitle, message: Strings.Call.upgradePreviewMessage, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Call.ok, style: .default))
        present(alert, animated: true)
    }

    /// In a full-height sheet of its own over whatever is on top.
    @discardableResult
    static func present(_ screen: Screen, over top: UIViewController, onStart: (() -> Void)? = nil) -> CallSheetViewController {
        let sheet = CallSheetViewController(screen)
        sheet.onStart = onStart
        sheet.modalPresentationStyle = .pageSheet
        sheet.sheetPresentationController?.detents = [.large()]
        sheet.sheetPresentationController?.preferredCornerRadius = 28
        top.present(sheet, animated: true)
        return sheet
    }
}

/// The sheet's top: the call bar's indigo into violet, and voice's three
/// bars in a ring.
private final class Hero: UIView {
    private let gradient = CAGradientLayer()
    private let ring = UIView()
    private let halo = UIView()

    init() {
        super.init(frame: .zero)
        isAccessibilityElement = false
        let colors = Palette.CallBar.listening
        gradient.colors = [UIColor(colors.start).cgColor, UIColor(colors.end).cgColor]
        gradient.startPoint = CGPoint(x: 0, y: 0)
        gradient.endPoint = CGPoint(x: 1, y: 1)
        layer.addSublayer(gradient)
        halo.backgroundColor = UIColor.white.withAlphaComponent(0.08)
        ring.backgroundColor = UIColor.white.withAlphaComponent(0.18)
        let bars = UIImageView(image: .voiceIcon(size: 56))
        bars.tintColor = .white
        for view in [halo, ring, bars] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 200),
            ring.centerXAnchor.constraint(equalTo: centerXAnchor),
            ring.centerYAnchor.constraint(equalTo: centerYAnchor, constant: 8),
            ring.widthAnchor.constraint(equalToConstant: 100),
            ring.heightAnchor.constraint(equalToConstant: 100),
            halo.centerXAnchor.constraint(equalTo: ring.centerXAnchor),
            halo.centerYAnchor.constraint(equalTo: ring.centerYAnchor),
            halo.widthAnchor.constraint(equalToConstant: 152),
            halo.heightAnchor.constraint(equalToConstant: 152),
            bars.centerXAnchor.constraint(equalTo: ring.centerXAnchor),
            bars.centerYAnchor.constraint(equalTo: ring.centerYAnchor),
        ])
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        gradient.frame = bounds
        ring.layer.cornerRadius = ring.bounds.width / 2
        halo.layer.cornerRadius = halo.bounds.width / 2
    }
}

/// One line of what voice does or brings: its symbol in a tinted square,
/// a heading and a sentence, read out as one.
private final class Benefit: UIView {
    init(symbol: String, title: String, detail: String) {
        super.init(frame: .zero)
        isAccessibilityElement = true
        accessibilityLabel = "\(title). \(detail)"
        let tint = UIColor(Palette.CallBar.listening.end)
        let tile = UIView()
        tile.backgroundColor = tint.withAlphaComponent(0.14)
        tile.layer.cornerRadius = 10
        tile.layer.cornerCurve = .continuous
        let icon = UIImageView(image: UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(textStyle: .body, scale: .medium)))
        icon.tintColor = tint
        icon.contentMode = .center
        let heading = UILabel()
        heading.font = .preferredFont(forTextStyle: .headline)
        heading.adjustsFontForContentSizeCategory = true
        heading.numberOfLines = 0
        heading.text = title
        let words = UILabel()
        words.font = .preferredFont(forTextStyle: .subheadline)
        words.adjustsFontForContentSizeCategory = true
        words.textColor = .secondaryLabel
        words.numberOfLines = 0
        words.text = detail
        let text = UIStackView(arrangedSubviews: [heading, words])
        text.axis = .vertical
        text.spacing = 2
        for view in [tile, icon, text] {
            view.translatesAutoresizingMaskIntoConstraints = false
        }
        addSubview(tile)
        tile.addSubview(icon)
        addSubview(text)
        NSLayoutConstraint.activate([
            tile.leadingAnchor.constraint(equalTo: leadingAnchor),
            tile.topAnchor.constraint(equalTo: topAnchor, constant: 2),
            tile.widthAnchor.constraint(equalToConstant: 40),
            tile.heightAnchor.constraint(equalToConstant: 40),
            icon.centerXAnchor.constraint(equalTo: tile.centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: tile.centerYAnchor),
            text.leadingAnchor.constraint(equalTo: tile.trailingAnchor, constant: 14),
            text.trailingAnchor.constraint(equalTo: trailingAnchor),
            text.topAnchor.constraint(equalTo: topAnchor),
            text.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor),
            tile.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor),
        ])
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
}
#endif
