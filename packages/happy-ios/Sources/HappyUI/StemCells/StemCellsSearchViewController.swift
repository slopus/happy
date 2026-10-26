#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// The sidebar's Search row: every row of the sidebar, folded away or not,
/// whose name holds what was typed, drawn as the sidebar draws them.
final class StemCellsSearchViewController: UIViewController, UISearchBarDelegate {
    private let session: StemCellsSession
    private let onOpen: (StemCellsRow) -> Void
    private let searchBar = UISearchBar()
    private let list = StemCellsSidebarView()
    private var watch: StemCellsWatch?
    private var all: [StemCellsRow] = []
    private var query = ""

    init(session: StemCellsSession, onOpen: @escaping (StemCellsRow) -> Void) {
        self.session = session
        self.onOpen = onOpen
        super.init(nibName: nil, bundle: nil)
        title = Strings.StemCells.search
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        // The conversation's own ground, light and dark.
        view.backgroundColor = UIColor(Palette.surface)
        searchBar.searchBarStyle = .minimal
        searchBar.placeholder = Strings.StemCells.search
        searchBar.delegate = self
        searchBar.autocapitalizationType = .none
        view.addSubview(list)
        view.addSubview(searchBar)
        list.images = session.images
        list.keyboardDismissMode = .onDrag
        list.onSelect = { [weak self] row in self?.onOpen(row) }
        watch = session.watch { [weak self] snapshot in
            self?.all = snapshot.allRows
            self?.filter()
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(false, animated: animated)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if query.isEmpty { searchBar.becomeFirstResponder() }
    }

    func searchBar(_ searchBar: UISearchBar, textDidChange searchText: String) {
        query = searchText
        filter()
    }

    func searchBarSearchButtonClicked(_ searchBar: UISearchBar) { searchBar.resignFirstResponder() }

    private func filter() {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let matches = all.filter { row in
            guard row.kind == .space || row.kind == .session else { return false }
            return needle.isEmpty || row.label.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }.map { row in
            var flat = row
            flat.depth = 0
            return flat
        }
        list.apply(matches)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let barHeight = searchBar.sizeThatFits(CGSize(width: view.bounds.width, height: 56)).height
        let layout = StemCellsSearchLayout(width: view.bounds.width, safeArea: LayoutInsets(view.safeAreaInsets), barHeight: barHeight)
        searchBar.frame = layout.bar
        list.frame = view.bounds
        list.contentInset = UIEdgeInsets(layout.listInsets)
    }
}
#endif
