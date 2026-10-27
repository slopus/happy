#if canImport(UIKit)
import HappyLayout
import UIKit

/// A conversation's name in its header's capsule, which opens its detail
/// (`onOpen`). Given `onRename`, a tap turns it into a field where it
/// stands, as the sidebar's rows do:
/// Return, the keyboard going or the screen closing keeps the new name,
/// Escape the old one. The name shows at once; the store takes it back if
/// the computer refuses it.
@MainActor
final class StemCellChatTitleView: UIView {
    private let label = UILabel()
    private var field: StemCellsRenameField?
    /// What the field started with, so a name arriving mid-edit isn't
    /// taken for the person's.
    private var initial = ""

    /// Given the new name; nil where the name can't be changed.
    var onRename: ((String) -> Void)? {
        didSet { updateAccessibility() }
    }

    /// In the header: what activating it does instead of renaming.
    var onOpen: (() -> Void)? {
        didSet { updateAccessibility() }
    }

    var text = "" {
        didSet {
            guard text != oldValue else { return }
            label.text = text
            updateAccessibility()
            resize()
        }
    }

    /// What the field starts with: empty for work nobody named yet.
    var editableText: String?

    /// The widest the name may be.
    var maxWidth: CGFloat = .greatestFiniteMagnitude {
        didSet { if maxWidth != oldValue { resize() } }
    }

    var isEditing: Bool { field != nil }

    init() {
        super.init(frame: .zero)
        let attributes = AppCoordinator.nativeTitleAttributes
        label.font = attributes[.font] as? UIFont
        label.textColor = attributes[.foregroundColor] as? UIColor
        label.textAlignment = .center
        label.lineBreakMode = .byTruncatingTail
        addSubview(label)
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(beginEditing)))
        isAccessibilityElement = true
        accessibilityIdentifier = "stem-chat-title"
        updateAccessibility()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    private var layout: StemCellChatTitleLayout {
        let textWidth = label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: StemCellChatTitleLayout.height)).width
        return StemCellChatTitleLayout(textWidth: textWidth, maxWidth: maxWidth, editing: field != nil)
    }

    override var intrinsicContentSize: CGSize { layout.size }

    override func sizeThatFits(_ size: CGSize) -> CGSize { layout.size }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout
        label.frame = layout.text
        field?.frame = layout.text
    }

    private func resize() {
        let size = layout.size
        invalidateIntrinsicContentSize()
        setNeedsLayout()
        // The header places the name and its capsule, editing or not.
        superview?.setNeedsLayout()
        guard frame.size != size else { return }
        frame.size = size
    }

    private func updateAccessibility() {
        accessibilityLabel = text
        accessibilityTraits = onRename == nil && onOpen == nil ? .header : [.header, .button]
        accessibilityHint = onOpen != nil ? Strings.StemCells.detailsHint : onRename == nil ? nil : Strings.StemCells.renameHint
    }

    override func accessibilityActivate() -> Bool {
        if let onOpen {
            onOpen()
            return true
        }
        guard onRename != nil else { return false }
        beginEditing()
        return true
    }

    @objc func beginEditing() {
        guard onRename != nil, field == nil else { return }
        let field = StemCellsRenameField()
        field.font = label.font
        field.textColor = label.textColor
        field.tintColor = UIColor(Palette.stemCellsSettingsPrimary)
        field.textAlignment = .center
        initial = editableText ?? text
        field.text = initial
        field.returnKeyType = .done
        field.autocapitalizationType = .sentences
        field.accessibilityIdentifier = "stem-chat-title-field"
        field.onFinish = { [weak self] kept in self?.finish(kept) }
        addSubview(field)
        self.field = field
        label.isHidden = true
        isAccessibilityElement = false
        resize()
        superview?.layoutIfNeeded()
        layoutIfNeeded()
        // Mid-transition the field can't take the keyboard: back to the name.
        guard field.becomeFirstResponder() else { finish(nil); return }
        field.selectAll(nil)
    }

    /// Ends editing the way Return does: what was typed is kept.
    func finishEditing() {
        guard let field else { return }
        if field.isFirstResponder {
            field.resignFirstResponder()
        } else {
            finish(field.text)
        }
    }

    private func finish(_ kept: String?) {
        guard let field else { return }
        self.field = nil
        field.onFinish = nil
        field.removeFromSuperview()
        label.isHidden = false
        isAccessibilityElement = true
        let name = kept?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let renamed = !name.isEmpty && name != initial
        if renamed {
            // Shown before the store publishes it back.
            editableText = name
            text = name
        }
        resize()
        guard renamed else { return }
        StemCellsHaptics.play(.renamed)
        onRename?(name)
    }
}
#endif
