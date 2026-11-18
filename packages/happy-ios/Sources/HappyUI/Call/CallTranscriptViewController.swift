#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Developer › Last voice call transcript (Android `CallTranscriptScreen`):
/// when the last call started and how long it ran, then everything it
/// exchanged with the voice connection, each with its local time and kind
/// (`CallTranscript`). Copy puts it all on the clipboard; Share hands it to
/// the share sheet. Reached from Settings' About card once developer mode
/// is on (ten taps on Version); in English only.
final class CallTranscriptViewController: UITableViewController {
    private let store: (any CallTranscriptStore)?
    private var recording: CallTranscript.Recording?

    init(store: (any CallTranscriptStore)?) {
        self.store = store
        super.init(style: .plain)
        title = "Last voice call"
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.surface)
        tableView.separatorStyle = .none
        tableView.allowsSelection = false
        tableView.register(Cell.self, forCellReuseIdentifier: "entry")
        let store = store
        Task { [weak self] in
            // Up to 4 MB, read off the main thread.
            let recording = await Task.detached(priority: .userInitiated) { store.flatMap { CallTranscript.read(from: $0) } }.value
            self?.show(recording)
        }
    }

    private func show(_ recording: CallTranscript.Recording?) {
        self.recording = recording
        if let recording {
            navigationItem.rightBarButtonItems = [
                UIBarButtonItem(title: "Share", primaryAction: UIAction { [weak self] _ in self?.share(recording) }),
                UIBarButtonItem(title: "Copy", primaryAction: UIAction { [weak self] _ in self?.copy(recording) }),
            ]
            tableView.backgroundView = nil
        } else {
            let empty = UILabel()
            empty.text = "No voice call yet. The next call's transcript shows here."
            empty.font = .systemFont(ofSize: 16)
            empty.textColor = UIColor(Palette.textSecondary)
            empty.textAlignment = .center
            empty.numberOfLines = 0
            empty.accessibilityIdentifier = "callTranscript.empty"
            tableView.backgroundView = empty
        }
        tableView.reloadData()
    }

    private func copy(_ recording: CallTranscript.Recording) {
        UIPasteboard.general.string = recording.text()
        Haptics.play(.pick)
    }

    private func share(_ recording: CallTranscript.Recording) {
        let controller = UIActivityViewController(activityItems: [recording.text()], applicationActivities: nil)
        controller.popoverPresentationController?.sourceItem = navigationItem.rightBarButtonItems?.first
        present(controller, animated: true)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if let empty = tableView.backgroundView { empty.frame = tableView.bounds.insetBy(dx: 40, dy: 40) }
    }

    // MARK: Table

    override func numberOfSections(in tableView: UITableView) -> Int { recording == nil ? 0 : 1 }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        (recording?.entries.count ?? 0) + 1
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "entry", for: indexPath) as! Cell
        guard let recording else { return cell }
        if indexPath.row == 0 {
            let started = DateFormatter.localizedString(from: Date(timeIntervalSince1970: recording.started), dateStyle: .medium, timeStyle: .medium)
            let details = ["Started \(started)", "Duration \(CallController.clock(seconds: Int(recording.duration)))",
                           recording.language.map { "Language \($0)" }, recording.truncated ? "Truncated: the rest wasn't kept" : nil]
            cell.show(heading: nil, text: details.compactMap { $0 }.joined(separator: "\n"), error: false)
        } else {
            let entry = recording.entries[indexPath.row - 1]
            cell.show(heading: entry.heading(), text: entry.text, error: entry.isError == true)
        }
        return cell
    }

    /// An entry: its time and kind over its text, as sent or received, selectable.
    private final class Cell: UITableViewCell {
        private let heading = UILabel()
        private let body = UITextView()

        override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
            super.init(style: style, reuseIdentifier: reuseIdentifier)
            backgroundColor = .clear
            heading.font = .systemFont(ofSize: 13, weight: .semibold)
            heading.numberOfLines = 0
            body.isEditable = false
            body.isScrollEnabled = false
            body.backgroundColor = .clear
            body.textContainerInset = .zero
            body.textContainer.lineFragmentPadding = 0
            body.textColor = UIColor(Palette.text)
            let stack = UIStackView(arrangedSubviews: [heading, body])
            stack.axis = .vertical
            stack.spacing = 2
            stack.translatesAutoresizingMaskIntoConstraints = false
            contentView.addSubview(stack)
            NSLayoutConstraint.activate([
                stack.leadingAnchor.constraint(equalTo: contentView.layoutMarginsGuide.leadingAnchor),
                stack.trailingAnchor.constraint(equalTo: contentView.layoutMarginsGuide.trailingAnchor),
                stack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 8),
                stack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -8),
            ])
        }

        @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

        func show(heading text: String?, text body: String, error: Bool) {
            heading.text = text
            heading.isHidden = text == nil
            heading.textColor = UIColor(error ? Palette.textDestructive : Palette.textSecondary)
            self.body.font = text == nil ? .systemFont(ofSize: 15) : .monospacedSystemFont(ofSize: 13, weight: .regular)
            self.body.text = body
        }
    }
}
#endif
