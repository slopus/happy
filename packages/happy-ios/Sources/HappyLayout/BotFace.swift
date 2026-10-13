import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// The face a new bot is given, drawn from a seed (utils/botFace.ts).
//
// happy-app renders DiceBear's Adventurer Neutral with @dicebear/core 10.7.0
// and paints the SVG with Skia. Here the style's artwork is a generated
// table (GeneratedBotFaces.swift, scripts/generate-bot-faces.py) and the
// picking is ported: the same seed picks the same background, eyes,
// eyebrows, mouth and glasses as DiceBear does, so a face looks the same
// in the picker here, on the desktop and on the daemon once painted.
//
// The picking follows @dicebear/core's Prng, Fnv1a and Mulberry32, and the
// parts of its Resolver and Renderer this style reaches:
//
//   @dicebear/core, https://github.com/dicebear/dicebear
//   MIT License
//
//   Copyright (c) 2026 Florian Körner
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.

/// A DiceBear style as the generator wrote it: the canvas, the background
/// colours, and each component's variants as filled outlines.
public struct BotFaceStyle: Sendable {
    /// Who drew the pack, for the credit under the faces.
    public struct Credit: Equatable, Sendable {
        public var pack: String
        public var artist: String
        public var artistURL: String
    }

    public struct Shape: Equatable, Sendable {
        /// In canvas units, the component's place applied.
        public var path: VectorPath
        public var fill: RGBA
        public var evenOdd: Bool
    }

    public struct Variant: Sendable {
        public var name: String
        public var weight: Double
        public var shapes: [Shape]
    }

    public struct Component: Sendable {
        public var name: String
        /// The chance, out of 100, that it is drawn at all.
        public var probability: Double
        public var variants: [Variant]
    }

    public var canvas: CGSize
    /// `#rrggbb`, as the definition lists them.
    public var backgrounds: [String]
    /// In drawing order.
    public var components: [Component]

    /// The style happy-app draws bots with. Its outlines are parsed on first
    /// use, which takes a few milliseconds: touch it off the main thread.
    public static let adventurerNeutral: BotFaceStyle = {
        guard let style = parse(adventurerNeutralTable) else {
            preconditionFailure("GeneratedBotFaces.swift does not parse; rerun scripts/generate-bot-faces.py")
        }
        return style
    }()

    static func parse(_ table: String) -> BotFaceStyle? {
        var canvas: CGSize?
        var backgrounds: [String] = []
        var components: [Component] = []
        for line in table.split(separator: "\n") {
            let fields = line.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: false)
            switch fields.first {
            case "canvas":
                guard fields.count == 3, let width = Double(fields[1]), let height = Double(fields[2]) else { return nil }
                canvas = CGSize(width: width, height: height)
            case "background":
                backgrounds = line.split(separator: " ").dropFirst().map { "#\($0)" }
            case "component":
                guard fields.count == 3, let probability = Double(fields[2]) else { return nil }
                components.append(Component(name: String(fields[1]), probability: probability, variants: []))
            case "variant":
                guard fields.count >= 3, !components.isEmpty, let weight = Double(fields[2]) else { return nil }
                var shapes: [Shape] = []
                if fields.count == 4 {
                    for entry in fields[3].split(separator: ";") {
                        let parts = entry.split(separator: ",", maxSplits: 2)
                        guard parts.count == 3, let fill = RGBA(hex: String(parts[0])),
                              let path = try? VectorPath(svg: String(parts[2])) else { return nil }
                        shapes.append(Shape(path: path, fill: fill, evenOdd: parts[1] == "e"))
                    }
                }
                components[components.count - 1].variants.append(Variant(name: String(fields[1]), weight: weight, shapes: shapes))
            default:
                return nil
            }
        }
        guard let canvas, !backgrounds.isEmpty else { return nil }
        return BotFaceStyle(canvas: canvas, backgrounds: backgrounds, components: components)
    }
}

/// What a seed picks: the background and one variant of each component
/// drawn (DiceBear's `Resolver`).
public struct BotFace: Equatable, Sendable {
    public struct Part: Equatable, Sendable {
        public var component: String
        public var variant: String

        public init(component: String, variant: String) {
            self.component = component
            self.variant = variant
        }
    }

    public var seed: String
    /// `#rrggbb`.
    public var background: String
    /// In drawing order; a component left out (glasses, most of the time)
    /// has no part.
    public var parts: [Part]

    /// `BOT_FACE_PAINT_SIZE`: the raster the daemon keeps, more than any
    /// face is shown at.
    public static let paintSize: CGFloat = 256

    public init(seed: String, style: BotFaceStyle = .adventurerNeutral) {
        self.seed = seed
        let prng = BotFacePrng(seed: seed)
        // `color('background')`: shuffled, then the first.
        let backgrounds = style.backgrounds.map { $0.lowercased() }
        background = prng.shuffle("backgroundColor", backgrounds).first ?? "#000000"
        parts = style.components.compactMap { component in
            guard prng.bool("\(component.name)Probability", likelihood: component.probability) else { return nil }
            var weights: [String: Double] = [:]
            for variant in component.variants { weights[variant.name] = variant.weight }
            return prng.weightedPick("\(component.name)Variant", weights).map { Part(component: component.name, variant: $0) }
        }
    }

    /// The outlines to fill over the background, in drawing order, in
    /// canvas units.
    public func shapes(in style: BotFaceStyle = .adventurerNeutral) -> [BotFaceStyle.Shape] {
        parts.flatMap { part in
            style.components.first { $0.name == part.component }?
                .variants.first { $0.name == part.variant }?
                .shapes ?? []
        }
    }
}

/// DiceBear's key-based generator: every value comes from the seed and a
/// key alone, so the order things are asked for changes nothing.
struct BotFacePrng {
    let seed: String

    /// `getValue`: a float in [0, 1) from `seed:key`.
    func value(_ key: String) -> Double {
        var generator = Mulberry32(state: Self.fnv1a("\(seed):\(key)"))
        return generator.nextFloat()
    }

    func bool(_ key: String, likelihood: Double = 50) -> Bool {
        value(key) * 100 < likelihood
    }

    func pick(_ key: String, _ items: [String]) -> String? {
        if items.count <= 1 { return items.first }
        let unique = Self.unique(items)
        if unique.count == 1 { return unique[0] }
        let sorted = unique.sorted(by: Self.codeUnitsPrecede)
        return sorted[Int((value(key) * Double(sorted.count)).rounded(.down))]
    }

    func weightedPick(_ key: String, _ weights: [String: Double]) -> String? {
        let keys = weights.keys.sorted(by: Self.codeUnitsPrecede)
        if keys.count <= 1 { return keys.first }
        let total = keys.reduce(0) { $0 + (weights[$1] ?? 0) }
        if total == 0 { return pick(key, keys) }
        let threshold = value(key) * total
        var cumulative = 0.0
        for name in keys {
            cumulative += weights[name] ?? 0
            if threshold < cumulative { return name }
        }
        return keys.last
    }

    /// Fisher-Yates over the sorted, deduplicated items, on one Mulberry32
    /// run.
    func shuffle(_ key: String, _ items: [String]) -> [String] {
        if items.count <= 1 { return items }
        var result = Self.unique(items).sorted(by: Self.codeUnitsPrecede)
        var generator = Mulberry32(state: Self.fnv1a("\(seed):\(key)"))
        var i = result.count - 1
        while i > 0 {
            let j = Int((generator.nextFloat() * Double(i + 1)).rounded(.down))
            result.swapAt(i, j)
            i -= 1
        }
        return result
    }

    /// FNV-1a 32 over UTF-16 code units, as `charCodeAt` reads them.
    static func fnv1a(_ input: String) -> UInt32 {
        var hash: UInt32 = 0x811C9DC5
        for unit in input.utf16 {
            hash ^= UInt32(unit)
            hash = hash &* 0x0100_0193
        }
        return hash
    }

    /// JavaScript's string `<`: by UTF-16 code unit.
    static func codeUnitsPrecede(_ a: String, _ b: String) -> Bool {
        a.utf16.lexicographicallyPrecedes(b.utf16)
    }

    static func unique(_ items: [String]) -> [String] {
        var seen: Set<String> = []
        return items.filter { seen.insert($0).inserted }
    }

    /// Tommy Ettinger's Mulberry32, in 32-bit wrapping arithmetic.
    struct Mulberry32 {
        var state: UInt32

        mutating func next() -> UInt32 {
            state = state &+ 0x6D2B_79F5
            let z = state
            var t = (z ^ (z >> 15)) &* (z | 1)
            t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
            return t ^ (t >> 14)
        }

        mutating func nextFloat() -> Double {
            Double(next()) / 4_294_967_296
        }
    }
}
