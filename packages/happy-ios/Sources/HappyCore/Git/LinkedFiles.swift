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
            return .file(FileViewer.decode(base64: try await workspaceFile(workspaceId, path: link.path)))
        } catch {
            return LinkedFiles.outcome(error)
        }
    }
}
