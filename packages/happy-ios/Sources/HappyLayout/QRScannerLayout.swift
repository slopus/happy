import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The full-screen camera scanner. happy-app hands this to the system
/// scanner; here it is our own AVFoundation screen: the preview fills the
/// screen, a square viewfinder is cut out of a dimmed overlay, a hint sits
/// under it and a close button in the top-left corner. Without camera access
/// the screen shows a message and a button instead of the viewfinder.
public struct QRScannerLayout: Equatable, Sendable {
    public enum Metrics {
        public static let viewfinderMaxSide: CGFloat = 280
        /// Least room kept beside the viewfinder.
        public static let viewfinderMinMargin: CGFloat = 48
        /// Room kept above and below for the close button and the hint.
        public static let viewfinderMinVerticalMargin: CGFloat = 120
        public static let viewfinderCornerRadius: CGFloat = 20
        public static let hintMarginTop: CGFloat = 24
        public static let textPaddingHorizontal: CGFloat = 32
        public static let closeButtonSize: CGFloat = 44
        public static let closeButtonMargin: CGFloat = 8
        public static let messageButtonSpacing: CGFloat = 24
        public static let messageButtonMaxWidth: CGFloat = 280
    }

    public enum Mode {
        case scanning(hint: Measurable)
        case message(text: Measurable, button: Measurable)
    }

    public struct Input {
        public var size: CGSize
        public var safeArea: LayoutInsets
        public var mode: Mode

        public init(size: CGSize, safeArea: LayoutInsets, mode: Mode) {
            self.size = size
            self.safeArea = safeArea
            self.mode = mode
        }
    }

    /// The camera preview and dimming overlay: the whole screen.
    public var preview: CGRect
    public var close: CGRect
    public var viewfinder: CGRect?
    public var hint: CGRect?
    public var message: CGRect?
    public var button: CGRect?

    public static func textWidth(size: CGSize, safeArea: LayoutInsets) -> CGFloat {
        max(0, size.width - safeArea.horizontal - Metrics.textPaddingHorizontal * 2)
    }

    public static func buttonWidth(size: CGSize, safeArea: LayoutInsets) -> CGFloat {
        min(Metrics.messageButtonMaxWidth, textWidth(size: size, safeArea: safeArea))
    }

    public init(_ input: Input) {
        typealias M = Metrics
        let size = input.size
        let insets = input.safeArea
        preview = CGRect(origin: .zero, size: size)
        close = CGRect(
            x: insets.left + M.closeButtonMargin,
            y: insets.top + M.closeButtonMargin,
            width: M.closeButtonSize,
            height: M.closeButtonSize
        )

        let safe = CGRect(
            x: insets.left,
            y: insets.top,
            width: max(0, size.width - insets.horizontal),
            height: max(0, size.height - insets.vertical)
        )
        let textWidth = Self.textWidth(size: size, safeArea: insets)
        let textX = insets.left + M.textPaddingHorizontal

        switch input.mode {
        case .scanning(let hint):
            let side = max(0, min(
                M.viewfinderMaxSide,
                safe.width - M.viewfinderMinMargin * 2,
                safe.height - M.viewfinderMinVerticalMargin * 2
            ))
            let finder = CGRect(x: safe.midX - side / 2, y: safe.midY - side / 2, width: side, height: side)
            viewfinder = finder
            self.hint = CGRect(x: textX, y: finder.maxY + M.hintMarginTop, width: textWidth, height: hint.height(fitting: textWidth))
            message = nil
            button = nil
        case .message(let text, let button):
            let textHeight = text.height(fitting: textWidth)
            let buttonWidth = Self.buttonWidth(size: size, safeArea: insets)
            let buttonHeight = button.height(fitting: buttonWidth)
            let total = textHeight + M.messageButtonSpacing + buttonHeight
            let top = safe.midY - total / 2
            message = CGRect(x: textX, y: top, width: textWidth, height: textHeight)
            self.button = CGRect(
                x: textX + (textWidth - buttonWidth) / 2,
                y: top + textHeight + M.messageButtonSpacing,
                width: buttonWidth,
                height: buttonHeight
            )
            viewfinder = nil
            hint = nil
        }
    }
}
