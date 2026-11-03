#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The voice paywall: shown once a device's free voice time is used
/// (`CallAllowance`), as a sheet of the app's own grouped rows. It says
/// when free time comes back and what can be bought, which today is
/// nothing (`CallOffer.unavailable`): no price, no button that pretends.
@MainActor
final class CallPaywallViewController: UIViewController {
    private let list = GroupedListView()
    private let freeAgain: Date?
    private let offer: CallOffer

    init(freeAgain: Date?, offer: CallOffer) {
        self.freeAgain = freeAgain
        self.offer = offer
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func loadView() { view = list }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = Strings.Call.paywallTitle
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: Strings.Call.done, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        let used = ItemRowView(title: Strings.Call.paywallUsed,
                               subtitle: freeAgain.map { Strings.Call.paywallFree(Strings.dayTime($0, now: Date())) },
                               icon: ItemIcon(.ionicons("mic-outline"), tint: Palette.iconPurple))
        used.showsChevron = false
        var sections = [ItemGroupView(footer: Strings.Call.paywallFooter, rows: [used])]
        switch offer {
        case .unavailable:
            let more = ItemRowView(title: Strings.Call.paywallMore, detail: Strings.Call.paywallUnavailable,
                                   icon: ItemIcon(.ionicons("sparkles-outline"), tint: Palette.iconBlue))
            more.showsChevron = false
            more.accessibilityIdentifier = "call-paywall-offer"
            sections.append(ItemGroupView(footer: Strings.Call.paywallUnavailableFooter, rows: [more]))
        }
        list.sections = sections
        for section in sections { for case let row as ItemRowView in section.rows { row.titleLabel.numberOfLines = 0 } }
        view.accessibilityIdentifier = "call-paywall"
    }

    /// In a sheet of its own, over whatever is on top.
    static func present(freeAgain: Date?, offer: CallOffer, over top: UIViewController) {
        let navigation = UINavigationController(rootViewController: CallPaywallViewController(freeAgain: freeAgain, offer: offer))
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        if let sheet = navigation.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
        top.present(navigation, animated: true)
    }
}
#endif
