import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The custom server form, from app/(app)/server.tsx. It is the single row
/// of an untitled ItemGroup, so its width is the group's card width.
///
///     SERVER URL                      label, 8 below
///     [ https://…                ]    field, 8 below
///     error / validating…             each 12 below
///     ( Save )                        4 above the column
///     ( Reset to Default )            4 between buttons, 12 below
///     Currently using custom server
public struct ServerFormLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingHorizontal: CGFloat = 16
        public static let paddingVertical: CGFloat = 12
        public static let labelMarginBottom: CGFloat = 8
        public static let fieldPaddingHorizontal: CGFloat = 14
        public static let fieldPaddingVertical: CGFloat = 12
        public static let fieldMinHeight: CGFloat = 44
        public static let fieldCornerRadius: CGFloat = 10
        public static let fieldMarginBottom: CGFloat = 8
        public static let messageMarginBottom: CGFloat = 12
        public static let buttonsMarginTop: CGFloat = 4
        public static let buttonSpacing: CGFloat = 4
        public static let buttonsMarginBottom: CGFloat = 12
    }

    public struct Input {
        public var width: CGFloat
        public var label: Measurable
        /// One line of the field's text style.
        public var fieldLineHeight: CGFloat
        public var error: Measurable?
        public var validating: Measurable?
        public var save: Measurable
        /// Shown only while a custom server is set.
        public var reset: Measurable?
        public var status: Measurable?

        public init(
            width: CGFloat,
            label: Measurable,
            fieldLineHeight: CGFloat,
            error: Measurable? = nil,
            validating: Measurable? = nil,
            save: Measurable,
            reset: Measurable? = nil,
            status: Measurable? = nil
        ) {
            self.width = width
            self.label = label
            self.fieldLineHeight = fieldLineHeight
            self.error = error
            self.validating = validating
            self.save = save
            self.reset = reset
            self.status = status
        }
    }

    public var size: CGSize
    public var label: CGRect
    public var field: CGRect
    public var error: CGRect?
    public var validating: CGRect?
    public var save: CGRect
    public var reset: CGRect?
    public var status: CGRect?

    public static func innerWidth(forWidth width: CGFloat) -> CGFloat {
        max(0, width - Metrics.paddingHorizontal * 2)
    }

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.width)
        let innerWidth = Self.innerWidth(forWidth: width)
        let x = M.paddingHorizontal
        func frame(_ measurable: Measurable, at y: CGFloat) -> CGRect {
            CGRect(x: x, y: y, width: innerWidth, height: measurable.height(fitting: innerWidth))
        }

        var y = M.paddingVertical
        label = frame(input.label, at: y)
        y = label.maxY + M.labelMarginBottom
        field = CGRect(
            x: x,
            y: y,
            width: innerWidth,
            height: max(M.fieldMinHeight, input.fieldLineHeight + M.fieldPaddingVertical * 2)
        )
        y = field.maxY + M.fieldMarginBottom

        error = input.error.map { frame($0, at: y) }
        if let error { y = error.maxY + M.messageMarginBottom }
        validating = input.validating.map { frame($0, at: y) }
        if let validating { y = validating.maxY + M.messageMarginBottom }

        y += M.buttonsMarginTop
        save = frame(input.save, at: y)
        y = save.maxY
        reset = input.reset.map { frame($0, at: y + M.buttonSpacing) }
        if let reset { y = reset.maxY }
        y += M.buttonsMarginBottom

        status = input.status.map { frame($0, at: y) }
        if let status { y = status.maxY }
        size = CGSize(width: width, height: y + M.paddingVertical)
    }
}
