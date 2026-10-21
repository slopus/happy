import Foundation

/// Git worktrees on a computer, through its `bash` RPC (utils/worktree.ts).
/// Happy puts them under `.dev/worktree/` in the repository.
public enum Worktrees {
    /// utils/worktreePaths.ts `WORKTREE_DIR`.
    public static let directory = ".dev/worktree"

    public struct Created: Equatable, Sendable {
        public var path: String
        public var branch: String
    }

    public enum Failure: Error, Equatable, LocalizedError {
        case notAGitRepository
        case unreachable(String)
        case failed(String)

        public var errorDescription: String? {
            switch self {
            case .notAGitRepository: "Not a Git repository"
            case .unreachable(let message), .failed(let message): message
            }
        }
    }

    /// One existing worktree: its path and branch.
    public struct Entry: Equatable, Sendable {
        public var path: String
        public var branch: String
    }

    static let adjectives = [
        "clever", "happy", "swift", "bright", "calm",
        "bold", "quiet", "brave", "wise", "eager",
        "gentle", "quick", "sharp", "smooth", "fresh",
    ]
    static let nouns = [
        "ocean", "forest", "cloud", "star", "river",
        "mountain", "valley", "bridge", "beacon", "harbor",
        "garden", "meadow", "canyon", "island", "desert",
    ]

    public static func randomName() -> String {
        "\(adjectives.randomElement()!)-\(nouns.randomElement()!)"
    }

    /// `createWorktree`: a new branch in a new worktree, named like
    /// `swift-river`, with `-2` to `-4` tried when the name is taken.
    public static func create(
        ops: any HomeOps,
        machineId: String,
        basePath: String,
        name: String = randomName()
    ) async -> Result<Created, Failure> {
        let check = await bash(ops, machineId, "git rev-parse --git-dir", basePath)
        guard check.success else {
            // -1 is the call itself failing, not git saying no.
            return .failure(check.exitCode == -1
                ? .unreachable(check.stderr.isEmpty ? "Failed to connect to machine" : check.stderr)
                : .notAGitRepository)
        }
        var result = await bash(ops, machineId, "git worktree add -b \(name) \(directory)/\(name)", basePath)
        if result.success {
            return .success(Created(path: "\(basePath)/\(directory)/\(name)", branch: name))
        }
        if result.stderr.contains("already exists") {
            for suffix in 2...4 {
                let numbered = "\(name)-\(suffix)"
                result = await bash(ops, machineId, "git worktree add -b \(numbered) \(directory)/\(numbered)", basePath)
                if result.success {
                    return .success(Created(path: "\(basePath)/\(directory)/\(numbered)", branch: numbered))
                }
            }
        }
        return .failure(.failed(result.stderr.isEmpty ? "Failed to create worktree" : result.stderr))
    }

    /// `listWorktrees`: every worktree but the main checkout, or none when
    /// the call fails.
    public static func list(ops: any HomeOps, machineId: String, basePath: String) async -> [Entry] {
        let result = await bash(ops, machineId, "git worktree list --porcelain", basePath)
        guard result.success else { return [] }
        return parse(result.stdout)
    }

    /// Porcelain blocks are separated by blank lines; the first is the main
    /// worktree.
    static func parse(_ porcelain: String) -> [Entry] {
        porcelain.components(separatedBy: "\n\n").dropFirst().compactMap { block in
            var path = ""
            var branch = ""
            for line in block.components(separatedBy: "\n") {
                if line.hasPrefix("worktree ") {
                    path = String(line.dropFirst("worktree ".count))
                } else if line.hasPrefix("branch refs/heads/") {
                    branch = String(line.dropFirst("branch refs/heads/".count))
                }
            }
            return path.isEmpty ? nil : Entry(path: path, branch: branch.isEmpty ? path : branch)
        }
    }

    /// ops.ts `machineBash`, which reports a failed call as exit code -1.
    private static func bash(_ ops: any HomeOps, _ machineId: String, _ command: String, _ cwd: String) async -> SessionBashResponse {
        do {
            return try await ops.machineBash(machineId: machineId, command: command, cwd: cwd)
        } catch {
            return SessionBashResponse(success: false, stdout: "", stderr: error.localizedDescription, exitCode: -1, error: nil)
        }
    }
}
