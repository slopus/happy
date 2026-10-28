import AppKit
import HappyCore
import HappyLayout

final class MacConversationView: FlippedView, NSTableViewDataSource, NSTableViewDelegate, NSTextViewDelegate {
    let title = NSTextField(labelWithString: "Select a session")
    let table = NSTableView()
    let composer = NSTextView()
    let send = NSButton(title: "Send", target: nil, action: nil)
    let more = NSButton(title: "Load older", target: nil, action: nil)
    let stop = NSButton(title: "Stop", target: nil, action: nil)
    let hint = NSTextField(labelWithString: "⌘ Return to send")
    private let transcriptScroll = NSScrollView()
    private let composerScroll = NSScrollView()
    private let tools = NSStackView()
    private var rows: [ConversationRow] = []
    private var expanded = Set<String>()
    var onSend: (() -> Void)?
    var onPermission: ((String, Bool) -> Void)?
    var onRetry: ((String) -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        title.font = .systemFont(ofSize: 20, weight: .semibold)
        table.addTableColumn(NSTableColumn(identifier: .init("message")))
        table.headerView = nil; table.intercellSpacing = NSSize(width: 0, height: 14)
        table.selectionHighlightStyle = .none; table.usesAutomaticRowHeights = true
        table.dataSource = self; table.delegate = self
        transcriptScroll.documentView = table; transcriptScroll.hasVerticalScroller = true
        transcriptScroll.drawsBackground = false; table.backgroundColor = .windowBackgroundColor
        composer.isRichText = false; composer.font = .systemFont(ofSize: 14)
        composer.isVerticallyResizable = true; composer.isHorizontallyResizable = false
        composer.textContainer?.widthTracksTextView = true
        composer.textContainerInset = NSSize(width: 12, height: 12)
        composer.delegate = self
        composerScroll.documentView = composer; composerScroll.hasVerticalScroller = true
        composerScroll.borderType = .bezelBorder
        tools.orientation = .horizontal; tools.spacing = 8
        for button in [more, stop] { button.bezelStyle = .rounded; tools.addArrangedSubview(button) }
        send.bezelStyle = .rounded; send.bezelColor = .controlAccentColor
        send.target = self; send.action = #selector(sendPressed)
        hint.font = .systemFont(ofSize: 11); hint.textColor = .secondaryLabelColor
        for view in [title, tools, transcriptScroll, composerScroll, send, hint] { addSubview(view) }
        setEnabled(false)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override func layout() {
        super.layout()
        let frames = MacConversationLayout(size: bounds.size)
        title.frame = frames.title; tools.frame = frames.tools; transcriptScroll.frame = frames.transcript
        composerScroll.frame = frames.composer; send.frame = frames.send; hint.frame = frames.hint
        composer.setFrameSize(NSSize(width: composerScroll.contentSize.width, height: composer.frame.height))
    }
    func setEnabled(_ enabled: Bool) {
        composer.isEditable = enabled; send.isEnabled = enabled; stop.isEnabled = enabled
    }
    func update(_ next: [ConversationRow], changes: ConversationChanges, hasMore: Bool) {
        let old = rows
        let atBottom = table.numberOfRows == 0 || transcriptScroll.contentView.bounds.maxY >= table.bounds.maxY - 80
        rows = next; more.isEnabled = hasMore
        if changes.membershipChanged || table.numberOfRows != next.count {
            let difference = next.map(\.id).difference(from: old.map(\.id))
            table.beginUpdates()
            table.removeRows(at: IndexSet(difference.removals.map { if case .remove(let index, _, _) = $0 { return index }; return 0 }), withAnimation: [])
            table.insertRows(at: IndexSet(difference.insertions.map { if case .insert(let index, _, _) = $0 { return index }; return 0 }), withAnimation: [])
            table.endUpdates()
        }
        for index in changes.changed where index < rows.count {
            if let cell = table.view(atColumn: 0, row: index, makeIfNecessary: false) as? MacMessageCell { configure(cell, at: index) }
        }
        table.noteHeightOfRows(withIndexesChanged: changes.changed)
        if atBottom, !rows.isEmpty { table.scrollRowToVisible(rows.count - 1) }
    }
    @objc private func sendPressed() { onSend?() }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers == "\r", composer.isEditable {
            onSend?(); return true
        }
        return super.performKeyEquivalent(with: event)
    }
    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { false }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let cell = tableView.makeView(withIdentifier: .init("message-cell"), owner: self) as? MacMessageCell ?? MacMessageCell()
        cell.identifier = .init("message-cell"); configure(cell, at: row); return cell
    }
    private func configure(_ cell: MacMessageCell, at index: Int) {
        let row = rows[index]
        cell.update(row, expanded: expanded.contains(row.id))
        cell.onToggle = { [weak self, weak cell] in
            guard let self, let cell, let current = self.rows.firstIndex(where: { $0.id == row.id }) else { return }
            if !self.expanded.insert(row.id).inserted { self.expanded.remove(row.id) }
            self.configure(cell, at: current)
            self.table.noteHeightOfRows(withIndexesChanged: IndexSet(integer: current))
        }
        cell.onPermission = { [weak self] allow in if let id = row.permissionID { self?.onPermission?(id, allow) } }
        cell.onRetry = { [weak self] in if let id = row.localID { self?.onRetry?(id) } }
    }
}

final class MacMessageCell: NSTableCellView {
    private let heading = NSTextField(labelWithString: "")
    private let body = NSTextField(wrappingLabelWithString: "")
    private let toggle = NSButton(title: "Show output", target: nil, action: nil)
    private let approve = NSButton(title: "Allow", target: nil, action: nil)
    private let deny = NSButton(title: "Deny", target: nil, action: nil)
    private let retry = NSButton(title: "Retry sending", target: nil, action: nil)
    private let status = NSTextField(labelWithString: "")
    var onToggle: (() -> Void)?
    var onPermission: ((Bool) -> Void)?
    var onRetry: (() -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        heading.font = .systemFont(ofSize: 12, weight: .semibold)
        body.font = .systemFont(ofSize: 14); body.isSelectable = true; body.maximumNumberOfLines = 0
        status.font = .systemFont(ofSize: 11); status.textColor = .secondaryLabelColor
        let actions = NSStackView(views: [toggle, approve, deny, retry]); actions.spacing = 8
        let stack = NSStackView(views: [heading, body, status, actions])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false; addSubview(stack)
        for button in [toggle, approve, deny, retry] { button.bezelStyle = .rounded; button.target = self }
        toggle.action = #selector(togglePressed); approve.action = #selector(allowPressed)
        deny.action = #selector(denyPressed); retry.action = #selector(retryPressed)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
            body.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }
    convenience init() { self.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    func update(_ row: ConversationRow, expanded: Bool) {
        heading.stringValue = row.heading
        heading.textColor = row.kind == .user ? .controlAccentColor : .secondaryLabelColor
        body.stringValue = row.text + (expanded ? row.detail.map { "\n\n" + $0 } ?? "" : "")
        toggle.isHidden = row.detail == nil; toggle.title = expanded ? "Hide output" : "Show output"
        approve.isHidden = row.permissionID == nil; deny.isHidden = row.permissionID == nil
        retry.isHidden = true
        switch row.delivery {
        case .queued: status.stringValue = "Queued"
        case .sending: status.stringValue = "Sending…"
        case .failed: status.stringValue = "Delivery failed"; retry.isHidden = false
        case nil: status.stringValue = ""
        }
        status.isHidden = status.stringValue.isEmpty
    }
    @objc private func togglePressed() { onToggle?() }
    @objc private func allowPressed() { onPermission?(true) }
    @objc private func denyPressed() { onPermission?(false) }
    @objc private func retryPressed() { onRetry?() }
}