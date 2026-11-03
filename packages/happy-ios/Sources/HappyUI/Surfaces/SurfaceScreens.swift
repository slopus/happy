#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit

/// The screen each kind of Surface opens on the phone: home's Surface rows
/// and the Surfaces list both open through here, so a kind's screen is
/// chosen in one place.
@MainActor
enum SurfaceScreens {
    /// The screen for `surface`, which the person is opening: the Feed
    /// counts it seen.
    static func make(session: Session, surface: AgentWire.Surface) -> UIViewController {
        let subject = FeedSubject(type: "surface", id: surface.id)
        Task { [feed = session.engine.feed] in await feed.seen(subject) }
        Task { [engine = session.engine] in await engine.openTab(kind: "surface", id: surface.id) }
        switch surface.type {
        case "", "bot", "task", "artifact":
            return TabLinkViewController(session: session, tab: surface)
        case "document":
            return DocumentScreens.make(session: session, surfaceId: surface.id, name: surface.name)
        case "system_monitor":
            return MonitorViewController(session: session, surface: surface)
        case "todo":
            return TodoListViewController(session: session, surface: surface)
        default:
            return SurfaceElsewhereViewController(surface: surface)
        }
    }
}

/// Resolves a tab's current target, without assuming its content is global
/// or granting access to a target the server has marked unavailable.
@MainActor
final class TabLinkViewController: UIViewController {
    private let session: Session
    private let resource: AgentWire.Surface
    private var loading: Task<Void, Never>?
    private let status = EmptyView()

    init(session: Session, tab: AgentWire.Surface) {
        self.session = session
        self.resource = tab
        super.init(nibName: nil, bundle: nil)
        title = tab.name
        MainPanelKey.record("surface:\(tab.id)", for: self)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.surface)
        status.showsPair = false
        status.accessibilityIdentifier = "tab-loading"
        status.frame = view.bounds
        status.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(status)
        load()
    }

    private func load() {
        status.message = Strings.Documents.loading
        navigationItem.rightBarButtonItem = nil
        loading = Task { [weak self] in await self?.resolve() }
    }

    private func unavailable() {
        status.message = Strings.couldntRefresh
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .refresh, primaryAction: UIAction { [weak self] _ in self?.load() })
    }

    private func resolve() async {
        do {
            let tab = try await session.client.tab(resource.id)
            let controller: UIViewController
            if ["bot", "task", "artifact"].contains(tab.type) {
                guard let target = tab.target, target["state"]?.stringValue == "available",
                      let id = target[tab.type + "Id"]?.stringValue else { return unavailable() }
                let name = target["name"]?.stringValue ?? tab.name
                if tab.type == "artifact" {
                    controller = ArtifactViewController(session: session, artifact: Artifact(id: id, version: 1, type: "", title: name, followsLatest: true))
                } else {
                    guard let agentId = try await session.client.tabAgent(kind: tab.type, id: id) else { return unavailable() }
                    controller = ChatViewController(session: session, agentId: agentId, title: name, spaceId: nil, intro: nil)
                }
            } else {
                controller = SurfaceScreens.make(session: session, surface: tab)
            }
            replace(controller)
        } catch {
            unavailable()
        }
    }

    private func replace(_ controller: UIViewController) {
        guard let navigation = navigationController, let index = navigation.viewControllers.firstIndex(where: { $0 === self }) else { return }
        MainPanelKey.record("surface:\(resource.id)", for: controller)
        var stack = navigation.viewControllers
        stack[index] = controller
        navigation.setViewControllers(stack, animated: false)
    }
}
#endif
