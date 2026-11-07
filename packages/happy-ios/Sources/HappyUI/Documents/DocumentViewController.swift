#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A document Surface, open for editing (docs/DOCUMENT-EDITOR.md): drawn
/// from what this phone kept the moment it opens, kept in step with the
/// computer by its `DocumentSync`, and with whoever else has it open.
@MainActor
final class DocumentViewController: UIViewController {
    private let session: Session
    let surfaceId: String
    private var name: String
    private let textView = DocumentTextView()
    private let toolbar = DocumentToolbar()
    private let status = UILabel()
    private let cursors = DocumentCursorsView()
    private let moreItem = UIBarButtonItem()
    private let peersItem = UIBarButtonItem()
    private var controller: DocumentTextController?
    private var sync: DocumentSync?
    private var following: Task<Void, Never>?
    private var save: DocumentSaveState = .saved
    private var notice: String?
    private var noticeClearing: Task<Void, Never>?
    private var peers: [DocumentPeer] = []
    private var keyboard: CGFloat = 0
    private var styleTraits: UITraitCollection?
    private var released = false
    private var accessWatch: Watch?
    /// The person's role may edit, rename and leave it; else it reads.
    private var writable: Bool { session.gate.allows(.contentWrite) }

    init(session: Session, surfaceId: String, name: String) {
        self.session = session
        self.surfaceId = surfaceId
        self.name = name
        super.init(nibName: nil, bundle: nil)
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.documentGround)
        textView.isEditable = false
        textView.inputAccessoryView = toolbar
        textView.addSubview(cursors)
        view.addSubview(textView)
        status.numberOfLines = 0
        status.textAlignment = .center
        status.font = .preferredFont(forTextStyle: .subheadline)
        status.adjustsFontForContentSizeCategory = true
        status.textColor = UIColor(Palette.documentSecondary)
        status.text = Strings.Documents.loading
        status.accessibilityIdentifier = "document.status"
        view.addSubview(status)
        toolbar.onTool = { [weak self] in self?.controller?.run($0) }
        toolbar.onStyle = { [weak self] in self?.controller?.setStyle($0) }
        toolbar.onDone = { [weak self] in self?.textView.resignFirstResponder() }
        setUpNavigation()
        accessWatch = session.watchAccess { [weak self] in
            guard let self else { return }
            setUpNavigation()
            if controller != nil, status.isHidden { textView.isEditable = writable }
            if !writable { textView.resignFirstResponder() }
        }
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (self: Self, _) in self.restyle() }
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.showPeers() }
        open()
    }

    private func setUpNavigation() {
        navigationItem.title = name.isEmpty ? Strings.Documents.untitled : name
        let more = moreItem
        more.image = UIImage(systemName: "ellipsis")
        let history = UIAction(title: Strings.Documents.history, image: UIImage(systemName: "clock.arrow.circlepath")) { [weak self] _ in self?.showHistory() }
        more.menu = UIMenu(children: !writable ? [history] : [
            UIAction(title: Strings.Documents.rename, image: UIImage(systemName: "pencil")) { [weak self] _ in self?.rename() },
            history,
            UIAction(title: Strings.Documents.leave, image: UIImage(systemName: "rectangle.portrait.and.arrow.right"), attributes: .destructive) { [weak self] _ in self?.leave() },
        ])
        more.accessibilityLabel = Strings.Documents.more
        more.accessibilityIdentifier = "document.more"
        peersItem.hidesSharedBackground = true
        peersItem.accessibilityIdentifier = "document.peers"
        showPeers()
        showSave()
    }

    /// The faces of whoever else has it open, left of the menu; their names in its menu.
    private func showPeers() {
        guard let image = DocumentPeersView.image(peers, traits: traitCollection) else {
            navigationItem.rightBarButtonItems = [moreItem]
            return
        }
        peersItem.image = image
        peersItem.accessibilityLabel = Strings.Documents.editing(peers.map(\.name))
        peersItem.menu = UIMenu(title: peersItem.accessibilityLabel ?? "", children: peers.map { UIAction(title: $0.name, attributes: .disabled) { _ in } })
        navigationItem.rightBarButtonItems = [moreItem, peersItem]
    }

    // MARK: Opening

    private func open() {
        let library = session.engine.documents
        let surfaceId = surfaceId
        let traits = traitCollection
        following = Task { [weak self] in
            let sync = await library.document(surfaceId)
            let opening = await sync.start()
            guard let self, !Task.isCancelled else { return }
            self.sync = sync
            switch opening {
            case .ready:
                // The editor and its text are made off the main thread; this one only takes them.
                let made = await Self.prepare(sync, style: DocumentStyle(traits: traits))
                guard let made, !Task.isCancelled else { return }
                self.show(made.handoff.editor, text: made.text.value, traits: traits)
                for await event in await sync.events() {
                    guard !Task.isCancelled else { return }
                    self.received(event)
                }
            case .markdownOnly:
                self.showMarkdown()
            case .unavailable(let reason):
                self.showStatus(reason.isEmpty ? Strings.Documents.unavailable : "\(Strings.Documents.unavailable)\n\(reason)")
            }
        }
    }

    struct Prepared: @unchecked Sendable {
        let handoff: DocumentHandoff
        let text: Box
    }

    final class Box: @unchecked Sendable {
        let value: NSAttributedString
        init(_ value: NSAttributedString) { self.value = value }
    }

    nonisolated private static func prepare(_ sync: DocumentSync, style: DocumentStyle) async -> Prepared? {
        guard let handoff = await sync.editor() else { return nil }
        return Prepared(handoff: handoff, text: Box(style.document(handoff.editor.lines)))
    }

    private func show(_ editor: DocumentEditor, text: NSAttributedString, traits: UITraitCollection) {
        styleTraits = traits
        let style = DocumentStyle(traits: traits)
        let controller = self.controller ?? DocumentTextController(textView: textView, editor: editor, style: style)
        self.controller = controller
        let local = sync?.local
        editor.onLocalUpdate = { local?.yield($0) }
        controller.onSelection = { [weak self] in self?.selectionChanged() }
        controller.onLink = { [weak self] current, done in self?.askLink(current, done) }
        let client = session.client
        controller.loadPicture = { url in await Self.picture(url, client: client) }
        controller.install(editor, text: text)
        textView.isEditable = writable
        status.isHidden = true
        view.setNeedsLayout()
        selectionChanged()
    }

    private func restyle() {
        guard let controller, traitCollection.preferredContentSizeCategory != styleTraits?.preferredContentSizeCategory else { return }
        styleTraits = traitCollection
        controller.restyle(DocumentStyle(traits: traitCollection))
    }

    private func showMarkdown() {
        let client = session.client
        let surfaceId = surfaceId
        Task { [weak self] in
            let text = try? await client.documentMarkdown(surfaceId).text
            guard let self else { return }
            guard let text else { self.showStatus(Strings.Documents.unavailable); return }
            self.textView.text = text
            self.textView.font = .preferredFont(forTextStyle: .body)
            self.textView.textColor = UIColor(Palette.documentText)
            self.status.isHidden = true
            self.navigationItem.subtitle = Strings.Documents.markdownOnly
        }
    }

    private func showStatus(_ text: String) {
        status.text = text
        status.isHidden = false
        textView.isEditable = false
        view.setNeedsLayout()
    }

    nonisolated private static func picture(_ url: String, client: AgentClient) async -> UIImage? {
        let data: Data?
        if url.hasPrefix("/v0/") {
            data = try? await client.image(url)
        } else if let address = URL(string: url), address.scheme == "https" || address.scheme == "http" {
            data = try? await URLSession.shared.data(from: address).0
        } else {
            data = nil
        }
        return data.flatMap { UIImage(data: $0)?.preparingForDisplay() }
    }

    // MARK: Sync

    private func received(_ event: DocumentSyncEvent) {
        switch event {
        case .remote(let update):
            controller?.applyRemote(update)
            cursors.update()
        case .reset(let handoff):
            let traits = traitCollection
            show(handoff.editor, text: DocumentStyle(traits: traits).document(handoff.editor.lines), traits: traits)
        case .save(let state):
            save = state
            showSave()
        case .peers(let list):
            let changed = list.map { [$0.name, $0.color] } != peers.map { [$0.name, $0.color] }
            peers = list
            cursors.peers = list
            if changed { showPeers() }
        case .notice(let text):
            notice = text.isEmpty ? Strings.Documents.refused : "\(Strings.Documents.refused) \(text)"
            showSave()
            noticeClearing?.cancel()
            noticeClearing = Task { [weak self] in
                try? await Task.sleep(for: .seconds(4))
                self?.notice = nil
                self?.showSave()
            }
        case .gone:
            textView.resignFirstResponder()
            showStatus(Strings.Documents.gone)
            textView.isHidden = true
        }
    }

    private func showSave() {
        let text = notice ?? {
            switch save {
            case .saved: Strings.Documents.saved
            case .saving: Strings.Documents.saving
            case .waiting: Strings.Documents.waiting
            }
        }()
        navigationItem.subtitle = text
    }

    private func selectionChanged() {
        guard let controller else { return }
        toolbar.setActive(controller.activeTools)
        cursors.controller = controller
        cursors.update()
        guard textView.isFirstResponder, let carets = controller.selectionCarets else {
            sync?.presence.yield(nil)
            return
        }
        let editor = controller.editor
        let me = session.profile.state.name
        sync?.presence.yield(DocumentPeer.state(name: me.isEmpty ? Strings.Documents.someone : me, color: DocumentPeersView.color(for: session.personSeed),
                                                anchor: editor.relativePosition(carets.anchor), head: editor.relativePosition(carets.head)))
    }

    // MARK: Actions

    private func askLink(_ current: String?, _ done: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: Strings.Documents.linkTitle, message: nil, preferredStyle: .alert)
        alert.addTextField { field in
            field.text = current
            field.placeholder = Strings.Documents.linkPlaceholder
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
            field.clearButtonMode = .whileEditing
        }
        alert.addAction(UIAlertAction(title: Strings.Documents.cancel, style: .cancel))
        if current != nil {
            alert.addAction(UIAlertAction(title: Strings.Documents.removeLink, style: .destructive) { _ in done(nil) })
        }
        alert.addAction(UIAlertAction(title: Strings.Documents.save, style: .default) { [weak alert] _ in
            let text = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            done(text.isEmpty ? nil : text)
        })
        present(alert, animated: true)
    }

    private func rename() {
        let alert = UIAlertController(title: Strings.Documents.renameTitle, message: nil, preferredStyle: .alert)
        alert.addTextField { [name] field in
            field.text = name
            field.placeholder = Strings.Documents.renamePlaceholder
            field.autocapitalizationType = .sentences
            field.clearButtonMode = .whileEditing
        }
        alert.addAction(UIAlertAction(title: Strings.Documents.cancel, style: .cancel))
        alert.addAction(UIAlertAction(title: Strings.Documents.save, style: .default) { [weak self, weak alert] _ in
            guard let self, let text = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty, text != self.name else { return }
            self.name = text
            self.navigationItem.title = text
            // Kept and sent like any rename (docs/offline-first.md).
            let intents = self.session.engine.intents
            let surfaceId = self.surfaceId
            Task { _ = try? await intents.enqueue(.rename, target: surfaceId, value: .object(["title": .string(text), "kind": .string("surface")])) }
        })
        present(alert, animated: true)
    }

    private func showHistory() {
        let history = DocumentHistoryViewController(session: session, surfaceId: surfaceId, name: name)
        navigationController?.pushViewController(history, animated: true)
    }

    /// Surfaces have no deletion: what a person can do is leave one.
    private func leave() {
        let sheet = UIAlertController(title: Strings.Documents.leaveTitle(name.isEmpty ? Strings.Documents.untitled : name), message: Strings.Documents.leaveMessage, preferredStyle: .alert)
        sheet.addAction(UIAlertAction(title: Strings.Documents.cancel, style: .cancel))
        sheet.addAction(UIAlertAction(title: Strings.Documents.leaveConfirm, style: .destructive) { [weak self] _ in
            guard let self else { return }
            let intents = self.session.engine.intents
            let surfaceId = self.surfaceId
            Task { _ = try? await intents.enqueue(.leave, target: surfaceId, value: .object(["kind": .string("surface")])) }
            self.navigationController?.popViewController(animated: true)
        })
        present(sheet, animated: true)
    }

    // MARK: Layout

    @objc private func keyboardChanged(_ note: Notification) {
        let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect) ?? .zero
        let local = view.convert(frame, from: nil)
        let next = note.name == UIResponder.keyboardWillHideNotification ? 0 : max(0, view.bounds.maxY - local.minY)
        guard next != keyboard else { return }
        keyboard = next
        view.setNeedsLayout()
        UIView.animate(withDuration: 0.25) { self.view.layoutIfNeeded() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let isPad = traitCollection.userInterfaceIdiom == .pad
        let layout = DocumentScreenLayout(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets), keyboard: keyboard,
                                          maxWidth: ContentWidthLimit.maxWidth(isPad: isPad), status: Measurable { [status] width in status.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)) })
        textView.frame = layout.text
        let inset = UIEdgeInsets(top: layout.inset.top, left: layout.inset.left, bottom: layout.inset.bottom, right: layout.inset.right)
        if textView.textContainerInset != inset { textView.textContainerInset = inset }
        textView.verticalScrollIndicatorInsets.bottom = layout.scrollBottom
        if textView.contentInset.bottom != layout.scrollBottom { textView.contentInset.bottom = layout.scrollBottom }
        status.frame = layout.status
        cursors.frame = CGRect(origin: .zero, size: textView.contentSize)
        cursors.update()
    }

    // MARK: Leaving

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        guard isMovingFromParent || navigationController == nil || isBeingDismissed else { return }
        releaseSync()
    }

    private func releaseSync() {
        guard !released else { return }
        released = true
        following?.cancel()
        let sync = sync
        Task { await sync?.release() }
    }

    isolated deinit {
        releaseSync()
    }

    // MARK: Testing

    var editorForTesting: DocumentEditor? { controller?.editor }
    var textControllerForTesting: DocumentTextController? { controller }
    var textViewForTesting: DocumentTextView { textView }
    var toolbarForTesting: DocumentToolbar { toolbar }
}
#endif
