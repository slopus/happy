import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// agentInputLayout.ts: the compact mobile composer's metric contract. Home's
// dock and the chat composer render different controls, but their shell,
// input and action geometry are these numbers. `AgentInputLayout` turns them
// into frames.

/// `MOBILE_COMPOSER_METRICS`.
public struct MobileComposerMetrics: Equatable, Sendable {
    public var shellRadius: CGFloat
    public var shellInset: CGFloat
    public var shellPaddingTop: CGFloat
    public var shellPaddingBottom: CGFloat
    public var inputMinHeight: CGFloat
    public var inputMaxHeight: CGFloat
    public var inputFontSize: CGFloat
    public var inputLineHeight: CGFloat
    public var inputPaddingTop: CGFloat
    public var inputPaddingBottom: CGFloat
    public var actionRowHeight: CGFloat
    public var actionSize: CGFloat
    public var addIconSize: CGFloat
    public var secondaryActionHeight: CGFloat
    public var effortWidth: CGFloat
    public var primaryActionSize: CGFloat
    public var primaryActionMarginLeft: CGFloat
    public var attachmentExtraHeight: CGFloat

    public init(
        shellRadius: CGFloat,
        shellInset: CGFloat,
        shellPaddingTop: CGFloat,
        shellPaddingBottom: CGFloat,
        inputMinHeight: CGFloat,
        inputMaxHeight: CGFloat,
        inputFontSize: CGFloat,
        inputLineHeight: CGFloat,
        inputPaddingTop: CGFloat,
        inputPaddingBottom: CGFloat,
        actionRowHeight: CGFloat,
        actionSize: CGFloat,
        addIconSize: CGFloat,
        secondaryActionHeight: CGFloat,
        effortWidth: CGFloat,
        primaryActionSize: CGFloat,
        primaryActionMarginLeft: CGFloat,
        attachmentExtraHeight: CGFloat
    ) {
        self.shellRadius = shellRadius
        self.shellInset = shellInset
        self.shellPaddingTop = shellPaddingTop
        self.shellPaddingBottom = shellPaddingBottom
        self.inputMinHeight = inputMinHeight
        self.inputMaxHeight = inputMaxHeight
        self.inputFontSize = inputFontSize
        self.inputLineHeight = inputLineHeight
        self.inputPaddingTop = inputPaddingTop
        self.inputPaddingBottom = inputPaddingBottom
        self.actionRowHeight = actionRowHeight
        self.actionSize = actionSize
        self.addIconSize = addIconSize
        self.secondaryActionHeight = secondaryActionHeight
        self.effortWidth = effortWidth
        self.primaryActionSize = primaryActionSize
        self.primaryActionMarginLeft = primaryActionMarginLeft
        self.attachmentExtraHeight = attachmentExtraHeight
    }

    public static let mobile = MobileComposerMetrics(
        shellRadius: 30,
        shellInset: 10,
        shellPaddingTop: 8,
        shellPaddingBottom: 8,
        inputMinHeight: 44,
        inputMaxHeight: 120,
        inputFontSize: 16,
        inputLineHeight: 22,
        inputPaddingTop: 4,
        inputPaddingBottom: 4,
        actionRowHeight: 42,
        actionSize: 42,
        addIconSize: 26,
        secondaryActionHeight: 40,
        effortWidth: 64,
        primaryActionSize: 42,
        primaryActionMarginLeft: 8,
        // The photos 18 down instead of the 8 the text starts at, 64, 8 below.
        attachmentExtraHeight: 82
    )

    /// `MOBILE_COMPOSER_BASE_HEIGHT`: an empty one-line composer.
    public var baseHeight: CGFloat {
        shellPaddingTop + inputMinHeight + actionRowHeight + shellPaddingBottom
    }

    /// `MOBILE_COMPOSER_CHROME_HEIGHT`: everything but the input.
    public var chromeHeight: CGFloat {
        baseHeight - inputMinHeight
    }

    /// `resolveMobileComposerHeight`: the shell's height around an input
    /// `inputHeight` tall (its own padding included).
    public func composerHeight(inputHeight: CGFloat, hasAttachments: Bool = false) -> CGFloat {
        let inputContainerHeight = max(inputMinHeight, inputHeight + inputPaddingTop + inputPaddingBottom)
        return chromeHeight + inputContainerHeight + (hasAttachments ? attachmentExtraHeight : 0)
    }
}

/// `AgentInputLayout`: where the text starts, from the leading add glyph.
public struct AgentInputInsets: Equatable, Sendable {
    public var shellInset: CGFloat
    public var addGlyphOffset: CGFloat
    public var textInset: CGFloat
    public var inputContainerPaddingLeft: CGFloat
    public var inputContainerPaddingRight: CGFloat

    /// `resolveAgentInputLayout`: the text's left edge lines up with the add
    /// glyph's, not with the button around it.
    public init(shellInset: CGFloat, actionSize: CGFloat, addIconSize: CGFloat) {
        let addGlyphOffset = (actionSize - addIconSize) / 2
        self.shellInset = shellInset
        self.addGlyphOffset = addGlyphOffset
        self.textInset = shellInset + addGlyphOffset
        self.inputContainerPaddingLeft = addGlyphOffset
        self.inputContainerPaddingRight = addGlyphOffset
    }

    /// `MOBILE_COMPOSER_LAYOUT`.
    public static let mobile = AgentInputInsets(
        shellInset: MobileComposerMetrics.mobile.shellInset,
        actionSize: MobileComposerMetrics.mobile.actionSize,
        addIconSize: MobileComposerMetrics.mobile.addIconSize
    )
}

/// `MobileCollapsedComposerGeometry`: Home's collapsed one-line capsule.
public struct MobileCollapsedComposerGeometry: Equatable, Sendable {
    public var shellHeight: CGFloat
    public var shellRadius: CGFloat
    public var contentPaddingLeft: CGFloat
    public var contentPaddingRight: CGFloat
    public var inputPaddingLeft: CGFloat
    public var inputPaddingRight: CGFloat
    public var textInset: CGFloat

    /// `resolveMobileCollapsedComposerGeometry`: the text starts where the
    /// capsule's rounded end meets its straight edge.
    public init(shellHeight: CGFloat = 56, contentPaddingHorizontal: CGFloat = 7, inputPaddingRight: CGFloat = 4) {
        let shellRadius = shellHeight / 2
        let inputPaddingLeft = shellRadius - contentPaddingHorizontal
        self.shellHeight = shellHeight
        self.shellRadius = shellRadius
        self.contentPaddingLeft = contentPaddingHorizontal
        self.contentPaddingRight = contentPaddingHorizontal
        self.inputPaddingLeft = inputPaddingLeft
        self.inputPaddingRight = inputPaddingRight
        self.textInset = contentPaddingHorizontal + inputPaddingLeft
    }
}

/// `MobileComposerGeometryStyle`: the subset of a React Native style the
/// composer's geometry resolvers return. Absent fields are nil, as they are
/// absent from the RN object.
public struct ComposerGeometryStyle: Equatable, Sendable {
    public enum Dimension: Equatable, Sendable {
        case points(CGFloat)
        case fill
    }

    public enum Align: String, Equatable, Sendable {
        case center
        case flexStart = "flex-start"
        case flexEnd = "flex-end"
    }

    public var width: Dimension?
    public var height: Dimension?
    public var minWidth: CGFloat?
    public var flex: CGFloat?
    public var flexShrink: CGFloat?
    /// Always `row` when set.
    public var flexDirectionRow: Bool?
    public var alignItems: Align?
    public var justifyContent: Align?
    /// Always `hidden` when set.
    public var overflowHidden: Bool?
    public var borderRadius: CGFloat?
    public var paddingLeft: CGFloat?
    public var paddingRight: CGFloat?
    public var paddingHorizontal: CGFloat?
    public var gap: CGFloat?
    public var marginLeft: CGFloat?

    public init(
        width: Dimension? = nil, height: Dimension? = nil, minWidth: CGFloat? = nil, flex: CGFloat? = nil,
        flexShrink: CGFloat? = nil, flexDirectionRow: Bool? = nil, alignItems: Align? = nil,
        justifyContent: Align? = nil, overflowHidden: Bool? = nil, borderRadius: CGFloat? = nil,
        paddingLeft: CGFloat? = nil, paddingRight: CGFloat? = nil, paddingHorizontal: CGFloat? = nil,
        gap: CGFloat? = nil, marginLeft: CGFloat? = nil
    ) {
        self.width = width
        self.height = height
        self.minWidth = minWidth
        self.flex = flex
        self.flexShrink = flexShrink
        self.flexDirectionRow = flexDirectionRow
        self.alignItems = alignItems
        self.justifyContent = justifyContent
        self.overflowHidden = overflowHidden
        self.borderRadius = borderRadius
        self.paddingLeft = paddingLeft
        self.paddingRight = paddingRight
        self.paddingHorizontal = paddingHorizontal
        self.gap = gap
        self.marginLeft = marginLeft
    }

    /// The left padding Yoga applies (`paddingLeft` beats `paddingHorizontal`).
    public var resolvedPaddingLeft: CGFloat { paddingLeft ?? paddingHorizontal ?? 0 }
    public var resolvedPaddingRight: CGFloat { paddingRight ?? paddingHorizontal ?? 0 }
}

/// `MobileComposerMenuGeometry`: a native menu's host frame and the label
/// inside it. The frame never carries padding; the label does.
public struct ComposerMenuGeometry: Equatable, Sendable {
    public var frame: ComposerGeometryStyle
    public var content: ComposerGeometryStyle
}

/// The composer's controls (`MobileComposerMenuVariant` and the two
/// circular actions).
public enum ComposerControl: Sendable {
    case icon
    case model
    case effort
    case permission
}

extension MobileComposerMetrics {
    /// `resolveMobileComposerMenuGeometry`.
    public func menuGeometry(_ variant: ComposerControl) -> ComposerMenuGeometry {
        switch variant {
        case .icon:
            return ComposerMenuGeometry(
                frame: ComposerGeometryStyle(width: .points(actionSize), height: .points(actionSize), flexShrink: 0),
                content: ComposerGeometryStyle(width: .fill, height: .fill, alignItems: .center, justifyContent: .center)
            )
        case .permission:
            // Anchors the left of the row and never shrinks: always one word,
            // padded tight against the add button so the model name gets the
            // width.
            return ComposerMenuGeometry(
                frame: ComposerGeometryStyle(height: .points(secondaryActionHeight), flexShrink: 0),
                content: ComposerGeometryStyle(
                    height: .points(secondaryActionHeight), flexDirectionRow: true, alignItems: .center,
                    justifyContent: .center, borderRadius: secondaryActionHeight / 2, paddingLeft: 4, paddingRight: 8
                )
            )
        case .model:
            // Only the model shrinks; its slack sits on the outside (left).
            return ComposerMenuGeometry(
                frame: ComposerGeometryStyle(height: .points(secondaryActionHeight), minWidth: 0, flexShrink: 1),
                content: ComposerGeometryStyle(
                    height: .points(secondaryActionHeight), minWidth: 0, flexDirectionRow: true, alignItems: .center,
                    justifyContent: .flexEnd, borderRadius: secondaryActionHeight / 2, paddingLeft: 12, paddingRight: 4,
                    gap: 7
                )
            )
        case .effort:
            // Reserves the widest level's width so switching never reflows the
            // row; sits close to send.
            return ComposerMenuGeometry(
                frame: ComposerGeometryStyle(height: .points(secondaryActionHeight), minWidth: effortWidth, flexShrink: 0),
                content: ComposerGeometryStyle(
                    height: .points(secondaryActionHeight), minWidth: 0, flexDirectionRow: true, alignItems: .center,
                    justifyContent: .flexStart, borderRadius: secondaryActionHeight / 2, paddingLeft: 4, paddingRight: 6,
                    gap: 4
                )
            )
        }
    }

    /// `resolveMobileComposerActionRowGeometry`.
    public var actionRowGeometry: ComposerGeometryStyle {
        ComposerGeometryStyle(
            height: .points(actionRowHeight), flexDirectionRow: true, alignItems: .center,
            justifyContent: .flexStart, paddingHorizontal: 0, gap: 2
        )
    }

    /// `resolveMobileComposerMiddleGeometry`: the box between add and send
    /// that holds every chip. It is the row's only flexible child, so it gets
    /// exactly what the two buttons leave and cuts anything wider at its edge.
    public var middleGeometry: ComposerGeometryStyle {
        ComposerGeometryStyle(
            height: .points(actionRowHeight), minWidth: 0, flex: 1, flexDirectionRow: true, alignItems: .center,
            justifyContent: .flexStart, overflowHidden: true, gap: 2
        )
    }

    /// `resolveMobileComposerActionGeometry`: the add button (`icon`) and
    /// send (`primary`).
    public func actionGeometry(primary: Bool) -> ComposerGeometryStyle {
        let size = primary ? primaryActionSize : actionSize
        return ComposerGeometryStyle(
            width: .points(size), height: .points(size), flexShrink: 0, alignItems: .center,
            justifyContent: .center, borderRadius: size / 2, marginLeft: primary ? primaryActionMarginLeft : nil
        )
    }
}
