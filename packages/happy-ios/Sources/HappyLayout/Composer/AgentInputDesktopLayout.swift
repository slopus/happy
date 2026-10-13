import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// AgentInput.tsx's other composer, in a window wider than 700 points
/// (`compactMobileComposer` false): the flat `unifiedPanel` and its
/// `desktopActionControls`.
///
///     ┌ input.background ──────────────────────────────────── r 16 ┐ 2 top
///     │ 8 [attachments 64, 8 below, 8 in]                        8 │
///     │ 8 2 text (38…120 with its 8 + 8, then scrolls)         8 8 │ input 40+, 4 + 4
///     │ 8 [gear 40] 8 [stop 32] 8 [image 32] ········· 8 [send 32] 8 │ row 40
///     └────────────────────────────────────────────────────────────┘ 8 bottom
///
/// The left group (`actionButtonsLeft`) takes the row less send and clips
/// what it holds. Yoga stretches its children, so the 32-point buttons sit
/// at its top while the 40-point gear sets its height and send is centred
/// on it. In zen mode the group is a spacer and send is all there is.
///
/// Frames are in the panel's bounds; `leftContent` is in `left`'s.
public struct AgentInputDesktopLayout: Equatable, Sendable {
    public enum Metrics {
        /// `unifiedPanel`: radius 16 on iOS, paddingVertical 2 with
        /// paddingBottom 8, paddingHorizontal 8.
        public static let panelRadius: CGFloat = 16
        public static let panelPaddingTop: CGFloat = 2
        public static let panelPaddingBottom: CGFloat = 8
        public static let panelPaddingH: CGFloat = 8

        /// `inputContainer`.
        public static let inputPaddingLeft: CGFloat = 2
        public static let inputPaddingRight: CGFloat = 8
        public static let inputPaddingV: CGFloat = 4
        public static let inputMinHeight: CGFloat = 40
        /// MultiTextInput on native iOS: paddingTop and paddingBottom 8,
        /// line height 22, at most 120.
        public static let textPaddingTop: CGFloat = 8
        public static let textPaddingBottom: CGFloat = 8
        public static let lineHeight: CGFloat = 22
        public static let inputMaxHeight: CGFloat = 120

        /// The gear's NativeSettingsMenu, 40 square.
        public static let settingsSize: CGFloat = 40
        /// Stop and image (`actionButton`): 32 tall, 8 either side of a
        /// 16-point glyph.
        public static let actionHeight: CGFloat = 32
        public static let actionPaddingH: CGFloat = 8
        public static let actionIconSize: CGFloat = 16
        /// `actionButtonsLeft`'s gap.
        public static let actionGap: CGFloat = 8
        /// `sendButton`.
        public static let sendSize: CGFloat = 32
        public static let sendMarginLeft: CGFloat = 8
        public static let sendIconSize: CGFloat = 16
        public static let lockIconSize: CGFloat = 15
        /// A small ActivityIndicator.
        public static let spinnerSize: CGFloat = 20
        /// Stop, image and send: `hitSlop={{ top: 5, bottom: 10 }}`.
        public static let actionHitSlop = LayoutInsets(top: 5, left: 0, bottom: 10, right: 0)
        /// Their Pressable's `opacity: pressed ? 0.7 : 1`.
        public static let pressedOpacity: CGFloat = 0.7
    }

    public struct Input: Equatable, Sendable {
        public var width: CGFloat
        public var attachmentCount: Int
        /// The text view's height for its text, its 8 + 8 padding included.
        public var textContentHeight: CGFloat
        public var hasText: Bool
        /// One line of the text as drawn: 22, times the text size's
        /// multiplier where the composer follows it. The 40 minimum and the
        /// 120 cap stay.
        public var lineHeight: CGFloat
        /// `minHeight` for the input container; nil keeps 40.
        public var inputMinHeight: CGFloat?
        /// The gear (`onPermissionModeChange`).
        public var showsSettings: Bool
        /// Stop (`onAbort`): the width of what it shows, the glyph or, while
        /// it stops, the spinner. Nil hides it.
        public var stopContentWidth: CGFloat?
        /// The image button (`onPickImages`): its glyph's width. Nil hides
        /// it.
        public var imageContentWidth: CGFloat?
        /// AgentInput.tsx `zenMode`: no left group, send stays.
        public var zenMode: Bool

        public init(
            width: CGFloat,
            attachmentCount: Int = 0,
            textContentHeight: CGFloat,
            hasText: Bool,
            lineHeight: CGFloat = Metrics.lineHeight,
            inputMinHeight: CGFloat? = nil,
            showsSettings: Bool = false,
            stopContentWidth: CGFloat? = nil,
            imageContentWidth: CGFloat? = nil,
            zenMode: Bool = false
        ) {
            self.width = width
            self.attachmentCount = attachmentCount
            self.textContentHeight = textContentHeight
            self.hasText = hasText
            self.lineHeight = lineHeight
            self.inputMinHeight = inputMinHeight
            self.showsSettings = showsSettings
            self.stopContentWidth = stopContentWidth
            self.imageContentWidth = imageContentWidth
            self.zenMode = zenMode
        }
    }

    /// The left group's buttons, in its bounds.
    public struct LeftContent: Equatable, Sendable {
        public var settings: CGRect?
        public var stop: CGRect?
        public var image: CGRect?

        public init(settings: CGRect? = nil, stop: CGRect? = nil, image: CGRect? = nil) {
            self.settings = settings
            self.stop = stop
            self.image = image
        }
    }

    public var size: CGSize
    /// The horizontal strip; its thumbnails come from
    /// `AgentInputCardLayout.attachmentThumbnails(count:)`.
    public var attachments: CGRect?
    public var inputContainer: CGRect
    /// The text view, its 8 + 8 padding included.
    public var text: CGRect
    public var textScrolls: Bool
    public var actionRow: CGRect
    /// `actionButtonsLeft`; nil in zen mode.
    public var left: CGRect?
    public var leftContent: LeftContent
    public var send: CGRect

    /// The text view's width at a panel `width`: measure its text there.
    public static func textWidth(panelWidth: CGFloat) -> CGFloat {
        typealias M = Metrics
        return max(0, max(0, panelWidth) - 2 * M.panelPaddingH - M.inputPaddingLeft - M.inputPaddingRight)
    }

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.width)
        let contentX = M.panelPaddingH
        let contentWidth = max(0, width - 2 * M.panelPaddingH)
        var y = M.panelPaddingTop

        if input.attachmentCount > 0 {
            typealias Strip = AgentInputCardLayout.Metrics
            attachments = CGRect(
                x: contentX + Strip.attachmentStripMarginH,
                y: y,
                width: max(0, contentWidth - 2 * Strip.attachmentStripMarginH),
                height: Strip.attachmentSize
            )
            y += Strip.attachmentSize + Strip.attachmentStripMarginBottom
        } else {
            attachments = nil
        }

        let text = MultiTextInputLayout(
            contentHeight: input.textContentHeight,
            hasText: input.hasText,
            maxHeight: M.inputMaxHeight,
            lineHeight: input.lineHeight,
            paddingTop: M.textPaddingTop,
            paddingBottom: M.textPaddingBottom
        )
        let containerHeight = max(input.inputMinHeight ?? M.inputMinHeight, text.height + 2 * M.inputPaddingV)
        inputContainer = CGRect(x: contentX, y: y, width: contentWidth, height: containerHeight)
        self.text = CGRect(
            x: contentX + M.inputPaddingLeft,
            y: y + M.inputPaddingV + (containerHeight - 2 * M.inputPaddingV - text.height) / 2,
            width: Self.textWidth(panelWidth: width),
            height: text.height
        )
        textScrolls = text.scrollEnabled
        y += containerHeight

        // [left, flex 1] 8 [send]; the row is as tall as its tallest.
        var content = LeftContent()
        var leftHeight: CGFloat = 0
        if !input.zenMode {
            var x: CGFloat = 0
            func place(_ width: CGFloat, _ height: CGFloat) -> CGRect {
                // Stretched, but with a height of its own: at the top.
                let frame = CGRect(x: x, y: 0, width: width, height: height)
                x += width + M.actionGap
                leftHeight = max(leftHeight, height)
                return frame
            }
            if input.showsSettings {
                content.settings = place(M.settingsSize, M.settingsSize)
            }
            if let width = input.stopContentWidth {
                content.stop = place(2 * M.actionPaddingH + width, M.actionHeight)
            }
            if let width = input.imageContentWidth {
                content.image = place(2 * M.actionPaddingH + width, M.actionHeight)
            }
        }
        let rowHeight = max(leftHeight, M.sendSize)
        actionRow = CGRect(x: contentX, y: y, width: contentWidth, height: rowHeight)
        send = CGRect(
            x: actionRow.maxX - M.sendSize,
            y: y + (rowHeight - M.sendSize) / 2,
            width: M.sendSize,
            height: M.sendSize
        )
        left = input.zenMode ? nil : CGRect(
            x: contentX,
            y: y + (rowHeight - leftHeight) / 2,
            width: max(0, send.minX - M.sendMarginLeft - contentX),
            height: leftHeight
        )
        leftContent = content
        y += rowHeight + M.panelPaddingBottom
        size = CGSize(width: width, height: y)
    }
}
