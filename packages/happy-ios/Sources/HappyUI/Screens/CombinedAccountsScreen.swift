#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Every account and connection, each signed out or disconnected from
/// here, and the one way to add another; the switcher's Manage Accounts.
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
            let icon = images[account.id].map { ItemIcon(.image($0), round: true) } ?? ItemIcon(.ionicons(account.isAgentConnection ? "desktop-outline" : "person-circle-outline"), tint: Palette.iconBlue)
            let status = account.connectionStatus ?? (account.isActive ? "Active" : "Signed in")
            let row = ItemRowView(title: account.name ?? account.username ?? "Happy account", subtitle: "\(account.isAgentConnection ? "Agent" : account.serverURL.host ?? "Happy") · \(status)", icon: icon) { [weak self] in
                self?.select(account)
            }
            row.showsChevron = false
            if account.isActive { row.trailingView = SettingsCheckmark.view(tint: Palette.iconBlue) }
            rows.append(row)
            let remove = ItemRowView(title: account.isAgentConnection ? "Disconnect \(account.name ?? "agent")" : "Sign out \(account.name ?? "account")", icon: ItemIcon(.ionicons("log-out-outline"), tint: Palette.textSecondary)) { [weak self] in self?.remove(account) }
            remove.showsChevron = false
            rows.append(remove)
        }
        let add = ItemRowView(title: Strings.AccountSwitcher.add, icon: ItemIcon(.ionicons("add-circle-outline"), tint: Palette.iconBlue)) { [weak self] in
            guard let self else { return }
            AccountAdding.begin(context: context, from: self)
        }
        add.accessibilityIdentifier = "accounts-add"
        list.sections = [ItemGroupView(rows: rows), ItemGroupView(rows: [add])]
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
    func remove(_ account: AccountSummary) {
        guard !busy else { return }; busy = true
        Task { [weak self] in
            guard let self else { return }
            defer { busy = false }
            guard await Alerts.confirm(account.isAgentConnection ? "Disconnect agent?" : "Sign out?", "Remove this account and its credentials from this phone?", confirmTitle: account.isAgentConnection ? "Disconnect" : "Sign out", destructive: true, on: self) else { return }
            await signOut(account)
        }
    }

    /// Once confirmed: the account goes, and a computer's session with it,
    /// only if it really went. A Happy account forgets nothing, since
    /// `Session.forget` also clears caches shared by every account.
    func signOut(_ account: AccountSummary) async {
        do {
            try await context.account.signOut(accountID: account.id)
            if account.isAgentConnection { Session.forget(account.id) }
        }
        catch { Alerts.show("Could not remove account", error.localizedDescription, on: self) }
    }
    private func loadImage(_ account: AccountSummary) {
        let direct = context.account.agentConnections.accounts.first { $0.id == account.id }
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