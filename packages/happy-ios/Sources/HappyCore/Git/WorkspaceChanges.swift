import Foundation
import HappyWire

/// A Happy Agent workspace's changes over the agent API (API.md "Git" and
/// "Files"): the git state's files against its comparison base, each file's
/// base side from `file-revision` and its working side from `file`. The
/// snapshot and file reads are the session RPC's, so `HappyAgentChanges`
/// turns them into the changes list as it does for a Happy CLI session.
extension AgentClient {
    /// `GET /v0/workspaces/:id/git`; nil for a workspace without a repository.
    public func workspaceGit(_ workspaceId: String) async throws -> HappyAgentGitState? {
        do {
            let response = try await decode(JSONValue.self, "GET", "/v0/workspaces/\(Self.escape(workspaceId))/git")
            guard let git = response["git"] else { throw AgentClientError.invalidResponse }
            return try HappyAgentGitState(WorkspaceChanges.normalized(git), base: WorkspaceChanges.commitish)
        } catch AgentClientError.status(404, _, _) {
            return nil
        }
    }

    /// One changed file's two sides, as the changes list shows them.
    public func workspaceFileContent(_ workspaceId: String, base: String, file: HappyAgentGitFile) async throws -> HappyAgentFileContent {
        try await HappyAgentGitFileRead.content(file) { path, after in
            guard let path else { return .success(nil) }
            do {
                return .success(after ? try await self.workspaceFile(workspaceId, path: path) : try await self.workspaceFileRevision(workspaceId, path: path, revision: base))
            } catch {
                return .failure(WorkspaceChanges.failure(error))
            }
        }
    }

    /// `GET /v0/workspaces/:id/file`: the file's bytes as base64.
    func workspaceFile(_ workspaceId: String, path: String) async throws -> String {
        struct Response: Decodable { let content: String }
        return try await decode(Response.self, "GET", "/v0/workspaces/\(Self.escape(workspaceId))/file?path=\(Self.escape(path))").content
    }

    /// `GET /v0/workspaces/:id/file-revision`: nil where the path doesn't
    /// exist at that revision.
    func workspaceFileRevision(_ workspaceId: String, path: String, revision: String) async throws -> String? {
        struct Response: Decodable { let content: String }
        do {
            return try await decode(Response.self, "GET", "/v0/workspaces/\(Self.escape(workspaceId))/file-revision?path=\(Self.escape(path))&revision=\(Self.escape(revision))").content
        } catch AgentClientError.status(404, _, _) {
            return nil
        }
    }
}

public enum WorkspaceChanges {
    /// The API leaves out what the session RPC sends as null (a detached
    /// head's branch, a missing upstream or base); the snapshot reads both.
    public static func normalized(_ git: JSONValue) -> JSONValue {
        guard var object = git.objectValue else { return git }
        if var facts = object["facts"]?.objectValue {
            for key in ["branch", "head", "upstream"] where facts[key] == nil { facts[key] = .null }
            object["facts"] = .object(facts)
        }
        if object["base"] == nil { object["base"] = .null }
        return .object(object)
    }

    /// The agent API's comparison base: a hash or a ref, never empty.
    public static func commitish(_ base: String) -> Bool { !base.isEmpty }

    /// What a failed read says in the list: the computer's own words, or ours.
    static func failure(_ error: any Error) -> any Error {
        switch error {
        case AgentClientError.status(413, _, _): SessionActionError.failed("This file is too large to preview on the phone.")
        case AgentClientError.status(_, _, let message?) where !message.isEmpty: SessionActionError.failed(message)
        default: error
        }
    }
}
