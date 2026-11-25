#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit

/// A team server's owner-only refusals, remembered per connection while
/// the app runs: the daemon has no flag that says who the owner is, so
/// the first `403 forbidden` says it, and the actions are off after that.
@MainActor
enum ProviderSignInAccess {
    private static var ownerOnly: Set<String> = []

    static func isOwnerOnly(_ connection: String) -> Bool { ownerOnly.contains(connection) }
    static func refused(_ connection: String) { ownerOnly.insert(connection) }
    /// For the tests.
    static func forget(_ connection: String) { ownerOnly.remove(connection) }
}

/// What the provider-account screens show of one computer: its Codex,
/// Claude and Grok accounts (`GET /v0/config`), how each login is doing
/// (`GET /v0/usage`) and each one's sign-in, the greater version kept.
/// Read when a screen shows, again on `config.updated` and usage events;
/// `provider_sign_in.updated` lands as it comes. Both screens watch it.
@MainActor
final class ProviderAccountsModel {
    let client: AgentClient
    let store: Store?
    let connection: String
    private(set) var accounts: [ProviderAccount]?
    private(set) var signIns: [String: ProviderSignIn] = [:]
    private(set) var health: [String: ProviderAccountHealth] = [:]
    private(set) var failed = false
    private var watchers: [UUID: () -> Void] = [:]
    private var listening: Task<Void, Never>?
    private var loading: Task<Void, Never>?
    private var loadAgain = false

    init(client: AgentClient, store: Store?, connection: String) {
        self.client = client
        self.store = store
        self.connection = connection
    }

    deinit {
        listening?.cancel()
        loading?.cancel()
    }

    var ownerOnly: Bool { ProviderSignInAccess.isOwnerOnly(connection) }

    func account(_ id: String) -> ProviderAccount? { accounts?.first { $0.id == id } }

    /// What the account is called: its configured name, else the vendor's
    /// for the vendor's own entry, else its id.
    static func name(_ account: ProviderAccount) -> String {
        account.name ?? (account.id == account.type ? ModelMenus.serviceName(account.type) : account.id)
    }

    func watch(_ watch: @escaping () -> Void) -> Watch {
        let id = UUID()
        watchers[id] = watch
        listen()
        return Watch { [weak self] in self?.watchers.removeValue(forKey: id) }
    }

    private func changed() {
        for watcher in watchers.values { watcher() }
    }

    private func listen() {
        guard listening == nil, let store else { return }
        listening = Task { @MainActor [weak self] in
            for await event in await store.events(matching: ["config.updated", ProviderSignIn.updatedEvent, "provider.usage."]) {
                guard let self, !Task.isCancelled else { return }
                if case .event(let envelope) = event, let signIn = ProviderSignIn.fromEvent(envelope) {
                    keep(signIn)
                } else {
                    load()
                }
            }
        }
    }

    func keep(_ signIn: ProviderSignIn) {
        if ProviderSignIn.keep(signIn, in: &signIns) { changed() }
    }

    /// One read at a time; asked again meanwhile, it reads once more after.
    func load() {
        guard loading == nil else { loadAgain = true; return }
        let client = client
        loading = Task { @MainActor [weak self] in
            do {
                async let health = try? client.providerAccountHealth()
                let accounts = try await client.providerAccounts()
                let read = await withTaskGroup(of: ProviderSignIn?.self) { group in
                    for account in accounts { group.addTask { try? await client.providerSignIn(account.id) } }
                    var read: [ProviderSignIn] = []
                    for await signIn in group { if let signIn { read.append(signIn) } }
                    return read
                }
                let readHealth = await health
                guard let self else { return }
                self.accounts = accounts
                failed = false
                if let readHealth { self.health = readHealth }
                for signIn in read { _ = ProviderSignIn.keep(signIn, in: &signIns) }
            } catch {
                guard let self else { return }
                failed = accounts == nil
            }
            guard let self else { return }
            loading = nil
            changed()
            if loadAgain {
                loadAgain = false
                load()
            }
        }
    }

    func refused(_ refusal: ProviderSignInRefusal) {
        if refusal == .ownerOnly { ProviderSignInAccess.refused(connection) }
        load()
    }

    /// Why `account`'s sign-in changes are off, or nil when they are on.
    func blocked(_ account: ProviderAccount) -> String? {
        if ownerOnly { return Strings.ProviderAccounts.ownerOnly }
        if signIns[account.id]?.installed == false { return Strings.ProviderAccounts.notInstalled(account.type) }
        return nil
    }

    func credential(_ account: ProviderAccount) -> ProviderCredential { signIns[account.id]?.credential ?? account.credential }

    func status(_ account: ProviderAccount) -> ProviderAccountStatus {
        ProviderAccountStatus(enabled: account.enabled, source: credential(account).source, health: health[account.id])
    }

    func plan(_ account: ProviderAccount) -> String? {
        signIns[account.id]?.account?.plan ?? health[account.id]?.planName
    }

    /// What a refusal says to the person.
    static func words(_ refusal: ProviderSignInRefusal, cli: String) -> String? {
        switch refusal {
        case .ownerOnly: Strings.ProviderAccounts.ownerOnly
        case .notInstalled: Strings.ProviderAccounts.notInstalled(cli)
        case .notSupported: Strings.ProviderAccounts.signsInOnComputer
        case .conflict: nil
        case .invalid(let message), .other(let message): message
        }
    }
}

/// The account's vendor mark on a tile, as the provider chooser draws them.
@MainActor
enum ProviderAccountMark {
    static func apply(_ type: String, to row: inout SettingsRow) {
        switch type {
        case "codex": row.icon = ("sparkles-outline", .green); row.image = codex
        case "claude": row.icon = ("sparkles-outline", .orange); row.image = claude
        default: row.icon = ("flash-outline", .gray)
        }
        row.squareImage = row.image != nil
    }

    // Drawn once: a new picture on every reload would dissolve in again.
    private static let codex = tile("icon-gpt", Palette.settingsTileGreen)
    private static let claude = tile("icon-claude", Palette.settingsTileOrange)

    private static func tile(_ name: String, _ fill: ColorToken) -> UIImage? {
        guard let mark = UIImage.happy(name) else { return nil }
        let side = SettingsLayout.Metrics.tile, size = SettingsLayout.Metrics.glyph * 0.9
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { _ in
            UIColor(fill).setFill()
            UIBezierPath(roundedRect: CGRect(x: 0, y: 0, width: side, height: side), cornerRadius: SettingsLayout.Metrics.tileRadius).fill()
            let fit = min(size / mark.size.width, size / mark.size.height)
            let drawn = CGSize(width: mark.size.width * fit, height: mark.size.height * fit)
            mark.withTintColor(.white, renderingMode: .alwaysOriginal)
                .draw(in: CGRect(x: (side - drawn.width) / 2, y: (side - drawn.height) / 2, width: drawn.width, height: drawn.height))
        }
    }
}

/// The status dot a row wears where its value goes.
final class ProviderStatusDot: UIView {
    static let side: CGFloat = 10

    var dot: ProviderAccountStatus.Dot = .grey {
        didSet { apply() }
    }

    override init(frame: CGRect) {
        super.init(frame: CGRect(x: 0, y: 0, width: Self.side, height: Self.side))
        layer.cornerRadius = Self.side / 2
        apply()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func sizeThatFits(_ size: CGSize) -> CGSize { CGSize(width: Self.side, height: Self.side) }

    private func apply() {
        backgroundColor = switch dot {
        case .green: .systemGreen
        case .amber: .systemOrange
        case .red: .systemRed
        case .grey: .systemGray3
        }
    }
}

/// Settings › Provider accounts (API.md "Provider sign-in"): a minimal
/// list of the computer's Codex, Claude and Grok accounts. Each row is
/// its vendor's mark, its name and plan, a status dot, and one line on how
/// its login is doing; a tap opens the account's own page.
final class ProviderAccountsViewController: SettingsPageViewController {
    let model: ProviderAccountsModel
    private var watch: Watch?
    private var dots: [String: ProviderStatusDot] = [:]
    private let now: () -> Date

    init(model: ProviderAccountsModel, now: @escaping () -> Date = { Date() }) {
        self.model = model
        self.now = now
        super.init(title: Strings.ProviderAccounts.title)
    }

    convenience init(session: Session) {
        self.init(model: ProviderAccountsModel(client: session.client, store: session.store, connection: session.accountID))
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "provider-accounts"
        watch = model.watch { [weak self] in self?.reload() }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        model.load()
    }

    override func makeRows() -> [[SettingsRow]] {
        typealias Text = Strings.ProviderAccounts
        guard let accounts = model.accounts else {
            return model.failed ? [[SettingsRow(id: "provider-accounts-failed", title: Text.loadFailed, accessory: .none, dimmed: true)]] : []
        }
        guard !accounts.isEmpty else {
            return [[SettingsRow(id: "provider-accounts-empty", title: Text.empty, accessory: .none, dimmed: true)]]
        }
        return [accounts.map(row).withFooter(Text.footer)]
    }

    private func row(_ account: ProviderAccount) -> SettingsRow {
        typealias Text = Strings.ProviderAccounts
        let status = model.status(account)
        let now = now()
        let title = ([ProviderAccountsModel.name(account)] + [model.plan(account)].compactMap { $0 }).joined(separator: " · ")
        var row = SettingsRow(id: "provider-account-\(account.id)", title: title, action: { [weak self] in self?.open(account) })
        ProviderAccountMark.apply(account.type, to: &row)
        let line = Text.status(status, source: model.credential(account).source, account: model.signIns[account.id]?.account, now: now)
        var lines = [line]
        if let expires = ProviderAccountStatus.expiryWarning(model.health[account.id], now: now) { lines.append(Text.expires(expires, now: now)) }
        row.subtitle = lines.joined(separator: "\n")
        row.subtitleLines = 0
        let dot = dots[account.id] ?? ProviderStatusDot()
        dots[account.id] = dot
        dot.dot = status.dot
        dot.accessibilityLabel = line
        row.valueView = dot
        return row
    }

    /// The account's own page.
    func open(_ account: ProviderAccount) {
        navigationController?.pushViewController(ProviderAccountViewController(model: model, accountId: account.id, now: now), animated: true)
    }

    /// The row's status dot, for the tests.
    func shownDot(_ id: String) -> ProviderAccountStatus.Dot? { dots[id]?.dot }
}

/// One account's page: its name, vendor and switch; how its login is
/// doing (where the credential comes from, its last renewal, its token's
/// expiry, the last renewal error); then Sign in again, and Update token
/// for Claude, with what signing in here means said under them.
final class ProviderAccountViewController: SettingsPageViewController {
    let model: ProviderAccountsModel
    let accountId: String
    private var watch: Watch?
    private let now: () -> Date

    init(model: ProviderAccountsModel, accountId: String, now: @escaping () -> Date = { Date() }) {
        self.model = model
        self.accountId = accountId
        self.now = now
        super.init(title: model.account(accountId).map(ProviderAccountsModel.name) ?? accountId)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "provider-account"
        watch = model.watch { [weak self] in
            guard let self else { return }
            if let account = model.account(accountId) { title = ProviderAccountsModel.name(account) }
            reload()
        }
    }

    override func makeRows() -> [[SettingsRow]] {
        typealias Text = Strings.ProviderAccounts
        guard let account = model.account(accountId) else { return [] }
        let now = now()
        let reason = model.blocked(account)
        let credential = model.credential(account)
        let health = model.health[account.id]
        let signIn = model.signIns[account.id]

        var head = SettingsRow(id: "provider-detail-name", title: ProviderAccountsModel.name(account), value: ModelMenus.serviceName(account.type), accessory: .none)
        ProviderAccountMark.apply(account.type, to: &head)
        head.subtitle = model.plan(account)
        var enabled = SettingsRow(id: "provider-detail-enabled", title: Text.enabled, accessory: .toggle, isOn: account.enabled,
                                  toggled: model.ownerOnly ? nil : { [weak self] on in self?.setEnabled(on) })
        enabled.dimmed = model.ownerOnly
        enabled.hint = model.ownerOnly ? Text.ownerOnly : nil

        var source = SettingsRow(id: "provider-detail-source", title: Text.source, value: Text.credential(credential.source, account: nil), accessory: .none)
        if credential.source == .internal, let who = signIn?.account, who.email != nil || who.plan != nil {
            source.subtitle = [who.email, who.plan].compactMap { $0 }.joined(separator: " · ")
        }
        var login = [source]
        if let refreshed = health?.login?.refreshedAt {
            login.append(SettingsRow(id: "provider-detail-refreshed", title: Text.lastRefresh, value: Text.ago(refreshed, now: now), accessory: .none))
        } else if health?.login != nil {
            login.append(SettingsRow(id: "provider-detail-refreshed", title: Text.lastRefresh, value: Text.never, accessory: .none))
        } else if let checked = health?.checkedAt {
            // An older daemon says only when it last read the account.
            login.append(SettingsRow(id: "provider-detail-checked", title: Text.lastChecked, value: Text.ago(checked, now: now), accessory: .none))
        }
        if let expires = health?.login?.expiresAt {
            login.append(SettingsRow(id: "provider-detail-expires", title: Text.tokenExpires, value: Text.expiry(expires, now: now), accessory: .none))
        }
        if let error = health?.login?.refreshError {
            var row = SettingsRow(id: "provider-detail-error", title: Text.lastRefreshError, accessory: .none)
            row.subtitle = Text.refreshError(error)
            row.destructive = error.permanent
            login.append(row)
        }
        login[0].header = Text.loginHeader

        let method = credential.phoneMethod(cli: account.type)
        let running = signIn?.operation.map { !$0.ended } ?? false
        var actions: [SettingsRow] = []
        // A sign-in already going (started on another device) can be joined
        // or cancelled even where this phone can't start one.
        if method != nil || running {
            var again = SettingsRow(id: "provider-sign-in-\(account.id)", title: Text.signInAgain, value: running ? Text.inProgress : nil,
                                    accessory: reason == nil ? .chevron : .none, action: reason == nil ? { [weak self] in self?.signIn() } : nil)
            again.dimmed = reason != nil
            again.hint = reason
            actions.append(again)
        }
        if credential.acceptsToken {
            var token = SettingsRow(id: "provider-token-\(account.id)", title: Text.updateToken, accessory: .none,
                                    action: reason == nil ? { [weak self] in self?.updateToken() } : nil)
            token.dimmed = reason != nil
            token.hint = reason
            actions.append(token)
        }
        let unavailable = method == nil && !running && !credential.acceptsToken ? Text.signsInOnComputer : nil
        let notes = [reason ?? unavailable, Text.footer].compactMap { $0 }.joined(separator: " ")
        guard !actions.isEmpty else {
            login[login.count - 1].footer = notes
            return [[head, enabled], login]
        }
        actions[actions.count - 1].footer = notes
        return [[head, enabled], login, actions]
    }

    // MARK: Actions

    private func setEnabled(_ on: Bool) {
        let model = model, id = accountId
        Task { @MainActor [weak self] in
            do {
                try await model.client.setProviderEnabled(id, on)
                model.load()
            } catch {
                let refusal = ProviderSignInRefusal(error)
                model.refused(refusal)
                guard let self else { return }
                reload()
                Alerts.show(Strings.ProviderAccounts.couldNotSwitch, ProviderAccountsModel.words(refusal, cli: model.account(id)?.type ?? ""), on: self)
            }
        }
    }

    func signIn() {
        guard let account = model.account(accountId) else { return }
        let model = model
        let page = AccountSignInViewController(client: model.client, store: model.store, account: account, current: model.signIns[account.id]) { signIn in
            model.keep(signIn)
            if signIn.operation?.status == .succeeded { model.load() }
        } refused: { refusal in
            model.refused(refusal)
        }
        navigationController?.pushViewController(page, animated: true)
    }

    /// Claude's setup token, typed into a secure field, sent once and kept
    /// nowhere here.
    func updateToken() {
        typealias Text = Strings.ProviderAccounts
        let alert = UIAlertController(title: Text.updateToken, message: Text.tokenMessage, preferredStyle: .alert)
        alert.addTextField { field in
            field.placeholder = Text.tokenPlaceholder
            field.isSecureTextEntry = true
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
            field.spellCheckingType = .no
            field.textContentType = .password
            field.accessibilityIdentifier = "provider-token-field"
        }
        alert.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel))
        alert.addAction(UIAlertAction(title: Text.save, style: .default) { [weak self, weak alert] _ in
            let token = (alert?.textFields?.first?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !token.isEmpty else { return }
            self?.save(token)
        })
        present(alert, animated: true)
    }

    private func save(_ token: String) {
        typealias Text = Strings.ProviderAccounts
        let model = model, id = accountId
        Task { @MainActor [weak self] in
            do {
                let signIn = try await model.client.saveProviderToken(id, token: token)
                model.keep(signIn)
                model.load()
                guard let self else { return }
                Alerts.show(Text.tokenSaved, nil, on: self)
            } catch {
                let refusal = ProviderSignInRefusal(error)
                model.refused(refusal)
                guard let self else { return }
                Alerts.show(Text.tokenFailed, ProviderAccountsModel.words(refusal, cli: model.account(id)?.type ?? ""), on: self)
            }
        }
    }
}
#endif
