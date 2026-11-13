import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Telegram's drawing tools as they start (`DrawingScreen`'s initial
/// tool states) and its colours (`DrawingScreen`'s presets,
/// `ColorPickerScreen`'s grid and swatches).
public enum PhotoTools {
    /// The order of the tool row.
    public static let order: [PhotoStroke.Tool] = [.pen, .arrow, .marker, .neon, .blur, .eraser]
    /// Kirill's: the editor opens on the arrow ("the pointer").
    public static let initial: PhotoStroke.Tool = .arrow

    public static func color(_ tool: PhotoStroke.Tool) -> RGBA {
        switch tool {
        case .pen: return hex(0xFF453A)
        case .arrow: return hex(0xFF8A00)
        case .marker: return hex(0xFFD60A)
        case .neon: return hex(0x34C759)
        case .blur, .eraser: return .white
        }
    }

    public static func size(_ tool: PhotoStroke.Tool) -> CGFloat {
        switch tool {
        case .pen, .arrow: return 0.23
        case .marker: return 0.75
        case .neon: return 0.4
        case .blur, .eraser: return 0.5
        }
    }

    /// Whether the tool draws in a colour (blur and the eraser don't).
    public static func colored(_ tool: PhotoStroke.Tool) -> Bool { tool != .blur && tool != .eraser }

    /// The swatch row over the bottom buttons.
    public static let presets: [RGBA] = [0xFF453A, 0xFF8A00, 0xFFD60A, 0x34C759, 0x63E6E2, 0x0A84FF, 0xBF5AF2, 0xFFFFFF].map(hex)
    /// The colour sheet's swatches beside its preview.
    public static let sheetSwatches: [RGBA] = [0x000000, 0x0161FD, 0x32C759, 0xFFCC02, 0xFF3A30].map(hex)
    /// The colour sheet's grid, 12 across and 10 down, row by row.
    public static let grid: [RGBA] = [
        0xffffff, 0xebebeb, 0xd6d6d6, 0xc2c2c2, 0xadadad, 0x999999, 0x858585, 0x707070, 0x5c5c5c, 0x474747, 0x333333, 0x000000,
        0x00374a, 0x011d57, 0x11053b, 0x2e063d, 0x3c071b, 0x5c0701, 0x5a1c00, 0x583300, 0x563d00, 0x666100, 0x4f5504, 0x263e0f,
        0x004d65, 0x012f7b, 0x1a0a52, 0x450d59, 0x551029, 0x831100, 0x7b2900, 0x7a4a00, 0x785800, 0x8d8602, 0x6f760a, 0x38571a,
        0x016e8f, 0x0042a9, 0x2c0977, 0x61187c, 0x791a3d, 0xb51a00, 0xad3e00, 0xa96800, 0xa67b01, 0xc4bc00, 0x9ba50e, 0x4e7a27,
        0x008cb4, 0x0056d6, 0x371a94, 0x7a219e, 0x99244f, 0xe22400, 0xda5100, 0xd38301, 0xd19d01, 0xf5ec00, 0xc3d117, 0x669d34,
        0x00a1d8, 0x0061fe, 0x4d22b2, 0x982abc, 0xb92d5d, 0xff4015, 0xff6a00, 0xffab01, 0xfdc700, 0xfefb41, 0xd9ec37, 0x76bb40,
        0x01c7fc, 0x3a87fe, 0x5e30eb, 0xbe38f3, 0xe63b7a, 0xff6250, 0xff8648, 0xfeb43f, 0xfecb3e, 0xfff76b, 0xe4ef65, 0x96d35f,
        0x52d6fc, 0x74a7ff, 0x864ffe, 0xd357fe, 0xee719e, 0xff8c82, 0xffa57d, 0xffc777, 0xffd977, 0xfff994, 0xeaf28f, 0xb1dd8b,
        0x93e3fd, 0xa7c6ff, 0xb18cfe, 0xe292fe, 0xf4a4c0, 0xffb5af, 0xffc5ab, 0xffd9a8, 0xfee4a8, 0xfffbb9, 0xf2f7b7, 0xcde8b5,
        0xcbf0ff, 0xd3e2ff, 0xd9c9fe, 0xefcaff, 0xf9d3e0, 0xffdbd8, 0xffe2d6, 0xffecd4, 0xfff2d5, 0xfefcdd, 0xf7fadb, 0xdfeed4,
    ].map(hex)
    public static let gridColumns = 12
    public static let gridRows = 10

    public static func hex(_ value: Int) -> RGBA {
        RGBA(red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255, blue: Double(value & 0xFF) / 255)
    }

    /// The same colour, ignoring how see-through it is.
    public static func sameHue(_ a: RGBA, _ b: RGBA) -> Bool {
        abs(a.red - b.red) < 0.004 && abs(a.green - b.green) < 0.004 && abs(a.blue - b.blue) < 0.004
    }

    /// The spectrum field's colour at `point` (0...1 each way): the hue
    /// across, white over it at the top and black at the bottom.
    public static func spectrum(at point: CGPoint) -> RGBA {
        let hue = min(max(Double(point.x), 0), 1)
        let y = min(max(Double(point.y), 0), 1)
        let pure = hueColor(hue)
        if y < 0.5 {
            let white = 1 - y * 2
            return RGBA(red: pure.red + (1 - pure.red) * white, green: pure.green + (1 - pure.green) * white, blue: pure.blue + (1 - pure.blue) * white)
        }
        let dark = (y - 0.5) * 2
        return RGBA(red: pure.red * (1 - dark), green: pure.green * (1 - dark), blue: pure.blue * (1 - dark))
    }

    static func hueColor(_ hue: Double) -> RGBA {
        let h = (hue * 6).truncatingRemainder(dividingBy: 6)
        let x = 1 - abs(h.truncatingRemainder(dividingBy: 2) - 1)
        switch Int(h) {
        case 0: return RGBA(red: 1, green: x, blue: 0)
        case 1: return RGBA(red: x, green: 1, blue: 0)
        case 2: return RGBA(red: 0, green: 1, blue: x)
        case 3: return RGBA(red: 0, green: x, blue: 1)
        case 4: return RGBA(red: x, green: 0, blue: 1)
        default: return RGBA(red: 1, green: 0, blue: x)
        }
    }
}

/// Telegram's crop screen (`TGPhotoCropController`, portrait):
///
///     ┌──────────────────────┐
///     │ ┌──────────────────┐ │   the picture's room: the screen less the
///     │ │                  │ │   bottom 49 + 115, the crop 9 inside it
///     │ │      crop        │ │
///     │ └──────────────────┘ │
///     │        ‿‿‿‿‿         │   the wheel, a 100 strip under the crop
///     │        Reset         │   61 over the bar, the title 20 down
///     │ ✕   (⟲)(⇋)(▭)    ✓   │   49 over the safe area
///     └──────────────────────┘
public struct PhotoCropScreenLayout: Equatable, Sendable {
    public enum Metrics {
        public static let toolbar: CGFloat = 49
        public static let panel: CGFloat = 115
        public static let areaInset: CGFloat = 9
        public static let buttonsWrapper: CGFloat = 61
        public static let resetTop: CGFloat = 20
        public static let resetHeight: CGFloat = 24
        public static let wheel: CGFloat = 100
        public static let button: CGFloat = 44
        /// The side buttons' edge from the screen's.
        public static let side: CGFloat = 26
        /// Between the buttons in the middle group.
        public static let spacing: CGFloat = 10
        /// The shortest a crop's side gets on the screen.
        public static let minimumSide: CGFloat = 44
    }

    /// Where the crop fits, at rest.
    public var area: CGRect
    public var cancel: CGRect
    public var done: CGRect
    /// The middle group's capsule, and its buttons in it.
    public var group: CGRect
    public var groupButtons: [CGRect]
    /// The centre of "Reset".
    public var reset: CGPoint
    /// Below this the wheel never goes.
    public var wheelLimit: CGFloat

    public init(size: CGSize, safeArea: LayoutInsets, buttons: Int = 3) {
        typealias M = Metrics
        let left = safeArea.left, right = size.width - safeArea.right
        let top = safeArea.top
        let bottom = size.height - safeArea.bottom
        let room = CGRect(x: left, y: top, width: right - left, height: max(0, bottom - M.toolbar - M.panel - top))
        area = room.insetBy(dx: M.areaInset, dy: M.areaInset)
        let barMid = bottom - M.toolbar / 2
        cancel = CGRect(x: left + M.side, y: barMid - M.button / 2, width: M.button, height: M.button)
        done = CGRect(x: right - M.side - M.button, y: barMid - M.button / 2, width: M.button, height: M.button)
        let width = CGFloat(buttons) * M.button + CGFloat(max(0, buttons - 1)) * M.spacing
        group = CGRect(x: (left + right - width) / 2, y: barMid - M.button / 2, width: width, height: M.button)
        groupButtons = (0..<buttons).map { CGRect(x: CGFloat($0) * (M.button + M.spacing), y: 0, width: M.button, height: M.button) }
        let wrapperTop = bottom - M.toolbar - M.buttonsWrapper
        reset = CGPoint(x: (left + right) / 2, y: wrapperTop + M.resetTop + M.resetHeight / 2)
        wheelLimit = wrapperTop
    }

    /// A crop of `size` (in any unit) fitted to the area, centred.
    public func window(for size: CGSize) -> CGRect {
        guard size.width > 0, size.height > 0, area.width > 0, area.height > 0 else { return area }
        let scale = min(area.width / size.width, area.height / size.height)
        let fitted = CGSize(width: size.width * scale, height: size.height * scale)
        return CGRect(x: area.midX - fitted.width / 2, y: area.midY - fitted.height / 2, width: fitted.width, height: fitted.height)
    }

    /// The wheel's strip under a crop at `window`, kept over "Reset".
    public func wheel(under window: CGRect) -> CGRect {
        let top = min(window.maxY, wheelLimit - Metrics.wheel + Metrics.resetTop)
        return CGRect(x: area.minX - Metrics.areaInset, y: top, width: area.width + 2 * Metrics.areaInset, height: Metrics.wheel)
    }

    /// Telegram's wheel: a degree for every 1.15 π points dragged, the
    /// picture turning against the finger.
    public static func angle(_ angle: CGFloat, dragged dx: CGFloat) -> CGFloat {
        let degrees = angle * 180 / .pi - dx / .pi / 1.15
        let limit = PhotoCrop.maxAngle * 180 / .pi
        return min(max(degrees, -limit), limit) * .pi / 180
    }
}

/// Telegram's drawing screen (`DrawingScreen`, chat media editor):
///
///     ( ↶ ↷ )               ( Clear )   one row of glass 31 under the top
///     ◖                                 the size wedge at the left edge
///          ▮  ▮  ▮  ▮  ▮  ▮             the tool row, the chosen one up
///     ◎                                 the colour over the row's left
///     ●   ●   ●   ●   ●   ●   ●   ●     the swatches
///     ✕                            ✓
public struct PhotoDrawScreenLayout: Equatable, Sendable {
    public enum Metrics {
        public static let topOffset: CGFloat = 31
        public static let button: CGFloat = 44
        public static let pillSide: CGFloat = 16
        /// The tool row's box and its tools (Telegram's 40 × 176 at half).
        public static let toolsHeight: CGFloat = 120
        public static let toolsBottom: CGFloat = 78
        public static let tool = CGSize(width: 20, height: 88)
        public static let toolSpacing: CGFloat = 44
        /// How far down a tool's middle is in the row: resting, and chosen.
        public static let toolY: CGFloat = 88
        public static let chosenToolY: CGFloat = 76
        public static let colorBottom: CGFloat = 89
        public static let swatch: CGFloat = 24
        public static let swatchBottom: CGFloat = 57
        public static let extraBottom: CGFloat = 8
        public static let sideButton: CGFloat = 14 + 12
        public static let wedge = CGSize(width: 30, height: 240)
        public static let bottomReserve: CGFloat = 145
    }

    public var topY: CGFloat
    public var undo: CGPoint
    public var clearRight: CGFloat
    /// The wedge's frame, at rest.
    public var wedge: CGRect
    public var tools: CGRect
    public var toolCenters: [CGFloat]
    public var color: CGRect
    public var swatches: [CGRect]
    public var close: CGRect
    public var done: CGRect
    /// Where the picture fits.
    public var picture: CGRect

    public init(size: CGSize, safeArea: LayoutInsets, toolCount: Int = PhotoTools.order.count, swatchCount: Int = PhotoTools.presets.count) {
        typealias M = Metrics
        let left = safeArea.left, right = size.width - safeArea.right
        let bottom = size.height - safeArea.bottom
        topY = safeArea.top + M.topOffset
        undo = CGPoint(x: left + M.pillSide, y: topY)
        clearRight = right - M.pillSide
        let wedgeY = topY + (size.height - topY - M.bottomReserve) / 2
        wedge = CGRect(x: 0, y: wedgeY - M.wedge.height / 2, width: M.wedge.width, height: M.wedge.height)
        let row = CGRect(x: left, y: bottom - M.extraBottom - M.toolsBottom - M.toolsHeight, width: right - left, height: M.toolsHeight)
        tools = row
        let span = M.toolSpacing * CGFloat(max(0, toolCount - 1))
        toolCenters = (0..<toolCount).map { row.width / 2 - span / 2 + M.toolSpacing * CGFloat($0) }
        color = CGRect(x: left + 6, y: bottom - M.button - M.colorBottom - M.extraBottom, width: M.button, height: M.button)
        let first = left + 28, last = right - 28
        let step = swatchCount > 1 ? (last - first) / CGFloat(swatchCount - 1) : 0
        let swatchY = bottom - M.swatch / 2 - M.swatchBottom - M.extraBottom
        swatches = (0..<swatchCount).map { CGRect(x: first + step * CGFloat($0) - M.swatch / 2, y: swatchY - M.swatch / 2, width: M.swatch, height: M.swatch) }
        let barY = bottom - M.button / 2 - 2
        close = CGRect(x: left + M.sideButton, y: barY - M.button / 2, width: M.button, height: M.button)
        done = CGRect(x: right - M.sideButton - M.button, y: barY - M.button / 2, width: M.button, height: M.button)
        picture = CGRect(x: left, y: safeArea.top, width: right - left, height: max(0, bottom - safeArea.top))
    }

    /// The wedge's 0...1 at `y` in it: big at the top (`TextSizeSliderComponent`).
    public static func wedgeValue(at y: CGFloat, height: CGFloat) -> CGFloat {
        1 - min(max((y - 12) / max(1, height - 24), 0), 1)
    }

    /// The knob's middle in the wedge for `value`.
    public static func wedgeKnob(_ value: CGFloat, height: CGFloat) -> CGFloat {
        -12 + (height + 24 - 52) * (1 - value) + 26
    }
}
