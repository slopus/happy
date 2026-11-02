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
        /// Past this the picture jumps about too much to aim.
        public static let maxFocusZoom: CGFloat = 3
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

    /// The camera output's rect of interest, in its unit space, from the
    /// viewfinder's conversion: the whole frame when the conversion is
    /// empty, not finite or entirely outside it, which would read nothing.
    public static func scanArea(_ converted: CGRect) -> CGRect {
        let whole = CGRect(x: 0, y: 0, width: 1, height: 1)
        let values = [converted.origin.x, converted.origin.y, converted.width, converted.height]
        guard values.allSatisfy(\.isFinite) else { return whole }
        let area = converted.standardized.intersection(whole)
        guard !area.isNull, area.width > 0.05, area.height > 0.05 else { return whole }
        return area
    }

    /// The viewfinder as the camera output's rect of interest, worked out
    /// from what the preview shows rather than asked of the preview layer,
    /// which answers nonsense until its session runs and its connection
    /// has a format.
    ///
    /// - `preview`: the preview layer's size, filled aspect-fill.
    /// - `video`: the camera's picture as the sensor delivers it, landscape
    ///   with (0, 0) at the top left, which is also the output's unit space.
    /// - `rotation`: the preview connection's `videoRotationAngle`, the
    ///   clockwise turn that stands that picture upright on screen: 90 in
    ///   portrait, 0 in landscape right, 180 in landscape left, 270 upside
    ///   down.
    public static func scanArea(viewfinder: CGRect, preview: CGSize, video: CGSize, rotation: CGFloat) -> CGRect {
        let whole = CGRect(x: 0, y: 0, width: 1, height: 1)
        guard rotation.isFinite, video.width > 0, video.height > 0, preview.width > 0, preview.height > 0 else { return whole }
        let quarter = ((Int((rotation / 90).rounded()) % 4) + 4) % 4
        let upright = quarter % 2 == 1 ? CGSize(width: video.height, height: video.width) : video
        let scale = max(preview.width / upright.width, preview.height / upright.height)
        let shown = CGSize(width: upright.width * scale, height: upright.height * scale)
        let left = (preview.width - shown.width) / 2
        let top = (preview.height - shown.height) / 2
        // The viewfinder in the upright picture's unit space…
        let x = (viewfinder.minX - left) / shown.width
        let y = (viewfinder.minY - top) / shown.height
        let width = viewfinder.width / shown.width
        let height = viewfinder.height / shown.height
        // …turned back to the sensor's.
        let area = switch quarter {
        case 1: CGRect(x: y, y: 1 - x - width, width: height, height: width)
        case 2: CGRect(x: 1 - x - width, y: 1 - y - height, width: width, height: height)
        case 3: CGRect(x: 1 - y - height, y: x, width: height, height: width)
        default: CGRect(x: x, y: y, width: width, height: height)
        }
        return scanArea(area)
    }

    /// The zoom that lets a code as small as Happy shows one fill the rect
    /// of interest while still in focus, after Apple's AVCamBarcode: a
    /// camera that can't focus close (the iPhone 15 Pro's wide one focuses
    /// no nearer than about 20 cm) would otherwise be held so near that
    /// the code is a blur and never reads. 1 when it can focus that near
    /// or says nothing of its distance.
    ///
    /// - `minimumFocusDistance`: millimetres, -1 when unknown.
    /// - `fieldOfView`: degrees across the picture's long side.
    /// - `fill`: the share of that side the rect of interest spans.
    public static func focusZoom(minimumFocusDistance: Float, fieldOfView: Float, fill: CGFloat) -> CGFloat {
        guard minimumFocusDistance > 0, fieldOfView > 0, fieldOfView < 180, fill > 0, fill <= 1 else { return 1 }
        // The desktop's code is about 32 mm across, the CLI's about 45.
        let codeSize: Float = 30
        let halfAngle = fieldOfView / 2 * .pi / 180
        let distance = codeSize / (2 * Float(fill) * tan(halfAngle))
        guard distance < minimumFocusDistance else { return 1 }
        return min(CGFloat(minimumFocusDistance / distance), Metrics.maxFocusZoom)
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
