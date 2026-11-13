#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The Happy Agent secret form a Gen UI `secret` element opens (SPEC.md,
/// "Secret actions"), in a sheet of its own: the action's prefill, every
/// field of it changeable, and a value typed for each variable. When the
/// name is a stored secret it changes that one, and a value left empty
/// keeps what is stored.
///
/// Saving sends the form once, through the version's actions route, under
/// a retry key kept until the form changes; the computer stores it, gives
/// the agent access and tells it. Values live in this page's fields and
/// that one request: never kept, logged or shown. What the save did is
/// said here, and the element is marked (`onSaved`).
final class GenUISecretFormViewController: SettingsPageViewController, UITextFieldDelegate {
    typealias Text = Strings.GenUISecret

    private let client: AgentClient
    private let artifactId: String
    private let version: Int
    private let element: String
    private let onSaved: (GenUISecretSaved) -> Void
    private var draft: GenUISecretDraft
    private var fields: [String: UITextField] = [:]
    private var checking: Task<Void, Never>?
    private var isChecking = false
    private var saving = false
    /// Problems are said once a save was tried.
    private var tried = false
    /// The retry key of the last save that didn't answer; any change makes another save.
    private var retry: String?
    private var saved: GenUISecretSaved?

    /// `name`: the secret this element saved before, which it opens on.
    init(client: AgentClient, artifactId: String, version: Int, element: String, prefill: GenUISecretPrefill, name: String?, onSaved: @escaping (GenUISecretSaved) -> Void) {
        self.client = client
        self.artifactId = artifactId
        self.version = version
        self.element = element
        self.onSaved = onSaved
        draft = GenUISecretDraft(prefill, name: name)
        super.init(title: Text.newTitle)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "genui-secret-form"
        scroll.keyboardDismissMode = .interactive
        navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.close() })
        navigationItem.leftBarButtonItem?.accessibilityIdentifier = "genui-secret-cancel"
        showSave()
        check(draft.name, at: .now)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard saved == nil else { return }
        // The first value to type, else the name.
        let first = draft.rows.first { draft.missing($0) }.map { "value-\($0.id)" } ?? "name"
        fields[first]?.becomeFirstResponder()
    }

    deinit { checking?.cancel() }

    // MARK: Rows

    override func makeRows() -> [[SettingsRow]] {
        if let saved { return completion(saved) }
        let problems = tried ? draft.problems : []
        var name = SettingsRow(id: "name", title: "", accessory: .none)
        name.header = Text.name
        name.footer = nameNote(problems)
        var description = SettingsRow(id: "description", title: "", accessory: .none)
        description.header = Text.description
        if problems.contains(.description) { description.footer = Text.descriptionProblem }
        var cards: [[SettingsRow]] = [[name], [description]]
        for (index, row) in draft.rows.enumerated() {
            var label = SettingsRow(id: "variable-\(row.id)", title: "", accessory: .none)
            label.header = index == 0 ? Text.variables : nil
            var value = SettingsRow(id: "value-\(row.id)", title: "", accessory: .none)
            if tried, draft.missing(row) { value.subtitle = Text.valueMissing; value.destructive = true }
            var remove = SettingsRow(id: "remove-\(row.id)", title: Text.remove, icon: ("trash", .action), accessory: .none, action: { [weak self] in
                self?.edit { $0.remove(row.id) }
            })
            remove.destructive = true
            remove.spoken = Text.removeNamed(row.name)
            remove.footer = row.hint
            cards.append([label, value, remove])
        }
        var add = SettingsRow(id: "add", title: Text.add, icon: ("add", .action), accessory: .none, action: { [weak self] in
            self?.edit { $0.add() }
            if let id = self?.draft.rows.last?.id { self?.fields["variable-\(id)"]?.becomeFirstResponder() }
        })
        add.footer = [variablesNote(problems), Text.about].compactMap { $0 }.joined(separator: "\n\n")
        cards.append([add])
        return cards
    }

    private func nameNote(_ problems: Set<GenUISecretDraft.Problem>) -> String? {
        if isChecking { return Text.checking }
        if draft.existing?.changeable == false { return Text.managed }
        if problems.contains(.name) { return Text.nameProblem }
        return draft.changing ? Text.changes : nil
    }

    private func variablesNote(_ problems: Set<GenUISecretDraft.Problem>) -> String? {
        if problems.contains(.noVariables) { return Text.noVariables }
        if problems.contains(.variableName) { return Text.variableNameProblem }
        if problems.contains(.variableTwice) { return Text.variableTwice }
        if problems.contains(.value) { return Text.valueProblem }
        return nil
    }

    private func completion(_ saved: GenUISecretSaved) -> [[SettingsRow]] {
        var row = SettingsRow(id: "saved", title: saved.created ? Text.added(saved.secret.id) : Text.updated(saved.secret.id),
                              icon: ("checkmark-circle", .green), accessory: .none)
        row.footer = Text.told(saved.secret.environmentVariables)
        return [[row]]
    }

    override func reload() {
        super.reload()
        guard isViewLoaded else { return }
        if let saved { title = saved.created ? Text.addedTitle : Text.updatedTitle }
        else { title = draft.changing ? Text.changeTitle : Text.newTitle }
        syncFields()
    }

    /// A field over each editable row, made once and kept while its row is.
    private func syncFields() {
        var wanted: [String: (text: String, mono: Bool, secret: Bool, placeholder: String, label: String)] = [:]
        if saved == nil {
            wanted["name"] = (draft.name, true, false, Text.namePlaceholder, Text.name)
            wanted["description"] = (draft.description, false, false, Text.descriptionPlaceholder, Text.description)
            for row in draft.rows {
                wanted["variable-\(row.id)"] = (row.name, true, false, Text.variablePlaceholder, Text.variableName)
                wanted["value-\(row.id)"] = (row.value, false, true, draft.changing && row.keeps ? Text.keepPlaceholder : Text.valuePlaceholder, row.name.isEmpty ? Text.value : row.name)
            }
        }
        for (id, field) in fields where wanted[id] == nil {
            field.text = nil
            field.removeFromSuperview()
            fields[id] = nil
        }
        for (id, want) in wanted {
            let field = fields[id] ?? makeField(id, mono: want.mono, secret: want.secret)
            if !field.isFirstResponder, field.text != want.text { field.text = want.text }
            field.placeholder = want.placeholder
            field.accessibilityLabel = want.label
            field.isEnabled = !saving
        }
        view.setNeedsLayout()
    }

    private func makeField(_ id: String, mono: Bool, secret: Bool) -> UITextField {
        let field = UITextField()
        field.font = mono ? Fonts.mono(bold: false, size: 16) : SettingsCardView.RowView.titleFont
        field.textColor = UIColor(Palette.settingsText)
        field.tintColor = UIColor(Palette.settingsPrimary)
        field.autocapitalizationType = id.hasPrefix("variable-") ? .allCharacters : id == "description" ? .sentences : .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.smartQuotesType = .no
        field.smartDashesType = .no
        // A value is typed and sent once: hidden, never suggested or remembered.
        field.isSecureTextEntry = secret
        field.textContentType = secret ? .oneTimeCode : nil
        field.keyboardType = mono ? .asciiCapable : .default
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

    /// A change to the draft: another save from here on, and the page again.
    private func edit(_ change: (inout GenUISecretDraft) -> Void) {
        change(&draft)
        retry = nil
        reload()
    }

    @objc private func edited(_ field: UITextField) {
        guard let id = fields.first(where: { $0.value === field })?.key else { return }
        let text = field.text ?? ""
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if id == "name" {
            draft.name = trimmed
            retry = nil
            check(trimmed, at: .now + .milliseconds(400))
            reload()
        } else if id == "description" {
            draft.describe(text)
            retry = nil
            if tried { reload() }
        } else if let row = Int(id.dropFirst("variable-".count)), id.hasPrefix("variable-") {
            edit { $0.rename(row, to: trimmed) }
        } else if let row = Int(id.dropFirst("value-".count)), id.hasPrefix("value-") {
            draft.type(row, text)
            retry = nil
            if tried { reload() }
        }
        showSave()
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        let order = ["name", "description"] + draft.rows.flatMap { ["variable-\($0.id)", "value-\($0.id)"] }
        guard let id = fields.first(where: { $0.value === textField })?.key, let index = order.firstIndex(of: id) else { return false }
        if index + 1 < order.count { fields[order[index + 1]]?.becomeFirstResponder() } else { save() }
        return false
    }

    /// Whether `name` is a stored secret decides whether the form makes one
    /// or changes it; asked once typing settles. Unknown, it makes one: the
    /// computer refuses to overwrite a secret the form didn't show.
    private func check(_ name: String, at when: ContinuousClock.Instant) {
        checking?.cancel()
        guard GenUISecretPrefill.isName(name) else {
            isChecking = false
            draft.adopt(nil)
            reload()
            return
        }
        isChecking = true
        checking = Task { [weak self, client] in
            try? await Task.sleep(until: when)
            guard !Task.isCancelled else { return }
            let stored = (try? await client.secret(name)) ?? nil
            guard !Task.isCancelled, let self, self.draft.name == name else { return }
            self.isChecking = false
            self.draft.adopt(stored)
            self.reload()
            self.showSave()
        }
    }

    // MARK: Saving

    private func showSave() {
        if saved != nil {
            navigationItem.leftBarButtonItem = nil
            navigationItem.rightBarButtonItem = UIBarButtonItem(title: Text.done, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
            navigationItem.rightBarButtonItem?.style = .done
            navigationItem.rightBarButtonItem?.accessibilityIdentifier = "genui-secret-done"
            return
        }
        if saving {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            navigationItem.rightBarButtonItem = UIBarButtonItem(customView: spinner)
            return
        }
        let item = navigationItem.rightBarButtonItem?.customView == nil ? navigationItem.rightBarButtonItem : nil
        let button = item ?? UIBarButtonItem(title: Strings.Common.save, primaryAction: UIAction { [weak self] _ in self?.save() })
        button.style = .done
        button.accessibilityIdentifier = "genui-secret-save"
        button.isEnabled = !isChecking && draft.existing?.changeable != false
        navigationItem.rightBarButtonItem = button
    }

    private func save() {
        tried = true
        guard draft.problems.isEmpty, !isChecking, !saving else {
            reload()
            return
        }
        saving = true
        reload()
        showSave()
        let id = retry ?? ClientID.make()
        retry = id
        let (secret, ifMatch) = draft.form()
        let changing = draft.changing
        let name = draft.name
        Task { @MainActor [weak self, client, artifactId, version, element] in
            do {
                let done = try await client.saveSecretAction(artifactId: artifactId, version: version, element: element, id: id, secret: secret, ifMatch: ifMatch)
                guard let self else { return }
                self.finish(done)
            } catch {
                guard let self else { return }
                self.saving = false
                let trouble = await self.trouble(error, name: name, changing: changing)
                self.reload()
                self.showSave()
                Alerts.show(Text.failedTitle, trouble, on: self)
            }
        }
    }

    private func finish(_ done: GenUISecretSaved) {
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

    /// What the person is told of a failed save, in this app's words, never
    /// the computer's, which could hold what was typed. A conflict reads
    /// the secret again and opens the form on it.
    private func trouble(_ error: any Error, name: String, changing: Bool) async -> String {
        guard case .status(let status, _, _) = error as? AgentClientError else { return Text.failed }
        switch status {
        case 404: return Text.unavailable
        case 400: return Text.refused
        case 409:
            let stored = (try? await client.secret(name)) ?? nil
            guard let stored, draft.name == name else { return Text.conflict }
            draft.adopt(stored)
            retry = nil
            return changing ? Text.stale : Text.exists
        default: return Text.failed
        }
    }

    private func close() {
        checking?.cancel()
        draft.forget()
        for field in fields.values { field.text = nil }
        dismiss(animated: true)
    }
}
#endif
