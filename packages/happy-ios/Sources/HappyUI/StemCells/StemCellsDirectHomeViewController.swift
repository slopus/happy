#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Home for a paired computer in development and preview builds: home's
/// floating header over that computer's Stem Cells. The computer's own
/// picture at the left opens settings, where another computer or the Happy
/// account is chosen; its name is plain in the middle; search alone is the
/// pill at the right.
final class StemCellsDirectHomeViewController: UIViewController, StemCellsDockHosting {
    private let context: AppContext
    private let id: String
    private let header = HomeHeaderView()
    private let stemCells: StemCellsHomeViewController
    private var observation: AccountsObservation?
    private var avatarKey: String?
    private var avatarJob: Task<Void, Never>?

    init(context: AppContext, id: String) {
        self.context = context
        self.id = id
        stemCells = StemCellsHomeViewController(context: context, computer: id)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        // The conversation's own ground, light and dark.
        view.backgroundColor = UIColor(Palette.surface)
        addChild(stemCells)
        stemCells.view.frame = view.bounds
        stemCells.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(stemCells.view)
        stemCells.didMove(toParent: self)
        view.addSubview(header)
        header.stemCellsActions = true
        stemCells.header = header
        header.searchButton.accessibilityIdentifier = "stem-search"
        header.searchButton.addAction(UIAction { [weak self] _ in self?.stemCells.openSearch() }, for: .primaryActionTriggered)
        header.logoControl.isUserInteractionEnabled = true
        header.logoControl.isAccessibilityElement = true
        header.logoControl.accessibilityLabel = Strings.StemCells.openSettings
        header.logoControl.accessibilityTraits = .button
        header.logoControl.accessibilityIdentifier = "stem-settings-mark"
        header.logoControl.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(openSettings)))
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
        // Settings has its own glass bar, a chat its own header: shown for
        // them, the bar would slide in with them and away again.
        if let top = navigationController?.topViewController, top !== self,
           !(top is StemCellsSettingsViewController), !(top is StemCellChatViewController) {
            navigationController?.setNavigationBarHidden(false, animated: animated)
        }
    }

    /// The computer's name, plain in the middle, and its own picture at
    /// the left, round; Happy's mark where it has none. The picture last
    /// shown stays until the next is decoded, so nothing flashes.
    private func updateTitle() {
        guard let account = context.account.direct.accounts.first(where: { $0.id == id }) else { return }
        if header.titleLabel.string != account.name { header.titleLabel.string = account.name }
        let key = "\(account.avatarETag ?? ""):\(account.avatar?.count ?? 0):\(account.thumbhash ?? "")"
        guard key != avatarKey else { view.setNeedsLayout(); return }
        avatarKey = key
        let bytes = account.avatar
        let thumbhash = account.thumbhash
        avatarJob?.cancel()
        avatarJob = Task { [weak self] in
            let image = await Task.detached { () -> UIImage? in
                if let bytes, let image = AccountPictureImages.decode(bytes)?.picture as? UIImage { return image }
                return thumbhash.flatMap { AccountPictureImages.placeholder($0)?.picture as? UIImage }
            }.value
            guard !Task.isCancelled, let self else { return }
            self.showAvatar(image)
        }
        view.setNeedsLayout()
    }

    private func showAvatar(_ image: UIImage?) {
        if let image {
            header.logo.image = image.withRenderingMode(.alwaysOriginal)
            header.logo.contentMode = .scaleAspectFill
        } else {
            header.logo.image = UIImage.happy("logo-black")?.withRenderingMode(.alwaysTemplate)
            header.logo.contentMode = .scaleAspectFit
        }
        header.showsAccountAvatar = image != nil
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let layout = HomeScreenLayout(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets), dock: HomeDockLayout.Metrics.contentInset)
        header.frame = layout.header
        stemCells.contentInsets = layout.insets
    }

    var newWorkDock: UIView { stemCells.newWorkDock }

    @objc private func openSettings() {
        StemCellsSettingsViewController.open(context: context, computer: id, from: self)
    }
}
#endif
