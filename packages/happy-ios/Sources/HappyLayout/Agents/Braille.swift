import Foundation

/// Desktop's working loader (`spinnerBrailleCanvas.ts`, cli-spinners'
/// `dots2`): a 2x4 braille cell whose eight dots dim one after another.
/// The dots are placed on the screen's own pixels, as desktop places them:
/// one hard-edged stamp of one diameter, copied eight times at whole-pixel
/// origins, with whitespace taking every rounding so no two dots differ.
/// Every dot runs the same opacity wave, offset by its phase.
public enum Braille {
    public static let frameCount = 8
    /// Milliseconds.
    public static let frame: Double = 100
    public static let cycle: Double = frame * Double(frameCount)
    public static let fade: Double = 60
    public static let dim: Double = 0.18
    /// The box at desktop's 14px: 8 wide (twice the dot pitch) by 14.
    public static let width: Double = 8
    public static let height: Double = 14
    /// Left column top to bottom, then right column top to bottom; `dots2`
    /// dims dots 1, 2, 3, 7, 8, 6, 5, then 4.
    public static let phases = [0, 1, 2, 3, 7, 6, 5, 4]

    /// The one wave: down over 60ms, held dim to 100, up over the next 60.
    public static func opacity(at time: Double) -> Double {
        let t = (time.truncatingRemainder(dividingBy: cycle) + cycle).truncatingRemainder(dividingBy: cycle)
        if t < fade { return 1 - (1 - dim) * (t / fade) }
        if t < frame { return dim }
        if t < frame + fade { return dim + (1 - dim) * ((t - frame) / fade) }
        return 1
    }

    /// The same wave as keyframes over one cycle (fractions of it, and the
    /// opacity there), for an animation the render server runs.
    public static let keyframes: [(time: Double, opacity: Double)] = [
        (0, 1), (fade / cycle, dim), (frame / cycle, dim), ((frame + fade) / cycle, 1), (1, 1),
    ]

    /// The largest stamp that keeps one clear pixel between dots and round the edge.
    public static func diameter(width: Int, height: Int) -> Int {
        var diameter = min(width, height, max(2, height / 7))
        while diameter > 1, width < diameter * 2 + 3 || height < diameter * 4 + 5 { diameter -= 1 }
        return diameter
    }

    /// Four rows: a pixel of padding top and bottom, the inner gaps widened
    /// evenly, a lone spare row in the middle gap.
    public static func rows(height: Int, diameter: Int) -> [Int] {
        let whitespace = max(0, height - diameter * 4)
        let padding = whitespace >= 2 ? 1 : 0
        let inner = max(0, whitespace - padding * 2)
        let base = min(diameter, inner / 3)
        let extras: [Int] = switch inner - base * 3 {
        case 0: [0, 0, 0]
        case 1: [0, 1, 0]
        case 2: [1, 0, 1]
        case 3: [1, 1, 1]
        default: [1, 2, 1]
        }
        let gaps = extras.map { base + $0 }
        return [
            padding,
            padding + diameter + gaps[0],
            padding + diameter * 2 + gaps[0] + gaps[1],
            padding + diameter * 3 + gaps[0] + gaps[1] + gaps[2],
        ]
    }

    /// Two columns with even padding; an odd spare pixel widens the gap.
    public static func columns(width: Int, diameter: Int) -> [Int] {
        let whitespace = max(0, width - diameter * 2)
        let base = min(diameter, whitespace)
        let remainder = whitespace - base
        let padding = remainder / 2
        let gap = base + remainder % 2
        return [padding, padding + diameter + gap]
    }

    /// Each dot's origin in pixels, in the phases' order.
    public static func origins(width: Int, height: Int) -> (diameter: Int, origins: [(x: Int, y: Int)]) {
        let diameter = diameter(width: width, height: height)
        let rows = rows(height: height, diameter: diameter)
        let columns = columns(width: width, diameter: diameter)
        return (diameter, columns.flatMap { x in rows.map { (x: x, y: $0) } })
    }

    /// The stamp: per pixel row, the first lit pixel and how many.
    public static func stamp(diameter: Int) -> [(start: Int, length: Int)] {
        let center = Double(diameter - 1) / 2
        let radius = Double(diameter) / 2
        return (0..<diameter).map { y in
            var first = diameter
            var last = -1
            for x in 0..<diameter where hypot(Double(x) - center, Double(y) - center) <= radius {
                first = min(first, x)
                last = x
            }
            return (first, max(0, last - first + 1))
        }
    }
}

/// Desktop's `elapsedTimeFormat`: seconds, then minutes and seconds, then
/// hours and minutes.
public enum Elapsed {
    public static func text(milliseconds: Double) -> String {
        let seconds = max(0, Int(milliseconds / 1000))
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m \(seconds % 60)s" }
        return "\(minutes / 60)h \(minutes % 60)m"
    }

    /// Desktop's `waitRemainingLabel`: what is left of a wait in its two
    /// largest units, a trailing zero unit dropped.
    public static func remaining(milliseconds: Double) -> String {
        let total = max(0, Int((milliseconds / 1000).rounded(.up)))
        let days = total / 86_400
        let hours = total % 86_400 / 3600
        let minutes = total % 3600 / 60
        let seconds = total % 60
        if days > 0 { return hours > 0 ? "\(days)d \(hours)h" : "\(days)d" }
        if hours > 0 { return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h" }
        if minutes > 0 { return seconds > 0 ? "\(minutes)m \(seconds)s" : "\(minutes)m" }
        return "\(seconds)s"
    }
}
