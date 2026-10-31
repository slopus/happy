#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A reply to a story artifact: the person's face, then their name in bold.
/// In the peek the words follow on that one line; stacked, in the drawer,
/// the time follows and the words wrap under them.
final class StoryReplyRow: UIView {
    static let pixels = Int(AgentStoryLayout.Viewer.drawerFace * 3)
    private let face = FaceView(), line = UILabel(), words = UILabel(), stacked: Bool

    init(stacked: Bool) {
        self.stacked = stacked
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        line.lineBreakMode = .byTruncatingTail
        words.numberOfLines = 0
        [face, line, words].forEach(addSubview)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func show(_ reply: StoryReply, people: [String: Person], images: Images?) {
        let id = reply.userId ?? "", person = people[id], ink = UIColor(stacked ? Palette.storiesDrawerText : Palette.storiesViewerText)
        face.show(id, person: person, picture: images?.cachedPicture(Person.photoPath(id), thumbhash: person?.thumbhash, pixels: Self.pixels), images: images)
        let text = NSMutableAttributedString(string: person?.name ?? Strings.Stories.someone, attributes: [.font: UIFont.systemFont(ofSize: stacked ? 13.5 : 14, weight: .semibold), .foregroundColor: ink])
        // 6 after the name, as the mock's margin.
        text.addAttribute(.kern, value: 6, range: NSRange(location: text.length - 1, length: 1))
        text.append(NSAttributedString(string: stacked ? RowTime.text(Double(reply.createdAt)) : reply.text, attributes: [.font: UIFont.systemFont(ofSize: stacked ? 12.5 : 14),
                                                                                                                        .foregroundColor: stacked ? UIColor(Palette.storiesDrawerTime) : ink.withAlphaComponent(0.92)]))
        line.attributedText = text
        let wrapped = NSMutableParagraphStyle()
        (wrapped.minimumLineHeight, wrapped.maximumLineHeight) = (AgentStoryLayout.Viewer.drawerText, AgentStoryLayout.Viewer.drawerText)
        words.attributedText = stacked ? NSAttributedString(string: reply.text, attributes: [.font: UIFont.systemFont(ofSize: 15), .foregroundColor: ink, .paragraphStyle: wrapped]) : nil
    }

    func height(width: CGFloat) -> CGFloat { AgentStoryLayout.replyRow(width: width, text: wordsHeight(width)).height }

    private func wordsHeight(_ width: CGFloat) -> CGFloat? {
        guard stacked else { return nil }
        return ceil(words.sizeThatFits(CGSize(width: AgentStoryLayout.replyRow(width: width, text: 0).text.width, height: .greatestFiniteMagnitude)).height)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let row = AgentStoryLayout.replyRow(width: bounds.width, text: wordsHeight(bounds.width))
        (face.frame, line.frame, words.frame) = (row.face, row.line, row.text)
    }
}

/// A story artifact's foot scrim (`AgentStoryLayout.Viewer.scrim`): black
/// stops over a blur that fades in over its first `blurLead`.
final class StoryScrimView: UIView {
    private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark)), reveal = UIView(), revealFade = CAGradientLayer(), fade = CAGradientLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        revealFade.colors = [UIColor.clear.cgColor, UIColor.black.cgColor]
        reveal.layer.addSublayer(revealFade)
        blur.mask = reveal
        addSubview(blur)
        layer.addSublayer(fade)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        typealias V = AgentStoryLayout.Viewer
        let height = max(1, bounds.height), stops = V.scrim + [(height, V.scrimFoot)]
        CATransaction.begin(); CATransaction.setDisableActions(true)
        (blur.frame, reveal.frame, revealFade.frame, fade.frame) = (bounds, bounds, bounds, bounds)
        revealFade.locations = [0, NSNumber(value: Double(V.blurLead / height))]
        (fade.colors, fade.locations) = (stops.map { UIColor(white: 0, alpha: $0.1).cgColor }, stops.map { NSNumber(value: Double($0.0 / height)) })
        CATransaction.commit()
    }
}

extension UIView {
    /// The mock's shadow under text over a frame: 0 1 2, black at 40%.
    func storyTextShadow() {
        (layer.shadowColor, layer.shadowOpacity, layer.shadowRadius, layer.shadowOffset) = (UIColor.black.cgColor, 0.4, 1, CGSize(width: 0, height: 1))
    }
}

/// A story artifact's replies in a stock sheet `height` tall (then all the
/// screen): "N REPLIES · SENT TO …" with a close button, every reply oldest
/// first at the list's foot, and the viewer's own reply field (the same one,
/// the same send) pinned at its bottom.
final class StoryRepliesSheet: UIViewController {
    private let heading = UILabel(), close = UIButton(type: .system), list = UIScrollView(), lines = [UIView(), UIView()], field: UITextField
    private var rows: [StoryReplyRow] = []
    var onClose: (() -> Void)?

    init(field: UITextField, height: CGFloat) {
        self.field = field
        super.init(nibName: nil, bundle: nil)
        overrideUserInterfaceStyle = .dark
        sheetPresentationController?.detents = [.custom { _ in height }, .large()]
        sheetPresentationController?.prefersGrabberVisible = true
        sheetPresentationController?.preferredCornerRadius = 14
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.storiesDrawerGround)
        view.accessibilityIdentifier = "story-replies"
        close.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)), for: .normal)
        close.tintColor = UIColor(Palette.storiesDrawerText)
        close.accessibilityLabel = Strings.Stories.close
        close.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .touchUpInside)
        lines.forEach { $0.backgroundColor = UIColor(Palette.storiesDrawerLine) }
        (field.backgroundColor, field.layer.borderColor) = (UIColor(Palette.storiesDrawerField), UIColor(Palette.storiesDrawerLine).cgColor)
        field.attributedPlaceholder = NSAttributedString(string: field.attributedPlaceholder?.string ?? "", attributes: [.foregroundColor: UIColor(Palette.storiesDrawerHint)])
        ([heading, close, list, field] + lines).forEach(view.addSubview)
    }

    /// `replies` newest first, drawn oldest first.
    func show(_ replies: [StoryReply], to name: String, people: [String: Person], images: Images?) {
        loadViewIfNeeded()
        heading.attributedText = NSAttributedString(string: Strings.Stories.replies(replies.count, to: name), attributes: [.font: UIFont.systemFont(ofSize: 11.5, weight: .semibold), .kern: 0.92,
                                                                                                                          .foregroundColor: UIColor(Palette.storiesDrawerHeading)])
        heading.lineBreakMode = .byTruncatingTail
        rows.forEach { $0.removeFromSuperview() }
        rows = replies.reversed().map { reply in
            let row = StoryReplyRow(stacked: true)
            row.show(reply, people: people, images: images)
            list.addSubview(row)
            return row
        }
        view.setNeedsLayout()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let drawer = AgentStoryLayout.drawer(size: view.bounds.size, bottom: view.bounds.maxY - view.keyboardLayoutGuide.layoutFrame.minY, heights: rows.map { $0.height(width: view.bounds.width) })
        (heading.frame, close.frame, list.frame, field.frame) = (drawer.heading, drawer.close, drawer.list, drawer.field)
        zip(rows, drawer.rows).forEach { $0.frame = $1 }
        zip(lines, drawer.lines).forEach { $0.frame = $1 }
        list.contentSize = CGSize(width: drawer.list.width, height: drawer.content)
    }

    /// Typing, the keyboard goes with the drawer, before the field goes back.
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if isBeingDismissed { field.resignFirstResponder() }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed { onClose?() }
    }
}
#endif
