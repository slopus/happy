import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The card at the top of Settings once the account has a name
/// (components/SettingsView.tsx, profile branch): the avatar, the name and
/// the GitHub bio, centred.
///
///     ╭──────────── card, 16 from the edges, 16 from the top ────────────╮
///     │ 24                                                               │
///     │                          ( avatar 90 )                           │
///     │ 12                                                               │
///     │                             Name                                 │
///     │ 4 (8 without a bio)                                              │
///     │                 bio, 16 in from the card's sides                 │
///     │ 8, then 24                                                       │
///     ╰──────────────────────────────────────────────────────────────────╯
public struct SettingsProfileHeaderLayout: Equatable, Sendable {
    public enum Metrics {
        public static let marginTop: CGFloat = 16
        public static let marginHorizontal: CGFloat = 16
        public static let paddingVertical: CGFloat = 24
        public static let avatarSize: CGFloat = 90
        public static let avatarMarginBottom: CGFloat = 12
        public static let nameMarginBottom: CGFloat = 8
        public static let nameMarginBottomWithBio: CGFloat = 4
        public static let bioPaddingHorizontal: CGFloat = 16
        public static let bioMarginBottom: CGFloat = 8
        public static let cornerRadius: CGFloat = 16
    }

    public var size: CGSize
    public var card: CGRect
    /// The rest are in the card's coordinates.
    public var avatar: CGRect
    public var name: CGRect
    public var bio: CGRect?

    public init(width: CGFloat, name: Measurable, bio: Measurable?) {
        typealias M = Metrics
        let width = max(0, width)
        let cardWidth = max(0, width - M.marginHorizontal * 2)
        var y = M.paddingVertical
        avatar = CGRect(x: (cardWidth - M.avatarSize) / 2, y: y, width: M.avatarSize, height: M.avatarSize)
        y = avatar.maxY + M.avatarMarginBottom
        let nameSize = name.size(fitting: cardWidth)
        self.name = CGRect(x: (cardWidth - nameSize.width) / 2, y: y, width: nameSize.width, height: nameSize.height)
        y = self.name.maxY
        if let bio {
            y += M.nameMarginBottomWithBio
            let bioWidth = max(0, cardWidth - M.bioPaddingHorizontal * 2)
            let bioSize = bio.size(fitting: bioWidth)
            self.bio = CGRect(x: (cardWidth - bioSize.width) / 2, y: y, width: bioSize.width, height: bioSize.height)
            y = self.bio!.maxY + M.bioMarginBottom
        } else {
            self.bio = nil
            y += M.nameMarginBottom
        }
        card = CGRect(x: M.marginHorizontal, y: M.marginTop, width: cardWidth, height: y + M.paddingVertical)
        size = CGSize(width: width, height: card.maxY)
    }
}

/// A dropdown's current value in a row's trailing slot
/// (settings/appearance.tsx `dropdownValue`): a preview, the value's name
/// and an up/down chevron, 8 apart, at most 184 wide. The name shrinks
/// first.
public struct DropdownValueLayout: Equatable, Sendable {
    public enum Metrics {
        public static let gap: CGFloat = 8
        public static let maxWidth: CGFloat = 184
        public static let chevronSize: CGFloat = 18
    }

    public var size: CGSize
    public var preview: CGRect
    public var label: CGRect
    public var chevron: CGRect

    public init(preview: CGSize, label: Measurable, chevron: CGSize = CGSize(width: Metrics.chevronSize, height: Metrics.chevronSize)) {
        typealias M = Metrics
        let fixedWidth = preview.width + chevron.width + M.gap * 2
        let text = label.size(fitting: max(0, M.maxWidth - fixedWidth))
        let height = max(preview.height, text.height, chevron.height)
        self.preview = CGRect(x: 0, y: (height - preview.height) / 2, width: preview.width, height: preview.height)
        self.label = CGRect(x: self.preview.maxX + M.gap, y: (height - text.height) / 2, width: text.width, height: text.height)
        self.chevron = CGRect(x: self.label.maxX + M.gap, y: (height - chevron.height) / 2, width: chevron.width, height: chevron.height)
        size = CGSize(width: self.chevron.maxX, height: height)
    }
}

/// One choice under an open dropdown (settings/appearance.tsx
/// `bubbleColorOption`): preview, name, and a checkmark slot that is
/// reserved even when empty so names line up.
///
///     |16| preview |12| name ……………………… |12| ✓ 20 |16|    min 48 tall
public struct OptionRowLayout: Equatable, Sendable {
    public enum Metrics {
        public static let minHeight: CGFloat = 48
        public static let paddingHorizontal: CGFloat = 16
        public static let gap: CGFloat = 12
        public static let checkSize: CGFloat = 20
    }

    public var size: CGSize
    public var preview: CGRect
    public var title: CGRect
    public var check: CGRect

    public init(width: CGFloat, preview: CGSize, title: Measurable) {
        typealias M = Metrics
        let width = max(0, width)
        let titleX = M.paddingHorizontal + preview.width + M.gap
        let titleWidth = max(0, width - titleX - M.gap - M.checkSize - M.paddingHorizontal)
        let titleHeight = title.height(fitting: titleWidth)
        let height = max(M.minHeight, preview.height, titleHeight, M.checkSize)
        self.preview = CGRect(x: M.paddingHorizontal, y: (height - preview.height) / 2, width: preview.width, height: preview.height)
        self.title = CGRect(x: titleX, y: (height - titleHeight) / 2, width: titleWidth, height: titleHeight)
        check = CGRect(x: width - M.paddingHorizontal - M.checkSize, y: (height - M.checkSize) / 2, width: M.checkSize, height: M.checkSize)
        size = CGSize(width: width, height: height)
    }
}

/// The open dropdown's options, stacked with 6 above and below
/// (`bubbleColorDropdown`).
public struct OptionListLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingVertical: CGFloat = 6
    }

    public var size: CGSize
    public var rows: [CGRect]

    public init(width: CGFloat, rows: [Measurable]) {
        let width = max(0, width)
        var y = Metrics.paddingVertical
        var frames: [CGRect] = []
        for row in rows {
            let height = row.height(fitting: width)
            frames.append(CGRect(x: 0, y: y, width: width, height: height))
            y += height
        }
        self.rows = frames
        size = CGSize(width: width, height: y + Metrics.paddingVertical)
    }
}

/// A user-bubble swatch (settings/appearance.tsx `bubblePreview`): a 46×28
/// pill with two short lines flush right, as a message bubble reads from
/// across the room.
public enum BubblePreviewLayout {
    public static let size = CGSize(width: 46, height: 28)
    public static let cornerRadius: CGFloat = 14
    public static let borderWidth: CGFloat = 1
    public static let paddingHorizontal: CGFloat = 9
    public static let lineHeight: CGFloat = 3
    public static let lineGap: CGFloat = 4
    public static let lineWidths: [CGFloat] = [18, 26]

    public static var lines: [CGRect] {
        let stack = CGFloat(lineWidths.count) * lineHeight + CGFloat(lineWidths.count - 1) * lineGap
        var y = (size.height - stack) / 2
        return lineWidths.map { width in
            defer { y += lineHeight + lineGap }
            return CGRect(x: size.width - paddingHorizontal - width, y: y, width: width, height: lineHeight)
        }
    }
}

/// Settings › Connected Accounts › Claude Code (settings/connect/claude.tsx,
/// `OAuthViewUnsupported`): a title, one line of instruction and the
/// command in a terminal card, centred on the screen.
public struct ConnectCommandLayout: Equatable, Sendable {
    public enum Metrics {
        public static let padding: CGFloat = 20
        public static let titleMarginBottom: CGFloat = 20
        public static let bodyMarginBottom: CGFloat = 24
        public static let terminalPadding: CGFloat = 16
        public static let terminalMinWidth: CGFloat = 280
        public static let terminalCornerRadius: CGFloat = 18
    }

    public var title: CGRect
    public var body: CGRect
    public var terminal: CGRect
    /// In the terminal card's coordinates.
    public var command: CGRect

    public init(size: CGSize, safeArea: LayoutInsets, title: Measurable, body: Measurable, command: Measurable) {
        typealias M = Metrics
        let width = max(0, size.width - safeArea.horizontal)
        let inner = max(0, width - M.padding * 2)
        let titleSize = title.size(fitting: inner)
        let bodySize = body.size(fitting: inner)
        let commandSize = command.size(fitting: max(0, inner - M.terminalPadding * 2))
        let terminalWidth = min(inner, max(M.terminalMinWidth, commandSize.width + M.terminalPadding * 2))
        let terminalHeight = commandSize.height + M.terminalPadding * 2
        let height = titleSize.height + M.titleMarginBottom + bodySize.height + M.bodyMarginBottom + terminalHeight

        let available = max(0, size.height - safeArea.vertical - M.padding * 2)
        var y = safeArea.top + M.padding + (available - height) / 2
        func centred(_ size: CGSize) -> CGRect {
            CGRect(x: safeArea.left + (width - size.width) / 2, y: y, width: size.width, height: size.height)
        }
        self.title = centred(titleSize)
        y = self.title.maxY + M.titleMarginBottom
        self.body = centred(bodySize)
        y = self.body.maxY + M.bodyMarginBottom
        terminal = centred(CGSize(width: terminalWidth, height: terminalHeight))
        self.command = CGRect(x: M.terminalPadding, y: M.terminalPadding, width: commandSize.width, height: commandSize.height)
    }
}

/// One What's New card (app/(app)/changelog.tsx `cardContent` with
/// MarkdownView): an optional summary line, then paragraphs and bullet
/// lists. Consecutive bullets form one list, 6 apart, with 8 after it;
/// a paragraph keeps 8 above and 10 below.
public struct ChangelogBodyLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingHorizontal: CGFloat = 16
        public static let paddingTop: CGFloat = 14
        public static let paddingBottom: CGFloat = 6
        public static let summaryMarginBottom: CGFloat = 16
        public static let paragraphMarginTop: CGFloat = 8
        public static let paragraphMarginBottom: CGFloat = 10
        public static let listGap: CGFloat = 6
        public static let listMarginBottom: CGFloat = 8
        public static let bulletMarginRight: CGFloat = 8
        public static let bulletMarginTop: CGFloat = 1
    }

    public struct Item {
        public var text: Measurable
        public var bulleted: Bool

        public init(text: Measurable, bulleted: Bool) {
            self.text = text
            self.bulleted = bulleted
        }
    }

    public var size: CGSize
    public var summary: CGRect?
    /// One per item, in order.
    public var texts: [CGRect]
    /// The bullet glyph beside each bulleted item; nil for paragraphs.
    public var bullets: [CGRect?]

    public init(width: CGFloat, summary: Measurable?, items: [Item], bullet: CGSize) {
        typealias M = Metrics
        let width = max(0, width)
        let inner = max(0, width - M.paddingHorizontal * 2)
        var y = M.paddingTop
        if let summary {
            let height = summary.height(fitting: inner)
            self.summary = CGRect(x: M.paddingHorizontal, y: y, width: inner, height: height)
            y += height + M.summaryMarginBottom
        } else {
            self.summary = nil
        }

        var texts: [CGRect] = []
        var bullets: [CGRect?] = []
        for (index, item) in items.enumerated() {
            if item.bulleted {
                let textX = M.paddingHorizontal + bullet.width + M.bulletMarginRight
                let textWidth = max(0, width - textX - M.paddingHorizontal)
                let height = item.text.height(fitting: textWidth)
                bullets.append(CGRect(x: M.paddingHorizontal, y: y + M.bulletMarginTop, width: bullet.width, height: bullet.height))
                texts.append(CGRect(x: textX, y: y, width: textWidth, height: height))
                y += max(height, M.bulletMarginTop + bullet.height)
                let listContinues = index + 1 < items.count && items[index + 1].bulleted
                y += listContinues ? M.listGap : M.listMarginBottom
            } else {
                y += M.paragraphMarginTop
                let height = item.text.height(fitting: inner)
                bullets.append(nil)
                texts.append(CGRect(x: M.paddingHorizontal, y: y, width: inner, height: height))
                y += height + M.paragraphMarginBottom
            }
        }
        self.texts = texts
        self.bullets = bullets
        size = CGSize(width: width, height: y + M.paddingBottom)
    }
}

/// One What's New release (changelog.tsx's ItemGroup holding `cardContent`):
/// the title over the card, and the card's body, placed together so a plan
/// made off the main thread has every frame. Each text is measured once.
public struct ChangelogEntryLayout: Equatable, Sendable {
    /// The title and the card, in the entry's coordinates.
    public var group: ItemGroupLayout
    /// The summary, texts and bullets, in the card's coordinates.
    public var body: ChangelogBodyLayout

    public var size: CGSize { group.size }

    public init(width: CGFloat, title: Measurable, summary: Measurable?, items: [ChangelogBodyLayout.Item], bullet: CGSize, maxWidth: CGFloat? = nil) {
        let cardWidth = ItemGroupLayout.cardWidth(forWidth: width, maxWidth: maxWidth)
        let body = ChangelogBodyLayout(width: cardWidth, summary: summary, items: items, bullet: bullet)
        self.body = body
        group = ItemGroupLayout(.init(width: width, title: title, rows: [.fixed(body.size)], maxWidth: maxWidth))
    }
}
