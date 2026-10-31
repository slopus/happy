#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
import UIKit

/// Settings › Voice Assistant (app/(app)/settings/voice.tsx) in settings'
/// cards: the last 30 days' voice time, Upgrade Voice, the language the
/// assistant answers in, and an ElevenLabs agent of one's own. Every value
/// is the Happy account's synced setting, which `VoiceContext` reads when
/// the microphone is pressed; an agent connection has no voice, so the page
/// is a Happy account's alone.
final class VoiceSettingsViewController: SettingsPageViewController {
    private let context: AppContext
    private let session: AccountSession
    private var observation: StoreObservation?
    private var settings = AccountSettings()
    private var usage: VoiceUsage?
    private var loading = false
    private var usageTask: Task<Void, Never>?
    /// Tests stand in for the server.
    var loadsUsage = true

    init(context: AppContext, session: AccountSession) {
        self.context = context
        self.session = session
        super.init(title: Strings.Voice.title)
    }

    deinit { usageTask?.cancel() }

    override func viewDidLoad() {
        super.viewDidLoad()
        observation = session.store.observeSettings { [weak self] snapshot in
            let settings = AccountSettings(snapshot)
            guard let self, settings != self.settings else { return }
            self.settings = settings
            reload()
        }
        if loadsUsage { loadUsage() }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // The language may have changed on the page pushed from here.
        reload()
    }

    private func loadUsage() {
        usageTask?.cancel()
        loading = true
        reload()
        let api = session.api
        usageTask = Task { [weak self] in
            let usage = try? await api.voiceUsage()
            guard !Task.isCancelled, let self else { return }
            self.usage = usage
            loading = false
            reload()
        }
    }

    override func makeRows() -> [[SettingsRow]] {
        typealias Row = SettingsRow
        typealias Text = Strings.Voice
        let usageRows: [Row]
        if let usage {
            usageRows = [
                Row(id: "voice-time", title: Text.usage, icon: ("time-outline", .orange), value: "\(Self.time(usage.usedSeconds)) / \(Self.time(usage.limitSeconds))", accessory: .none),
                Row(id: "voice-conversations", title: Text.conversations, icon: ("chatbubbles-outline", .orange), value: "\(usage.conversationCount) / \(usage.conversationLimit)", accessory: .none),
            ]
        } else {
            // Tapped, it asks again.
            usageRows = [Row(id: "voice-usage-retry", title: loading ? Text.connecting : Text.unavailable, icon: ("time-outline", .orange), value: loading ? nil : Text.retry, accessory: .none, action: loading ? nil : { [weak self] in self?.loadUsage() }, dimmed: loading)]
        }
        let language = VoiceLanguage.selection(settings.string("voiceAssistantLanguage"))
        let agentID = settings.string("voiceCustomAgentId")
        return [
            usageRows.withFooter("\(Text.usageTitle). \(Text.usageFooter)"),
            [Row(id: "voice-upgrade", title: Text.upgrade, icon: ("heart-outline", .red), action: { [weak self] in
                self?.navigationController?.pushViewController(SupportUsViewController(), animated: true)
            }, footer: Text.upgradeSubtitle)],
            [Row(id: "voice-language", title: Text.preferredLanguage, icon: ("language-outline", .blue), value: language.name, action: { [weak self] in
                guard let self else { return }
                navigationController?.pushViewController(VoiceLanguageViewController(session: session), animated: true)
            }, footer: Text.languageDescription)],
            [
                Row(id: "voice-agent-id", title: Text.agentID, icon: ("key-outline", .orange), value: agentID ?? Text.notConfigured, accessory: .none, action: { [weak self] in self?.editAgent() }),
                Row(id: "voice-direct", title: Text.direct, icon: ("flash-outline", .red), accessory: .toggle, isOn: settings.bool("voiceBypassToken"), toggled: { [weak self] on in
                    self?.set(["voiceBypassToken": .bool(on)])
                }),
            ].withFooter("\(Text.directSubtitle).\n\n\(Text.byo): \(Text.byoDescription)"),
        ]
    }

    /// Shown at once; the store echoes the same value back.
    private func set(_ delta: [String: JSONValue]) {
        settings = settings.applying(delta)
        session.updateSettings(delta)
        reload()
    }

    /// An ID turns the direct connection on, none turns it off, as voice.tsx.
    private func editAgent() {
        Task { [weak self] in
            guard let self else { return }
            guard let value = await Alerts.prompt(Strings.Voice.agentID, Strings.Voice.agentDescription,
                                                  placeholder: settings.string("voiceCustomAgentId") ?? "agent_…", confirmTitle: Strings.Common.save, on: self) else { return }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            set(["voiceCustomAgentId": trimmed.isEmpty ? .null : .string(trimmed), "voiceBypassToken": .bool(!trimmed.isEmpty)])
        }
    }

    private static func time(_ seconds: Int) -> String { "\(max(0, seconds) / 60)m \(max(0, seconds) % 60)s" }
}

/// Voice › Preferred Language: every language the assistant speaks, the
/// chosen one ticked, narrowed by the bar's search; a choice goes back.
final class VoiceLanguageViewController: SettingsPageViewController, UISearchResultsUpdating {
    private let session: AccountSession
    private var observation: StoreObservation?
    private var preferred: String?
    private var query = ""
    private let search = UISearchController(searchResultsController: nil)

    init(session: AccountSession) {
        self.session = session
        super.init(title: Strings.Voice.languageTitle)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        search.obscuresBackgroundDuringPresentation = false
        search.searchResultsUpdater = self
        search.searchBar.placeholder = Strings.Voice.search
        navigationItem.searchController = search
        navigationItem.hidesSearchBarWhenScrolling = false
        definesPresentationContext = true
        observation = session.store.observeSettings { [weak self] snapshot in
            self?.preferred = AccountSettings(snapshot).string("voiceAssistantLanguage")
            self?.reload()
        }
    }

    func updateSearchResults(for searchController: UISearchController) {
        query = searchController.searchBar.text ?? ""
        reload()
    }

    override func makeRows() -> [[SettingsRow]] {
        let languages = VoiceLanguage.all.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || ($0.code?.localizedCaseInsensitiveContains(query) ?? false) }
        return [languages.map { language in
            SettingsRow(id: "voice-language:\(language.code ?? "auto")", title: language.name, value: language.code == preferred ? "✓" : language.code, accessory: .none, action: { [weak self] in
                self?.choose(language)
            })
        }]
    }

    private func choose(_ language: VoiceLanguage) {
        preferred = language.code
        session.updateSettings(["voiceAssistantLanguage": language.code.map(JSONValue.string) ?? .null])
        search.isActive = false
        navigationController?.popViewController(animated: true)
    }
}
#endif
