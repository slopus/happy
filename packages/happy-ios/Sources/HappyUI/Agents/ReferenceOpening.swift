#if canImport(UIKit)
import HappyCore
import HappyWire
import UIKit

extension UIViewController {
    /// A Happy link tapped in a message or a document, `happy://` or a
    /// share link: what this conversation's installation holds opens here
    /// (a file through `file`, when given); anything else goes through
    /// instance-link routing, which opens it on its connection or says it
    /// can't. False for a link that is no Happy link.
    func openHappyLink(_ text: String, references: References, rows: [Row], session: Session, file: ((HappyLink.File) -> Void)? = nil) -> Bool {
        guard let link = ChatLinks.happyLink(text) else { return HappyLink.isHappyURL(text) }
        switch ChatLinks.kind(text, references: references) {
        case .here(_, _):
            switch link.target {
            case .reference(let named):
                openReference(.init(kind: named.kind.rawValue, id: named.id, version: named.version, workspaceId: named.workspaceId), references: references, rows: rows, session: session)
                return true
            case .settings(let page):
                SettingsLinks.open(page, options: link.providerOptions, session: session, from: self)
                return true
            case .file(let linked):
                if let file { file(linked); return true }
            }
        case .mention, .words:
            return true
        case .elsewhere, .web:
            break
        }
        // A link naming no installation is this conversation's.
        let instanceId = link.instanceId ?? session.instanceId
        openHappyLink(instanceId.flatMap { HappyLink(link.target, instanceId: $0).url } ?? text)
        return true
    }

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
