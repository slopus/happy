import Foundation

/// ThumbHash's decoder (github.com/evanw/thumbhash, MIT, `thumbHashToRGBA`
/// in thumbhash@0.1.1), which expo-image uses for the placeholder it shows
/// while a profile picture loads. Pure arithmetic: the UI turns the pixels
/// into an image.
public enum ThumbHash {
    public struct Image: Equatable, Sendable {
        public var width: Int
        public var height: Int
        /// Straight (not premultiplied) RGBA, row by row.
        public var rgba: [UInt8]
    }

    /// Decodes the base64 form the server stores; nil when it is not one.
    public static func decode(base64: String) -> Image? {
        var padded = base64.trimmingCharacters(in: .whitespacesAndNewlines)
        padded += String(repeating: "=", count: (4 - padded.count % 4) % 4)
        guard let data = Data(base64Encoded: padded) else { return nil }
        return decode([UInt8](data))
    }

    public static func decode(_ hash: [UInt8]) -> Image? {
        guard hash.count >= 5 else { return nil }
        func byte(_ index: Int) -> Int { index < hash.count ? Int(hash[index]) : 0 }

        let header24 = byte(0) | (byte(1) << 8) | (byte(2) << 16)
        let header16 = byte(3) | (byte(4) << 8)
        let lDC = Double(header24 & 63) / 63
        let pDC = Double((header24 >> 6) & 63) / 31.5 - 1
        let qDC = Double((header24 >> 12) & 63) / 31.5 - 1
        let lScale = Double((header24 >> 18) & 31) / 31
        let hasAlpha = (header24 >> 23) != 0
        let pScale = Double((header16 >> 3) & 63) / 63
        let qScale = Double((header16 >> 9) & 63) / 63
        let isLandscape = (header16 >> 15) != 0
        let lx = max(3, isLandscape ? (hasAlpha ? 5 : 7) : header16 & 7)
        let ly = max(3, isLandscape ? header16 & 7 : (hasAlpha ? 5 : 7))
        let aDC = hasAlpha ? Double(byte(5) & 15) / 15 : 1
        let aScale = Double(byte(5) >> 4) / 15

        // The AC terms are nibbles, low first, boosted 1.25× for colour.
        let acStart = hasAlpha ? 6 : 5
        var acIndex = 0
        func decodeChannel(_ nx: Int, _ ny: Int, _ scale: Double) -> [Double] {
            var ac: [Double] = []
            for cy in 0..<ny {
                var cx = cy == 0 ? 1 : 0
                while cx * ny < nx * (ny - cy) {
                    let nibble = (byte(acStart + (acIndex >> 1)) >> ((acIndex & 1) << 2)) & 15
                    acIndex += 1
                    ac.append((Double(nibble) / 7.5 - 1) * scale)
                    cx += 1
                }
            }
            return ac
        }
        let lAC = decodeChannel(lx, ly, lScale)
        let pAC = decodeChannel(3, 3, pScale * 1.25)
        let qAC = decodeChannel(3, 3, qScale * 1.25)
        let aAC = hasAlpha ? decodeChannel(5, 5, aScale) : []

        let ratio = approximateAspectRatio(hash)
        let width = Int((ratio > 1 ? 32 : 32 * ratio).rounded(.toNearestOrAwayFromZero))
        let height = Int((ratio > 1 ? 32 / ratio : 32).rounded(.toNearestOrAwayFromZero))
        guard width > 0, height > 0 else { return nil }
        var rgba = [UInt8](repeating: 0, count: width * height * 4)
        let columns = max(lx, hasAlpha ? 5 : 3)
        let rows = max(ly, hasAlpha ? 5 : 3)
        var fx = [Double](repeating: 0, count: columns)
        var fy = [Double](repeating: 0, count: rows)
        var i = 0
        for y in 0..<height {
            for x in 0..<width {
                var l = lDC, p = pDC, q = qDC, a = aDC
                for cx in 0..<columns {
                    fx[cx] = cos(Double.pi / Double(width) * (Double(x) + 0.5) * Double(cx))
                }
                for cy in 0..<rows {
                    fy[cy] = cos(Double.pi / Double(height) * (Double(y) + 0.5) * Double(cy))
                }
                var j = 0
                for cy in 0..<ly {
                    let fy2 = fy[cy] * 2
                    var cx = cy == 0 ? 1 : 0
                    while cx * ly < lx * (ly - cy) {
                        l += lAC[j] * fx[cx] * fy2
                        cx += 1
                        j += 1
                    }
                }
                j = 0
                for cy in 0..<3 {
                    let fy2 = fy[cy] * 2
                    var cx = cy == 0 ? 1 : 0
                    while cx < 3 - cy {
                        let f = fx[cx] * fy2
                        p += pAC[j] * f
                        q += qAC[j] * f
                        cx += 1
                        j += 1
                    }
                }
                if hasAlpha {
                    j = 0
                    for cy in 0..<5 {
                        let fy2 = fy[cy] * 2
                        var cx = cy == 0 ? 1 : 0
                        while cx < 5 - cy {
                            a += aAC[j] * fx[cx] * fy2
                            cx += 1
                            j += 1
                        }
                    }
                }
                let b = l - 2.0 / 3.0 * p
                let r = (3 * l - b + q) / 2
                let g = r - q
                rgba[i] = channel(r)
                rgba[i + 1] = channel(g)
                rgba[i + 2] = channel(b)
                rgba[i + 3] = channel(a)
                i += 4
            }
        }
        return Image(width: width, height: height, rgba: rgba)
    }

    /// `thumbHashToApproximateAspectRatio`.
    public static func approximateAspectRatio(_ hash: [UInt8]) -> Double {
        guard hash.count >= 5 else { return 1 }
        let header = Int(hash[3])
        let hasAlpha = hash[2] & 0x80 != 0
        let isLandscape = hash[4] & 0x80 != 0
        let lx = isLandscape ? (hasAlpha ? 5 : 7) : header & 7
        let ly = isLandscape ? header & 7 : (hasAlpha ? 5 : 7)
        guard ly > 0 else { return 1 }
        return Double(lx) / Double(ly)
    }

    /// A Uint8Array store: clamped to 0...255, then truncated.
    private static func channel(_ value: Double) -> UInt8 {
        UInt8(max(0, 255 * min(1, value)))
    }
}
