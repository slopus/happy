#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

/// What NoSessionsView's content is measured from, read on the main thread
/// as it lays out: its words, the width its content has, the text size and
/// screen scale it is drawn at, and whether it offers the archive. A new
/// value of any of them is measured again; a result for another is refused.
struct NoSessionsMeasureInput: Hashable, Sendable {
    var title: String
    var description: String
    var button: String
    var action: String
    /// The screen's width less its horizontal safe area.
    var width: CGFloat
    var text: TextEnvironment
    var showsArchived: Bool
}

/// NoSessionsView's content as its glyph, labels and buttons measure it,
/// for one input.
struct NoSessionsSizes: Equatable, Sendable {
    var input: NoSessionsMeasureInput
    var icon: CGSize
    var title: CGSize
    var description: CGSize
    /// "Start New Session"'s label, and the button around it.
    var buttonLabel: CGSize
    var buttonHeight: CGFloat
    /// "Show archived"'s label, and the action around it; nil without it.
    var actionLabel: CGSize?
    var action: CGSize?
}

/// Measures NoSessionsView's content off the main thread (AGENTS.md rule
/// 8): the same words, styles and line limits its labels draw, laid out by
/// the same HappyLayout layouts, so nothing on main measures text.
enum NoSessionsMeasure {
    nonisolated static func sizes(_ input: NoSessionsMeasureInput) -> NoSessionsSizes {
        #if DEBUG
        dispatchPrecondition(condition: .notOnQueue(.main))
        #endif
        let environment = input.text
        func text(_ string: String, _ style: TextStyle, lines: Int, alignment: NSTextAlignment) -> Measurable {
            Measurable { width in
                measure(string, style: style, lines: lines, alignment: alignment, environment: environment, width: width)
            }
        }
        let iconSize = NoSessionsLayout.Metrics.iconSize
        let icon = Icon.ionicons("terminal-outline").layout(size: iconSize, scale: environment.displayScale)?.size
            ?? CGSize(width: iconSize, height: iconSize)

        // The button is as wide as the content; its label is whatever its
        // layout measures it at.
        let buttonText = RoundButton.labelText(.large, display: .filled)
        var buttonLabel = CGSize.zero
        let button = RoundButtonLayout(.init(
            width: input.width,
            size: .large,
            display: .filled,
            label: Measurable { width in
                buttonLabel = text(input.button, buttonText.style, lines: buttonText.lines, alignment: buttonText.alignment).size(fitting: width)
                return buttonLabel
            }
        ))

        var actionLabel: CGSize?
        let action: Measurable? = input.showsArchived ? Measurable { width in
            let actionText = TextActionButton.labelText
            return TextActionLayout(width: width, label: Measurable { labelWidth in
                let size = text(input.action, actionText.style, lines: actionText.lines, alignment: actionText.alignment).size(fitting: labelWidth)
                actionLabel = size
                return size
            }).size
        } : nil

        // The layout itself says what width each part is measured at.
        let measured = NoSessionsLayout(.init(
            size: CGSize(width: input.width, height: 0),
            safeArea: .zero,
            icon: icon,
            title: text(input.title, NoSessionsView.titleText.style, lines: NoSessionsView.titleText.lines, alignment: NoSessionsView.titleText.alignment),
            description: text(
                input.description,
                NoSessionsView.descriptionText.style,
                lines: NoSessionsView.descriptionText.lines,
                alignment: NoSessionsView.descriptionText.alignment
            ),
            buttonHeight: button.size.height,
            action: action
        ))
        return NoSessionsSizes(
            input: input,
            icon: icon,
            title: measured.title.size,
            description: measured.description.size,
            buttonLabel: buttonLabel,
            buttonHeight: button.size.height,
            actionLabel: actionLabel,
            action: measured.action?.size
        )
    }

    /// `string` as a StyledLabel of `style`, `lines` and `alignment` draws
    /// it at `environment`'s text size: TextKit 1 with no line padding,
    /// wrapping (or cut short at `lines`) at `width`, the used box rounded
    /// up to the screen's pixels as a label's size is.
    nonisolated static func measure(
        _ string: String,
        style: TextStyle,
        lines: Int,
        alignment: NSTextAlignment,
        environment: TextEnvironment,
        width: CGFloat
    ) -> CGSize {
        guard !string.isEmpty else { return .zero }
        let scaled = style.scaled(environment.scale)
        let lineBreak: NSLineBreakMode = lines == 0 ? .byWordWrapping : .byTruncatingTail
        var attributes = scaled.attributes(color: .black, alignment: alignment, lineBreakMode: lineBreak)
        attributes[.font] = style.font(in: environment)
        let storage = NSTextStorage(string: scaled.uppercase ? string.uppercased() : string, attributes: attributes)
        let manager = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: max(0, width), height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.maximumNumberOfLines = lines
        if lines > 0 { container.lineBreakMode = .byTruncatingTail }
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        manager.ensureLayout(for: container)
        let used = manager.usedRect(for: container)
        let scale = environment.displayScale
        func pixels(_ value: CGFloat) -> CGFloat {
            scale > 0 ? (value * scale).rounded(.up) / scale : value.rounded(.up)
        }
        return CGSize(width: pixels(used.width), height: pixels(used.height))
    }
}
#endif
