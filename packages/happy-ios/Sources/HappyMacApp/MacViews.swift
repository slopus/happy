import AppKit
import HappyCore
import HappyLayout

class FlippedView: NSView {
    override var isFlipped: Bool { true }
    override var isOpaque: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        dirtyRect.fill()
    }
}

final class MacRootView: FlippedView {
    let sidebar = MacSidebarView()
    let welcome = MacWelcomeView()
    let conversation = MacConversationView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        addSubview(sidebar); addSubview(welcome); addSubview(conversation)
        conversation.isHidden = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layout() {
        super.layout()
        let frames = MacDesktopLayout(size: bounds.size)
        sidebar.frame = frames.sidebar
        welcome.frame = frames.content
        conversation.frame = frames.content
    }
}

final class MacWelcomeView: FlippedView {
    let title = NSTextField(labelWithString: "Happy\nEngineering")
    let subtitle = NSTextField(wrappingLabelWithString: "Your coding agents, on your Mac.")
    let detail = NSTextField(wrappingLabelWithString: "End-to-end encrypted.\nNo email, no password.")
    let create = NSButton(title: "Create account", target: nil, action: nil)
    let restore = NSButton(title: "Restore existing account…", target: nil, action: nil)
    let server = NSButton(title: "Server settings…", target: nil, action: nil)
    let status = NSTextField(wrappingLabelWithString: "")
    private let stack = NSStackView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        title.font = .systemFont(ofSize: 46, weight: .bold)
        title.textColor = .labelColor
        subtitle.font = .systemFont(ofSize: 23, weight: .semibold)
        detail.font = .systemFont(ofSize: 16)
        detail.textColor = .secondaryLabelColor
        status.font = .systemFont(ofSize: 12)
        status.textColor = .secondaryLabelColor
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 20
        for view in [title, subtitle, detail, create, restore, server, status] {
            stack.addArrangedSubview(view)
        }
        for button in [create, restore, server] {
            button.bezelStyle = .rounded; button.controlSize = .large
        }
        create.bezelColor = .controlAccentColor
        create.keyEquivalent = "\r"
        addSubview(stack)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override func layout() {
        super.layout()
        stack.frame = MacWelcomeLayout(size: bounds.size, measuredHeight: stack.fittingSize.height).content
    }
}

final class MacSidebarView: NSVisualEffectView, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate {
    override var isFlipped: Bool { true }
    let title = NSTextField(labelWithString: "Happy")
    let search = NSSearchField()
    let table = NSTableView()
    let footer = NSButton(title: "Account & settings", target: nil, action: nil)
    let empty = NSTextField(wrappingLabelWithString: "Sign in to see your sessions")
    private let scroll = NSScrollView()
    private var allRows: [SessionRow] = []
    private var rows: [SessionRow] = []
    var onSelect: ((String) -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        material = .sidebar; blendingMode = .behindWindow
        title.font = .systemFont(ofSize: 25, weight: .bold)
        search.placeholderString = "Search sessions"; search.delegate = self
        table.addTableColumn(NSTableColumn(identifier: .init("session")))
        table.headerView = nil; table.rowHeight = 62; table.intercellSpacing = .zero
        table.style = .sourceList; table.dataSource = self; table.delegate = self
        scroll.documentView = table; scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        footer.bezelStyle = .rounded
        empty.font = .systemFont(ofSize: 13); empty.textColor = .secondaryLabelColor
        for view in [title, search, scroll, empty, footer] { addSubview(view) }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override func layout() {
        super.layout()
        let frames = MacSidebarLayout(size: bounds.size)
        title.frame = frames.brand; search.frame = frames.search
        scroll.frame = frames.list; empty.frame = frames.list; footer.frame = frames.account
    }
    func update(_ rows: [SessionRow], signedIn: Bool) {
        allRows = rows
        empty.stringValue = signedIn ? "No sessions yet.\nConnect a computer to get started." : "Sign in to see your sessions"
        filter()
    }
    func controlTextDidChange(_ obj: Notification) { filter() }
    private func filter() {
        let query = search.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let next = allRows.filter { query.isEmpty || ($0.title ?? "New chat").localizedCaseInsensitiveContains(query) || $0.projectName.localizedCaseInsensitiveContains(query) }
        let old = rows
        let selected = table.selectedRow >= 0 && table.selectedRow < rows.count ? rows[table.selectedRow].id : nil
        rows = next
        if old.map(\.id) != next.map(\.id) {
            let difference = next.map(\.id).difference(from: old.map(\.id))
            table.beginUpdates()
            table.removeRows(at: IndexSet(difference.removals.map { if case .remove(let i, _, _) = $0 { return i }; return 0 }), withAnimation: [])
            table.insertRows(at: IndexSet(difference.insertions.map { if case .insert(let i, _, _) = $0 { return i }; return 0 }), withAnimation: [])
            table.endUpdates()
        }
        for index in next.indices where index >= old.count || old[index] != next[index] {
            (table.view(atColumn: 0, row: index, makeIfNecessary: false) as? MacSessionCell)?.update(next[index])
        }
        if let selected, let index = rows.firstIndex(where: { $0.id == selected }) { table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false) }
        empty.isHidden = !rows.isEmpty
    }
    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let cell = tableView.makeView(withIdentifier: .init("session-cell"), owner: self) as? MacSessionCell ?? MacSessionCell()
        cell.identifier = .init("session-cell"); cell.update(rows[row]); return cell
    }
    func tableViewSelectionDidChange(_ notification: Notification) {
        guard table.selectedRow >= 0, table.selectedRow < rows.count else { return }
        onSelect?(rows[table.selectedRow].id)
    }
}

final class MacSessionCell: NSTableCellView {
    private let heading = NSTextField(labelWithString: "")
    private let subtitle = NSTextField(labelWithString: "")
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        heading.font = .systemFont(ofSize: 13, weight: .semibold); heading.lineBreakMode = .byTruncatingTail
        subtitle.font = .systemFont(ofSize: 11); subtitle.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [heading, subtitle])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 5
        stack.translatesAutoresizingMaskIntoConstraints = false; addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }
    convenience init() { self.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    func update(_ row: SessionRow) {
        heading.stringValue = row.title ?? "New chat"
        subtitle.stringValue = row.projectName + "  ·  " + row.timestamp
        heading.textColor = row.state == .thinking ? .controlAccentColor : .labelColor
    }
}