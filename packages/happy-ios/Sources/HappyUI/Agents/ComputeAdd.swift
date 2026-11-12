#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Adding a computer, in a sheet of its own: its mode, then its name and
/// description, then the one-time command that installs it. The steps are
/// `ComputerAdd`'s; each page shows the step it is and sends the
/// person's changes back to it.
@MainActor
final class ComputeAddFlow: NSObject, UIAdaptivePresentationControllerDelegate {
    private(set) var state: ComputerAdd
    let access: ComputeAccess
    let navigation = UINavigationController()
    /// The list, read again once a computer may be on its way.
    private let added: () -> Void
    private let client: AgentClient
    /// The sheet went, however it went.
    var closed: (() -> Void)?
    private var creating: Task<Void, Never>?
    private weak var form: ComputeFormViewController?

    init?(access: ComputeAccess, client: AgentClient, added: @escaping () -> Void) {
        guard let state = ComputerAdd.start(access) else { return nil }
        self.state = state
        self.access = access
        self.client = client
        self.added = added
        super.init()
        navigation.setViewControllers([ComputeModesViewController(flow: self)], animated: false)
        navigation.presentationController?.delegate = self
    }

    func choose(_ mode: ComputeMode.Kind) {
        state.choose(mode, access: access)
    }

    func next() {
        state.next()
        guard case .describing = state else { return }
        let form = ComputeFormViewController(add: self)
        self.form = form
        navigation.pushViewController(form, animated: true)
    }

    /// The modes page showing again: the person went back to it.
    func back() { state.back() }

    func edit(_ change: (inout ComputerDraft) -> Void) { state.edit(change) }

    func create() {
        guard creating == nil, let request = state.create() else { return }
        form?.render()
        let client = client
        creating = Task { @MainActor [weak self] in
            let result: Result<ComputeInstall, ComputeFailure>
            do { result = .success(try await client.createComputerJoinToken(request)) }
            catch AgentClientError.invalidResponse { result = .failure(ComputeFailure(Strings.Compute.invalidInstall)) }
            catch { result = .failure(ComputeFailure(ComputeViewController.words(error))) }
            guard let self, !Task.isCancelled else { return }
            creating = nil
            state.finish(result)
            switch state {
            case .shown(let install):
                added()
                // Shown once: only Done puts it away.
                navigation.isModalInPresentation = true
                navigation.setViewControllers([ComputeInstallViewController(install: install, flow: self)], animated: true)
            case .failed(_, let message):
                form?.render()
                if let form { Alerts.show(Strings.Compute.noInstall, message, on: form) }
            default:
                break
            }
        }
    }

    func close() {
        creating?.cancel()
        navigation.dismiss(animated: true)
        closed?()
    }

    func presentationControllerShouldDismiss(_ presentationController: UIPresentationController) -> Bool {
        if case .creating = state { return false }
        return true
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        creating?.cancel()
        closed?()
    }
}

/// The first step: the four modes, each with the sentence that says what
/// it means. A member may add only a private computer of their own, so the
/// others are shown, greyed out.
final class ComputeModesViewController: SettingsPageViewController {
    private let flow: ComputeAddFlow

    init(flow: ComputeAddFlow) {
        self.flow = flow
        super.init(title: Strings.Compute.addComputer)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "compute-modes"
        navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.flow.close() })
        let next = UIBarButtonItem(title: Strings.Compute.next, primaryAction: UIAction { [weak self] _ in self?.flow.next() })
        next.style = .done
        next.accessibilityIdentifier = "compute-next"
        navigationItem.rightBarButtonItem = next
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        flow.back()
        reload()
    }

    override func makeRows() -> [[SettingsRow]] {
        typealias Text = Strings.Compute
        let chosen = flow.state.draft?.mode
        return ComputeMode.Kind.allCases.map { kind in
            let allowed = flow.access.modes.contains(kind)
            var row = SettingsRow(id: "compute-mode-\(kind.rawValue)", title: Text.mode(kind), icon: ComputeViewController.icon(kind),
                                  value: allowed ? nil : Text.modeNeedsAdmin, accessory: .none)
            if kind == chosen {
                let check = UIImageView(image: Glyphs.image("checkmark", size: 20))
                check.tintColor = UIColor(Palette.textLink)
                check.sizeToFit()
                check.accessibilityLabel = Text.mode(kind)
                row.valueView = check
                row.spoken = "\(Text.mode(kind)), selected"
            }
            if allowed { row.action = { [weak self] in self?.flow.choose(kind) } }
            else { row.dimmed = true; row.hint = Text.modeLockedHint }
            row.footer = Text.modeDescription(kind)
            return [row]
        }
    }
}

/// The install the token makes, shown once: each command with a way to
/// copy it, or the server and token where the server publishes no
/// installer, and what running it does.
final class ComputeInstallViewController: SettingsPageViewController {
    let install: ComputeInstall
    private weak var flow: ComputeAddFlow?
    /// The row last copied, which says so.
    private(set) var copied: String?

    init(install: ComputeInstall, flow: ComputeAddFlow) {
        self.install = install
        self.flow = flow
        super.init(title: Strings.Compute.installTitle)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "compute-install"
        navigationItem.hidesBackButton = true
        let done = UIBarButtonItem(title: Strings.done, primaryAction: UIAction { [weak self] _ in self?.flow?.close() })
        done.style = .done
        done.accessibilityIdentifier = "compute-done"
        navigationItem.rightBarButtonItem = done
    }

    override func makeRows() -> [[SettingsRow]] {
        typealias Text = Strings.Compute
        let shown: [(id: String, label: String, text: String)] = install.shown.isEmpty
            ? [("server", Text.server, install.clusterUrl), ("token", Text.joinToken, install.token)]
            : install.shown.map { ($0.platforms.contains(.windows) ? "windows" : "unix", Text.platforms($0.platforms), $0.text) }
        var cards = shown.map { item -> [SettingsRow] in
            var code = SettingsRow(id: "compute-command-\(item.id)", title: item.text, accessory: .none)
            code.isCode = true
            code.header = item.label
            let copy = SettingsRow(id: "compute-copy-\(item.id)", title: Text.copy, icon: ("copy-outline", .action),
                                   value: copied == item.id ? Text.copied : nil, accessory: .none, action: { [weak self] in
                UIPasteboard.general.string = item.text
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                self?.copied = item.id
            })
            return [code, copy]
        }
        cards[cards.count - 1][1].footer = Text.installFooter(install)
        return cards
    }
}

/// A computer's name and description, in two of Settings' cards: when it is
/// added, as that flow's second step, or when someone who may edits it.
final class ComputeFormViewController: UIViewController, UITextViewDelegate {
    enum Purpose {
        case add(ComputeAddFlow)
        case edit(Computer, AgentClient, saved: () -> Void)
    }

    let purpose: Purpose
    private let scroll = UIScrollView()
    private let nameHeader = UILabel()
    private let nameCard = UIView()
    let nameField = UITextField()
    private let nameHint = UILabel()
    private let descriptionHeader = UILabel()
    private let descriptionCard = UIView()
    let descriptionView = UITextView()
    private let placeholder = UILabel()
    private let descriptionHint = UILabel()
    private var saving = false

    init(add flow: ComputeAddFlow) {
        purpose = .add(flow)
        super.init(nibName: nil, bundle: nil)
        title = Strings.Compute.addComputer
    }

    init(edit node: Computer, client: AgentClient, saved: @escaping () -> Void) {
        purpose = .edit(node, client, saved: saved)
        super.init(nibName: nil, bundle: nil)
        title = Strings.Compute.editComputer
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        typealias Text = Strings.Compute
        view.backgroundColor = UIColor(Palette.settingsGround)
        view.accessibilityIdentifier = "compute-form"
        navigationItem.largeTitleDisplayMode = .never
        scroll.alwaysBounceVertical = true
        scroll.keyboardDismissMode = .interactive
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
        ])
        for (label, text) in [(nameHeader, Text.name), (descriptionHeader, Text.description)] {
            label.font = SettingsFooters.font
            label.textColor = UIColor(Palette.settingsSecondary)
            label.text = text.uppercased()
        }
        let editing: Bool
        if case .edit = purpose { editing = true } else { editing = false }
        for (label, text) in [(nameHint, Text.nameHint), (descriptionHint, editing ? Text.editDescriptionHint : Text.descriptionHint)] {
            label.font = SettingsFooters.font
            label.textColor = UIColor(Palette.settingsSecondary)
            label.numberOfLines = 0
            label.text = text
        }
        nameHint.isHidden = editing
        for card in [nameCard, descriptionCard] {
            card.backgroundColor = UIColor(Palette.settingsCard)
            card.layer.cornerRadius = SettingsLayout.Metrics.radius
            card.layer.cornerCurve = .continuous
        }
        nameField.font = SettingsCardView.RowView.titleFont
        nameField.textColor = UIColor(Palette.settingsText)
        nameField.placeholder = Text.namePlaceholder
        nameField.clearButtonMode = .whileEditing
        nameField.autocorrectionType = .no
        nameField.autocapitalizationType = .none
        nameField.returnKeyType = .next
        nameField.accessibilityIdentifier = "compute-name"
        nameField.accessibilityLabel = Text.name
        nameField.addAction(UIAction { [weak self] _ in self?.changed() }, for: .editingChanged)
        nameField.addAction(UIAction { [weak self] _ in self?.descriptionView.becomeFirstResponder() }, for: .editingDidEndOnExit)
        descriptionView.font = SettingsCardView.RowView.titleFont
        descriptionView.textColor = UIColor(Palette.settingsText)
        descriptionView.backgroundColor = .clear
        descriptionView.textContainerInset = .zero
        descriptionView.textContainer.lineFragmentPadding = 0
        descriptionView.accessibilityIdentifier = "compute-description"
        descriptionView.accessibilityLabel = Text.description
        descriptionView.delegate = self
        placeholder.font = SettingsCardView.RowView.titleFont
        placeholder.textColor = UIColor(Palette.settingsSecondary)
        placeholder.text = Text.descriptionPlaceholder
        placeholder.isAccessibilityElement = false
        for view in [nameHeader, nameCard, nameField, nameHint, descriptionHeader, descriptionCard, descriptionView, placeholder, descriptionHint] as [UIView] {
            scroll.addSubview(view)
        }
        switch purpose {
        case .add(let flow):
            nameField.text = flow.state.draft?.name
            descriptionView.text = flow.state.draft?.description
        case .edit(let node, _, _):
            nameField.text = node.displayName
            descriptionView.text = node.description ?? ""
            navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        }
        render()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = scroll.readableColumn(width: scroll.bounds.width)
        let hintWidth = SettingsLayout.footerWidth(width)
        func height(_ label: UILabel) -> CGFloat { label.isHidden ? 0 : ceil(label.sizeThatFits(CGSize(width: hintWidth, height: .greatestFiniteMagnitude)).height) }
        let layout = ComputeFormLayout(width: width, header: ceil(SettingsFooters.font.lineHeight), line: ceil(SettingsCardView.RowView.titleFont.lineHeight),
                                       nameHint: height(nameHint), descriptionHint: height(descriptionHint))
        nameHeader.frame = layout.nameHeader
        nameCard.frame = layout.nameCard
        nameField.frame = layout.nameField
        nameHint.frame = layout.nameHint
        descriptionHeader.frame = layout.descriptionHeader
        descriptionCard.frame = layout.descriptionCard
        descriptionView.frame = layout.descriptionText
        placeholder.frame = layout.descriptionPlaceholder
        descriptionHint.frame = layout.descriptionHint
        scroll.contentSize = CGSize(width: width, height: layout.contentHeight)
    }

    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        if case .edit = purpose { nameField.becomeFirstResponder() }
    }

    func textViewDidChange(_ textView: UITextView) { changed() }

    private func changed() {
        if case .add(let flow) = purpose {
            let name = nameField.text ?? "", description = descriptionView.text ?? ""
            flow.edit { $0.name = name; $0.description = description }
        }
        render()
    }

    /// The bar's buttons and the fields as the step or the save stands.
    func render() {
        typealias Text = Strings.Compute
        placeholder.isHidden = !(descriptionView.text ?? "").isEmpty
        let busy: Bool
        let item: UIBarButtonItem
        switch purpose {
        case .add(let flow):
            if case .creating = flow.state { busy = true } else { busy = false }
            item = UIBarButtonItem(title: Text.create, primaryAction: UIAction { [weak self] _ in
                self?.view.endEditing(true)
                flow.create()
            })
            item.accessibilityIdentifier = "compute-create"
        case .edit:
            busy = saving
            item = UIBarButtonItem(title: Strings.Common.save, primaryAction: UIAction { [weak self] _ in self?.save() })
            item.isEnabled = !(nameField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            item.accessibilityIdentifier = "compute-save"
        }
        item.style = .done
        if busy {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            navigationItem.rightBarButtonItem = UIBarButtonItem(customView: spinner)
        } else if navigationItem.rightBarButtonItem?.title != item.title || navigationItem.rightBarButtonItem?.isEnabled != item.isEnabled {
            navigationItem.rightBarButtonItem = item
        }
        navigationItem.hidesBackButton = busy
        navigationItem.leftBarButtonItem?.isEnabled = !busy
        nameField.isEnabled = !busy
        descriptionView.isEditable = !busy
        isModalInPresentation = busy
    }

    func save() {
        guard case .edit(let node, let client, let saved) = purpose, !saving else { return }
        guard let patch = ComputerPatch(node, name: nameField.text ?? "", description: descriptionView.text ?? "") else {
            // Nothing changed, or the name was emptied, which Save isn't offered for.
            if !(nameField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { dismiss(animated: true) }
            return
        }
        view.endEditing(true)
        saving = true
        render()
        Task { @MainActor [weak self] in
            do {
                try await client.updateComputer(node.id, patch)
                saved()
                self?.dismiss(animated: true)
            } catch {
                guard let self else { return }
                saving = false
                render()
                Alerts.show(Strings.Compute.notSaved, ComputeViewController.words(error), on: self)
            }
        }
    }
}
#endif
