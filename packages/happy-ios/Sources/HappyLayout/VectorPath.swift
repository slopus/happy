import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// One step of a vector outline, in absolute coordinates.
public enum PathElement: Equatable, Sendable {
    case move(CGPoint)
    case line(CGPoint)
    case quadCurve(to: CGPoint, control: CGPoint)
    case curve(to: CGPoint, control1: CGPoint, control2: CGPoint)
    case close
}

public enum VectorPathError: Error, Equatable {
    case unsupportedCommand(Character)
    case missingNumber(command: Character)
    case unexpectedCharacter(Character)
}

/// An outline parsed from SVG path data. UIKit can't draw SVG on its own, so
/// the wordmark is parsed here (and tested on Linux) and HappyUI replays the
/// elements into a CGPath. Supports M, L, H, V, Q, C and Z, absolute and
/// relative, with implicit repeats; that covers the bundled artwork.
public struct VectorPath: Equatable, Sendable {
    public var elements: [PathElement]

    public init(elements: [PathElement] = []) {
        self.elements = elements
    }

    public init(svg data: String) throws {
        var scanner = NumberScanner(Array(data.utf8))
        var elements: [PathElement] = []
        var current = CGPoint.zero
        var subpathStart = CGPoint.zero
        var command: UInt8?

        while let next = scanner.peekNonSeparator() {
            if Self.isCommand(next) {
                scanner.advance()
                command = next
            } else if command == nil || !Self.startsNumber(next) {
                throw VectorPathError.unexpectedCharacter(Character(UnicodeScalar(next)))
            }
            guard let letter = command else { break }
            let relative = letter >= UInt8(ascii: "a")
            let origin = relative ? current : .zero
            let name = Character(UnicodeScalar(letter))
            func number() throws -> CGFloat {
                guard let value = scanner.number() else { throw VectorPathError.missingNumber(command: name) }
                return value
            }
            func point() throws -> CGPoint {
                let x = try number()
                let y = try number()
                return CGPoint(x: origin.x + x, y: origin.y + y)
            }

            switch letter | 0x20 {
            case UInt8(ascii: "m"):
                current = try point()
                subpathStart = current
                elements.append(.move(current))
                // Further pairs after a move are lines.
                command = relative ? UInt8(ascii: "l") : UInt8(ascii: "L")
            case UInt8(ascii: "l"):
                current = try point()
                elements.append(.line(current))
            case UInt8(ascii: "h"):
                current = CGPoint(x: origin.x + (try number()), y: current.y)
                elements.append(.line(current))
            case UInt8(ascii: "v"):
                current = CGPoint(x: current.x, y: origin.y + (try number()))
                elements.append(.line(current))
            case UInt8(ascii: "q"):
                let control = try point()
                current = try point()
                elements.append(.quadCurve(to: current, control: control))
            case UInt8(ascii: "c"):
                let control1 = try point()
                let control2 = try point()
                current = try point()
                elements.append(.curve(to: current, control1: control1, control2: control2))
            case UInt8(ascii: "z"):
                elements.append(.close)
                current = subpathStart
                command = nil
            default:
                throw VectorPathError.unsupportedCommand(name)
            }
        }
        self.elements = elements
    }

    /// The smallest rect holding every point, control points included.
    public var controlBounds: CGRect {
        var points: [CGPoint] = []
        for element in elements {
            switch element {
            case .move(let p), .line(let p): points.append(p)
            case .quadCurve(let to, let control): points += [to, control]
            case .curve(let to, let c1, let c2): points += [to, c1, c2]
            case .close: break
            }
        }
        guard let first = points.first else { return .null }
        var minX = first.x, maxX = first.x, minY = first.y, maxY = first.y
        for p in points.dropFirst() {
            minX = min(minX, p.x); maxX = max(maxX, p.x)
            minY = min(minY, p.y); maxY = max(maxY, p.y)
        }
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    /// Every point scaled by `scale`, then moved by `offset`.
    public func applying(scale: CGFloat, offset: CGPoint) -> VectorPath {
        func map(_ p: CGPoint) -> CGPoint {
            CGPoint(x: p.x * scale + offset.x, y: p.y * scale + offset.y)
        }
        return VectorPath(elements: elements.map { element in
            switch element {
            case .move(let p): .move(map(p))
            case .line(let p): .line(map(p))
            case .quadCurve(let to, let control): .quadCurve(to: map(to), control: map(control))
            case .curve(let to, let c1, let c2): .curve(to: map(to), control1: map(c1), control2: map(c2))
            case .close: .close
            }
        })
    }

    private static func isCommand(_ byte: UInt8) -> Bool {
        switch byte | 0x20 {
        case UInt8(ascii: "a")...UInt8(ascii: "z"): byte != UInt8(ascii: "e") && byte != UInt8(ascii: "E")
        default: false
        }
    }

    private static func startsNumber(_ byte: UInt8) -> Bool {
        (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
            || byte == UInt8(ascii: "-") || byte == UInt8(ascii: "+") || byte == UInt8(ascii: ".")
    }
}

/// Paths with colours in a view box, drawn aspect-fit into a rect.
public struct VectorGraphic: Equatable, Sendable {
    public struct Layer: Equatable, Sendable {
        public var path: VectorPath
        public var color: ColorToken

        public init(path: VectorPath, color: ColorToken) {
            self.path = path
            self.color = color
        }
    }

    public var viewBox: CGRect
    public var layers: [Layer]

    public init(viewBox: CGRect, layers: [Layer]) {
        self.viewBox = viewBox
        self.layers = layers
    }

    /// The layers scaled to fit `rect`, keeping the aspect ratio, centred.
    public func fitted(into rect: CGRect) -> [Layer] {
        guard viewBox.width > 0, viewBox.height > 0 else { return [] }
        let scale = min(rect.width / viewBox.width, rect.height / viewBox.height)
        let offset = CGPoint(
            x: rect.minX + (rect.width - viewBox.width * scale) / 2 - viewBox.minX * scale,
            y: rect.minY + (rect.height - viewBox.height * scale) / 2 - viewBox.minY * scale
        )
        return layers.map { Layer(path: $0.path.applying(scale: scale, offset: offset), color: $0.color) }
    }
}

/// Reads SVG numbers: optional sign, digits with one optional point, and an
/// optional exponent. "1.5.5" is 1.5 then .5 and "3-4" is 3 then -4, as SVG
/// allows.
private struct NumberScanner {
    let bytes: [UInt8]
    var index = 0

    init(_ bytes: [UInt8]) {
        self.bytes = bytes
    }

    mutating func advance() {
        index += 1
    }

    mutating func peekNonSeparator() -> UInt8? {
        while index < bytes.count, Self.isSeparator(bytes[index]) {
            index += 1
        }
        return index < bytes.count ? bytes[index] : nil
    }

    mutating func number() -> CGFloat? {
        guard peekNonSeparator() != nil else { return nil }
        let start = index
        if bytes[index] == UInt8(ascii: "-") || bytes[index] == UInt8(ascii: "+") {
            index += 1
        }
        var sawDigit = false
        var sawPoint = false
        while index < bytes.count {
            let byte = bytes[index]
            if Self.isDigit(byte) {
                sawDigit = true
            } else if byte == UInt8(ascii: "."), !sawPoint {
                sawPoint = true
            } else {
                break
            }
            index += 1
        }
        if sawDigit, index < bytes.count, bytes[index] | 0x20 == UInt8(ascii: "e") {
            var lookahead = index + 1
            if lookahead < bytes.count, bytes[lookahead] == UInt8(ascii: "-") || bytes[lookahead] == UInt8(ascii: "+") {
                lookahead += 1
            }
            if lookahead < bytes.count, Self.isDigit(bytes[lookahead]) {
                index = lookahead
                while index < bytes.count, Self.isDigit(bytes[index]) {
                    index += 1
                }
            }
        }
        guard sawDigit, let text = String(bytes: bytes[start..<index], encoding: .utf8), let value = Double(text) else {
            index = start
            return nil
        }
        return CGFloat(value)
    }

    private static func isDigit(_ byte: UInt8) -> Bool {
        byte >= UInt8(ascii: "0") && byte <= UInt8(ascii: "9")
    }

    private static func isSeparator(_ byte: UInt8) -> Bool {
        byte == UInt8(ascii: " ") || byte == UInt8(ascii: ",") || byte == UInt8(ascii: "\n")
            || byte == UInt8(ascii: "\t") || byte == UInt8(ascii: "\r")
    }
}
