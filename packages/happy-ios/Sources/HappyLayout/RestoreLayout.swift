import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Restore by QR: the other phone scans the code shown here. From
/// app/(app)/restore/index.tsx: a centred column of instruction, menu path,
/// the QR on a white frame (or a placeholder while the keypair is made) and
/// a text action to use the secret key instead.
public struct RestoreQRLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingHorizontal: CGFloat = 32
        public static let paddingVertical: CGFloat = 24
        public static let instructionMarginBottom: CGFloat = 8
        public static let pathMarginBottom: CGFloat = 32
        public static let qrSize: CGFloat = 260
        public static let qrFramePadding: CGFloat = 12
        public static let qrCornerRadius: CGFloat = 16
        public static let buttonMaxWidth: CGFloat = 280
        public static let buttonMarginTop: CGFloat = 32
    }

    public struct Input {
        public var size: CGSize
        public var safeArea: LayoutInsets
        public var instruction: Measurable
        public var path: Measurable
        /// The QR code is ready; until then a same-size placeholder shows.
        public var showsCode: Bool
        public var button: Measurable

        public init(size: CGSize, safeArea: LayoutInsets, instruction: Measurable, path: Measurable, showsCode: Bool, button: Measurable) {
            self.size = size
            self.safeArea = safeArea
            self.instruction = instruction
            self.path = path
            self.showsCode = showsCode
            self.button = button
        }
    }

    /// Everything below is in the scroll view's content coordinates; the
    /// scroll view fills the screen.
    public var contentSize: CGSize
    public var instruction: CGRect
    public var path: CGRect
    /// The white frame around the code, or the placeholder.
    public var codeContainer: CGRect
    /// The code itself; nil while the placeholder shows.
    public var code: CGRect?
    public var button: CGRect

    public static func innerWidth(size: CGSize, safeArea: LayoutInsets) -> CGFloat {
        max(0, size.width - safeArea.horizontal - Metrics.paddingHorizontal * 2)
    }

    public static func buttonWidth(size: CGSize, safeArea: LayoutInsets) -> CGFloat {
        min(Metrics.buttonMaxWidth, innerWidth(size: size, safeArea: safeArea))
    }

    public init(_ input: Input) {
        typealias M = Metrics
        let insets = input.safeArea
        let innerWidth = Self.innerWidth(size: input.size, safeArea: insets)
        let innerX = insets.left + M.paddingHorizontal

        let instructionHeight = input.instruction.height(fitting: innerWidth)
        let pathHeight = input.path.height(fitting: innerWidth)
        let containerSide: CGFloat
        let codeSide: CGFloat
        if input.showsCode {
            codeSide = max(0, min(M.qrSize, innerWidth - M.qrFramePadding * 2))
            containerSide = codeSide + M.qrFramePadding * 2
        } else {
            codeSide = max(0, min(M.qrSize, innerWidth))
            containerSide = codeSide
        }
        let buttonWidth = Self.buttonWidth(size: input.size, safeArea: insets)
        let buttonHeight = input.button.height(fitting: buttonWidth)

        let columnHeight = instructionHeight + M.instructionMarginBottom + pathHeight + M.pathMarginBottom
            + containerSide + M.buttonMarginTop + buttonHeight
        let visibleHeight = max(0, input.size.height - insets.vertical)
        let free = max(0, visibleHeight - M.paddingVertical * 2 - columnHeight)

        var y = insets.top + M.paddingVertical + free / 2
        instruction = CGRect(x: innerX, y: y, width: innerWidth, height: instructionHeight)
        y = instruction.maxY + M.instructionMarginBottom
        path = CGRect(x: innerX, y: y, width: innerWidth, height: pathHeight)
        y = path.maxY + M.pathMarginBottom
        codeContainer = CGRect(x: innerX + (innerWidth - containerSide) / 2, y: y, width: containerSide, height: containerSide)
        code = input.showsCode
            ? codeContainer.insetBy(dx: M.qrFramePadding, dy: M.qrFramePadding)
            : nil
        y = codeContainer.maxY + M.buttonMarginTop
        button = CGRect(x: innerX + (innerWidth - buttonWidth) / 2, y: y, width: buttonWidth, height: buttonHeight)
        contentSize = CGSize(
            width: input.size.width,
            height: max(input.size.height, button.maxY + M.paddingVertical + insets.bottom)
        )
    }
}

/// Restore with the secret key, from app/(app)/restore/manual.tsx: an
/// instruction, a multi-line monospace field and the Restore button. The
/// screen keeps the field above the keyboard by shrinking the scroll view.
public struct RestoreSecretKeyLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingHorizontal: CGFloat = 24
        public static let paddingVertical: CGFloat = 24
        public static let instructionMarginBottom: CGFloat = 20
        public static let fieldPadding: CGFloat = 16
        public static let fieldMinHeight: CGFloat = 120
        public static let fieldCornerRadius: CGFloat = 12
        public static let fieldMarginBottom: CGFloat = 24
    }

    public struct Input {
        public var size: CGSize
        public var safeArea: LayoutInsets
        /// How far the keyboard overlaps the screen from the bottom.
        public var keyboardOverlap: CGFloat
        public var instruction: Measurable
        /// The typed text at the field's text width.
        public var fieldText: Measurable
        public var button: Measurable

        public init(size: CGSize, safeArea: LayoutInsets, keyboardOverlap: CGFloat = 0, instruction: Measurable, fieldText: Measurable, button: Measurable) {
            self.size = size
            self.safeArea = safeArea
            self.keyboardOverlap = keyboardOverlap
            self.instruction = instruction
            self.fieldText = fieldText
            self.button = button
        }
    }

    /// The scroll view, in the screen's coordinates.
    public var scroll: CGRect
    public var contentSize: CGSize
    /// The rest are in the scroll view's content coordinates.
    public var instruction: CGRect
    public var field: CGRect
    public var button: CGRect

    public static func innerWidth(size: CGSize, safeArea: LayoutInsets) -> CGFloat {
        max(0, size.width - safeArea.horizontal - Metrics.paddingHorizontal * 2)
    }

    /// The width the field's text wraps at, inside its padding.
    public static func fieldTextWidth(size: CGSize, safeArea: LayoutInsets) -> CGFloat {
        max(0, innerWidth(size: size, safeArea: safeArea) - Metrics.fieldPadding * 2)
    }

    public init(_ input: Input) {
        typealias M = Metrics
        let insets = input.safeArea
        let overlap = min(max(0, input.keyboardOverlap), input.size.height)
        scroll = CGRect(x: 0, y: 0, width: input.size.width, height: input.size.height - overlap)
        // The keyboard covers the home indicator, so its inset no longer
        // applies once the keyboard is up.
        let bottomInset = max(0, insets.bottom - overlap)

        let innerWidth = Self.innerWidth(size: input.size, safeArea: insets)
        let innerX = insets.left + M.paddingHorizontal
        var y = insets.top + M.paddingVertical
        instruction = CGRect(x: innerX, y: y, width: innerWidth, height: input.instruction.height(fitting: innerWidth))
        y = instruction.maxY + M.instructionMarginBottom
        let textHeight = input.fieldText.height(fitting: Self.fieldTextWidth(size: input.size, safeArea: insets))
        field = CGRect(x: innerX, y: y, width: innerWidth, height: max(M.fieldMinHeight, textHeight + M.fieldPadding * 2))
        y = field.maxY + M.fieldMarginBottom
        button = CGRect(x: innerX, y: y, width: innerWidth, height: input.button.height(fitting: innerWidth))
        contentSize = CGSize(width: input.size.width, height: button.maxY + M.paddingVertical + bottomInset)
    }
}
