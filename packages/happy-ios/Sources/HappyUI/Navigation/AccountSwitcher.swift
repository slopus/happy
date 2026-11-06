#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Home's left bar item, alone there on both homes: the active account's
/// picture and name on one line, and a chevron. A tap opens the native
/// menu: every account and agent connection (the active one ticked; another
/// switches to it), then Add (`AccountAdding`) and Connect to Happy Cloud. Adding
/// or a failed switch leaves the active account as it was.
///
/// Every kind of account is one row in the menu: a legacy account, one made
/// for a computer and an agent connection differ only in their name and
/// picture, and to VoiceOver in their kind (Happy CLI or Happy Agent). Each picture is the account's own or its placeholder
/// (`ProfilePictures`), drawn as the same round bitmap at the same size
/// and scale; none has a subtitle. UIKit lays a symbol and a bitmap, or a
/// row with a subtitle and one without, out differently.
@MainActor
final class AccountSwitcher: NSObject {
    private let context: AppContext
    private weak var controller: UIViewController?
    private let button = AccountSwitcherButton()
    private let item: UIBarButtonItem
    private var observation: AccountsObservation?
    private var images: [String: UIImage] = [:]
    /// Accounts whose picture or placeholder has arrived, for tests.
    var loadedPictureIDs: Set<String> { Set(images.keys) }
    private var imageKeys: [String: String] = [:]
    private var jobs: [String: Task<Void, Never>] = [:]
    private var switching = false

    /// The account's link as its headers show it (`LinkIndicator`, so
    /// already debounced). While it isn't live its status takes the name's
    /// place (`Strings.HeaderStatus.title`), and VoiceOver hears the change.
    var link: LinkState = .online {
        didSet {
            guard link != oldValue else { return }
            button.setStatus(Strings.HeaderStatus.title(link), animated: true, bar: controller?.navigationController?.navigationBar)
            describe()
            announceSoon()
        }
    }
    /// The last change VoiceOver was told of, and the one on its way.
    private var announced: LinkState = .online
    private var announcement: DispatchWorkItem?

    init(context: AppContext, controller: UIViewController) {
        self.context = context
        self.controller = controller
        item = UIBarButtonItem(customView: button)
        // Its glass is the bar's own (the item's shared background), which
        // the bar morphs into Back as a chat is pushed and out of it as the
        // chat goes. Glass of its own, with the bar's hidden, went through
        // that morph as a hard-edged rectangle. The bar is laid out inside
        // `setStatus`'s animation, so its glass follows the width.
        super.init()
        button.accessibilityIdentifier = "account-switcher"
        button.showsMenuAsPrimaryAction = true
        button.menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] done in done(self?.menuElements() ?? []) }])
        observation = context.account.observeAccounts { [weak self] _ in self?.show() }
        show()
    }

    /// The item the screen puts in its bar. One item throughout, so a
    /// screen places it once and it keeps itself up to date.
    var barItem: UIBarButtonItem { item }

    private func name(_ account: AccountSummary) -> String {
        if account.isAgentConnection, let connection = context.account.agentConnections.accounts.first(where: { $0.id == account.id }) {
            return connection.name
        }
        return account.shownName
    }

    /// The one account the switcher calls current. A signed-in Happy
    /// account and an open agent connection each report themselves active,
    /// from two fields that know nothing of each other
    /// (`AccountController.accounts`), so in that mixed case more than one
    /// says so. The first in the order they are shown in wins, which is
    /// the one the button already draws.
    private func current(in accounts: [AccountSummary]) -> AccountSummary? {
        accounts.first(where: \.isActive)
    }

    private func show() {
        let accounts = context.account.accounts
        accounts.forEach(loadImage)
        guard let active = current(in: accounts) else { return }
        button.title = name(active)
        button.picture = images[active.id] ?? Self.fallback(active)
        button.liveSeed = ProfilePictures.liveSeed(active, context: context)
        describe()
        button.frame.size = button.sizeThatFits(.zero)
        item.customView = button
        layout()
    }

    /// The status first while it stands in the name's place: "Connecting…,
    /// Steve". A computer that did not answer says so in home's list, and
    /// the name stands, but VoiceOver hears "offline" after it.
    private func describe() {
        guard let active = current(in: context.account.accounts) else { return }
        button.accessibilityLabel = Strings.AccountSwitcher.switcher
        let status = Strings.HeaderStatus.title(link)
        let after = link == .offline ? Strings.HeaderStatus.text(.offline) : nil
        button.accessibilityValue = [status, name(active), after].compactMap { $0 }.joined(separator: ", ")
    }

    /// Says the change aloud once it has stood half a second, and only
    /// while home is on screen: a status that comes and goes at once is
    /// said once, or not at all if it is back where it was.
    private func announceSoon() {
        announcement?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self, link != announced, controller?.viewIfLoaded?.window != nil else { return }
            announced = link
            guard let words = Self.announcement(for: link) else { return }
            UIAccessibility.post(notification: .announcement, argument: words)
        }
        announcement = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: item)
    }

    /// What VoiceOver hears for a change: the status, or that the account
    /// is online again. Offline is said by the notice that explains it.
    static func announcement(for link: LinkState) -> String? {
        if let title = Strings.HeaderStatus.title(link) { return title }
        guard link == .online else { return nil }
        let online = Strings.HeaderStatus.text(.online)
        return online.prefix(1).uppercased(with: Locale(identifier: AppLocalization.language)) + online.dropFirst()
    }

    func layout() {
        guard let controller, let navigation = controller.navigationController else { return }
        button.maximumWidth = AccountSwitcherLayout.availableWidth(
            barWidth: navigation.navigationBar.bounds.width,
            safeArea: LayoutInsets(navigation.navigationBar.safeAreaInsets),
            trailingItems: controller.navigationItem.rightBarButtonItems?.count ?? 0
        )
    }

    /// Until its picture is decoded: an empty circle the same size.
    private static func fallback(_ account: AccountSummary) -> UIImage? {
        AvatarPlaceholderImages.pending(side: menuPicture)
    }

    /// The side every account's picture is drawn at, in the bar and the menu.
    static let menuPicture = AccountSwitcherLayout.Metrics.picture

    private func loadImage(_ account: AccountSummary) {
        let key = ProfilePictures.key(account, context: context)
        guard imageKeys[account.id] != key else { return }
        imageKeys[account.id] = key
        jobs[account.id]?.cancel()
        // Its thumbhash or decoded placeholder at once, the picture when it comes.
        if let placeholder = ProfilePictures.immediate(account, context: context) {
            images[account.id] = Self.round(placeholder, side: Self.menuPicture)
        }
        jobs[account.id] = Task { [weak self, context] in
            let image = await ProfilePictures.load(account, context: context)
            guard !Task.isCancelled, let self, imageKeys[account.id] == key else { return }
            images[account.id] = image.map { Self.round($0, side: Self.menuPicture) }
            show()
        }
    }

    private static func round(_ image: UIImage, side: CGFloat) -> UIImage {
        let size = CGSize(width: side, height: side)
        return UIGraphicsImageRenderer(size: size).image { _ in
            let rect = CGRect(origin: .zero, size: size)
            UIBezierPath(ovalIn: rect).addClip()
            image.draw(in: rect)
        }.withRenderingMode(.alwaysOriginal)
    }

    /// Not private, so a test can read what the menu would show without
    /// opening it; the menu itself asks for these on every tap.
    func menuElements() -> [UIMenuElement] {
        let accounts = context.account.accounts
        let current = current(in: accounts)?.id
        let choices: [UIMenuElement] = accounts.map { account in
            let fullName = name(account)
            let action = UIAction(title: Self.menuTitle(fullName), image: images[account.id] ?? Self.fallback(account), state: account.id == current ? .on : .off) { [weak self] _ in
                self?.choose(account, current: current)
            }
            // The rows look alike, so VoiceOver says which kind each is.
            action.accessibilityLabel = Strings.AccountKind.spoken(fullName, account.kindName)
            action.accessibilityIdentifier = "account-\(account.id)"
            return action
        }
        let add = UIAction(title: Strings.AccountSwitcher.add, image: UIImage(systemName: "plus")) { [weak self] _ in
            guard let self, let controller else { return }
            AccountAdding.begin(context: context, from: controller)
        }
        add.accessibilityIdentifier = "account-add"
        let cloud = UIAction(title: Strings.ServerSignIn.cloudAction, image: UIImage(systemName: "cloud")) { [weak self] _ in
            guard let self, let controller else { return }
            AccountAdding.connectToCloud(context: context, from: controller)
        }
        cloud.accessibilityIdentifier = "account-cloud"
        return [
            UIMenu(options: .displayInline, children: choices),
            UIMenu(options: .displayInline, children: HappyCloud.isOffered(in: context.variant) ? [add, cloud] : [add]),
        ]
    }

    /// UIKit's compact menu reserves a fixed lane for the check and picture.
    /// UIKit wraps long titles, so allow room for roughly two lines before
    /// truncating the name.
    private static func menuTitle(_ name: String) -> String {
        let font = UIFont.preferredFont(forTextStyle: .body)
        func width(_ text: String) -> CGFloat { (text as NSString).size(withAttributes: [.font: font]).width }
        let limit: CGFloat = 300
        guard width(name) > limit else { return name }
        var title = name
        while !title.isEmpty, width(title + "…") > limit { title.removeLast() }
        return title.trimmingCharacters(in: .whitespaces) + "…"
    }

    /// `current` is the ticked one, not every account that calls itself
    /// active: in the mixed case the other one is a real switch.
    private func choose(_ account: AccountSummary, current: String?) {
        guard account.id != current, !switching else { return }
        switching = true
        Task { [weak self] in
            guard let self else { return }
            defer { switching = false }
            do {
                // The coordinator puts the other account's home in place.
                try await context.account.switchAccount(to: account.id)
            } catch {
                guard let controller else { return }
                Alerts.show(Strings.Common.error, Strings.AccountSwitcher.switchFailed, on: controller)
            }
        }
    }
}

/// The switcher's single-line face, placed by `AccountSwitcherLayout`:
/// the picture, the name or the link's status in its place, and the
/// chevron. The name and the status are each in a lane of their own, as
/// wide as the button, so one can slide and fade over the other while
/// their frames stay the layout's. Its glass is the bar's, round it.
final class AccountSwitcherButton: UIButton {
    private let pictureView = UIImageView()
    private let titleLane = UIView()
    private let titleText = StyledLabel(style: TextStyles.headerTitle, color: Palette.headerTint, lines: 1)
    private let statusLane = UIView()
    /// The words' own lane in the status's, so one status's words can
    /// give way to the next while the spinner stays.
    private let wordsLane = UIView()
    let spinner = LinkSpinnerView()
    private let statusText = StyledLabel(style: TextStyles.headerTitle, color: Palette.headerTint, lines: 1)
    private let chevron = UIImageView(image: UIImage(systemName: "chevron.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .semibold)))

    var title = "" {
        didSet { titleText.string = title; invalidateIntrinsicContentSize(); setNeedsLayout() }
    }

    /// The link's status in the name's place ("Connecting…"); nil while
    /// the name shows. Set it through `setStatus(_:animated:)`.
    private(set) var status: String?
    /// The words last shown, kept while they fade away.
    private var lastStatus: String?

    var maximumWidth: CGFloat = .greatestFiniteMagnitude {
        didSet {
            guard maximumWidth != oldValue else { return }
            invalidateIntrinsicContentSize()
            frame.size = sizeThatFits(.zero)
            setNeedsLayout()
        }
    }

    var picture: UIImage? {
        didSet { if picture !== oldValue { ImageFade.show(picture, in: pictureView, fade: oldValue != nil && picture != nil) } }
    }

    /// The placeholder's seed when `picture` is the placeholder: it moves
    /// with Animated Avatars on (`ProfilePictures.liveSeed`). The menu's
    /// pictures are the system's bitmaps and stay still.
    var liveSeed: String? {
        didSet { if liveSeed != oldValue { live.animate(seed: liveSeed) } }
    }
    private let live = AvatarPlaceholderSlot()

    override init(frame: CGRect) {
        super.init(frame: frame)
        live.liveHost = pictureView
        pictureView.contentMode = .scaleAspectFill
        pictureView.clipsToBounds = true
        pictureView.layer.cornerRadius = AccountSwitcherLayout.Metrics.picture / 2
        chevron.tintColor = UIColor(Palette.textSecondary)
        titleText.lineBreakMode = .byTruncatingTail
        statusText.lineBreakMode = .byTruncatingTail
        statusText.accessibilityIdentifier = "home-link-status"
        statusLane.alpha = 0
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        titleLane.addSubview(titleText)
        statusLane.addSubview(spinner)
        wordsLane.addSubview(statusText)
        statusLane.addSubview(wordsLane)
        for view in [pictureView, titleLane, statusLane, chevron] as [UIView] {
            view.isUserInteractionEnabled = false
            addSubview(view)
        }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func measured(maxWidth: CGFloat? = nil) -> AccountSwitcherLayout {
        let unbounded = CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        return AccountSwitcherLayout(
            title: titleText.sizeThatFits(unbounded),
            status: lastStatus.map { _ in .init(spinner: spinner.sizeThatFits(.zero), text: statusText.sizeThatFits(unbounded)) },
            showing: status == nil ? .title : .status,
            chevron: chevron.image?.size ?? .zero,
            maxWidth: maxWidth ?? maximumWidth
        )
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize { measured().size }
    override var intrinsicContentSize: CGSize { measured().size }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = measured(maxWidth: bounds.width)
        pictureView.setLayoutFrame(layout.picture)
        // The lanes are the button's bounds, placed by bounds and centre so
        // a slide's transform leaves their frames alone.
        for lane in [titleLane, statusLane, wordsLane] {
            lane.bounds = CGRect(origin: .zero, size: bounds.size)
            lane.center = CGPoint(x: bounds.midX, y: bounds.midY)
        }
        place(layout)
        chevron.setLayoutFrame(layout.chevron)
    }

    /// The name and the status where they are in their lanes: the same
    /// whatever the width, so a change places what comes before it shows.
    private func place(_ layout: AccountSwitcherLayout) {
        titleText.setLayoutFrame(layout.title)
        spinner.setLayoutFrame(layout.spinner)
        statusText.setLayoutFrame(layout.status)
    }

    /// What the title says: the name (nil) or the link's status. Animated,
    /// the one going slides up and fades as the one coming rises into its
    /// place, and the button's width follows in the same 0.25 s (Telegram's
    /// title). With Reduce Motion they only crossfade. `bar` is laid out in
    /// the animation, so the glass round the button follows its width.
    func setStatus(_ text: String?, animated: Bool, bar: UIView? = nil) {
        guard text != status else { return }
        let wasStatus = status != nil
        let words = statusText.string
        let wordsFrame = statusText.frame
        status = text
        if let text {
            lastStatus = text
            statusText.string = text
            spinner.spins = true
        }
        let isStatus = text != nil
        let incoming = isStatus ? statusLane : titleLane
        let outgoing = isStatus ? titleLane : statusLane
        invalidateIntrinsicContentSize()
        let size = sizeThatFits(.zero)
        // What comes is in its place before it fades in; only the width,
        // the glass and the chevron move.
        UIView.performWithoutAnimation { place(measured()) }
        guard animated, window != nil, UIView.areAnimationsEnabled else {
            wordsLane.alpha = 1; wordsLane.transform = .identity
            incoming.alpha = 1; incoming.transform = .identity
            outgoing.alpha = 0; outgoing.transform = .identity
            frame.size = size
            setNeedsLayout()
            bar?.setNeedsLayout()
            spinner.spins = isStatus
            return
        }
        let slide = UIAccessibility.isReduceMotionEnabled ? 0 : AccountSwitcherLayout.Metrics.slide
        if wasStatus == isStatus {
            // One status for another: the spinner stays and turns on; only
            // the words change, the old ones lifted away from a copy.
            let copy = Self.copy(of: statusText, saying: words, at: wordsFrame)
            copy.map(statusLane.addSubview)
            wordsLane.alpha = 0
            wordsLane.transform = CGAffineTransform(translationX: 0, y: slide)
            Self.animate {
                copy?.alpha = 0
                copy?.transform = CGAffineTransform(translationX: 0, y: -slide)
                self.wordsLane.alpha = 1
                self.wordsLane.transform = .identity
                self.resize(to: size, bar: bar)
            } completion: { _ in copy?.removeFromSuperview() }
            return
        }
        incoming.transform = CGAffineTransform(translationX: 0, y: slide)
        Self.animate {
            incoming.alpha = 1
            incoming.transform = .identity
            outgoing.alpha = 0
            outgoing.transform = CGAffineTransform(translationX: 0, y: -slide)
            self.resize(to: size, bar: bar)
        } completion: { [weak self] _ in
            guard let self, (status != nil) == isStatus else { return }
            outgoing.transform = .identity
            spinner.spins = isStatus
        }
    }

    private func resize(to size: CGSize, bar: UIView?) {
        frame.size = size
        layoutIfNeeded()
        bar?.setNeedsLayout()
        bar?.layoutIfNeeded()
    }

    static let transitionDuration: TimeInterval = 0.25

    private static func animate(_ animations: @escaping () -> Void, completion: ((Bool) -> Void)? = nil) {
        UIView.animate(
            withDuration: transitionDuration, delay: 0,
            options: [.beginFromCurrentState, .allowUserInteraction, .curveEaseInOut],
            animations: animations, completion: completion
        )
    }

    /// A still of `label` saying `words` at `frame`, where they were, to fade away.
    private static func copy(of label: StyledLabel, saying words: String, at frame: CGRect) -> UIView? {
        guard !words.isEmpty else { return nil }
        let copy = StyledLabel(style: label.style, color: label.color, lines: 1)
        copy.lineBreakMode = label.lineBreakMode
        copy.string = words
        copy.frame = frame
        copy.isUserInteractionEnabled = false
        return copy
    }

    // Tests: what shows, and how far through a change it is.
    var titleLaneView: UIView { titleLane }
    var statusLaneView: UIView { statusLane }
    var statusLabel: StyledLabel { statusText }
    var nameLabel: StyledLabel { titleText }
}
#endif

