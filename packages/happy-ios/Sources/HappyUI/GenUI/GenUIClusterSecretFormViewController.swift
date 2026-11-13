#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The Happy Cloud secret form a Gen UI `cluster_secret` element opens
/// (SPEC.md, "Secret actions"; the cluster's API.md, "Gen UI actions"), in
/// a sheet of its own: the fields of the action's type, prefilled, every
/// one changeable but the type, and the values the type asks for. When the
/// action names a stored secret the form changes it, and an endpoint's or
/// environment secret's value left empty keeps the stored one.
///
/// Saving sends the form once, under a retry key kept until the form
/// changes; the cluster stores it, grants it to the agent and tells it.
/// What the cluster refused is said in its words, which name fields and
/// never values. Typed values live in this page's fields and that request.
final class GenUIClusterSecretFormViewController: SettingsPageViewController, UITextFieldDelegate {
    typealias Text = Strings.GenUIClusterSecret

    private let client: AgentClient
    private let artifactId: String
    private let version: Int
    private let element: String
    private let prefill: GenUIClusterSecretPrefill
    /// The secret this element saved before, which it opens on.
    private let savedId: String?
    private let onSaved: (GenUIClusterSecretSaved) -> Void
    private var draft: GenUIClusterSecretDraft
    private var fields: [String: UITextField] = [:]
    private var loading: Task<Void, Never>?
    private var isLoading = false
    private var saving = false
    private var tried = false
    private var retry: String?
    private var saved: GenUIClusterSecretSaved?

    init(client: AgentClient, artifactId: String, version: Int, element: String, prefill: GenUIClusterSecretPrefill, savedId: String?,
         onSaved: @escaping (GenUIClusterSecretSaved) -> Void) {
        self.client = client
        self.artifactId = artifactId
        self.version = version
        self.element = element
        self.prefill = prefill
        self.savedId = savedId
        self.onSaved = onSaved
        draft = GenUIClusterSecretDraft(prefill)
        super.init(title: Text.newTitle)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "genui-cluster-secret-form"
        scroll.keyboardDismissMode = .interactive
        navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.close() })
        navigationItem.leftBarButtonItem?.accessibilityIdentifier = "genui-secret-cancel"
        showSave()
        // The stored secret the action names, or the one this element made.
        guard let id = prefill.id ?? savedId else { return }
        isLoading = true
        loading = Task { [weak self, client, prefill] in
            let stored = (try? await client.clusterSecret(id)) ?? nil
            guard !Task.isCancelled, let self else { return }
            self.isLoading = false
            if let stored, stored.type == prefill.kind.rawValue {
                if prefill.id != nil { self.draft.adopt(stored, suggested: prefill) } else { self.draft.reopen(stored) }
            }
            self.reload()
            self.showSave()
        }
    }

    deinit { loading?.cancel() }

    // MARK: Rows

    private func field(_ id: String, header: String? = nil, footer: String? = nil, missing: Bool = false) -> SettingsRow {
        var row = SettingsRow(id: id, title: "", accessory: .none, action: { [weak self] in self?.fields[id]?.becomeFirstResponder() })
        row.header = header
        row.footer = footer
        if missing { row.subtitle = Text.valueMissing; row.destructive = true }
        return row
    }

    private func removeRow(_ id: String, _ remove: @escaping (inout GenUIClusterSecretDraft) -> Void) -> SettingsRow {
        var row = SettingsRow(id: id, title: Text.remove, icon: ("trash", .action), accessory: .none, action: { [weak self] in self?.edit(remove) })
        row.destructive = true
        return row
    }

    private func addRow(_ id: String, _ title: String, footer: String? = nil, _ add: @escaping (inout GenUIClusterSecretDraft) -> Void) -> SettingsRow {
        var row = SettingsRow(id: id, title: title, icon: ("add", .action), accessory: .none, action: { [weak self] in self?.edit(add) })
        row.footer = footer
        return row
    }

    override func makeRows() -> [[SettingsRow]] {
        if let saved { return completion(saved) }
        if isLoading { return [[SettingsRow(id: "loading", title: Text.loading, accessory: .none)]] }
        let problems = tried ? draft.problems : []
        let keeps = draft.keepsEmptyValues
        var cards: [[SettingsRow]] = []
        cards.append([field("name", header: Text.name, footer: problems.contains(.name) ? Text.nameProblem : nil)])
        cards.append([field("description", header: Text.description, footer: problems.contains(.description) ? Text.descriptionProblem : nil)])
        if !draft.changing {
            var owner = SettingsRow(id: "owner", title: Text.owner, value: draft.owner == .team ? Text.team : Text.me, accessory: .chevron)
            owner.pullDown = { [weak self] in self?.ownerMenu() }
            owner.footer = Text.ownerNote
            cards.append([owner])
        }
        var uses = draft.kind.uses.sorted().map { use in
            SettingsRow(id: "use-\(use)", title: Text.use(use), accessory: .toggle, isOn: draft.uses.contains(use), toggled: { [weak self] on in
                self?.edit { if on { $0.uses.insert(use) } else { $0.uses.remove(use) } }
            })
        }
        uses[0].header = Text.uses
        uses[uses.count - 1].footer = problems.contains(.uses) ? Text.usesProblem : nil
        cards.append(uses)

        switch draft.kind {
        case .endpoint:
            for (index, target) in draft.targets.enumerated() {
                var card = [field("target-\(target.id)-host", header: index == 0 ? Text.targets : nil), field("target-\(target.id)-ports"),
                            field("target-\(target.id)-paths"), field("target-\(target.id)-methods")]
                if draft.targets.count > 1 { card.append(removeRow("target-\(target.id)-remove") { $0.removeTarget(target.id) }) }
                cards.append(card)
            }
            cards.append([addRow("target-add", Text.addTarget, footer: problems.contains(.targets) ? Text.targetsProblem : Text.targetsNote) { $0.addTarget() }])
            for (index, header) in draft.headers.enumerated() {
                var card = [field("header-\(header.id)-name", header: index == 0 ? Text.headers : nil), field("header-\(header.id)-prefix"),
                            field("header-\(header.id)-value", missing: tried && header.value.isEmpty && !keeps)]
                if draft.headers.count > 1 { card.append(removeRow("header-\(header.id)-remove") { $0.removeHeader(header.id) }) }
                cards.append(card)
            }
            cards.append([addRow("header-add", Text.addHeader, footer: problems.contains(.headers) ? Text.headersProblem : Text.headersNote) { $0.addHeader() }])
        case .sshKey:
            cards.append([field("hosts", header: Text.sshHosts, footer: problems.contains(.hosts) ? Text.hostsProblem : nil),
                          field("ssh-ports", footer: problems.contains(.port) ? Text.portProblem : nil)])
            cards.append(knownHostsCard())
            cards.append(keyCard(problems))
        case .gitCredential:
            cards.append([field("server", header: Text.server, footer: problems.contains(.server) ? Text.serverProblem : nil),
                          field("port", footer: problems.contains(.port) ? Text.portProblem : nil)])
            var method = SettingsRow(id: "method", title: Text.method, value: Text.method(draft.method), accessory: .chevron)
            method.pullDown = { [weak self] in self?.methodMenu() }
            var methodCard = [method]
            switch draft.method {
            case .sshKey: break
            case .password, .token: methodCard.append(field("username"))
            }
            methodCard[methodCard.count - 1].footer = Text.methodNote(draft.method)
            cards.append(methodCard)
            var access = [field("repos", header: Text.access)]
            for operation in ["read", "write", "sign"] where operation != "sign" || draft.method == .sshKey {
                access.append(SettingsRow(id: "op-\(operation)", title: Text.operation(operation), accessory: .toggle, isOn: draft.operations.contains(operation),
                                          toggled: { [weak self] on in self?.edit { if on { $0.operations.insert(operation) } else { $0.operations.remove(operation) } } }))
            }
            cards.append(access)
            if draft.method == .sshKey { cards.append(knownHostsCard()) }
            switch draft.method {
            case .sshKey: cards.append(keyCard(problems))
            case .password: cards.append([field("password", header: Text.values, footer: Text.valuesNote, missing: tried && draft.password.isEmpty)])
            case .token: cards.append([field("token", header: Text.values, footer: Text.valuesNote, missing: tried && draft.token.isEmpty)])
            }
        case .environment:
            for (index, variable) in draft.variables.enumerated() {
                var card = [field("variable-\(variable.id)-name", header: index == 0 ? Text.variables : nil),
                            field("variable-\(variable.id)-value", missing: tried && variable.value.isEmpty && !(variable.stored && keeps))]
                if draft.variables.count > 1 { card.append(removeRow("variable-\(variable.id)-remove") { $0.removeVariable(variable.id) }) }
                cards.append(card)
            }
            cards.append([addRow("variable-add", Text.addVariable, footer: problems.contains(.variables) ? Text.variablesProblem : nil) { $0.addVariable() }])
        }
        var about = [Text.about]
        if draft.changing { about.insert(draft.movesValues ? Text.moves : Text.changes, at: 0) }
        if draft.resaving { about.insert(Text.resaving, at: 0) }
        cards[cards.count - 1][cards[cards.count - 1].count - 1].footer = ([cards.last?.last?.footer].compactMap { $0 } + about).joined(separator: "\n\n")
        return cards
    }

    private func knownHostsCard() -> [SettingsRow] {
        var card = draft.knownHosts.indices.map { index in field("known-\(index)", header: index == 0 ? Text.knownHosts : nil) }
        var add = SettingsRow(id: "known-add", title: Text.addKnownHost, icon: ("add", .action), accessory: .none, action: { [weak self] in
            self?.edit { $0.knownHosts.append("") }
            if let last = self?.draft.knownHosts.indices.last { self?.fields["known-\(last)"]?.becomeFirstResponder() }
        })
        if card.isEmpty { add.header = Text.knownHosts }
        add.footer = Text.knownHostsNote
        card.append(add)
        return card
    }

    private func keyCard(_ problems: Set<GenUIClusterSecretDraft.Problem>) -> [SettingsRow] {
        [field("private-key", header: Text.values, missing: tried && problems.contains(.value) && draft.privateKey.isEmpty),
         field("passphrase", footer: Text.keyNote)]
    }

    private func ownerMenu() -> UIMenu {
        UIMenu(children: [GenUIClusterSecretPrefill.Owner.me, .team].map { owner in
            UIAction(title: owner == .team ? Text.team : Text.me, state: draft.owner == owner ? .on : .off) { [weak self] _ in self?.edit { $0.owner = owner } }
        })
    }

    private func methodMenu() -> UIMenu {
        UIMenu(children: GenUIClusterSecretDraft.Method.allCases.map { method in
            UIAction(title: Text.method(method), state: draft.method == method ? .on : .off) { [weak self] _ in
                self?.edit {
                    $0.method = method
                    if method != .sshKey { $0.operations.remove("sign") }
                }
            }
        })
    }

    private func completion(_ saved: GenUIClusterSecretSaved) -> [[SettingsRow]] {
        let name = saved.secret?.name ?? draft.name
        var row = SettingsRow(id: "saved", title: changed ? Text.updated(name) : Text.added(name), icon: ("checkmark-circle", .green), accessory: .none)
        row.footer = saved.granted ? Text.told : Text.toldUngranted
        return [[row]]
    }

    /// Whether the save changed a secret rather than made one.
    private var changed: Bool { draft.changing || draft.resaving }

    override func reload() {
        super.reload()
        guard isViewLoaded else { return }
        if let saved { title = changed ? Text.updatedTitle : Text.addedTitle; _ = saved }
        else { title = draft.changing || draft.resaving ? Text.changeTitle : Text.newTitle }
        syncFields()
    }

    // MARK: Fields

    private struct Spec {
        var text: String
        var placeholder: String
        /// What a field of several in a card holds, before it.
        var label: String?
        var mono = false
        var secret = false
        var caps: UITextAutocapitalizationType = .none
        var keyboard: UIKeyboardType = .default
    }

    private func specs() -> [String: Spec] {
        guard saved == nil, !isLoading else { return [:] }
        let keeps = draft.keepsEmptyValues
        var specs: [String: Spec] = [
            "name": Spec(text: draft.name, placeholder: Text.namePlaceholder, caps: .words),
            "description": Spec(text: draft.description, placeholder: Text.descriptionPlaceholder, caps: .sentences),
        ]
        switch draft.kind {
        case .endpoint:
            for target in draft.targets {
                specs["target-\(target.id)-host"] = Spec(text: target.host, placeholder: Text.hostPlaceholder, mono: true, keyboard: .URL)
                specs["target-\(target.id)-ports"] = Spec(text: target.ports, placeholder: Text.portsPlaceholder, label: Text.portsLabel, mono: true, keyboard: .numbersAndPunctuation)
                specs["target-\(target.id)-paths"] = Spec(text: target.paths, placeholder: Text.pathsPlaceholder, label: Text.pathsLabel, mono: true, keyboard: .URL)
                specs["target-\(target.id)-methods"] = Spec(text: target.methods, placeholder: Text.methodsPlaceholder, label: Text.methodsLabel, mono: true, caps: .allCharacters)
            }
            for header in draft.headers {
                specs["header-\(header.id)-name"] = Spec(text: header.name, placeholder: Text.headerPlaceholder, mono: true)
                specs["header-\(header.id)-prefix"] = Spec(text: header.prefix, placeholder: Text.prefixPlaceholder, label: Text.prefixLabel, mono: true)
                specs["header-\(header.id)-value"] = Spec(text: header.value, placeholder: keeps ? Text.keepPlaceholder : Text.valueOf(header.name), secret: true)
            }
        case .sshKey:
            specs["hosts"] = Spec(text: draft.hosts, placeholder: Text.hostsPlaceholder, mono: true, keyboard: .URL)
            specs["ssh-ports"] = Spec(text: draft.sshPorts, placeholder: Text.sshPortsPlaceholder, label: Text.portsLabel, mono: true, keyboard: .numbersAndPunctuation)
        case .gitCredential:
            specs["server"] = Spec(text: draft.server, placeholder: Text.serverPlaceholder, mono: true, keyboard: .URL)
            specs["port"] = Spec(text: draft.port, placeholder: Text.portPlaceholder, label: Text.portLabel, mono: true, keyboard: .numberPad)
            specs["username"] = Spec(text: draft.username, placeholder: Text.usernamePlaceholder(draft.method), label: Text.usernameLabel, mono: true)
            specs["repos"] = Spec(text: draft.repos, placeholder: Text.reposPlaceholder, label: Text.reposLabel, mono: true)
            specs["password"] = Spec(text: draft.password, placeholder: Text.passwordPlaceholder, secret: true)
            specs["token"] = Spec(text: draft.token, placeholder: Text.tokenPlaceholder, secret: true)
        case .environment:
            for variable in draft.variables {
                specs["variable-\(variable.id)-name"] = Spec(text: variable.name, placeholder: Text.variablePlaceholder, mono: true, caps: .allCharacters, keyboard: .asciiCapable)
                specs["variable-\(variable.id)-value"] = Spec(text: variable.value, placeholder: variable.stored && keeps ? Text.keepPlaceholder : Text.valueOf(variable.name), secret: true)
            }
        }
        if draft.asksKey {
            for (index, line) in draft.knownHosts.enumerated() { specs["known-\(index)"] = Spec(text: line, placeholder: Text.knownHostPlaceholder, mono: true) }
            specs["private-key"] = Spec(text: draft.privateKey, placeholder: Text.keyPlaceholder, secret: true)
            specs["passphrase"] = Spec(text: draft.passphrase, placeholder: Text.passphrasePlaceholder, label: Text.passphraseLabel, secret: true)
        }
        return specs
    }

    private func syncFields() {
        let wanted = specs()
        let shown = Set(rows.joined().map(\.id))
        for (id, field) in fields where wanted[id] == nil || !shown.contains(id) {
            field.text = nil
            field.removeFromSuperview()
            fields[id] = nil
        }
        // The labels line up: each as wide as the widest.
        let font = SettingsCardView.RowView.titleFont
        let labelWidth = wanted.values.compactMap(\.label).map { ($0 as NSString).size(withAttributes: [.font: font]).width.rounded(.up) }.max().map { $0 + 12 } ?? 0
        for (id, spec) in wanted where shown.contains(id) {
            let field = fields[id] ?? makeField(id, spec)
            if !field.isFirstResponder, field.text != spec.text { field.text = spec.text }
            field.placeholder = spec.placeholder
            field.accessibilityLabel = spec.label ?? spec.placeholder
            field.isEnabled = !saving
            if let label = spec.label {
                let view = field.leftView as? FieldLabel ?? FieldLabel()
                view.text = label
                view.font = font
                view.textColor = UIColor(Palette.settingsSecondary)
                view.width = labelWidth
                view.invalidateIntrinsicContentSize()
                field.leftView = view
                field.leftViewMode = .always
            }
        }
        view.setNeedsLayout()
    }

    /// A field's label, as wide as the card's widest: a text field sizes
    /// its left view by its intrinsic size.
    private final class FieldLabel: UILabel {
        var width: CGFloat = 0
        override var intrinsicContentSize: CGSize { CGSize(width: width, height: super.intrinsicContentSize.height) }
        override func sizeThatFits(_ size: CGSize) -> CGSize { CGSize(width: width, height: super.sizeThatFits(size).height) }
    }

    private func makeField(_ id: String, _ spec: Spec) -> UITextField {
        let field = UITextField()
        field.font = spec.mono ? Fonts.mono(bold: false, size: 16) : SettingsCardView.RowView.titleFont
        field.textColor = UIColor(Palette.settingsText)
        field.tintColor = UIColor(Palette.settingsPrimary)
        field.autocapitalizationType = spec.caps
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.smartQuotesType = .no
        field.smartDashesType = .no
        field.keyboardType = spec.keyboard
        // A value is typed and sent once: hidden, never suggested or remembered.
        field.isSecureTextEntry = spec.secret
        field.textContentType = spec.secret ? .oneTimeCode : nil
        field.clearButtonMode = .whileEditing
        field.returnKeyType = .next
        field.accessibilityIdentifier = "genui-secret-\(id)"
        field.delegate = self
        field.addTarget(self, action: #selector(edited(_:)), for: .editingChanged)
        scroll.addSubview(field)
        fields[id] = field
        return field
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        for (id, field) in fields { field.frame = titleFrame(id) ?? .zero }
    }

    // MARK: Editing

    private func edit(_ change: (inout GenUIClusterSecretDraft) -> Void) {
        change(&draft)
        retry = nil
        reload()
        showSave()
    }

    /// A typed change: the page again only where it changes what shows.
    @objc private func edited(_ field: UITextField) {
        guard let id = fields.first(where: { $0.value === field })?.key else { return }
        let text = field.text ?? ""
        let before = (draft.changing, draft.movesValues, draft.keepsEmptyValues)
        set(id, text)
        retry = nil
        if tried || before != (draft.changing, draft.movesValues, draft.keepsEmptyValues) { reload() }
        showSave()
    }

    private func set(_ id: String, _ text: String) {
        let parts = id.split(separator: "-").map(String.init)
        switch parts.first {
        case "name": draft.name = text
        case "description": draft.description = text
        case "hosts": draft.hosts = text
        case "ssh": draft.sshPorts = text
        case "server": draft.server = text
        case "port": draft.port = text
        case "username": draft.username = text
        case "repos": draft.repos = text
        case "password": draft.password = text
        case "token": draft.token = text
        case "private": draft.privateKey = text
        case "passphrase": draft.passphrase = text
        case "known":
            if let index = Int(parts[1]), draft.knownHosts.indices.contains(index) { draft.knownHosts[index] = text }
        case "target":
            guard let row = Int(parts[1]), let index = draft.targets.firstIndex(where: { $0.id == row }) else { return }
            switch parts[2] {
            case "host": draft.targets[index].host = text
            case "ports": draft.targets[index].ports = text
            case "paths": draft.targets[index].paths = text
            default: draft.targets[index].methods = text
            }
        case "header":
            guard let row = Int(parts[1]), let index = draft.headers.firstIndex(where: { $0.id == row }) else { return }
            switch parts[2] {
            case "name": draft.headers[index].name = text
            case "prefix": draft.headers[index].prefix = text
            default: draft.headers[index].value = text
            }
        case "variable":
            guard let row = Int(parts[1]), let index = draft.variables.firstIndex(where: { $0.id == row }) else { return }
            if parts[2] == "name" { draft.variables[index].name = text.trimmingCharacters(in: .whitespaces) } else { draft.variables[index].value = text }
        default: break
        }
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        let order = rows.joined().map(\.id).filter { fields[$0] != nil }
        guard let id = fields.first(where: { $0.value === textField })?.key, let index = order.firstIndex(of: id) else { return false }
        if index + 1 < order.count { fields[order[index + 1]]?.becomeFirstResponder() } else { save() }
        return false
    }

    // MARK: Saving

    private func showSave() {
        if saved != nil {
            navigationItem.leftBarButtonItem = nil
            navigationItem.rightBarButtonItem = UIBarButtonItem(title: Text.done, style: .done, target: self, action: #selector(finished))
            navigationItem.rightBarButtonItem?.accessibilityIdentifier = "genui-secret-done"
            return
        }
        if saving {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            navigationItem.rightBarButtonItem = UIBarButtonItem(customView: spinner)
            return
        }
        let button = UIBarButtonItem(title: Strings.Common.save, primaryAction: UIAction { [weak self] _ in self?.save() })
        button.style = .done
        button.accessibilityIdentifier = "genui-secret-save"
        button.isEnabled = !isLoading
        navigationItem.rightBarButtonItem = button
    }

    @objc private func finished() { dismiss(animated: true) }

    private func save() {
        tried = true
        guard draft.problems.isEmpty, !isLoading, !saving else {
            reload()
            return
        }
        saving = true
        reload()
        showSave()
        let id = retry ?? ClientID.make()
        retry = id
        let body = draft.body()
        Task { @MainActor [weak self, client, artifactId, version, element] in
            do {
                let done = try await client.saveClusterSecretAction(artifactId: artifactId, version: version, element: element, id: id, secret: body)
                self?.finish(done)
            } catch {
                guard let self else { return }
                self.saving = false
                self.reload()
                self.showSave()
                Alerts.show(Text.failedTitle, Self.words(error), on: self)
            }
        }
    }

    /// The cluster's words, which name fields and never values; this app's
    /// where it gave none.
    static func words(_ error: any Error) -> String {
        guard case .status(let status, let code, let message) = error as? AgentClientError else { return Text.failed }
        if status == 409, code == "no_origin" { return Text.noOrigin }
        if status == 403 { return message ?? Text.forbidden }
        if let message, !message.isEmpty { return message }
        return status == 404 ? Text.unavailable : Text.failed
    }

    private func finish(_ done: GenUIClusterSecretSaved) {
        view.endEditing(true)
        draft.forget()
        for field in fields.values { field.text = nil }
        saving = false
        retry = nil
        saved = done
        onSaved(done)
        reload()
        showSave()
        UIAccessibility.post(notification: .screenChanged, argument: nil)
    }

    private func close() {
        loading?.cancel()
        draft.forget()
        for field in fields.values { field.text = nil }
        dismiss(animated: true)
    }
}
#endif
