#if canImport(UIKit)
import HappyCore
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
        switch surface.type {
        case "document":
            return DocumentScreens.make(session: session, surfaceId: surface.id, name: surface.name)
        case "system_monitor":
            return MonitorViewController(session: session, surface: surface)
        case "todo":
            return TodoListViewController(session: session, surface: surface)
        case "vault":
            return VaultViewController(session: session, surfaceId: surface.id, vaultName: surface.name.isEmpty ? Strings.Vaults.title : surface.name)
        default:
            return SurfaceElsewhereViewController(surface: surface)
        }
    }
}
#endif
