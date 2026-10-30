#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Home's left bar item, alone there on both homes: the active account's
/// picture and name, with the connection under it while it isn't live,
/// and a chevron. A tap opens the native menu: every account and agent
/// connection (the active one ticked; another switches to it), then Add
/// Account (`AccountAdding`) and Manage Accounts. Adding or a failed
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

    /// Under the name: the connection while it isn't live.
    var subtitle: String? {
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
        controller.navigationItem.leftBarButtonItem = item
        observation = context.account.observeAccounts { [weak self] _ in self?.show() }
        show()
    }

    /// The item, for a screen that sets its left items itself.
    var barItem: UIBarButtonItem { item }

    private func name(_ account: AccountSummary) -> String {
        if account.isAgentConnection, let connection = context.account.agentConnections.accounts.first(where: { $0.id == account.id }) {
            return connection.name
        }
        return account.name ?? account.username ?? Strings.happyAccount
    }

    private func show() {
        let accounts = context.account.accounts
        accounts.forEach(loadImage)
        guard let active = accounts.first(where: \.isActive) else { return }
        button.title = name(active)
        button.subtitle = subtitle
        button.picture = images[active.id] ?? Self.fallback(active)
        button.accessibilityLabel = Strings.AccountSwitcher.switcher
        button.accessibilityValue = [name(active), subtitle].compactMap { $0 }.joined(separator: ", ")
        button.frame.size = button.sizeThatFits(.zero)
        item.customView = button
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

    private func menuElements() -> [UIMenuElement] {
        let accounts = context.account.accounts
        let choices: [UIMenuElement] = accounts.map { account in
            let action = UIAction(title: name(account), image: images[account.id] ?? Self.fallback(account), state: account.isActive ? .on : .off) { [weak self] _ in
                self?.choose(account)
            }
            action.subtitle = account.isAgentConnection ? (account.connectionStatus ?? Strings.agentConnection) : account.username.map { "@\($0)" } ?? account.serverURL.host
            action.accessibilityIdentifier = "account-\(account.id)"
            return action
        }
        let add = UIAction(title: Strings.AccountSwitcher.addAccount, image: UIImage(systemName: "plus")) { [weak self] _ in
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

    private func choose(_ account: AccountSummary) {
        guard !account.isActive, !switching else { return }
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

/// The switcher's face: picture, name and chevron, the connection under the
/// name. `AccountSwitcherLayout` places them.
final class AccountSwitcherButton: UIButton {
    private let pictureView = UIImageView()
    private let titleText = StyledLabel(style: TextStyles.headerTitle, color: Palette.headerTint, lines: 1)
    private let subtitleText = StyledLabel(style: TextStyles.headerSubtitle, color: Palette.textSecondary, lines: 1)
    private let chevron = UIImageView(image: UIImage(systemName: "chevron.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .semibold)))

    var title = "" {
        didSet { titleText.string = title; setNeedsLayout() }
    }

    var subtitle: String? {
        didSet {
            subtitleText.string = subtitle ?? ""
            subtitleText.isHidden = subtitle == nil
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
        subtitleText.lineBreakMode = .byTruncatingTail
        subtitleText.isHidden = true
        for view in [pictureView, titleText, subtitleText, chevron] as [UIView] {
            view.isUserInteractionEnabled = false
            addSubview(view)
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func measured() -> AccountSwitcherLayout {
        let unbounded = CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        return AccountSwitcherLayout(
            title: titleText.sizeThatFits(unbounded),
            subtitle: subtitle == nil ? nil : subtitleText.sizeThatFits(unbounded),
            chevron: chevron.image?.size ?? .zero
        )
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize { measured().size }
    override var intrinsicContentSize: CGSize { measured().size }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = measured()
        pictureView.setLayoutFrame(layout.picture)
        titleText.setLayoutFrame(layout.title)
        if let frame = layout.subtitle { subtitleText.setLayoutFrame(frame) }
        chevron.setLayoutFrame(layout.chevron)
    }
}
#endif
