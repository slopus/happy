#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import HappyWire
import UIKit

/// A piece of text placed by a pure layout and drawn as measured.
@MainActor
final class ChatLabel {
    let view = ChatTextView()
    private(set) var text: MeasuredText

    init(_ text: MeasuredText) {
        self.text = text
        view.isAccessibilityElement = false
    }

    var measurable: Measurable { text.measurable }

    func update(_ text: MeasuredText) {
        self.text = text
    }

    func place(_ frame: CGRect) {
        view.setLayoutFrame(frame)
        view.layout = text.layout(for: frame)
    }
}

// MARK: AgentQuestionBanner.tsx

/// The card above the composer for a request the chat can't show inline:
/// a form opens the answer sheet; an unknown kind can only be dismissed.
/// Its text follows the text size, laid out off the main thread
/// (`ChatDockBarMeasure.questionBanner`) at the width the dock offers;
/// until its plan is in it has no height. The glyph and the chevron keep
/// their size.
final class ChatQuestionBannerView: UIView {
    var onOpen: (() -> Void)?
    var onDismiss: (() -> Void)?
    /// Its plan came in: the dock is laid out again with its height.
    var onNeedsLayout: (() -> Void)?

    private(set) var pending: PendingAgentCommunication?
    private var model: ChatQuestionBannerModel?
    let measure = OffMainPlan<ChatDockBarInput<ChatQuestionBannerModel>, ChatQuestionBannerPlan> { ChatDockBarMeasure.questionBanner($0) }
    private let card = UIView()
    private let icon = UIImageView()
    private let title = ChatTextView()
    private let subtitle = ChatTextView()
    private let trailing = ChatTextView()
    private let chevron = UIImageView(image: .icon(.ionicons("chevron-forward"), size: ChatDockBarMeasure.chevronSize))

    override init(frame: CGRect) {
        super.init(frame: frame)
        card.backgroundColor = UIColor(Palette.surface)
        card.layer.cornerRadius = QuestionBannerLayout.Metrics.radius
        card.layer.cornerCurve = .continuous
        card.layer.borderWidth = QuestionBannerLayout.Metrics.border
        addSubview(card)
        icon.contentMode = .center
        chevron.contentMode = .center
        chevron.tintColor = UIColor(Palette.textSecondary)
        for view in [title, subtitle, trailing] { view.isAccessibilityElement = false }
        for view in [icon, title, subtitle, trailing, chevron] { addSubview(view) }
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped(_:))))
        isAccessibilityElement = true
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.updateBorder()
        }
        measure.onApply = { [weak self] in
            self?.setNeedsLayout()
            self?.onNeedsLayout?()
        }
        // A new size is measured when the dock next asks for its height.
        registerForTraitChanges(UIView.textSizeTraits + [UITraitDisplayScale.self]) { (self: Self, _) in
            self.setNeedsLayoutUpTheTree()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// Gone, it forgets its plan, so it comes back with nothing old in it.
    override var isHidden: Bool {
        didSet { if isHidden { measure.reset() } }
    }

    func show(_ pending: PendingAgentCommunication) {
        guard pending != self.pending else { return }
        self.pending = pending
        let model: ChatQuestionBannerModel
        switch pending.kind {
        case .unsupported(let rawKind, let titleText):
            icon.image = .icon(.ionicons("alert-circle-outline"), size: 20)
            icon.tintColor = UIColor(Palette.textSecondary)
            model = ChatQuestionBannerModel(
                title: titleText ?? Strings.AgentQuestion.unsupportedTitle,
                subtitle: Strings.AgentQuestion.unsupportedDescription(rawKind),
                dismiss: Strings.AgentQuestion.dismiss
            )
            accessibilityTraits = .staticText
        case .form(let questions):
            icon.image = .icon(.ionicons("help-circle-outline"), size: 20)
            icon.tintColor = UIColor(Palette.textLink)
            let first = questions.first
            let remaining = questions.count - 1
            model = ChatQuestionBannerModel(
                title: first?.header ?? Strings.AgentQuestion.title,
                subtitle: remaining > 0 ? Strings.AgentQuestion.moreQuestions(remaining) : (first?.question ?? ""),
                dismiss: nil
            )
            accessibilityTraits = .button
        }
        self.model = model
        accessibilityLabel = [model.title, model.subtitle].joined(separator: ", ")
        updateBorder()
        setNeedsLayout()
    }

    private var isForm: Bool {
        if case .form = pending?.kind { return true }
        return false
    }

    /// The banner's height at a width, for the dock: its plan's, asked for
    /// at that width; the last one's until that is in, or none.
    var bannerMeasurable: Measurable {
        Measurable { [self] width in
            guard let model else { return .zero }
            measure.request(ChatDockBarInput(model: model, width: width, text: traitCollection.measuredTextEnvironment))
            return measure.plan?.layout.size ?? .zero
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let plan = measure.plan
        for view in [card, icon, title, subtitle] { view.isHidden = plan == nil }
        chevron.isHidden = plan == nil || plan?.dismiss != nil
        trailing.isHidden = plan?.dismiss == nil
        guard let plan else { return }
        let layout = plan.layout
        card.setLayoutFrame(layout.card)
        icon.setLayoutFrame(layout.icon)
        title.setLayoutFrame(layout.title)
        title.layout = plan.title
        subtitle.setLayoutFrame(layout.subtitle)
        subtitle.layout = plan.subtitle
        if let dismiss = plan.dismiss {
            trailing.setLayoutFrame(layout.trailing)
            trailing.layout = dismiss
        } else {
            chevron.setLayoutFrame(layout.trailing)
        }
        dismissTarget = layout.trailing.insetBy(dx: -10, dy: -10)
    }

    private var dismissTarget: CGRect = .zero

    private func updateBorder() {
        let color = isForm ? Palette.textLink : Palette.divider
        card.layer.borderColor = UIColor(color).resolvedColor(with: traitCollection).cgColor
    }

    @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
        if isForm {
            onOpen?()
        } else if dismissTarget.contains(recognizer.location(in: self)) {
            onDismiss?()
        }
    }
}

// MARK: AgentQuestionModal.tsx

/// The full-screen answer sheet: each question's options as checkboxes,
/// and a field for a written answer where the agent allows one.
final class AgentQuestionSheetController: UIViewController, UITextViewDelegate {
    let pending: PendingAgentCommunication
    private let questions: [AgentQuestion]
    private let submit: (JSONValue) async throws -> Void
    private let cancel: () async -> Void

    private var drafts: [String: AgentQuestionDraft] = [:]
    private var submitting = false
    private var errorText: String?

    private let header = UIView()
    private let headerDivider = UIView()
    private let cancelButton = UIButton(type: .system)
    private let titleLabel = ChatLabel(MeasuredText(ChatTextStyles.sheetTitle.string(Strings.AgentQuestion.title, color: Palette.text), maxLines: 1))
    private let scrollView = UIScrollView()
    private let footer = UIView()
    private let footerDivider = UIView()
    private let submitButton = UIControl()
    private let submitLabel = ChatLabel(MeasuredText(ChatTextStyles.sheetSubmit.string(Strings.AgentQuestion.submit, color: Palette.onAccent), maxLines: 1))
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let errorLabel = ChatLabel(MeasuredText(NSAttributedString()))
    private let keyboardTracker = UIView()
    private var blocks: [QuestionBlock] = []

    /// One question's views.
    @MainActor
    private final class QuestionBlock {
        let chip = UIView()
        let chipText: ChatLabel
        let dot = UIView()
        let text: ChatLabel
        let hint: ChatLabel?
        var options: [(box: UIControl, checkbox: UIView, check: UIImageView, label: ChatLabel, description: ChatLabel?)] = []
        let customLabel: ChatLabel?
        let input: UITextView?
        let placeholder: ChatLabel?

        init(_ question: AgentQuestion) {
            chipText = ChatLabel(MeasuredText(ChatTextStyles.sheetChip.string(question.header.uppercased(), color: Palette.textSecondary), maxLines: 1))
            text = ChatLabel(MeasuredText(ChatTextStyles.sheetQuestion.string(question.question, color: Palette.text)))
            hint = question.multiSelect ? ChatLabel(MeasuredText(ChatTextStyles.sheetHint.string(Strings.AgentQuestion.chooseMultiple, color: Palette.textSecondary))) : nil
            if question.allowCustom != false {
                customLabel = ChatLabel(MeasuredText(ChatTextStyles.sheetCustomLabel.string(Strings.AgentQuestion.ownAnswer, color: Palette.textSecondary)))
                let input = UITextView()
                input.font = ChatTextStyles.sheetInput.font
                input.textColor = UIColor(Palette.text)
                input.backgroundColor = UIColor(Palette.surface)
                input.layer.cornerRadius = QuestionSheetLayout.Metrics.inputRadius
                input.layer.cornerCurve = .continuous
                input.layer.borderWidth = 1
                input.textContainer.lineFragmentPadding = 0
                input.textContainerInset = UIEdgeInsets(
                    top: QuestionSheetLayout.Metrics.inputPaddingV, left: QuestionSheetLayout.Metrics.inputPaddingH,
                    bottom: QuestionSheetLayout.Metrics.inputPaddingV, right: QuestionSheetLayout.Metrics.inputPaddingH
                )
                input.isScrollEnabled = false
                self.input = input
                placeholder = ChatLabel(MeasuredText(ChatTextStyles.sheetInput.string(Strings.AgentQuestion.ownAnswerPlaceholder, color: Palette.textSecondary), maxLines: 1))
            } else {
                customLabel = nil
                input = nil
                placeholder = nil
            }
        }

        /// What the person has typed, as the layout measures it.
        var typed: Measurable {
            guard let input else { return .fixed(width: 0, height: 0) }
            return Measurable { width in
                let text = input.text.isEmpty ? " " : input.text!
                return ChatTextLayout(ChatTextStyles.sheetInput.string(text, color: Palette.text), width: width).size
            }
        }
    }

    init(pending: PendingAgentCommunication, submit: @escaping (JSONValue) async throws -> Void, cancel: @escaping () async -> Void) {
        self.pending = pending
        questions = pending.questions
        self.submit = submit
        self.cancel = cancel
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.groupedBackground)

        cancelButton.setAttributedTitle(ChatTextStyles.sheetAction.string(Strings.Common.cancel, color: Palette.textLink), for: .normal)
        cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        headerDivider.backgroundColor = UIColor(Palette.divider)
        header.addSubview(cancelButton)
        header.addSubview(titleLabel.view)
        view.addSubview(header)
        view.addSubview(headerDivider)

        scrollView.alwaysBounceVertical = true
        scrollView.keyboardDismissMode = .interactive
        view.addSubview(scrollView)
        for question in questions {
            let block = QuestionBlock(question)
            block.chip.backgroundColor = UIColor(Palette.surfaceHighest)
            block.chip.layer.cornerRadius = QuestionSheetLayout.Metrics.chipRadius
            block.dot.backgroundColor = UIColor(Palette.requiredDot)
            block.dot.layer.cornerRadius = QuestionSheetLayout.Metrics.dotSize / 2
            for view in [block.chip, block.chipText.view, block.dot, block.text.view] { scrollView.addSubview(view) }
            if let hint = block.hint { scrollView.addSubview(hint.view) }
            for option in question.options {
                let box = UIControl()
                box.backgroundColor = UIColor(Palette.surface)
                box.layer.cornerRadius = QuestionSheetLayout.Metrics.optionRadius
                box.layer.cornerCurve = .continuous
                box.layer.borderWidth = 1
                box.accessibilityLabel = option.label
                box.isAccessibilityElement = true
                box.addTarget(self, action: #selector(optionTapped(_:)), for: .touchUpInside)
                let checkbox = UIView()
                checkbox.isUserInteractionEnabled = false
                checkbox.layer.cornerRadius = QuestionSheetLayout.Metrics.checkboxRadius
                checkbox.layer.borderWidth = 2
                let check = UIImageView(image: .icon(.ionicons("checkmark"), size: 14))
                check.tintColor = UIColor(Palette.onAccent)
                check.contentMode = .center
                checkbox.addSubview(check)
                let label = ChatLabel(MeasuredText(ChatTextStyles.sheetOptionLabel.string(option.label, color: Palette.text)))
                let description = option.description.flatMap { $0.isEmpty ? nil : ChatLabel(MeasuredText(ChatTextStyles.sheetOptionDescription.string($0, color: Palette.textSecondary))) }
                label.view.isUserInteractionEnabled = false
                description?.view.isUserInteractionEnabled = false
                scrollView.addSubview(box)
                box.addSubview(checkbox)
                box.addSubview(label.view)
                if let description { box.addSubview(description.view) }
                block.options.append((box, checkbox, check, label, description))
            }
            if let customLabel = block.customLabel, let input = block.input, let placeholder = block.placeholder {
                input.delegate = self
                scrollView.addSubview(customLabel.view)
                scrollView.addSubview(input)
                placeholder.view.isUserInteractionEnabled = false
                input.addSubview(placeholder.view)
            }
            blocks.append(block)
        }
        scrollView.addSubview(errorLabel.view)

        footer.backgroundColor = UIColor(Palette.groupedBackground)
        footerDivider.backgroundColor = UIColor(Palette.divider)
        submitButton.backgroundColor = UIColor(Palette.textLink)
        submitButton.layer.cornerRadius = QuestionSheetLayout.Metrics.submitRadius
        submitButton.layer.cornerCurve = .continuous
        submitButton.accessibilityLabel = Strings.AgentQuestion.submit
        submitButton.accessibilityTraits = .button
        submitButton.isAccessibilityElement = true
        submitButton.addTarget(self, action: #selector(submitTapped), for: .touchUpInside)
        submitLabel.view.isUserInteractionEnabled = false
        spinner.color = UIColor(Palette.onAccent)
        spinner.hidesWhenStopped = true
        view.addSubview(footer)
        footer.addSubview(footerDivider)
        footer.addSubview(submitButton)
        submitButton.addSubview(submitLabel.view)
        submitButton.addSubview(spinner)

        keyboardTracker.isHidden = true
        keyboardTracker.isUserInteractionEnabled = false
        keyboardTracker.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(keyboardTracker)
        view.keyboardLayoutGuide.followsUndockedKeyboard = false
        NSLayoutConstraint.activate([
            keyboardTracker.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            keyboardTracker.widthAnchor.constraint(equalToConstant: 1),
            keyboardTracker.topAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            keyboardTracker.heightAnchor.constraint(equalToConstant: 1),
        ])

        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.update()
        }
        update()

        // A question with nothing to pick opens with the keyboard ready.
        if let first = questions.first, first.options.isEmpty {
            blocks.first?.input?.becomeFirstResponder()
        }
    }

    /// Applies the drafts, the error and the submitting state to the views.
    private func update() {
        for (index, question) in questions.enumerated() {
            let block = blocks[index]
            let draft = drafts[question.id] ?? AgentQuestionDraft()
            block.dot.isHidden = AgentCommunications.isAnswered(question, draft: drafts[question.id])
            for (optionIndex, option) in question.options.enumerated() {
                let views = block.options[optionIndex]
                let selected = draft.options.contains(option.label)
                views.box.isEnabled = !submitting
                views.box.isSelected = selected
                views.box.accessibilityTraits = selected ? [.button, .selected] : .button
                views.box.layer.borderColor = (selected ? UIColor(Palette.textLink) : .clear).resolvedColor(with: traitCollection).cgColor
                views.checkbox.backgroundColor = selected ? UIColor(Palette.textLink) : .clear
                views.checkbox.layer.borderColor = UIColor(selected ? Palette.textLink : Palette.divider).resolvedColor(with: traitCollection).cgColor
                views.check.isHidden = !selected
            }
            block.input?.isEditable = !submitting
            block.input?.layer.borderColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
            block.placeholder?.view.isHidden = !(block.input?.text.isEmpty ?? true)
        }
        errorLabel.update(MeasuredText(ChatTextStyles.sheetError.string(errorText ?? "", color: Palette.statusError)))
        errorLabel.view.isHidden = errorText == nil
        let ready = AgentCommunications.canSubmit(questions, drafts: drafts)
        submitButton.isEnabled = ready && !submitting
        submitButton.alpha = ready && !submitting ? 1 : 0.4
        submitLabel.view.isHidden = submitting
        if submitting { spinner.startAnimating() } else { spinner.stopAnimating() }
        cancelButton.isEnabled = !submitting
        view.setNeedsLayout()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let layout = QuestionSheetLayout(.init(
            size: view.bounds.size,
            safeArea: LayoutInsets(view.safeAreaInsets),
            keyboardTop: keyboardTracker.frame.minY,
            hairline: view.hairline,
            cancel: Measurable { [cancelButton] _ in cancelButton.titleLabel?.intrinsicContentSize ?? .zero },
            title: titleLabel.measurable,
            submit: submitLabel.measurable,
            questions: questions.enumerated().map { index, question in
                let block = blocks[index]
                return QuestionSheetLayout.Question(
                    chip: block.chipText.measurable,
                    showsDot: !block.dot.isHidden,
                    text: block.text.measurable,
                    hint: block.hint?.measurable,
                    options: block.options.map { .init(label: $0.label.measurable, description: $0.description?.measurable) },
                    custom: block.customLabel.map { (label: $0.measurable, text: block.typed) }
                )
            },
            error: errorText == nil ? nil : errorLabel.measurable
        ))
        header.setLayoutFrame(layout.header)
        cancelButton.setLayoutFrame(layout.cancel.offsetBy(dx: 0, dy: -layout.header.minY).insetBy(dx: -8, dy: -8))
        titleLabel.place(layout.title.offsetBy(dx: 0, dy: -layout.header.minY))
        headerDivider.setLayoutFrame(layout.headerDivider)
        scrollView.setLayoutFrame(layout.scroll)
        scrollView.contentSize = layout.contentSize
        for (index, placed) in layout.questions.enumerated() {
            let block = blocks[index]
            block.chip.setLayoutFrame(placed.chip)
            block.chipText.place(placed.chipText)
            if let dot = placed.dot { block.dot.setLayoutFrame(dot) }
            block.text.place(placed.text)
            if let hint = placed.hint { block.hint?.place(hint) }
            for (optionIndex, option) in placed.options.enumerated() {
                let views = block.options[optionIndex]
                views.box.setLayoutFrame(option.box)
                let origin = option.box.origin
                views.checkbox.setLayoutFrame(option.checkbox.offsetBy(dx: -origin.x, dy: -origin.y))
                views.check.setLayoutFrame(views.checkbox.bounds)
                views.label.place(option.label.offsetBy(dx: -origin.x, dy: -origin.y))
                if let description = option.description { views.description?.place(description.offsetBy(dx: -origin.x, dy: -origin.y)) }
            }
            if let label = placed.customLabel { block.customLabel?.place(label) }
            if let input = placed.input, let field = block.input {
                field.setLayoutFrame(input)
                let inset = field.textContainerInset
                block.placeholder?.place(CGRect(x: inset.left, y: inset.top, width: input.width - inset.left - inset.right, height: ChatTextStyles.sheetInput.lineHeightValue))
            }
        }
        if let frame = layout.error { errorLabel.place(frame) }
        footer.setLayoutFrame(layout.footer)
        footerDivider.setLayoutFrame(layout.footerDivider.offsetBy(dx: 0, dy: -layout.footer.minY))
        let submit = layout.submit.offsetBy(dx: 0, dy: -layout.footer.minY)
        submitButton.setLayoutFrame(submit)
        submitLabel.place(layout.submitLabel.offsetBy(dx: -layout.submit.minX, dy: -layout.submit.minY))
        spinner.center = CGPoint(x: submit.width / 2, y: submit.height / 2)
    }

    // MARK: Actions

    @objc private func optionTapped(_ sender: UIControl) {
        for (index, question) in questions.enumerated() {
            guard let optionIndex = blocks[index].options.firstIndex(where: { $0.box === sender }) else { continue }
            let label = question.options[optionIndex].label
            drafts[question.id] = AgentCommunications.toggleOption(drafts[question.id] ?? AgentQuestionDraft(), label: label, multiSelect: question.multiSelect)
        }
        update()
    }

    func textViewDidChange(_ textView: UITextView) {
        guard let index = blocks.firstIndex(where: { $0.input === textView }) else { return }
        let question = questions[index]
        var draft = drafts[question.id] ?? AgentQuestionDraft()
        draft.custom = textView.text
        drafts[question.id] = draft
        update()
    }

    @objc private func submitTapped() {
        guard AgentCommunications.canSubmit(questions, drafts: drafts), !submitting else { return }
        submitting = true
        errorText = nil
        update()
        let answers = AgentCommunications.json(AgentCommunications.buildAnswers(questions, drafts: drafts))
        let submit = self.submit
        Task { [weak self] in
            do {
                try await submit(answers)
                self?.dismiss(animated: true)
            } catch {
                // The form stays open with the answers, so they can retry.
                guard let self else { return }
                let message = (error as? LocalizedError)?.errorDescription
                self.errorText = message ?? Strings.AgentQuestion.submitFailed
                self.submitting = false
                self.update()
            }
        }
    }

    @objc private func cancelTapped() {
        guard !submitting else { return }
        dismiss(animated: true)
        let cancel = self.cancel
        Task { await cancel() }
    }
}
#endif
