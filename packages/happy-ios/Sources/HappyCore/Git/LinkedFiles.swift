import Foundation
import HappyWire

/// A file link (`happy://agents/<id>/files/Foo.tsx#L42`) read for the
/// read-only viewer, through the routes API.md's "Resolution" names: an
/// agent's workspace from `GET /v0/agents/:id`, then
/// `GET /v0/workspaces/:id/file`. Nothing is asked until the link is
/// opened.
public enum LinkedFiles {
    public enum Outcome: Equatable, Sendable {
        case file(FileViewer.Content)
        /// A picture or a recording (`FileViewer.mediaKind`), its bytes whole.
        case media(FileViewer.MediaKind, Data)
        /// The server said no (403): the reader's role doesn't reach it.
        case forbidden
        /// Not there to open: an unknown or archived agent, a missing
        /// file, or a server without workspace files yet (404, 501).
        case unavailable
        /// The read itself failed, as a network error does.
        case failed(String?)
    }

    /// What an error from either read means for the link.
    public static func outcome(_ error: any Error) -> Outcome {
        guard case AgentClientError.status(let status, _, let message) = error else { return .failed(nil) }
        if status == 403 { return .forbidden }
        // A conflict (a checkout still starting), a timeout or a limit may pass.
        if status == 501 || ((400..<500).contains(status) && ![408, 409, 429].contains(status)) { return .unavailable }
        return .failed(message)
    }

    /// The file's base64 as the viewer shows it: a picture's or a
    /// recording's bytes, else its text (`FileViewer.decode`).
    public static func read(_ base64: String, path: String) -> Outcome {
        if let kind = FileViewer.mediaKind(path), let bytes = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) {
            return .media(kind, bytes)
        }
        return .file(FileViewer.decode(base64: base64))
    }
}

extension AgentClient {
    /// The file `link` names, read once.
    public func linkedFile(_ link: HappyLink.File) async -> LinkedFiles.Outcome {
        do {
            let workspaceId: String
            switch link.target {
            case .workspace(let id): workspaceId = id
            case .agent(let id):
                let agent = try await agent(id)
                guard agent.archivedAt == nil else { return .unavailable }
                workspaceId = agent.workspaceId
            }
            let base64 = try await workspaceFile(workspaceId, path: link.path)
            return LinkedFiles.read(base64, path: link.path)
        } catch {
            return LinkedFiles.outcome(error)
        }
    }
}
