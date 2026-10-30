#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// C-311 SidebarProposal: a sidebar Prioritizing proposed, drawn by the
/// sidebar's own rows at their full height, with "Keep mine" and "Use this
/// sidebar" under them while it is open and one line once it is answered.
/// Its frames are `SidebarProposalLayout`'s.
@MainActor
final class SidebarProposalView: UIView {
    var onAccept: (() -> Void)?
    var onDecline: (() -> Void)?
    /// A section or a row with rows under it was folded or unfolded.
    var onTurn: ((String) -> Void)?

    private let titleLabel = UILabel()
    private let versionLabel = UILabel()
    private let ground = UIView()
    private let sidebar = SidebarView()
    private let keep = ProposalButton(primary: false)
    private let use = ProposalButton(primary: true)
    private let noticeLabel = UILabel()
    private let statusLabel = UILabel()
    private var layout: SidebarProposalLayout?

    init(images: Images?) {
        super.init(frame: .zero)
        typealias M = SidebarProposalLayout.Metrics
        backgroundColor = UIColor(Palette.cardFill)
        layer.cornerRadius = M.radius
        layer.cornerCurve = .continuous
        layer.borderWidth = M.border
        accessibilityIdentifier = "proposal"

        titleLabel.font = Fonts.ui(.semiBold, size: M.headerSize)
        titleLabel.textColor = UIColor(Palette.cardTitle)
        titleLabel.text = Strings.proposedSidebar
        titleLabel.accessibilityTraits = .header
        versionLabel.font = Fonts.tabular(Fonts.ui(.regular, size: M.headerSize))
        versionLabel.textColor = UIColor(Palette.cardDetail)
        versionLabel.isAccessibilityElement = false

        ground.backgroundColor = UIColor(Palette.background)
        ground.layer.cornerRadius = M.frameRadius
        ground.layer.cornerCurve = .continuous
        ground.clipsToBounds = true
        // Full height, never scrolled: the chat around it scrolls.
        sidebar.isScrollEnabled = false
        sidebar.alwaysBounceVertical = false
        sidebar.images = images
        sidebar.onFold = { [weak self] row in self?.onTurn?(row.id) }
        ground.addSubview(sidebar)

        keep.title = Strings.keepMine
        keep.accessibilityIdentifier = "proposal-keep"
        keep.addTarget(self, action: #selector(declined), for: .touchUpInside)
        use.title = Strings.useThisSidebar
        use.accessibilityIdentifier = "proposal-use"
        use.addTarget(self, action: #selector(accepted), for: .touchUpInside)

        noticeLabel.font = Fonts.ui(.regular, size: M.noteSize)
        noticeLabel.textColor = UIColor(Palette.notice)
        noticeLabel.lineBreakMode = .byTruncatingTail
        noticeLabel.accessibilityTraits = .staticText
        statusLabel.font = Fonts.ui(.regular, size: M.noteSize)
        statusLabel.textColor = UIColor(Palette.cardDetail)
        statusLabel.textAlignment = .right
        statusLabel.accessibilityIdentifier = "proposal-status"

        for view in [titleLabel, versionLabel, ground, keep, use, noticeLabel, statusLabel] { addSubview(view) }
        updateBorder()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.updateBorder() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func updateBorder() {
        layer.borderColor = UIColor(Palette.proposalBorder).resolvedColor(with: traitCollection).cgColor
    }

    func apply(_ shown: ProposalShown, layout: SidebarProposalLayout) {
        typealias M = SidebarProposalLayout.Metrics
        self.layout = layout
        versionLabel.text = Strings.proposalVersion(shown.revision)
        titleLabel.accessibilityLabel = Strings.proposalLabel(shown.revision)
        sidebar.apply(shown.rows)
        ground.alpha = shown.status == .declined ? M.declinedAlpha : 1
        let open = shown.status == .open
        keep.isHidden = !open
        use.isHidden = !open
        keep.isEnabled = shown.answering == nil
        use.isEnabled = shown.answering == nil
        keep.loading = shown.answering == .decline
        use.loading = shown.answering == .accept
        noticeLabel.text = shown.notice
        noticeLabel.isHidden = !open || shown.notice == nil
        statusLabel.text = switch shown.status {
        case .accepted: Strings.proposalAccepted
        case .declined: Strings.proposalDeclined
        default: nil
        }
        statusLabel.isHidden = open
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard let layout else { return }
        titleLabel.frame = layout.title
        versionLabel.frame = layout.version
        ground.frame = layout.frame
        sidebar.frame = ground.bounds
        if let frame = layout.keep { keep.frame = frame }
        if let frame = layout.use { use.frame = frame }
        noticeLabel.frame = layout.notice ?? .zero
        statusLabel.frame = layout.status ?? .zero
    }

    @objc private func accepted() { onAccept?() }

    @objc private func declined() { onDecline?() }
}

/// `Button size="small"`: a 28-tall pill, black with white ink for the
/// primary answer, ringed on the raised surface for the other; while an
/// answer is on its way both fade and the chosen one spins.
@MainActor
final class ProposalButton: UIControl {
    private let primary: Bool
    private let label = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)

    var title = "" {
        didSet {
            label.text = title
            accessibilityLabel = title
        }
    }

    var loading = false {
        didSet {
            guard loading != oldValue else { return }
            label.isHidden = loading
            if loading { spinner.startAnimating() } else { spinner.stopAnimating() }
        }
    }

    override var isEnabled: Bool {
        didSet { update() }
    }

    override var isHighlighted: Bool {
        didSet { update() }
    }

    init(primary: Bool) {
        self.primary = primary
        super.init(frame: .zero)
        typealias M = SidebarProposalLayout.Metrics
        layer.cornerCurve = .continuous
        layer.borderWidth = M.border
        label.font = Fonts.ui(.bold, size: M.buttonSize)
        label.textAlignment = .center
        label.textColor = UIColor(primary ? Palette.primaryButtonInk : Palette.cardTitle)
        label.isUserInteractionEnabled = false
        spinner.color = label.textColor
        spinner.hidesWhenStopped = true
        spinner.transform = CGAffineTransform(scaleX: 0.7, y: 0.7)
        addSubview(label)
        addSubview(spinner)
        isAccessibilityElement = true
        accessibilityTraits = .button
        update()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.update() }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private func update() {
        typealias M = SidebarProposalLayout.Metrics
        let fill: ColorToken = primary
            ? (isEnabled ? Palette.primaryButton : Palette.primaryButtonDisabled)
            : Palette.button
        backgroundColor = UIColor(fill)
        let ring: ColorToken = primary ? Palette.primaryButton : Palette.divider
        layer.borderColor = isEnabled || !primary
            ? UIColor(ring).resolvedColor(with: traitCollection).cgColor
            : UIColor(fill).resolvedColor(with: traitCollection).cgColor
        alpha = isEnabled ? (isHighlighted ? 0.8 : 1) : M.disabledAlpha
        accessibilityTraits = isEnabled ? .button : [.button, .notEnabled]
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = bounds.height / 2
        label.frame = bounds
        spinner.center = CGPoint(x: bounds.midX, y: bounds.midY)
    }

    /// A finger needs more than the 28 points the pill draws.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        bounds.insetBy(dx: -4, dy: -8).contains(point)
    }
}
#endif
