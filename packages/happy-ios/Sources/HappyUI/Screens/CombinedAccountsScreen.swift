#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The same inventory is used by a legacy home and a direct home.
@MainActor
final class HomeAccountControl: NSObject {
    private let context: AppContext
    private weak var controller: UIViewController?
    private weak var header: HomeHeaderView?
    private var observation: AccountsObservation?
    private var imageJob: Task<Void, Never>?
    private var accounts: [AccountSummary] = []
    /// Where a computer is a home of its own: the active account's picture,
    /// always, opens the profiles' settings, which is where switching went.
    var opensSettings: (() -> Void)? {
        didSet { update(accounts) }
    }

    init(context: AppContext, controller: UIViewController, header: HomeHeaderView? = nil) {
        self.context = context; self.controller = controller; self.header = header
        super.init()
        if let header { header.logoControl.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(open))) }
        observation = context.account.observeAccounts { [weak self] accounts in self?.update(accounts) }
    }

    private func update(_ accounts: [AccountSummary]) {
        self.accounts = accounts
        let settings = opensSettings != nil
        let multiple = accounts.count > 1 || settings
        let active = accounts.first(where: \.isActive)
        header?.showsAccountAvatar = multiple
        header?.logoControl.isUserInteractionEnabled = multiple
        header?.logoControl.isAccessibilityElement = multiple
        header?.logoControl.accessibilityLabel = settings ? Strings.StemCells.openSettings : "Switch account"
        header?.logoControl.accessibilityIdentifier = settings ? "stem-settings-mark" : nil
        header?.logoControl.accessibilityTraits = .button
        imageJob?.cancel()
        let fallback = multiple ? UIImage(systemName: active?.isDirect == true ? "desktopcomputer" : "person.crop.circle.fill") : UIImage.happy("logo-black")?.withRenderingMode(.alwaysTemplate)
        apply(fallback, multiple: multiple)
        guard multiple, let active else { return }
        let bytes = context.account.direct.accounts.first { $0.id == active.id }?.avatar
        let pictures = context.account.pictures(for: active.id)
        imageJob = Task { [weak self] in
            var image: UIImage?
            if let bytes { image = await Task.detached { AccountPictureImages.decode(bytes)?.picture as? UIImage }.value }
            else if let url = active.avatarURL { image = await pictures?.image(url) }
            if image == nil, let thumbhash = active.avatarThumbhash { image = await pictures?.placeholderImage(thumbhash) }
            guard !Task.isCancelled, let self, let image else { return }
            apply(image, multiple: true)
        }
    }

    private func apply(_ image: UIImage?, multiple: Bool) {
        if let header { header.logo.image = image; header.logo.contentMode = .scaleAspectFill }
        let side = multiple ? HomeHeaderLayout.Metrics.logoBox : HomeHeaderLayout.Metrics.logoSize
        let size = CGSize(width: side, height: side)
        let icon = image.map { image in
            UIGraphicsImageRenderer(size: size).image { _ in
                let rect = CGRect(origin: .zero, size: size)
                if multiple { UIBezierPath(ovalIn: rect).addClip() }
                image.draw(in: rect)
            }.withRenderingMode(multiple ? .alwaysOriginal : .alwaysTemplate)
        }
        let item = UIBarButtonItem(image: icon, style: .plain, target: self, action: #selector(open))
        item.isEnabled = multiple
        item.accessibilityLabel = opensSettings != nil ? Strings.StemCells.openSettings : multiple ? "Switch account" : "Happy"
        item.accessibilityIdentifier = opensSettings != nil ? "stem-settings-mark" : nil
        controller?.navigationItem.leftBarButtonItem = item
    }

    @objc private func open() {
        if let opensSettings { return opensSettings() }
        guard let controller else { return }
        controller.navigationController?.pushViewController(CombinedAccountsViewController(context: context), animated: true)
    }
}

final class CombinedAccountsViewController: UIViewController {
    private let context: AppContext
    private let list = GroupedListView()
    private var observation: AccountsObservation?
    private var images: [String: UIImage] = [:]
    private var imageKeys: [String: String] = [:]
    private var jobs: [String: Task<Void, Never>] = [:]
    private var busy = false

    init(context: AppContext) { self.context = context; super.init(nibName: nil, bundle: nil) }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
    override func loadView() { view = list }
    override func viewDidLoad() {
        super.viewDidLoad(); title = "Accounts"
        observation = context.account.observeAccounts { [weak self] _ in self?.update() }
    }
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated); navigationController?.setNavigationBarHidden(false, animated: animated)
    }
    private func update() {
        var rows: [UIView] = []
        for account in context.account.accounts {
            loadImage(account)
            let icon = images[account.id].map { ItemIcon(.image($0), round: true) } ?? ItemIcon(.ionicons(account.isDirect ? "desktop-outline" : "person-circle-outline"), tint: Palette.iconBlue)
            let status = account.connectionStatus ?? (account.isActive ? "Active" : "Signed in")
            let row = ItemRowView(title: account.name ?? account.username ?? "Happy account", subtitle: "\(account.isDirect ? "Direct computer" : account.serverURL.host ?? "Happy") · \(status)", icon: icon) { [weak self] in
                self?.select(account)
            }
            row.showsChevron = false
            if account.isActive { row.trailingView = SettingsCheckmark.view(tint: Palette.iconBlue) }
            rows.append(row)
            let remove = ItemRowView(title: account.isDirect ? "Disconnect \(account.name ?? "computer")" : "Sign out \(account.name ?? "account")", icon: ItemIcon(.ionicons("log-out-outline"), tint: Palette.textSecondary)) { [weak self] in self?.remove(account) }
            remove.showsChevron = false
            rows.append(remove)
        }
        let scan = ItemRowView(title: "Pair a computer", subtitle: "Scan a Happy or direct pairing code", icon: ItemIcon(.ionicons("qr-code-outline"), tint: Palette.iconBlue)) { [weak self] in
            guard let self else { return }; DirectPairingFlow.scan(context: context, on: self)
        }
        let add = ItemRowView(title: "Add Happy account", icon: ItemIcon(.ionicons("add-circle-outline"), tint: Palette.iconBlue)) { [weak self] in
            guard let self else { return }
            context.account.beginAddingAccount()
            navigationController?.pushViewController(WelcomeViewController(context: context), animated: true)
        }
        list.sections = [ItemGroupView(rows: rows), ItemGroupView(rows: [scan, add])]
    }
    private func select(_ account: AccountSummary) {
        guard !busy, !account.isActive else { return }; busy = true
        Task { [weak self] in
            guard let self else { return }
            do { try await context.account.switchAccount(to: account.id) }
            catch { Alerts.show("Could not switch account", error.localizedDescription, on: self) }
            busy = false
        }
    }
    private func remove(_ account: AccountSummary) {
        guard !busy else { return }; busy = true
        Task { [weak self] in
            guard let self else { return }
            defer { busy = false }
            guard await Alerts.confirm(account.isDirect ? "Disconnect computer?" : "Sign out?", "Remove this account and its credentials from this phone?", confirmTitle: account.isDirect ? "Disconnect" : "Sign out", destructive: true, on: self) else { return }
            do { try await context.account.signOut(accountID: account.id) }
            catch { Alerts.show("Could not remove account", error.localizedDescription, on: self) }
        }
    }
    private func loadImage(_ account: AccountSummary) {
        let direct = context.account.direct.accounts.first { $0.id == account.id }
        let key = direct.map { "\($0.avatarETag ?? ""):\($0.avatar?.count ?? 0)" } ?? account.avatarURL?.absoluteString ?? account.avatarThumbhash ?? ""
        guard imageKeys[account.id] != key else { return }
        imageKeys[account.id] = key; jobs[account.id]?.cancel()
        let pictures = context.account.pictures(for: account.id)
        jobs[account.id] = Task { [weak self] in
            var image: UIImage?
            if let bytes = direct?.avatar { image = await Task.detached { AccountPictureImages.decode(bytes)?.picture as? UIImage }.value }
            else if let url = account.avatarURL { image = await pictures?.image(url) }
            if image == nil, let hash = account.avatarThumbhash { image = await pictures?.placeholderImage(hash) }
            guard !Task.isCancelled, let self, imageKeys[account.id] == key else { return }
            images[account.id] = image; update()
        }
    }
}
#endif