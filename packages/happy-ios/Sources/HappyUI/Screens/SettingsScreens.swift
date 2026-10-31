#if canImport(UIKit)
import HappyCore
import HappyCrypto
import HappyLayout
import HappyStore
import UIKit

/// useHappyAction.ts's catch-all: any failure reads "Unknown error".
@MainActor
enum SettingsAlerts {
    static func unknownError(on controller: UIViewController) {
        Alerts.show(Strings.SettingsActions.error, Strings.SettingsActions.unknownError, on: controller)
    }
}

/// The active account's server host, for rows that name it; nil on the
/// default server. Each account has its own server, so this reads the
/// session, not the server the sign-in screens would pick.
@MainActor
func activeServerHost(_ context: AppContext) -> String? {
    guard let url = context.account.session?.api.serverURL, url != ServerConfig.defaultServerURL else { return nil }
    guard let host = url.host else { return url.absoluteString }
    return url.port.map { "\(host):\($0)" } ?? host
}

/// The gear on Link Your Computer, app/(app)/onboarding/settings.tsx. Two
/// things a person may need before a computer is linked: another server, or
/// throwing the new account away. Nothing is linked yet, so logging out
/// loses nothing.
/// The custom server screen. app/(app)/server.tsx without the voice
/// section.
public final class ServerConfigViewController: UIViewController, UITextFieldDelegate {
    private let context: AppContext
    private let list = GroupedListView()
    private let form = ServerFormView()

    public init(context: AppContext) {
        self.context = context
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func loadView() {
        view = list
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        title = Strings.Server.title
        list.sections = [ItemGroupView(footer: Strings.Server.selfHostFooter, rows: [form])]
        let config = context.account.serverConfig
        form.field.text = config.isCustomServer ? config.serverURL.absoluteString : ""
        form.isCustomServer = config.isCustomServer
        form.field.delegate = self
        form.field.addTarget(self, action: #selector(edited), for: .editingChanged)
        form.save.action = { [weak self] in await self?.save() }
        form.reset.onTap = { [weak self] in self?.reset() }
    }

    public func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return true
    }

    @objc private func edited() {
        form.error = nil
    }

    private func save() async {
        let input = form.field.text ?? ""
        guard !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            Alerts.show(Strings.Common.error, Strings.Server.enterServerUrl, on: self)
            return
        }
        let url: URL
        do {
            url = try ServerConfig.validate(input)
        } catch {
            form.error = Strings.Server.invalidFormat
            return
        }
        form.error = nil
        form.isValidating = true
        let result = await context.account.checkServer(url)
        form.isValidating = false
        switch result {
        case .ok:
            break
        case .serverError:
            form.error = Strings.Server.serverReturnedError
            return
        case .notHappyServer:
            form.error = Strings.Server.notValidHappyServer
            return
        case .unreachable:
            form.error = Strings.Server.failedToConnectToServer
            return
        }
        let confirmed = await Alerts.confirm(
            Strings.Server.changeServer,
            Strings.Server.continueWithServer,
            confirmTitle: Strings.Common.continueAction,
            destructive: true,
            on: self
        )
        guard confirmed else { return }
        do {
            try context.account.serverConfig.setCustomServerURL(url.absoluteString)
        } catch {
            form.error = Strings.Server.invalidFormat
            return
        }
        form.isCustomServer = context.account.serverConfig.isCustomServer
    }

    private func reset() {
        Task { @MainActor in
            let confirmed = await Alerts.confirm(
                Strings.Server.resetToDefault,
                Strings.Server.resetServerDefault,
                confirmTitle: Strings.Common.reset,
                destructive: true,
                on: self
            )
            guard confirmed else { return }
            try? context.account.serverConfig.setCustomServerURL(nil)
            form.field.text = ""
            form.error = nil
            form.isCustomServer = false
        }
    }
}
#endif
