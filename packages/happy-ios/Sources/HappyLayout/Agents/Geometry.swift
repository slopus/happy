import Foundation

/// The seedling: a seeded identity for work that has not become something
/// yet, the same shape for the same ID on every client. A port of
/// happy-desktop-ui `stemCellGeometry.ts`; `GeometryTests` pins it
/// against the TypeScript output.
public enum Geometry {
    public typealias Point = (x: Double, y: Double)

    /// The membrane and the core, each 32 points in a unit square.
    public struct Shape: Sendable {
        public var membrane: [Point]
        public var core: [Point]
    }

    private struct Harmonic { let k: Double; let a: Double; let phase: Double }

    /// FNV-1a over UTF-16 code units, as JavaScript's `charCodeAt` reads them.
    static func hash(_ text: String) -> UInt32 {
        var h: UInt32 = 0x811c9dc5
        for unit in text.utf16 {
            h ^= UInt32(unit)
            h = h &* 0x01000193
        }
        return h
    }

    /// mulberry32.
    struct Random {
        var a: UInt32
        mutating func next() -> Double {
            a = a &+ 0x6d2b79f5
            var t = a
            t = (t ^ (t >> 15)) &* (t | 1)
            t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
            return Double(t ^ (t >> 14)) / 4294967296
        }
    }

    private static func radial(_ harmonics: [Harmonic], drift: Double) -> (Double) -> Double {
        { theta in
            var r = 1.0
            for harmonic in harmonics { r += harmonic.a * cos(harmonic.k * theta + harmonic.phase + drift) }
            return r
        }
    }

    public static func shape(_ id: String, drift: Double = 0) -> Shape {
        let tau = Double.pi * 2
        let samples = 32
        let padding = 0.06
        let coreOffset = 0.11
        let coreRadius = 0.105
        let margin = 0.1
        var random = Random(a: hash(id))
        func between(_ lo: Double, _ hi: Double) -> Double { lo + (hi - lo) * random.next() }

        // The core first, then a membrane sized to contain it.
        let coreAngle = between(0, tau)
        let coreDistance = coreOffset * random.next().squareRoot()
        let coreX = cos(coreAngle) * coreDistance
        let coreY = sin(coreAngle) * coreDistance
        let coreR = coreRadius * between(0.85, 1.15)
        let c2 = Harmonic(k: 2, a: between(0.05, 0.12), phase: between(0, tau))
        let c3 = Harmonic(k: 3, a: between(0.0, 0.05), phase: between(0, tau))
        let coreShape = radial([c2, c3], drift: drift)
        let lobes = [3.0, 4, 4, 4, 5][Int((random.next() * 5).rounded(.down))]
        let lobeAmp = between(0.13, 0.18) * (lobes == 5 ? 0.75 : 1)
        let lobePhase = between(0, tau)
        let m1 = Harmonic(k: lobes, a: lobeAmp, phase: lobePhase)
        let m2 = Harmonic(k: 2 * lobes, a: lobeAmp * between(0.08, 0.18), phase: 2 * lobePhase)
        let m3 = Harmonic(k: lobes - 1, a: between(0.02, 0.06), phase: between(0, tau))
        let m4 = Harmonic(k: lobes + 1, a: between(0.02, 0.06), phase: between(0, tau))
        let m5 = Harmonic(k: 1, a: between(0.0, 0.06), phase: between(0, tau))
        let membraneShape = radial([m1, m2, m3, m4, m5], drift: drift)

        var scale = 0.32
        for i in 0..<48 {
            let t = Double(i) / 48 * tau
            let rr = coreR * coreShape(t)
            let px = coreX + cos(t) * rr
            let py = coreY + sin(t) * rr
            let needed = ((px * px + py * py).squareRoot() + margin) / membraneShape(atan2(py, px))
            if needed > scale { scale = needed }
        }

        var membrane: [Point] = []
        var core: [Point] = []
        for i in 0..<samples {
            let t = Double(i) / Double(samples) * tau
            let rm = scale * membraneShape(t)
            membrane.append((cos(t) * rm, sin(t) * rm))
            let rc = coreR * coreShape(t)
            core.append((coreX + cos(t) * rc, coreY + sin(t) * rc))
        }
        let xs = membrane.map(\.x), ys = membrane.map(\.y)
        let minX = xs.min()!, maxX = xs.max()!, minY = ys.min()!, maxY = ys.max()!
        let fit = (1 - 2 * padding) / max(maxX - minX, maxY - minY)
        let cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
        func place(_ point: Point) -> Point { (0.5 + (point.x - cx) * fit, 0.5 + (point.y - cy) * fit) }
        return Shape(membrane: membrane.map(place), core: core.map(place))
    }

    /// One cubic segment of the closed Catmull–Rom spline through `points`.
    public struct Segment: Sendable {
        public var control1: Point
        public var control2: Point
        public var end: Point
    }

    /// The closed Catmull–Rom spline through the points at `size`, starting
    /// at the first point (`stemCellSmoothPath`).
    public static func smooth(_ points: [Point], size: Double) -> (start: Point, segments: [Segment]) {
        let p = points.map { (x: $0.x * size, y: $0.y * size) }
        let n = p.count
        var segments: [Segment] = []
        for i in 0..<n {
            let p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n]
            segments.append(Segment(
                control1: (p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6),
                control2: (p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6),
                end: p2
            ))
        }
        return (p[0], segments)
    }
}
