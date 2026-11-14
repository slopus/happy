#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Adding a computer, in a sheet of its own: shared or private and how many
/// agents it runs at once, then the one-time
/// command that installs it. The steps are `ComputerAdd`'s; each page
/// shows the step it is and sends the person's changes back to it.
@MainActor
final class ComputeAddFlow: NSObject, UIAdaptivePresentationControllerDelegate {
    private(set) var state: ComputerAdd
    let role: ComputeRole
    let navigation = UINavigationController()
    /// The list, read again once a computer may be on its way.
    private let added: () -> Void
    private let client: AgentClient
    /// The sheet went, however it went.
    var closed: (() -> Void)?
    private var creating: Task<Void, Never>?
    private weak var modes: ComputeAccessViewController?

    init?(role: ComputeRole, client: AgentClient, added: @escaping () -> Void) {
        guard let state = ComputerAdd.start(role) else { return nil }
        self.state = state
        self.role = role
        self.client = client
        self.added = added
        super.init()
        let modes = ComputeAccessViewController(flow: self)
        self.modes = modes
        navigation.setViewControllers([modes], animated: false)
        navigation.presentationController?.delegate = self
    }

    func choose(_ access: ComputeAccess) {
        state.choose(access, role: role)
    }

    func setConcurrency(_ concurrency: Int?) {
        state.setConcurrency(concurrency)
    }

    func create() {
        guard creating == nil, let request = state.create() else { return }
        modes?.render()
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
                modes?.render()
                if let modes { Alerts.show(Strings.Compute.noInstall, message, on: modes) }
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

/// Shared or private, each with the sentence that says what it means, then
/// how many agents it runs at once. A member may add only a private computer
/// of their own, so shared is shown, greyed out.
final class ComputeAccessViewController: SettingsPageViewController {
    private let flow: ComputeAddFlow

    init(flow: ComputeAddFlow) {
        self.flow = flow
        super.init(title: Strings.Compute.addComputer)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "compute-access"
        navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.flow.close() })
        render()
    }

    /// Create, or a spinner while the token is minted.
    func render() {
        let busy: Bool
        if case .creating = flow.state { busy = true } else { busy = false }
        if busy {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            navigationItem.rightBarButtonItem = UIBarButtonItem(customView: spinner)
        } else if navigationItem.rightBarButtonItem?.title != Strings.Compute.create {
            let create = UIBarButtonItem(title: Strings.Compute.create, primaryAction: UIAction { [weak self] _ in self?.flow.create() })
            create.style = .done
            create.accessibilityIdentifier = "compute-create"
            navigationItem.rightBarButtonItem = create
        }
        navigationItem.leftBarButtonItem?.isEnabled = !busy
    }

    override func makeRows() -> [[SettingsRow]] {
        typealias Text = Strings.Compute
        guard let draft = flow.state.draft else { return [] }
        var cards = ComputeAccess.allCases.map { access in
            let allowed = flow.role.accesses.contains(access)
            var row = SettingsRow(id: "compute-access-\(access.rawValue)", title: Text.access(access), icon: ComputeViewController.icon(access),
                                  value: allowed ? nil : Text.accessNeedsAdmin, accessory: .none)
            if access == draft.access {
                let check = UIImageView(image: Glyphs.image("checkmark", size: 20))
                check.tintColor = UIColor(Palette.textLink)
                check.sizeToFit()
                check.accessibilityLabel = Text.access(access)
                row.valueView = check
                row.spoken = "\(Text.access(access)), selected"
            }
            if allowed { row.action = { [weak self] in self?.flow.choose(access) } }
            else { row.dimmed = true; row.hint = Text.accessLockedHint }
            row.footer = Text.accessDescription(access)
            return [row]
        }
        var concurrency = SettingsRow(id: "compute-concurrency", title: Text.concurrency,
                                      value: Text.concurrencyValue(draft.shownConcurrency, isDefault: draft.concurrency == nil), accessory: .chevron)
        concurrency.action = { [weak self] in self?.editConcurrency() }
        concurrency.footer = Text.concurrencyNote
        cards.append([concurrency])
        return cards
    }

    /// A number in 1…64; an empty answer goes back to the default.
    func editConcurrency() {
        typealias Text = Strings.Compute
        guard let draft = flow.state.draft else { return }
        Task { @MainActor [weak self] in
            guard let self, let typed = await Alerts.prompt(Text.concurrencyPrompt, Text.concurrencyRange(ComputeConcurrency.range),
                                                            placeholder: "\(draft.access.defaultConcurrency)", text: draft.concurrency.map(String.init),
                                                            keyboard: .numberPad, confirmTitle: Text.save, on: self) else { return }
            let trimmed = typed.trimmingCharacters(in: .whitespaces)
            let value = Int(trimmed)
            guard trimmed.isEmpty || value.map(ComputeConcurrency.range.contains) == true else {
                return Alerts.show(Text.invalidConcurrency, Text.concurrencyRange(ComputeConcurrency.range), on: self)
            }
            flow.setConcurrency(value)
            reload()
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
#endif
