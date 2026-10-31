#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Home's left bar item, alone there on both homes: the active account's
/// picture and name on one line, and a chevron. A tap opens the native menu: every account and agent
/// connection (the active one ticked; another switches to it), then Add
/// (`AccountAdding`) and Manage Accounts. Adding or a failed
/// switch leaves the active account as it was.
@MainActor
final class AccountSwitcher: NSObject {
    private let context: AppContext
    private weak var controller: UIViewController?
    private let button = AccountSwitcherButton()
    private let item: UIBarButtonItem
    private var observation: AccountsObservation?
    private var images: [String: UIImage] = [:]
    private var imageKeys: [String: String] = [:]
    private var jobs: [String: Task<Void, Never>] = [:]
    private var switching = false

    /// Connection state is available to VoiceOver without a second visual line.
    var subtitle: String = Strings.HeaderStatus.text(.connecting) {
        didSet { if subtitle != oldValue { show() } }
    }

    init(context: AppContext, controller: UIViewController) {
        self.context = context
        self.controller = controller
        item = UIBarButtonItem(customView: button)
        super.init()
        button.accessibilityIdentifier = "account-switcher"
        button.showsMenuAsPrimaryAction = true
        button.menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] done in done(self?.menuElements() ?? []) }])
        observation = context.account.observeAccounts { [weak self] _ in self?.show() }
        show()
    }

    /// The item the screen puts in its bar. One item throughout, so a
    /// screen places it once and it keeps itself up to date.
    var barItem: UIBarButtonItem { item }

    private func name(_ account: AccountSummary) -> String {
        if account.isAgentConnection, let connection = context.account.agentConnections.accounts.first(where: { $0.id == account.id }) {
            return connection.name
        }
        return account.name ?? account.username ?? Strings.happyAccount
    }

    /// The one account the switcher calls current. A signed-in Happy
    /// account and an open agent connection each report themselves active,
    /// from two fields that know nothing of each other
    /// (`AccountController.accounts`), so in that mixed case more than one
    /// says so. The first in the order they are shown in wins, which is
    /// the one the button already draws.
    private func current(in accounts: [AccountSummary]) -> AccountSummary? {
        accounts.first(where: \.isActive)
    }

    private func show() {
        let accounts = context.account.accounts
        accounts.forEach(loadImage)
        guard let active = current(in: accounts) else { return }
        button.title = name(active)
        button.picture = images[active.id] ?? Self.fallback(active)
        button.accessibilityLabel = Strings.AccountSwitcher.switcher
        button.accessibilityValue = [name(active), subtitle].joined(separator: ", ")
        button.frame.size = button.sizeThatFits(.zero)
        item.customView = button
        layout()
    }

    func layout() {
        guard let controller, let navigation = controller.navigationController else { return }
        button.maximumWidth = AccountSwitcherLayout.availableWidth(
            barWidth: navigation.navigationBar.bounds.width,
            safeArea: LayoutInsets(navigation.navigationBar.safeAreaInsets),
            trailingItems: controller.navigationItem.rightBarButtonItems?.count ?? 0
        )
    }

    private static func fallback(_ account: AccountSummary) -> UIImage? {
        UIImage(systemName: account.isAgentConnection ? "desktopcomputer" : "person.crop.circle.fill")?
            .withTintColor(UIColor(Palette.textSecondary), renderingMode: .alwaysOriginal)
    }

    private func loadImage(_ account: AccountSummary) {
        let key = ProfilePictures.key(account, context: context)
        guard imageKeys[account.id] != key else { return }
        imageKeys[account.id] = key
        jobs[account.id]?.cancel()
        jobs[account.id] = Task { [weak self, context] in
            let image = await ProfilePictures.load(account, context: context)
            guard !Task.isCancelled, let self, imageKeys[account.id] == key else { return }
            images[account.id] = image.map { Self.round($0, side: 28) }
            show()
        }
    }

    private static func round(_ image: UIImage, side: CGFloat) -> UIImage {
        let size = CGSize(width: side, height: side)
        return UIGraphicsImageRenderer(size: size).image { _ in
            let rect = CGRect(origin: .zero, size: size)
            UIBezierPath(ovalIn: rect).addClip()
            image.draw(in: rect)
        }.withRenderingMode(.alwaysOriginal)
    }

    /// Not private, so a test can read what the menu would show without
    /// opening it; the menu itself asks for these on every tap.
    func menuElements() -> [UIMenuElement] {
        let accounts = context.account.accounts
        let current = current(in: accounts)?.id
        let choices: [UIMenuElement] = accounts.map { account in
            let fullName = name(account)
            let action = UIAction(title: Self.menuTitle(fullName), image: images[account.id] ?? Self.fallback(account), state: account.id == current ? .on : .off) { [weak self] _ in
                self?.choose(account, current: current)
            }
            action.accessibilityLabel = fullName
            action.accessibilityIdentifier = "account-\(account.id)"
            return action
        }
        let add = UIAction(title: Strings.AccountSwitcher.add, image: UIImage(systemName: "plus")) { [weak self] _ in
            guard let self, let controller else { return }
            AccountAdding.begin(context: context, from: controller)
        }
        add.accessibilityIdentifier = "account-add"
        let manage = UIAction(title: Strings.AccountSwitcher.manageAccounts, image: UIImage(systemName: "person.2")) { [weak self] _ in
            guard let self, let navigation = controller?.navigationController, navigation.topViewController === controller else { return }
            navigation.pushViewController(CombinedAccountsViewController(context: context), animated: true)
        }
        manage.accessibilityIdentifier = "account-manage"
        return [
            UIMenu(options: .displayInline, children: choices),
            UIMenu(options: .displayInline, children: [add, manage]),
        ]
    }

    /// UIKit's compact menu reserves a fixed lane for the check and picture.
    /// UIAction offers no line-count setting, so fit its title on one line.
    private static func menuTitle(_ name: String) -> String {
        let font = UIFont.preferredFont(forTextStyle: .body)
        func width(_ text: String) -> CGFloat { (text as NSString).size(withAttributes: [.font: font]).width }
        let limit: CGFloat = 140
        guard width(name) > limit else { return name }
        var title = name
        while !title.isEmpty, width(title + "…") > limit { title.removeLast() }
        return title.trimmingCharacters(in: .whitespaces) + "…"
    }

    /// `current` is the ticked one, not every account that calls itself
    /// active: in the mixed case the other one is a real switch.
    private func choose(_ account: AccountSummary, current: String?) {
        guard account.id != current, !switching else { return }
        switching = true
        Task { [weak self] in
            guard let self else { return }
            defer { switching = false }
            do {
                // The coordinator puts the other account's home in place.
                try await context.account.switchAccount(to: account.id)
            } catch {
                guard let controller else { return }
                Alerts.show(Strings.Common.error, Strings.AccountSwitcher.switchFailed, on: controller)
            }
        }
    }
}

/// The switcher's single-line face, placed by `AccountSwitcherLayout`.
final class AccountSwitcherButton: UIButton {
    private let pictureView = UIImageView()
    private let titleText = StyledLabel(style: TextStyles.headerTitle, color: Palette.headerTint, lines: 1)
    private let chevron = UIImageView(image: UIImage(systemName: "chevron.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .semibold)))

    var title = "" {
        didSet { titleText.string = title; invalidateIntrinsicContentSize(); setNeedsLayout() }
    }

    var maximumWidth: CGFloat = .greatestFiniteMagnitude {
        didSet {
            guard maximumWidth != oldValue else { return }
            invalidateIntrinsicContentSize()
            frame.size = sizeThatFits(.zero)
            setNeedsLayout()
        }
    }

    var picture: UIImage? {
        didSet { pictureView.image = picture }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        pictureView.contentMode = .scaleAspectFill
        pictureView.clipsToBounds = true
        pictureView.layer.cornerRadius = AccountSwitcherLayout.Metrics.picture / 2
        chevron.tintColor = UIColor(Palette.textSecondary)
        titleText.lineBreakMode = .byTruncatingTail
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for view in [pictureView, titleText, chevron] as [UIView] {
            view.isUserInteractionEnabled = false
            addSubview(view)
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func measured(maxWidth: CGFloat? = nil) -> AccountSwitcherLayout {
        let unbounded = CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        return AccountSwitcherLayout(
            title: titleText.sizeThatFits(unbounded),
            chevron: chevron.image?.size ?? .zero,
            maxWidth: maxWidth ?? maximumWidth
        )
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize { measured().size }
    override var intrinsicContentSize: CGSize { measured().size }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = measured(maxWidth: bounds.width)
        pictureView.setLayoutFrame(layout.picture)
        titleText.setLayoutFrame(layout.title)
        chevron.setLayoutFrame(layout.chevron)
    }
}
#endif
