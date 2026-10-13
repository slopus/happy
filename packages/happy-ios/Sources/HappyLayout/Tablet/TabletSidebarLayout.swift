import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The sidebar (SidebarView.tsx): one column inside a hairline border, on
/// the grouped background.
///
///     (status bar + header row, where the persistent header's controls are)
///     |16| [✎ New session              ] |8| [▣] |16|     8 above, 4 below
///     +--------------------------------------------+
///     |  the session list, or its empty state      |
///     +--------------------------------------------+
///     |16| ⚙ |10| Settings                          |     hairline on top
///
///   - The border takes its hairline inside the box, as React Native's
///     borders do, so everything sits one hairline in.
///   - New session stretches; its hairline frame, rounded 10, holds a 16pt
///     glyph and the label, padded 10 by 14, 8 apart.
///   - The 40pt archive button shows only when there is an archive.
///   - The two share a row and centre in it.
///   - The settings row sits on the sidebar's bottom edge. Nothing pads it
///     above the home indicator, as in happy-app.
public struct TabletSidebarLayout: Equatable, Sendable {
    public enum Metrics {
        public static let controlsMarginHorizontal: CGFloat = 16
        public static let controlsMarginTop: CGFloat = 8
        public static let controlsMarginBottom: CGFloat = 4
        public static let controlsGap: CGFloat = 8
        public static let newSessionPaddingVertical: CGFloat = 10
        public static let newSessionPaddingHorizontal: CGFloat = 14
        public static let newSessionGap: CGFloat = 8
        public static let newSessionIconSize: CGFloat = 16
        public static let buttonRadius: CGFloat = 10
        public static let archiveButtonSize: CGFloat = 40
        public static let archiveIconSize: CGFloat = 18
        public static let settingsPaddingHorizontal: CGFloat = 16
        public static let settingsPaddingVertical: CGFloat = 14
        public static let settingsGap: CGFloat = 10
        public static let settingsIconSize: CGFloat = 18
        /// SessionsList.tsx's default `bottomContentInset`, under the
        /// home indicator's inset.
        public static let listBottomInset: CGFloat = 128
    }

    public struct Input {
        public var size: CGSize
        public var safeTop: CGFloat
        public var safeBottom: CGFloat
        /// `DeviceCalculations.headerHeight`.
        public var headerHeight: CGFloat
        /// One device pixel (`StyleSheet.hairlineWidth`).
        public var hairline: CGFloat
        /// create-outline at 16: its RN box (`Icon.layout`).
        public var newSessionIcon: CGSize
        public var newSessionTitle: Measurable
        /// The archive glyph's box at 18; nil when there is no archive and
        /// so no button.
        public var archiveIcon: CGSize?
        /// settings-outline at 18.
        public var settingsIcon: CGSize
        public var settingsTitle: Measurable
        /// The small activity indicator.
        public var spinner: CGSize

        public init(
            size: CGSize,
            safeTop: CGFloat,
            safeBottom: CGFloat,
            headerHeight: CGFloat,
            hairline: CGFloat,
            newSessionIcon: CGSize,
            newSessionTitle: Measurable,
            archiveIcon: CGSize?,
            settingsIcon: CGSize,
            settingsTitle: Measurable,
            spinner: CGSize
        ) {
            self.size = size
            self.safeTop = safeTop
            self.safeBottom = safeBottom
            self.headerHeight = headerHeight
            self.hairline = hairline
            self.newSessionIcon = newSessionIcon
            self.newSessionTitle = newSessionTitle
            self.archiveIcon = archiveIcon
            self.settingsIcon = settingsIcon
            self.settingsTitle = settingsTitle
            self.spinner = spinner
        }
    }

    public var newSessionButton: CGRect
    public var newSessionIcon: CGRect
    public var newSessionTitle: CGRect
    public var archiveButton: CGRect?
    public var archiveIcon: CGRect?
    /// The list, or what stands in for it (MainView.tsx's sidebar variant).
    public var content: CGRect
    /// The list's bottom padding: `safeArea.bottom + 128`. It has none on
    /// top.
    public var listBottomInset: CGFloat
    /// The loading spinner, centred in `content`.
    public var spinner: CGRect
    public var settingsRow: CGRect
    /// The row's top border.
    public var settingsDivider: CGRect
    public var settingsIcon: CGRect
    public var settingsTitle: CGRect

    public init(_ input: Input) {
        typealias M = Metrics
        let hairline = input.hairline
        let width = max(0, input.size.width)
        let height = max(0, input.size.height)
        let innerWidth = max(0, width - 2 * hairline)

        // The controls row.
        let rowX = hairline + M.controlsMarginHorizontal
        let rowWidth = max(0, innerWidth - 2 * M.controlsMarginHorizontal)
        let rowY = hairline + input.safeTop + input.headerHeight + M.controlsMarginTop
        let archiveWidth = input.archiveIcon == nil ? 0 : M.archiveButtonSize + M.controlsGap
        let buttonWidth = max(0, rowWidth - archiveWidth)
        let buttonInner = max(0, buttonWidth - 2 * hairline - 2 * M.newSessionPaddingHorizontal)
        let icon = input.newSessionIcon
        let title = input.newSessionTitle.size(fitting: max(0, buttonInner - icon.width - M.newSessionGap))
        let buttonContent = max(icon.height, title.height)
        let buttonHeight = 2 * hairline + 2 * M.newSessionPaddingVertical + buttonContent
        let rowHeight = max(buttonHeight, input.archiveIcon == nil ? 0 : M.archiveButtonSize)

        newSessionButton = CGRect(x: rowX, y: rowY + (rowHeight - buttonHeight) / 2, width: buttonWidth, height: buttonHeight)
        let buttonContentY = newSessionButton.minY + hairline + M.newSessionPaddingVertical
        newSessionIcon = CGRect(
            x: newSessionButton.minX + hairline + M.newSessionPaddingHorizontal,
            y: buttonContentY + (buttonContent - icon.height) / 2,
            width: icon.width,
            height: icon.height
        )
        newSessionTitle = CGRect(
            x: newSessionIcon.maxX + M.newSessionGap,
            y: buttonContentY + (buttonContent - title.height) / 2,
            width: title.width,
            height: title.height
        )
        if let archive = input.archiveIcon {
            let button = CGRect(
                x: rowX + rowWidth - M.archiveButtonSize,
                y: rowY + (rowHeight - M.archiveButtonSize) / 2,
                width: M.archiveButtonSize,
                height: M.archiveButtonSize
            )
            archiveButton = button
            archiveIcon = CGRect(
                x: button.minX + (M.archiveButtonSize - archive.width) / 2,
                y: button.minY + (M.archiveButtonSize - archive.height) / 2,
                width: archive.width,
                height: archive.height
            )
        } else {
            archiveButton = nil
            archiveIcon = nil
        }

        // The settings row, on the bottom edge.
        let settingsIcon = input.settingsIcon
        let settingsText = input.settingsTitle.size(
            fitting: max(0, innerWidth - 2 * M.settingsPaddingHorizontal - settingsIcon.width - M.settingsGap)
        )
        let settingsContent = max(settingsIcon.height, settingsText.height)
        let settingsHeight = hairline + 2 * M.settingsPaddingVertical + settingsContent
        settingsRow = CGRect(x: hairline, y: height - hairline - settingsHeight, width: innerWidth, height: settingsHeight)
        settingsDivider = CGRect(x: settingsRow.minX, y: settingsRow.minY, width: innerWidth, height: hairline)
        let settingsContentY = settingsRow.minY + hairline + M.settingsPaddingVertical
        self.settingsIcon = CGRect(
            x: settingsRow.minX + M.settingsPaddingHorizontal,
            y: settingsContentY + (settingsContent - settingsIcon.height) / 2,
            width: settingsIcon.width,
            height: settingsIcon.height
        )
        settingsTitle = CGRect(
            x: self.settingsIcon.maxX + M.settingsGap,
            y: settingsContentY + (settingsContent - settingsText.height) / 2,
            width: settingsText.width,
            height: settingsText.height
        )

        let contentY = rowY + rowHeight + M.controlsMarginBottom
        content = CGRect(x: hairline, y: contentY, width: innerWidth, height: max(0, settingsRow.minY - contentY))
        listBottomInset = input.safeBottom + M.listBottomInset
        spinner = CGRect(
            x: content.midX - input.spinner.width / 2,
            y: content.midY - input.spinner.height / 2,
            width: input.spinner.width,
            height: input.spinner.height
        )
    }
}

/// EmptySessionsTablet.tsx: the sidebar's stand-in for a list with nothing
/// in it. One centred column, 48 in from each side:
///
///         (64pt glyph)            24
///     No sessions yet             20pt, 8
///     Start a new session on …    16pt, 24
///     [ + Start New Session ]     only with a reachable or offline computer
///
/// The button hugs its glyph and label (padding 12 by 24, 8 between) but
/// never outgrows the column; the label wraps first.
public struct TabletEmptySessionsLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingHorizontal: CGFloat = 48
        public static let iconSize: CGFloat = 64
        public static let iconMarginBottom: CGFloat = 24
        public static let titleMarginBottom: CGFloat = 8
        public static let descriptionMarginBottom: CGFloat = 24
        public static let buttonPaddingHorizontal: CGFloat = 24
        public static let buttonPaddingVertical: CGFloat = 12
        public static let buttonRadius: CGFloat = 12
        public static let buttonIconSize: CGFloat = 20
        public static let buttonIconGap: CGFloat = 8
    }

    public struct Button {
        /// The glyph's RN box at 20.
        public var icon: CGSize
        public var title: Measurable

        public init(icon: CGSize, title: Measurable) {
            self.icon = icon
            self.title = title
        }
    }

    public struct Input {
        public var size: CGSize
        /// The 64pt glyph's RN box.
        public var icon: CGSize
        public var title: Measurable
        public var description: Measurable
        public var button: Button?

        public init(size: CGSize, icon: CGSize, title: Measurable, description: Measurable, button: Button?) {
            self.size = size
            self.icon = icon
            self.title = title
            self.description = description
            self.button = button
        }
    }

    public var icon: CGRect
    public var title: CGRect
    public var description: CGRect
    public var button: CGRect?
    public var buttonIcon: CGRect?
    public var buttonTitle: CGRect?

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.size.width)
        let column = max(0, width - 2 * M.paddingHorizontal)
        let titleSize = input.title.size(fitting: column)
        let descriptionSize = input.description.size(fitting: column)

        var buttonSize: CGSize?
        var buttonText = CGSize.zero
        var buttonContent: CGFloat = 0
        if let button = input.button {
            buttonText = button.title.size(fitting: max(0, column - 2 * M.buttonPaddingHorizontal - button.icon.width - M.buttonIconGap))
            buttonContent = max(button.icon.height, buttonText.height)
            buttonSize = CGSize(
                width: min(column, 2 * M.buttonPaddingHorizontal + button.icon.width + M.buttonIconGap + buttonText.width),
                height: 2 * M.buttonPaddingVertical + buttonContent
            )
        }

        let total = input.icon.height + M.iconMarginBottom + titleSize.height + M.titleMarginBottom
            + descriptionSize.height + M.descriptionMarginBottom + (buttonSize?.height ?? 0)
        var y = (input.size.height - total) / 2
        icon = .centered(input.icon, inWidth: width, y: y)
        y += input.icon.height + M.iconMarginBottom
        title = .centered(titleSize, inWidth: width, y: y)
        y += titleSize.height + M.titleMarginBottom
        description = .centered(descriptionSize, inWidth: width, y: y)
        y += descriptionSize.height + M.descriptionMarginBottom

        if let buttonSize, let glyph = input.button?.icon {
            let frame = CGRect.centered(buttonSize, inWidth: width, y: y)
            button = frame
            let contentY = frame.minY + M.buttonPaddingVertical
            let iconFrame = CGRect(
                x: frame.minX + M.buttonPaddingHorizontal,
                y: contentY + (buttonContent - glyph.height) / 2,
                width: glyph.width,
                height: glyph.height
            )
            buttonIcon = iconFrame
            buttonTitle = CGRect(
                x: iconFrame.maxX + M.buttonIconGap,
                y: contentY + (buttonContent - buttonText.height) / 2,
                width: buttonText.width,
                height: buttonText.height
            )
        } else {
            button = nil
            buttonIcon = nil
            buttonTitle = nil
        }
    }
}
