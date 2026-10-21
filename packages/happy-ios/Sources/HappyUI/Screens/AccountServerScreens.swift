#if canImport(UIKit)
import HappyCore
import UIKit

/// Import recovery uses the existing server form and ServerFormLayout.
/// Save confirms the host before any API or socket can use the RN token.
public final class AccountServerConfirmationViewController: UIViewController, UITextFieldDelegate {
    private let context: AppContext
    private let accountID: AccountSummary.ID
    private let list = GroupedListView()
    private let form = ServerFormView()

    public init(context: AppContext, account: AccountSummary) {
        self.context = context
        self.accountID = account.id
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func loadView() { view = list }

    public override func viewDidLoad() {
        super.viewDidLoad()
        title = Strings.Server.title
        list.sections = [ItemGroupView(footer: Strings.Server.continueWithServer, rows: [form])]
        form.field.delegate = self
        form.field.addTarget(self, action: #selector(edited), for: .editingChanged)
        form.save.action = { [weak self] in await self?.save() }
    }

    public func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return true
    }

    @objc private func edited() { form.error = nil }

    private func save() async {
        guard let input = form.field.text, !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            form.error = Strings.Server.enterServerUrl
            return
        }
        let url: URL
        do {
            url = try ServerConfig.validate(input)
        } catch {
            form.error = Strings.Server.invalidFormat
            return
        }
        let confirmed = await Alerts.confirm(
            Strings.Server.changeServer, Strings.Server.continueWithServer,
            confirmTitle: Strings.Common.continueAction, on: self
        )
        guard confirmed else { return }
        do {
            try await context.account.confirmServer(url, for: accountID)
        } catch {
            form.error = Strings.Server.failedToConnectToServer
        }
    }
}
#endif
