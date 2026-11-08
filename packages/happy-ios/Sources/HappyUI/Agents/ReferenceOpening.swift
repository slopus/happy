#if canImport(UIKit)
import HappyCore
import UIKit

extension UIViewController {
    /// What a message or a document names, opened over this screen: an
    /// artifact at the version the reference pinned, a Surface, or a
    /// conversation as its row in `rows` opens it. What `references`
    /// don't hold opens nothing.
    func openReference(_ reference: HappyReferences.Reference, references: References, rows: [Row], session: Session) {
        if reference.kind == "artifact" {
            // Still being read, the viewer reads it itself.
            var known: (title: String, type: String, latest: Int) = ("", "", 1)
            switch references.artifacts[reference.id] {
            case .active(let title, let type, let latest)?: known = (title, type, latest)
            case nil: let store = session.store; Task { await store.readArtifacts([reference.id]) }
            default: return
            }
            var artifact = Artifact(id: reference.id, version: reference.version ?? known.latest, type: known.type, title: known.title, followsLatest: reference.version == nil)
            artifact.pinned = reference.version != nil
            openArtifact(artifact, session: session)
            return
        }
        if reference.kind == "surface" {
            guard let surface = references.surfaces[reference.id] else { return }
            navigationController?.pushViewController(SurfaceScreens.make(session: session, surface: surface), animated: true)
            return
        }
        guard let entity = references.entity(reference) else { return }
        // A bot's or task's own conversation opens as its row opens it: renamed in its bar, its mark in the intro.
        let row = rows.first { $0.kind == .space && $0.agentId == entity.agentId }
        let intro: ChatViewController.Intro? = switch row?.mark {
        case .clay(let slug)?: .clay(slug)
        default: nil
        }
        let title = references.view(reference).label
        let chat = ChatViewController(session: session, agentId: entity.agentId, title: title, spaceId: row?.spaceId, intro: intro)
        navigationController?.pushViewController(chat, animated: true)
    }
}
#endif
