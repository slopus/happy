#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Settings for Stem Cells, opened from the Happy mark in home's header:
/// the computer, the accounts (switching, pairing, adding one; this is
/// where the mark's account switching went), and Happy's own settings when
/// a Happy account is signed in.
final class StemCellsSettingsViewController: UIViewController {
    private let context: AppContext
    private let computer: String?
    private let list = GroupedListView()
    private var observation: AccountsObservation?

    init(context: AppContext, computer: String?) {
        self.context = context
        self.computer = computer
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func loadView() { view = list }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = Strings.Settings.title
        view.accessibilityIdentifier = "stem-settings"
        observation = context.account.observeAccounts { [weak self] _ in self?.update() }
        update()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(false, animated: animated)
    }

    private func update() {
        var sections: [UIView] = []
        if let computer, let account = context.account.direct.accounts.first(where: { $0.id == computer }) {
            let row = ItemRowView(title: account.name, subtitle: account.status.title, icon: ItemIcon(.ionicons("desktop-outline"), tint: Palette.iconBlue)) { [weak self] in
                guard let self else { return }
                navigationController?.pushViewController(DirectHomeViewController(context: context, id: computer), animated: true)
            }
            sections.append(ItemGroupView(title: Strings.StemCells.thisComputer, rows: [row]))
        }
        let accounts = ItemRowView(title: Strings.StemCells.accounts, subtitle: Strings.StemCells.accountsDetail, icon: ItemIcon(.ionicons("person-circle-outline"), tint: Palette.iconBlue)) { [weak self] in
            guard let self else { return }
            navigationController?.pushViewController(CombinedAccountsViewController(context: context), animated: true)
        }
        accounts.accessibilityIdentifier = "stem-settings-accounts"
        sections.append(ItemGroupView(rows: [accounts]))
        if context.account.session != nil {
            let happy = ItemRowView(title: Strings.StemCells.happySettings, icon: ItemIcon(.ionicons("settings-outline"), tint: Palette.iconBlue)) { [weak self] in
                guard let self else { return }
                push(.settings, context: context)
            }
            sections.append(ItemGroupView(rows: [happy]))
        }
        list.sections = sections
    }
}
#endif
