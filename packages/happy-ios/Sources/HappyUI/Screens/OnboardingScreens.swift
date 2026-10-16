#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Signed out: create an account or restore one. app/(app)/index.tsx.
public final class WelcomeViewController: UIViewController {
    private let context: AppContext
    private let titleView = NavigationTitleView()
    private lazy var screen = OnboardingScreenView(
        content: WelcomeContentView(),
        primary: RoundButton(title: Strings.Onboarding.createAccount),
        secondary: RoundButton(title: Strings.Onboarding.restoreExisting, size: .normal, display: .inverted)
    )

    public init(context: AppContext) {
        self.context = context
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func loadView() {
        view = screen
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        // OnboardingHeader's title, which scales in a header that doesn't.
        setScaledTitleView(titleView)
        showsBackTitle()
        // Signed out, the gear leads straight to the server: self-hosters
        // set it before creating an account.
        navigationItem.rightBarButtonItem = settingsBarButton(action: #selector(openServer), label: Strings.Server.title)
        screen.primary.action = { [weak self] in await self?.createAccount() }
        screen.secondary.onTap = { [weak self] in self?.openRestore() }
        screen.help.onTap = { [weak self] in
            guard let self else { return }
            Alerts.help(on: self)
        }
    }

    public override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        titleView.subtitle = context.customServerHost
        // Not `sizeToFit`, which would hold a server chosen meanwhile to the
        // width of the one before it.
        titleView.frame.size = titleView.intrinsicContentSize
    }

    private func createAccount() async {
        do {
            let credentials = try await context.account.authService.createAccount()
            try await context.account.signIn(credentials)
        } catch {
            Alerts.show(Strings.Common.error, Strings.Errors.authenticationFailed, on: self)
        }
    }

    private func openRestore() {
        navigationController?.pushViewController(RestoreQRViewController(context: context), animated: true)
    }

    @objc private func openServer() {
        navigationController?.pushViewController(ServerConfigViewController(context: context), animated: true)
    }
}

/// Restore by showing a QR code to the phone that has the account.
/// app/(app)/restore/index.tsx.
public final class RestoreQRViewController: UIViewController {
    private let context: AppContext
    private let scrollView = UIScrollView()
    private let instruction = StyledLabel(style: TextStyles.restoreInstruction, color: Palette.text, alignment: .center)
    private let path = StyledLabel(style: TextStyles.restorePath, color: Palette.textSecondary, alignment: .center)
    private let codeContainer = UIView()
    private let codeView = QRCodeView()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let secretKeyButton = RoundButton(title: Strings.Onboarding.restoreUseKey, size: .normal, display: .inverted)
    private var task: Task<Void, Never>?

    private var showsCode = false {
        didSet {
            codeView.isHidden = !showsCode
            codeContainer.backgroundColor = UIColor(showsCode ? Palette.qrBackground : Palette.surfaceHigh)
            if showsCode { spinner.stopAnimating() } else { spinner.startAnimating() }
            view.setNeedsLayout()
        }
    }

    public init(context: AppContext) {
        self.context = context
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        title = Strings.Onboarding.restoreTitle
        showsBackTitle()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        scrollView.contentInsetAdjustmentBehavior = .never
        view.addSubview(scrollView)
        instruction.string = Strings.Onboarding.restoreScan
        path.string = Strings.Onboarding.restoreScanPath
        codeContainer.layer.cornerRadius = RestoreQRLayout.Metrics.qrCornerRadius
        codeContainer.layer.cornerCurve = .continuous
        spinner.color = UIColor(Palette.text)
        for subview in [instruction, path, codeContainer, codeView, secretKeyButton] {
            scrollView.addSubview(subview)
        }
        codeContainer.addSubview(spinner)
        secretKeyButton.onTap = { [weak self] in
            guard let self else { return }
            navigationController?.pushViewController(RestoreSecretKeyViewController(context: context), animated: true)
        }
        showsCode = false
        startLogin()
    }

    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let size = view.bounds.size
        let insets = LayoutInsets(view.safeAreaInsets)
        let layout = RestoreQRLayout(.init(
            size: size,
            safeArea: insets,
            instruction: instruction.measurable,
            path: path.measurable,
            showsCode: showsCode,
            button: secretKeyButton.measurable
        ))
        scrollView.frame = view.bounds
        scrollView.contentSize = layout.contentSize
        instruction.setLayoutFrame(layout.instruction)
        path.setLayoutFrame(layout.path)
        codeContainer.setLayoutFrame(layout.codeContainer)
        spinner.center = CGPoint(x: codeContainer.bounds.midX, y: codeContainer.bounds.midY)
        if let frame = layout.code { codeView.setLayoutFrame(frame) }
        secretKeyButton.setLayoutFrame(layout.button)
    }

    public override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Popped back to Welcome: stop polling. Pushing the secret key
        // screen on top keeps it running, so either way can finish.
        if isMovingFromParent || navigationController == nil {
            task?.cancel()
        }
    }

    private func startLogin() {
        let account = context.account
        task = Task { @MainActor [weak self] in
            do {
                let login = try account.authService.startQRLogin()
                try await login.register()
                self?.codeView.payload = login.link.urlString
                self?.codeView.accessibilityLabel = Strings.Onboarding.restoreScan
                self?.showsCode = true
                let credentials = try await login.waitForApproval()
                try await account.signIn(credentials)
            } catch is CancellationError {
                return
            } catch {
                guard let self, !Task.isCancelled else { return }
                Alerts.show(Strings.Common.error, Strings.Errors.authenticationFailed, on: self)
            }
        }
    }
}

/// Restore by pasting the secret key. app/(app)/restore/manual.tsx.
public final class RestoreSecretKeyViewController: UIViewController, UITextViewDelegate {
    private let context: AppContext
    private let scrollView = UIScrollView()
    private let instruction = StyledLabel(style: TextStyles.restoreInstruction, color: Palette.textSecondary)
    private let fieldBackground = UIView()
    private let textView = UITextView()
    private let placeholder = StyledLabel(style: TextStyles.secretKeyInput, color: Palette.inputPlaceholder, lines: 1)
    private let restoreButton = RoundButton(title: Strings.Onboarding.restoreButton)
    /// Keeps a layout pass coming whenever the keyboard moves.
    private let keyboardTracker = UIView()

    public init(context: AppContext) {
        self.context = context
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        title = Strings.Onboarding.secretKeyTitle
        view.backgroundColor = UIColor(Palette.groupedBackground)
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.keyboardDismissMode = .interactive
        view.addSubview(scrollView)
        instruction.string = Strings.Onboarding.secretKeyBody
        fieldBackground.backgroundColor = UIColor(Palette.surfaceHigh)
        fieldBackground.layer.cornerRadius = RestoreSecretKeyLayout.Metrics.fieldCornerRadius
        fieldBackground.layer.cornerCurve = .continuous
        let padding = RestoreSecretKeyLayout.Metrics.fieldPadding
        textView.backgroundColor = .clear
        textView.textContainerInset = UIEdgeInsets(top: padding, left: padding, bottom: padding, right: padding)
        textView.textContainer.lineFragmentPadding = 0
        textView.isScrollEnabled = false
        applyInputStyle()
        textView.autocapitalizationType = .allCharacters
        textView.autocorrectionType = .no
        textView.spellCheckingType = .no
        textView.smartDashesType = .no
        textView.delegate = self
        textView.accessibilityLabel = Strings.Onboarding.secretKeyTitle
        placeholder.string = "XXXXX-XXXXX-XXXXX..."
        placeholder.isUserInteractionEnabled = false
        for subview in [instruction, fieldBackground, textView, placeholder, restoreButton] {
            scrollView.addSubview(subview)
        }
        restoreButton.action = { [weak self] in await self?.restore() }
        registerForTraitChanges(UIView.textSizeTraits) { (self: Self, _) in
            self.applyInputStyle()
            self.view.setNeedsLayout()
        }

        view.keyboardLayoutGuide.usesBottomSafeArea = false
        keyboardTracker.isHidden = true
        keyboardTracker.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(keyboardTracker)
        NSLayoutConstraint.activate([
            keyboardTracker.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            keyboardTracker.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            keyboardTracker.widthAnchor.constraint(equalToConstant: 1),
            keyboardTracker.heightAnchor.constraint(equalToConstant: 1),
        ])
    }

    public override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        textView.becomeFirstResponder()
    }

    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let overlap = max(0, view.bounds.maxY - view.keyboardLayoutGuide.layoutFrame.minY)
        let padding = RestoreSecretKeyLayout.Metrics.fieldPadding
        let fieldText = Measurable { [unowned self] width in
            let fitted = textView.sizeThatFits(CGSize(width: width + padding * 2, height: .greatestFiniteMagnitude))
            return CGSize(width: width, height: fitted.height - padding * 2)
        }
        let layout = RestoreSecretKeyLayout(.init(
            size: view.bounds.size,
            safeArea: LayoutInsets(view.safeAreaInsets),
            keyboardOverlap: overlap,
            instruction: instruction.measurable,
            fieldText: fieldText,
            button: restoreButton.measurable
        ))
        scrollView.frame = layout.scroll
        scrollView.contentSize = layout.contentSize
        instruction.setLayoutFrame(layout.instruction)
        fieldBackground.setLayoutFrame(layout.field)
        textView.setLayoutFrame(layout.field)
        placeholder.setLayoutFrame(CGRect(
            x: layout.field.minX + padding,
            y: layout.field.minY + padding,
            width: max(0, layout.field.width - padding * 2),
            height: placeholder.lineHeight
        ))
        restoreButton.setLayoutFrame(layout.button)
    }

    public func textViewDidChange(_ textView: UITextView) {
        placeholder.isHidden = !textView.text.isEmpty
        view.setNeedsLayout()
    }

    /// The key's text, as RN's TextInput draws it: at the person's text
    /// size, what is typed already included.
    private func applyInputStyle() {
        let style = traitCollection.textEnvironment.map { TextStyles.secretKeyInput.scaled($0.scale) } ?? TextStyles.secretKeyInput
        let attributes = style.attributes(color: UIColor(Palette.inputText))
        textView.typingAttributes = attributes
        if !textView.text.isEmpty {
            let selection = textView.selectedRange
            textView.attributedText = NSAttributedString(string: textView.text, attributes: attributes)
            textView.selectedRange = selection
        }
    }

    private func restore() async {
        let key = textView.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            Alerts.show(Strings.Common.error, Strings.Connect.enterSecretKey, on: self)
            return
        }
        do {
            let credentials = try await context.account.authService.restore(secretKey: key)
            try await context.account.signIn(credentials)
        } catch {
            Alerts.show(Strings.Common.error, Strings.Connect.invalidSecretKey, on: self)
        }
    }
}
#endif
