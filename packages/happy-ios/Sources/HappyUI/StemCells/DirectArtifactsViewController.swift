#if canImport(UIKit)
import HappyCore
import HappyWire
import UIKit

/// Desktop's fixed Artifacts row opens the same catalog, with its last page
/// available offline. The existing artifact viewer handles each entry.
final class DirectArtifactsViewController: UITableViewController {
    private let session: StemCellsSession
    private var artifacts: [StemCellArtifact] = []
    private var nextPage: String?
    private var reading: Task<Void, Never>?
    private var following: Task<Void, Never>?
    private var source: UITableViewDiffableDataSource<Int, String>?

    init(session: StemCellsSession) {
        self.session = session
        super.init(style: .plain)
        title = "Artifacts"
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "artifact")
        tableView.accessibilityIdentifier = "direct-artifacts"
        source = UITableViewDiffableDataSource(tableView: tableView) { [weak self] table, index, id in
            let cell = table.dequeueReusableCell(withIdentifier: "artifact", for: index)
            var content = cell.defaultContentConfiguration()
            content.text = self?.artifacts.first { $0.id == id }?.title
            cell.contentConfiguration = content
            cell.accessoryType = .disclosureIndicator
            return cell
        }
        following = Task { [weak self, engine = session.engine, store = session.store] in
            if let value = try? await engine.cachedResource("artifacts") { await self?.apply(value, append: false) }
            self?.read()
            for await _ in await store.events(matching: ["artifact."]) {
                guard !Task.isCancelled else { return }
                self?.read()
            }
        }
    }

    private func read(append: Bool = false) {
        guard reading == nil else { return }
        let cursor = append ? nextPage : nil
        reading = Task { [weak self, session] in
            defer { self?.reading = nil }
            do {
                let value = try await session.client.artifacts(pageCursor: cursor)
                if !append { try await session.engine.keepResource("artifacts", value: value) }
                guard !Task.isCancelled else { return }
                await self?.apply(value, append: append)
            } catch { }
        }
    }

    private func apply(_ value: JSONValue, append: Bool) async {
        let rows = await Task.detached {
            (value["artifacts"]?.arrayValue ?? []).compactMap { item -> StemCellArtifact? in
                guard let id = item["id"]?.stringValue else { return nil }
                return StemCellArtifact(id: id, version: Int(item["latestVersion"]?.numberValue ?? 1), type: item["type"]?.stringValue ?? "", title: item["title"]?.stringValue ?? "Untitled", followsLatest: true)
            }
        }.value
        let known = Set(artifacts.map(\.id))
        let next = append ? artifacts + rows.filter { !known.contains($0.id) } : rows
        nextPage = value["nextPageCursor"]?.stringValue
        guard next != artifacts else { return }
        let changed = next.filter { item in artifacts.contains { $0.id == item.id && $0 != item } }.map(\.id)
        artifacts = next
        var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
        snapshot.appendSections([0])
        snapshot.appendItems(next.map(\.id))
        snapshot.reconfigureItems(changed)
        await source?.apply(snapshot, animatingDifferences: !known.isEmpty)
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        navigationController?.pushViewController(StemCellArtifactViewController(session: session, artifact: artifacts[indexPath.row]), animated: true)
    }
    override func tableView(_ tableView: UITableView, willDisplay cell: UITableViewCell, forRowAt indexPath: IndexPath) {
        if indexPath.row == artifacts.count - 1, nextPage != nil { read(append: true) }
    }
    isolated deinit { reading?.cancel(); following?.cancel() }
}
#endif