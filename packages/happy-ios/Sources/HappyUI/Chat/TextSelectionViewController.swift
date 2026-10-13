#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

/// text-selection.tsx: a text to select any part of, in a read-only text
/// view inside a card, with Copy (all of it) in the header. Markdown Copy
/// v2 opens it from a long press on an agent's message.
final class TextSelectionViewController: UIViewController {
    private let text: String
    private let card = UIView()
    private let textView = UITextView()

    init(text: String) {
        self.text = text
        super.init(nibName: nil, bundle: nil)
        title = Strings.TextSelection.title
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        showsBackTitle()
        navigationItem.largeTitleDisplayMode = .never
        let copy = UIBarButtonItem(
            image: .icon(.ionicons("copy-outline"), size: 24), style: .plain, target: self, action: #selector(copyAll)
        )
        copy.accessibilityLabel = Strings.Chat.copy
        copy.isEnabled = !text.isEmpty
        navigationItem.rightBarButtonItem = copy

        // MobileGlassSurface without a native effect: no fill of its own on
        // iOS, a hairline rim.
        card.layer.cornerRadius = TextSelectionLayout.Metrics.radius
        card.layer.cornerCurve = .continuous
        card.clipsToBounds = true
        view.addSubview(card)
        textView.isEditable = false
        textView.isSelectable = true
        textView.backgroundColor = .clear
        textView.alwaysBounceVertical = true
        textView.contentInsetAdjustmentBehavior = .never
        textView.textContainer.lineFragmentPadding = 0
        textView.attributedText = ChatTextStyles.textSelection.string(text, color: Palette.text)
        card.addSubview(textView)
        applyColors()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.applyColors()
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard text.isEmpty, presentedViewController == nil else { return }
        let alert = UIAlertController(title: Strings.Common.error, message: Strings.TextSelection.noTextProvided, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Common.ok, style: .default) { [weak self] _ in
            self?.navigationController?.popViewController(animated: true)
        })
        present(alert, animated: true)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let layout = TextSelectionLayout(size: view.bounds.size, safeArea: LayoutInsets(view.safeAreaInsets))
        card.frame = layout.card
        card.layer.borderWidth = view.hairline
        textView.frame = card.bounds
        textView.textContainerInset = UIEdgeInsets(layout.textInsets)
    }

    private func applyColors() {
        card.layer.borderColor = UIColor(Palette.glassBorder).resolvedColor(with: traitCollection).cgColor
    }

    @objc private func copyAll() {
        UIPasteboard.general.string = text
        let alert = UIAlertController(title: Strings.TextSelection.textCopied, message: nil, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Common.ok, style: .default))
        present(alert, animated: true)
    }
}
#endif
