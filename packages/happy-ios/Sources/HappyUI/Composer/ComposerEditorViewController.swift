#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// The composer's text full screen, as Telegram's input expands once it is
/// past the lines the card shows: the same text with the caret where it
/// was, the keyboard staying up, and the button where the card's expand
/// button was putting it back (`ComposerEditorLayout`).
final class ComposerEditorViewController: UIViewController, UITextViewDelegate {
    /// Every edit, as the card hears its own: the draft keeps up.
    var onChange: ((String) -> Void)?
    /// Collapsed, or gone any other way: the text and the caret go back to
    /// the card, and whether the keyboard was up.
    var onClose: ((String, NSRange, Bool) -> Void)?

    let textView = UITextView(usingTextLayoutManager: true)
    private let collapseButton = ComposerIconButton(
        icon: .ionicons("contract-outline"),
        size: ComposerEditorLayout.Metrics.collapseIconSize
    )
    private let initialSelection: NSRange
    /// The keyboard's top in the view; nil while it is down.
    private var keyboardTop: CGFloat?

    /// `keyboardTop` is where the keyboard already is, in the screen's
    /// bounds: no notification says so while it stays up.
    init(text: String, selection: NSRange, keyboardTop: CGFloat?) {
        initialSelection = selection
        self.keyboardTop = keyboardTop
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
        textView.text = text
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private var inputStyle: TextStyle {
        traitCollection.textEnvironment.map { TextStyles.composerInput.scaled($0.scale) } ?? TextStyles.composerInput
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.surface)
        let text = textView.text ?? ""
        textView.backgroundColor = .clear
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.attributedText = inputStyle.attributedString(text, color: UIColor(Palette.inputText))
        textView.typingAttributes = inputStyle.attributes(color: UIColor(Palette.inputText))
        textView.tintColor = UIColor(Palette.radioActive)
        textView.alwaysBounceVertical = true
        textView.keyboardDismissMode = .none
        textView.accessibilityIdentifier = "composer-editor"
        textView.delegate = self
        let length = (text as NSString).length
        let location = min(max(0, initialSelection.location), length)
        textView.selectedRange = NSRange(location: location, length: min(initialSelection.length, length - location))
        view.addSubview(textView)

        collapseButton.tint = Palette.textSecondary
        collapseButton.accessibilityLabel = Strings.Composer.collapseEditor
        collapseButton.accessibilityIdentifier = "composer-collapse"
        collapseButton.addTarget(self, action: #selector(collapse), for: .touchUpInside)
        view.addSubview(collapseButton)

        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillChange(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    }

    override func viewIsAppearing(_ animated: Bool) {
        super.viewIsAppearing(animated)
        // Taken from the card as this comes in, in the window by now, so
        // the keyboard stays up.
        textView.becomeFirstResponder()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        textView.scrollRangeToVisible(textView.selectedRange)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let safe = view.safeAreaInsets
        let layout = ComposerEditorLayout(
            size: view.bounds.size,
            safeArea: .init(top: safe.top, left: safe.left, bottom: safe.bottom, right: safe.right),
            keyboardTop: keyboardTop
        )
        textView.setLayoutFrame(layout.text)
        collapseButton.setLayoutFrame(layout.collapse)
        // The lines wrap clear of the button, and run the full width under it.
        let clear = [UIBezierPath(rect: layout.collapseClearance)]
        if textView.textContainer.exclusionPaths != clear { textView.textContainer.exclusionPaths = clear }
    }

    /// A draft from elsewhere, while this is up: the text is replaced, the
    /// caret kept where it can be. Never heard as an edit.
    func show(_ text: String) {
        guard textView.text != text, textView.markedTextRange == nil else { return }
        let selection = textView.selectedRange
        textView.attributedText = inputStyle.attributedString(text, color: UIColor(Palette.inputText))
        textView.typingAttributes = inputStyle.attributes(color: UIColor(Palette.inputText))
        let length = (text as NSString).length
        textView.selectedRange = NSRange(location: min(selection.location, length), length: 0)
    }

    @objc private func keyboardWillChange(_ note: Notification) {
        guard let screen = view.window?.screen,
              let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
        let curve = (note.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.uintValue ?? 7
        let local = view.convert(end, from: screen.coordinateSpace)
        keyboardTop = local.minY >= view.bounds.maxY || local.isEmpty ? nil : local.minY
        UIView.animate(withDuration: duration, delay: 0, options: [UIView.AnimationOptions(rawValue: curve << 16), .beginFromCurrentState]) {
            self.view.setNeedsLayout()
            self.view.layoutIfNeeded()
        }
    }

    func textViewDidChange(_ textView: UITextView) {
        onChange?(textView.text ?? "")
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        finish()
    }

    private func finish() {
        guard let onClose else { return }
        self.onClose = nil
        onClose(textView.text ?? "", textView.selectedRange, textView.isFirstResponder)
    }

    @objc private func collapse() {
        finish()
        dismiss(animated: true)
    }
}
#endif
