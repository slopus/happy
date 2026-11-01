#if canImport(UIKit)
import HappyLayout
import UIKit

/// Home's bar at the foot of the iPad's sidebar (`SidebarBottomBarLayout`):
/// settings at the bottom left in a glass circle, and compose at the
/// bottom right as the column's prominent action, a pill in the app's
/// primary (`Palette.roundButtonFill`, the send button's: black on light,
/// light on dark) that says what it starts. The phone keeps compose in its
/// toolbar and settings in the header.
///
/// The list scrolls under it with iOS 26's soft edge at its foot, as it
/// does under a toolbar (`follow`).
@MainActor
final class SidebarBottomBar: UIView {
    let settings = UIButton(configuration: .glass())
    let compose = UIButton(configuration: .prominentGlass())
    /// Nothing can be started from here: settings alone.
    var showsCompose = true {
        didSet {
            compose.isHidden = !showsCompose
            superview?.setNeedsLayout()
        }
    }
    private var edge: UIInteraction?

    init(composeTitle: String, onSettings: @escaping () -> Void, onCompose: @escaping () -> Void) {
        super.init(frame: .zero)
        settings.configuration?.image = .icon(.ionicons("settings-outline"), size: 22)
        settings.configuration?.cornerStyle = .capsule
        settings.tintColor = UIColor(Palette.headerTint)
        settings.accessibilityLabel = Strings.openSettings
        settings.accessibilityIdentifier = "settings"
        settings.addAction(UIAction { _ in onSettings() }, for: .primaryActionTriggered)

        compose.configuration?.image = .composeIcon(size: 20)
        compose.configuration?.title = composeTitle
        compose.configuration?.imagePadding = 8
        compose.configuration?.cornerStyle = .capsule
        compose.configuration?.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 20)
        compose.configuration?.baseForegroundColor = UIColor(Palette.roundButtonText)
        compose.configuration?.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Fonts.ui(.semiBold, size: 16)
            return attributes
        }
        compose.tintColor = UIColor(Palette.roundButtonFill)
        compose.accessibilityLabel = composeTitle
        compose.accessibilityIdentifier = "compose"
        compose.addAction(UIAction { _ in onCompose() }, for: .primaryActionTriggered)
        addSubview(settings)
        addSubview(compose)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// The bar's frames in a sidebar of `size` and `safeArea`.
    func layout(size: CGSize, safeArea: LayoutInsets) -> SidebarBottomBarLayout {
        let width = showsCompose ? compose.sizeThatFits(CGSize(width: size.width, height: SidebarBottomBarLayout.Metrics.height)).width : nil
        return SidebarBottomBarLayout(size: size, safeArea: safeArea, composeWidth: width)
    }

    /// Lays the bar over its whole host and its controls where `layout` says.
    func apply(_ layout: SidebarBottomBarLayout, in bounds: CGRect) {
        setLayoutFrame(bounds)
        settings.setLayoutFrame(layout.settings)
        compose.setLayoutFrame(layout.compose ?? .zero)
    }

    /// The list under the bar, whose foot iOS 26 shades softly under it.
    func follow(_ scrollView: UIScrollView?) {
        if let edge { removeInteraction(edge) }
        edge = nil
        guard let scrollView else { return }
        let interaction = UIScrollEdgeElementContainerInteraction()
        interaction.scrollView = scrollView
        interaction.edge = .bottom
        addInteraction(interaction)
        edge = interaction
    }

    /// The bar covers its host only to place its controls: touches
    /// anywhere else go to the list.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        subviews.contains { !$0.isHidden && $0.frame.contains(point) }
    }
}

/// Home's search as the iPad's sidebar has it (`SidebarSearchLayout`): a
/// field at the top of the list, scrolling with it, and Cancel beside it
/// while search is open. Searching does on home exactly what the phone's
/// bar field does (`onBegin`, `onChange`, `onEnd`).
@MainActor
final class SidebarSearchField: UIView, UITextFieldDelegate {
    let field = UISearchTextField()
    let cancel = UIButton(configuration: .plain())
    private(set) var isActive = false
    var query: String { field.text ?? "" }
    var onBegin: (() -> Void)?
    var onChange: ((String) -> Void)?
    var onEnd: (() -> Void)?
    /// Cancel coming or going: the host lays the field out again.
    var onLayoutChange: (() -> Void)?

    init(placeholder: String) {
        super.init(frame: .zero)
        field.placeholder = placeholder
        field.font = Fonts.ui(.regular, size: 16)
        field.backgroundColor = UIColor(Palette.groupedCard)
        field.borderStyle = .none
        field.layer.cornerRadius = SidebarSearchLayout.Metrics.height / 2
        field.layer.cornerCurve = .continuous
        field.clipsToBounds = true
        field.returnKeyType = .search
        field.delegate = self
        field.accessibilityIdentifier = "search-field"
        field.addAction(UIAction { [weak self] _ in self?.changed() }, for: .editingChanged)
        cancel.configuration?.title = Strings.Common.cancel
        cancel.configuration?.contentInsets = .zero
        cancel.configuration?.baseForegroundColor = UIColor(Palette.headerTint)
        cancel.configuration?.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = Fonts.ui(.medium, size: 16)
            return attributes
        }
        cancel.accessibilityIdentifier = "search-cancel"
        cancel.isHidden = true
        cancel.addAction(UIAction { [weak self] _ in self?.end() }, for: .primaryActionTriggered)
        addSubview(field)
        addSubview(cancel)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Cancel's width while search is open, nil while it is closed.
    var cancelWidth: CGFloat? {
        isActive ? cancel.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: SidebarSearchLayout.Metrics.height)).width : nil
    }

    /// Places the field and Cancel where `layout` says, in the host's
    /// coordinates; the view itself covers only them.
    func apply(_ layout: SidebarSearchLayout) {
        let frame = layout.cancel.map { layout.field.union($0) } ?? layout.field
        setLayoutFrame(frame)
        field.setLayoutFrame(layout.field.offsetBy(dx: -frame.minX, dy: -frame.minY))
        cancel.setLayoutFrame((layout.cancel ?? .zero).offsetBy(dx: -frame.minX, dy: -frame.minY))
        alpha = layout.alpha
        isUserInteractionEnabled = layout.alpha > 0.5
    }

    func textFieldDidBeginEditing(_ textField: UITextField) {
        guard !isActive else { return }
        isActive = true
        cancel.isHidden = false
        onBegin?()
        onLayoutChange?()
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return false
    }

    private func changed() {
        guard isActive else { return }
        onChange?(query)
    }

    /// Search closes: the query goes and home is as it was.
    func end() {
        guard isActive else { return }
        isActive = false
        field.text = ""
        field.resignFirstResponder()
        cancel.isHidden = true
        onEnd?()
        onLayoutChange?()
    }
}
#endif
