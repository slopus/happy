#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Standard measured rows keep the call controls scrollable at every text
/// size and in landscape. Dismissing the sheet leaves the call running;
/// the composer's microphone opens these controls again.
@MainActor
final class VoiceStatusViewController: UIViewController {
    private let coordinator: VoiceCoordinator
    private let list = GroupedListView()
    init(coordinator: VoiceCoordinator) {
        self.coordinator = coordinator
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override func loadView() { view = list }
    override func viewDidLoad() {
        super.viewDidLoad()
        title = Strings.Voice.title
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: Strings.Voice.done, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        update(coordinator.state)
    }

    func update(_ state: VoiceState) {
        guard isViewLoaded else { return }
        let title: String
        var rows: [ItemRowView] = []
        switch state {
        case .idle: title = Strings.Voice.ended
        case .connecting: title = Strings.Voice.connecting
        case .active(let activity, let muted):
            let activityTitle = switch activity {
            case .listening: Strings.Voice.listening
            case .userSpeaking: Strings.Voice.userSpeaking
            case .agentSpeaking: Strings.Voice.agentSpeaking
            }
            title = muted ? Strings.Voice.muted : activityTitle
            rows.append(ItemRowView(title: muted ? Strings.Voice.unmute : Strings.Voice.mute,
                                    icon: ItemIcon(.ionicons(muted ? "mic-outline" : "mic"), tint: Palette.iconBlue)) { [weak self] in
                self?.coordinator.toggleMute()
            })
        case .denied(let denial):
            title = switch denial.reason {
            case .subscriptionRequired: Strings.Voice.subscriptionRequired
            case .hardLimitReached: Strings.Voice.hardLimit
            case .conversationLimitReached: Strings.Voice.conversationLimit
            }
            if denial.reason == .subscriptionRequired {
                rows.append(ItemRowView(title: Strings.Voice.upgrade, icon: ItemIcon(.ionicons("heart-outline"), tint: Palette.iconRed)) { [weak self] in
                    self?.navigationController?.pushViewController(SupportUsViewController(), animated: true)
                })
            }
        case .failed(let failure):
            title = failure == .microphonePermission ? Strings.Voice.permissionDenied : failure == .authentication ? Strings.Voice.authentication : Strings.Voice.unavailable
            if failure == .microphonePermission {
                rows.append(ItemRowView(title: Strings.Voice.openSettings, icon: ItemIcon(.ionicons("settings-outline"), tint: Palette.iconBlue)) {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                })
            }
        }
        let status = ItemRowView(title: title, icon: ItemIcon(.ionicons("mic-outline"), tint: Palette.iconBlue))
        status.showsChevron = false
        status.isLoading = state == .connecting
        switch state {
        case .connecting, .active:
            rows.append(ItemRowView(title: Strings.Voice.stop, icon: ItemIcon(.octicons("stop"), tint: Palette.iconRed), isDestructive: true) { [weak self] in
                self?.coordinator.stop()
            })
        default: break
        }
        list.sections = [ItemGroupView(footer: Strings.Voice.callFooter, rows: [status] + rows)]
        // Error explanations must remain readable at accessibility sizes.
        // Groups finish configuring dividers before these measured limits.
        for row in [status] + rows { row.titleLabel.numberOfLines = 0 }
        list.setNeedsLayout()
    }
}
#endif
