#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// components/GitLineChanges.tsx: `≈`, `+N` and `-M`, 4 apart.
final class DetailLineChangesView: UIView {
    var changes: SessionDetails.LineChanges? {
        didSet { if changes != oldValue { apply() } }
    }

    private let approximate = StyledLabel(style: SecondaryTextStyles.lineChangesApproximate, color: Palette.textSecondary, lines: 1)
    private let added = StyledLabel(style: SecondaryTextStyles.lineChanges, color: SecondaryPalette.gitAdded, lines: 1)
    private let removed = StyledLabel(style: SecondaryTextStyles.lineChanges, color: SecondaryPalette.gitRemoved, lines: 1)

    init(_ changes: SessionDetails.LineChanges?) {
        self.changes = changes
        super.init(frame: .zero)
        approximate.string = "≈"
        for label in [approximate, added, removed] { addSubview(label) }
        apply()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private var parts: [UILabel] {
        guard let changes else { return [] }
        var parts: [UILabel] = []
        if changes.approximate { parts.append(approximate) }
        if changes.insertions > 0 { parts.append(added) }
        if changes.deletions > 0 { parts.append(removed) }
        return parts
    }

    private func layout() -> HorizontalStackLayout {
        HorizontalStackLayout(parts.map { $0.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)) }, spacing: 4)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout().size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        for (label, frame) in zip(parts, layout().items) { label.setLayoutFrame(frame) }
    }

    private func apply() {
        added.string = "+" + SessionDetails.compactCount(changes?.insertions ?? 0)
        removed.string = "-" + SessionDetails.compactCount(changes?.deletions ?? 0)
        let shown = Set(parts.map(ObjectIdentifier.init))
        for label in [approximate, added, removed] { label.isHidden = !shown.contains(ObjectIdentifier(label)) }
        setNeedsLayout()
        superview?.setNeedsLayout()
    }
}

/// info.tsx's right element on the Changes row: "N changed files", the
/// line counts and its own chevron, 6 apart.
final class DetailChangesAccessoryView: UIView {
    private let count = StyledLabel(style: SecondaryTextStyles.changedFiles, color: Palette.textSecondary, lines: 1)
    private let lines: DetailLineChangesView
    private let chevron = IconView(.ionicons("chevron-forward"), size: 17, tint: Palette.groupedChevron)
    private let presentation: SessionDetails.GitPresentation

    init(_ presentation: SessionDetails.GitPresentation) {
        self.presentation = presentation
        lines = DetailLineChangesView(presentation.changes)
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        count.string = presentation.changedFileCount.map(Strings.FilesDetail.changedFiles) ?? ""
        count.isHidden = presentation.changedFileCount == nil
        lines.isHidden = presentation.changes == nil
        for view in [count, lines, chevron] { addSubview(view) }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private var parts: [UIView] {
        [count, lines, chevron].filter { !$0.isHidden }
    }

    private func layout() -> HorizontalStackLayout {
        HorizontalStackLayout(parts.map { $0.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)) }, spacing: 6)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        layout().size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        for (view, frame) in zip(parts, layout().items) {
            view.setLayoutFrame(view === chevron ? IconLayout.textFrame(frame, scale: layoutScale) : frame)
        }
    }

    override var accessibilityLabel: String? {
        get { [count.isHidden ? nil : count.string].compactMap { $0 }.joined() }
        set {}
    }
}

/// A trailing glyph at RN's box size (`rightElement={<Ionicons …/>}`).
final class DetailTrailingIcon: UIView {
    let icon: IconView

    init(_ glyph: Icon, size: CGFloat, tint: ColorToken) {
        icon = IconView(glyph, size: size, tint: tint)
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        addSubview(icon)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        icon.sizeThatFits(size)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        icon.frame = bounds
    }
}

/// `rightElement={<Text style={{ color, fontSize: 14 }}>…</Text>}`: a plain
/// React Native Text, so the system font, at 14 × the text size's
/// multiplier where the screen follows it.
final class DetailTrailingText: UILabel {
    static let fontSize: CGFloat = 14

    init(_ text: String, color: ColorToken) {
        super.init(frame: .zero)
        self.text = text
        textColor = UIColor(color)
        numberOfLines = 1
        applyTextSize()
        registerForTraitChanges(UIView.textSizeTraits) { (self: Self, _) in
            self.applyTextSize()
            self.setNeedsLayoutUpTheTree()
        }
    }

    private func applyTextSize() {
        font = .systemFont(ofSize: Self.fontSize * (traitCollection.textEnvironment?.scale.multiplier ?? 1))
    }

    /// Measured before its first trait update: measure what it will draw.
    override func sizeThatFits(_ size: CGSize) -> CGSize {
        applyTextSize()
        return super.sizeThatFits(size)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }
}

/// A screen's centred message on the grouped background: an optional icon
/// or spinner over lines of text (`CenteredStackLayout`).
final class DetailMessageView: UIView {
    struct Line {
        var text: String
        var style: TextStyle
        var color: ColorToken
        var spacingBefore: CGFloat = 0
        var horizontalPadding: CGFloat = 0
        var centered = false
    }

    private let lead: UIView?
    private let labels: [StyledLabel]
    private let lines: [Line]
    private let padding: CGFloat

    init(lead: UIView?, lines: [Line], padding: CGFloat = 0, background: ColorToken = Palette.groupedBackground) {
        self.lead = lead
        self.lines = lines
        self.padding = padding
        labels = lines.map { line in
            let label = StyledLabel(style: line.style, color: line.color, alignment: line.centered ? .center : .natural)
            label.string = line.text
            return label
        }
        super.init(frame: .zero)
        backgroundColor = UIColor(background)
        if let lead { addSubview(lead) }
        for label in labels { addSubview(label) }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func layout(size: CGSize) -> CenteredStackLayout {
        var items: [CenteredStackLayout.Item] = []
        if let lead { items.append(.init(.fixed(lead.sizeThatFits(.zero)))) }
        for (line, label) in zip(lines, labels) {
            items.append(.init(label.measurable, spacingBefore: line.spacingBefore, horizontalPadding: line.horizontalPadding))
        }
        return CenteredStackLayout(.init(size: size, padding: padding, items: items))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let frames = layout(size: bounds.size).items
        let views: [UIView] = (lead.map { [$0] } ?? []) + labels
        for (view, frame) in zip(views, frames) { view.setLayoutFrame(frame) }
    }
}

extension ItemGroupView {
    /// ItemGroup.tsx gives every row a divider but the child in the group's
    /// last slot. When that slot is a conditional that rendered nothing,
    /// React still counts it, so the last visible row keeps its divider.
    func keepsLastDivider(_ keeps: Bool) {
        guard keeps else { return }
        for case let row as ItemRowView in rows { row.showsDivider = true }
    }
}

extension ItemRowView {
    /// Item.tsx `titleStyle={{ color }}`. Set after the row is in its group:
    /// the row re-applies its own colour whenever it changes.
    func tintTitle(_ color: ColorToken) {
        titleLabel.color = color
    }

    /// Item.tsx `detailStyle={{ color }}`.
    func tintDetail(_ color: ColorToken) {
        detailLabel.color = color
    }

    /// Item.tsx `subtitleStyle={{ fontFamily: 'Menlo', fontSize }}`.
    func monoSubtitle(_ style: TextStyle) {
        subtitleLabel.style = style
    }
}

/// happy-app's Modal.confirm with its own button titles.
@MainActor
enum DetailAlerts {
    static func confirm(
        _ title: String,
        _ message: String?,
        confirmTitle: String,
        cancelTitle: String = Strings.Common.cancel,
        destructive: Bool,
        on controller: UIViewController
    ) async -> Bool {
        await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: cancelTitle, style: .cancel) { _ in continuation.resume(returning: false) })
            alert.addAction(UIAlertAction(title: confirmTitle, style: destructive ? .destructive : .default) { _ in
                continuation.resume(returning: true)
            })
            controller.present(alert, animated: true)
        }
    }

    /// Modal.prompt: a text field with a default value; nil when cancelled.
    static func prompt(
        _ title: String,
        _ message: String?,
        defaultValue: String,
        placeholder: String?,
        confirmTitle: String,
        on controller: UIViewController
    ) async -> String? {
        await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
            alert.addTextField { field in
                field.text = defaultValue
                field.placeholder = placeholder
            }
            alert.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel) { _ in continuation.resume(returning: nil) })
            alert.addAction(UIAlertAction(title: confirmTitle, style: .default) { [weak alert] _ in
                continuation.resume(returning: alert?.textFields?.first?.text ?? "")
            })
            controller.present(alert, animated: true)
        }
    }
}

/// useHappyAction's alert: the failure's own words, or "Unknown error".
@MainActor
enum DetailActionAlert {
    static func show(_ error: Error, on controller: UIViewController) {
        let message = (error as? SessionDetailActions.Failure)?.message ?? Strings.SessionDetail.unknownError
        Alerts.show(Strings.SessionDetail.actionError, message, on: controller)
    }
}
#endif
