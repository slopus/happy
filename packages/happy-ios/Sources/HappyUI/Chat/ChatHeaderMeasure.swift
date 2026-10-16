#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

// The chat's header and the CLI warning under it, measured off the main
// thread (AGENTS.md rule 8) at the text size their traits say: what they
// say is read on main, a background task lays their text out, and the view
// draws the plan for what it asked last (`OffMainPlan`).

/// What ChatHeaderView says, read on main as it is updated: `title ||
/// subtitle` heading it, the workspace or branch line, and the line changes.
struct ChatHeaderTitleModel: Equatable, Sendable {
    var heading: String
    var subtitle: String?
    var changes: GitLineChanges?
}

/// GitLineChanges in the header, "≈ +12 -3": each part laid out on one
/// line, and where it goes (`GitChangesLayout`). The parts never shrink.
struct ChatGitChangesPlan: Sendable {
    var layout: GitChangesLayout
    var approximate: ChatTextLayout?
    var added: ChatTextLayout?
    var removed: ChatTextLayout?

    /// GitChangesView's parts in the project list's styles, as the header
    /// had them, at `environment`'s text size. Safe off main.
    nonisolated static func plan(_ changes: GitLineChanges, in environment: TextEnvironment) -> ChatGitChangesPlan {
        func part(_ text: String, _ style: TextStyle, _ color: ColorToken) -> ChatTextLayout {
            ChatTextLayout(unwrapped: ChatTextStyle(style).string(text, color: color, in: environment))
        }
        let approximate = changes.approximate ? part("≈", TextStyles.gitApproximate, Palette.textSecondary) : nil
        let added = changes.insertions > 0 ? part("+" + GitLineChanges.compact(changes.insertions), TextStyles.gitLineCount, Palette.gitAddedText) : nil
        let removed = changes.deletions > 0 ? part("-" + GitLineChanges.compact(changes.deletions), TextStyles.gitLineCount, Palette.gitRemovedText) : nil
        return ChatGitChangesPlan(
            layout: GitChangesLayout(approximate: approximate?.size, added: added?.size, removed: removed?.size),
            approximate: approximate, added: added, removed: removed
        )
    }
}

/// What the phone's capsule is measured from: what it says, the widest it
/// may be (`maxWidth`, or what the bar handed over when that is less) and
/// the text size and screen it is drawn at.
struct ChatHeaderTitleInput: Equatable, Sendable {
    var model: ChatHeaderTitleModel
    var width: CGFloat
    var text: TextEnvironment
}

/// The capsule laid out (`ChatHeaderTitleLayout`, its frames in the
/// capsule's space) with its text.
struct ChatHeaderTitlePlan: Sendable {
    var layout: ChatHeaderTitleLayout
    var title: ChatTextLayout
    var subtitle: ChatTextLayout?
    var changes: ChatGitChangesPlan?
}

/// What the tablet's plain header is measured from: what it says, what its
/// column has across (`ChatPlainHeaderLayout.textWidth`), and the text
/// size and screen.
struct ChatPlainHeaderInput: Equatable, Sendable {
    var model: ChatHeaderTitleModel
    var width: CGFloat
    var text: TextEnvironment
}

/// The plain header's text measured at its column's width; where it goes
/// is worked out on main from these sizes (`ChatPlainHeaderLayout`), which
/// depends on where the bar put the title view.
struct ChatPlainHeaderPlan: Sendable {
    var title: ChatTextLayout
    var subtitle: ChatTextLayout?
    var changes: ChatGitChangesPlan?
}

/// What the CLI warning is measured from: its words, the screen's width,
/// the text size and screen.
struct ChatCliWarningInput: Equatable, Sendable {
    var label: String
    var width: CGFloat
    var text: TextEnvironment
}

enum ChatHeaderMeasure {
    nonisolated static func title(_ input: ChatHeaderTitleInput) -> ChatHeaderTitlePlan {
        #if DEBUG
        dispatchPrecondition(condition: .notOnQueue(.main))
        #endif
        let environment = input.text
        let model = input.model
        let title = MeasuredText(
            ChatTextStyles.headerTitle.string(model.heading, color: Palette.headerTint, alignment: .center, lineBreakMode: .byTruncatingTail, in: environment),
            maxLines: 1
        )
        let subtitle = model.subtitle.map {
            MeasuredText(ChatTextStyles.headerSubtitle.string($0, color: Palette.headerGlassSubtitle, lineBreakMode: .byTruncatingTail, in: environment), maxLines: 1)
        }
        let changes = model.changes.map { ChatGitChangesPlan.plan($0, in: environment) }
        let layout = ChatHeaderTitleLayout(maxWidth: input.width, title: title.measurable, subtitle: subtitle?.measurable, changes: changes?.layout.size)
        return ChatHeaderTitlePlan(
            layout: layout,
            title: title.layout(for: layout.title),
            subtitle: layout.subtitle.flatMap { frame in subtitle?.layout(for: frame) },
            changes: changes
        )
    }

    nonisolated static func plain(_ input: ChatPlainHeaderInput) -> ChatPlainHeaderPlan {
        #if DEBUG
        dispatchPrecondition(condition: .notOnQueue(.main))
        #endif
        let environment = input.text
        let model = input.model
        let changes = model.changes.map { ChatGitChangesPlan.plan($0, in: environment) }
        let title = MeasuredText(
            ChatTextStyles.headerTitle.string(model.heading, color: Palette.headerTint, lineBreakMode: .byTruncatingTail, in: environment),
            maxLines: 1
        )
        let subtitle = model.subtitle.map {
            MeasuredText(ChatTextStyles.headerPlainSubtitle.string($0, color: Palette.textSecondary, lineBreakMode: .byTruncatingTail, in: environment), maxLines: 1)
        }
        let subtitleWidth = ChatPlainHeaderLayout.subtitleWidth(textWidth: input.width, changes: changes?.layout.size)
        return ChatPlainHeaderPlan(
            title: title.layout(width: input.width),
            subtitle: subtitle?.layout(width: subtitleWidth),
            changes: changes
        )
    }

    /// The warning's label laid out where `CliWarningPillLayout` puts it.
    nonisolated static func cliWarning(_ input: ChatCliWarningInput) -> ChatTextLayout {
        #if DEBUG
        dispatchPrecondition(condition: .notOnQueue(.main))
        #endif
        let label = MeasuredText(ChatTextStyles.cliWarning.string(input.label, color: Palette.cliWarningText, in: input.text), maxLines: 1)
        let layout = CliWarningPillLayout(width: input.width, top: 0, label: label.measurable)
        return label.layout(for: layout.label)
    }
}
#endif
