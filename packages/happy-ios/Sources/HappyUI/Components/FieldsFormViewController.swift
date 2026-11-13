#if canImport(UIKit)
import HappyLayout
import UIKit

/// What a server refused about some of a form's fields, by key.
protocol FieldsRefusal: Error {
    var fields: [String: String] { get }
}

/// A form of a few values sent once: a plugin's fields method, a team's
/// own provider. A field for each, its help under it, and what the server
/// refused about it in its place. Secret values are typed into secure
/// fields, sent once and kept nowhere here. Connect, in the bar, takes them
/// once every required one is filled; saved, the page goes back.
final class FieldsFormViewController: SettingsPageViewController, UITextFieldDelegate {
    typealias Save = @MainActor ([String: String]) async throws -> Void

    struct Field {
        var key: String
        var label: String
        var help: String = ""
        var required = true
        var secret = false
        var keyboard: UIKeyboardType = .default
        var placeholder: String?
    }

    private let fields: [Field]
    private let footer: String?
    private let action: String
    /// The title an error the server gave is said under, and its words.
    private let failure: String
    private let words: (any Error) -> String
    private let save: Save
    private var inputs: [String: UITextField] = [:]
    private var refused: [String: String] = [:]
    private var saving = false

    init(title: String, fields: [Field], footer: String? = nil, action: String, failure: String, words: @escaping (any Error) -> String, save: @escaping Save) {
        self.fields = fields
        self.footer = footer
        self.action = action
        self.failure = failure
        self.words = words
        self.save = save
        super.init(title: title)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "fields-form"
        scroll.keyboardDismissMode = .interactive
        for (index, field) in fields.enumerated() {
            let input = UITextField()
            input.font = SettingsCardView.RowView.titleFont
            input.textColor = UIColor(Palette.settingsText)
            input.tintColor = UIColor(Palette.settingsPrimary)
            input.placeholder = field.placeholder ?? field.label
            input.keyboardType = field.keyboard
            input.isSecureTextEntry = field.secret
            input.textContentType = field.secret ? .password : nil
            input.autocapitalizationType = .none
            input.autocorrectionType = .no
            input.spellCheckingType = .no
            input.clearButtonMode = .whileEditing
            input.returnKeyType = index == fields.count - 1 ? .done : .next
            input.accessibilityIdentifier = "form-field-\(field.key)"
            input.accessibilityLabel = field.label
            input.delegate = self
            input.addTarget(self, action: #selector(edited(_:)), for: .editingChanged)
            scroll.addSubview(input)
            inputs[field.key] = input
        }
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: action, style: .done, target: self, action: #selector(connect))
        navigationItem.rightBarButtonItem?.accessibilityIdentifier = "form-connect"
        updateConnect()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if let first = fields.first, let input = inputs[first.key], !input.isFirstResponder { input.becomeFirstResponder() }
    }

    override func makeRows() -> [[SettingsRow]] {
        fields.enumerated().map { index, field in
            var card = [SettingsRow(id: "field-\(field.key)", title: "", accessory: .none, action: { [weak self] in self?.inputs[field.key]?.becomeFirstResponder() })]
            // What the server refused about it, in red under the field.
            if let refusal = refused[field.key] {
                card[0].subtitle = refusal
                card[0].subtitleLines = 0
                card[0].destructive = true
            }
            card[0].header = field.label
            let help = field.help.isEmpty ? nil : field.help
            card[card.count - 1].footer = index == fields.count - 1 ? [help, footer].compactMap { $0 }.joined(separator: "\n\n") : help
            return card
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        for field in fields {
            inputs[field.key]?.frame = titleFrame("field-\(field.key)") ?? .zero
        }
    }

    private var values: [String: String] {
        inputs.mapValues { ($0.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    private var complete: Bool { fields.allSatisfy { !$0.required || values[$0.key]?.isEmpty == false } }

    /// Typed into again, a refused field's refusal goes.
    @objc private func edited(_ input: UITextField) {
        if let key = fields.first(where: { inputs[$0.key] === input })?.key, refused.removeValue(forKey: key) != nil { reload() }
        updateConnect()
    }

    private func updateConnect() {
        navigationItem.rightBarButtonItem?.isEnabled = complete && !saving
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        guard let index = fields.firstIndex(where: { inputs[$0.key] === textField }) else { return false }
        if index + 1 < fields.count { inputs[fields[index + 1].key]?.becomeFirstResponder() }
        else if complete { connect() }
        return false
    }

    @objc func connect() {
        guard complete, !saving else { return }
        saving = true
        let spinner = UIActivityIndicatorView(style: .medium)
        spinner.startAnimating()
        let button = navigationItem.rightBarButtonItem
        navigationItem.rightBarButtonItem = UIBarButtonItem(customView: spinner)
        for input in inputs.values { input.isEnabled = false }
        let values = values.filter { !$0.value.isEmpty }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await save(values)
                navigationController?.popViewController(animated: true)
            } catch {
                saving = false
                navigationItem.rightBarButtonItem = button
                for input in inputs.values { input.isEnabled = true }
                if let refusal = error as? FieldsRefusal, !refusal.fields.isEmpty {
                    refused = refusal.fields
                    reload()
                    // A refused secret is typed again, not edited.
                    for (key, _) in refusal.fields where fields.first(where: { $0.key == key })?.secret == true { inputs[key]?.text = "" }
                    if let key = fields.first(where: { refused[$0.key] != nil })?.key { inputs[key]?.becomeFirstResponder() }
                } else {
                    Alerts.show(failure, words(error), on: self)
                }
                updateConnect()
            }
        }
    }
}
#endif
