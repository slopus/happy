#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Home for a paired computer in development and preview builds: home's
/// floating header over that computer's Stem Cells. The gear opens the
/// computer's own page, where it can be disconnected.
final class StemCellsDirectHomeViewController: UIViewController {
    private let context: AppContext
    private let id: String
    private let header = HomeHeaderView()
    private let stemCells: StemCellsHomeViewController
    private var accountControl: HomeAccountControl?
    private var observation: AccountsObservation?

    init(context: AppContext, id: String) {
        self.context = context
        self.id = id
        stemCells = StemCellsHomeViewController(context: context, computer: id)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        addChild(stemCells)
        stemCells.view.frame = view.bounds
        stemCells.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(stemCells.view)
        stemCells.didMove(toParent: self)
        view.addSubview(header)
        header.settingsButton.addAction(UIAction { [weak self] _ in self?.openComputer() }, for: .primaryActionTriggered)
        header.filterButton.menu = UIMenu(children: [
            UIMenu(title: Strings.SessionsFilter.groupingTitle, image: UIImage(systemName: "rectangle.grid.1x2"), options: .displayInline, children: [
                UIAction(title: Strings.StemCells.filterTitle, state: .on) { _ in },
            ]),
        ])
        header.filterButton.showsMenuAsPrimaryAction = true
        accountControl = HomeAccountControl(context: context, controller: self, header: header)
        stemCells.onSnapshot = { [weak self] snapshot in
            self?.header.status = snapshot.live ? .connected : .connecting
        }
        observation = context.account.observeAccounts { [weak self] _ in self?.updateTitle() }
        updateTitle()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: animated)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if navigationController?.topViewController !== self {
            navigationController?.setNavigationBarHidden(false, animated: animated)
        }
    }

    private func updateTitle() {
        guard let account = context.account.direct.accounts.first(where: { $0.id == id }) else { return }
        header.titleLabel.string = account.name
        view.setNeedsLayout()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let layout = HomeScreenLayout(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets), dock: HomeDockLayout.Metrics.contentInset)
        header.frame = layout.header
        stemCells.contentInsets = layout.insets
    }

    private func openComputer() {
        navigationController?.pushViewController(DirectHomeViewController(context: context, id: id), animated: true)
    }
}
#endif
