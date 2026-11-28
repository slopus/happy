import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A personal bot's settings page, in Settings' glass style
/// (`SettingsLayout`), scrolling under the navigation bar:
///
///           [picture]          ← a bot's rounded square; a tap picks one
///          Change Photo
///     NAME
///     ┌────────────────────┐
///     │ Release helper     │
///     └────────────────────┘
///     INSTRUCTIONS
///     ┌────────────────────┐
///     │ Many lines, the    │   ← grows with what is typed, never less
///     │ card as tall as    │     than `minInstructions`
///     │ they are.          │
///     └────────────────────┘
///     What saving does, or what stops it.
///
/// Frames are in the page's content space, `width` wide.
public struct BotSettingsLayout: Equatable, Sendable {
    public enum Metrics {
        public static let top: CGFloat = 24
        public static let avatar: CGFloat = 96
        /// A bot's picture is a rounded square, as its home row draws it.
        public static let avatarRadius: CGFloat = 21
        public static let captionGap: CGFloat = 8
        public static let captionHeight: CGFloat = 22
        public static let sectionsTop: CGFloat = 28
        public static let side: CGFloat = SettingsLayout.Metrics.side
        public static let radius: CGFloat = SettingsLayout.Metrics.radius
        public static let cardGap: CGFloat = SettingsLayout.Metrics.cardGap
        public static let headingHeight: CGFloat = SessionDetailLayout.Metrics.headingHeight
        public static let headingGap: CGFloat = SessionDetailLayout.Metrics.headingGap
        public static let headingInset: CGFloat = SessionDetailLayout.Metrics.headingInset
        public static let field: CGFloat = SettingsLayout.Metrics.row
        /// The text's inset in its card: across, and down from the top.
        public static let textInset: CGFloat = 16
        public static let textPadding: CGFloat = SettingsLayout.Metrics.textPadding
        public static let minInstructions: CGFloat = 160
        public static let noteGap: CGFloat = SettingsLayout.Metrics.footerGap
        public static let bottom: CGFloat = SettingsLayout.Metrics.bottom
    }

    public var avatar: CGRect
    public var photoButton: CGRect
    public var nameHeading: CGRect
    public var nameCard: CGRect
    public var nameText: CGRect
    public var instructionsHeading: CGRect
    public var instructionsCard: CGRect
    public var instructionsText: CGRect
    /// Nil when it says nothing.
    public var note: CGRect?
    public var contentHeight: CGFloat

    /// How wide the instructions' text is at `width`: what it is measured at.
    public static func instructionsTextWidth(width: CGFloat) -> CGFloat {
        max(0, width - 2 * Metrics.side - 2 * Metrics.textInset)
    }

    /// How wide the note under the instructions is at `width`.
    public static func noteWidth(width: CGFloat) -> CGFloat {
        max(0, width - 2 * (Metrics.side + Metrics.headingInset))
    }

    /// `captionWidth`: Change Photo's title; `instructionsHeight`: the
    /// text measured at `instructionsTextWidth`; `noteHeight`: the line
    /// under it, 0 for none.
    public init(width: CGFloat, captionWidth: CGFloat, instructionsHeight: CGFloat, noteHeight: CGFloat) {
        typealias M = Metrics
        avatar = CGRect(x: ((width - M.avatar) / 2).rounded(), y: M.top, width: M.avatar, height: M.avatar)
        let caption = min(ceil(captionWidth), width)
        photoButton = CGRect(x: ((width - caption) / 2).rounded(), y: avatar.maxY + M.captionGap, width: caption, height: M.captionHeight)
        let cardWidth = max(0, width - 2 * M.side)
        let headingWidth = max(0, width - 2 * (M.side + M.headingInset))
        let textWidth = Self.instructionsTextWidth(width: width)
        nameHeading = CGRect(x: M.side + M.headingInset, y: photoButton.maxY + M.sectionsTop, width: headingWidth, height: M.headingHeight)
        nameCard = CGRect(x: M.side, y: nameHeading.maxY + M.headingGap, width: cardWidth, height: M.field)
        nameText = CGRect(x: nameCard.minX + M.textInset, y: nameCard.minY, width: textWidth, height: M.field)
        instructionsHeading = CGRect(x: nameHeading.minX, y: nameCard.maxY + M.cardGap, width: headingWidth, height: M.headingHeight)
        let text = max(ceil(instructionsHeight), M.minInstructions - 2 * M.textPadding)
        instructionsCard = CGRect(x: M.side, y: instructionsHeading.maxY + M.headingGap, width: cardWidth, height: text + 2 * M.textPadding)
        instructionsText = CGRect(x: instructionsCard.minX + M.textInset, y: instructionsCard.minY + M.textPadding, width: textWidth, height: text)
        if noteHeight > 0 {
            let note = CGRect(x: nameHeading.minX, y: instructionsCard.maxY + M.noteGap, width: headingWidth, height: ceil(noteHeight))
            self.note = note
            contentHeight = note.maxY + M.bottom
        } else {
            note = nil
            contentHeight = instructionsCard.maxY + M.bottom
        }
    }
}
