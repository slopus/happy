#if canImport(UIKit)
import HappyCore
import UIKit

/// The screen each kind of Surface opens on the phone: home's Surface rows
/// and the Surfaces list both open through here, so a kind's screen is
/// chosen in one place.
@MainActor
enum SurfaceScreens {
    static func make(session: Session, surface: AgentWire.Surface) -> UIViewController {
        switch surface.type {
        case "document":
            return DocumentScreens.make(session: session, surfaceId: surface.id, name: surface.name)
        case "system_monitor":
            return MonitorViewController(session: session, surface: surface)
        default:
            return SurfaceViewController(session: session, surface: surface)
        }
    }
}
#endif
