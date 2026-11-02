import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The full camera, as the system camera and Telegram's camera
/// (`CameraScreen`, `CaptureControlsComponent`) lay it out.
///
/// On a phone (locked upright; its buttons turn instead):
///
///     [×]   [⏱] [▭] [#]    [⚡]   the top bar, under the status bar
///     ┌──────────────────────┐
///     │                      │   the preview: 4:3 under the bar, 16:9
///     │                      │   centred on the screen (under the bar
///     │       picture        │   and the controls); a square photo is
///     │                      │   the 4:3 with its top and bottom dimmed
///     │     (.5)(1×)(3)      │   the lenses, over the picture's foot
///     └──────────────────────┘
///            PHOTO VIDEO         the modes
///             ( ◯ )      [⟳]     the shutter, the flip beside it
///
/// On an iPad (any way up, in any window), the controls are a column at
/// the trailing edge, as the iPad's camera has them, and the picture fits
/// the rest, its long side along the window's.
public struct CameraScreenLayout: Equatable, Sendable {
    public enum Metrics {
        public static let barHeight: CGFloat = 44
        public static let button: CGFloat = 44
        public static let buttonInset: CGFloat = 8
        /// Telegram's shutter: a 68 ring of 3 around a 60 disc, in a 96 box.
        public static let shutterBox: CGFloat = 96
        public static let shutterRing: CGFloat = 68
        public static let shutterRingWidth: CGFloat = 3
        public static let shutterDisc: CGFloat = 60
        /// From the bottom safe edge to the shutter's box.
        public static let shutterBottom: CGFloat = 16
        public static let flip: CGFloat = 48
        /// Telegram's lens buttons: 37 discs on a 43 capsule.
        public static let zoomItem: CGFloat = 37
        public static let zoomBarHeight: CGFloat = 43
        public static let zoomSpacing: CGFloat = 3
        public static let zoomGap: CGFloat = 12
        public static let modesHeight: CGFloat = 28
        public static let modesGap: CGFloat = 4
        /// The iPad's control column.
        public static let column: CGFloat = 120
        public static let columnSpacing: CGFloat = 24
        /// The system camera's yellow focus square.
        public static let focus: CGFloat = 80
        /// The exposure slider beside it: its track and its sun
        /// (Telegram's `TGCameraFocusCrosshairsControl`: 144 tall).
        public static let exposureTrack: CGFloat = 144
        public static let exposureSun: CGFloat = 26
        public static let exposureGap: CGFloat = 12
        /// The review's bar under the photo.
        public static let reviewBar: CGFloat = 96
        public static let reviewInset: CGFloat = 16
        /// The lock's banner, under the picture's top edge.
        public static let bannerGap: CGFloat = 12
        public static let bannerPadding = CGSize(width: 8, height: 3)
        /// Why there is no picture: at most this wide, inset from the edges.
        public static let messageWidth: CGFloat = 320
        public static let messageInset: CGFloat = 32
        public static let messageGap: CGFloat = 20
    }

    public struct Input: Equatable, Sendable {
        public var size: CGSize
        public var safeArea: LayoutInsets
        /// The picture's long side over its short one: 4:3 for photos
        /// (square ones too), 16:9 for wide ones and video.
        public var previewRatio: CGFloat
        /// The photo's: as the preview's, or 1 for square.
        public var cropRatio: CGFloat
        /// An iPad's regular width: the column at the trailing edge.
        public var regular: Bool
        /// The top bar's buttons beside close, in order (timer, shape, grid,
        /// flash on a phone).
        public var topButtons: Int
        /// The lens buttons.
        public var lenses: Int

        public init(size: CGSize, safeArea: LayoutInsets, previewRatio: CGFloat, cropRatio: CGFloat, regular: Bool, topButtons: Int, lenses: Int) {
            self.size = size
            self.safeArea = safeArea
            self.previewRatio = previewRatio
            self.cropRatio = cropRatio
            self.regular = regular
            self.topButtons = topButtons
            self.lenses = lenses
        }
    }

    public var close: CGRect
    public var topButtons: [CGRect]
    /// Where the camera's picture shows.
    public var preview: CGRect
    /// The part of it the photo keeps; the rest is dimmed.
    public var crop: CGRect
    /// The same in the picture's own space, and the two dimmed bands
    /// either side of it there (above and below, or beside on an iPad).
    public var cropInPreview: CGRect
    public var outside: [CGRect]
    public var zoomBar: CGRect
    /// The lens buttons, in the bar.
    public var zoomItems: [CGRect]
    public var modes: CGRect
    public var shutter: CGRect
    public var flip: CGRect

    public init(_ input: Input) {
        typealias M = Metrics
        let size = input.size
        let safe = input.safeArea
        let previewRatio = max(1, input.previewRatio)
        let cropRatio = min(previewRatio, max(1, input.cropRatio))
        close = CGRect(x: safe.left + M.buttonInset, y: safe.top + (input.regular ? M.buttonInset : 0), width: M.button, height: M.button)

        if input.regular {
            let column = CGRect(x: size.width - safe.right - M.column, y: 0, width: M.column, height: size.height)
            let area = CGRect(x: 0, y: 0, width: max(0, column.minX), height: size.height)
            preview = Self.fit(ratio: previewRatio, in: area)
            shutter = CGRect(x: column.midX - M.shutterBox / 2, y: size.height / 2 - M.shutterBox / 2, width: M.shutterBox, height: M.shutterBox)
            flip = CGRect(x: column.midX - M.flip / 2, y: shutter.maxY + M.columnSpacing, width: M.flip, height: M.flip)
            modes = CGRect(x: column.minX, y: shutter.minY - M.columnSpacing - M.modesHeight, width: column.width, height: M.modesHeight)
            topButtons = (0..<input.topButtons).map { index in
                CGRect(x: column.midX - M.button / 2, y: safe.top + M.buttonInset + CGFloat(index) * (M.button + M.buttonInset), width: M.button, height: M.button)
            }
        } else {
            let bar = CGRect(x: 0, y: safe.top, width: size.width, height: M.barHeight)
            let width = size.width
            let tall = width * previewRatio
            let room = size.height - bar.maxY
            if previewRatio <= 4.0 / 3.0 + 0.01, tall <= room {
                preview = CGRect(x: 0, y: bar.maxY, width: width, height: tall)
            } else if tall <= size.height {
                // A wide picture centred on the screen, under the bar.
                preview = CGRect(x: 0, y: ((size.height - tall) / 2).rounded(), width: width, height: tall)
            } else {
                preview = Self.fit(ratio: previewRatio, in: CGRect(x: 0, y: bar.maxY, width: width, height: max(0, room)))
            }
            shutter = CGRect(
                x: (size.width - M.shutterBox) / 2,
                y: size.height - safe.bottom - M.shutterBottom - M.shutterBox,
                width: M.shutterBox,
                height: M.shutterBox
            )
            flip = CGRect(x: ((shutter.maxX + size.width - safe.right) / 2 - M.flip / 2).rounded(), y: shutter.midY - M.flip / 2, width: M.flip, height: M.flip)
            modes = CGRect(x: 0, y: shutter.minY - M.modesGap - M.modesHeight, width: size.width, height: M.modesHeight)
            // Close at the left; the others spread to the right edge, the
            // last (flash) at it.
            let right = size.width - safe.right - M.buttonInset - M.button
            let left = close.maxX
            let count = input.topButtons
            topButtons = (0..<count).map { index in
                let x: CGFloat = count == 1 ? right : left + (right - left) * CGFloat(index + 1) / CGFloat(count)
                return CGRect(x: x.rounded(), y: bar.minY, width: M.button, height: M.button)
            }
        }

        crop = Self.fit(ratio: cropRatio, in: preview, longSideAlong: preview.width >= preview.height ? .horizontal : .vertical, cover: true)
        let local = crop.offsetBy(dx: -preview.minX, dy: -preview.minY)
        cropInPreview = local
        if local.width < preview.width - 0.001 {
            outside = [
                CGRect(x: 0, y: 0, width: local.minX, height: preview.height),
                CGRect(x: local.maxX, y: 0, width: preview.width - local.maxX, height: preview.height),
            ]
        } else {
            outside = [
                CGRect(x: 0, y: 0, width: preview.width, height: max(0, local.minY)),
                CGRect(x: 0, y: local.maxY, width: preview.width, height: max(0, preview.height - local.maxY)),
            ]
        }

        let count = max(0, input.lenses)
        let barWidth = count == 0 ? 0 : CGFloat(count) * M.zoomItem + CGFloat(count - 1) * M.zoomSpacing + (M.zoomBarHeight - M.zoomItem)
        let pad = (M.zoomBarHeight - M.zoomItem) / 2
        zoomItems = (0..<count).map { index in
            CGRect(x: pad + CGFloat(index) * (M.zoomItem + M.zoomSpacing), y: pad, width: M.zoomItem, height: M.zoomItem)
        }
        let foot = input.regular ? preview.maxY : min(crop.maxY, modes.minY)
        zoomBar = CGRect(x: (preview.midX - barWidth / 2).rounded(), y: foot - M.zoomGap - M.zoomBarHeight, width: barWidth, height: M.zoomBarHeight)
    }

    private enum Axis { case horizontal, vertical }

    /// The largest rect of `ratio` in `area`, centred, its long side along
    /// the area's. `cover`: a crop of the area that keeps its full short
    /// side, as a photo is cut from the sensor's picture.
    private static func fit(ratio: CGFloat, in area: CGRect, longSideAlong: Axis? = nil, cover: Bool = false) -> CGRect {
        guard area.width > 0, area.height > 0 else { return CGRect(origin: CGPoint(x: area.midX, y: area.midY), size: .zero) }
        let axis = longSideAlong ?? (area.width >= area.height ? .horizontal : .vertical)
        var size: CGSize
        switch axis {
        case .horizontal: size = CGSize(width: area.height * ratio, height: area.height)
        case .vertical: size = CGSize(width: area.width, height: area.width * ratio)
        }
        if !cover || size.width > area.width || size.height > area.height {
            let scale = min(area.width / size.width, area.height / size.height, cover ? 1 : .greatestFiniteMagnitude)
            size = CGSize(width: size.width * scale, height: size.height * scale)
        }
        return CGRect(x: area.midX - size.width / 2, y: area.midY - size.height / 2, width: size.width, height: size.height)
    }

    // MARK: Over the picture

    /// The focus square, centred on a tap and kept within the picture.
    public static func focus(at point: CGPoint, in preview: CGRect) -> CGRect {
        let side = Metrics.focus
        let x = min(max(point.x - side / 2, preview.minX), preview.maxX - side)
        let y = min(max(point.y - side / 2, preview.minY), preview.maxY - side)
        return CGRect(x: x, y: y, width: side, height: side)
    }

    /// The exposure slider beside the focus square: on its right, or its
    /// left when there is no room; `bias` from -1 to 1 puts the sun from
    /// the track's foot to its head.
    public static func exposure(beside focus: CGRect, in preview: CGRect, bias: CGFloat) -> (track: CGRect, sun: CGRect) {
        let track = Metrics.exposureTrack
        let sun = Metrics.exposureSun
        var x = focus.maxX + Metrics.exposureGap + sun / 2
        if x + sun / 2 > preview.maxX { x = focus.minX - Metrics.exposureGap - sun / 2 }
        let top = min(max(focus.midY - track / 2, preview.minY), preview.maxY - track)
        let line = CGRect(x: x - 0.5, y: top, width: 1, height: track)
        let fraction = (1 - min(1, max(-1, bias))) / 2
        let center = CGPoint(x: x, y: top + fraction * track)
        return (line, CGRect(x: center.x - sun / 2, y: center.y - sun / 2, width: sun, height: sun))
    }

    /// The grid's two lines each way, at the photo's thirds.
    public static func grid(in crop: CGRect) -> [CGRect] {
        let line: CGFloat = 0.5
        return (1...2).map { CGRect(x: crop.minX + crop.width * CGFloat($0) / 3 - line / 2, y: crop.minY, width: line, height: crop.height) }
            + (1...2).map { CGRect(x: crop.minX, y: crop.minY + crop.height * CGFloat($0) / 3 - line / 2, width: crop.width, height: line) }
    }

    /// `size` centred on `rect`, on whole points.
    public static func centred(_ size: CGSize, in rect: CGRect) -> CGRect {
        CGRect(x: (rect.midX - size.width / 2).rounded(), y: (rect.midY - size.height / 2).rounded(), width: size.width, height: size.height)
    }

    /// The shutter's white ring and the disc inside it, in its box.
    public static func shutterRing(in box: CGRect) -> CGRect {
        centred(CGSize(width: Metrics.shutterRing, height: Metrics.shutterRing), in: CGRect(origin: .zero, size: box.size))
    }

    public static func shutterDisc(in box: CGRect) -> CGRect {
        centred(CGSize(width: Metrics.shutterDisc, height: Metrics.shutterDisc), in: CGRect(origin: .zero, size: box.size))
    }

    /// The focus lock's banner, as the system camera shows "AE/AF LOCK":
    /// its word padded, centred just inside the photo's top; the word in
    /// the banner's own space.
    public static func banner(_ label: CGSize, in crop: CGRect) -> (box: CGRect, label: CGRect) {
        let size = CGSize(width: label.width + 2 * Metrics.bannerPadding.width, height: label.height + 2 * Metrics.bannerPadding.height)
        let box = CGRect(x: (crop.midX - size.width / 2).rounded(), y: crop.minY + Metrics.bannerGap, width: size.width, height: size.height)
        return (box, CGRect(origin: CGPoint(x: Metrics.bannerPadding.width, y: Metrics.bannerPadding.height), size: label))
    }

    /// The exposure slider dragged `dy` points down from `start`: the sun
    /// follows the finger along the track, its ends the slider's.
    public static func exposureSlider(_ start: Double, dragged dy: CGFloat) -> Double {
        min(1, max(-1, start - Double(dy / (Metrics.exposureTrack / 2))))
    }

    /// How much a picture `size` is scaled to fill `rect` aspect-fill: the
    /// full camera's picture grows out of the attach menu's tile from it.
    public static func fillScale(_ size: CGSize, into rect: CGSize) -> CGFloat {
        guard size.width > 0, size.height > 0 else { return 1 }
        return max(rect.width / size.width, rect.height / size.height)
    }

    /// Why there is no picture, and the way to Settings under it, centred
    /// on the picture; `text` measured at `messageWidth(in:)`.
    public static func message(text: CGSize, button: CGSize?, in area: CGRect) -> (text: CGRect, button: CGRect?) {
        let gap: CGFloat = button == nil ? 0 : Metrics.messageGap
        let height = text.height + gap + (button?.height ?? 0)
        let top = (area.midY - height / 2).rounded()
        let textFrame = CGRect(x: (area.midX - text.width / 2).rounded(), y: top, width: text.width, height: text.height)
        let buttonFrame = button.map { CGRect(x: (area.midX - $0.width / 2).rounded(), y: textFrame.maxY + gap, width: $0.width, height: $0.height) }
        return (textFrame, buttonFrame)
    }

    public static func messageWidth(in area: CGRect) -> CGFloat {
        max(0, min(Metrics.messageWidth, area.width - 2 * Metrics.messageInset))
    }

    /// How far the phone's buttons turn so they read upright as the device
    /// turns under a screen locked upright, as the system camera's do;
    /// radians, clockwise. Face up or down keeps the last.
    public enum DeviceOrientation: Equatable, Sendable {
        case portrait, landscapeLeft, landscapeRight, portraitUpsideDown
    }

    public static func iconRotation(_ orientation: DeviceOrientation) -> CGFloat {
        switch orientation {
        case .portrait: 0
        // UIKit's landscape left is the home side at the right: the top
        // went left, so the buttons turn a quarter clockwise.
        case .landscapeLeft: .pi / 2
        case .landscapeRight: -.pi / 2
        case .portraitUpsideDown: .pi
        }
    }
}

/// The part of a captured photo a shape keeps: centred, its long side
/// along the picture's. The sensor's picture is 4:3 and turns with the
/// photo, so the cut is the same whichever way the device was held.
public enum CameraCrop {
    /// `ratio`: the shape's long side over its short.
    public static func rect(pixels: CGSize, ratio: CGFloat) -> CGRect {
        guard pixels.width > 0, pixels.height > 0, ratio >= 1 else { return CGRect(origin: .zero, size: pixels) }
        let landscape = pixels.width >= pixels.height
        let long = landscape ? pixels.width : pixels.height
        let short = landscape ? pixels.height : pixels.width
        var cutLong = long
        var cutShort = short
        if long / short < ratio {
            cutShort = (long / ratio).rounded(.down)
        } else {
            cutLong = (short * ratio).rounded(.down)
        }
        let size = landscape ? CGSize(width: cutLong, height: cutShort) : CGSize(width: cutShort, height: cutLong)
        return CGRect(x: ((pixels.width - size.width) / 2).rounded(.down), y: ((pixels.height - size.height) / 2).rounded(.down), width: size.width, height: size.height)
    }
}

/// The photo just taken, before it goes: the system camera's review, the
/// picture whole over black and a bar under it with Retake at the leading
/// end and Use Photo at the trailing one.
public struct CameraReviewLayout: Equatable, Sendable {
    public var photo: CGRect
    public var bar: CGRect
    public var retake: CGRect
    public var use: CGRect

    /// `photo`: the picture's upright size in pixels; `retake` and `use`,
    /// the buttons' measured sizes.
    public init(size: CGSize, safeArea: LayoutInsets, photo: CGSize, retake: CGSize, use: CGSize) {
        typealias M = CameraScreenLayout.Metrics
        bar = CGRect(x: 0, y: size.height - safeArea.bottom - M.reviewBar, width: size.width, height: M.reviewBar + safeArea.bottom)
        let area = CGRect(x: safeArea.left, y: safeArea.top, width: max(0, size.width - safeArea.left - safeArea.right), height: max(0, bar.minY - safeArea.top))
        if photo.width > 0, photo.height > 0, area.width > 0, area.height > 0 {
            let scale = min(area.width / photo.width, area.height / photo.height)
            self.photo = CameraScreenLayout.centred(CGSize(width: (photo.width * scale).rounded(), height: (photo.height * scale).rounded()), in: area)
        } else {
            self.photo = CGRect(origin: CGPoint(x: area.midX, y: area.midY), size: .zero)
        }
        let middle = bar.minY + M.reviewBar / 2
        self.retake = CGRect(x: safeArea.left + M.reviewInset, y: (middle - retake.height / 2).rounded(), width: retake.width, height: retake.height)
        self.use = CGRect(x: size.width - safeArea.right - M.reviewInset - use.width, y: (middle - use.height / 2).rounded(), width: use.width, height: use.height)
    }
}
