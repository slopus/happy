#if canImport(UIKit)
import HappyCore
import UIKit

/// The screen each kind of Surface opens on the phone: home's Surface rows
/// and the Surfaces list both open through here, so a kind's screen is
/// chosen in one place.
@MainActor
enum SurfaceScreens {
    /// The screen for `surface`, which the person is opening: the Feed
    /// counts it seen, and one they aren't in is joined.
    static func make(session: Session, surface: AgentWire.Surface) -> UIViewController {
        let subject = FeedSubject(type: "surface", id: surface.id)
        Task { [feed = session.engine.feed] in await feed.seen(subject) }
        // It takes its place in their sidebar, as desktop's opening does (de78af49).
        Task { [engine = session.engine] in await engine.join(surfaceId: surface.id) }
        switch surface.type {
        case "document":
            return DocumentScreens.make(session: session, surfaceId: surface.id, name: surface.name)
        case "system_monitor":
            return MonitorViewController(session: session, surface: surface)
        case "todo":
            return TodoListViewController(session: session, surface: surface)
        case "vault":
            // Listed but closed to the person's role: its name, and why,
            // with nothing asked of the server.
            let access = session.vaultAccesses[surface.id] ?? (surface.access != nil ? surface.vaultAccess : session.vaultAccess(surface.id))
            if access.isLocked { return SurfaceElsewhereViewController(surface: surface, message: Strings.Vaults.locked, identifier: "vault-locked") }
            return VaultViewController(session: session, surfaceId: surface.id, vaultName: surface.name.isEmpty ? Strings.Vaults.title : surface.name)
        default:
            return SurfaceElsewhereViewController(surface: surface)
        }
    }
}
#endif
