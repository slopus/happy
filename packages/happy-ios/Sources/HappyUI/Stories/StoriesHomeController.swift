#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The stories row on Stem Cells home: shown while the computer has Stories
/// on for the person, and drawn from what was kept before the computer
/// answers. With Stories off it has no height and home is as it was.
@MainActor
final class StoriesHomeController {
    let row = StoriesRowView()
    /// The row's height changed (0: not drawn).
    var onHeightChange: (() -> Void)?
    private weak var host: UIViewController?
    private(set) var session: StoriesSession?
    private var watch: StemCellsWatch?
    private var snapshot = StoriesSnapshot()

    init(host: UIViewController) {
        self.host = host
        row.isHidden = true
        row.onOpen = { [weak self] item in self?.open(item) }
        row.onAdd = { [weak self] in self?.compose() }
    }

    var height: CGFloat { snapshot.isOn ? StoriesRowLayout.Metrics.height : 0 }

    func attach(_ stemCells: StemCellsSession?) {
        guard stemCells?.accountID != session?.accountID else { return }
        watch?.invalidate(); watch = nil
        session = stemCells.map(StoriesSession.session(for:))
        row.images = stemCells?.images
        snapshot = StoriesSnapshot()
        row.apply([])
        if let session { watch = session.watch { [weak self] snapshot in self?.apply(snapshot) } }
        else { apply(StoriesSnapshot()) }
    }

    private func apply(_ next: StoriesSnapshot) {
        let wasOn = snapshot.isOn
        snapshot = next
        row.isHidden = !next.isOn
        if next.isOn {
            row.apply(StoriesRow.items(next.feed, myStory: Strings.Stories.myStory))
        }
        if wasOn != next.isOn { onHeightChange?() }
    }

    // MARK: Acts

    private func open(_ item: StoriesRowItem) {
        guard let session, let host, let feed = snapshot.feed,
              let index = feed.authors.firstIndex(where: { $0.key == item.id }) else { return }
        StoriesViewerPresenter.present(session: session, feed: feed, authorIndex: index, from: host, origin: row.circle(item.id))
    }

    private func compose() {
        guard let session, let host else { return }
        StoriesEditorPresenter.present(session: session, draft: nil, from: host)
    }
}
#endif
