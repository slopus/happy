#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
import UIKit

public final class VoiceSettingsViewController: UIViewController {
    private let context: AppContext
    private let session: AccountSession
    private let list = GroupedListView()
    private let toggles = SettingsToggleRows()
    private var observation: StoreObservation?
    private var settings = AccountSettings()
    private var usage: VoiceUsage?
    private var loading = false
    private var usageTask: Task<Void, Never>?

    public init(context: AppContext, session: AccountSession) {
        self.context = context; self.session = session
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    deinit { usageTask?.cancel() }
    public override func loadView() { view = list }
    public override func viewDidLoad() {
        super.viewDidLoad()
        title = Strings.Voice.title
        showsBackTitle()
        observation = session.store.observeSettings { [weak self] snapshot in
            self?.settings = AccountSettings(snapshot)
            self?.rebuild()
        }
        loadUsage()
    }
    public override func viewWillAppear(_ animated: Bool) { super.viewWillAppear(animated); rebuild() }

    private func loadUsage() {
        usageTask?.cancel()
        loading = true; rebuild()
        let api = session.api
        usageTask = Task { [weak self] in
            let usage = try? await api.voiceUsage()
            guard !Task.isCancelled, let self else { return }
            self.usage = usage; self.loading = false; self.rebuild()
        }
    }

    private func rebuild() {
        var usageRows: [ItemRowView] = []
        if let usage {
            usageRows = [
                ItemRowView(title: Strings.Voice.usage, detail: "\(Self.time(usage.usedSeconds)) / \(Self.time(usage.limitSeconds))"),
                ItemRowView(title: Strings.Voice.conversations, detail: "\(usage.conversationCount) / \(usage.conversationLimit)"),
            ]
        } else {
            let row = ItemRowView(title: loading ? Strings.Voice.connecting : Strings.Voice.unavailable) { [weak self] in self?.loadUsage() }
            row.isLoading = loading
            usageRows = [row]
        }
        let language = ItemRowView(title: Strings.Voice.preferredLanguage, subtitle: Strings.Voice.preferredLanguageSubtitle,
                                  detail: VoiceLanguage.selection(settings.string("voiceAssistantLanguage")).name,
                                  icon: ItemIcon(.ionicons("language-outline"), tint: Palette.iconBlue)) { [weak self] in
            guard let self else { return }; self.push(.settingsVoiceLanguage, context: self.context)
        }
        let upgrade = ItemRowView(title: Strings.Voice.upgrade, subtitle: Strings.Voice.upgradeSubtitle,
                                 icon: ItemIcon(.ionicons("heart-outline"), tint: Palette.iconRed)) { [weak self] in
            guard let self else { return }; self.push(.supportUs, context: self.context)
        }
        let custom = ItemRowView(title: Strings.Voice.agentID, subtitle: settings.string("voiceCustomAgentId") ?? Strings.Voice.notConfigured,
                                icon: ItemIcon(.ionicons("key-outline"), tint: Palette.iconOrange)) { [weak self] in self?.editAgent() }
        let direct = toggles.row("voiceBypassToken", title: Strings.Voice.direct, subtitle: Strings.Voice.directSubtitle,
                                 icon: ItemIcon(.ionicons("flash-outline"), tint: Palette.iconRed), isOn: settings.bool("voiceBypassToken")) { [weak self] enabled in
            self?.set(["voiceBypassToken": .bool(enabled)])
        }
        list.sections = [
            ItemGroupView(title: Strings.Voice.usageTitle, footer: Strings.Voice.usageFooter, rows: usageRows),
            ItemGroupView(rows: [upgrade]),
            ItemGroupView(title: Strings.Voice.languageTitle, footer: Strings.Voice.languageDescription, rows: [language]),
            ItemGroupView(title: Strings.Voice.byo, footer: Strings.Voice.byoDescription, rows: [custom, direct]),
        ]
        for group in list.sections.compactMap({ $0 as? ItemGroupView }) {
            for case let row as ItemRowView in group.rows {
                row.titleLabel.numberOfLines = 0
                row.subtitleLabel.numberOfLines = 0
            }
        }
        list.setNeedsLayout()
    }

    private func set(_ delta: [String: JSONValue]) {
        settings = settings.applying(delta)
        session.updateSettings(delta)
        rebuild()
    }
    private func editAgent() {
        Task { [weak self] in
            guard let self else { return }
            guard let value = await Alerts.prompt(Strings.Voice.agentID, Strings.Voice.agentDescription,
                                                   placeholder: settings.string("voiceCustomAgentId") ?? "agent_…", confirmTitle: Strings.Common.save, on: self) else { return }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            self.set(["voiceCustomAgentId": trimmed.isEmpty ? .null : .string(trimmed), "voiceBypassToken": .bool(!trimmed.isEmpty)])
        }
    }
    private static func time(_ seconds: Int) -> String { "\(max(0, seconds) / 60)m \(max(0, seconds) % 60)s" }
}

public final class VoiceLanguageViewController: UITableViewController, UISearchResultsUpdating {
    private let session: AccountSession
    private var observation: StoreObservation?
    private var preferred: String?
    private var languages = VoiceLanguage.all
    private let search = UISearchController(searchResultsController: nil)

    public init(session: AccountSession) {
        self.session = session
        super.init(style: .insetGrouped)
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    public override func viewDidLoad() {
        super.viewDidLoad()
        title = Strings.Voice.languageTitle
        showsBackTitle()
        search.obscuresBackgroundDuringPresentation = false
        search.searchResultsUpdater = self
        search.searchBar.placeholder = Strings.Voice.search
        navigationItem.searchController = search
        definesPresentationContext = true
        observation = session.store.observeSettings { [weak self] snapshot in
            self?.preferred = AccountSettings(snapshot).string("voiceAssistantLanguage")
            self?.tableView.reloadData()
        }
    }
    public func updateSearchResults(for searchController: UISearchController) {
        let query = searchController.searchBar.text ?? ""
        languages = VoiceLanguage.all.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || ($0.code?.localizedCaseInsensitiveContains(query) ?? false) }
        tableView.reloadData()
    }
    public override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { languages.count }
    public override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "language") ?? UITableViewCell(style: .subtitle, reuseIdentifier: "language")
        let language = languages[indexPath.row]
        var content = cell.defaultContentConfiguration()
        content.text = language.name; content.secondaryText = language.code
        content.image = UIImage.icon(.ionicons("language-outline"), size: 24)
        cell.contentConfiguration = content
        cell.accessoryType = language.code == preferred ? .checkmark : .none
        return cell
    }
    public override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        let language = languages[indexPath.row]
        session.updateSettings(["voiceAssistantLanguage": language.code.map(JSONValue.string) ?? .null])
        navigationController?.popViewController(animated: true)
    }
}
#endif
