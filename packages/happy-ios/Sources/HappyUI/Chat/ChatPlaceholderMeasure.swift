#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// What the chat's placeholder says, read on the main thread when it is
/// shown (its words are the screens'): the glyph, PendingChatPlaceholder's
/// title, the lines under it with their styles and margins, and where
/// EmptyMessages' status sits.
struct ChatPlaceholderModel: Equatable, Sendable {
    struct Glyph: Equatable, Sendable {
        var icon: Icon
        var size: CGFloat
    }

    struct Line: Equatable, Sendable {
        var text: String
        var style: ChatTextStyle
        var color: ColorToken
        /// 0: as many as it takes.
        var maxLines = 0
        /// The space above it (the previous line's `marginBottom`) and its
        /// own `paddingHorizontal`.
        var spacing: CGFloat
        var padding: CGFloat
    }

    /// EmptyMessages' status among the lines: Retry or Load more, or the
    /// paging spinner without a `button`.
    struct Status: Equatable, Sendable {
        var index: Int
        var spacing: CGFloat
        var button: String?
    }

    /// The spinner alone, while the session loads.
    var loading = false
    var icon: Glyph?
    /// PendingChatPlaceholder's shimmering title.
    var title: String?
    var lines: [Line] = []
    var status: Status?
    /// The first load's Retry, alone in the middle.
    var button: String?

    @MainActor
    init(_ content: ChatPlaceholderView.Content) {
        switch content {
        case .loading:
            loading = true
        case .loadFailed:
            button = Strings.Chat.retry
        case .empty(let state, let paging):
            icon = Glyph(icon: .ionicons(state.osIcon), size: 72)
            // EmptyMessages' margins: each line sits the previous line's
            // marginBottom below it (icon 12, host 4, path 40, status 8).
            var spacing: CGFloat = 12
            if let host = state.host {
                lines.append(Line(text: host, style: ChatTextStyles.emptyHost, color: Palette.text, spacing: spacing, padding: 48))
                spacing = 4
            }
            if let path = state.path {
                lines.append(Line(text: path, style: ChatTextStyles.emptyPath, color: Palette.textSecondary, spacing: spacing, padding: 48))
                spacing = 40
            }
            // The title and the spinner keep 8 under them; RoundButton
            // has no margin.
            var createdSpacing: CGFloat = 8
            switch paging {
            case .noMessages:
                lines.append(Line(text: Strings.Chat.noMessages, style: ChatTextStyles.emptyTitle, color: Palette.textSecondary, spacing: spacing, padding: 48))
            case .loading:
                status = Status(index: lines.count, spacing: spacing)
            case .error, .loadMore:
                status = Status(index: lines.count, spacing: spacing, button: paging == .error ? Strings.Chat.retry : Strings.Chat.loadMore)
                createdSpacing = 0
            }
            lines.append(Line(
                text: Strings.Chat.created(Strings.Chat.age(state.created)), style: ChatTextStyles.emptyCreated, color: Palette.textSecondary,
                spacing: createdSpacing, padding: 48
            ))
        case .pendingChat(let model):
            icon = Glyph(icon: .ionicons("chatbubbles-outline"), size: 64)
            title = Strings.Chat.startingChat
            switch model.detail {
            case .queued(let text)?:
                lines.append(Line(text: text, style: ChatTextStyles.pendingQueued, color: Palette.text, maxLines: 6, spacing: 10, padding: 48))
            case .path(let path)?:
                lines.append(Line(text: path, style: ChatTextStyles.emptyPath, color: Palette.textSecondary, maxLines: 1, spacing: 6, padding: 48))
            case nil:
                break
            }
        case .deleted:
            icon = Glyph(icon: .ionicons("trash-outline"), size: 48)
            lines.append(Line(text: Strings.SessionDetail.sessionDeleted, style: ChatTextStyles.deletedTitle, color: Palette.text, spacing: 16, padding: 0))
            lines.append(Line(
                text: Strings.SessionDetail.sessionDeletedDescription, style: ChatTextStyles.deletedBody, color: Palette.textSecondary,
                spacing: 8, padding: 32
            ))
        }
    }
}

/// What the placeholder is measured from, read on main as it lays out: what
/// it says, its frame's width, the text size and screen scale it is drawn
/// at, and the paging spinner's size. A plan for any other is refused. Its
/// height only centres the column, so a new height (the keyboard moving
/// the dock) measures nothing.
struct ChatPlaceholderInput: Equatable, Sendable {
    var model: ChatPlaceholderModel
    var width: CGFloat
    var text: TextEnvironment
    var spinner: CGSize
}

/// The placeholder's parts measured at its width: the glyph's box, the
/// title's, the lines laid out, and the status's (the first load's Retry
/// when there is nothing else).
struct ChatPlaceholderPlan: Sendable {
    var icon: CGSize?
    var title: CGSize?
    var lines: [ChatTextLayout] = []
    var status: CGSize?
    /// The button's label, measured for the button's width.
    var buttonLabel: CGSize?

    /// Where each part goes in a frame of `size` (`ChatPlaceholderLayout`).
    /// Measures nothing.
    func layout(_ model: ChatPlaceholderModel, size: CGSize) -> ChatPlaceholderLayout {
        if model.button != nil {
            return ChatPlaceholderLayout(size: size, button: status ?? .zero)
        }
        var placed: ChatPlaceholderLayout.Status?
        if let place = model.status, let status {
            placed = ChatPlaceholderLayout.Status(index: place.index, size: status, spacing: place.spacing)
        }
        return ChatPlaceholderLayout(
            size: size, icon: icon, title: title,
            lines: zip(model.lines, lines).map { ChatPlaceholderLayout.Line(size: $1.size, spacing: $0.spacing, padding: $0.padding) },
            status: placed
        )
    }
}

/// Measures the placeholder off the main thread (AGENTS.md rule 8): its
/// lines through TextKit at the text size, "Starting a new chat…" and the
/// button's label as their StyledLabels measure (`NoSessionsMeasure`), and
/// the glyph's box, each at the width its padding leaves it.
enum ChatPlaceholderMeasure {
    nonisolated static func plan(_ input: ChatPlaceholderInput) -> ChatPlaceholderPlan {
        #if DEBUG
        dispatchPrecondition(condition: .notOnQueue(.main))
        #endif
        let model = input.model
        let environment = input.text
        var plan = ChatPlaceholderPlan()
        guard !model.loading else { return plan }
        func width(_ padding: CGFloat) -> CGFloat { max(0, input.width - padding * 2) }
        let padding = ChatPlaceholderLayout.Metrics.padding

        func button(_ title: String, width: CGFloat) -> (size: CGSize, label: CGSize) {
            let text = RoundButton.labelText(.small, display: .inverted)
            var label = CGSize.zero
            let size = RoundButtonLayout(.init(width: width, size: .small, display: .inverted, label: Measurable { labelWidth in
                label = NoSessionsMeasure.measure(title, style: text.style, lines: text.lines, alignment: text.alignment, environment: environment, width: labelWidth)
                return label
            })).size
            return (size, label)
        }
        if let title = model.button {
            (plan.status, plan.buttonLabel) = button(title, width: input.width)
            return plan
        }

        plan.icon = model.icon.map { glyph in
            glyph.icon.layout(size: glyph.size, scale: environment.displayScale)?.size ?? CGSize(width: glyph.size, height: glyph.size)
        }
        plan.title = model.title.map { title in
            NoSessionsMeasure.measure(title, style: TextStyles.pendingChatTitle, lines: 1, alignment: .natural, environment: environment, width: width(padding))
        }
        plan.lines = model.lines.map { line in
            let text = MeasuredText(line.style.string(
                line.text, color: line.color, alignment: .center,
                lineBreakMode: line.maxLines > 0 ? .byTruncatingTail : .byWordWrapping, in: environment
            ), maxLines: line.maxLines)
            // Drawn in a frame hugging it, so laid out at its own width:
            // centred in the width it was measured at, it would sit off
            // to the right.
            let measured = text.layout(width: width(line.padding))
            return text.layout(for: CGRect(origin: .zero, size: measured.size))
        }
        if let status = model.status {
            if let title = status.button {
                (plan.status, plan.buttonLabel) = button(title, width: width(padding))
            } else {
                plan.status = input.spinner
            }
        }
        return plan
    }
}
#endif
