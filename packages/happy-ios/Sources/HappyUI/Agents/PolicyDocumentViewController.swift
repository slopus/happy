#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// One of a Happy Cloud server's two documents every agent follows, its
/// instructions or its security policy, as plain text the size of the
/// screen. Those granted `policy.edit` (owners) change it and Save it;
/// everyone else reads it. Read again on `config.updated` while nothing
/// typed here waits to be saved; Back with unsaved changes asks first.
final class PolicyDocumentViewController: UIViewController, UITextViewDelegate {
    let document: PolicyDocument
    private let session: Session
    let textView = UITextView(usingTextLayoutManager: true)
    private let note = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private lazy var saveItem = UIBarButtonItem(title: Strings.PolicyDocuments.save, primaryAction: UIAction { [weak self] _ in
        Task { await self?.save() }
    })
    /// The text as the server last had it; nil until read.
    private(set) var saved: String?
    private var saving = false
    private var failed = false
    private var problem: String?
    private var following: Task<Void, Never>?
    private var accessWatch: Watch?
    private var keyboardTop: CGFloat?

    init(document: PolicyDocument, session: Session) {
        self.document = document
        self.session = session
        super.init(nibName: nil, bundle: nil)
        title = Strings.PolicyDocuments.title(document)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private var editable: Bool { session.gate.allows(.policyEdit) }
    private var text: String { textView.text ?? "" }
    private var dirty: Bool { saved != nil && text != saved }
    private var tooLong: Bool { text.utf8.count > document.limit }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.surface)
        view.accessibilityIdentifier = "policy-\(document.rawValue)"
        textView.backgroundColor = .clear
        textView.font = UIFont.monospacedSystemFont(ofSize: UIFontMetrics(forTextStyle: .body).scaledValue(for: 15), weight: .regular)
        textView.adjustsFontForContentSizeCategory = true
        textView.textColor = UIColor(Palette.text)
        textView.tintColor = UIColor(Palette.textLink)
        textView.autocorrectionType = .no
        textView.autocapitalizationType = .none
        textView.smartQuotesType = .no
        textView.smartDashesType = .no
        textView.alwaysBounceVertical = true
        textView.keyboardDismissMode = .interactive
        textView.textContainerInset = UIEdgeInsets(top: 12, left: 16, bottom: 24, right: 16)
        textView.textContainer.lineFragmentPadding = 0
        textView.accessibilityIdentifier = "policy-text"
        textView.delegate = self
        textView.isEditable = false
        view.addSubview(textView)
        note.font = UIFont.preferredFont(forTextStyle: .footnote)
        note.adjustsFontForContentSizeCategory = true
        note.numberOfLines = 0
        note.textAlignment = .center
        view.addSubview(note)
        spinner.hidesWhenStopped = true
        view.addSubview(spinner)
        saveItem.accessibilityIdentifier = "policy-save"
        navigationItem.backAction = UIAction { [weak self] _ in self?.leave() }
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillChange(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        accessWatch = session.watchAccess { [weak self] in self?.update() }
        follow()
        load()
        update()
    }

    deinit { following?.cancel() }

    // MARK: Reading

    private func follow() {
        let store = session.store
        following = Task { [weak self] in
            for await _ in await store.events(matching: ["config.updated"]) {
                guard !Task.isCancelled, let self else { return }
                if !dirty, !saving { load() }
            }
        }
    }

    func load() {
        failed = false
        if saved == nil { spinner.startAnimating() }
        update()
        let client = session.client
        let document = document
        Task { [weak self] in
            let read = try? await client.policyDocument(document)
            guard let self else { return }
            spinner.stopAnimating()
            if let read {
                // Typed meanwhile: what was typed stays.
                if !dirty { show(read) }
                saved = read
            } else if saved == nil {
                failed = true
            }
            update()
        }
    }

    private func show(_ text: String) {
        guard textView.text != text else { return }
        textView.text = text
    }

    // MARK: Saving

    func save() async {
        guard editable, dirty, !tooLong, !saving else { return }
        saving = true
        problem = nil
        update()
        do {
            let kept = try await session.client.putPolicyDocument(document, text)
            saved = kept
            if text != kept, !textView.isFirstResponder { show(kept) }
            textView.resignFirstResponder()
            Haptics.play(.renamed)
        } catch AgentClientError.status(403, _, _) {
            problem = Strings.PolicyDocuments.notAllowed
            session.refreshPermissions()
        } catch AgentClientError.status(400, _, _) {
            problem = Strings.PolicyDocuments.tooLong(document.limit)
        } catch {
            problem = Strings.PolicyDocuments.saveFailed
        }
        saving = false
        update()
    }

    private func leave() {
        guard dirty else { navigationController?.popViewController(animated: true); return }
        let alert = UIAlertController(title: Strings.PolicyDocuments.discardTitle, message: nil, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.PolicyDocuments.keepEditing, style: .cancel))
        alert.addAction(UIAlertAction(title: Strings.PolicyDocuments.discard, style: .destructive) { [weak self] _ in
            self?.navigationController?.popViewController(animated: true)
        })
        present(alert, animated: true)
    }

    func textViewDidChange(_ textView: UITextView) {
        problem = nil
        update()
    }

    // MARK: State

    private func update() {
        textView.isEditable = editable && saved != nil && !saving
        textView.isHidden = saved == nil
        navigationItem.rightBarButtonItem = editable && saved != nil ? saveItem : (failed ? retryItem : nil)
        saveItem.isEnabled = dirty && !tooLong && !saving
        // Swiping back would lose what was typed: Back asks instead.
        navigationController?.interactivePopGestureRecognizer?.isEnabled = !dirty
        let (words, warning): (String, Bool) = if let problem { (problem, true) }
            else if failed { (Strings.PolicyDocuments.loadFailed, true) }
            else if tooLong { (Strings.PolicyDocuments.tooLong(document.limit), true) }
            else if saved == nil { ("", false) }
            else if saved?.isEmpty == true, !editable { (Strings.PolicyDocuments.empty + " " + Strings.PolicyDocuments.about(document), false) }
            else { (Strings.PolicyDocuments.about(document) + (editable ? "" : " " + Strings.PolicyDocuments.ownersOnly), false) }
        note.text = words
        note.textColor = UIColor(warning ? Palette.textDestructive : Palette.textSecondary)
        view.setNeedsLayout()
    }

    private lazy var retryItem = UIBarButtonItem(title: Strings.PolicyDocuments.tryAgain, primaryAction: UIAction { [weak self] _ in self?.load() })

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        navigationController?.interactivePopGestureRecognizer?.isEnabled = true
    }

    // MARK: Layout

    @objc private func keyboardWillChange(_ note: Notification) {
        guard let screen = view.window?.screen,
              let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let local = view.convert(end, from: screen.coordinateSpace)
        keyboardTop = local.minY >= view.bounds.maxY || local.isEmpty ? nil : local.minY
        view.setNeedsLayout()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let safe = view.safeAreaInsets
        let width = view.bounds.width - safe.left - safe.right - 32
        let noteHeight = note.text?.isEmpty == false ? ceil(note.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height) + 16 : 0
        note.frame = CGRect(x: safe.left + 16, y: safe.top + 8, width: width, height: max(0, noteHeight - 16))
        let top = safe.top + noteHeight
        textView.frame = CGRect(x: 0, y: top, width: view.bounds.width, height: max(0, view.bounds.height - top))
        let bottom = keyboardTop.map { max(0, view.bounds.maxY - $0) } ?? safe.bottom
        if textView.contentInset.bottom != bottom {
            textView.contentInset.bottom = bottom
            textView.verticalScrollIndicatorInsets.bottom = bottom
        }
        spinner.center = CGPoint(x: view.bounds.midX, y: top + 40)
    }
}
#endif
