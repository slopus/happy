import Foundation
import HappyLayout

/// One font's table in `GeneratedIcons.swift`.
struct GeneratedFont: Sendable {
    let family: IconFamily
    let unitsPerEm: Int
    /// hhea ascender and descender, in font units.
    let ascender: Int
    let descender: Int
    /// One glyph per line: `name advance outline`, outline as below.
    let glyphs: String
}

/// A glyph outline as `scripts/generate-icons.py` packs it, base64-encoded:
///
/// - a varint contour count, then each contour's point count as a varint;
/// - one bit per point, least significant first, set when the point is on
///   the curve (TrueType's quadratic B-spline rule);
/// - each point as zigzag varints dx, dy from the previous point (the first
///   from 0,0), in font units, y pointing down from the ascender line.
///
/// Decoding replays TrueType's rules: two off-curve points in a row imply an
/// on-curve point halfway between them, and a contour may start off the
/// curve.
enum GlyphOutline {
    static func decode(_ base64: Substring) -> VectorPath? {
        guard let data = Data(base64Encoded: String(base64)) else { return nil }
        var reader = ByteReader(bytes: [UInt8](data))
        guard let contourCount = reader.varint() else { return nil }
        var pointCounts: [Int] = []
        pointCounts.reserveCapacity(contourCount)
        for _ in 0..<contourCount {
            guard let count = reader.varint() else { return nil }
            pointCounts.append(count)
        }
        let total = pointCounts.reduce(0, +)
        guard let flags = reader.bytes((total + 7) / 8).map(Array.init) else { return nil }
        var points: [CGPoint] = []
        points.reserveCapacity(total)
        var x = 0, y = 0
        for _ in 0..<total {
            guard let dx = reader.zigzag(), let dy = reader.zigzag() else { return nil }
            x += dx
            y += dy
            points.append(CGPoint(x: x, y: y))
        }
        guard reader.isAtEnd else { return nil }

        var elements: [PathElement] = []
        var first = 0
        for count in pointCounts {
            let contour = (first..<first + count).map { i in
                (point: points[i], onCurve: flags[i / 8] & (1 << (i % 8)) != 0)
            }
            appendContour(contour, to: &elements)
            first += count
        }
        return VectorPath(elements: elements)
    }

    private static func appendContour(_ contour: [(point: CGPoint, onCurve: Bool)], to elements: inout [PathElement]) {
        guard let firstPoint = contour.first, let lastPoint = contour.last else { return }
        let start: CGPoint
        let rest: ArraySlice<(point: CGPoint, onCurve: Bool)>
        if firstPoint.onCurve {
            start = firstPoint.point
            rest = contour.dropFirst()
        } else if lastPoint.onCurve {
            start = lastPoint.point
            rest = contour.dropLast()
        } else {
            start = midpoint(lastPoint.point, firstPoint.point)
            rest = contour[...]
        }
        elements.append(.move(start))
        var control: CGPoint?
        for (point, onCurve) in rest {
            if onCurve {
                if let c = control {
                    elements.append(.quadCurve(to: point, control: c))
                    control = nil
                } else {
                    elements.append(.line(point))
                }
            } else {
                if let c = control {
                    elements.append(.quadCurve(to: midpoint(c, point), control: c))
                }
                control = point
            }
        }
        if let c = control {
            elements.append(.quadCurve(to: start, control: c))
        }
        elements.append(.close)
    }

    private static func midpoint(_ a: CGPoint, _ b: CGPoint) -> CGPoint {
        CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
    }
}

private struct ByteReader {
    let bytes: [UInt8]
    var index = 0

    var isAtEnd: Bool { index == bytes.count }

    mutating func varint() -> Int? {
        var value = 0
        var shift = 0
        while index < bytes.count, shift < 63 {
            let byte = bytes[index]
            index += 1
            value |= Int(byte & 0x7F) << shift
            if byte & 0x80 == 0 { return value }
            shift += 7
        }
        return nil
    }

    mutating func zigzag() -> Int? {
        guard let raw = varint() else { return nil }
        return raw & 1 == 0 ? raw >> 1 : -((raw + 1) >> 1)
    }

    mutating func bytes(_ count: Int) -> ArraySlice<UInt8>? {
        guard index + count <= bytes.count else { return nil }
        defer { index += count }
        return bytes[index..<index + count]
    }
}
