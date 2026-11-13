#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A `gen_ui` artifact drawn in a conversation, under its card: the
/// version and the planner its row was sized by, at the width it was
/// planned at. The view builds its nodes from that same plan.
struct GenUIEmbed: Equatable, Sendable {
    var artifactId: String
    var version: Int
    var title: String
    /// What its viewer groups are read from; its planner stands for it.
    var document: GenUIRenderDocument
    var planner: GenUIPlanner
    var width: CGFloat
    /// What its elements may run in this conversation.
    var runs: GenUIRuns

    var height: CGFloat { planner.height(width: width) }

    static func == (a: GenUIEmbed, b: GenUIEmbed) -> Bool {
        a.artifactId == b.artifactId && a.version == b.version && a.title == b.title && a.planner === b.planner && a.width == b.width && a.runs == b.runs
    }
}

/// The planners of the documents conversations draw, one per version and
/// text size, kept across rows and plans so a document is read once and
/// each width planned once (RENDER.md M9). Safe from any thread.
enum GenUIPlanners {
    private struct Key: Hashable {
        var artifactId: String
        var version: Int
        var traits: GenUITraits
    }

    /// Enough for every Gen UI a long conversation shows.
    static let limit = 64
    private static let lock = NSLock()
    nonisolated(unsafe) private static var planners: [Key: GenUIPlanner] = [:]

    static func planner(_ artifactId: String, version: Int, document: GenUIRenderDocument, traits: GenUITraits) -> GenUIPlanner {
        let key = Key(artifactId: artifactId, version: version, traits: traits)
        return lock.withLock {
            if let planner = planners[key] { return planner }
            if planners.count >= limit { planners.removeAll() }
            let planner = GenUIPlanner(document: document, traits: traits)
            planners[key] = planner
            return planner
        }
    }

    /// The embed a message draws for `artifact` at the column `width`, or
    /// nil when the conversation doesn't draw it: one read that follows
    /// the latest version, or names it. `server` is the conversation's
    /// (nil for a paired computer) and `agentId` its agent: a `message`
    /// goes only into the origin agent's own conversation.
    static func embed(_ artifact: Artifact, references: References, width: CGFloat, environment: TextEnvironment?, server: String?, agentId: String?) -> GenUIEmbed? {
        guard let read = references.genUI[artifact.id], artifact.opensLatest || artifact.version == read.version, width > 0 else { return nil }
        let traits = GenUITraits(text: environment, displayScale: environment?.displayScale ?? 2)
        let planner = planner(artifact.id, version: read.version, document: read.document, traits: traits)
        let host = GenUIHost(server: HappyCloud.isCloud(server) ? .cluster : .happyAgent, origin: read.origin != nil, served: references.genUIServed)
        let runs = GenUIRuns(host: host, sends: read.origin != nil && read.origin == agentId)
        return GenUIEmbed(artifactId: artifact.id, version: read.version, title: artifact.title, document: read.document, planner: planner, width: width, runs: runs)
    }
}

extension GenUIBlockView {
    /// A conversation's Gen UI: the plan its row was sized by, its pictures
    /// read through the computer the conversation is on, a tile opening
    /// the viewer on its group.
    func apply(_ embed: GenUIEmbed) {
        accessibilityIdentifier = "chat-gen-ui"
        let files = GenUIChatFiles(view: self, artifactId: embed.artifactId, version: embed.version)
        interaction.onAction = { [weak self] key, action in
            guard let self, let host = GenUIChatFiles.host(self) as? GenUIActing else { return }
            host.genUI(run: action, key: key, artifactId: embed.artifactId, version: embed.version)
        }
        interaction.onViewer = { [weak self] _, group, index in
            Task { @MainActor in
                guard let self, let resolved = await files.resolved() else { return }
                let (pictures, start) = resolved.viewer(embed.document.viewers[group] ?? [], at: index)
                guard !pictures.isEmpty, let controller = self.closestController else { return }
                controller.present(PictureViewController(source: resolved.media, pictures: pictures, index: start), animated: true)
            }
        }
        show(embed.planner, width: embed.width, identity: "\(embed.artifactId)/\(embed.version)", files: files, runs: embed.runs)
    }

    fileprivate var closestController: UIViewController? {
        var responder: UIResponder? = self
        while let current = responder {
            if let controller = current as? UIViewController { return controller }
            responder = current.next
        }
        return nil
    }
}

/// A conversation's Gen UI pictures: its version's files, read through
/// the computer the conversation is on (`PageHosting`, up the responder
/// chain) once the view is in it. A version's files are listed once,
/// however many rows show it.
@MainActor
final class GenUIChatFiles: GenUIFiles {
    private weak var view: UIView?
    private let artifactId: String
    private let version: Int
    private static var versions: [String: Task<GenUIArtifactFiles?, Never>] = [:]

    init(view: UIView, artifactId: String, version: Int) {
        self.view = view
        self.artifactId = artifactId
        self.version = version
    }

    func image(_ path: String, pixels: Int) async -> UIImage? {
        await resolved()?.image(path, pixels: pixels)
    }

    /// The version's files, once the view is in a conversation; nil when
    /// it isn't within a few seconds, or the version can't be read.
    func resolved() async -> GenUIArtifactFiles? {
        let key = "\(artifactId)/\(version)"
        if let held = Self.versions[key] { return await held.value }
        var host: PageHosting?
        for _ in 0..<50 {
            host = view.flatMap(Self.host)
            if host != nil || Task.isCancelled { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        guard let client = host?.pageClient else { return nil }
        if let held = Self.versions[key] { return await held.value }
        let (artifactId, version) = (artifactId, version)
        let task = Task { @MainActor () -> GenUIArtifactFiles? in
            guard let read = try? await client.artifactVersion(artifactId, version: version) else { return nil }
            return GenUIArtifactFiles(media: ArtifactMedia(client: client, artifactId: artifactId, version: version), files: read.files)
        }
        Self.versions[key] = task
        let files = await task.value
        // A failed read is tried again by the next picture.
        if files == nil { Self.versions[key] = nil }
        return files
    }

    static func host(_ view: UIView) -> PageHosting? {
        var responder: UIResponder? = view
        while let current = responder {
            if let host = current as? PageHosting { return host }
            responder = current.next
        }
        return nil
    }
}
#endif
